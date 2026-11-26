/**
 * End to end on the anvil fork of Hemi mainnet (sdk/test/helpers/anvil.ts): BitcoinFacts deployed through the real
 * CREATE2 deployer, MockHvm answering with the real mainnet fixtures, and every step through the `hbf` CLI.
 * HBF_E2E_NO_FORK=1 runs the same on a plain local chain.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BITCOIN_FACTS_INIT_CODE,
  BITCOIN_FACTS_RUNTIME,
  BITCOIN_FACTS_SALT,
  bitcoinFactsAbi,
  bitcoinFactsCreate2Address,
  outputId,
  parseFactFile,
  recordFact,
  serializeFactFile,
  verifyFactId,
  type FactFile,
} from "../src/facts.js";
import {
  ANVIL_KEY_1,
  deployCreate2,
  encodeHeader,
  hbf,
  installForwarder,
  installMockHvm,
  mockHvm,
  SDK,
  sendVia,
  startAnvil,
  type Anvil,
} from "./helpers/anvil.js";

// Mainnet fixtures (docs/BRIEF.md; DECISIONS.md D-001, D-004, D-007)
const TIP = { height: 976_833, hash: "0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a" as Hex };
const UNSPENT = {
  txid: "0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4" as Hex,
  script: "0x001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831" as Hex,
  confirmations: 1596,
};
const SPENT = {
  txid: "0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e" as Hex,
  script: "0x0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4" as Hex,
  // 0x42 with flags 003c0703 as mainnet answered it (D-004)
  txOutputs:
    "0x0002000000001b8430890022512068d343ef205a6afa4ae74508ab4aefb92dd46549e30d5eecf63acf3155c0798e000000000004f33e1000220020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c400" as Hex,
  confirmations: 1647,
};
const P2PKH = { address: "18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm", script: "0x76a9144f364626b44b11929dd604d3cc592c4b8d887d1c88ac" as Hex, sats: 108_217n };

let anvil: Anvil;
let contract: Address;
let other: Address; // a second BitcoinFacts deployment
let dir: string;
let outputFile: string;
let balanceFile: string;

const rpcArgs = () => ["--rpc", anvil.url, "--contract", contract];
const read = (path: string): FactFile => {
  const p = parseFactFile(JSON.parse(readFileSync(path, "utf8")));
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.file;
};
/** Writes a tampered copy of a fact file's JSON. */
function tamper(path: string, name: string, edit: (o: Record<string, any>) => void): string {
  const o = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  edit(o);
  const out = join(dir, name);
  writeFileSync(out, `${JSON.stringify(o, null, 2)}\n`);
  return out;
}

before(async () => {
  anvil = await startAnvil();
  await installMockHvm(anvil);
  await mockHvm(anvil, 0x44, "setTip", [encodeHeader({ height: TIP.height, hash: TIP.hash })]);
  for (const p of [0x48, 0x42]) {
    await mockHvm(anvil, p, "setOutput", [UNSPENT.txid, 0, 1000n, UNSPENT.script, 1]);
    await mockHvm(anvil, p, "setOutput", [UNSPENT.txid, 1, 859n, "0x0014208fa508568396937efe008cbae70b4fe8a1ae45", 1]);
  }
  await mockHvm(anvil, 0x43, "setConfirmations", [UNSPENT.txid, UNSPENT.confirmations]);
  await mockHvm(anvil, 0x42, "setRaw", [`${SPENT.txid}003c0703`, SPENT.txOutputs]);
  await mockHvm(anvil, 0x43, "setConfirmations", [SPENT.txid, SPENT.confirmations]);
  await mockHvm(anvil, 0x46, "setScript", [P2PKH.address, P2PKH.script]);
  await mockHvm(anvil, 0x40, "setBalance", [P2PKH.address, P2PKH.sats]);

  contract = await deployCreate2(anvil, BITCOIN_FACTS_INIT_CODE, BITCOIN_FACTS_SALT);
  other = await deployCreate2(anvil, BITCOIN_FACTS_INIT_CODE, toHex(1, { size: 32 }));
  dir = mkdtempSync(join(tmpdir(), "hbf-facts-"));
  outputFile = join(dir, "output.json");
  balanceFile = join(dir, "balance.json");
});

after(async () => {
  await anvil?.stop();
});

