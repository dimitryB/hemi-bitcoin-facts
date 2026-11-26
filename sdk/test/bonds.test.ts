/**
 * Unit tests of the bond tooling (no chain, no bitcoind): constants against the contract, ids, scripts, the two
 * Bitcoin transactions, fact and bond files, the Esplora and bitcoind backends against fakes, and the CLI's guards.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { SigHash, Transaction, WIF } from "@scure/btc-signer";
import { bytesToHex, hexToBytes, keccak256, toBytes, type Hex } from "viem";
import {
  BOND_STATUSES,
  BOND_VERDICTS,
  bondId,
  bondSubject,
  FIDELITY_BONDS_SALT,
  fidelityBondsCreate2Address,
  KIND_BOND,
  parseBondFactFile,
  serializeBondFactFile,
} from "../src/bonds.js";
import { BitcoindBackend, BroadcastRejected, btcToSats, EsploraBackend } from "../src/btc/backend.js";
import { assertCreateAllowed, createBond, readBondFile, writeBondFile, type BondFile } from "../src/btc/bond.js";
import { btcKey, parsePrivateKey } from "../src/btc/keys.js";
import { btcNetForChain, REGTEST_NETWORK } from "../src/btc/networks.js";
import {
  bondAddress,
  bondOutputScript,
  bondWitnessScript,
  LOCKTIME_LIMIT,
  MIN_CONFIRMATIONS,
  MIN_LOCKTIME,
  MIN_SATS,
  parseBondWitnessScript,
  parseTagScript,
  tagScript,
  TAG_LENGTH,
  WITNESS_SCRIPT_LENGTH,
} from "../src/btc/script.js";
import { buildFundingTx, buildRedeemTx, REDEEM_SEQUENCE, redeemVsize, txOutputs } from "../src/btc/tx.js";
import { locktimeOf } from "../src/cli/bond.js";
import { REPO, SDK } from "./helpers/anvil.js";

const G: Hex = "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"; // secp256k1 generator (key 1)
const FIXTURE = JSON.parse(readFileSync(join(SDK, "test/fixtures/regtest-bond.json"), "utf8")) as {
  bondFile: Record<string, string>;
  outputs: { sats: string; script: Hex }[];
};
const src = readFileSync(join(REPO, "contracts/src/FidelityBonds.sol"), "utf8");

function enumNames(name: string): string[] {
  const body = src.slice(src.indexOf(`enum ${name} {`), src.indexOf("}", src.indexOf(`enum ${name} {`)));
  return [...body.matchAll(/^\s+([A-Z][A-Za-z]+),?$/gm)].map((m) => m[1]!);
}
function constant(name: string): string {
  const m = new RegExp(`constant ${name} = ([^;]+);`).exec(src);
  assert.ok(m, name);
  return m[1]!.replace(/_/g, "");
}

// ---------------------------------------------------------------------------------------------
// Constants and ids
// ---------------------------------------------------------------------------------------------

test("verdicts, statuses and constants match contracts/src/FidelityBonds.sol and the deploy script", () => {
  assert.deepEqual(enumNames("Verdict"), [...BOND_VERDICTS]);
  assert.deepEqual(enumNames("Status"), [...BOND_STATUSES]);
  assert.equal(constant("MIN_SATS"), MIN_SATS.toString());
  assert.equal(Number(constant("MIN_CONFIRMATIONS")), MIN_CONFIRMATIONS);
  assert.equal(Number(constant("MIN_LOCKTIME")), MIN_LOCKTIME);
  assert.equal(constant("LOCKTIME_LIMIT"), "1 << 31");
  assert.equal(2 ** 31, LOCKTIME_LIMIT);
  assert.equal(Number(constant("TAG_LENGTH")), TAG_LENGTH);
  assert.equal(Number(constant("WITNESS_SCRIPT_LENGTH")), WITNESS_SCRIPT_LENGTH);
  assert.equal(constant("TAG_MAGIC"), "0x48464231");
  assert.equal(KIND_BOND, keccak256(toBytes("hemi-bitcoin-facts/bond")));
  const deploy = readFileSync(join(REPO, "contracts/script/Deploy.s.sol"), "utf8");
  assert.match(deploy, /FIDELITY_BONDS_SALT = keccak256\("hemi-bitcoin-facts\/FidelityBonds\/v1"\)/);
  assert.equal(FIDELITY_BONDS_SALT, keccak256(toBytes("hemi-bitcoin-facts/FidelityBonds/v1")));
  assert.match(fidelityBondsCreate2Address(), /^0x[0-9a-fA-F]{40}$/);
});

test("ids: the vector in contracts/test/FidelityBonds.t.sol test_ids_vectors", () => {
  const txid: Hex = "0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4";
  assert.equal(bondSubject(txid, 0), keccak256(`${txid}0000`));
  assert.equal(bondId(txid, 0), "0xc0cc984bb9d0a5ee009b84a036bbdff3aa543eabcace67aeebbf4af34f818a39");
  assert.equal(bondSubject(`0x${"00".repeat(32)}`, 0x0102), keccak256(`0x${"00".repeat(32)}0102`));
});

// ---------------------------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------------------------

test("the witness script is the contract's 42-byte template", () => {
  const ws = bondWitnessScript(1_800_000_000, hexToBytes(G));
  // the same bytes as FidelityBonds.t.sol's _ws(): 1,800,000,000 = 0x6b49d200, little-endian 00 d2 49 6b
  assert.equal(bytesToHex(ws), `0x0400d2496bb17521${G.slice(2)}ac`);
  assert.deepEqual(parseBondWitnessScript(ws), { locktime: 1_800_000_000, pubkey: hexToBytes(G) });
  assert.equal(bytesToHex(bondOutputScript(ws)), `0x0020${bytesToHex(sha256(ws)).slice(2)}`);
  assert.match(bondAddress(ws, "mainnet"), /^bc1q[0-9a-z]{58}$/);
  assert.match(bondAddress(ws, "testnet"), /^tb1q/);
  assert.match(bondAddress(ws, "regtest"), /^bcrt1q/);
  // bitcoind reported the regtest fixture's bond output as paying exactly this address
  const f = FIXTURE.bondFile;
  assert.equal(bondAddress(hexToBytes(f.witnessScript as Hex), "regtest"), f.bondAddress);
  assert.equal(bytesToHex(bondOutputScript(hexToBytes(f.witnessScript as Hex))), FIXTURE.outputs[0]!.script);
});

test("the witness script refuses what the contract refuses", () => {
  const key = hexToBytes(G);
  assert.throws(() => bondWitnessScript(MIN_LOCKTIME - 1, key), /not a bond locktime/);
  assert.throws(() => bondWitnessScript(LOCKTIME_LIMIT, key), /not a bond locktime/);
  assert.throws(() => bondWitnessScript(1.5e9 + 0.5, key), /not a bond locktime/);
  assert.doesNotThrow(() => bondWitnessScript(MIN_LOCKTIME, key));
  assert.doesNotThrow(() => bondWitnessScript(LOCKTIME_LIMIT - 1, key));
  const uncompressed = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), false);
  assert.throws(() => bondWitnessScript(1_800_000_000, uncompressed), /33-byte compressed/);
  const offCurve = new Uint8Array(33).fill(0xff); // x >= the field prime: no point
  offCurve[0] = 0x02;
  assert.throws(() => bondWitnessScript(1_800_000_000, offCurve), /not a point/);
  const ws = bondWitnessScript(1_800_000_000, key);
  for (const i of [0, 5, 6, 7, 41]) {
    const bad = ws.slice();
    bad[i] = bad[i]! ^ 0xff;
    assert.throws(() => parseBondWitnessScript(bad), /not a bond witness script/);
  }
  assert.throws(() => parseBondWitnessScript(ws.slice(0, 41)), /not a bond witness script/);
});

test("the tag: 50 bytes, OP_RETURN push 48, HFB1, chain id big-endian, contract, agent", () => {
  const contract = fidelityBondsCreate2Address();
  const agent = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const t = tagScript(43_111, contract, agent);
  assert.equal(bytesToHex(t), `0x6a30484642310000a867${contract.slice(2).toLowerCase()}${agent.slice(2).toLowerCase()}`);
  assert.deepEqual(parseTagScript(t), { chainId: 43_111, contract, agent });
  assert.throws(() => tagScript(43_111, contract, "0x0000000000000000000000000000000000000000"), /zero address/);
  assert.throws(() => tagScript(2 ** 32, contract, agent), /4 bytes/);
  // a tunnel deposit's OP_RETURN (the address as ASCII hex) is not a tag
  assert.equal(parseTagScript(new Uint8Array([0x6a, 0x28, ...new TextEncoder().encode(agent.slice(2))])), undefined);
  assert.equal(bytesToHex(t.slice(0, 2)), "0x6a30");
  // the regtest fixture's tag, as bitcoind saw it
  assert.deepEqual(parseTagScript(hexToBytes(FIXTURE.outputs[1]!.script)), {
    chainId: 31_337,
    contract: fidelityBondsCreate2Address(),
    agent,
  });
});

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

describe("the funding transaction", () => {
  const ws = bondWitnessScript(1_800_000_000, hexToBytes(G));
  const tag = tagScript(31_337, fidelityBondsCreate2Address(), "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  for (const type of ["p2wpkh", "p2tr"] as const) {
    test(`${type}: bond at 0, tag at 1, change at 2, fee as selected, every input signed`, () => {
      const key = btcKey(secp256k1.utils.randomPrivateKey(), "regtest", type);
      const utxos = [
        { txid: "11".repeat(32), vout: 0, value: 30_000 },
        { txid: "22".repeat(32), vout: 3, value: 40_000 },
      ];
      const f = buildFundingTx(key, utxos, { sats: 50_000n, witnessScript: ws, tag, feeRate: 3 });
      const tx = Transaction.fromRaw(hexToBytes(`0x${f.hex}`), { allowUnknownOutputs: true });
      assert.equal(tx.id, f.txid);
      assert.equal(tx.inputsLength, 2);
      assert.equal(tx.outputsLength, 3);
      assert.deepEqual(tx.getOutput(0).script, bondOutputScript(ws));
      assert.equal(tx.getOutput(0).amount, 50_000n);
      assert.deepEqual(tx.getOutput(1).script, tag);
      assert.equal(tx.getOutput(1).amount, 0n);
      assert.deepEqual(tx.getOutput(2).script, key.script);
      assert.equal(70_000n - 50_000n - f.fee, f.change);
      assert.ok(f.fee >= BigInt(Math.ceil(f.vsize * 3)), `fee ${f.fee} covers ${f.vsize} vB at 3 sat/vB`);
      for (let i = 0; i < 2; i++) assert.ok((tx.getInput(i).finalScriptWitness?.length ?? 0) > 0);
      assert.deepEqual(txOutputs(f.hex).map((o) => o.sats), [50_000n, 0n, f.change]);
    });
  }

  test("change below dust goes to the fee, and too little is refused", () => {
    const key = btcKey(secp256k1.utils.randomPrivateKey(), "regtest");
    const f = buildFundingTx(key, [{ txid: "33".repeat(32), vout: 0, value: 50_600 }], { sats: 50_000n, witnessScript: ws, tag, feeRate: 2 });
    assert.equal(f.changeVout, undefined);
    assert.equal(f.fee, 600n);
    assert.throws(() => buildFundingTx(key, [{ txid: "33".repeat(32), vout: 0, value: 50_000 }], { sats: 50_000n, witnessScript: ws, tag, feeRate: 2 }), /insufficient funds/);
  });
});

describe("the redeem transaction", () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const key = btcKey(priv, "regtest");
  const ws = bondWitnessScript(1_800_000_000, key.publicKey);
  const base = { txid: "44".repeat(32), vout: 0, sats: 50_000n, witnessScript: ws, privateKey: priv, to: key.address, network: "regtest" as const, feeRate: 2 };

  test("nLockTime = the locktime, sequence 0xfffffffe, witness [signature, witness script], signature valid", () => {
    const r = buildRedeemTx(base);
    const tx = Transaction.fromRaw(hexToBytes(`0x${r.hex}`), { allowUnknownInputs: true });
    assert.equal(tx.lockTime, 1_800_000_000);
    assert.equal(r.lockTime, 1_800_000_000);
    const input = tx.getInput(0);
    assert.equal(input.sequence, REDEEM_SEQUENCE);
    assert.equal(input.sequence, 0xfffffffe);
    const [sig, script] = input.finalScriptWitness!;
    assert.deepEqual(script, ws);
    assert.equal(sig![sig!.length - 1], SigHash.ALL);
    // BIP143 digest over the witness script, checked independently of the builder
    const check = new Transaction({ lockTime: 1_800_000_000, allowUnknownInputs: true });
    check.addInput({ txid: base.txid, index: 0, sequence: 0xfffffffe, witnessUtxo: { script: bondOutputScript(ws), amount: 50_000n } });
    check.addOutput({ script: key.script, amount: r.outputSats });
    const digest = check.preimageWitnessV0(0, ws, SigHash.ALL, 50_000n);
    const der = secp256k1.Signature.fromDER(sig!.slice(0, -1));
    assert.ok(secp256k1.verify(der, digest, key.publicKey));
    assert.ok(!der.hasHighS(), "low S");
    assert.equal(r.outputSats, 50_000n - r.fee);
    assert.ok(r.vsize <= redeemVsize(22), `vsize ${r.vsize} within the estimate`);
    assert.equal(r.fee, BigInt(Math.ceil(redeemVsize(22) * 2)));
  });

  test("refuses another key, an earlier nLockTime, an address of another network, and a dust output", () => {
    assert.throws(() => buildRedeemTx({ ...base, privateKey: secp256k1.utils.randomPrivateKey() }), /not the bond's key/);
    assert.throws(() => buildRedeemTx({ ...base, lockTime: 1_799_999_999 }), /at least the bond's locktime/);
    assert.doesNotThrow(() => buildRedeemTx({ ...base, lockTime: 1_800_000_001 }));
    assert.throws(() => buildRedeemTx({ ...base, to: "bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkv" }), /not a regtest address/);
    assert.throws(() => buildRedeemTx({ ...base, sats: 400n }), /below dust/);
  });
});

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

function schemaExample(): string {
  const doc = readFileSync(join(REPO, "docs/SCHEMA.md"), "utf8");
  const start = doc.indexOf("### `bond` (FidelityBonds)");
  const end = doc.indexOf("\n## ", start + 1);
  const blocks = [...doc.slice(start, end).matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
  assert.equal(blocks.length, 1);
  return blocks[0]!;
}

test("docs/SCHEMA.md's bond example parses, re-serializes byte for byte, and recomputes; it is the regtest bond", () => {
  const text = schemaExample();
  const p = parseBondFactFile(JSON.parse(text));
  assert.ok(p.ok, p.ok ? "" : p.errors.join("; "));
  assert.equal(serializeBondFactFile(p.file), text);
  assert.equal(bondId(p.file.fact.txid, p.file.fact.vout), p.file.id);
  assert.equal(bytesToHex(sha256(hexToBytes(p.file.fact.witnessScript))), p.file.fact.witnessProgram);
  assert.equal(parseBondWitnessScript(hexToBytes(p.file.fact.witnessScript)).locktime, p.file.fact.locktime);
  assert.equal(p.file.contract, fidelityBondsCreate2Address().toLowerCase());
  const f = FIXTURE.bondFile;
  assert.deepEqual(
    [p.file.fact.agent, p.file.fact.txid, String(p.file.fact.sats), String(p.file.fact.locktime), p.file.fact.witnessScript, p.file.chainId],
    [f.agent, f.txid, f.sats, f.locktime, f.witnessScript, Number(f.chainId)],
  );
});

describe("parseBondFactFile rejects", () => {
  const base = () => JSON.parse(schemaExample()) as Record<string, any>;
  const cases: [string, (o: Record<string, any>) => void, RegExp][] = [
    ["another kind", (o) => (o.kind = "output"), /file\.kind must be "bond"/],
    ["an unknown key", (o) => (o.fact.pubkey = "0x02"), /file\.fact\.pubkey is not a known key/],
    ["a missing key", (o) => delete o.fact.tagVout, /file\.fact\.tagVout is missing/],
    ["a JSON number", (o) => (o.fact.sats = 50_000), /file\.fact\.sats must be a decimal string/],
    ["a checksummed agent", (o) => (o.fact.agent = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"), /file\.fact\.agent/],
    ["a locktime above 2^32-1", (o) => (o.fact.locktime = "4294967296"), /file\.fact\.locktime is out of range/],
    ["odd-length script hex", (o) => (o.fact.witnessScript = "0x041"), /file\.fact\.witnessScript/],
  ];
  for (const [name, mutate, want] of cases) {
    test(name, () => {
      const o = base();
      mutate(o);
      const r = parseBondFactFile(o);
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.errors.join("; "), want);
    });
  }
});

test("bond files round-trip, and one that disagrees with itself is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbf-bondfile-"));
  const path = join(dir, "bond.json");
  writeFileSync(path, `${JSON.stringify(FIXTURE.bondFile, null, 2)}\n`);
  const f = readBondFile(path);
  const again = join(dir, "again.json");
  writeBondFile(again, f);
  assert.equal(readFileSync(again, "utf8"), readFileSync(path, "utf8"));
  for (const [key, value, want] of [
    ["tagScript", `${FIXTURE.bondFile.tagScript!.slice(0, -2)}00`, /tagScript does not name/],
    ["bondAddress", "bcrt1qmaljyuup4d2dyzd3kt65wmfr87gwwl5ruqmu3f", /bondAddress does not encode/],
    ["locktime", "1795239730", /locktime differs/],
    ["agent", "0x000000000000000000000000000000000000beef", /tagScript does not name/],
  ] as const) {
    const bad = join(dir, `${key}.json`);
    writeFileSync(bad, JSON.stringify({ ...FIXTURE.bondFile, [key]: value }));
    assert.throws(() => readBondFile(bad), want, key);
  }
});

test("a bond file's numbers are unsigned decimals, and its funding transaction is the bond it describes (pre-mainnet I-6)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbf-bondfile-i6-"));
  const bf = FIXTURE.bondFile;
  const otherTxid = `0x${"ab".repeat(32)}`;
  for (const [key, value, want] of [
    ["sats", "-1", /sats must be a decimal string of at least 1/],
    ["sats", "0x10", /sats must be a decimal string/],
    ["sats", "0", /sats must be a decimal string of at least 1/],
    ["sats", "007", /sats must be a decimal string/],
    ["fee", "-424", /fee must be a decimal string/],
    ["fee", "1e3", /fee must be a decimal string/],
    ["feeRate", "abc", /feeRate is not a positive number/],
    ["txid", otherTxid, /txid is not hex's transaction id/],
    ["sats", "50001", /hex's output bondVout is not sats paid to bondScript/],
    ["bondVout", "2", /hex's output bondVout is not sats paid to bondScript/],
    ["tagVout", "0", /hex's output tagVout is not the zero-value tagScript/],
    ["hex", "0x00", /hex does not decode as a transaction/],
  ] as const) {
    const bad = join(dir, `${key}-${value}.json`);
    writeFileSync(bad, JSON.stringify({ ...bf, [key]: value }));
    assert.throws(() => readBondFile(bad), want, `${key} = ${value}`);
  }
  // the fixture itself passes every check
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify(bf));
  assert.equal(readBondFile(good).txid, bf.txid);
});

test("bond create refuses the zero agent and a chain id wider than the tag's 4 bytes (pre-mainnet I-5)", () => {
  const now = 1_790_000_000;
  const p = { network: "regtest" as const, chainId: 31_337, contract: fidelityBondsCreate2Address(), agent: G.slice(0, 42) as Hex, sats: 20_000n, locktime: now + 3600, now };
  assert.doesNotThrow(() => assertCreateAllowed(p));
  assert.throws(() => assertCreateAllowed({ ...p, agent: `0x${"0".repeat(40)}` }), /--agent must be a nonzero EVM address/);
  assert.throws(() => assertCreateAllowed({ ...p, chainId: 0x1_0000_0000 }), /does not fit in the tag's 4 bytes/);
  assert.throws(() => assertCreateAllowed({ ...p, chainId: -1 }), /does not fit in the tag's 4 bytes/);
  assert.doesNotThrow(() => assertCreateAllowed({ ...p, chainId: 0xffffffff }));
});

// ---------------------------------------------------------------------------------------------
// Guards, networks and arguments
// ---------------------------------------------------------------------------------------------

test("create refusals that need no key and no network", () => {
  const now = 1_790_000_000;
  const p = { network: "mainnet" as const, chainId: 43_111, contract: fidelityBondsCreate2Address(), agent: G.slice(0, 42) as Hex, sats: 20_000n, locktime: now + 3600, now };
  assert.throws(() => assertCreateAllowed(p), /refusing to broadcast on Bitcoin mainnet without --allow-mainnet/);
  assert.doesNotThrow(() => assertCreateAllowed({ ...p, allowMainnet: true }));
  assert.doesNotThrow(() => assertCreateAllowed({ ...p, dryRun: true }));
  assert.throws(() => assertCreateAllowed({ ...p, allowMainnet: true, sats: 20_001n }), /cap is 20000 sats/);
  assert.throws(() => assertCreateAllowed({ ...p, allowMainnet: true, locktime: now + 24 * 3600 + 1 }), /cap is 24 hours/);
  assert.doesNotThrow(() => assertCreateAllowed({ ...p, allowMainnet: true, locktime: now + 24 * 3600 }));
  assert.doesNotThrow(() => assertCreateAllowed({ ...p, allowMainnet: true, overrideCaps: true, sats: 10n ** 8n, locktime: now + 30 * 86_400 }));
  // everywhere
  for (const network of ["mainnet", "testnet", "regtest"] as const) {
    const q = { ...p, network, allowMainnet: true };
    assert.throws(() => assertCreateAllowed({ ...q, locktime: now }), /not in the future/);
    assert.throws(() => assertCreateAllowed({ ...q, sats: 9_999n }), /below FidelityBonds\.MIN_SATS/);
    assert.throws(() => assertCreateAllowed({ ...q, locktime: 499_999_999 }), /not a bond locktime/);
    assert.throws(() => assertCreateAllowed({ ...q, locktime: 2 ** 31 }), /not a bond locktime/);
  }
  assert.doesNotThrow(() => assertCreateAllowed({ ...p, network: "regtest", sats: 10n ** 8n, locktime: now + 365 * 86_400 }));
});

test("the Bitcoin network follows the Hemi chain", () => {
  assert.equal(btcNetForChain(43_111), "mainnet");
  assert.equal(btcNetForChain(743_111), "testnet");
  assert.equal(btcNetForChain(31_337, "regtest"), "regtest");
  assert.throws(() => btcNetForChain(31_337), /--btc-network/);
  assert.throws(() => btcNetForChain(43_111, "regtest"), /reads Bitcoin mainnet/);
  assert.throws(() => btcNetForChain(743_111, "mainnet"), /reads Bitcoin testnet/);
  assert.throws(() => btcNetForChain(1, "signet"), /--btc-network must be/);
});

test("keys: a WIF of the network or 32 bytes of hex; errors never echo the key", () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const wif = WIF(REGTEST_NETWORK).encode(priv);
  assert.deepEqual(parsePrivateKey(`${wif}\n`, "regtest"), priv);
  assert.deepEqual(parsePrivateKey(bytesToHex(priv), "regtest"), priv);
  assert.deepEqual(parsePrivateKey(bytesToHex(priv).slice(2), "mainnet"), priv);
  for (const bad of [WIF().encode(priv), "not a key", `0x${"00".repeat(32)}`]) {
    try {
      parsePrivateKey(bad, "regtest");
      assert.fail("accepted");
    } catch (error) {
      assert.ok(!(error as Error).message.includes(bad), "the message does not contain the input");
    }
  }
});

test("--locktime and --lock-for", () => {
  assert.equal(locktimeOf("1800000000", undefined), 1_800_000_000);
  assert.equal(locktimeOf("2027-01-15T08:00:00Z", undefined), 1_800_000_000);
  assert.equal(locktimeOf(undefined, "90m", 1_000), 1_000 + 5_400);
  assert.equal(locktimeOf(undefined, "2h", 0), 7_200);
  assert.equal(locktimeOf(undefined, "1d", 0), 86_400);
  assert.throws(() => locktimeOf(undefined, "2 hours"), /--lock-for/);
  assert.throws(() => locktimeOf("1800000000", "2h"), /--locktime/);
  assert.throws(() => locktimeOf(undefined, undefined), /--locktime/);
  assert.throws(() => locktimeOf("tomorrow", undefined), /ISO 8601/);
});

// ---------------------------------------------------------------------------------------------
// Backends against fakes
// ---------------------------------------------------------------------------------------------

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
const fakeFetch = (route: Route, calls: string[]): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(`${init?.method ?? "GET"} ${url}`);
  return route(url, init);
}) as typeof fetch;

describe("Esplora: rotation, pacing and rejections", () => {
  test("a failing or throttling instance hands over to the next; unconfirmed UTXOs are left out", async () => {
    const calls: string[] = [];
    const esplora = new EsploraBackend(
      "mainnet",
      ["https://a.example/api", "https://b.example/api"],
      fakeFetch((url) => {
        if (url.startsWith("https://a.example")) return new Response("slow down", { status: 429 });
        if (url.endsWith("/utxo")) {
          return Response.json([
            { txid: "aa".repeat(32), vout: 0, value: 5000, status: { confirmed: true, block_height: 9 } },
            { txid: "bb".repeat(32), vout: 1, value: 7000, status: { confirmed: false } },
          ]);
        }
        if (url.endsWith("/blocks/tip/hash")) return new Response("cc".repeat(32));
        if (url.endsWith(`/block/${"cc".repeat(32)}`)) return Response.json({ height: 977_000, timestamp: 1_795_000_600, mediantime: 1_795_000_000 });
        return new Response("not found", { status: 404 });
      }, calls),
    );
    const u = await esplora.utxos("bc1qexample");
    assert.deepEqual(u.map((x) => x.value), [5000]);
    assert.deepEqual(await esplora.tip(), { height: 977_000, time: 1_795_000_600, medianTime: 1_795_000_000 });
    assert.ok(calls[0]!.includes("a.example") && calls[1]!.includes("b.example"));
  });

  test("an unknown transaction is not found and its outputs are not 'unspent' (Esplora's /status says confirmed:false for anything)", async () => {
    const calls: string[] = [];
    const known = "aa".repeat(32);
    const esplora = new EsploraBackend(
      "mainnet",
      ["https://a.example/api"],
      fakeFetch((url) => {
        if (url.endsWith(`/tx/${known}`)) return Response.json({ txid: known, status: { confirmed: true, block_height: 976_850 } });
        if (url.endsWith("/blocks/tip/height")) return new Response("976855");
        if (url.includes("/outspend/")) return Response.json({ spent: false });
        if (url.endsWith("/status")) return Response.json({ confirmed: false });
        return new Response("Transaction not found", { status: 404 });
      }, calls),
    );
    assert.deepEqual(await esplora.tx("bb".repeat(32)), { found: false, confirmed: false, confirmations: 0 });
    assert.equal(await esplora.outputSpent("bb".repeat(32), 0), undefined);
    assert.deepEqual(await esplora.tx(known), { found: true, confirmed: true, confirmations: 6, blockHeight: 976_850 });
    assert.equal(await esplora.outputSpent(known, 0), false);
  });

  test("a 400 from a broadcast is final: no retry elsewhere", async () => {
    const calls: string[] = [];
    const esplora = new EsploraBackend(
      "mainnet",
      ["https://a.example/api", "https://b.example/api"],
      fakeFetch(() => new Response("sendrawtransaction RPC error: non-final", { status: 400 }), calls),
    );
    await assert.rejects(esplora.broadcast("00"), (e: unknown) => e instanceof BroadcastRejected && /non-final/.test(e.reason));
    assert.equal(calls.length, 1);
  });

  test("a 5xx from a broadcast tries the next instance", async () => {
    const calls: string[] = [];
    const esplora = new EsploraBackend(
      "mainnet",
      ["https://a.example/api", "https://b.example/api"],
      fakeFetch((url) => (url.startsWith("https://a.") ? new Response("bad gateway", { status: 502 }) : new Response("dd".repeat(32))), calls),
    );
    assert.equal(await esplora.broadcast("00"), "dd".repeat(32));
    assert.equal(calls.length, 2);
  });
});

describe("bitcoind JSON-RPC", () => {
  test("credentials go in a header, amounts become sats, errors become rejections", async () => {
    const calls: string[] = [];
    const seen: { url: string; auth: string | null; body: { method: string; params: unknown[] } }[] = [];
    const node = new BitcoindBackend(
      "regtest",
      "http://user:p%40ss@127.0.0.1:18443/wallet/x",
      2,
      fakeFetch(async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
        seen.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
        const reply = (result: unknown, error: unknown = null) => Response.json({ result, error, id: body.id });
        if (body.method === "scantxoutset") return reply({ success: true, unspents: [{ txid: "ab".repeat(32), vout: 2, amount: 0.0005, height: 101 }, { txid: "cd".repeat(32), vout: 0, amount: 0.1, height: 102 }] });
        if (body.method === "estimatesmartfee") return reply({ errors: ["Insufficient data or no feerate found"], blocks: 0 });
        if (body.method === "sendrawtransaction") return Response.json({ result: null, error: { code: -26, message: "non-final" }, id: body.id }, { status: 500 });
        return reply(null, { code: -32601, message: "Method not found" });
      }, calls),
    );
    assert.equal(node.name, "bitcoind 127.0.0.1:18443");
    const u = await node.utxos("bcrt1qexample");
    assert.deepEqual(u.map((x) => [x.txid, x.vout, x.value]), [["ab".repeat(32), 2, 50_000], ["cd".repeat(32), 0, 10_000_000]]);
    assert.equal(seen[0]!.url, "http://127.0.0.1:18443/wallet/x");
    assert.equal(seen[0]!.auth, `Basic ${Buffer.from("user:p@ss").toString("base64")}`);
    assert.deepEqual(seen[0]!.body.params, ["start", [{ desc: "addr(bcrt1qexample)" }]]);
    assert.equal(await node.feeRate(), 2);
    await assert.rejects(node.broadcast("00"), (e: unknown) => e instanceof BroadcastRejected && e.reason === "non-final (RPC code -26)");
    assert.equal(btcToSats(0.00000001), 1);
    assert.equal(btcToSats(20.99999999), 2_099_999_999);
  });
});

test("createBond (dry run) runs the same path with any backend: file first, nothing broadcast", async () => {
  const key = btcKey(secp256k1.utils.randomPrivateKey(), "regtest");
  const sent: string[] = [];
  const backend = {
    network: "regtest" as const,
    name: "fake",
    utxos: async () => [{ txid: "ef".repeat(32), vout: 1, value: 100_000 }],
    feeRate: async () => 4,
    broadcast: async (h: string) => (sent.push(h), "00"),
    tx: async () => ({ found: false, confirmed: false, confirmations: 0 }),
    tip: async () => ({ height: 1, time: 1, medianTime: 1 }),
    outputSpent: async () => undefined,
  };
  let written: BondFile | undefined;
  const r = await createBond({
    backend,
    key,
    network: "regtest",
    chainId: 31_337,
    contract: fidelityBondsCreate2Address(),
    agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    sats: 25_000n,
    locktime: Math.floor(Date.now() / 1000) + 3600,
    dryRun: true,
    beforeBroadcast: (f) => (written = f),
  });
  assert.equal(r.broadcast, false);
  assert.equal(sent.length, 0);
  assert.equal(written, r.file);
  assert.equal(r.file.feeRate, 4);
  assert.equal(r.file.fundingAddress, key.address);
  assert.equal(r.file.txid, `0x${r.tx.txid}`);
});

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const run = promisify(execFile);
async function hbfAsync(args: string[], cwd = SDK): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [join(SDK, "bin/hbf.mjs"), ...args], { cwd, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function fakeHemi(chainIdHex: string): Promise<{ url: string; methods: string[]; server: Server }> {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const r = JSON.parse(body) as { id: unknown; method: string };
      methods.push(r.method);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r.method === "eth_chainId" ? { jsonrpc: "2.0", id: r.id, result: chainIdHex } : { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "not in this test" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${a.port}`, methods, server };
}

describe("CLI", () => {
  let hemi: Awaited<ReturnType<typeof fakeHemi>>;
  let dir: string;
  let mainnetBond: string;
  before(async () => {
    hemi = await fakeHemi("0xa867");
    dir = mkdtempSync(join(tmpdir(), "hbf-bond-cli-"));
    // a bond file on Bitcoin mainnet (built offline; nothing was or will be broadcast)
    const priv = secp256k1.utils.randomPrivateKey();
    const key = btcKey(priv, "mainnet");
    const ws = bondWitnessScript(Math.floor(Date.now() / 1000) + 3600, key.publicKey);
    const tag = tagScript(43_111, fidelityBondsCreate2Address(), "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const f = buildFundingTx(key, [{ txid: "12".repeat(32), vout: 0, value: 40_000 }], { sats: 20_000n, witnessScript: ws, tag, feeRate: 2 });
    mainnetBond = join(dir, "mainnet-bond.json");
    writeBondFile(mainnetBond, {
      schema: "hemi-bitcoin-facts/bond-file/v1",
      network: "mainnet",
      chainId: 43_111,
      contract: fidelityBondsCreate2Address(),
      agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      txid: `0x${f.txid}`,
      bondVout: 0,
      tagVout: 1,
      sats: 20_000n,
      locktime: parseBondWitnessScript(ws).locktime,
      pubkey: bytesToHex(key.publicKey),
      witnessScript: bytesToHex(ws),
      bondScript: bytesToHex(bondOutputScript(ws)),
      bondAddress: bondAddress(ws, "mainnet"),
      tagScript: bytesToHex(tag),
      fundingAddress: key.address,
      fee: f.fee,
      feeRate: 2,
      hex: `0x${f.hex}`,
    });
  });
  after(() => hemi.server.close());

  test("help for every command", async () => {
    for (const c of ["create", "record", "status", "refresh", "redeem"]) {
      const r = await hbfAsync(["bond", c, "--help"]);
      assert.equal(r.code, 0, c);
      assert.match(r.stdout, new RegExp(`usage: hbf bond ${c}`));
    }
    const g = await hbfAsync(["bond", "--help"]);
    assert.equal(g.code, 0);
    assert.match(g.stdout, /not collateral/);
    assert.equal((await hbfAsync(["bond", "nope"])).code, 2);
  });

  test("create on Bitcoin mainnet: the caps and --allow-mainnet are checked before any key or request", async () => {
    const base = ["bond", "create", "--agent", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "--chain-id", "43111", "--esplora", "http://127.0.0.1:9/never", "--btc-key-file", "/nonexistent/.secrets/none.key"];
    let r = await hbfAsync([...base, "--sats", "20001", "--lock-for", "2h", "--allow-mainnet"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing 20001 sats on Bitcoin mainnet: the cap is 20000 sats/);
    r = await hbfAsync([...base, "--sats", "20000", "--lock-for", "25h", "--allow-mainnet"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cap is 24 hours/);
    r = await hbfAsync([...base, "--sats", "20000", "--lock-for", "2h"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing to broadcast on Bitcoin mainnet without --allow-mainnet/);
    // without --rpc the registry cannot be checked: refused, still before any key (independent audit, finding 2)
    r = await hbfAsync([...base, "--sats", "20000", "--lock-for", "2h", "--allow-mainnet"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /needs --rpc <hemi rpc> to check that FidelityBonds is deployed/);
    // past the guards it reaches the key file, which does not exist: the guards came first
    r = await hbfAsync([...base, "--sats", "20000", "--lock-for", "2h", "--allow-mainnet", "--no-registry-check"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ENOENT|no such file/);
  });

  test("create: the network follows the chain, the key must be under .secrets/", async () => {
    let r = await hbfAsync(["bond", "create", "--agent", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "--chain-id", "43111", "--btc-network", "regtest", "--sats", "20000", "--lock-for", "1h"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Hemi chain 43111 reads Bitcoin mainnet/);
    const keyFile = join(dir, "plain.key");
    writeFileSync(keyFile, "x");
    r = await hbfAsync(["bond", "create", "--agent", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "--chain-id", "31337", "--btc-network", "regtest", "--btc-rpc", "http://u:p@127.0.0.1:9", "--sats", "20000", "--lock-for", "1h", "--btc-key-file", keyFile, "--no-registry-check"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--btc-key-file must point inside a \.secrets\/ directory/);
    r = await hbfAsync(["bond", "create", "--agent", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "--chain-id", "31337", "--btc-network", "regtest", "--sats", "20000", "--lock-for", "1h", "--btc-key-file", keyFile, "--no-registry-check"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /regtest needs --btc-rpc/);
  });

  test("redeem on Bitcoin mainnet without --allow-mainnet is refused before any key or request", async () => {
    const r = await hbfAsync(["bond", "redeem", "--bond-file", mainnetBond, "--to", "bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkv", "--esplora", "http://127.0.0.1:9/never", "--btc-key-file", "/nonexistent/.secrets/none.key"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing to broadcast on Bitcoin mainnet without --allow-mainnet/);
    const wrong = await hbfAsync(["bond", "redeem", "--bond-file", mainnetBond, "--to", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "--allow-mainnet"]);
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /--to tb1q\S+ is not a Bitcoin mainnet address/);
  });

  test("record and refresh on Hemi mainnet without --allow-mainnet are refused after one eth_chainId", async () => {
    for (const cmd of [
      ["bond", "record", "--bond-file", mainnetBond],
      ["bond", "refresh", "--id", `0x${"11".repeat(32)}`],
    ]) {
      const before = hemi.methods.length;
      const r = await hbfAsync([...cmd, "--rpc", hemi.url, "--contract", fidelityBondsCreate2Address(), "--key-file", "/nonexistent/.secrets/none.key"]);
      assert.equal(r.code, 2, cmd.join(" "));
      assert.match(r.stderr, /refusing to send a transaction on Hemi mainnet without --allow-mainnet/);
      assert.deepEqual(hemi.methods.slice(before), ["eth_chainId"]);
    }
  });

  test("status needs exactly one subject; a non-JSON file is invalid", async () => {
    let r = await hbfAsync(["bond", "status", "--rpc", hemi.url, "--contract", fidelityBondsCreate2Address()]);
    assert.equal(r.code, 2);
    r = await hbfAsync(["bond", "status", join(dir, "nope.json"), "--rpc", hemi.url, "--contract", fidelityBondsCreate2Address()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: malformed fact file/);
  });

  test("the bond file create writes is public data: no key in it", () => {
    const text = readFileSync(mainnetBond, "utf8");
    assert.doesNotMatch(text, /privateKey|wif/i);
    const keys = Object.keys(JSON.parse(text) as object);
    assert.deepEqual(keys, ["schema", "network", "chainId", "contract", "agent", "txid", "bondVout", "tagVout", "sats", "locktime", "locktimeIso", "pubkey", "witnessScript", "bondScript", "bondAddress", "tagScript", "fundingAddress", "fee", "feeRate", "hex"]);
  });
});
