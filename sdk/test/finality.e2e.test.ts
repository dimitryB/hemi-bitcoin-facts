/**
 * End to end on the anvil fork of Hemi mainnet (sdk/test/helpers/anvil.ts): PopFinality deployed through the real
 * CREATE2 deployer, MockHvm answering 0x42/0x43 with publications of keystones the local chain cut (their block
 * hashes are anvil's), a fake Esplora serving raw Bitcoin blocks, and every step through the `hbf` CLI.
 * HBF_E2E_NO_FORK=1 runs the same on a plain local chain.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import {
  esploraClient,
  finalityStatus,
  parsePublicationFile,
  POP_FINALITY_INIT_CODE,
  POP_FINALITY_RUNTIME,
  POP_FINALITY_SALT,
  popFinalityAbi,
  popFinalityCreate2Address,
  readBestPublication,
  readCheckpoint,
  readPublication,
  recordCandidates,
  serializePublicationFile,
  watch,
  type CanonicalCache,
  type PublicationFactFile,
} from "../src/finality.js";
import { deployCreate2, encodeHeader, hbf, installForwarder, installMockHvm, mockHvm, SDK, sendVia, startAnvil, type Anvil } from "./helpers/anvil.js";
import { buildAbrev, buildTx, FakeEsplora, P2PKH, popScript, popTxOutputs, type BuiltTx } from "./helpers/bitcoin.js";

const TIP = { height: 976_833, hash: "0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a" as Hex };
const fork = process.env.HBF_E2E_NO_FORK !== "1";

let anvil: Anvil;
let contract: Address;
let other: Address; // a second PopFinality deployment
let dir: string;
let K: number; // the keystone checkpointed and recorded by hand
let OLD: number; // a keystone outside every block hash window
let fileA: string;
const A = keccak256(toHex("pop a"));
const B = keccak256(toHex("pop b"));
const W = keccak256(toHex("pop of another keystone"));
const fake = new FakeEsplora();

const rpcArgs = () => ["--rpc", anvil.url, "--contract", contract];
const keyArgs = () => ["--key-file", anvil.keyFile];
const read = (path: string): PublicationFactFile => {
  const p = parsePublicationFile(JSON.parse(readFileSync(path, "utf8")));
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.file;
};
function tamper(path: string, name: string, edit: (o: Record<string, any>) => void): string {
  const o = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  edit(o);
  const out = join(dir, name);
  writeFileSync(out, `${JSON.stringify(o, null, 2)}\n`);
  return out;
}
const head = async () => Number(await anvil.client.getBlockNumber());
const nextKeystone = async () => Math.floor((await head()) / 25) * 25 + 25;
async function mineTo(n: number): Promise<void> {
  const h = await head();
  if (h < n) await anvil.mine(n - h);
}
/** Keystone k's abbreviated keystone as the local chain gives it (the L1 origin is made up: nothing checks it). */
async function abrevFor(k: number): Promise<Hex> {
  const [b, prev] = await Promise.all([anvil.client.getBlock({ blockNumber: BigInt(k) }), anvil.client.getBlock({ blockNumber: BigInt(k - 25) })]);
  return buildAbrev({ l2: k, parentHash: b.parentHash, prevKeystoneHash: prev.hash!, stateRoot: b.stateRoot, blockHash: b.hash! });
}
/** MockHvm answers for `txid` as a PoP transaction publishing `abrev` at vout 1, with `confs` confirmations. */
async function setPop(txid: Hex, abrev: Hex, confs: number): Promise<void> {
  await mockHvm(anvil, 0x42, "setRaw", [`${txid}003c0703`, popTxOutputs(popScript(abrev))]);
  await mockHvm(anvil, 0x43, "setConfirmations", [txid, confs]);
}
const prefixOf = async (k: number) => (await anvil.client.getBlock({ blockNumber: BigInt(k) })).hash!.slice(0, 26);

/**
 * The CLI without blocking this process: the fake Esplora is served from here, so a synchronous run (the harness's
 * `hbf`) would leave the CLI's Esplora requests unanswered until they time out.
 */