test("BitcoinFacts lands at the CREATE2 address the SDK predicts", () => {
  assert.equal(contract, bitcoinFactsCreate2Address());
});

describe("check", () => {
  test("the unspent fixture: Ok, 1,000 sats, its script hash, not spent", () => {
    const r = hbf(["facts", "check", ...rpcArgs(), "--txid", UNSPENT.txid, "--vout", "0", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.verdict, "Ok");
    assert.equal(j.fact.sats, "1000");
    assert.equal(j.fact.scriptHash, keccak256(UNSPENT.script));
    assert.equal(j.fact.spent, false);
    assert.equal(j.fact.confirmations, UNSPENT.confirmations);
    assert.equal(j.asOf.btcHeight, TIP.height);
    assert.equal(j.recorded, false);
  });

  test("the spent fixture reads as spent", () => {
    const r = hbf(["facts", "check", ...rpcArgs(), "--txid", SPENT.txid, "--vout", "1"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /verdict\s+Ok/);
    assert.match(r.stdout, /sats\s+83050000/);
    assert.match(r.stdout, /spent\s+yes/);
  });

  test("an unknown output is NotFound, exit 1", () => {
    const r = hbf(["facts", "check", ...rpcArgs(), "--txid", `0x${"11".repeat(32)}`, "--vout", "0"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /verdict\s+NotFound/);
  });

  test("--code-override runs the compiled code where nothing is deployed", () => {
    const empty = "0x00000000000000000000000000000000000fac75";
    const r = hbf(["facts", "check", "--rpc", anvil.url, "--contract", empty, "--code-override", "--address", P2PKH.address, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.verdict, "Ok");
    assert.equal(j.fact.sats, P2PKH.sats.toString());
    assert.equal(j.fact.scriptHash, keccak256(P2PKH.script));
    assert.equal(j.codeOverride, true);
    // without the override there is no code there
    const without = hbf(["facts", "check", "--rpc", anvil.url, "--contract", empty, "--address", P2PKH.address]);
    assert.equal(without.code, 1);
    assert.match(without.stderr, /no contract at 0x[0-9a-fA-F]{40} on chain 31337; --code-override/);
  });

  test("a wrong-network address is refused", () => {
    const r = hbf(["facts", "check", ...rpcArgs(), "--address", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /testnet address/);
  });
});

describe("record", () => {
  test("an output fact", () => {
    const r = hbf(["facts", "record", ...rpcArgs(), "--txid", UNSPENT.txid, "--vout", "0", "--key-file", anvil.keyFile, "--out", outputFile]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^recorded output fact 0x[0-9a-f]{64} in Hemi tx/);
    const text = readFileSync(outputFile, "utf8");
    const file = read(outputFile);
    assert.equal(serializeFactFile(file), text, "the file is in canonical form");
    assert.equal(file.chainId, anvil.chainId);
    assert.equal(file.contract, contract.toLowerCase());
    assert.equal(file.kind, "output");
    if (file.kind !== "output") return;
    assert.equal(file.fact.sats, 1000n);
    assert.equal(file.fact.spent, false);
    assert.equal(file.fact.script, UNSPENT.script);
    assert.equal(file.asOf.btcBlockHash, TIP.hash);
  });

  test("again at the same Bitcoin tip: nothing is sent, same id", () => {
    const before = read(outputFile);
    const r = hbf(["facts", "record", ...rpcArgs(), "--txid", UNSPENT.txid, "--vout", "0", "--key-file", anvil.keyFile, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.created, false);
    assert.equal(j.sentTxHash, undefined);
    assert.equal(j.file.id, before.id);
    assert.equal(j.file.recording.txHash, before.recording.txHash);
  });

  test("a balance fact", () => {
    const r = hbf(["facts", "record", ...rpcArgs(), "--address", P2PKH.address, "--key-file", anvil.keyFile, "--out", balanceFile]);
    assert.equal(r.code, 0, r.stderr);
    const file = read(balanceFile);
    assert.equal(file.kind, "balance");
    assert.equal(file.fact.sats, P2PKH.sats);
    assert.equal(file.fact.scriptHash, keccak256(P2PKH.script));
  });

  test("the spent fixture records as spent", () => {
    const path = join(dir, "spent.json");
    const r = hbf(["facts", "record", ...rpcArgs(), "--txid", SPENT.txid, "--vout", "1", "--key-file", anvil.keyFile, "--out", path]);
    assert.equal(r.code, 0, r.stderr);
    const file = read(path);
    assert.ok(file.kind === "output" && file.fact.spent && file.fact.sats === 83_050_000n);
  });

  test("a non-Ok verdict sends nothing", () => {
    const r = hbf(["facts", "record", ...rpcArgs(), "--txid", `0x${"11".repeat(32)}`, "--vout", "0", "--key-file", anvil.keyFile]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not recorded: verdict NotFound/);
  });
});

describe("verify", () => {
  test("output and balance files are valid", () => {
    for (const f of [outputFile, balanceFile]) {
      const r = hbf(["facts", "verify", f, ...rpcArgs()]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /^valid\n/);
      assert.match(r.stdout, /hemi stage\s+(latest|safe|finalized)/);
    }
  });

  test("--id is valid and needs no file", () => {
    for (const f of [outputFile, balanceFile]) {
      const r = hbf(["facts", "verify", "--id", read(f).id, ...rpcArgs(), "--json"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const j = JSON.parse(r.stdout);
      assert.equal(j.valid, true);
      assert.equal(`${JSON.stringify(j.file, null, 2)}\n`, readFileSync(f, "utf8"), "verify --id rebuilds the same file");
    }
  });

  test("with only --rpc and --contract: no key, empty HOME, nothing else in the environment", () => {
    const home = mkdtempSync(join(tmpdir(), "hbf-empty-home-"));
    let stdout: string;
    try {
      stdout = execFileSync(process.execPath, [join(SDK, "bin/hbf.mjs"), "facts", "verify", outputFile, "--rpc", anvil.url, "--contract", contract], {
        cwd: home,
        env: { HOME: home },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      assert.fail(`verify failed: ${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
    assert.match(stdout, /^valid\n/);
  });

  test("(a) a changed value in the file", () => {
    const f = tamper(outputFile, "changed-sats.json", (o) => (o.fact.sats = "1001"));
    const r = hbf(["facts", "verify", f, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: changed value: fact\.sats is 1001 in the file but 1000 on chain/);
    const g = tamper(balanceFile, "changed-height.json", (o) => (o.asOf.btcHeight = String(TIP.height - 1)));
    assert.match(hbf(["facts", "verify", g, ...rpcArgs()]).stdout, /^invalid: changed value: asOf\.btcHeight/);
    const h = tamper(outputFile, "changed-spent.json", (o) => (o.fact.spent = true));
    assert.match(hbf(["facts", "verify", h, ...rpcArgs()]).stdout, /^invalid: changed value: fact\.spent/);
    const s = tamper(outputFile, "changed-script.json", (o) => (o.fact.script = "0x0014" + "00".repeat(20)));
    assert.match(hbf(["facts", "verify", s, ...rpcArgs()]).stdout, /^invalid: changed value: fact\.script does not hash/);
  });

  test("(b) a wrong contract address", () => {
    // the right file against another contract
    let r = hbf(["facts", "verify", outputFile, "--rpc", anvil.url, "--contract", other]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: wrong contract: the file names 0x[0-9a-f]{40}, verifying against 0x/);
    // a file edited to name another BitcoinFacts, verified against it
    const f = tamper(outputFile, "other-contract.json", (o) => (o.contract = other.toLowerCase()));
    r = hbf(["facts", "verify", f, "--rpc", anvil.url, "--contract", other]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: not recorded: no fact with id/);
    // an address with no code
    const nobody = "0x000000000000000000000000000000000000dead";
    const g = tamper(outputFile, "no-code.json", (o) => (o.contract = nobody));
    r = hbf(["facts", "verify", g, "--rpc", anvil.url, "--contract", nobody]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: no contract code/);
  });

  test("(c) a recording transaction that does not exist", () => {
    const f = tamper(outputFile, "no-tx.json", (o) => (o.recording.txHash = `0x${"ab".repeat(32)}`));
    const r = hbf(["facts", "verify", f, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: recording transaction does not exist: no transaction 0xabab/);
  });

  test("an id that does not recompute", () => {
    const f = tamper(outputFile, "bad-id.json", (o) => (o.id = read(balanceFile).id));
    const r = hbf(["facts", "verify", f, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: id does not recompute/);
    const g = tamper(outputFile, "other-vout.json", (o) => (o.fact.vout = "1"));
    assert.match(hbf(["facts", "verify", g, ...rpcArgs()]).stdout, /^invalid: id does not recompute/);
  });

  test("a recording transaction of another fact", () => {
    const f = tamper(outputFile, "other-tx.json", (o) => {
      const b = read(balanceFile);
      o.recording.txHash = b.recording.txHash;
    });
    const r = hbf(["facts", "verify", f, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: (recording transaction is in another block|no matching event)/);
  });

  test("an unknown id", () => {
    const r = hbf(["facts", "verify", "--id", `0x${"77".repeat(32)}`, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: not recorded/);
  });
});

describe("status", () => {
  test("a recorded output fact", () => {
    const id = read(outputFile).id;
    const r = hbf(["facts", "status", "--id", id, ...rpcArgs()]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^recorded\n/);
    assert.match(r.stdout, /hemi stage\s+(latest|safe|finalized)/);
    assert.match(r.stdout, /now\s+unspent, 1000 sats/);
  });

  test("an unknown id", () => {
    const r = hbf(["facts", "status", "--id", `0x${"77".repeat(32)}`, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^not recorded/);
  });
});

describe("pre-mainnet audit", () => {
  /** Runs `body` and puts the chain (and so MockHvm's answers) back as it was. */
  async function isolated(body: () => Promise<void>): Promise<void> {
    const snapshot = await anvil.rpc<Hex>("evm_snapshot");
    try {
      await body();
    } finally {
      await anvil.rpc("evm_setAutomine", [true]);
      await anvil.rpc("evm_revert", [snapshot]);
    }
  }

  test("M-1: a fact recorded through another contract verifies; the same event from another deployment does not", () =>
    isolated(async () => {
      await installForwarder(anvil);
      const data = encodeFunctionData({ abi: bitcoinFactsAbi, functionName: "recordOutput", args: [UNSPENT.txid, 1] });
      // In one block: through the forwarder to the contract, and straight to another deployment (the same event, the
      // same id, emitted from another address).
      await anvil.rpc("evm_setAutomine", [false]);
      const via = await sendVia(anvil, contract, data);
      const twin = await anvil.wallet.sendTransaction({ account: anvil.wallet.account!, chain: anvil.wallet.chain, to: other, data, gas: 3_000_000n });
      await anvil.rpc("evm_mine");
      await anvil.rpc("evm_setAutomine", [true]);
      const [rv, rt] = await Promise.all([anvil.client.getTransactionReceipt({ hash: via }), anvil.client.getTransactionReceipt({ hash: twin })]);
      assert.equal(rv.status, "success");
      assert.equal(rt.status, "success");
      assert.notEqual(rv.to?.toLowerCase(), contract.toLowerCase(), "the recording transaction went to the forwarder");
      assert.equal(rt.blockNumber, rv.blockNumber);

      const id = outputId(UNSPENT.txid, 1, TIP.hash);
      let r = hbf(["facts", "verify", "--id", id, ...rpcArgs(), "--json"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const j = JSON.parse(r.stdout);
      assert.equal(j.valid, true);
      assert.equal(j.file.recording.txHash, via);
      const path = join(dir, "via-forwarder.json");
      writeFileSync(path, `${JSON.stringify(j.file, null, 2)}\n`);
      r = hbf(["facts", "verify", path, ...rpcArgs()]);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /^valid\n/);
      r = hbf(["facts", "status", "--id", id, ...rpcArgs()]);
      assert.equal(r.code, 0, r.stdout + r.stderr);

      const forged = tamper(path, "via-other-deployment.json", (o) => {
        o.recording.txHash = twin;
      });
      r = hbf(["facts", "verify", forged, ...rpcArgs()]);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /^invalid: no matching event/);
    }));

  test("I-3: verify refuses a contract whose code is not this SDK's BitcoinFacts", () =>
    isolated(async () => {
      const lookalike: Address = "0x00000000000000000000000000000000000fac75";
      await anvil.rpc("anvil_setCode", [lookalike, `${BITCOIN_FACTS_RUNTIME}00`]);
      const id = read(outputFile).id;
      const r = hbf(["facts", "verify", "--id", id, "--rpc", anvil.url, "--contract", lookalike]);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /^invalid: not a BitcoinFacts contract: the code at 0x[0-9a-fA-F]{40} is not this SDK's BitcoinFacts/);
      // A library caller can accept other code; this look-alike has nothing stored.
      const v = await verifyFactId(anvil.client, lookalike, id, { allowOtherCode: true });
      assert.equal(v.valid, false);
      assert.equal(v.valid ? "" : v.code, "not-recorded");
      // The real deployments' code is this SDK's.
      assert.equal((await verifyFactId(anvil.client, contract, id)).valid, true);
      // status, check and record refuse it too (pre-mainnet review R-2)
      for (const args of [
        ["facts", "status", "--id", id],
        ["facts", "check", "--txid", UNSPENT.txid, "--vout", "0"],
        ["facts", "record", "--txid", UNSPENT.txid, "--vout", "0", "--key-file", anvil.keyFile],
      ]) {
        const s = hbf([...args, "--rpc", anvil.url, "--contract", lookalike]);
        assert.equal(s.code, 1, args.join(" "));
        assert.match(s.stderr, /is not this SDK's BitcoinFacts .*refusing to use it/, args.join(" "));
      }
    }));

  test("L-4: the Bitcoin tip moves after the check and someone records the newer tip's fact first: the file is that one", () =>
    isolated(async () => {
      const H2 = { height: TIP.height + 1, hash: keccak256(toHex("facts-e2e-tip-2")) };
      const account = privateKeyToAccount(ANVIL_KEY_1);
      // A wallet whose send first lets the tip move and another transaction record the same output at the new tip.
      const racing = {
        chain: anvil.wallet.chain,
        async writeContract(args: Parameters<WalletClient["writeContract"]>[0]) {
          await mockHvm(anvil, 0x44, "setTip", [encodeHeader({ height: H2.height, hash: H2.hash })]);
          const first = await anvil.wallet.writeContract({
            address: contract,
            abi: bitcoinFactsAbi,
            functionName: "recordOutput",
            args: [UNSPENT.txid, 1],
            account: anvil.wallet.account!,
            chain: anvil.wallet.chain,
          });
          assert.equal((await anvil.client.waitForTransactionReceipt({ hash: first })).status, "success");
          return anvil.wallet.writeContract(args as never);
        },
      } as unknown as WalletClient;
      const r = await recordFact(anvil.client, racing, account, anvil.chainId, contract, { kind: "output", txid: UNSPENT.txid, vout: 1 });
      assert.equal(r.created, false, "this transaction changed nothing");
      assert.match(r.sentTxHash ?? "", /^0x[0-9a-f]{64}$/);
      assert.equal(r.file.id, outputId(UNSPENT.txid, 1, H2.hash), "the fact stored at the newer tip");
      assert.notEqual(r.file.id, outputId(UNSPENT.txid, 1, TIP.hash));
      assert.equal(r.file.asOf.btcBlockHash, H2.hash);
    }));
});

describe("finality stage and reorgs (last: these move the chain)", () => {
  test("the stage reaches finalized as blocks are added", async () => {
    await anvil.mine(80);
    const r = hbf(["facts", "verify", balanceFile, ...rpcArgs()]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /hemi stage\s+finalized/);
  });

  test("a recording block that is no longer canonical", async () => {
    // Record a fact, then roll the chain back and mine the same transaction into a different block at that height.
    const snapshot = await anvil.rpc<Hex>("evm_snapshot");
    const path = join(dir, "reorged.json");
    let r = hbf(["facts", "record", ...rpcArgs(), "--txid", UNSPENT.txid, "--vout", "1", "--key-file", anvil.keyFile, "--out", path]);
    assert.equal(r.code, 0, r.stderr);
    const first = read(path);
    assert.equal(hbf(["facts", "verify", path, ...rpcArgs()]).code, 0);

    await anvil.rpc("evm_revert", [snapshot]);
    const head = await anvil.client.getBlock();
    await anvil.rpc("evm_setNextBlockTimestamp", [toHex(head.timestamp + 1000n)]);
    r = hbf(["facts", "record", ...rpcArgs(), "--txid", UNSPENT.txid, "--vout", "1", "--key-file", anvil.keyFile, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const again = JSON.parse(r.stdout).file as { id: string; recording: { blockNumber: string; blockHash: string } };
    assert.equal(again.id, first.id);
    assert.equal(again.recording.blockNumber, first.recording.blockNumber.toString());
    assert.notEqual(again.recording.blockHash, first.recording.blockHash);

    r = hbf(["facts", "verify", path, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: recording block is not canonical: block \d+ is now 0x/);
  });
});
