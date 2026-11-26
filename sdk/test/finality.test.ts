/** Unit tests of the finality SDK: ids, keystone parsing, covering keystones, fact files, PoP discovery and CLI guards. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { keccak256, toBytes, type Hex } from "viem";
import {
  coveringKeystone,
  esploraClient,
  firstHeightAtOrAfter,
  idOfPublicationFile,
  isKeystone,
  MAX_KEYSTONE,
  KIND_PUBLICATION,
  minerPops,
  parseAbrev,
  parsePublicationFile,
  parseStateOverride,
  POP_FINALITY_SALT,
  popFinalityCreate2Address,
  popsInRawBlock,
  publicationId,
  publicationSubject,
  rankByExactMatch,
  scanBitcoinBlock,
  serializePublicationFile,
  shownHemiPopFinal,
  txOutputs,
  VERDICTS,
  type CanonicalCache,
} from "../src/finality.js";
import { REPO, SDK } from "./helpers/anvil.js";
import { buildAbrev, buildBlock, buildTx, FakeEsplora, P2PKH, popScript } from "./helpers/bitcoin.js";

// Mainnet fixtures (DECISIONS.md D-003; contracts/test/PopFinality.t.sol)
const K1 = 5_620_225;
const POP1: Hex = "0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e";
const ABREV1: Hex =
  "0x01019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef4";
const ABREV2: Hex =
  "0x010193107000578145bafef2e72dafe581470b89f044fc1222471baa496ca1c2ba645ee626c1fa5b66f2bebcb60c08d627533446263043bfd39c965c66b011ffaba3a4a528a1d75f06c94018";
const TIP_HASH: Hex = "0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a";

// ---------------------------------------------------------------------------------------------
// Constants and ids
// ---------------------------------------------------------------------------------------------

test("shownHemiPopFinal: only a checked exact match with isBtcFinalVia true is final (independent audit, finding 6)", () => {
  const path = (exact: boolean | null, final: boolean) =>
    ({
      keystone: 25,
      btcTxid: `0x${"11".repeat(32)}`,
      vout: 1,
      source: "given",
      match: { exact, detail: "" },
      contract: { verdict: final ? "Ok" : "NoConfirmations", confirmations: final ? 9 : 0, final },
    }) as unknown as Parameters<typeof shownHemiPopFinal>[0];
  assert.equal(shownHemiPopFinal(null), false);
  assert.equal(shownHemiPopFinal(path(true, true)), true);
  assert.equal(shownHemiPopFinal(path(null, true)), false, "not checked is never final");
  assert.equal(shownHemiPopFinal(path(false, true)), false);
  assert.equal(shownHemiPopFinal(path(true, false)), false);
});

test("constants match the contract and the deploy script", () => {
  assert.equal(KIND_PUBLICATION, keccak256(toBytes("hemi-bitcoin-facts/publication")));
  assert.equal(KIND_PUBLICATION, "0xaca80b0419e9bbfa912cafe37427934507668a2c285c3d5516c6a149df40b901");
  const deploy = readFileSync(join(REPO, "contracts/script/Deploy.s.sol"), "utf8");
  assert.match(deploy, /POP_FINALITY_SALT = keccak256\("hemi-bitcoin-facts\/PopFinality\/v1"\)/);
  assert.match(deploy, /"PopFinality", Deployments\.POP_FINALITY_SALT, type\(PopFinality\)\.creationCode/);
  assert.equal(POP_FINALITY_SALT, keccak256(toBytes("hemi-bitcoin-facts/PopFinality/v1")));
  assert.match(popFinalityCreate2Address(), /^0x[0-9a-fA-F]{40}$/);
  const src = readFileSync(join(REPO, "contracts/src/PopFinality.sol"), "utf8");
  const body = src.slice(src.indexOf("enum Verdict {"), src.indexOf("}", src.indexOf("enum Verdict {")));
  const names = [...body.matchAll(/^\s+([A-Z][A-Za-z]+),?$/gm)].map((m) => m[1]);
  assert.deepEqual(names, [...VERDICTS]);
});

test("ids: the same vectors as contracts/test/PopFinality.t.sol test_ids_vectors", () => {
  assert.equal(publicationSubject(K1, POP1, 1), keccak256(`0x0055c201${POP1.slice(2)}0001`));
  assert.equal(publicationSubject(K1, POP1, 1), "0x2948946b05df0e10a0991c069d33caf8eaf06bf304d50b4f8e58b1b537e35512");
  assert.equal(publicationId(K1, POP1, 1, TIP_HASH), "0x8f4f2caf3b437a371175137bb1efc6b3b4b00dc6d74b7ad9e3d4508b2ff73699");
  assert.equal(publicationSubject(0x01020304, `0x${"00".repeat(32)}`, 0x0506), keccak256(`0x01020304${"00".repeat(32)}0506`));
});

// ---------------------------------------------------------------------------------------------
// Keystones
// ---------------------------------------------------------------------------------------------

test("parseAbrev: both mainnet fixtures, field by field (D-003)", () => {
  assert.deepEqual(parseAbrev(ABREV1), {
    version: 1,
    l1: 26_301_090,
    l2: 5_620_225,
    parentHashPrefix: "0x04ddfaf81653745406b60e",
    prevKeystoneHashPrefix: "0x74126bbe37be01ec07b30197",
    stateRoot: "0x76d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb7933",
    blockHashPrefix: "0x60d1b3e5d6c873e1408ddef4",
  });
  const b = parseAbrev(ABREV2);
  assert.equal(b.l1, 26_415_216);
  assert.equal(b.l2, 5_734_725);
  assert.equal(b.blockHashPrefix, "0xaba3a4a528a1d75f06c94018");
  assert.equal(b.prevKeystoneHashPrefix, "0xf044fc1222471baa496ca1c2");
  assert.throws(() => parseAbrev(`0x${ABREV1.slice(4)}`), /76 bytes/);
  assert.throws(() => parseAbrev(`${ABREV1}00`), /76 bytes/);
  // buildAbrev (the test helper) builds what the parser reads back
  const built = buildAbrev({ l2: K1, parentHash: `0x${"11".repeat(32)}`, prevKeystoneHash: `0x${"22".repeat(32)}`, stateRoot: `0x${"33".repeat(32)}`, blockHash: `0x${"44".repeat(32)}` });
  assert.deepEqual(parseAbrev(built), {
    version: 1,
    l1: 26_301_090,
    l2: K1,
    parentHashPrefix: `0x${"11".repeat(11)}`,
    prevKeystoneHashPrefix: `0x${"22".repeat(12)}`,
    stateRoot: `0x${"33".repeat(32)}`,
    blockHashPrefix: `0x${"44".repeat(12)}`,
  });
});

test("coveringKeystone: the boundaries the contract's tests use (block = K, K − 24, K + 1)", () => {
  assert.equal(coveringKeystone(BigInt(K1)), BigInt(K1));
  assert.equal(coveringKeystone(BigInt(K1 - 24)), BigInt(K1));
  assert.equal(coveringKeystone(BigInt(K1 + 1)), BigInt(K1 + 25));
  assert.equal(coveringKeystone(BigInt(K1 - 25)), BigInt(K1 - 25));
  assert.equal(coveringKeystone(1n), 25n);
  for (const b of [1, 24, 25, 26, 49, 50, 5_620_209]) assert.equal(coveringKeystone(b), Math.ceil(b / 25) * 25);
  assert.ok(isKeystone(25) && isKeystone(K1) && isKeystone(4_294_967_275));
  assert.ok(!isKeystone(0) && !isKeystone(24) && !isKeystone(K1 + 1) && !isKeystone(4_294_967_300));
});

test("coveringKeystone is PopFinality's: 25 for block 0, 0 above MAX_KEYSTONE, else always a keystone (pre-mainnet L-1)", () => {
  assert.equal(MAX_KEYSTONE, 4_294_967_275);
  assert.equal(coveringKeystone(0n), 25n);
  assert.equal(coveringKeystone(0), 25);
  assert.equal(coveringKeystone(BigInt(MAX_KEYSTONE)), BigInt(MAX_KEYSTONE));
  assert.equal(coveringKeystone(MAX_KEYSTONE - 24), MAX_KEYSTONE);
  assert.equal(coveringKeystone(MAX_KEYSTONE + 1), 0);
  assert.equal(coveringKeystone(0xffffffffn), 0n);
  assert.equal(coveringKeystone(2n ** 256n - 1n), 0n);
  for (const b of [0, 1, 24, 25, 26, 5_620_209, MAX_KEYSTONE - 1, MAX_KEYSTONE, MAX_KEYSTONE + 1, 0xffffffff, 0x100000000]) {
    const k = coveringKeystone(b);
    assert.ok(k === 0 || (isKeystone(k) && k >= b), `${b} -> ${k}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Fact files
// ---------------------------------------------------------------------------------------------

function schemaExamples(): string[] {
  const doc = readFileSync(join(REPO, "docs/SCHEMA.md"), "utf8");
  const start = doc.indexOf("### `publication`");
  const end = doc.indexOf("\n### ", start + 1);
  return [...doc.slice(start, end).matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

test("docs/SCHEMA.md publication example parses, re-serializes byte for byte, and its id recomputes", () => {
  const examples = schemaExamples();
  assert.equal(examples.length, 1);
  const text = examples[0]!;
  const parsed = parsePublicationFile(JSON.parse(text));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
  assert.equal(serializePublicationFile(parsed.file), text);
  assert.equal(idOfPublicationFile(parsed.file), parsed.file.id);
  assert.equal(parsed.file.id, publicationId(K1, POP1, 1, TIP_HASH));
  assert.equal(parseAbrev(parsed.file.fact.abrev).l2, parsed.file.fact.keystone);
  assert.equal(parsed.file.fact.abrev, ABREV1);
});

describe("parsePublicationFile rejects", () => {
  const base = (): Record<string, any> => JSON.parse(schemaExamples()[0]!) as Record<string, any>;
  const cases: [string, (o: Record<string, any>) => void, RegExp][] = [
    ["an unknown key", (o) => (o.fact.extra = "1"), /file\.fact\.extra is not a known key/],
    ["a missing key", (o) => delete o.fact.abrev, /file\.fact\.abrev is missing/],
    ["a JSON number", (o) => (o.fact.keystone = K1), /file\.fact\.keystone must be a decimal string/],
    ["a non-keystone", (o) => (o.fact.keystone = String(K1 + 1)), /must be a positive multiple of 25/],
    ["keystone 0", (o) => (o.fact.keystone = "0"), /must be a positive multiple of 25/],
    ["a short abrev", (o) => (o.fact.abrev = o.fact.abrev.slice(0, -2)), /file\.fact\.abrev must be 76 bytes/],
    ["the 83-byte script instead of the abrev", (o) => (o.fact.abrev = popScript(o.fact.abrev)), /file\.fact\.abrev must be 76 bytes/],
    ["upper-case hex", (o) => (o.fact.btcTxid = o.fact.btcTxid.toUpperCase().replace("0X", "0x")), /file\.fact\.btcTxid/],
    ["a vout above 65535", (o) => (o.fact.vout = "65536"), /file\.fact\.vout is out of range/],
    ["another kind", (o) => (o.kind = "output"), /file\.kind must be "publication"/],
    ["another schema", (o) => (o.schema = "hemi-bitcoin-facts/v2"), /file\.schema/],
  ];
  for (const [name, mutate, want] of cases) {
    test(name, () => {
      const o = base();
      mutate(o);
      const r = parsePublicationFile(o);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.errors.join("; "), want);
    });
  }
});

test("a fact file round-trips through serialize and parse", () => {
  const parsed = parsePublicationFile(JSON.parse(schemaExamples()[0]!));
  assert.ok(parsed.ok);
  const file = { ...parsed.file, fact: { ...parsed.file.fact, confirmations: 4_294_967_295, vout: 65_535 }, recording: { ...parsed.file.recording, blockNumber: 2n ** 63n } };
  const again = parsePublicationFile(JSON.parse(serializePublicationFile(file)));
  assert.ok(again.ok);
  assert.deepEqual(again.file, file);
});

// ---------------------------------------------------------------------------------------------
// PoP discovery (Esplora is a hint only)
// ---------------------------------------------------------------------------------------------

test("popsInRawBlock finds PoP outputs at any vout, in legacy and segwit transactions, with their txids", () => {
  const legacy = buildTx([
    { value: 17_680n, script: P2PKH },
    { value: 0n, script: popScript(ABREV1) },
  ]);
  const segwit = buildTx([{ value: 0n, script: popScript(ABREV2) }], { segwit: true });
  const unrelated = buildTx([{ value: 0n, script: "0x6a0548454d4931" }]); // a short "HEMI1" OP_RETURN
  const coinbase = buildTx([{ value: 50n, script: P2PKH }], { coinbase: true });
  const pops = popsInRawBlock(buildBlock(1_763_000_000, [coinbase.raw, legacy.raw, unrelated.raw, segwit.raw]));
  assert.deepEqual(pops, [
    { btcTxid: legacy.txid, vout: 1, keystone: K1, abrev: ABREV1 },
    { btcTxid: segwit.txid, vout: 0, keystone: 5_734_725, abrev: ABREV2 },
  ]);
  // the segwit txid is the hash without the witness, as Bitcoin computes it
  assert.notEqual(segwit.txid, keccak256(segwit.raw));
});

describe("through a fake Esplora", () => {
  const fake = new FakeEsplora();
  const pop = buildTx([
    { value: 1n, script: P2PKH },
    { value: 0n, script: popScript(ABREV1) },
  ]);
  before(async () => {
    for (let h = 900_000; h <= 900_030; h++) fake.add(h, 1_763_000_000 + (h - 900_000) * 600, h === 900_012 ? [pop.raw] : []);
    await fake.start();
  });
  after(() => fake.close());

  test("scanBitcoinBlock: two requests, and the PoP output with its height and block hash", async () => {
    const esplora = esploraClient([`${fake.url}`], { requestsPerSecond: 50 });
    const before = fake.requests.length;
    const b = await scanBitcoinBlock(esplora, 900_012);
    assert.deepEqual(fake.requests.slice(before), ["/block-height/900012", `/block/${b.hash}/raw`]);
    assert.equal(b.pops.length, 1);
    assert.equal(b.pops[0]!.btcTxid, pop.txid);
    assert.equal(b.pops[0]!.height, 900_012);
    assert.equal((await scanBitcoinBlock(esplora, 900_013)).pops.length, 0);
  });

  test("firstHeightAtOrAfter finds the first block at or after a time", async () => {
    const esplora = esploraClient([fake.url], { requestsPerSecond: 50 });
    assert.equal(await firstHeightAtOrAfter(esplora, 1_763_000_000 + 12 * 600, 900_030), 900_012);
    assert.equal(await firstHeightAtOrAfter(esplora, 1_763_000_000 + 12 * 600 - 1, 900_030), 900_012);
    assert.equal(await firstHeightAtOrAfter(esplora, 1_763_000_000 + 25 * 600 + 1, 900_030), 900_026);
    assert.equal(await firstHeightAtOrAfter(esplora, 1_763_000_000 + 31 * 600, 900_030), 900_031); // nothing yet
  });

  test("the first instance failing moves on to the second (mempool.space, then blockstream.info)", async () => {
    const dead = createServer((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as { port: number }).port;
    try {
      const esplora = new (await import("../src/vendor/receipts/finality.js")).EsploraClient({
        baseUrls: [`http://127.0.0.1:${port}`, fake.url],
        requestsPerSecond: 50,
        retryDelayMs: 1,
      });
      assert.equal(await esplora.tipHeight(), 900_030);
    } finally {
      dead.close();
    }
  });
});

test("minerPops reads a miner's history newest first and stops below the keystone", async () => {
  const pages: Record<string, unknown[]> = {
    "/address/1Miner/txs": [
      { txid: "aa".repeat(32), status: { confirmed: false }, vout: [{ scriptpubkey: P2PKH.slice(2) }, { scriptpubkey: popScript(ABREV2).slice(2) }] },
      { txid: "bb".repeat(32), status: { confirmed: true, block_height: 975_836, block_hash: "cc".repeat(32) }, vout: [{ scriptpubkey: popScript(ABREV2).slice(2) }] },
    ],
    [`/address/1Miner/txs/chain/${"bb".repeat(32)}`]: [
      { txid: "dd".repeat(32), status: { confirmed: true, block_height: 973_746, block_hash: "ee".repeat(32) }, vout: [{ scriptpubkey: P2PKH.slice(2) }, { scriptpubkey: popScript(ABREV1).slice(2) }] },
    ],
    [`/address/1Miner/txs/chain/${"dd".repeat(32)}`]: [],
  };
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace(/^\/api/, "");
    seen.push(path);
    const body = pages[path];
    return new Response(body ? JSON.stringify(body) : "nope", { status: body ? 200 : 404 });
  }) as typeof fetch;
  const esplora = esploraClient(["https://esplora.test/api"], { fetch: fetchFn, requestsPerSecond: 50 });
  // keystone 5734725: the first page's newest confirmed keystone is 5734725 (not below it), so page two is read
  const hints = await minerPops(esplora, "1Miner", 5_734_725);
  assert.deepEqual(
    hints.map((h) => [h.btcTxid.slice(0, 6), h.vout, h.keystone, h.height]),
    [
      ["0xaaaa", 1, 5_734_725, null],
      ["0xbbbb", 0, 5_734_725, 975_836],
      ["0xdddd", 1, K1, 973_746],
    ],
  );
  assert.equal(seen.length, 2); // page two's newest confirmed keystone is below 5734725: stop
});

test("parseStateOverride takes eth_call's object form", () => {
  const o = parseStateOverride({ "0x00000000000000000000000000000000000000aa": { code: "0x6001", stateDiff: { "0x01": "0x02" } } });
  assert.deepEqual(o, [{ address: "0x00000000000000000000000000000000000000aa", code: "0x6001", stateDiff: [{ slot: "0x01", value: "0x02" }] }]);
  assert.throws(() => parseStateOverride([]), /JSON object/);
  assert.throws(() => parseStateOverride({ nope: {} }), /not an address/);
  assert.throws(() => parseStateOverride({ "0x00000000000000000000000000000000000000aa": { code: "zz" } }), /0x hex/);
});

// ---------------------------------------------------------------------------------------------
// CLI guards, against a fake JSON-RPC server that says it is Hemi mainnet
// ---------------------------------------------------------------------------------------------

const run = promisify(execFile);
async function hbfAsync(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [join(SDK, "bin/hbf.mjs"), ...args], { cwd: SDK, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("hbf finality guards", () => {
  let server: Server;
  let url: string;
  const methods: string[] = [];
  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const r = JSON.parse(body) as { id: unknown; method: string };
        methods.push(r.method);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, ...(r.method === "eth_chainId" ? { result: "0xa867" } : { error: { code: -32601, message: "not in this test" } }) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());

  const C = "0x0000000000000000000000000000000000000001";
  for (const args of [
    ["checkpoint", "--keystone", "25"],
    ["record", "--keystone", "25", "--btc-txid", `0x${"11".repeat(32)}`, "--vout", "1"],
    ["watch", "--iterations", "1"],
  ]) {
    test(`${args[0]} on Hemi mainnet without --allow-mainnet is refused before any key or send`, async () => {
      const before = methods.length;
      const r = await hbfAsync(["finality", ...args, "--rpc", url, "--contract", C]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /refusing to send a transaction on Hemi mainnet without --allow-mainnet/);
      assert.deepEqual(methods.slice(before), ["eth_chainId"]);
    });
  }

  test("--chain-id cannot talk the guard out of a mainnet RPC", async () => {
    const r = await hbfAsync(["finality", "checkpoint", "--keystone", "25", "--rpc", url, "--chain-id", "31337", "--contract", C]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--chain-id 31337, but the RPC serves chain 43111/);
  });

  test("usage errors exit 2 before any call", async () => {
    const before = methods.length;
    for (const args of [
      ["checkpoint", "--keystone", "26", "--rpc", url, "--contract", C],
      ["record", "--keystone", "0", "--rpc", url, "--contract", C],
      ["record", "--keystone", "25", "--vout", "1", "--rpc", url, "--contract", C],
      ["status", "--block", "51", "--keystone", "50", "--rpc", url, "--contract", C],
      ["verify", "--rpc", url, "--contract", C],
      ["nope"],
    ]) {
      const r = await hbfAsync(["finality", ...args]);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    }
    assert.equal(methods.length, before);
  });

  test("every command has --help", async () => {
    for (const c of ["checkpoint", "record", "verify", "status", "watch"]) {
      const r = await hbfAsync(["finality", c, "--help"]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, new RegExp(`^usage: hbf finality ${c}`));
    }
    const g = await hbfAsync(["finality", "--help"]);
    assert.equal(g.code, 0);
    assert.match(g.stdout, /checkpoint \| record|checkpoint  store/);
  });
});

test("rankByExactMatch: a canonical output at a higher vout comes before an inexact one at vout 0 (pre-mainnet L-5)", async () => {
  const K = 5_620_225;
  const canonical = buildAbrev({ l2: K, parentHash: `0x${"11".repeat(32)}`, prevKeystoneHash: `0x${"22".repeat(32)}`, stateRoot: `0x${"33".repeat(32)}`, blockHash: `0x${"44".repeat(32)}` });
  const mutated = buildAbrev({ l2: K, parentHash: `0x${"11".repeat(32)}`, prevKeystoneHash: `0x${"22".repeat(32)}`, stateRoot: `0x${"55".repeat(32)}`, blockHash: `0x${"44".repeat(32)}` });
  // The canonical keystone from the cache (a finalized entry needs no RPC), so no client call is made.
  const client = { chain: { id: 43_111 } } as never;
  const cache: CanonicalCache = new Map();
  cache.set(`43111:${K}`, { abrev: canonical, abrevHash: keccak256(canonical), l1: 0, l2: K, timestamp: 0, blockHash: `0x${"44".repeat(32)}`, finalized: true });
  const ranked = await rankByExactMatch(client, K, [{ vout: 0, abrev: mutated }, { vout: 1, abrev: canonical }, { vout: 2, abrev: mutated }], cache);
  assert.deepEqual(ranked.map((m) => [m.out.vout, m.match.exact]), [[1, true], [0, false], [2, false]]);
  assert.match(ranked[1]!.match.detail, /stateRoot/);
});

test("txOutputs parses 0x42's answer as Hvm.txOutputs does: a truncated or malformed one is no answer (pre-mainnet I-6)", async () => {
  const one = (script: string, utxo = "01") => `${"0000000000000064"}${(script.length / 2).toString(16).padStart(4, "0")}${script}${utxo}`;
  const answer = (body: string, count = 2) => `0x${count.toString(16).padStart(4, "0")}${body}` as Hex;
  const client = (data: Hex) => ({ call: async () => ({ data }) }) as never;
  const txid = `0x${"aa".repeat(32)}` as Hex;
  const good = answer(one("0014" + "11".repeat(20)) + one("6a0401020304", "00"));
  assert.deepEqual(await txOutputs(client(good), txid), [
    { vout: 0, script: `0x0014${"11".repeat(20)}` },
    { vout: 1, script: "0x6a0401020304" },
  ]);
  assert.deepEqual(await txOutputs(client(good.slice(0, -2) as Hex), txid), [], "the last UTXO byte cut off");
  assert.deepEqual(await txOutputs(client(`${good}00` as Hex), txid), [], "a byte left over");
  assert.deepEqual(await txOutputs(client(answer(one("0014" + "11".repeat(20), "02") + one("6a00", "00"))), txid), [], "a UTXO byte above 1");
  assert.deepEqual(await txOutputs(client(answer(one("0014" + "11".repeat(20)), 2)), txid), [], "fewer outputs than the count");
});
