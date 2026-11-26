/**
 * The regtest gate (docs/BRIEF.md "Bitcoin side", Definition of done): on regtest, `bond create` then
 * `bond redeem` succeed, and bitcoind refuses a redeem before the locktime.
 *
 * Every step that builds or sends a bond transaction runs the CLI (`node bin/hbf.mjs bond create|redeem`), the same
 * code path a mainnet bond would take; only the backend is bitcoind instead of Esplora. The test itself talks to
 * bitcoind only to mine, fund the test key, move the clock and read results.
 *
 * Needs a regtest bitcoind: `npm run test:regtest` (regtest/run.sh starts one in Docker, runs this, stops it). Under
 * plain `npm test` it is skipped unless HBF_REGTEST_RPC is set. With HBF_REGTEST_FIXTURE=<path> it also writes the
 * funding transaction it made to that file, which test/bond.e2e.test.ts replays into MockHvm.
 *
 * The keys are generated here for this run and written only to a temporary .secrets/ directory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { WIF } from "@scure/btc-signer";
import { bytesToHex } from "viem";
import { fidelityBondsCreate2Address } from "../src/bonds.js";
import { BitcoindBackend } from "../src/btc/backend.js";
import { readBondFile } from "../src/btc/bond.js";
import { btcKey } from "../src/btc/keys.js";
import { REGTEST_NETWORK } from "../src/btc/networks.js";
import { parseTagScript } from "../src/btc/script.js";
import { txOutputs } from "../src/btc/tx.js";
import { hbf } from "./helpers/anvil.js";

const RPC = process.env.HBF_REGTEST_RPC;
const CHAIN_ID = 31337; // the anvil chain of test/bond.e2e.test.ts
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil's account 1 (public)
const BOND_SATS = 50_000n;

const log = (s: string) => process.stdout.write(`# ${s}\n`);

/** The fixture bond's locktime: 2033-05-18T03:33:20Z, below 2^31 and years ahead of any clock this suite runs at. */
const FIXTURE_LOCKTIME = 2_000_000_000;

