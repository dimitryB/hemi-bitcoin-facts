/** Shared helpers in src/common.ts. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { EsploraBackend } from "../src/btc/backend.js";
import { connect, readSecretPath, redactUrl, redactUrls, UsageError } from "../src/common.js";
import * as common from "../src/common.js";
import { loadBtcKey } from "../src/btc/keys.js";
import { SDK } from "./helpers/anvil.js";

test("redactUrl prints scheme and host only: no credentials, path or query (audit-fixes review F-2)", () => {
  assert.equal(redactUrl("https://user:secret@rpc.example.org:8545/v1/KEY?token=abc"), "https://rpc.example.org:8545");
  assert.equal(redactUrl("HTTPS://RPC.EXAMPLE.ORG/path"), "https://rpc.example.org");
  assert.equal(redactUrl("http://127.0.0.1:18545"), "http://127.0.0.1:18545");
  assert.equal(redactUrl("http://h?k=v"), "http://h");
  assert.equal(redactUrl("not a url"), "<invalid URL>");
});

test("redactUrls cuts every URL in a message to scheme and host (pre-mainnet I-7)", () => {
  assert.equal(
    redactUrls('GET https://user:pw@esplora.example.org/api/KEY/tx/ab answered 500; then "http://10.0.0.1:3000/x?apikey=s"'),
    'GET https://esplora.example.org answered 500; then "http://10.0.0.1:3000"',
  );
  assert.equal(redactUrls("no url here"), "no url here");
  // punctuation after a URL in running text is kept, and the URL is still cut (found while fixing N-1 to N-6)
  assert.equal(redactUrls("cannot read chain id from http://127.0.0.1:8545: TypeError (see https://h.example/a/b)."), "cannot read chain id from http://127.0.0.1:8545: TypeError (see https://h.example).");
  assert.equal(redactUrls("URL: https://u:p@RPC.example.org:443/v1/KEY?x=1, then"), "URL: https://rpc.example.org:443, then");
  // credentials run to the last "@" (a password may hold one), and an IPv6 literal is a host (review P-3)
  assert.equal(redactUrls("GET https://user:p@ssw0rd-TAIL@rpc.example.org/v1/KEY failed"), "GET https://rpc.example.org failed");
  assert.equal(redactUrls("GET https://me@example.com:TOKEN@rpc.example.org/x failed"), "GET https://rpc.example.org failed");
  assert.equal(redactUrls("at http://[::1]:8545/v2/KEY now"), "at http://[::1]:8545 now");
  assert.equal(redactUrls("GET https://esplora.example.org/api/tx/ab@cd"), "GET https://esplora.example.org");
  // a raw "'" in the credentials or path, and an IPv6 zone id (the pre-mainnet fixes' final check)
  assert.equal(redactUrls("GET https://user:pa'ss@h.example/KEY'x failed"), "GET https://h.example failed");
  assert.equal(redactUrls("at http://[fe80::1%25eth0]:8545/KEY now"), "at http://[fe80::1%25eth0]:8545 now");
  // a host right before a closing parenthesis is not doubled
  assert.equal(redactUrls("no contract at 0xC527 on chain 43111 (https://rpc.hemi.network): deploy first"), "no contract at 0xC527 on chain 43111 (https://rpc.hemi.network): deploy first");
  assert.equal(redactUrls("(https://h.example/v1/KEY), next"), "(https://h.example), next");
});

/** A JSON-RPC server answering eth_chainId with `id`. */
async function chainIdServer(id: number): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body) as { id: number };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: `0x${id.toString(16)}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${a.port}/rpc/SECRET-KEY`, server };
}

test("connect asks every --rpc URL for its chain id: one serving another chain is refused (pre-mainnet L-3)", async () => {
  const a = await chainIdServer(31_337);
  const b = await chainIdServer(999);
  const c = await chainIdServer(31_337);
  try {
    const ok = await connect([a.url, c.url]);
    assert.equal(ok.chainId, 31_337);
    await assert.rejects(connect([a.url, b.url]), (e: unknown) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, /--rpc http:\/\/127\.0\.0\.1:\d+ serves chain 999, but http:\/\/127\.0\.0\.1:\d+ serves chain 31337/);
      assert.doesNotMatch(e.message, /SECRET-KEY/);
      return true;
    });
    await assert.rejects(connect([a.url], 999), /--chain-id 999, but the RPC serves chain 31337 \(http:\/\/127\.0\.0\.1:\d+\)/);
  } finally {
    for (const s of [a, b, c]) s.server.close();
  }
});