const runAsync = promisify(execFile);
async function hbfAsync(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await runAsync(process.execPath, [join(SDK, "bin/hbf.mjs"), ...args], { cwd: SDK, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

before(async () => {
  anvil = await startAnvil();
  await installMockHvm(anvil);
  await mockHvm(anvil, 0x44, "setTip", [encodeHeader({ height: TIP.height, hash: TIP.hash })]);
  contract = await deployCreate2(anvil, POP_FINALITY_INIT_CODE, POP_FINALITY_SALT);
  other = await deployCreate2(anvil, POP_FINALITY_INIT_CODE, toHex(1, { size: 32 }));
  if (fork) {
    OLD = 5_620_225; // a mainnet keystone, ~160,000 blocks back
  } else {
    await anvil.mine(8_300);
    OLD = 25;
  }
  K = await nextKeystone();
  await mineTo(K + 2);
  await setPop(A, await abrevFor(K), 12);
  dir = mkdtempSync(join(tmpdir(), "hbf-finality-"));
  fileA = join(dir, "publication-a.json");
  await fake.start();
});

after(async () => {
  fake.close();
  await anvil?.stop();
});

test("PopFinality lands at the CREATE2 address the SDK predicts", () => {
  assert.equal(contract, popFinalityCreate2Address());
});

describe("checkpoint", () => {
  test("keystone K: sent, and the stored prefix is block K's hash prefix", async () => {
    const r = hbf(["finality", "checkpoint", "--keystone", String(K), ...rpcArgs(), ...keyArgs()]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^checkpointed keystone ${K}: ${await prefixOf(K)} in Hemi tx 0x[0-9a-f]{64}`));
    assert.equal((await readCheckpoint(anvil.client, contract, K))?.blockHashPrefix, await prefixOf(K));
  });

  test("again: already checkpointed, nothing sent", async () => {
    const before = await head();
    const r = hbf(["finality", "checkpoint", "--keystone", String(K), ...rpcArgs(), ...keyArgs(), "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).created, false);
    assert.equal(await head(), before);
  });

  test("outside the 8,191-block window, or not produced yet: refused, nothing sent", async () => {
    const before = await head();
    let r = hbf(["finality", "checkpoint", "--keystone", String(OLD), ...rpcArgs(), ...keyArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not checkpointed: keystone \d+: OutsideWindow .*nothing was sent/);
    r = hbf(["finality", "checkpoint", "--keystone", String(K + 1000), ...rpcArgs(), ...keyArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /NotProduced/);
    assert.equal(await head(), before);
  });
});

describe("record", () => {
  test("--btc-txid without --vout: the PoP output is found through 0x42, recorded, and the fact file written", async () => {
    const r = await hbfAsync(["finality", "record", "--keystone", String(K), "--btc-txid", A, ...rpcArgs(), ...keyArgs(), "--out", fileA]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^recorded the publication of keystone ${K}: ${A}:1, 12 confirmations, in Hemi tx 0x[0-9a-f]{64} \\(block \\d+\\); K's best\n`));
    // a local chain has no L1-info deposit, so the canonical keystone cannot be rebuilt: the contract alone decides
    assert.match(r.stderr, /note: cannot rebuild the canonical keystone/);
    const text = readFileSync(fileA, "utf8");
    const f = read(fileA);
    assert.equal(serializePublicationFile(f), text, "the file is in canonical form");
    assert.equal(f.kind, "publication");
    assert.equal(f.chainId, anvil.chainId);
    assert.equal(f.contract, contract.toLowerCase());
    assert.deepEqual(f.fact, { keystone: K, btcTxid: A, vout: 1, confirmations: 12, abrev: await abrevFor(K) });
    assert.deepEqual(f.asOf, { btcHeight: TIP.height, btcBlockHash: TIP.hash });
  });

  test("again: already recorded, nothing sent, the same file", async () => {
    const before = await head();
    const r = hbf(["finality", "record", "--keystone", String(K), "--btc-txid", A, "--vout", "1", ...rpcArgs(), "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.created, false);
    assert.equal(j.best, true);
    assert.equal(j.sentTxHash, undefined);
    assert.equal(`${JSON.stringify(j.file, null, 2)}\n`, readFileSync(fileA, "utf8"));
    assert.equal(await head(), before);
  });

  test("a non-Ok verdict sends nothing", async () => {
    await setPop(W, await abrevFor(K - 25), 30); // keystone K − 25's publication offered as K's
    const before = await head();
    let r = hbf(["finality", "record", "--keystone", String(K), "--btc-txid", W, "--vout", "1", ...rpcArgs(), ...keyArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not recorded: verdict WrongKeystone/);
    r = hbf(["finality", "record", "--keystone", String(K), "--btc-txid", keccak256(toHex("unknown")), "--vout", "1", ...rpcArgs(), ...keyArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not recorded: verdict NotFound/);
    assert.equal(await head(), before);
  });

  test("a second publication with fewer confirmations is recorded too, and does not become K's best", async () => {
    await setPop(B, await abrevFor(K), 5);
    const fileB = join(dir, "publication-b.json");
    const r = hbf(["finality", "record", "--keystone", String(K), "--btc-txid", B, ...rpcArgs(), ...keyArgs(), "--out", fileB]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^recorded the publication of keystone ${K}: ${B}:1, 5 confirmations, .*; not K's best \\(${A}:1 has 12 confirmations now\\)`));
    assert.equal((await readPublication(anvil.client, contract, K, B, 1))?.confirmations, 5);
    assert.equal((await readBestPublication(anvil.client, contract, K))?.btcTxid, A);
    const v = hbf(["finality", "verify", fileB, ...rpcArgs()]);
    assert.equal(v.code, 0, v.stdout);
    assert.match(v.stdout, new RegExp(`publication\\s+Bitcoin tx ${B}:1; not K's best`));
  });
});

describe("verify", () => {
  test("the fact file is valid", () => {
    const r = hbf(["finality", "verify", fileA, ...rpcArgs()]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^valid\n/);
    assert.match(r.stdout, new RegExp(`publication\\s+Bitcoin tx ${A}:1; K's best`));
    assert.match(r.stdout, /confirmations\s+12 at recording; now 12 \(isBtcFinalVia: final\)/);
    assert.match(r.stdout, /hemi stage\s+(latest|safe|finalized)/);
    assert.match(r.stdout, /exact match\s+not checked; cannot rebuild the canonical keystone/);
  });

  test("--keystone is valid and rebuilds the same file", () => {
    const r = hbf(["finality", "verify", "--keystone", String(K), ...rpcArgs(), "--json"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.valid, true);
    assert.equal(j.best, true);
    assert.equal(j.now.final, true);
    assert.equal(`${JSON.stringify(j.file, null, 2)}\n`, readFileSync(fileA, "utf8"));
    // a named publication, and one that is not stored
    const b = hbf(["finality", "verify", "--keystone", String(K), "--btc-txid", B, "--vout", "1", ...rpcArgs(), "--json"]);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.equal(JSON.parse(b.stdout).best, false);
    const n = hbf(["finality", "verify", "--keystone", String(K), "--btc-txid", W, "--vout", "1", ...rpcArgs()]);
    assert.equal(n.code, 1);
    assert.match(n.stdout, /^invalid: not recorded: publication 0x[0-9a-f]{64}:1 of keystone \d+ is not stored/);
  });

  test("with only --rpc and --contract: no key, empty HOME, nothing else in the environment", () => {
    const home = mkdtempSync(join(tmpdir(), "hbf-empty-home-"));
    let stdout: string;
    try {
      stdout = execFileSync(process.execPath, [join(SDK, "bin/hbf.mjs"), "finality", "verify", fileA, "--rpc", anvil.url, "--contract", contract], {
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
    const f = tamper(fileA, "changed-confs.json", (o) => (o.fact.confirmations = "13"));
    let r = hbf(["finality", "verify", f, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: changed value: fact\.confirmations is 13 in the file but 12 on chain/);
    const g = tamper(fileA, "changed-state-root.json", (o) => (o.fact.abrev = `${o.fact.abrev.slice(0, 66)}${"ee".repeat(32)}${o.fact.abrev.slice(130)}`));
    r = hbf(["finality", "verify", g, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: changed value: fact\.abrev is 0x[0-9a-f]+ in the file but 0x[0-9a-f]+ in the event/);
    const h = tamper(fileA, "changed-height.json", (o) => (o.asOf.btcHeight = String(TIP.height - 1)));
    assert.match(hbf(["finality", "verify", h, ...rpcArgs()]).stdout, /^invalid: changed value: asOf\.btcHeight/);
    const k = tamper(fileA, "changed-keystone.json", (o) => (o.fact.keystone = String(K - 25)));
    assert.match(hbf(["finality", "verify", k, ...rpcArgs()]).stdout, /^invalid: changed value: fact\.abrev carries keystone \d+, fact\.keystone says \d+/);
  });

  test("(b) a wrong contract address", () => {
    let r = hbf(["finality", "verify", fileA, "--rpc", anvil.url, "--contract", other]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: wrong contract: the file names 0x[0-9a-f]{40}, verifying against 0x/);
    const f = tamper(fileA, "other-contract.json", (o) => (o.contract = other.toLowerCase()));
    r = hbf(["finality", "verify", f, "--rpc", anvil.url, "--contract", other]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: not recorded: publication 0x[0-9a-f]{64}:1 of keystone \d+ is not stored at/);
    const nobody = "0x000000000000000000000000000000000000dead";
    const g = tamper(fileA, "no-code.json", (o) => (o.contract = nobody));
    r = hbf(["finality", "verify", g, "--rpc", anvil.url, "--contract", nobody]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: no contract code/);
  });

  test("(c) a recording transaction that does not exist", () => {
    const f = tamper(fileA, "no-tx.json", (o) => (o.recording.txHash = `0x${"ab".repeat(32)}`));
    const r = hbf(["finality", "verify", f, ...rpcArgs()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: recording transaction does not exist: no transaction 0xabab/);
  });

  test("an id that does not recompute", () => {
    const f = tamper(fileA, "bad-id.json", (o) => (o.id = `0x${"77".repeat(32)}`));
    assert.match(hbf(["finality", "verify", f, ...rpcArgs()]).stdout, /^invalid: id does not recompute/);
    const g = tamper(fileA, "other-vout.json", (o) => (o.fact.vout = "0"));
    assert.match(hbf(["finality", "verify", g, ...rpcArgs()]).stdout, /^invalid: id does not recompute/);
  });
});

describe("status", () => {
  test("anchored (K's best) and, for a named publication, isBtcFinalVia; no receipts reader on a local chain", () => {
    // Without a named publication: anchored only. K's best cannot be shown an exact match here (no canonical
    // keystone on a local chain), so there is no Hemi PoP reading and the exit code is 1.
    let r = hbf(["finality", "status", "--block", String(K - 10), ...rpcArgs(), "--json"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    let j = JSON.parse(r.stdout);
    assert.equal(j.keystone, K);
    assert.equal(j.coveringKeystone, K);
    assert.deepEqual(j.anchored, { verdict: "Ok", confirmations: 12, final: true });
    assert.equal(j.exact, null);
    assert.equal(j.final, false);
    assert.equal(j.reader.source, "unavailable");
    assert.equal(j.agree, null);
    assert.match(j.notes.join(" "), /not shown to be an exact match/);
    // Naming the publication: isBtcFinalVia through it is read, but on a local chain the canonical keystone cannot
    // be rebuilt, so the exact match is not checked and the block is NOT shown Hemi-PoP-final (exit 1). An unchecked
    // match is never final: a one-fee forged keystone would read the same (independent audit, finding 6).
    r = hbf(["finality", "status", "--block", String(K - 10), "--btc-txid", A, ...rpcArgs(), "--json"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    j = JSON.parse(r.stdout);
    assert.deepEqual(j.exact.contract, { verdict: "Ok", confirmations: 12, final: true });
    assert.equal(j.exact.source, "given");
    assert.equal(j.exact.vout, 1);
    assert.equal(j.exact.match.exact, null);
    assert.equal(j.final, false);
    assert.match(j.notes.join(" "), /exact match was not checked/);
    const h = hbf(["finality", "status", "--block", String(K), "--btc-txid", A, ...rpcArgs()]);
    assert.equal(h.code, 1, h.stderr);
    assert.match(h.stdout, /final\s+no: not shown Hemi-PoP-final/);
    assert.match(h.stdout, new RegExp(`Hemi PoP\\s+isBtcFinalVia true: keystone ${K}, publication ${A}:1 \\(given\\): 12 Bitcoin confirmations`));
    assert.match(h.stdout, new RegExp(`anchored\\s+isBtcAnchored true: keystone ${K}'s best publication: 12 Bitcoin confirmations`));
    assert.match(h.stdout, /a forged keystone satisfies it/);
    assert.match(h.stdout, /agree\s+n\/a/);
  });

  test("a later keystone anchors an earlier block; K does not anchor K + 1", () => {
    let r = hbf(["finality", "status", "--block", String(K - 30), ...rpcArgs(), "--skip-reader", "--json"]);
    let j = JSON.parse(r.stdout);
    assert.equal(j.coveringKeystone, K - 25);
    assert.equal(j.keystone, K);
    assert.equal(j.anchored.final, true);
    assert.match(j.notes.join(" "), new RegExp(`uses keystone ${K}`));
    r = hbf(["finality", "status", "--block", String(K - 30), "--keystone", String(K), "--btc-txid", A, ...rpcArgs(), "--skip-reader", "--json"]);
    assert.equal(r.code, 1, r.stdout + r.stderr); // exact match not checkable on a local chain: not final
    assert.equal(JSON.parse(r.stdout).exact.contract.final, true);
    assert.equal(JSON.parse(r.stdout).final, false);
    r = hbf(["finality", "status", "--block", String(K + 1), ...rpcArgs(), "--skip-reader", "--search", "0", "--json"]);
    assert.equal(r.code, 1);
    j = JSON.parse(r.stdout);
    assert.equal(j.keystone, K + 25);
    assert.equal(j.anchored.verdict, "NotRecorded");
  });

  test("status refuses --skip-exact, and marks overridden contract state as simulated (audit-fixes review R-6, R-7)", () => {
    let r = hbf(["finality", "status", "--block", String(K), "--skip-exact", ...rpcArgs()]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--skip-exact applies to finality verify/);
    r = hbf(["finality", "status", "--block", String(K), "--btc-txid", A, ...rpcArgs(), "--skip-reader", "--json"]);
    assert.equal(JSON.parse(r.stdout).simulated, false);
    r = hbf(["finality", "status", "--block", String(K), "--btc-txid", A, ...rpcArgs(), "--skip-reader", "--code-override", "--json"]);
    const j = JSON.parse(r.stdout);
    assert.equal(j.simulated, true);
    assert.match(j.notes.join(" "), /simulated: the contract was read with --code-override or --state-override/);
    const h = hbf(["finality", "status", "--block", String(K), "--btc-txid", A, ...rpcArgs(), "--skip-reader", "--code-override"]);
    assert.match(h.stdout, /simulated\s+yes: the contract's answers come from an override/);
  });

  test("8 confirmations is not final", async () => {
    await mockHvm(anvil, 0x43, "setConfirmations", [A, 8]);
    const r = hbf(["finality", "status", "--block", String(K), "--btc-txid", A, ...rpcArgs(), "--skip-reader", "--json"]);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.exact.contract, { verdict: "Ok", confirmations: 8, final: false });
    assert.deepEqual(j.anchored, { verdict: "Ok", confirmations: 8, final: false });
    await mockHvm(anvil, 0x43, "setConfirmations", [A, 12]);
  });
});

describe("every publication is kept; K's best is the one with most confirmations", () => {
  test("re-submitting a stored publication that now has more makes it K's best; both files stay valid", async () => {
    await mockHvm(anvil, 0x43, "setConfirmations", [B, 20]);
    const before = await head();
    const r = hbf(["finality", "record", "--keystone", String(K), "--btc-txid", B, ...rpcArgs(), ...keyArgs(), "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.created, false);
    assert.equal(j.best, true);
    assert.match(j.sentTxHash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(j.previousBest, { btcTxid: A, vout: 1 });
    assert.equal(await head(), before + 1);
    assert.equal((await readBestPublication(anvil.client, contract, K))?.btcTxid, B);
    // A's file is still valid (no longer K's best), and the Hemi PoP reading through A does not change
    const old = hbf(["finality", "verify", fileA, ...rpcArgs()]);
    assert.equal(old.code, 0, old.stdout);
    assert.match(old.stdout, new RegExp(`publication\\s+Bitcoin tx ${A}:1; not K's best`));
    const st = JSON.parse(hbf(["finality", "status", "--block", String(K), "--btc-txid", A, ...rpcArgs(), "--skip-reader", "--json"]).stdout);
    assert.deepEqual(st.exact.contract, { verdict: "Ok", confirmations: 12, final: true });
    assert.deepEqual(st.anchored, { verdict: "Ok", confirmations: 20, final: true });
    assert.equal(st.best.btcTxid, B);
    // the same re-submission again: nothing to send
    const again = hbf(["finality", "record", "--keystone", String(K), "--btc-txid", B, ...rpcArgs(), "--json"]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).sentTxHash, undefined);
    assert.equal(await head(), before + 1);
  });
});

describe("Esplora supplies the hint, the contract decides", () => {
  let K2: number;
  let pop: BuiltTx;
  before(async () => {
    K2 = await nextKeystone();
    await mineTo(K2 + 2);
    const t = Number((await anvil.client.getBlock({ blockNumber: BigInt(K2) })).timestamp);
    const abrev = await abrevFor(K2);
    // a forged "HEMI" OP_RETURN for K2 with another block hash prefix, one block before the real one
    const forged = buildTx([{ value: 0n, script: popScript(`${abrev.slice(0, 130)}${"99".repeat(12)}` as Hex) }], { prevTxid: `0x${"cd".repeat(32)}` });
    const real = buildTx([
      { value: 17_680n, script: P2PKH },
      { value: 0n, script: popScript(abrev) },
    ]);
    pop = real;
    for (let h = 900_000; h <= 900_005; h++) fake.add(h, t - 1200 + (h - 900_000) * 600, h === 900_001 ? [forged.raw] : h === 900_002 ? [real.raw] : []);
    await setPop(real.txid, abrev, 4);
    await mockHvm(anvil, 0x42, "setRaw", [`${forged.txid}003c0703`, popTxOutputs(popScript(`${abrev.slice(0, 130)}${"99".repeat(12)}` as Hex))]);
  });

  test("record without --btc-txid finds the PoP transaction by scanning Bitcoin blocks, skipping the forgery", async () => {
    const path = join(dir, "publication-k2.json");
    const r = await hbfAsync(["finality", "record", "--keystone", String(K2), "--esplora", fake.url, ...rpcArgs(), ...keyArgs(), "--out", path]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`Esplora: ${pop.txid}:1 carries keystone ${K2} \\(Bitcoin block 900002\\)`));
    assert.doesNotMatch(r.stderr, /900001\)/);
    const f = read(path);
    assert.equal(f.fact.btcTxid, pop.txid);
    assert.equal(f.fact.confirmations, 4);
    assert.equal(hbf(["finality", "verify", path, ...rpcArgs()]).code, 0);
  });
});

describe("pre-mainnet audit", () => {
  /** Runs `body` and puts the chain (and so MockHvm's answers) back as it was. */
  async function isolated(body: () => Promise<void>): Promise<void> {
    const snapshot = await anvil.rpc<Hex>("evm_snapshot");
    try {
      await body();
    } finally {
      await anvil.rpc("evm_revert", [snapshot]);
    }
  }

  test("M-1: a publication recorded through another contract verifies, by keystone and by file", () =>
    isolated(async () => {
      await installForwarder(anvil);
      const C = keccak256(toHex("pop via a forwarder"));
      await setPop(C, await abrevFor(K), 10);
      const data = encodeFunctionData({ abi: popFinalityAbi, functionName: "recordPublication", args: [BigInt(K), C, 1] });
      const via = await sendVia(anvil, contract, data);
      const receipt = await anvil.client.waitForTransactionReceipt({ hash: via });
      assert.equal(receipt.status, "success");
      assert.notEqual(receipt.to?.toLowerCase(), contract.toLowerCase());
      let r = hbf(["finality", "verify", "--keystone", String(K), "--btc-txid", C, "--vout", "1", ...rpcArgs(), "--json"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const j = JSON.parse(r.stdout);
      assert.equal(j.valid, true);
      assert.equal(j.file.recording.txHash, via);
      const path = join(dir, "publication-via-forwarder.json");
      writeFileSync(path, `${JSON.stringify(j.file, null, 2)}\n`);
      r = hbf(["finality", "verify", path, ...rpcArgs()]);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /^valid\n/);
    }));

  test("I-3: verify refuses a contract whose code is not this SDK's PopFinality", () =>
    isolated(async () => {
      const lookalike: Address = "0x00000000000000000000000000000000000f1a75";
      await anvil.rpc("anvil_setCode", [lookalike, `${POP_FINALITY_RUNTIME}00`]);
      const r = hbf(["finality", "verify", "--keystone", String(K), "--rpc", anvil.url, "--contract", lookalike]);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /^invalid: not a PopFinality contract: the code at 0x[0-9a-fA-F]{40} is not this SDK's PopFinality/);
      // status, checkpoint and record refuse it too: a look-alike's answers are not Hemi PoP finality (pre-mainnet review R-2)
      for (const args of [
        ["finality", "status", "--block", String(K), "--skip-reader"],
        ["finality", "checkpoint", "--keystone", String(K), ...keyArgs()],
        ["finality", "record", "--keystone", String(K), "--btc-txid", A, ...keyArgs()],
      ]) {
        const s = hbf([...args, "--rpc", anvil.url, "--contract", lookalike]);
        assert.equal(s.code, 1, args.join(" "));
        assert.match(s.stderr, /is not this SDK's PopFinality .*refusing to use it/, args.join(" "));
      }
    }));

  test("L-5: with two PoP outputs for K, status and record take the canonical one at vout 1, not the inexact one at vout 0", () =>
    isolated(async () => {
      const canonicalAbrev = await abrevFor(K);
      const b = await anvil.client.getBlock({ blockNumber: BigInt(K) });
      const inexact = buildAbrev({ l2: K, parentHash: b.parentHash, prevKeystoneHash: (await anvil.client.getBlock({ blockNumber: BigInt(K - 25) })).hash!, stateRoot: `0x${"5e".repeat(32)}`, blockHash: b.hash! });
      const T = keccak256(toHex("two pop outputs"));
      const out = (script: Hex) => `0000000000000000${toHex((script.length - 2) / 2, { size: 2 }).slice(2)}${script.slice(2)}00`;
      await mockHvm(anvil, 0x42, "setRaw", [`${T}003c0703`, `0x0002${out(popScript(inexact))}${out(popScript(canonicalAbrev))}` as Hex]);
      await mockHvm(anvil, 0x43, "setConfirmations", [T, 10]);
      // A local chain has no L1-info deposit, so the canonical keystone is given to the cache (a finalized entry needs
      // no RPC): the same comparison mainnet makes from Hemi RPC.
      const cache: CanonicalCache = new Map();
      cache.set(`${anvil.client.chain?.id ?? "?"}:${K}`, { abrev: canonicalAbrev, abrevHash: keccak256(canonicalAbrev), l1: 0, l2: K, timestamp: 0, blockHash: b.hash!.toLowerCase() as Hex, finalized: true });
      const { ranked, usable } = await recordCandidates(anvil.client, K, T, { cache });
      assert.deepEqual(ranked.map((m) => [m.out.vout, m.match.exact]), [[1, true], [0, false]]);
      assert.deepEqual(usable.map((m) => m.out.vout), [1], "the inexact output is not offered");
      assert.deepEqual((await recordCandidates(anvil.client, K, T, { cache, allowInexact: true })).usable.map((m) => m.out.vout), [1, 0]);
      const s = await finalityStatus(anvil.client, contract, BigInt(K), { keystone: K, reader: null, exact: { keystone: K, btcTxid: T }, canonical: cache });
      assert.equal(s.exact?.vout, 1);
      assert.equal(s.exact?.match.exact, true);
    }));

  test("M-2: watch retries a publication hVM cannot read yet, and drops a terminal verdict at once", async () => {
    const K5 = await nextKeystone();
    await mineTo(K5 + 2);
    const abrev = await abrevFor(K5);
    const forgedAbrev = `${abrev.slice(0, 130)}${"99".repeat(12)}` as Hex; // another block hash prefix: WrongBlockHash
    const late = buildTx([
      { value: 2n, script: P2PKH },
      { value: 0n, script: popScript(abrev) },
    ]);
    const forged = buildTx([
      { value: 3n, script: P2PKH },
      { value: 0n, script: popScript(forgedAbrev) },
    ]);
    const t = fake.blocks.get(fake.tip)!.time;
    const start = fake.tip;
    for (let i = 1; i <= 3; i++) fake.add(start + i, t + i * 600, i === 1 ? [late.raw, forged.raw] : []);
    // hVM sees the forgery but not yet the real one: Esplora is 3 blocks ahead of hVM's index (D-012 saw 4)
    await mockHvm(anvil, 0x42, "setRaw", [`${forged.txid}003c0703`, popTxOutputs(popScript(forgedAbrev))]);
    await mockHvm(anvil, 0x43, "setConfirmations", [forged.txid, 3]);
    const lines: string[] = [];
    let sleeps = 0;
    const stats = await watch({
      client: anvil.client,
      contract,
      chainId: anvil.chainId,
      esplora: esploraClient([fake.url], { requestsPerSecond: 50 }),
      fromKeystone: K5,
      iterations: 2,
      log: (l) => lines.push(l),
      sleep: async () => {
        sleeps++;
        await setPop(late.txid, abrev, 3); // hVM catches up
      },
    });
    assert.equal(sleeps, 1);
    assert.equal(stats.iterations, 2);
    assert.equal(stats.retried, 1, lines.join("\n"));
    assert.ok(lines.some((l) => l.includes(`${late.txid}:1 for keystone ${K5}: NotFound (hVM may not see it yet) at 3 Bitcoin confirmations; retried next time`)), lines.join("\n"));
    assert.equal(stats.errors, 0, lines.join("\n"));
    assert.deepEqual(
      stats.wouldSend.filter((w) => w.startsWith("recordPublication")),
      [`recordPublication(${K5}, ${late.txid}, 1)`],
      "offered once hVM sees it",
    );
    assert.equal(lines.filter((l) => l.includes(`${forged.txid}:1 for keystone ${K5}: WrongBlockHash; not recorded`)).length, 1, "checked once, not again");
  });

  test("M-2: watch scans again the Bitcoin blocks a reorg replaced, and finds a publication mined in one", async () => {
    const K6 = await nextKeystone();
    await mineTo(K6 + 2);
    const abrev = await abrevFor(K6);
    const pop = buildTx([
      { value: 4n, script: P2PKH },
      { value: 0n, script: popScript(abrev) },
    ]);
    await setPop(pop.txid, abrev, 3);
    const t = fake.blocks.get(fake.tip)!.time;
    const start = fake.tip;
    for (let i = 1; i <= 3; i++) fake.add(start + i, t + i * 600);
    const lines: string[] = [];
    const stats = await watch({
      client: anvil.client,
      contract,
      chainId: anvil.chainId,
      esplora: esploraClient([fake.url], { requestsPerSecond: 50 }),
      fromKeystone: K6,
      iterations: 2,
      log: (l) => lines.push(l),
      // A reorg replaces the three blocks; the publication is in the new first one.
      sleep: async () => {
        for (let i = 1; i <= 3; i++) fake.add(start + i, t + i * 600 + 1, i === 1 ? [pop.raw] : [], 1);
      },
    });
    assert.equal(stats.scannedBlocks, 3);
    assert.equal(stats.rescannedBlocks, 3, lines.join("\n"));
    assert.ok(lines.some((l) => l.includes(`Bitcoin blocks ${start + 1}..${start + 3} were replaced by a reorg`)));
    assert.deepEqual(stats.wouldSend.filter((w) => w.startsWith("recordPublication")), [`recordPublication(${K6}, ${pop.txid}, 1)`]);
  });
});

describe("watch (last: it sends transactions on its own)", () => {
  let K3: number;
  let pop: BuiltTx;
  before(async () => {
    K3 = await nextKeystone();
    await mineTo(K3 + 2);
    const abrev = await abrevFor(K3);
    pop = buildTx([
      { value: 1n, script: P2PKH },
      { value: 0n, script: popScript(abrev) },
    ]);
    const t = fake.blocks.get(fake.tip)!.time;
    // three new Bitcoin blocks; K3's publication in the first, so it has 3 confirmations at the tip
    for (let h = fake.tip + 1, i = 1; i <= 3; h++, i++) fake.add(h, t + i * 600, i === 1 ? [pop.raw] : []);
    await setPop(pop.txid, abrev, 3);
  });

  test("--dry-run sends nothing and needs no key", async () => {
    const before = await head();
    const r = await hbfAsync(["finality", "watch", ...rpcArgs(), "--from-keystone", String(K3), "--esplora", fake.url, "--iterations", "1", "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.deepEqual(j.wouldSend, [`checkpoint(${K3})`, `recordPublication(${K3}, ${pop.txid}, 1)`]);
    assert.equal(await head(), before);
    assert.equal(await readCheckpoint(anvil.client, contract, K3), null);
  });

  test("one pass checkpoints the new keystone and records its publication once hVM can see it", async () => {
    const r = await hbfAsync(["finality", "watch", ...rpcArgs(), ...keyArgs(), "--from-keystone", String(K3), "--esplora", fake.url, "--iterations", "1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.deepEqual(j.checkpointed, [K3]);
    assert.deepEqual(j.recorded, [{ keystone: K3, btcTxid: pop.txid, vout: 1 }]);
    assert.equal(j.scannedBlocks, 3);
    assert.equal(j.skippedInexact, 0);
    assert.equal((await readCheckpoint(anvil.client, contract, K3))?.blockHashPrefix, await prefixOf(K3));
    assert.equal((await readPublication(anvil.client, contract, K3, pop.txid, 1))?.btcTxid, pop.txid);
    assert.equal((await readBestPublication(anvil.client, contract, K3))?.btcTxid, pop.txid);
  });

  test("without Esplora it only checkpoints, and a second pass finds nothing new to send", async () => {
    const K4 = await nextKeystone();
    await mineTo(K4 + 1);
    const r = hbf(["finality", "watch", ...rpcArgs(), ...keyArgs(), "--from-keystone", String(K4), "--iterations", "2", "--interval", "1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.deepEqual(j.checkpointed, [K4]);
    assert.equal(j.iterations, 2);
    assert.deepEqual(j.recorded, []);
    assert.equal((await readCheckpoint(anvil.client, contract, K4))?.blockHashPrefix, await prefixOf(K4));
  });
});
