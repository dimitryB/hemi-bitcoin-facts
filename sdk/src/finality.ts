/**
 * PopFinality from TypeScript: checkpoint and record keystone publications (transactions), check them, read a Hemi
 * block's Bitcoin confirmations through the contract, verify `publication` fact files (docs/SCHEMA.md), find PoP
 * transactions through Esplora (a hint only: the contract decides), and the `watch` loop.
 *
 * Every chain read takes a viem PublicClient; pass one from `connect()` in common.ts (fallback RPCs, retry with
 * backoff, at most 4 requests a second). `verify` needs nothing but that client and the contract address.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  BaseError,
  decodeEventLog,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  toBytes,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { POP_FINALITY_INIT_CODE, POP_FINALITY_RUNTIME, popFinalityAbi } from "./abi/PopFinality.js";
import { CREATE2_DEPLOYER, factId, hemiStage, SCHEMA, type AsOf, type HemiStage, type Recording } from "./facts.js";
import { findAll, transactionsContaining } from "./vendor/receipts/bitcoin.js";
import { pollTransactionReceipt, withRetry } from "./vendor/receipts/client.js";
import {
  BTC_FINAL_CONFIRMATIONS,
  defaultFinalityReader,
  EsploraClient,
  KNOWN_POP_MINERS_MAINNET,
  type EsploraBlock,
} from "./vendor/receipts/finality.js";
import {
  ABREV_BYTES,
  decodePopOpReturn,
  KEYSTONE_PERIOD,
  KeystoneError,
  keystoneAbrev,
  POP_SCRIPT_PREFIX,
  type AbrevCache,
} from "./vendor/receipts/keystone.js";
import type { FinalityReader } from "./vendor/receipts/status.js";
import type { BtcFinality } from "./vendor/receipts/types.js";
import { HEMI_MAINNET_CHAIN_ID, OTHER_CODE, redactUrls, sameCode, type VerifyOptions } from "./common.js";

export { popFinalityAbi, POP_FINALITY_INIT_CODE, POP_FINALITY_RUNTIME, KEYSTONE_PERIOD, BTC_FINAL_CONFIRMATIONS };
/**
 * Every PopFinality runtime this SDK accepts in `verify` (pre-mainnet audit I-3): this build's. A later release adds
 * its own and keeps these, so earlier deployments' publications still verify.
 */
export const POP_FINALITY_RUNTIMES: readonly Hex[] = [POP_FINALITY_RUNTIME];

// ---------------------------------------------------------------------------------------------
// Constants: the contract's, mirrored (test/finality.test.ts checks them against the contract)
// ---------------------------------------------------------------------------------------------

export const KIND_PUBLICATION: Hex = keccak256(toBytes("hemi-bitcoin-facts/publication"));
/** contracts/script/Deploy.s.sol `Deployments.POP_FINALITY_SALT`. */
export const POP_FINALITY_SALT: Hex = keccak256(toBytes("hemi-bitcoin-facts/PopFinality/v1"));
/** EIP-2935 serves block hashes up to this many blocks back (DECISIONS.md D-008). */
export const HISTORY_SERVE_WINDOW = 8191;
export const BLOCKHASH_WINDOW = 256;
/** hVM trails Bitcoin by about two blocks (D-012), so a transaction is readable after about three confirmations. */
export const HVM_VISIBLE_CONFIRMATIONS = 3;
/**
 * `watch` keeps retrying a PoP output that hVM cannot read yet (NotFound, NoBitcoinView, NoConfirmations) until it
 * has this many Bitcoin confirmations more than `minConfirmations` (at least WATCH_MIN_RETRY_CONFIRMATIONS in all):
 * D-012 saw hVM four blocks behind Esplora in bursts (pre-mainnet audit M-2).
 */
export const WATCH_RETRY_EXTRA_CONFIRMATIONS = 12;
export const WATCH_MIN_RETRY_CONFIRMATIONS = 20;
/** Bitcoin blocks `watch` remembers by hash, to rescan one a reorg replaced. */
export const WATCH_REORG_DEPTH = 6;
/** Outputs `watch` remembers as dealt with (oldest forgotten first). */
export const WATCH_DONE_LIMIT = 10_000;
/** Canonical keystones `watch` keeps rebuilt (oldest forgotten first). */
export const WATCH_CACHE_LIMIT = 1_000;
/** Entries each of `watch`'s stats lists keeps (the newest). With the limits above, a run of any length has bounded memory. */
export const WATCH_LIST_LIMIT = 1_000;
/**
 * Failures in a row after which `watch` gives an output up, once it is also past the retry window: a request that keeps
 * throwing for it, or a transaction for it that reverts or is not mined (review N-1, N-2, P-1).
 * Between failures it waits 1, 2, 4, … up to WATCH_MAX_BACKOFF passes, so a send is not repeated every pass.
 */
export const WATCH_MAX_FAILURES = 5;
export const WATCH_MAX_BACKOFF = 32;
/** Passes to wait after the n-th failure in a row: 1, 2, 4, … WATCH_MAX_BACKOFF. */
const backoff = (n: number): number => Math.min(2 ** (n - 1), WATCH_MAX_BACKOFF);
/** A PoP for a keystone up to this many blocks past the Hemi RPC's newest is taken as the RPC lagging (pre-mainnet review R-4); further is a forgery. */
export const WATCH_LAG_BLOCKS = 300;

/** Adds `key` to an insertion-ordered set, forgetting the oldest entries past `limit`. */
export function remember(set: Set<string>, key: string, limit: number): void {
  set.delete(key);
  set.add(key);
  while (set.size > limit) set.delete(set.values().next().value!);
}
/** checkPublication verdicts that can turn Ok as hVM catches up: `watch` retries these. Every other one is final. */
export const TRANSIENT_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(["NotFound", "NoBitcoinView", "NoConfirmations"]);
/** Esplora instances, in order: mempool.space, then blockstream.info (D-012 item 8). */
export const DEFAULT_ESPLORA_MAINNET = ["https://mempool.space/api", "https://blockstream.info/api"];

/** Where Deploy.s.sol puts the compiled PopFinality on any chain with the deterministic deployer. */
export function popFinalityCreate2Address(): Address {
  return getContractAddress({ from: CREATE2_DEPLOYER, salt: POP_FINALITY_SALT, bytecode: POP_FINALITY_INIT_CODE, opcode: "CREATE2" });
}