test("key files must be inside a .secrets/ directory; a file named .secrets is not (pre-mainnet I-4)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbf-secrets-"));
  writeFileSync(join(dir, ".secrets"), "0x01\n");
  assert.throws(() => readSecretPath(join(dir, ".secrets"), "--key-file"), /--key-file must point inside a \.secrets\/ directory/);
  const inner = join(dir, "x");
  mkdirSync(join(inner, ".secrets"), { recursive: true });
  writeFileSync(join(inner, ".secrets", "hemi.key"), "0x02\n");
  assert.equal(readSecretPath(join(inner, ".secrets", "hemi.key"), "--key-file"), "0x02\n");
  writeFileSync(join(dir, "plain.key"), "0x03\n");
  assert.throws(() => readSecretPath(join(dir, "plain.key"), "--btc-key-file"), /--btc-key-file must point inside/);
});

/** A port nothing listens on: bind one, note it, close it. */
async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const a = s.address();
  if (!a || typeof a === "string") throw new Error("no port");
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${a.port}/rpc/SECRET-KEY`;
}

test("a fallback --rpc that does not answer is left out with a warning; the primary carries on (pre-mainnet review R-1)", async () => {
  const primary = await chainIdServer(43_111);
  const dead = await deadUrl();
  try {
    const warnings: string[] = [];
    const t0 = Date.now();
    const conn = await connect([primary.url, dead], undefined, (w) => warnings.push(w));
    assert.ok(Date.now() - t0 < 5_000, "a dead fallback costs seconds, not a minute");
    assert.equal(conn.chainId, 43_111);
    assert.deepEqual(conn.rpcUrls, [primary.url]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^--rpc http:\/\/127\.0\.0\.1:\d+ did not answer eth_chainId; it is left out of this run$/);
    // A dead first URL: without --chain-id it must answer, since it sets the chain (N-5); with --chain-id the others serve.
    await assert.rejects(connect([dead, primary.url], undefined, (w) => warnings.push(w)), /the first --rpc sets the chain \(give --chain-id to run on the others\)/);
    const flipped = await connect([dead, primary.url], 43_111, (w) => warnings.push(w));
    assert.deepEqual(flipped.rpcUrls, [primary.url]);
  } finally {
    primary.server.close();
  }
  await assert.rejects(connect([await deadUrl()]), (e: unknown) => {
    assert.match((e as Error).message, /^cannot read chain id from http:\/\/127\.0\.0\.1:\d+: /);
    assert.doesNotMatch((e as Error).message, /SECRET-KEY/);
    return true;
  });
});

test("Esplora URLs are printed as scheme and host only (pre-mainnet I-7)", () => {
  const b = new EsploraBackend("mainnet", ["https://user:pw@esplora.example.org/api/KEY/", "https://blockstream.info/api"]);
  assert.equal(b.name, "Esplora (https://esplora.example.org, https://blockstream.info)");
});

test("the CLI's error line never prints a URL's path, query or credentials (pre-mainnet I-7)", async () => {
  // An RPC that answers eth_chainId, then refuses everything else with HTTP 400: viem's error names the whole URL.
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body) as { id: number; method: string };
      if (r.method !== "eth_chainId") {
        res.statusCode = 400;
        return res.end("bad request");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: "0x7a69" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no port");
  // (No credentials in it: fetch refuses a URL that carries them; redactUrls' own test covers those.)
  const url = `http://127.0.0.1:${a.port}/v2/SECRET-KEY?token=SECRET-TOKEN`;
  try {
    const run = promisify(execFile);
    const r = await run(process.execPath, [join(SDK, "bin/hbf.mjs"), "facts", "status", "--id", `0x${"11".repeat(32)}`, "--rpc", url, "--contract", `0x${"22".repeat(20)}`], {
      cwd: SDK,
      encoding: "utf8",
    }).then(
      (o) => ({ code: 0, stderr: o.stderr }),
      (e: { code?: number; stderr?: string }) => ({ code: e.code ?? 1, stderr: e.stderr ?? "" }),
    );
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`^error: .*http://127\\.0\\.0\\.1:${a.port}`, "s"));
    assert.doesNotMatch(r.stderr, /SECRET/);
  } finally {
    server.close();
  }
});

test("no key prompt: without a key file both loaders refuse at once, even on a terminal (D-029)", async () => {
  const had = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try {
    await assert.rejects(common.loadSigner({}), (e: unknown) =>
      e instanceof UsageError && /^--key-file <path> is required to sign: .*never at a prompt$/.test(e.message));
    await assert.rejects(loadBtcKey({ network: "regtest" }), (e: unknown) =>
      e instanceof UsageError && /^--btc-key-file <path> is required to sign: .*regtest key.*never at a prompt$/.test(e.message));
  } finally {
    if (had) Object.defineProperty(process.stdin, "isTTY", had);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
  assert.equal("promptHidden" in common, false);
});
