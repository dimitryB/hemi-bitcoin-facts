/** Unit tests of the facts SDK: ids, fact files, address networks, RPC error handling and the CLI's guards. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { keccak256, toBytes, type Hex } from "viem";
import { GENERATED, modulePath, readArtifact, renderAbiModule } from "../src/abi/generate.js";
import {
  balanceId,
  BITCOIN_FACTS_SALT,
  bitcoinFactsCreate2Address,
  btcAddressScript,
  btcNetworkFor,
  checkBalance,
  checkOutput,
  factId,
  hvmRpcError,
  idOfFile,
  KIND_BALANCE,
  KIND_OUTPUT,
  outputId,
  outputSubject,
  parseFactFile,
  scriptAddress,
  serializeFactFile,
  VERDICTS,
  type FactFile,
} from "../src/facts.js";
import { createHemiPublicClient } from "../src/vendor/receipts/client.js";
import { forgeBuild, REPO, SDK } from "./helpers/anvil.js";

const TXID: Hex = "0x43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4";
const TIP_HASH: Hex = "0x000000000000000000019ada2495c08b2f353705b20f8d653ad2fe492b51249a";
const P2PKH_SCRIPT: Hex = "0x76a9144f364626b44b11929dd604d3cc592c4b8d887d1c88ac";

// ---------------------------------------------------------------------------------------------
// Generated ABI and constants
// ---------------------------------------------------------------------------------------------

test("src/abi/BitcoinFacts.ts is what forge's output renders to", () => {
  forgeBuild();
  for (const c of GENERATED) {
    assert.equal(readFileSync(modulePath(c), "utf8"), renderAbiModule(c, readArtifact(c.name)), `${c.name}: run npm run gen:abi`);
  }
});

test("constants match the contract and the deploy script", () => {
  assert.equal(KIND_OUTPUT, keccak256(toBytes("hemi-bitcoin-facts/output")));
  assert.equal(KIND_BALANCE, keccak256(toBytes("hemi-bitcoin-facts/balance")));
  const deploy = readFileSync(join(REPO, "contracts/script/Deploy.s.sol"), "utf8");
  assert.match(deploy, /BITCOIN_FACTS_SALT = keccak256\("hemi-bitcoin-facts\/BitcoinFacts\/v1"\)/);
  assert.equal(BITCOIN_FACTS_SALT, keccak256(toBytes("hemi-bitcoin-facts/BitcoinFacts/v1")));
  assert.match(bitcoinFactsCreate2Address(), /^0x[0-9a-fA-F]{40}$/);
  assert.deepEqual(VERDICTS.slice(0, 3), ["Ok", "NoBitcoinView", "NotFound"]);
  // The enum order in the ABI-generating source
  const src = readFileSync(join(REPO, "contracts/src/BitcoinFacts.sol"), "utf8");
  const body = src.slice(src.indexOf("enum Verdict {"), src.indexOf("}", src.indexOf("enum Verdict {")));
  const names = [...body.matchAll(/^\s+([A-Z][A-Za-z]+),?$/gm)].map((m) => m[1]);
  assert.deepEqual(names, [...VERDICTS]);
});

test("ids: the same vectors as contracts/test/BitcoinFacts.t.sol test_ids_vectors", () => {
  assert.equal(outputSubject(TXID, 0), keccak256(`${TXID}0000`));
  assert.equal(outputSubject(`0x${"00".repeat(32)}`, 0x0102), keccak256(`0x${"00".repeat(32)}0102`));
  assert.equal(outputId(TXID, 0, TIP_HASH), "0x5c7f60897e18b23a4c7d6570671f5839f997c18491134654624ae386a00f683a");
  assert.equal(balanceId(keccak256(P2PKH_SCRIPT), TIP_HASH), "0xec31ca3396707a7e550791a4eb5b2c39c81a2174a362ccc2f8ad50a760e5156e");
  assert.equal(factId(KIND_OUTPUT, outputSubject(TXID, 0), TIP_HASH), outputId(TXID, 0, TIP_HASH));
});

// ---------------------------------------------------------------------------------------------
// Fact files
// ---------------------------------------------------------------------------------------------

/** The examples in docs/SCHEMA.md's output-and-balance section, byte for byte. */
function schemaExamples(): string[] {
  const doc = readFileSync(join(REPO, "docs/SCHEMA.md"), "utf8");
  const start = doc.indexOf("### `output` and `balance`");
  const end = doc.indexOf("\n### ", start + 1);
  const section = doc.slice(start, end);
  return [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

test("docs/SCHEMA.md examples parse and re-serialize byte for byte, and their ids recompute", () => {
  const examples = schemaExamples();
  assert.equal(examples.length, 2);
  for (const text of examples) {
    const parsed = parseFactFile(JSON.parse(text));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
    assert.equal(serializeFactFile(parsed.file), text);
    assert.equal(idOfFile(parsed.file), parsed.file.id);
    assert.equal(keccak256(parsed.file.fact.script), parsed.file.fact.scriptHash);
  }
});

describe("parseFactFile rejects", () => {
  const base = (): Record<string, unknown> => JSON.parse(schemaExamples()[0]!) as Record<string, unknown>;
  const fact = (o: Record<string, unknown>) => o.fact as Record<string, unknown>;
  const cases: [string, (o: Record<string, unknown>) => void, RegExp][] = [
    ["an unknown key", (o) => (o.extra = "1"), /file\.extra is not a known key/],
    ["a missing key", (o) => delete fact(o).spent, /file\.fact\.spent is missing/],
    ["a JSON number", (o) => (fact(o).sats = 1000), /file\.fact\.sats must be a decimal string/],
    ["a leading zero", (o) => (fact(o).sats = "01000"), /file\.fact\.sats must be a decimal string/],
    ["upper-case hex", (o) => (fact(o).txid = String(fact(o).txid).toUpperCase().replace("0X", "0x")), /file\.fact\.txid/],
    ["a checksummed address", (o) => (o.contract = "0x00000000000000000000000000000000000000Ab"), /file\.contract/],
    ["a vout above 65535", (o) => (fact(o).vout = "65536"), /file\.fact\.vout is out of range/],
    ["sats above 2^64-1", (o) => (fact(o).sats = "18446744073709551616"), /file\.fact\.sats is out of range/],
    ["a string boolean", (o) => (fact(o).spent = "false"), /file\.fact\.spent must be true or false/],
    ["another schema", (o) => (o.schema = "hemi-bitcoin-facts/v2"), /file\.schema/],
    ["another kind", (o) => (o.kind = "bond"), /file\.kind/],
    ["odd-length script hex", (o) => (fact(o).script = "0x001"), /file\.fact\.script/],
  ];
  for (const [name, mutate, want] of cases) {
    test(name, () => {
      const o = base();
      mutate(o);
      const r = parseFactFile(o);
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.errors.join("; "), want);
    });
  }
  test("a non-object", () => {
    assert.equal(parseFactFile([1]).ok, false);
    assert.equal(parseFactFile(null).ok, false);
  });
});

test("serializeFactFile writes integers as decimal strings and hex in lower case", () => {
  const file: FactFile = {
    schema: "hemi-bitcoin-facts/v1",
    kind: "balance",
    chainId: 43_111,
    contract: "0x00000000000000000000000000000000000000AB",
    id: "0xAA00000000000000000000000000000000000000000000000000000000000000",
    fact: { scriptHash: keccak256("0x51"), sats: 2n ** 64n - 1n, scriptLength: 1, script: "0x51" },
    asOf: { btcHeight: 0, btcBlockHash: TIP_HASH },
    recording: { txHash: TIP_HASH, blockNumber: 5_780_432n, blockHash: TIP_HASH },
  };
  const text = serializeFactFile(file);
  assert.ok(text.endsWith("}\n"));
  assert.match(text, /"sats": "18446744073709551615"/);
  assert.match(text, /"btcHeight": "0"/);
  assert.match(text, /"contract": "0x00000000000000000000000000000000000000ab"/);
  assert.match(text, /"id": "0xaa0+"/);
  assert.deepEqual(Object.keys(JSON.parse(text) as object), ["schema", "kind", "chainId", "contract", "id", "fact", "asOf", "recording"]);
});

// ---------------------------------------------------------------------------------------------
// Bitcoin address networks (D-012 item 4)
// ---------------------------------------------------------------------------------------------

test("addresses decode to the scripts 0x46 gave on mainnet (D-001)", () => {
  const cases: [string, Hex][] = [
    ["18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm", P2PKH_SCRIPT],
    ["bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkv", "0x0014d57738858e10d8b5b3ae80047cbb7750e028b6f2"],
    ["BC1Q64MN3PVWZRVTTVAWSQZ8EWMH2RSZ3DHJP4CNKV", "0x0014d57738858e10d8b5b3ae80047cbb7750e028b6f2"],
  ];
  for (const [a, script] of cases) assert.equal(btcAddressScript(a, "mainnet"), script);
  assert.equal(scriptAddress(P2PKH_SCRIPT, "mainnet"), "18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm");
  assert.equal(scriptAddress("0x6a00", "mainnet"), undefined);
});

test("an address for the other network is refused", () => {
  assert.throws(() => btcAddressScript("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "mainnet"), /is a Bitcoin testnet address; this chain reads Bitcoin mainnet/);
  assert.throws(() => btcAddressScript("n1hDD6zeYAhvsT2tkPVQCzjfgLNZDBgZQL", "mainnet"), /testnet address/);
  assert.throws(() => btcAddressScript("18DqQBT9CKb3RJ94H1d2JJbnHWp25uRmjm", "testnet"), /is a Bitcoin mainnet address; this chain reads Bitcoin testnet/);
  assert.throws(() => btcAddressScript("bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkq", "mainnet"), /not a valid Bitcoin mainnet address/);
  assert.equal(btcNetworkFor(43_111), "mainnet");
  assert.equal(btcNetworkFor(743_111), "testnet");
  assert.equal(btcNetworkFor(31_337), "mainnet");
  assert.equal(btcNetworkFor(31_337, "testnet"), "testnet");
  assert.throws(() => btcNetworkFor(43_111, "testnet"), /reads Bitcoin mainnet/);
  assert.throws(() => btcNetworkFor(1, "signet"), /--btc-network/);
});

// ---------------------------------------------------------------------------------------------
// A fake JSON-RPC server, for what an anvil cannot do: hVM's -32000 errors and a mainnet chain id.
// ---------------------------------------------------------------------------------------------

interface Fake {
  url: string;
  methods: string[];
  server: Server;
}

async function fakeRpc(handler: (method: string, params: unknown[]) => { result?: unknown; error?: { code: number; message: string } }): Promise<Fake> {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const one = (r: { id: unknown; method: string; params?: unknown[] }) => {
        methods.push(r.method);
        return { jsonrpc: "2.0", id: r.id, ...handler(r.method, r.params ?? []) };
      };
      const parsed = JSON.parse(body) as { id: unknown; method: string; params?: unknown[] } | { id: unknown; method: string; params?: unknown[] }[];
      const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${addr.port}`, methods, server };
}

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

describe("hVM's JSON-RPC -32000 errors are verdicts, not retried", () => {
  let fake: Fake;
  before(async () => {
    fake = await fakeRpc((method, params) => {
      if (method === "eth_chainId") return { result: "0x7a69" };
      if (method === "eth_call") {
        const data = String((params[0] as { data?: string }).data ?? (params[0] as { input?: string }).input);
        // checkBalance(string) selector is the first 4 bytes; anything else is checkOutput
        const isBalance = data.startsWith("0x" + keccak256(toBytes("checkBalance(string)")).slice(2, 10));
        return isBalance
          ? { error: { code: -32000, message: "invalid checksum (expected (bech32=p4cnkv, bech32m=p4cnkv5fglnw), got p4cnkq)" } }
          : { error: { code: -32000, message: `tx not found: ${"de".repeat(32)}` } };
      }
      return { error: { code: -32601, message: "method not found" } };
    });
  });
  after(() => fake.server.close());

  test("tx not found → NotFound after one request", async () => {
    const client = createHemiPublicClient({ chainId: 31_337, rpcUrls: [fake.url] });
    const before = fake.methods.length;
    const c = await checkOutput(client, "0x0000000000000000000000000000000000000001", `0x${"de".repeat(32)}`, 0);
    assert.equal(c.verdict, "NotFound");
    assert.match(c.note ?? "", /tx not found/);
    assert.deepEqual(fake.methods.slice(before), ["eth_call"]);
  });

  test("invalid checksum → BadAddress after one request", async () => {
    const client = createHemiPublicClient({ chainId: 31_337, rpcUrls: [fake.url] });
    const before = fake.methods.length;
    const c = await checkBalance(client, "0x0000000000000000000000000000000000000001", "bc1q64mn3pvwzrvttvawsqz8ewmh2rsz3dhjp4cnkq");
    assert.equal(c.verdict, "BadAddress");
    assert.deepEqual(fake.methods.slice(before), ["eth_call"]);
  });

  test("hvmRpcError finds the code under viem's wrappers", () => {
    assert.equal(hvmRpcError({ cause: { cause: { code: -32000, details: "tx not found: ab" } } })?.notFound, true);
    assert.equal(hvmRpcError({ code: -32603, message: "internal" }), undefined);
    const header = hvmRpcError({ cause: { code: -32000, details: "header not found" } });
    assert.ok(header && !header.notFound && !header.badAddress);
    assert.equal(hvmRpcError({ code: -32000, message: "invalid character not part of charset: 98" })?.badAddress, true);
  });
});

// ---------------------------------------------------------------------------------------------
// CLI guards
// ---------------------------------------------------------------------------------------------

describe("CLI", () => {
  let mainnet: Fake;
  before(async () => {
    mainnet = await fakeRpc((method) => (method === "eth_chainId" ? { result: "0xa867" } : { error: { code: -32601, message: `${method} not allowed in this test` } }));
  });
  after(() => mainnet.server.close());

  test("help", async () => {
    for (const args of [["facts", "--help"], ["facts", "check", "--help"], ["facts", "record", "--help"], ["facts", "verify", "--help"], ["facts", "status", "--help"]]) {
      const r = await hbfAsync(args);
      assert.equal(r.code, 0, args.join(" "));
      assert.match(r.stdout, /usage: hbf facts/);
    }
    const r = await hbfAsync(["facts", "nope"]);
    assert.equal(r.code, 2);
  });

  test("record on Hemi mainnet without --allow-mainnet is refused before any key or send", async () => {
    const before = mainnet.methods.length;
    const r = await hbfAsync([
      "facts", "record", "--rpc", mainnet.url, "--contract", "0x0000000000000000000000000000000000000001",
      "--txid", TXID, "--vout", "0", "--key-file", "/nonexistent/.secrets/none.key",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing to send a transaction on Hemi mainnet without --allow-mainnet/);
    assert.deepEqual(mainnet.methods.slice(before), ["eth_chainId"]);
  });

  test("--chain-id cannot talk the guard out of a mainnet RPC", async () => {
    const r = await hbfAsync([
      "facts", "record", "--rpc", mainnet.url, "--chain-id", "31337", "--contract", "0x0000000000000000000000000000000000000001",
      "--txid", TXID, "--vout", "0",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--chain-id 31337, but the RPC serves chain 43111/);
  });

  test("a testnet address is refused on mainnet before any call", async () => {
    const before = mainnet.methods.length;
    const r = await hbfAsync([
      "facts", "check", "--rpc", mainnet.url, "--contract", "0x0000000000000000000000000000000000000001",
      "--address", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /testnet address; this chain reads Bitcoin mainnet/);
    assert.deepEqual(mainnet.methods.slice(before), ["eth_chainId"]);
  });

  test("usage errors", async () => {
    let r = await hbfAsync(["facts", "check", "--rpc", mainnet.url, "--contract", "0x01", "--txid", TXID, "--vout", "0"]);
    assert.equal(r.code, 2);
    r = await hbfAsync(["facts", "verify", "--rpc", mainnet.url, "--contract", "0x0000000000000000000000000000000000000001"]);
    assert.equal(r.code, 2);
    r = await hbfAsync(["facts", "check", "--bogus"]);
    assert.equal(r.code, 2);
  });

  test("verify of a file that is not JSON is invalid", async () => {
    const r = await hbfAsync(["facts", "verify", join(SDK, "package.json.nope"), "--rpc", mainnet.url, "--contract", "0x0000000000000000000000000000000000000001"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^invalid: malformed fact file/);
  });
});
