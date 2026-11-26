/**
 * Shared plumbing for the SDK and the `hbf` CLI: RPC clients, signers, the mainnet guard and output.
 *
 * Every chain read goes through the vendored receipts client (fallback RPCs, retry with backoff,
 * at most 4 requests a second). `verify`-style commands need nothing but an RPC URL and a contract
 * address; only `record`/`checkpoint`/`create`/`redeem` need a key.
 */
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  createWalletClient,
  isAddress,
  isHex,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHemiPublicClient, hemiTransport } from "./vendor/receipts/client.js";

export const HEMI_MAINNET_CHAIN_ID = 43_111;
export const HEMI_TESTNET_CHAIN_ID = 743_111;

export class UsageError extends Error {
  override name = "UsageError";
}

// ---------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------

export interface Connection {
  client: PublicClient;
  chainId: number;
  rpcUrls: string[];
}

/**
 * Asks every RPC for its chain id (one plain request each, in parallel), then builds the rate-limited client over the
 * ones that answered. The client falls back from one URL to the next mid-run, so a URL serving another chain could mix
 * two chains' answers (pre-mainnet audit L-3): such a URL stops the command. One that does not answer is left out of
 * this run with a warning, so a dead fallback cannot take down a healthy primary (pre-mainnet review R-1); if
 * none answers, the first one's error is thrown. With `chainId`, each must serve that one.
 */
export async function connect(
  rpcUrls: string[],
  chainId?: number,
  warn: (message: string) => void = (m) => process.stderr.write(`warning: ${m}\n`),
): Promise<Connection> {
  if (rpcUrls.length === 0) throw new UsageError("--rpc <url> is required");
  // The first URL gets the full retries; a fallback two short probes, so a dead one (refusing or hanging) costs
  // seconds rather than a minute or more (review N-5).
  const answers = await Promise.allSettled(rpcUrls.map((url, i) => (i === 0 ? fetchChainId(url) : fetchChainId(url, 2, 5_000))));
  const first = answers[0]!;
  // Without an expected chain the first URL sets it, so it must answer: a fallback alone must not pick the chain (N-5).
  if (chainId === undefined && first.status === "rejected") {
    const why = first.reason instanceof Error ? first.reason.message : String(first.reason);
    throw new Error(`${why}; the first --rpc sets the chain (give --chain-id to run on the others)`);
  }
  const live = rpcUrls.flatMap((url, i) => {
    const a = answers[i]!;
    return a.status === "fulfilled" ? [{ url, id: a.value }] : [];
  });
  if (live.length === 0) throw (first as PromiseRejectedResult).reason;
  const id = chainId ?? live[0]!.id;
  for (const l of live) {
    if (l.id === id) continue;
    if (chainId !== undefined) throw new UsageError(`--chain-id ${id}, but the RPC serves chain ${l.id} (${redactUrl(l.url)})`);
    throw new UsageError(`--rpc ${redactUrl(l.url)} serves chain ${l.id}, but ${redactUrl(live[0]!.url)} serves chain ${id}; every --rpc URL must serve the same chain`);
  }
  rpcUrls.forEach((url, i) => {
    if (answers[i]!.status === "rejected") warn(`--rpc ${redactUrl(url)} did not answer eth_chainId; it is left out of this run`);
  });
  const urls = live.map((l) => l.url);
  return { client: createHemiPublicClient({ chainId: id, rpcUrls: urls }), chainId: id, rpcUrls: urls };
}

export async function fetchChainId(url: string, attempts = 5, timeoutMs = 15_000): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json()) as { result?: string };
      if (body.result) return Number(BigInt(body.result));
      lastError = new Error(`eth_chainId returned ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`cannot read chain id from ${redactUrl(url)}: ${redactUrls(String(lastError))}`);
}

/** An RPC URL for messages: scheme and host only, so credentials, paths and query strings are never printed. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<invalid URL>";
  }
}

/**
 * Every http(s) URL in `text` cut to its scheme and host (redactUrl). For messages built by code that prints whole
 * URLs (viem's errors, the vendored Esplora client), so a private RPC or Esplora URL's credentials, key-bearing path or
 * query string never reach the terminal.
 */
export function redactUrls(text: string): string {
  // By pattern, not by URL parsing: a URL in running text is often followed by punctuation ("…from http://h:1: …"),
  // which would make it unparseable. Punctuation after it is kept.
  // The credentials run to the last "@" before the path, as URL parsing has it (a password may hold one, or a "'";
  // P-3), and a host may be an IPv6 literal, with a zone id. Cutting too much is the safe side.
  return text.replace(/\b(https?):\/\/(?:[^\s/?#"<>`]*@)?(\[[0-9A-Fa-f:.%a-zA-Z]+\]|[^\s/?#:@"'<>`\[\](){},;!]+)(:\d+)?[^\s"<>`]*/gi, (m, scheme: string, host: string, port: string | undefined) => {
    const tail = /[.,:;!?)\]]+$/.exec(m)?.[0] ?? "";
    return `${scheme.toLowerCase()}://${host.toLowerCase()}${port ?? ""}${tail}`;
  });
}

// ---------------------------------------------------------------------------------------------
// Verification options
// ---------------------------------------------------------------------------------------------