/** PopFinality.Verdict, in enum order. */
export const VERDICTS = [
  "Ok",
  "NotKeystone",
  "NotProduced",
  "OutsideWindow",
  "NoBitcoinView",
  "NotFound",
  "VoutTooHigh",
  "WrongLength",
  "WrongPrefix",
  "Inconsistent",
  "WrongVersion",
  "WrongKeystone",
  "WrongBlockHash",
  "NoConfirmations",
  "NotCovering",
  "NotRecorded",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_MEANING: Record<Verdict, string> = {
  Ok: "the check passed",
  NotKeystone: "not a keystone: 0, not a multiple of 25, or above 2^32 - 1",
  NotProduced: "block K is not in the past yet",
  OutsideWindow: "no checkpoint, and block K's hash is no longer readable (more than 8,191 blocks back)",
  NoBitcoinView: "0x44 gave no usable Bitcoin header",
  NotFound: "0x42 has no usable answer for the transaction, or vout is past its output count",
  VoutTooHigh: "vout is 128 or higher, past 0x42's window",
  WrongLength: "the output's script is not 83 bytes",
  WrongPrefix: "the script does not start with 6a4c5048454d49 (OP_RETURN OP_PUSHDATA1 0x50 \"HEMI\")",
  Inconsistent: "0x42 lists the OP_RETURN as in the UTXO set",
  WrongVersion: "the abbreviated keystone's version is not 1",
  WrongKeystone: "the abbreviated keystone's L2 number is not K",
  WrongBlockHash: "the abbreviated keystone's block hash prefix is not block K's",
  NoConfirmations: "0x43 gave no plausible confirmation count",
  NotCovering: "K is before the block's covering keystone",
  NotRecorded: "that publication (or, for the anchored reading, any publication of K) is not stored",
};

export function verdictName(n: number): Verdict {
  const v = VERDICTS[n];
  if (!v) throw new Error(`unknown PopFinality verdict ${n}`);
  return v;
}

const lower = <T extends string>(s: T): T => s.toLowerCase() as T;
const ZERO32: Hex = `0x${"0".repeat(64)}`;

export function isKeystone(k: number | bigint): boolean {
  const n = BigInt(k);
  return n > 0n && n % BigInt(KEYSTONE_PERIOD) === 0n && n <= 0xffffffffn;
}

/** PopFinality.MAX_KEYSTONE: the largest multiple of 25 that fits in 32 bits. */
export const MAX_KEYSTONE = 4_294_967_275;

/**
 * PopFinality.coveringKeystone: the block itself if it is a nonzero multiple of 25, else the next multiple of 25, so
 * 25 for block 0; 0 (not a keystone) above MAX_KEYSTONE. The receipts SDK's coveringKeystone gives 0 for block 0 and
 * does not stop at 32 bits; this one is the contract's, so every nonzero answer is a keystone (pre-mainnet audit L-1).
 */
export function coveringKeystone(block: bigint): bigint;
export function coveringKeystone(block: number): number;
export function coveringKeystone(block: bigint | number): bigint | number {
  const b = BigInt(block);
  const p = BigInt(KEYSTONE_PERIOD);
  const k = b === 0n ? p : b > BigInt(MAX_KEYSTONE) ? 0n : b % p === 0n ? b : b - (b % p) + p;
  return typeof block === "bigint" ? k : Number(k);
}

// ---------------------------------------------------------------------------------------------
// Abbreviated keystones
// ---------------------------------------------------------------------------------------------

export interface ParsedAbrev {
  version: number;
  /** L1 (Ethereum) origin block number: bytes [1:5]. Not checked by the contract. */
  l1: number;
  /** L2 number K: bytes [5:9]. */
  l2: number;
  /** bytes [9:20] */
  parentHashPrefix: Hex;
  /** bytes [20:32]: block K − 25's hash prefix */
  prevKeystoneHashPrefix: Hex;
  /** bytes [32:64] */
  stateRoot: Hex;
  /** bytes [64:76]: block K's hash prefix */
  blockHashPrefix: Hex;
}

/** Parses a 76-byte abbreviated keystone by offset, as PopFinality does. Throws on any other length. */
export function parseAbrev(abrev: Hex): ParsedAbrev {
  const hex = abrev.slice(2).toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex) || hex.length !== ABREV_BYTES * 2) throw new Error(`an abbreviated keystone is ${ABREV_BYTES} bytes`);
  const at = (from: number, to: number): string => hex.slice(from * 2, to * 2);
  return {
    version: Number.parseInt(at(0, 1), 16),
    l1: Number.parseInt(at(1, 5), 16),
    l2: Number.parseInt(at(5, 9), 16),
    parentHashPrefix: `0x${at(9, 20)}`,
    prevKeystoneHashPrefix: `0x${at(20, 32)}`,
    stateRoot: `0x${at(32, 64)}`,
    blockHashPrefix: `0x${at(64, 76)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

/** keccak256(K as 4 big-endian bytes ‖ txid ‖ vout as 2 big-endian bytes): 38 bytes hashed. */
export function publicationSubject(keystone: number, btcTxid: Hex, vout: number): Hex {
  return keccak256(encodePacked(["uint32", "bytes32", "uint16"], [keystone, btcTxid, vout]));
}

/** keccak256(abi.encode(KIND_PUBLICATION, subject, btcBlockHash)). */
export function publicationId(keystone: number, btcTxid: Hex, vout: number, btcBlockHash: Hex): Hex {
  return factId(KIND_PUBLICATION, publicationSubject(keystone, btcTxid, vout), btcBlockHash);
}

// ---------------------------------------------------------------------------------------------
// Fact files (docs/SCHEMA.md `publication`). Integers are numbers in memory (all fit), decimal strings on disk.
// ---------------------------------------------------------------------------------------------

export interface PublicationFields {
  keystone: number;
  btcTxid: Hex;
  vout: number;
  /** 0x43 when it was recorded. */
  confirmations: number;
  /** The 76-byte abbreviated keystone. Emitted, not stored. */
  abrev: Hex;
}

export interface PublicationFactFile {
  schema: typeof SCHEMA;
  kind: "publication";
  chainId: number;
  contract: Address;
  id: Hex;
  fact: PublicationFields;
  asOf: AsOf;
  recording: Recording;
}

export function idOfPublicationFile(file: PublicationFactFile): Hex {
  return publicationId(file.fact.keystone, file.fact.btcTxid, file.fact.vout, file.asOf.btcBlockHash);
}

/** The JSON object, keys in schema order, every integer a decimal string, hex lowercase. */
export function publicationFileJson(file: PublicationFactFile): Record<string, unknown> {
  return {
    schema: file.schema,
    kind: file.kind,
    chainId: String(file.chainId),
    contract: lower(file.contract),
    id: lower(file.id),
    fact: {
      keystone: String(file.fact.keystone),
      btcTxid: lower(file.fact.btcTxid),
      vout: String(file.fact.vout),
      confirmations: String(file.fact.confirmations),
      abrev: lower(file.fact.abrev),
    },
    asOf: { btcHeight: String(file.asOf.btcHeight), btcBlockHash: lower(file.asOf.btcBlockHash) },
    recording: {
      txHash: lower(file.recording.txHash),
      blockNumber: file.recording.blockNumber.toString(),
      blockHash: lower(file.recording.blockHash),
    },
  };
}

export function serializePublicationFile(file: PublicationFactFile): string {
  return `${JSON.stringify(publicationFileJson(file), null, 2)}\n`;
}

export function writePublicationFile(path: string, file: PublicationFactFile): void {
  writeFileSync(path, serializePublicationFile(file));
}

export type PublicationFileParse = { ok: true; file: PublicationFactFile } | { ok: false; errors: string[] };

const DEC = /^(0|[1-9][0-9]*)$/;
const B32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const ABREV = new RegExp(`^0x[0-9a-f]{${ABREV_BYTES * 2}}$`);

/** Strict parse of a `publication` fact file's JSON value: exact keys, exact value formats, values in range. */
export function parsePublicationFile(input: unknown): PublicationFileParse {
  const errors: string[] = [];
  const obj = (v: unknown, path: string, keys: readonly string[]): Record<string, unknown> | undefined => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      errors.push(`${path} must be an object`);
      return undefined;
    }
    const o = v as Record<string, unknown>;
    for (const k of keys) if (!(k in o)) errors.push(`${path}.${k} is missing`);
    for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${path}.${k} is not a known key`);
    return o;
  };
  const dec = (v: unknown, path: string, max: bigint): bigint => {
    if (typeof v !== "string" || !DEC.test(v)) {
      errors.push(`${path} must be a decimal string`);
      return 0n;
    }
    const n = BigInt(v);
    if (n > max) errors.push(`${path} is out of range`);
    return n;
  };
  const re = (v: unknown, path: string, pattern: RegExp, what: string): Hex => {
    if (typeof v !== "string" || !pattern.test(v)) errors.push(`${path} must be ${what}`);
    return (typeof v === "string" ? v : "0x") as Hex;
  };

  const top = obj(input, "file", ["schema", "kind", "chainId", "contract", "id", "fact", "asOf", "recording"]);
  if (!top) return { ok: false, errors };
  if (top.schema !== SCHEMA) errors.push(`file.schema must be "${SCHEMA}"`);
  if (top.kind !== "publication") {
    errors.push('file.kind must be "publication"');
    return { ok: false, errors };
  }
  const chainId = dec(top.chainId, "file.chainId", BigInt(Number.MAX_SAFE_INTEGER));
  const contract = re(top.contract, "file.contract", ADDR, "a lowercase 0x address");
  const id = re(top.id, "file.id", B32, "32 bytes of lowercase hex");
  const f = obj(top.fact, "file.fact", ["keystone", "btcTxid", "vout", "confirmations", "abrev"]);
  const keystone = Number(dec(f?.keystone, "file.fact.keystone", 0xffffffffn));
  const asOfObj = obj(top.asOf, "file.asOf", ["btcHeight", "btcBlockHash"]);
  const recObj = obj(top.recording, "file.recording", ["txHash", "blockNumber", "blockHash"]);
  const file: PublicationFactFile = {
    schema: SCHEMA,
    kind: "publication",
    chainId: Number(chainId),
    contract: contract as Address,
    id,
    fact: {
      keystone,
      btcTxid: re(f?.btcTxid, "file.fact.btcTxid", B32, "32 bytes of lowercase hex"),
      vout: Number(dec(f?.vout, "file.fact.vout", 0xffffn)),
      confirmations: Number(dec(f?.confirmations, "file.fact.confirmations", 0xffffffffn)),
      abrev: re(f?.abrev, "file.fact.abrev", ABREV, `${ABREV_BYTES} bytes of lowercase hex`),
    },
    asOf: {
      btcHeight: Number(dec(asOfObj?.btcHeight, "file.asOf.btcHeight", 0xffffffffn)),
      btcBlockHash: re(asOfObj?.btcBlockHash, "file.asOf.btcBlockHash", B32, "32 bytes of lowercase hex"),
    },
    recording: {
      txHash: re(recObj?.txHash, "file.recording.txHash", B32, "32 bytes of lowercase hex"),
      blockNumber: dec(recObj?.blockNumber, "file.recording.blockNumber", 0xffffffffffffffffn),
      blockHash: re(recObj?.blockHash, "file.recording.blockHash", B32, "32 bytes of lowercase hex"),
    },
  };
  if (f && typeof f.keystone === "string" && DEC.test(f.keystone) && !isKeystone(keystone)) {
    errors.push("file.fact.keystone must be a positive multiple of 25 below 2^32");
  }
  return errors.length ? { ok: false, errors } : { ok: true, file };
}