describe("regtest gate: bond create, an early redeem refused, bond redeem after the locktime", { skip: RPC ? false : "needs a regtest bitcoind: npm run test:regtest" }, () => {
  const node = new BitcoindBackend("regtest", RPC ?? "http://127.0.0.1:1");
  const dir = mkdtempSync(join(tmpdir(), "hbf-regtest-"));
  const secrets = join(dir, ".secrets");
  mkdirSync(secrets);
  const bondPath = join(dir, "bond.json");
  const btcArgs = () => ["--btc-network", "regtest", "--btc-rpc", RPC!, "--fee-rate", "2"];

  let miner: string;
  let keyFile: string;
  let fundingAddress: string;
  let locktime: number;
  let redeemTo: string;
  let earlyRejection = "";
  let redeemTxid = "";

  const mine = async (n: number, to = miner) => node.call<string[]>("generatetoaddress", [n, to]);

  test("setup: 101 blocks to a miner wallet, and a fresh test key funded with 0.01 BTC", async () => {
    const chain = await node.call<{ chain: string; blocks: number }>("getblockchaininfo");
    assert.equal(chain.chain, "regtest");
    await node.call("setmocktime", [0]);
    const wallets = await node.call<string[]>("listwallets");
    if (!wallets.includes("miner")) {
      try {
        await node.call("createwallet", ["miner"]);
      } catch {
        await node.call("loadwallet", ["miner"]);
      }
    }
    const minerNode = new BitcoindBackend("regtest", `${RPC!.replace(/\/$/, "")}/wallet/miner`);
    miner = await minerNode.call<string>("getnewaddress");
    await mine(101);

    // the test key: generated now, written only to this run's temporary .secrets/
    const priv = secp256k1.utils.randomPrivateKey();
    keyFile = join(secrets, "btc.key");
    writeFileSync(keyFile, `${WIF(REGTEST_NETWORK).encode(priv)}\n`, { mode: 0o600 });
    fundingAddress = btcKey(priv, "regtest", "p2wpkh").address;
    redeemTo = await minerNode.call<string>("getnewaddress");
    await minerNode.call("sendtoaddress", [fundingAddress, 0.01]);
    await mine(1);
    const utxos = await node.utxos(fundingAddress);
    assert.equal(utxos.length, 1);
    assert.equal(utxos[0]!.value, 1_000_000);
    log(`bitcoind ${chain.chain}, height ${(await node.tip()).height}; test key funded at ${fundingAddress}`);
  });

  test("bond create (the CLI): bond output, tag output, change; 6 confirmations", async () => {
    const tip = await node.tip();
    // Far in the future (2033-05-18): test/bond.e2e.test.ts replays this bond on a Hemi fork, where a bond reads
    // Expired once Hemi's own clock reaches the locktime (independent audit, finding 1), so the fixture must stay
    // ahead of the real clock for years. The redeem below moves bitcoind's clock past it with setmocktime.
    locktime = Math.max(Math.floor(Date.now() / 1000), tip.medianTime, FIXTURE_LOCKTIME);
    const r = hbf([
      "bond", "create", ...btcArgs(),
      "--chain-id", String(CHAIN_ID),
      "--no-registry-check", // Bitcoin only: the Hemi half replays this transaction in test/bond.e2e.test.ts
      "--agent", AGENT,
      "--sats", BOND_SATS.toString(),
      "--locktime", String(locktime),
      "--btc-key-file", keyFile,
      "--out", bondPath,
      "--json",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.broadcast, true);
    const file = readBondFile(bondPath);
    assert.equal(file.contract, fidelityBondsCreate2Address());
    assert.equal(file.locktime, locktime);
    log(`bond create: txid ${file.txid.slice(2)}, bond ${file.bondAddress}, ${file.sats} sats, locktime ${locktime}, fee ${file.fee} sats`);
    log(`  witness script ${file.witnessScript}`);

    await mine(6);
    const t = await node.tx(file.txid.slice(2));
    assert.equal(t.confirmations, 6);
    const raw = await node.call<string>("getrawtransaction", [file.txid.slice(2), false]);
    assert.equal(`0x${raw}`, file.hex, "the node holds exactly the transaction the bond file carries");
    const outs = txOutputs(raw);
    assert.equal(outs.length, 3);
    assert.equal(outs[0]!.sats, BOND_SATS);
    assert.equal(bytesToHex(outs[0]!.script), file.bondScript);
    assert.equal(outs[1]!.sats, 0n);
    const tag = parseTagScript(outs[1]!.script);
    assert.deepEqual(tag, { chainId: CHAIN_ID, contract: fidelityBondsCreate2Address(), agent: AGENT });
    assert.equal(outs[2]!.sats, 1_000_000n - BOND_SATS - file.fee);
    // the node agrees the bond output pays the bond address, unspent
    const txout = await node.call<{ value: number; scriptPubKey: { address: string } }>("gettxout", [file.txid.slice(2), 0]);
    assert.equal(txout.scriptPubKey.address, file.bondAddress);
  });

  test("bond redeem before the locktime: refused by the CLI's own check, and by bitcoind (non-final)", async () => {
    const tip = await node.tip();
    assert.ok(tip.medianTime <= locktime, "the median time past is still before the locktime");
    const early = hbf(["bond", "redeem", ...btcArgs(), "--bond-file", bondPath, "--to", redeemTo, "--btc-key-file", keyFile]);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /not yet redeemable: the median time past is .* nothing was sent/);
    log(`hbf (own check): ${early.stderr.trim()}`);

    // broadcast anyway: bitcoind itself must refuse it
    const forced = hbf(["bond", "redeem", ...btcArgs(), "--bond-file", bondPath, "--to", redeemTo, "--btc-key-file", keyFile, "--skip-locktime-check"]);
    assert.equal(forced.code, 1);
    assert.match(forced.stderr, /redeem refused: bitcoind 127\.0\.0\.1:\d+ rejected the transaction: non-final \(RPC code -26\)/);
    earlyRejection = forced.stderr.trim();
    log(`bitcoind: ${earlyRejection}`);

    // and testmempoolaccept on the same signed transaction says why
    const dry = hbf(["bond", "redeem", ...btcArgs(), "--bond-file", bondPath, "--to", redeemTo, "--btc-key-file", keyFile, "--skip-locktime-check", "--dry-run", "--json"]);
    assert.equal(dry.code, 0, dry.stderr);
    const [verdict] = await node.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[JSON.parse(dry.stdout).hex]]);
    assert.equal(verdict!.allowed, false);
    assert.equal(verdict!["reject-reason"], "non-final");
    log(`testmempoolaccept: ${JSON.stringify(verdict)}`);
    assert.equal(await node.outputSpent(readBondFile(bondPath).txid.slice(2), 0), false);
  });

  test("median time past moves past the locktime (setmocktime, 11 blocks)", async () => {
    await node.call("setmocktime", [locktime + 600]);
    await mine(11);
    const tip = await node.tip();
    log(`median time past ${tip.medianTime} > locktime ${locktime}`);
    assert.ok(tip.medianTime > locktime);
  });

  test("bond redeem (the CLI): accepted and confirmed, the bond output spent to the given address", async () => {
    const r = hbf(["bond", "redeem", ...btcArgs(), "--bond-file", bondPath, "--to", redeemTo, "--btc-key-file", keyFile, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.broadcast, true);
    assert.equal(j.lockTime, locktime);
    assert.equal(j.sequence, 0xfffffffe);
    redeemTxid = j.txid;
    await mine(1);
    const t = await node.tx(redeemTxid);
    assert.ok(t.confirmed && t.confirmations === 1);
    const file = readBondFile(bondPath);
    assert.equal(await node.outputSpent(file.txid.slice(2), 0), true);
    const tx = await node.call<{ locktime: number; vin: { txid: string; vout: number; sequence: number; txinwitness: string[] }[]; vout: { value: number; scriptPubKey: { address: string } }[] }>(
      "getrawtransaction",
      [redeemTxid, true],
    );
    assert.equal(tx.locktime, locktime);
    assert.equal(tx.vin[0]!.txid, file.txid.slice(2));
    assert.equal(tx.vin[0]!.sequence, 0xfffffffe);
    assert.equal(tx.vin[0]!.txinwitness.length, 2);
    assert.equal(`0x${tx.vin[0]!.txinwitness[1]}`, file.witnessScript);
    assert.equal(tx.vout[0]!.scriptPubKey.address, redeemTo);
    assert.equal(BigInt(Math.round(tx.vout[0]!.value * 1e8)), BOND_SATS - BigInt(j.fee));
    log(`bond redeem: txid ${redeemTxid}, ${j.outputSats} sats to ${redeemTo}, fee ${j.fee} sats; confirmed`);
    // a second redeem is refused before anything is built: the output is spent
    const again = hbf(["bond", "redeem", ...btcArgs(), "--bond-file", bondPath, "--to", redeemTo, "--btc-key-file", keyFile]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already spent/);
  });

  test("a P2TR funding key works too (create; the node accepts it)", async () => {
    // After the redeem the chain's blocks are stamped past the fixture's 2033 locktime, so keep the node's clock
    // there too (a real-time clock would make every new block "time-too-new" against the median time past).
    await node.call("setmocktime", [locktime + 1200]);
    const priv = secp256k1.utils.randomPrivateKey();
    const trKey = join(secrets, "btc-tr.key");
    writeFileSync(trKey, `${bytesToHex(priv)}\n`, { mode: 0o600 }); // hex works as well as WIF
    const addr = btcKey(priv, "regtest", "p2tr").address;
    const minerNode = new BitcoindBackend("regtest", `${RPC!.replace(/\/$/, "")}/wallet/miner`);
    await minerNode.call("sendtoaddress", [addr, 0.001]);
    await mine(1);
    const tip = await node.tip();
    const lt = Math.max(Math.floor(Date.now() / 1000), tip.medianTime) + 3600;
    const path = join(dir, "bond-tr.json");
    const r = hbf(["bond", "create", ...btcArgs(), "--chain-id", String(CHAIN_ID), "--no-registry-check", "--agent", AGENT, "--sats", "10000", "--locktime", String(lt), "--btc-key-file", trKey, "--address-type", "p2tr", "--out", path, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    await mine(1);
    const t = await node.tx(readBondFile(path).txid.slice(2));
    assert.equal(t.confirmations, 1);
    log(`P2TR-funded bond ${readBondFile(path).txid.slice(2)} confirmed`);
  });

  test("the fixture for the Hemi half (test/bond.e2e.test.ts)", () => {
    const target = process.env.HBF_REGTEST_FIXTURE;
    const file = JSON.parse(readFileSync(bondPath, "utf8")) as Record<string, string>;
    const fixture = {
      note: "Written by test/bond.regtest.test.ts (npm run test:regtest -- --update-fixture): a funding transaction bitcoind accepted on regtest, and its redeem. test/bond.e2e.test.ts replays its outputs into MockHvm.",
      bitcoind: "bitcoin/bitcoin:32.1 (regtest)",
      bondFile: file,
      outputs: txOutputs(file.hex!.slice(2)).map((o) => ({ sats: o.sats.toString(), script: bytesToHex(o.script) })),
      earlyRedeemRejection: earlyRejection,
      redeemTxid,
    };
    if (target) {
      writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
      log(`wrote ${target}`);
    }
    assert.ok(redeemTxid);
  });
});