export interface VerifyOptions {
  /**
   * Accept a contract whose runtime code is not the one this SDK carries. Off by default: the three contracts have no
   * immutables and no metadata, so every authentic deployment has exactly that code, and a look-alike at an address
   * copied from an untrusted file could emit matching events without reading hVM (pre-mainnet audit I-3).
   */
  allowOtherCode?: boolean;
}

/** What an Invalid says when the code differs. */
export const OTHER_CODE = "its runtime code is not a build this SDK knows";

/**
 * Whether `code` is one of `runtimes` (a contract's known releases: today one each; a later SDK lists every earlier
 * release's runtime beside its own, so facts recorded at an earlier address still verify; pre-mainnet review R-10).
 */
export function sameCode(code: Hex | undefined, runtimes: readonly Hex[]): boolean {
  return code !== undefined && runtimes.some((r) => r.toLowerCase() === code.toLowerCase());
}

/**
 * For the CLI: the code at `contract` must be one of `runtimes`, else a line on stderr and false. Every command that
 * reads or writes a contract uses this, not only `verify` (pre-mainnet review R-2): a look-alike could make
 * `finality status` report final, or `facts status` print a fact, without reading hVM.
 */
export async function hasKnownCode(conn: Connection, contract: Address, runtimes: readonly Hex[], name: string, hint = ""): Promise<boolean> {
  const code = await conn.client.getCode({ address: contract });
  if (!code || code === "0x") {
    process.stderr.write(`no contract at ${contract} on chain ${conn.chainId}${hint}\n`);
    return false;
  }
  if (!sameCode(code, runtimes)) {
    process.stderr.write(`the code at ${contract} on chain ${conn.chainId} is not this SDK's ${name} (${OTHER_CODE}); refusing to use it\n`);
    return false;
  }
  return true;
}

export function walletFor(conn: Connection, account: Account): WalletClient {
  const { transport, chain } = hemiTransport({ chainId: conn.chainId, rpcUrls: conn.rpcUrls });
  return createWalletClient({ account, chain, transport });
}

// ---------------------------------------------------------------------------------------------
// Signers. Keys never appear in argv, logs or output: they come only from a file under .secrets/.
// There is no key prompt (docs/DECISIONS.md D-029).
// ---------------------------------------------------------------------------------------------

export interface SignerOptions {
  /** Path to a file holding a 0x-prefixed private key. Must resolve inside a `.secrets/` directory. Required. */
  keyFile?: string;
}

/** The message when a command has something to sign and no key file was given. */
export function keyFileRequired(flag: string, holds: string): UsageError {
  return new UsageError(`${flag} <path> is required to sign: a file under a .secrets/ directory holding ${holds}; keys are read only from files, never at a prompt`);
}

export async function loadSigner(options: SignerOptions): Promise<Account> {
  if (!options.keyFile) throw keyFileRequired("--key-file", "the 0x private key");
  const key = readKeyFile(options.keyFile);
  if (!isHex(key) || key.length !== 66) throw new UsageError("the private key must be 32 bytes of 0x-prefixed hex");
  return privateKeyToAccount(key);
}

function readKeyFile(path: string): Hex {
  return readSecretPath(path, "--key-file").trim() as Hex;
}

/**
 * Reads a key file that resolves (symlinks followed) to a file inside a directory named `.secrets`, which .gitignore
 * ignores. A file itself named `.secrets` is not inside one, and is refused (pre-mainnet audit I-4).
 */
export function readSecretPath(path: string, flag: string): string {
  const real = realpathSync(resolve(path));
  if (!real.split(sep).slice(0, -1).includes(".secrets")) {
    throw new UsageError(`${flag} must point inside a .secrets/ directory (gitignored)`);
  }
  return readFileSync(real, "utf8");
}

/**
 * Writes to Hemi mainnet need an explicit `--allow-mainnet`. Each mainnet action in this project
 * waits for its own go (docs/BRIEF.md, Rules); the flag makes that a deliberate act.
 */
export function assertWriteAllowed(chainId: number, allowMainnet: boolean | undefined): void {
  if (chainId === HEMI_MAINNET_CHAIN_ID && !allowMainnet) {
    throw new UsageError("refusing to send a transaction on Hemi mainnet without --allow-mainnet");
  }
}

// ---------------------------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------------------------

export function requireAddress(value: string | undefined, flag: string): Address {
  if (!value || !isAddress(value)) throw new UsageError(`${flag} <0x address> is required`);
  return value;
}

export function requireBytes32(value: string | undefined, flag: string): Hex {
  const v = value && !value.startsWith("0x") ? `0x${value}` : value;
  if (!v || !isHex(v) || v.length !== 66) throw new UsageError(`${flag} <32-byte hex> is required`);
  return v.toLowerCase() as Hex;
}

export function requireUint(value: string | undefined, flag: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) > max) {
    throw new UsageError(`${flag} <integer 0..${max}> is required`);
  }
  return Number(value);
}

/** Common CLI options every command accepts (node:util parseArgs format). */
export const COMMON_OPTIONS = {
  rpc: { type: "string", multiple: true },
  "chain-id": { type: "string" },
  contract: { type: "string" },
  json: { type: "boolean" },
  "key-file": { type: "string" },
  "allow-mainnet": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/** JSON with bigints as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export function print(value: unknown, json: boolean | undefined, human?: () => string): void {
  process.stdout.write(`${json || !human ? toJson(value) : human()}\n`);
}