export function readPublicationFile(path: string): PublicationFactFile {
  const parsed = parsePublicationFile(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new Error(`malformed publication fact file ${path}: ${parsed.errors.join("; ")}`);
  return parsed.file;
}

// ---------------------------------------------------------------------------------------------
// Reads (eth_call)
// ---------------------------------------------------------------------------------------------

export interface CallOptions {
  /** Place the compiled PopFinality at the contract address for the call (state override). */
  codeOverride?: boolean;
  stateOverride?: StateOverride;
  blockNumber?: bigint;
}

export function popFinalityCodeOverride(contract: Address): StateOverride {
  return [{ address: contract, code: POP_FINALITY_RUNTIME }];
}

/**
 * An eth_call state override object as JSON-RPC takes it (`{ "0xaddr": { "code": …, "stateDiff": { slot: value } } }`)
 * in viem's form. Throws on anything else.
 */
export function parseStateOverride(json: unknown): StateOverride {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("a state override is a JSON object keyed by address");
  const hex = (v: unknown, what: string): Hex => {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error(`${what} must be 0x hex`);
    return v as Hex;
  };
  return Object.entries(json as Record<string, unknown>).map(([address, o]) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${address} is not an address`);
    const e = (o ?? {}) as { code?: unknown; stateDiff?: unknown; balance?: unknown; nonce?: unknown };
    const entry: StateOverride[number] = { address: address as Address };
    if (e.code !== undefined) entry.code = hex(e.code, "code");
    if (e.balance !== undefined) entry.balance = BigInt(hex(e.balance, "balance"));
    if (e.nonce !== undefined) entry.nonce = Number(BigInt(hex(e.nonce, "nonce")));
    if (e.stateDiff !== undefined) {
      if (typeof e.stateDiff !== "object" || e.stateDiff === null) throw new Error("stateDiff must be an object");
      entry.stateDiff = Object.entries(e.stateDiff as Record<string, unknown>).map(([slot, value]) => ({ slot: hex(slot, "slot"), value: hex(value, "value") }));
    }
    return entry;
  });
}

function callOptions(contract: Address, o: CallOptions): { stateOverride?: StateOverride; blockNumber?: bigint } {
  const list = [...(o.codeOverride ? popFinalityCodeOverride(contract) : []), ...(o.stateOverride ?? [])];
  return { ...(list.length ? { stateOverride: list } : {}), ...(o.blockNumber !== undefined ? { blockNumber: o.blockNumber } : {}) };
}

export interface CheckpointCheck {
  verdict: Verdict;
  blockHashPrefix: Hex;
  stored: boolean;
}

export async function checkCheckpoint(client: PublicClient, contract: Address, keystone: number, o: CallOptions = {}): Promise<CheckpointCheck> {
  const [v, prefix, stored] = await client.readContract({
    address: contract,
    abi: popFinalityAbi,
    functionName: "checkCheckpoint",
    args: [BigInt(keystone)],
    ...callOptions(contract, o),
  });
  return { verdict: verdictName(v), blockHashPrefix: prefix, stored };
}

export interface PublicationCheck {
  verdict: Verdict;
  id: Hex;
  confirmations: number;
  asOf: AsOf;
  checkpoint: Hex;
  checkpointStored: boolean;
  keystone: ParsedAbrev;
  abrev: Hex;
  /** (K, txid, vout) is stored already. */
  recorded: boolean;
  /** It is K's best publication now. */
  best: boolean;
  /** recordPublication would make it K's best. */
  becomesBest: boolean;
  /** K's best publication and its confirmations read now (0 if it fails the check now); null if K has none. */
  currentBest: { btcTxid: Hex; vout: number; confirmations: number } | null;
}

export async function checkPublication(
  client: PublicClient,
  contract: Address,
  keystone: number,
  btcTxid: Hex,
  vout: number,
  o: CallOptions = {},
): Promise<PublicationCheck> {
  const c = await client.readContract({
    address: contract,
    abi: popFinalityAbi,
    functionName: "checkPublication",
    args: [BigInt(keystone), btcTxid, vout],
    ...callOptions(contract, o),
  });
  return {
    verdict: verdictName(c.verdict),
    id: c.id,
    confirmations: c.confirmations,
    asOf: { btcHeight: c.btcHeight, btcBlockHash: c.btcBlockHash },
    checkpoint: c.checkpoint,
    checkpointStored: c.checkpointStored,
    keystone: {
      version: c.keystone.version,
      l1: c.keystone.l1Number,
      l2: c.keystone.l2Number,
      parentHashPrefix: c.keystone.parentHashPrefix,
      prevKeystoneHashPrefix: c.keystone.prevKeystoneHashPrefix,
      stateRoot: c.keystone.stateRoot,
      blockHashPrefix: c.keystone.blockHashPrefix,
    },
    abrev: c.abrev,
    recorded: c.recorded,
    best: c.best,
    becomesBest: c.becomesBest,
    currentBest: c.bestTxid === ZERO32 ? null : { btcTxid: c.bestTxid, vout: c.bestVout, confirmations: c.bestConfirmations },
  };
}

export interface ConfirmationsResult {
  verdict: Verdict;
  confirmations: number;
  final: boolean;
}

/**
 * ANCHORED, not Hemi PoP finality: anchorConfirmations and isBtcAnchored of (block, K), which read K's best publication.
 * A forged keystone satisfies them for one Bitcoin fee (PopFinality's NatSpec; docs/SECURITY-AUDIT.md, internal review finding 1).
 * Two calls, so the two can straddle a Bitcoin block.
 */
export async function anchorConfirmations(client: PublicClient, contract: Address, block: bigint, keystone: number, o: CallOptions = {}): Promise<ConfirmationsResult> {
  const opts = callOptions(contract, o);
  const [v, confirmations] = await client.readContract({
    address: contract,
    abi: popFinalityAbi,
    functionName: "anchorConfirmations",
    args: [block, BigInt(keystone)],
    ...opts,
  });
  const final = await client.readContract({ address: contract, abi: popFinalityAbi, functionName: "isBtcAnchored", args: [block, BigInt(keystone)], ...opts });
  return { verdict: verdictName(v), confirmations, final };
}

/**
 * btcConfirmationsVia and isBtcFinalVia of (block, K, txid, vout): about that stored publication. Hemi PoP finality
 * when its 76 bytes were matched with the canonical keystone (`exactMatch`); the contract does not check that.
 */
export async function btcConfirmationsVia(
  client: PublicClient,
  contract: Address,
  block: bigint,
  keystone: number,
  btcTxid: Hex,
  vout: number,
  o: CallOptions = {},
): Promise<ConfirmationsResult> {
  const opts = callOptions(contract, o);
  const args = [block, BigInt(keystone), btcTxid, vout] as const;
  const [v, confirmations] = await client.readContract({ address: contract, abi: popFinalityAbi, functionName: "btcConfirmationsVia", args, ...opts });
  const final = await client.readContract({ address: contract, abi: popFinalityAbi, functionName: "isBtcFinalVia", args, ...opts });
  return { verdict: verdictName(v), confirmations, final };
}

export interface StoredCheckpoint {
  blockHashPrefix: Hex;
  hemiBlock: bigint;
}

export interface StoredPublication {
  btcTxid: Hex;
  btcBlockHash: Hex;
  hemiBlock: bigint;
  btcHeight: number;
  confirmations: number;
  vout: number;
}

export async function readCheckpoint(client: PublicClient, contract: Address, keystone: number, o: CallOptions = {}): Promise<StoredCheckpoint | null> {
  const c = await client.readContract({ address: contract, abi: popFinalityAbi, functionName: "checkpointOf", args: [BigInt(keystone)], ...callOptions(contract, o) });
  // As PopFinality._checkpointOf: a stored checkpoint has a nonzero Hemi block; its prefix can be zero.
  return c.hemiBlock === 0n ? null : { blockHashPrefix: c.blockHashPrefix, hemiBlock: c.hemiBlock };
}

/** The stored publication (K, txid, vout), or null. */
export async function readPublication(
  client: PublicClient,
  contract: Address,
  keystone: number,
  btcTxid: Hex,
  vout: number,
  o: CallOptions = {},
): Promise<StoredPublication | null> {
  const p = await client.readContract({
    address: contract,
    abi: popFinalityAbi,
    functionName: "publicationOf",
    args: [BigInt(keystone), btcTxid, vout],
    ...callOptions(contract, o),
  });
  return p.btcBlockHash === ZERO32 ? null : { ...p };
}

/** K's best publication (the stored one with the most confirmations, as last chosen), or null. */
export async function readBestPublication(client: PublicClient, contract: Address, keystone: number, o: CallOptions = {}): Promise<StoredPublication | null> {
  const p = await client.readContract({ address: contract, abi: popFinalityAbi, functionName: "bestPublicationOf", args: [BigInt(keystone)], ...callOptions(contract, o) });
  return p.btcBlockHash === ZERO32 ? null : { ...p };
}

export function idOfStored(keystone: number, s: StoredPublication): Hex {
  return publicationId(keystone, s.btcTxid, s.vout, s.btcBlockHash);
}

const sameOutput = (a: { btcTxid: Hex; vout: number } | null | undefined, b: { btcTxid: Hex; vout: number }): boolean =>
  !!a && lower(a.btcTxid) === lower(b.btcTxid) && a.vout === b.vout;

/**
 * A transaction's outputs as hVM's 0x42 lists them (flags 003c0703: outputs, scripts cut at 128 bytes, unspendable
 * ones included), by a raw eth_call to the precompile. Empty when 0x42 has no answer.
 */
export async function txOutputs(client: PublicClient, btcTxid: Hex): Promise<{ vout: number; script: Hex }[]> {
  const ret = (await client.call({ to: "0x0000000000000000000000000000000000000042", data: `${btcTxid}003c0703` }).catch(() => ({ data: undefined }))).data;
  if (!ret || ret.length < 6) return [];
  const b = toBytes(ret);
  const total = (b[0]! << 8) | b[1]!;
  const out: { vout: number; script: Hex }[] = [];
  let off = 2;
  // Parsed as Hvm.txOutputs does: a truncated or malformed answer is no answer, not a partial list (pre-mainnet I-6).
  for (let i = 0; i < Math.min(total, 128); i++) {
    if (off + 10 > b.length) return [];
    const len = (b[off + 8]! << 8) | b[off + 9]!;
    const cut = Math.min(len, 128);
    if (off + 11 + cut > b.length || b[off + 10 + cut]! > 1) return [];
    out.push({ vout: i, script: `0x${Buffer.from(b.subarray(off + 10, off + 10 + cut)).toString("hex")}` });
    off += 11 + cut;
  }
  return off === b.length ? out : [];
}

/** The PoP outputs of `btcTxid` for `keystone`, with their abrevs, from 0x42 (see txOutputs). */
export async function popOutputs(client: PublicClient, btcTxid: Hex, keystone: number): Promise<{ vout: number; abrev: Hex }[]> {
  const out: { vout: number; abrev: Hex }[] = [];
  for (const o of await txOutputs(client, btcTxid)) {
    const pop = decodePopOpReturn(o.script);
    if (pop && pop.l2 === keystone) out.push({ vout: o.vout, abrev: lower(pop.abrev) });
  }
  return out;
}

/** The vouts of `btcTxid` whose script is a PoP script for `keystone` (see popOutputs). */
export async function popVouts(client: PublicClient, btcTxid: Hex, keystone: number): Promise<number[]> {
  return (await popOutputs(client, btcTxid, keystone)).map((o) => o.vout);
}

// ---------------------------------------------------------------------------------------------
// Events and recordings
// ---------------------------------------------------------------------------------------------

export interface PublicationEvent {
  id: Hex;
  keystone: bigint;
  btcTxid: Hex;
  vout: number;
  confirmations: number;
  btcHeight: number;
  btcBlockHash: Hex;
  hemiBlock: bigint;
  abrev: Hex;
}

export interface BestChangedEvent {
  keystone: bigint;
  btcTxid: Hex;
  vout: number;
  confirmations: number;
  previousTxid: Hex;
  previousVout: number;
}

type Log = { address: Address; topics: readonly Hex[]; data: Hex };

function decoded(logs: readonly Log[], contract: Address) {
  const out = [];
  for (const log of logs) {
    if (lower(log.address) !== lower(contract)) continue;
    try {
      out.push(decodeEventLog({ abi: popFinalityAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }));
    } catch {
      // not ours
    }
  }
  return out;
}

/** The PublicationRecorded events among `logs` from `contract`, optionally only those for `id`. */
export function publicationEvents(logs: readonly Log[], contract: Address, id?: Hex): PublicationEvent[] {
  return decoded(logs, contract)
    .filter((ev) => ev.eventName === "PublicationRecorded")
    .map((ev) => ev.args as PublicationEvent)
    .filter((a) => id === undefined || lower(a.id) === lower(id));
}

export function bestChangedEvents(logs: readonly Log[], contract: Address): BestChangedEvent[] {
  return decoded(logs, contract)
    .filter((ev) => ev.eventName === "BestPublicationChanged")
    .map((ev) => ev.args as BestChangedEvent);
}

export function checkpointEvents(logs: readonly Log[], contract: Address): { keystone: bigint; blockHashPrefix: Hex; hemiBlock: bigint }[] {
  return decoded(logs, contract)
    .filter((ev) => ev.eventName === "Checkpointed")
    .map((ev) => ev.args as { keystone: bigint; blockHashPrefix: Hex; hemiBlock: bigint });
}

export interface LocatedPublication {
  stored: StoredPublication;
  event: PublicationEvent;
  recording: Recording;
}

/** Finds the event that stored a publication: one getLogs over the single Hemi block the contract stored. */
export async function locatePublication(client: PublicClient, contract: Address, keystone: number, stored: StoredPublication): Promise<LocatedPublication | null> {
  const id = idOfStored(keystone, stored);
  const logs = await client.getLogs({ address: contract, fromBlock: stored.hemiBlock, toBlock: stored.hemiBlock });
  for (const log of logs) {
    const ev = publicationEvents([log], contract, id)[0];
    if (!ev || log.transactionHash === null || log.blockHash === null || log.blockNumber === null) continue;
    return { stored, event: ev, recording: { txHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash } };
  }
  return null;
}

export function fileFromPublication(chainId: number, contract: Address, keystone: number, located: LocatedPublication): PublicationFactFile {
  const { stored: s, event, recording } = located;
  return {
    schema: SCHEMA,
    kind: "publication",
    chainId,
    contract: lower(getAddress(contract)),
    id: lower(idOfStored(keystone, s)),
    fact: { keystone, btcTxid: lower(s.btcTxid), vout: s.vout, confirmations: s.confirmations, abrev: lower(event.abrev) },
    asOf: { btcHeight: s.btcHeight, btcBlockHash: lower(s.btcBlockHash) },
    recording,
  };
}

/** The fact file of the stored publication (K, txid, vout), from the contract and its event (pinned to `receipt`'s block). */
export async function publicationFileFor(
  client: PublicClient,
  chainId: number,
  contract: Address,
  keystone: number,
  btcTxid: Hex,
  vout: number,
  receipt?: TransactionReceipt,
): Promise<PublicationFactFile> {
  return withRetry(
    async () => {
      const stored = await readPublication(client, contract, keystone, btcTxid, vout, receipt ? { blockNumber: receipt.blockNumber } : {});
      if (!stored) throw new Error(`publication ${btcTxid}:${vout} of keystone ${keystone} is not stored at ${contract}`);
      const located = await locatePublication(client, contract, keystone, stored);
      if (!located) throw new Error(`no PublicationRecorded event for ${btcTxid}:${vout} in Hemi block ${stored.hemiBlock}`);
      return fileFromPublication(chainId, contract, keystone, located);
    },
    { retries: receipt ? 5 : 0, baseDelayMs: 1_000 },
  );
}

// ---------------------------------------------------------------------------------------------
// Writes. The caller runs the mainnet guard (`assertWriteAllowed`) before any of these.
// ---------------------------------------------------------------------------------------------

export class NotRecordableError extends Error {
  constructor(
    readonly verdict: Verdict,
    readonly what: string,
  ) {
    super(`not recordable: ${verdict} (${VERDICT_MEANING[verdict]})`);
    this.name = "NotRecordableError";
  }
}

export interface CheckpointResult {
  keystone: number;
  blockHashPrefix: Hex;
  created: boolean;
  txHash?: Hex;
  hemiBlock?: bigint;
}

/** Checks by eth_call, then sends `checkpoint(K)` unless it is already stored. */
export async function sendCheckpoint(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  contract: Address,
  keystone: number,
  options: { timeoutMs?: number } = {},
): Promise<CheckpointResult> {
  const c = await checkCheckpoint(client, contract, keystone);
  if (c.verdict !== "Ok") throw new NotRecordableError(c.verdict, `checkpoint of keystone ${keystone}`);
  if (c.stored) return { keystone, blockHashPrefix: c.blockHashPrefix, created: false };
  const hash = await wallet.writeContract({ address: contract, abi: popFinalityAbi, functionName: "checkpoint", args: [BigInt(keystone)], account, chain: wallet.chain });
  const receipt = await pollTransactionReceipt(client, hash, { timeoutMs: options.timeoutMs });
  if (receipt.status !== "success") throw new Error(`checkpoint transaction ${hash} reverted`);
  const ev = checkpointEvents(receipt.logs, contract).find((e) => e.keystone === BigInt(keystone));
  return { keystone, blockHashPrefix: ev?.blockHashPrefix ?? c.blockHashPrefix, created: ev !== undefined, txHash: hash, hemiBlock: receipt.blockNumber };
}

export interface PublicationRecordResult {
  file: PublicationFactFile;
  /** True when this call stored the publication; false when it was stored already. */
  created: boolean;
  /** It is K's best publication after the call. */
  best: boolean;
  /** The transaction this call sent; none when it was stored and would not become the best. */
  sentTxHash?: Hex;
  /** K's previous best, when this call made it the best. */
  previousBest?: { btcTxid: Hex; vout: number };
  check: PublicationCheck;
}

/**
 * Checks by eth_call, then sends `recordPublication(K, txid, vout)` when it is not stored yet, or when it is stored
 * and would become K's best (re-running the choice, which restores a best that stopped verifying). Builds the fact
 * file of that publication from what the contract stored and emitted. Throws NotRecordableError for a non-Ok
 * verdict; nothing is sent then.
 */
export async function sendPublication(
  client: PublicClient,
  wallet: WalletClient | undefined,
  account: Account | undefined,
  chainId: number,
  contract: Address,
  keystone: number,
  btcTxid: Hex,
  vout: number,
  options: { timeoutMs?: number; check?: PublicationCheck } = {},
): Promise<PublicationRecordResult> {
  const check = options.check ?? (await checkPublication(client, contract, keystone, btcTxid, vout));
  if (check.verdict !== "Ok") throw new NotRecordableError(check.verdict, `publication ${btcTxid}:${vout} of keystone ${keystone}`);
  if (check.recorded && !check.becomesBest) {
    return { file: await publicationFileFor(client, chainId, contract, keystone, btcTxid, vout), created: false, best: check.best, check };
  }
  if (!wallet || !account) throw new Error("a signer is needed to send recordPublication");
  const hash = await wallet.writeContract({
    address: contract,
    abi: popFinalityAbi,
    functionName: "recordPublication",
    args: [BigInt(keystone), btcTxid, vout],
    account,
    chain: wallet.chain,
  });
  const receipt = await pollTransactionReceipt(client, hash, { timeoutMs: options.timeoutMs });
  if (receipt.status !== "success") throw new Error(`record transaction ${hash} reverted`);
  const created = publicationEvents(receipt.logs, contract).some((e) => e.keystone === BigInt(keystone) && sameOutput(e, { btcTxid, vout }));
  const change = bestChangedEvents(receipt.logs, contract).find((e) => e.keystone === BigInt(keystone) && sameOutput(e, { btcTxid, vout }));
  const best = change !== undefined || check.best;
  const file = await publicationFileFor(client, chainId, contract, keystone, btcTxid, vout, receipt);
  const previousBest = change && change.previousTxid !== ZERO32 ? { btcTxid: change.previousTxid, vout: change.previousVout } : undefined;
  return { file, created, best, sentTxHash: hash, ...(previousBest ? { previousBest } : {}), check };
}

// ---------------------------------------------------------------------------------------------
// The canonical keystone (bfgd's exact-match rule, off chain)
// ---------------------------------------------------------------------------------------------

export interface ExactMatch {
  /** true: all 76 bytes equal the keystone rebuilt from Hemi RPC; false: they differ; null: could not rebuild. */
  exact: boolean | null;
  detail: string;
}

/** A cache for canonical abrevs (the receipts SDK's), shared by the calls that pass it. */
export type CanonicalCache = AbrevCache;

/** A PoP output and how it compares with the canonical keystone. */
export interface MatchedOutput {
  out: { vout: number; abrev: Hex };
  match: ExactMatch;
}

/**
 * A transaction's PoP outputs for K, each compared with the canonical keystone (rebuilt once for all), in this order:
 * exact matches, then those not checked (the canonical keystone cannot be rebuilt), then inexact ones; by vout within
 * each. The first is the one to use: a lower inexact output must not hide a canonical one (pre-mainnet audit L-5).
 */
export async function rankByExactMatch(
  client: PublicClient,
  keystone: number,
  outs: readonly { vout: number; abrev: Hex }[],
  cache: CanonicalCache = new Map(),
): Promise<MatchedOutput[]> {
  const matched: MatchedOutput[] = [];
  for (const out of outs) matched.push({ out, match: await exactMatch(client, keystone, out.abrev, cache) });
  const rank = (m: MatchedOutput) => (m.match.exact === true ? 0 : m.match.exact === null ? 1 : 2);
  return matched.sort((a, b) => rank(a) - rank(b) || a.out.vout - b.out.vout);
}

/**
 * The outputs of `btcTxid` that `hbf finality record` may offer for keystone K. With `vout`, that one, if 0x42 lists
 * it as a PoP output for K; without, every PoP output for K. `ranked` is each compared with the canonical keystone
 * (rankByExactMatch: exact matches first); `usable` leaves out the inexact ones unless `allowInexact` (L-5).
 */
export async function recordCandidates(
  client: PublicClient,
  keystone: number,
  btcTxid: Hex,
  options: { vout?: number; allowInexact?: boolean; cache?: CanonicalCache } = {},
): Promise<{ ranked: MatchedOutput[]; usable: MatchedOutput[] }> {
  const outs = await popOutputs(client, btcTxid, keystone);
  const chosen = options.vout === undefined ? outs : outs.filter((o) => o.vout === options.vout);
  const ranked = await rankByExactMatch(client, keystone, chosen, options.cache);
  return { ranked, usable: options.allowInexact ? ranked : ranked.filter((m) => m.match.exact !== false) };
}

/**
 * Compares an abbreviated keystone with the canonical one rebuilt from Hemi RPC (receipts `keystoneAbrev`: blocks K
 * and K − 25, two calls). The contract checks only K and the block hash prefix; this is the rest of bfgd's rule,
 * off chain, and what makes `isBtcFinalVia` Hemi PoP finality.
 */
export async function exactMatch(client: PublicClient, keystone: number, abrev: Hex, cache?: CanonicalCache): Promise<ExactMatch> {
  try {
    const canon = await keystoneAbrev(client, keystone, cache ? { cache } : {});
    if (lower(canon.abrev) === lower(abrev)) return { exact: true, detail: "all 76 bytes equal the keystone rebuilt from Hemi RPC" };
    const a = parseAbrev(abrev);
    const b = parseAbrev(canon.abrev);
    const differ = (Object.keys(a) as (keyof ParsedAbrev)[]).filter((k) => String(a[k]).toLowerCase() !== String(b[k]).toLowerCase());
    return { exact: false, detail: `differs from the keystone rebuilt from Hemi RPC in: ${differ.join(", ")}` };
  } catch (error) {
    if (error instanceof KeystoneError) return { exact: null, detail: `cannot rebuild the canonical keystone: ${error.message}` };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Verify (reads only: RPC + contract address)
// ---------------------------------------------------------------------------------------------

export const INVALID_CODES = [
  "malformed-file",
  "wrong-chain",
  "wrong-contract",
  "changed-value",
  "id-mismatch",
  "no-code",
  "not-a-finality-contract",
  "not-recorded",
  "not-canonical",
  "tx-not-found",
  "tx-failed",
  "tx-wrong-block",
  "no-event",
  "event-mismatch",
] as const;
export type InvalidCode = (typeof INVALID_CODES)[number];

export const INVALID_PHRASE: Record<InvalidCode, string> = {
  "malformed-file": "malformed fact file",
  "wrong-chain": "wrong chain",
  "wrong-contract": "wrong contract",
  "changed-value": "changed value",
  "id-mismatch": "id does not recompute",
  "no-code": "no contract code",
  "not-a-finality-contract": "not a PopFinality contract",
  "not-recorded": "not recorded",
  "not-canonical": "recording block is not canonical",
  "tx-not-found": "recording transaction does not exist",
  "tx-failed": "recording transaction failed",
  "tx-wrong-block": "recording transaction is in another block",
  "no-event": "no matching event",
  "event-mismatch": "event does not match",
};

export interface VerifyExtras {
  stage: HemiStage;
  /** It is K's best publication now. */
  best: boolean;
  /** btcConfirmationsVia / isBtcFinalVia of block K through this publication, now. */
  now: ConfirmationsResult;
}

export type VerifyResult = ({ valid: true; file: PublicationFactFile } & VerifyExtras) | { valid: false; code: InvalidCode; reason: string; file?: PublicationFactFile };

class Invalid extends Error {
  constructor(
    readonly code: InvalidCode,
    detail: string,
  ) {
    super(`${INVALID_PHRASE[code]}: ${detail}`);
  }
}

const show = (v: unknown): string => (typeof v === "bigint" ? v.toString() : String(v));

function compare(pairs: [string, unknown, unknown][], code: InvalidCode, side: [string, string], label = ""): void {
  for (const [name, a, b] of pairs) {
    const x = typeof a === "string" ? a.toLowerCase() : a;
    const y = typeof b === "string" ? b.toLowerCase() : b;
    if (x !== y) throw new Invalid(code, `${label}${name} is ${show(a)} ${side[0]} but ${show(b)} ${side[1]}`);
  }
}

/** Code at the contract, and the stored publication (K, txid, vout) or K's best (`which` undefined). */
async function readStoredOrInvalid(
  client: PublicClient,
  contract: Address,
  keystone: number,
  which: { btcTxid: Hex; vout: number } | undefined,
  options: VerifyOptions,
): Promise<StoredPublication> {
  const code = await client.getCode({ address: contract });
  if (!code || code === "0x") throw new Invalid("no-code", `there is no contract at ${contract}`);
  if (!options.allowOtherCode && !sameCode(code, POP_FINALITY_RUNTIMES)) {
    throw new Invalid("not-a-finality-contract", `the code at ${contract} is not this SDK's PopFinality (${OTHER_CODE})`);
  }
  let stored: StoredPublication | null;
  try {
    stored = which ? await readPublication(client, contract, keystone, which.btcTxid, which.vout) : await readBestPublication(client, contract, keystone);
  } catch (error) {
    const notOurs =
      error instanceof BaseError &&
      error.walk(
        (e) =>
          e instanceof Error &&
          (e.name === "ContractFunctionRevertedError" || e.name === "ContractFunctionZeroDataError" || e.name.startsWith("AbiDecoding")),
      ) !== null;
    if (notOurs) throw new Invalid("not-a-finality-contract", `${contract} does not answer publicationOf/bestPublicationOf`);
    throw error;
  }
  if (!stored) {
    throw new Invalid(
      "not-recorded",
      which ? `publication ${which.btcTxid}:${which.vout} of keystone ${keystone} is not stored at ${contract}` : `no publication of keystone ${keystone} is stored at ${contract}`,
    );
  }
  return stored;
}

async function receiptOrInvalid(client: PublicClient, txHash: Hex): Promise<TransactionReceipt> {
  try {
    return await client.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    if (error instanceof BaseError && error.name === "TransactionReceiptNotFoundError") {
      throw new Invalid("tx-not-found", `no transaction ${txHash} on this chain`);
    }
    throw error;
  }
}

/** The canonical-block, receipt and event steps, given what the recording should be. */
async function checkRecording(
  client: PublicClient,
  contract: Address,
  keystone: number,
  stored: StoredPublication,
  recording: Recording,
  fileAbrev: Hex | undefined,
): Promise<HemiStage> {
  const id = idOfStored(keystone, stored);
  const block = await client.getBlock({ blockNumber: recording.blockNumber }).catch(() => null);
  if (!block) throw new Invalid("not-canonical", `this chain has no block ${recording.blockNumber}`);
  if (lower(block.hash ?? "0x") !== lower(recording.blockHash)) {
    throw new Invalid("not-canonical", `block ${recording.blockNumber} is now ${block.hash}, the publication was recorded in ${recording.blockHash}`);
  }
  const receipt = await receiptOrInvalid(client, recording.txHash);
  if (receipt.status !== "success") throw new Invalid("tx-failed", `${recording.txHash} reverted`);
  // The transaction may have been sent to another contract that called this one (a Safe, a smart account, a multicall,
  // or someone recording the same fact first): only the event `contract` itself emitted counts (pre-mainnet audit M-1).
  if (receipt.blockNumber !== recording.blockNumber || lower(receipt.blockHash) !== lower(recording.blockHash)) {
    throw new Invalid("tx-wrong-block", `${recording.txHash} is in block ${receipt.blockNumber} (${receipt.blockHash}), not ${recording.blockNumber} (${recording.blockHash})`);
  }
  const event = publicationEvents(receipt.logs, contract, id)[0];
  if (!event) throw new Invalid("no-event", `${recording.txHash} emitted no PublicationRecorded event for ${id}`);
  compare(
    [
      ["id", id, event.id],
      ["keystone", BigInt(keystone), event.keystone],
      ["btcTxid", stored.btcTxid, event.btcTxid],
      ["vout", stored.vout, event.vout],
      ["confirmations", stored.confirmations, event.confirmations],
      ["btcHeight", stored.btcHeight, event.btcHeight],
      ["btcBlockHash", stored.btcBlockHash, event.btcBlockHash],
      ["hemiBlock", stored.hemiBlock, event.hemiBlock],
      ["abrev keystone", keystone, (event.abrev.length - 2) / 2 === ABREV_BYTES ? parseAbrev(event.abrev).l2 : -1],
    ],
    "event-mismatch",
    ["on chain", "in the event"],
    "event ",
  );
  if (fileAbrev !== undefined && lower(fileAbrev) !== lower(event.abrev)) {
    throw new Invalid("changed-value", `fact.abrev is ${fileAbrev} in the file but ${event.abrev} in the event`);
  }
  return hemiStage(client, recording.blockNumber);
}

/** The stored checkpoint of K must exist and equal the abrev's block hash prefix. */
async function checkCheckpointAgainst(client: PublicClient, contract: Address, keystone: number, abrev: Hex): Promise<void> {
  const cp = await readCheckpoint(client, contract, keystone);
  const prefix = parseAbrev(abrev).blockHashPrefix;
  if (!cp) throw new Invalid("changed-value", `keystone ${keystone} has no checkpoint at ${contract}, so no publication of it can be stored`);
  if (lower(cp.blockHashPrefix) !== lower(prefix)) {
    throw new Invalid("changed-value", `the checkpoint of keystone ${keystone} is ${cp.blockHashPrefix} on chain but the abrev's block hash prefix is ${prefix}`);
  }
}

function invalid(error: unknown, file?: PublicationFactFile): VerifyResult {
  if (error instanceof Invalid) return { valid: false, code: error.code, reason: error.message, ...(file ? { file } : {}) };
  throw error;
}

async function extras(client: PublicClient, contract: Address, keystone: number, stored: StoredPublication, stage: HemiStage): Promise<VerifyExtras> {
  const best = await readBestPublication(client, contract, keystone);
  return {
    stage,
    best: sameOutput(best, stored),
    now: await btcConfirmationsVia(client, contract, BigInt(keystone), keystone, stored.btcTxid, stored.vout),
  };
}

/**
 * Verifies a `publication` fact file (its parsed JSON) against `contract` on the chain `client` serves, in the
 * order docs/SCHEMA.md gives: against the file's own stored publication (K, txid, vout), never against K's best.
 */
export async function verifyPublicationFile(client: PublicClient, contract: Address, input: unknown, options: VerifyOptions = {}): Promise<VerifyResult> {
  const parsed = parsePublicationFile(input);
  if (!parsed.ok) return { valid: false, code: "malformed-file", reason: `${INVALID_PHRASE["malformed-file"]}: ${parsed.errors.join("; ")}` };
  const file = parsed.file;
  const k = file.fact.keystone;
  try {
    const chainId = await client.getChainId();
    if (file.chainId !== chainId) throw new Invalid("wrong-chain", `the file is for chain ${file.chainId}, the RPC serves chain ${chainId}`);
    if (lower(file.contract) !== lower(contract)) throw new Invalid("wrong-contract", `the file names ${file.contract}, verifying against ${lower(contract)}`);
    const a = parseAbrev(file.fact.abrev);
    if (a.version !== 1) throw new Invalid("changed-value", `fact.abrev has version ${a.version}, not 1`);
    if (a.l2 !== k) throw new Invalid("changed-value", `fact.abrev carries keystone ${a.l2}, fact.keystone says ${k}`);
    const recomputed = idOfPublicationFile(file);
    if (lower(recomputed) !== lower(file.id)) throw new Invalid("id-mismatch", `the file's fields give ${recomputed}, the file says ${file.id}`);

    const stored = await readStoredOrInvalid(client, contract, k, { btcTxid: file.fact.btcTxid, vout: file.fact.vout }, options);
    compare(
      [
        ["fact.confirmations", file.fact.confirmations, stored.confirmations],
        ["asOf.btcHeight", file.asOf.btcHeight, stored.btcHeight],
        ["asOf.btcBlockHash", file.asOf.btcBlockHash, stored.btcBlockHash],
        ["recording.blockNumber", file.recording.blockNumber, stored.hemiBlock],
      ],
      "changed-value",
      ["in the file", "on chain"],
    );
    const storedId = idOfStored(k, stored);
    if (lower(storedId) !== lower(file.id)) throw new Invalid("id-mismatch", `the stored publication gives ${storedId}`);
    await checkCheckpointAgainst(client, contract, k, file.fact.abrev);
    const stage = await checkRecording(client, contract, k, stored, file.recording, file.fact.abrev);
    return { valid: true, file, ...(await extras(client, contract, k, stored, stage)) };
  } catch (error) {
    return invalid(error, file);
  }
}

/**
 * Verifies a stored publication of keystone K, (txid, vout) if given, else K's best: the same checks, with the
 * recording found by one getLogs.
 */
export async function verifyPublicationKeystone(
  client: PublicClient,
  contract: Address,
  keystone: number,
  which?: { btcTxid: Hex; vout: number },
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  try {
    if (!isKeystone(keystone)) throw new Invalid("not-recorded", `${keystone} is not a keystone`);
    const chainId = await client.getChainId();
    const stored = await readStoredOrInvalid(client, contract, keystone, which, options);
    const located = await locatePublication(client, contract, keystone, stored);
    if (!located) throw new Invalid("no-event", `no PublicationRecorded event for ${stored.btcTxid}:${stored.vout} in Hemi block ${stored.hemiBlock}`);
    await checkCheckpointAgainst(client, contract, keystone, located.event.abrev);
    const stage = await checkRecording(client, contract, keystone, stored, located.recording, undefined);
    return { valid: true, file: fileFromPublication(chainId, contract, keystone, located), ...(await extras(client, contract, keystone, stored, stage)) };
  } catch (error) {
    return invalid(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Status: anchored (K's best) and Hemi PoP finality (an exact-matched publication), beside the receipts reader
// ---------------------------------------------------------------------------------------------

export interface ExactPath {
  keystone: number;
  btcTxid: Hex;
  vout: number;
  /** Where the publication came from: named by the caller, found by the receipts reader, or K's best. */
  source: "given" | "reader" | "best";
  match: ExactMatch;
  /** btcConfirmationsVia / isBtcFinalVia for the block through this publication. */
  contract: ConfirmationsResult;
}

export interface FinalityStatus {
  block: bigint;
  coveringKeystone: number;
  /** The keystone the anchored reading used. */
  keystone: number;
  /** ANCHORED (K's best publication), not Hemi PoP finality: anchorConfirmations / isBtcAnchored. */
  anchored: ConfirmationsResult;
  best: StoredPublication | null;
  /** Hemi PoP finality: the exact-matched publication's isBtcFinalVia; null if none was found. */
  exact: ExactPath | null;
  /** The receipts SDK's PoP finality reader for the same block (Esplora and Hemi RPC), unless skipped. */
  reader?: BtcFinality;
  readerFinal?: boolean;
  /** exact.contract.final === readerFinal; null when the reader has no source on this chain or was skipped. */
  agree: boolean | null;
  /** Shown Hemi-PoP-final (`shownHemiPopFinal`): an exact path whose publication was checked to match all 76 bytes of
   * the canonical keystone, and isBtcFinalVia true through it. An unchecked match is never final. */
  final: boolean;
  notes: string[];
}

/**
 * Whether a status shows Hemi PoP finality: a publication checked to equal the canonical keystone in all 76 bytes
 * (`match.exact === true`), and isBtcFinalVia true through it. "Not checked" (`null`: the canonical keystone could not
 * be rebuilt, or 0x42 gave nothing to compare) is never final, because without the check a one-fee forged keystone
 * reads the same (independent audit, finding 6).
 */
export function shownHemiPopFinal(exact: ExactPath | null): boolean {
  return exact !== null && exact.match.exact === true && exact.contract.final;
}

/**
 * A block's Bitcoin finality through PopFinality two ways, and the receipts SDK reader's for comparison:
 *  - anchored: anchorConfirmations / isBtcAnchored through keystone K (default: the covering keystone, or the first later
 *    keystone among the next `search` with a publication), which read K's best publication and are forgeable;
 *  - exact: btcConfirmationsVia / isBtcFinalVia through one publication whose 76 bytes match the canonical keystone:
 *    the one named in `exact`, else the one the receipts reader found (it matches all 76 bytes), else K's best when it
 *    matches. Only this one is Hemi PoP finality.
 */
export async function finalityStatus(
  client: PublicClient,
  contract: Address,
  block: bigint,
  options: {
    keystone?: number;
    search?: number;
    reader?: FinalityReader | null;
    chainId?: number;
    call?: CallOptions;
    exact?: { keystone: number; btcTxid: Hex; vout?: number };
    /** Canonical keystones already rebuilt (shared across calls; the receipts SDK's cache). */
    canonical?: CanonicalCache;
  } = {},
): Promise<FinalityStatus> {
  const cover = Number(coveringKeystone(block));
  const notes: string[] = [];
  const call = options.call ?? {};
  let k = options.keystone ?? cover;
  let best = isKeystone(k) ? await readBestPublication(client, contract, k, call) : null;
  // cover is 0 only above the largest keystone, where no keystone covers the block.
  if (options.keystone === undefined && !best && cover !== 0) {
    for (let i = 1; i <= (options.search ?? 0); i++) {
      const next = cover + i * KEYSTONE_PERIOD;
      const s = await readBestPublication(client, contract, next, call);
      if (s) {
        notes.push(`covering keystone ${cover} has no publication recorded; the anchored reading uses keystone ${next}, the first later one that has`);
        k = next;
        best = s;
        break;
      }
    }
  }
  const anchored = await anchorConfirmations(client, contract, block, k, call);
  const status: FinalityStatus = { block, coveringKeystone: cover, keystone: k, anchored, best, exact: null, agree: null, final: false, notes };

  // The receipts reader, unless skipped.
  if (options.reader !== null) {
    const chainId = options.chainId ?? (await client.getChainId());
    const reader = options.reader ?? defaultFinalityReader(chainId);
    const b = await client.getBlock({ blockNumber: block });
    status.reader = await reader.read({ client, blockNumber: block, blockHash: b.hash!, blockTimestamp: Number(b.timestamp) });
    if (status.reader.source === "unavailable" && status.reader.popLive === undefined) {
      notes.push(`the receipts SDK reader has no Bitcoin source on chain ${chainId}: ${status.reader.detail ?? ""}`.trim());
    } else {
      const verified = status.reader.source === "bitcoin" || status.reader.source === "bfg";
      status.readerFinal = verified && (status.reader.btcConfirmations ?? 0) >= BTC_FINAL_CONFIRMATIONS;
      if (!verified) notes.push(`the reader found no verified publication (${status.reader.source}), so it does not show the block final`);
    }
  }

  // The exact-matched publication.
  let candidate: { keystone: number; btcTxid: Hex; vout?: number; source: ExactPath["source"] } | undefined;
  if (options.exact) candidate = { ...options.exact, source: "given" };
  else if (status.reader?.popTxid && status.reader.viaKeystone !== undefined && (status.reader.source === "bitcoin" || status.reader.source === "bfg")) {
    candidate = { keystone: status.reader.viaKeystone, btcTxid: lower(`0x${status.reader.popTxid.replace(/^0x/, "")}` as Hex), source: "reader" };
  } else if (best) candidate = { keystone: k, btcTxid: best.btcTxid, vout: best.vout, source: "best" };
  if (candidate) {
    const outs = await popOutputs(client, candidate.btcTxid, candidate.keystone);
    // Without a vout (the receipts reader gives none), the exact-matching output if there is one (L-5).
    let picked: MatchedOutput | undefined;
    if (candidate.vout === undefined) picked = (await rankByExactMatch(client, candidate.keystone, outs, options.canonical))[0];
    else {
      const out = outs.find((o) => o.vout === candidate.vout);
      if (out) picked = { out, match: await exactMatch(client, candidate.keystone, out.abrev, options.canonical) };
    }
    const vout = candidate.vout ?? picked?.out.vout;
    if (vout === undefined) {
      notes.push(`0x42 lists no PoP output for keystone ${candidate.keystone} in ${candidate.btcTxid}`);
    } else {
      const match: ExactMatch = picked?.match ?? { exact: null, detail: "0x42 gave no PoP output to compare" };
      if (candidate.source === "best" && match.exact !== true) {
        notes.push(`K's best publication ${candidate.btcTxid}:${vout} is not shown to be an exact match (${match.detail}); no Hemi PoP finality reading`);
      } else {
        const via = await btcConfirmationsVia(client, contract, block, candidate.keystone, candidate.btcTxid, vout, call);
        status.exact = { keystone: candidate.keystone, btcTxid: candidate.btcTxid, vout, source: candidate.source, match, contract: via };
        if (match.exact === false) notes.push(`the publication named is NOT an exact match: ${match.detail}; isBtcFinalVia on it is not Hemi PoP finality`);
      }
    }
  }
  if (status.exact && status.exact.match.exact === null) {
    notes.push(
      `the exact match was not checked (${status.exact.match.detail}), so this is not shown to be Hemi PoP finality: final is false whatever isBtcFinalVia says`,
    );
  }
  status.final = shownHemiPopFinal(status.exact);
  // agree compares the reader with a checked exact path only; an unchecked one is not a Hemi PoP reading (audit-fixes review R-7).
  if (status.readerFinal !== undefined && status.exact && status.exact.match.exact === true) {
    status.agree = status.readerFinal === status.exact.contract.final;
  } else if (status.readerFinal !== undefined && status.exact) status.agree = null;
  else if (status.readerFinal !== undefined) status.agree = status.readerFinal === false;
  return status;
}

// ---------------------------------------------------------------------------------------------
// Finding PoP transactions through Esplora: a hint only. The contract decides.
// ---------------------------------------------------------------------------------------------

export interface PopHint {
  btcTxid: Hex;
  vout: number;
  keystone: number;
  abrev: Hex;
  /** null while unconfirmed. */
  height: number | null;
  blockHash: string | null;
}

/** Esplora with mempool.space first and blockstream.info second, paced at one request a second. */
export function esploraClient(baseUrls: string[], options: { requestsPerSecond?: number; fetch?: typeof fetch } = {}): EsploraClient {
  return new EsploraClient({ baseUrls, requestsPerSecond: options.requestsPerSecond ?? 1, burst: 2, timeoutMs: 30_000, ...(options.fetch ? { fetch: options.fetch } : {}) });
}

const MAGIC = toBytes(POP_SCRIPT_PREFIX);

/** Every PoP output in a raw Bitcoin block: txid (display order), vout, keystone and abrev. */
export function popsInRawBlock(raw: Uint8Array): Omit<PopHint, "height" | "blockHash">[] {
  const out: Omit<PopHint, "height" | "blockHash">[] = [];
  for (const tx of transactionsContaining(raw, findAll(raw, MAGIC))) {
    tx.outputs.forEach((script, vout) => {
      const pop = decodePopOpReturn(script);
      if (pop) out.push({ btcTxid: lower(tx.txid), vout, keystone: pop.l2, abrev: lower(pop.abrev) });
    });
  }
  return out;
}

/** One Bitcoin block's PoP outputs (one /block-height and one /block/{hash}/raw request). */
export async function scanBitcoinBlock(esplora: EsploraClient, height: number): Promise<{ height: number; hash: string; pops: PopHint[] }> {
  const hash = await esplora.blockHashAtHeight(height);
  const raw = await esplora.rawBlock(hash);
  return { height, hash, pops: popsInRawBlock(raw).map((p) => ({ ...p, height, blockHash: hash })) };
}

/**
 * PoP outputs in a miner address's history, newest page first, until the newest confirmed keystone on a page is
 * below `minKeystone` (the receipts reader's rule: a forged low keystone must not end the search early).
 */
export async function minerPops(esplora: EsploraClient, address: string, minKeystone: number, maxPages = 10): Promise<PopHint[]> {
  const out: PopHint[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const txs = await esplora.addressTxs(address, after);
    if (txs.length === 0) break;
    let newest = -1;
    for (const tx of txs) {
      tx.vout.forEach((v, vout) => {
        const pop = decodePopOpReturn(v.scriptpubkey);
        if (!pop) return;
        if (tx.status.confirmed) newest = Math.max(newest, pop.l2);
        out.push({
          btcTxid: lower(`0x${tx.txid}` as Hex),
          vout,
          keystone: pop.l2,
          abrev: lower(pop.abrev),
          height: tx.status.confirmed ? (tx.status.block_height ?? null) : null,
          blockHash: tx.status.block_hash?.toLowerCase() ?? null,
        });
      });
    }
    const confirmed = txs.filter((t) => t.status.confirmed);
    if (confirmed.length === 0 || (newest >= 0 && newest < minKeystone)) break;
    after = confirmed[confirmed.length - 1]!.txid;
  }
  return out;
}

/** The lowest Bitcoin height whose block time is at or after `target` (approximately: block times are not monotonic). */
export async function firstHeightAtOrAfter(esplora: EsploraClient, target: number, tip: number): Promise<number> {
  const asc = (page: EsploraBlock[]) => [...page].sort((a, b) => a.height - b.height);
  const top = asc(await esplora.blocks(tip));
  const newest = top[top.length - 1];
  if (!newest || newest.timestamp < target) return tip + 1;
  let h = Math.max(0, tip - Math.ceil((newest.timestamp - target) / 600) - 5);
  for (let i = 0; i < 24; i++) {
    const page = asc(await esplora.blocks(Math.min(tip, h + 9)));
    if (page.length === 0) return h;
    if (page[0]!.timestamp >= target) {
      if (page[0]!.height === 0) return 0;
      h = Math.max(0, page[0]!.height - 10);
      continue;
    }
    const first = page.find((b) => b.timestamp >= target);
    if (first) return first.height;
    h = page[page.length - 1]!.height + 1;
    if (h > tip) return tip + 1;
  }
  return h;
}

export interface FindOptions {
  /** Miner addresses to read first (default on mainnet: the receipts SDK's known PoP miner). */
  miners?: string[];
  /** Raw Bitcoin blocks to scan from the keystone's time minus ten minutes (default 18, three hours). */
  scanBlocks?: number;
  log?: (line: string) => void;
}

/**
 * Candidate PoP outputs for keystone K, confirmed ones first (lowest height first). Candidates must carry K and
 * block K's hash prefix; when the canonical keystone can be rebuilt from Hemi RPC, all 76 bytes must equal it, so a
 * forged "HEMI" OP_RETURN is never offered. The contract still decides.
 */
export async function findPopHints(client: PublicClient, esplora: EsploraClient, keystone: number, options: FindOptions = {}): Promise<PopHint[]> {
  const log = options.log ?? (() => {});
  const block = await client.getBlock({ blockNumber: BigInt(keystone) });
  const prefix = lower(block.hash!).slice(0, 26);
  let canonical: Hex | undefined;
  try {
    canonical = lower((await keystoneAbrev(client, keystone)).abrev);
  } catch (error) {
    if (!(error instanceof KeystoneError)) throw error;
    log(`note: cannot rebuild keystone ${keystone} from Hemi RPC (${error.message}); matching K and the block hash prefix only`);
  }
  const ok = (h: PopHint) =>
    h.keystone === keystone && (canonical ? h.abrev === canonical : `0x${h.abrev.slice(2 + 128, 2 + 152)}` === prefix);
  const seen = new Set<string>();
  const found: PopHint[] = [];
  const add = (hs: PopHint[]) => {
    for (const h of hs) {
      const key = `${h.btcTxid}:${h.vout}`;
      if (!ok(h) || seen.has(key)) continue;
      seen.add(key);
      found.push(h);
    }
  };
  for (const m of options.miners ?? []) {
    log(`looking for keystone ${keystone} in miner ${m}'s transactions`);
    add(await minerPops(esplora, m, keystone));
  }
  const scan = options.scanBlocks ?? 18;
  if (!found.some((h) => h.height !== null) && scan > 0) {
    const tip = await esplora.tipHeight();
    const start = await firstHeightAtOrAfter(esplora, Number(block.timestamp) - 600, tip);
    const end = Math.min(tip, start + scan - 1);
    if (start <= end) log(`scanning Bitcoin blocks ${start}..${end} for keystone ${keystone}`);
    for (let h = start; h <= end && !found.some((x) => x.height !== null); h++) add((await scanBitcoinBlock(esplora, h)).pops);
  }
  return found.sort((a, b) => (a.height ?? Number.MAX_SAFE_INTEGER) - (b.height ?? Number.MAX_SAFE_INTEGER));
}

/** The default miners for a chain: the receipts SDK's known mainnet PoP miner on Hemi mainnet, none elsewhere. */
export function defaultMiners(chainId: number): string[] {
  return chainId === HEMI_MAINNET_CHAIN_ID ? [...KNOWN_POP_MINERS_MAINNET] : [];
}

// ---------------------------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------------------------

export interface WatchOptions {
  client: PublicClient;
  contract: Address;
  chainId: number;
  /** Sends transactions when given; without it the loop only reports what it would send. */
  send?: { wallet: WalletClient; account: Account };
  esplora?: EsploraClient;
  /** Start with this keystone (default: the newest one already produced). */
  fromKeystone?: number;
  /** Bitcoin blocks to scan back at start (default 3). */
  backfillBlocks?: number;
  /** Confirmations before a found PoP transaction is offered to the contract (default 3: hVM can see it by then). */
  minConfirmations?: number;
  /** Raw blocks scanned per iteration at most (default 6), so a long pause does not turn into a burst. */
  maxScanPerIteration?: number;
  /** Seconds between iterations (default 60). */
  intervalSeconds?: number;
  /** Stop after this many iterations (default: run until `signal` aborts). */
  iterations?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** What `watch` did. The lists keep their newest WATCH_LIST_LIMIT entries; `totals` and the other counts are totals. */
export interface WatchStats {
  iterations: number;
  checkpointed: number[];
  recorded: { keystone: number; btcTxid: Hex; vout: number }[];
  wouldSend: string[];
  /** How many of each the run did in all (the lists above are capped). */
  totals: { checkpointed: number; recorded: number; wouldSend: number };
  scannedBlocks: number;
  /** PoP outputs left out because their 76 bytes differ from the canonical keystone. */
  skippedInexact: number;
  /** Times an output hVM could not read yet was kept for a later iteration. */
  retried: number;
  /** Bitcoin blocks scanned again because a reorg replaced them. */
  rescannedBlocks: number;
  /** Passes a failed request ended early (the watch carried on). */
  errors: number;
}

/**
 * The watch loop. Each iteration:
 *  1. every keystone cut since the last iteration is checkpointed (checkCheckpoint by eth_call first; one already
 *     stored or out of the window is skipped);
 *  2. with Esplora, each new Bitcoin block is scanned once for PoP outputs (and scanned again if a reorg replaced it,
 *     up to WATCH_REORG_DEPTH back), and every one with at least `minConfirmations` whose keystone is still trackable
 *     is offered to `checkPublication` by eth_call, and recorded when the contract would store it. A verdict hVM can
 *     outgrow (TRANSIENT_VERDICTS: it has not indexed the block yet), or a keystone the Hemi RPC has not served yet, is
 *     retried on later iterations until the output has `max(minConfirmations + 12, 20)` confirmations, then
 *     forgotten (a block that carries it again offers it again); any other verdict drops it for good.
 * A request that fails ends that iteration only (counted in `errors`); state is kept for the next.
 * Hemi requests go through the caller's rate-limited client; Esplora through a paced client.
 */
export async function watch(o: WatchOptions): Promise<WatchStats> {
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minConf = o.minConfirmations ?? HVM_VISIBLE_CONFIRMATIONS;
  const maxScan = o.maxScanPerIteration ?? 6;
  const stats: WatchStats = {
    iterations: 0,
    checkpointed: [],
    recorded: [],
    wouldSend: [],
    totals: { checkpointed: 0, recorded: 0, wouldSend: 0 },
    scannedBlocks: 0,
    skippedInexact: 0,
    retried: 0,
    rescannedBlocks: 0,
    errors: 0,
  };
  const retryUntil = Math.max(minConf + WATCH_RETRY_EXTRA_CONFIRMATIONS, WATCH_MIN_RETRY_CONFIRMATIONS);
  let nextKeystone: number | undefined = o.fromKeystone;
  let lastScanned: number | undefined;
  /** PoP outputs found but not yet confirmed enough, or not yet stored. */
  const waiting = new Map<string, PopHint>();
  /** Outputs dealt with (Ok, or a verdict that cannot change), oldest forgotten first. */
  const done = new Set<string>();
  /** Per waiting output: retries so far (the first is logged), and failures in a row with the pass to try it next. */
  const retries = new Map<string, number>();
  const failures = new Map<string, { n: number; next: number }>();
  const forget = (key: string) => {
    waiting.delete(key);
    retries.delete(key);
    failures.delete(key);
  };
  const finish = (key: string) => {
    forget(key);
    remember(done, key, WATCH_DONE_LIMIT);
  };
  /**
   * Retried for the whole window without hVM reading it: forgotten, not finished, so a block that carries the
   * transaction again later (a reorg re-mining it) offers it again (pre-mainnet review R-3).
   */
  const giveUp = (key: string) => forget(key);
  /** Checkpoint sends that failed in a row, by keystone, with the pass to try again. */
  const checkpointFailures = new Map<number, { n: number; next: number }>();
  /** The hashes of the newest scanned Bitcoin blocks, by height. */
  const scanned = new Map<number, string>();
  const canonical: CanonicalCache = new Map();
  const note = <K extends keyof WatchStats["totals"]>(kind: K, item: WatchStats[K][number]) => {
    const list = stats[kind] as unknown[];
    list.push(item);
    if (list.length > WATCH_LIST_LIMIT) list.shift();
    stats.totals[kind]++;
  };

  const checkpoints = async (latest: number) => {
    const newest = Math.floor((latest - 1) / KEYSTONE_PERIOD) * KEYSTONE_PERIOD;
    nextKeystone ??= newest;
    if (latest - nextKeystone > HISTORY_SERVE_WINDOW) {
      const skipTo = Math.ceil((latest - HISTORY_SERVE_WINDOW) / KEYSTONE_PERIOD) * KEYSTONE_PERIOD;
      log(`keystones ${nextKeystone}..${skipTo - KEYSTONE_PERIOD} are outside the 8,191-block window; starting at ${skipTo}`);
      nextKeystone = skipTo;
    }
    for (; nextKeystone <= newest; nextKeystone += KEYSTONE_PERIOD) {
      if (nextKeystone <= 0) continue;
      // A keystone whose checkpoint failed waits for its backoff; the loop stays on it, so once sends work again the
      // keystones are checkpointed in order. It is left behind only when it leaves the block-hash window (P-2).
      const wait = checkpointFailures.get(nextKeystone);
      if (wait && wait.next > stats.iterations) return;
      const c = await checkCheckpoint(o.client, o.contract, nextKeystone);
      if (c.verdict !== "Ok") {
        checkpointFailures.delete(nextKeystone);
        log(`keystone ${nextKeystone}: ${c.verdict} (${VERDICT_MEANING[c.verdict]}); skipped`);
        continue;
      }
      if (c.stored) {
        checkpointFailures.delete(nextKeystone); // a send that timed out may have been mined after all
        log(`keystone ${nextKeystone}: already checkpointed (${c.blockHashPrefix})`);
        continue;
      }
      if (!o.send) {
        note("wouldSend", `checkpoint(${nextKeystone})`);
        log(`keystone ${nextKeystone}: would checkpoint ${c.blockHashPrefix} (no key: nothing sent)`);
        continue;
      }
      let r: CheckpointResult;
      try {
        r = await sendCheckpoint(o.client, o.send.wallet, o.send.account, o.contract, nextKeystone);
      } catch (error) {
        // Not sent again every pass (N-2): after 1, 2, 4, … passes, until it works or the keystone leaves the window.
        const n = (wait?.n ?? 0) + 1;
        checkpointFailures.set(nextKeystone, { n, next: stats.iterations + backoff(n) });
        throw error;
      }
      checkpointFailures.delete(nextKeystone);
      if (r.created) note("checkpointed", nextKeystone);
      log(`keystone ${nextKeystone}: ${r.created ? `checkpointed ${r.blockHashPrefix} in ${r.txHash}` : "already checkpointed"}`);
    }
  };

  const publications = async (esplora: EsploraClient, latest: number) => {
    const tip = await esplora.tipHeight();
    const take = (b: { height: number; hash: string; pops: PopHint[] }) => {
      for (const p of b.pops) {
        // The contract takes a 16-bit vout (and 0x42 lists the first 128 outputs): a later one can never be recorded.
        if (p.vout > 0xffff) {
          log(`Bitcoin block ${b.height}: PoP output ${p.btcTxid}:${p.vout} is past vout 65,535; ignored`);
          continue;
        }
        const key = `${p.keystone}:${p.btcTxid}:${p.vout}`;
        if (!done.has(key)) waiting.set(key, p);
      }
      if (b.pops.length) log(`Bitcoin block ${b.height}: ${b.pops.length} PoP output${b.pops.length === 1 ? "" : "s"} (keystones ${[...new Set(b.pops.map((x) => x.keystone))].join(", ")})`);
      scanned.set(b.height, b.hash.toLowerCase());
      for (const h of scanned.keys()) if (h <= b.height - WATCH_REORG_DEPTH) scanned.delete(h);
    };
    // Heights above a tip that went down are gone for now; they are scanned again as the chain grows back.
    if (lastScanned !== undefined && lastScanned > tip) {
      for (let h = tip + 1; h <= lastScanned; h++) scanned.delete(h);
      lastScanned = tip;
    }
    // A reorg: the newest scanned block was replaced. Walk down to the first remembered height that still has the
    // same hash and scan the replacements, so a PoP transaction mined in one is not missed (M-2).
    if (lastScanned !== undefined && scanned.has(lastScanned)) {
      let h = lastScanned;
      const replaced: number[] = [];
      while (scanned.has(h) && (await esplora.blockHashAtHeight(h)).toLowerCase() !== scanned.get(h)) replaced.unshift(h--);
      if (replaced.length) log(`Bitcoin blocks ${replaced[0]}..${replaced.at(-1)} were replaced by a reorg; scanning them again`);
      for (const r of replaced) {
        take(await scanBitcoinBlock(esplora, r));
        stats.rescannedBlocks++;
      }
    }
    lastScanned ??= tip - (o.backfillBlocks ?? 3);
    const end = Math.min(tip, lastScanned + maxScan);
    for (let h = lastScanned + 1; h <= end; h++) {
      take(await scanBitcoinBlock(esplora, h));
      stats.scannedBlocks++;
      lastScanned = h;
    }
    /** One waiting output; a throw is counted against it (N-1). */
    const handle = async (key: string, p: PopHint): Promise<void> => {
      if (p.height === null || tip - p.height + 1 < minConf) return;
      const confirmations = tip - p.height + 1;
      /** A verdict hVM (or the Hemi RPC) can outgrow: kept for a later pass, until the window closes. */
      const retry = (why: string): void => {
        if (confirmations < retryUntil) {
          const n = (retries.get(key) ?? 0) + 1;
          retries.set(key, n);
          // Logged the first time, not every pass (N-3)
          if (n === 1) log(`PoP ${p.btcTxid}:${p.vout} for keystone ${p.keystone}: ${why} at ${confirmations} Bitcoin confirmations; retried next time`);
          stats.retried++;
        } else {
          log(`PoP ${p.btcTxid}:${p.vout} for keystone ${p.keystone}: still ${why} at ${confirmations} Bitcoin confirmations; given up`);
          giveUp(key);
        }
      };
      if (!isKeystone(p.keystone)) {
        finish(key);
        return;
      }
      // The Hemi RPC has not served block K yet (it lags, or a fallback does): the same as hVM lagging (pre-mainnet review R-4).
      // Far past its newest block it is no lag but a forgery: a real PoP of K exists only after block K (N-3).
      if (p.keystone >= latest) {
        if (p.keystone > latest + WATCH_LAG_BLOCKS) {
          log(`PoP ${p.btcTxid}:${p.vout} names keystone ${p.keystone}, far past the Hemi RPC's block ${latest}; not recorded`);
          finish(key);
        } else retry(`keystone beyond the Hemi RPC's block ${latest}`);
        return;
      }
      // Only the exact-match publication is recorded (bfgd's 76-byte rule, off chain); where the canonical keystone
      // cannot be rebuilt (a local chain) the contract alone decides.
      const match = await exactMatch(o.client, p.keystone, p.abrev, canonical);
      while (canonical.size > WATCH_CACHE_LIMIT) canonical.delete(canonical.keys().next().value!);
      if (match.exact === false) {
        log(`PoP ${p.btcTxid}:${p.vout} for keystone ${p.keystone} is not the canonical keystone (${match.detail}); not recorded`);
        stats.skippedInexact++;
        finish(key);
        return;
      }
      const c = await checkPublication(o.client, o.contract, p.keystone, p.btcTxid, p.vout);
      // hVM may not have the transaction's block yet: NotFound and the like are retried, for a while (M-2).
      if (TRANSIENT_VERDICTS.has(c.verdict)) {
        retry(`${c.verdict} (hVM may not see it yet)`);
        return;
      }
      if (c.verdict !== "Ok" || (c.recorded && !c.becomesBest)) {
        if (c.verdict !== "Ok") log(`PoP ${p.btcTxid}:${p.vout} for keystone ${p.keystone}: ${c.verdict}; not recorded`);
        finish(key);
        return;
      }
      if (!o.send) {
        note("wouldSend", `recordPublication(${p.keystone}, ${p.btcTxid}, ${p.vout})`);
        log(`keystone ${p.keystone}: would record ${p.btcTxid}:${p.vout} (${c.confirmations} confirmations; no key: nothing sent)`);
      } else {
        try {
          const r = await sendPublication(o.client, o.send.wallet, o.send.account, o.chainId, o.contract, p.keystone, p.btcTxid, p.vout, { check: c });
          if (r.created) note("recorded", { keystone: p.keystone, btcTxid: p.btcTxid, vout: p.vout });
          log(
            `keystone ${p.keystone}: ${r.created ? "recorded" : "re-submitted"} ${p.btcTxid}:${p.vout} in ${r.sentTxHash ?? "(nothing sent)"}; ${r.best ? "K's best" : "not K's best"}${match.exact ? ", exact match" : ""}`,
          );
        } catch (error) {
          if (!(error instanceof NotRecordableError)) throw error;
          log(`keystone ${p.keystone}: ${error.message}`);
          if (TRANSIENT_VERDICTS.has(error.verdict)) {
            retry(error.verdict);
            return;
          }
        }
      }
      finish(key);
    };
    // A copy: handling an output may finish, forget or move it.
    for (const [key, p] of [...waiting]) {
      const f = failures.get(key);
      if (f && f.next > stats.iterations) continue; // backing off after a failure
      try {
        await handle(key, p);
        failures.delete(key); // failures in a row: one that works clears them
      } catch (error) {
        // An output whose handling throws (a request that fails, a send that reverts or is not mined) must neither
        // stall the ones behind it nor be sent again every pass (N-1, N-2): it goes to the back of the queue, the pass
        // ends, and it waits 1, 2, 4, … passes. It is given up only after WATCH_MAX_FAILURES failures in a row and once
        // past the retry window, as a transient verdict is (P-1): an outage of a few hours only delays it.
        const n = (f?.n ?? 0) + 1;
        const confirmations = p.height === null ? 0 : tip - p.height + 1;
        if (n >= WATCH_MAX_FAILURES && confirmations >= retryUntil) {
          log(`PoP ${p.btcTxid}:${p.vout} for keystone ${p.keystone}: failed ${n} times in a row (${redactUrls(error instanceof Error ? error.message : String(error))}); given up`);
          giveUp(key);
        } else {
          waiting.delete(key);
          waiting.set(key, p);
          failures.set(key, { n, next: stats.iterations + backoff(n) });
        }
        throw error;
      }
    }
  };

  for (;;) {
    if (o.signal?.aborted) break;
    stats.iterations++;
    // A failed request (Hemi or Esplora, after the clients' own retries) ends this pass, not the watch: what was
    // scanned and what waits are kept, and the next pass carries on from there (pre-mainnet review R-5).
    try {
      const latest = Number(await o.client.getBlockNumber({ cacheTime: 0 }));
      await checkpoints(latest);
      if (o.esplora) await publications(o.esplora, latest);
    } catch (error) {
      stats.errors++;
      log(`pass ${stats.iterations} stopped: ${redactUrls(error instanceof Error ? error.message : String(error))}; the next pass carries on`);
    }
    if (o.iterations !== undefined && stats.iterations >= o.iterations) break;
    await sleep((o.intervalSeconds ?? 60) * 1_000);
  }
  return stats;
}
