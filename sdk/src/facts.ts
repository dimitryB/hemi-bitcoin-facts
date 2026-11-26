/**
 * BitcoinFacts from TypeScript: check (eth_call), record (transaction), verify and status (reads only), and
 * fact files exactly as docs/SCHEMA.md defines them.
 *
 * Every chain read takes a viem PublicClient. Pass one from `connect()` in common.ts (the vendored receipts
 * client: fallback RPCs, retry with backoff, at most 4 requests a second). `verify` needs nothing but that
 * client and the contract address: no key, no Esplora, no environment.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  BaseError,
  bytesToHex,
  decodeEventLog,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  getContractAddress,
  hexToBytes,
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
import { Address as BtcAddress, NETWORK, OutScript, TEST_NETWORK } from "@scure/btc-signer";
import { BITCOIN_FACTS_INIT_CODE, BITCOIN_FACTS_RUNTIME, bitcoinFactsAbi } from "./abi/BitcoinFacts.js";
import { HEMI_MAINNET_CHAIN_ID, HEMI_TESTNET_CHAIN_ID, OTHER_CODE, sameCode, UsageError, type VerifyOptions } from "./common.js";
import { pollTransactionReceipt, withRetry } from "./vendor/receipts/client.js";

export { bitcoinFactsAbi, BITCOIN_FACTS_INIT_CODE, BITCOIN_FACTS_RUNTIME };
/**
 * Every BitcoinFacts runtime this SDK accepts in `verify` (pre-mainnet audit I-3): this build's. A later release adds
 * its own and keeps these, so earlier deployments' facts still verify.
 */
export const BITCOIN_FACTS_RUNTIMES: readonly Hex[] = [BITCOIN_FACTS_RUNTIME];

// ---------------------------------------------------------------------------------------------
// Constants: the contract's, mirrored (test/facts.test.ts checks them against the contract)
// ---------------------------------------------------------------------------------------------

export const SCHEMA = "hemi-bitcoin-facts/v1";
export const KIND_OUTPUT: Hex = keccak256(toBytes("hemi-bitcoin-facts/output"));
export const KIND_BALANCE: Hex = keccak256(toBytes("hemi-bitcoin-facts/balance"));
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
/** contracts/script/Deploy.s.sol `Deployments.BITCOIN_FACTS_SALT`. */
export const BITCOIN_FACTS_SALT: Hex = keccak256(toBytes("hemi-bitcoin-facts/BitcoinFacts/v1"));

/** Where Deploy.s.sol puts the compiled BitcoinFacts on any chain with the deterministic deployer. */
export function bitcoinFactsCreate2Address(): Address {
  return getContractAddress({
    from: CREATE2_DEPLOYER,
    salt: BITCOIN_FACTS_SALT,
    bytecode: BITCOIN_FACTS_INIT_CODE,
    opcode: "CREATE2",
  });
}

/** BitcoinFacts.Verdict, in enum order. */
export const VERDICTS = [
  "Ok",
  "NoBitcoinView",
  "NotFound",
  "VoutTooHigh",
  "Unspendable",
  "ScriptTooLong",
  "Inconsistent",
  "NoConfirmations",
  "BadAddress",
  "NoBalance",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_MEANING: Record<Verdict, string> = {
  Ok: "a positive answer: every field holds hVM's answer",
  NoBitcoinView: "0x44 gave no usable Bitcoin header",
  NotFound: "hVM knows no such transaction or output",
  VoutTooHigh: "not in the UTXO set and vout >= 128, past 0x42's window: spent or unspendable, unreadable",
  Unspendable: "the output can never be spent: an OP_RETURN, over 10,000 bytes or unparseable script, or a genesis-block coinbase",
  ScriptTooLong: "not in the UTXO set and the script is over 128 bytes, which 0x42 cuts",
  Inconsistent: "0x42 lists the output as unspent but 0x48 gave no answer",
  NoConfirmations: "0x43 gave no plausible confirmation count",
  BadAddress: "0x46 could not decode the address (or its length is outside 24..200)",
  NoBalance: "0x40 gave no answer for the address",
};

function verdictName(n: number): Verdict {
  const v = VERDICTS[n];
  if (!v) throw new Error(`unknown verdict ${n}`);
  return v;
}

export type FactKind = "output" | "balance";
const KIND_ENUM = ["none", "output", "balance"] as const;

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

/** keccak256(txid ‖ vout as 2 big-endian bytes): 34 bytes hashed. */
export function outputSubject(txid: Hex, vout: number): Hex {
  return keccak256(encodePacked(["bytes32", "uint16"], [txid, vout]));
}

/** keccak256(abi.encode(kind, subject, btcBlockHash)). */
export function factId(kind: Hex, subject: Hex, btcBlockHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [kind, subject, btcBlockHash]),
  );
}

export function outputId(txid: Hex, vout: number, btcBlockHash: Hex): Hex {
  return factId(KIND_OUTPUT, outputSubject(txid, vout), btcBlockHash);
}

/** @param scriptHash keccak256 of the scriptPubKey (the subject) */
export function balanceId(scriptHash: Hex, btcBlockHash: Hex): Hex {
  return factId(KIND_BALANCE, scriptHash, btcBlockHash);
}

/** The id a fact file's own fields give. */
export function idOfFile(file: FactFile): Hex {
  return file.kind === "output"
    ? outputId(file.fact.txid, file.fact.vout, file.asOf.btcBlockHash)
    : balanceId(file.fact.scriptHash, file.asOf.btcBlockHash);
}

// ---------------------------------------------------------------------------------------------
// Fact files (docs/SCHEMA.md). In memory integers are numbers (16/32-bit fields) or bigints (64-bit fields);
// on disk every integer is a decimal string.
// ---------------------------------------------------------------------------------------------

export interface OutputFields {
  txid: Hex;
  vout: number;
  sats: bigint;
  scriptHash: Hex;
  scriptLength: number;
  spent: boolean;
  confirmations: number;
  /** Emitted, not stored. */
  script: Hex;
}

export interface BalanceFields {
  scriptHash: Hex;
  sats: bigint;
  scriptLength: number;
  /** Emitted, not stored. */
  script: Hex;
}

export interface AsOf {
  btcHeight: number;
  btcBlockHash: Hex;
}

export interface Recording {
  txHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
}

interface Envelope {
  schema: typeof SCHEMA;
  chainId: number;
  contract: Address;
  id: Hex;
  asOf: AsOf;
  recording: Recording;
}

export type OutputFactFile = Envelope & { kind: "output"; fact: OutputFields };
export type BalanceFactFile = Envelope & { kind: "balance"; fact: BalanceFields };
export type FactFile = OutputFactFile | BalanceFactFile;

const lower = <T extends string>(s: T): T => s.toLowerCase() as T;

/** The JSON object, keys in schema order, every integer a decimal string, hex lowercase. */
export function factFileJson(file: FactFile): Record<string, unknown> {
  const fact =
    file.kind === "output"
      ? {
          txid: lower(file.fact.txid),
          vout: String(file.fact.vout),
          sats: file.fact.sats.toString(),
          scriptHash: lower(file.fact.scriptHash),
          scriptLength: String(file.fact.scriptLength),
          spent: file.fact.spent,
          confirmations: String(file.fact.confirmations),
          script: lower(file.fact.script),
        }
      : {
          scriptHash: lower(file.fact.scriptHash),
          sats: file.fact.sats.toString(),
          scriptLength: String(file.fact.scriptLength),
          script: lower(file.fact.script),
        };
  return {
    schema: file.schema,
    kind: file.kind,
    chainId: String(file.chainId),
    contract: lower(file.contract),
    id: lower(file.id),
    fact,
    asOf: { btcHeight: String(file.asOf.btcHeight), btcBlockHash: lower(file.asOf.btcBlockHash) },
    recording: {
      txHash: lower(file.recording.txHash),
      blockNumber: file.recording.blockNumber.toString(),
      blockHash: lower(file.recording.blockHash),
    },
  };
}

export function serializeFactFile(file: FactFile): string {
  return `${JSON.stringify(factFileJson(file), null, 2)}\n`;
}

export function writeFactFile(path: string, file: FactFile): void {
  writeFileSync(path, serializeFactFile(file));
}

export type FactFileParse = { ok: true; file: FactFile } | { ok: false; errors: string[] };

const DEC = /^(0|[1-9][0-9]*)$/;
const B32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const BYTES = /^0x([0-9a-f]{2})*$/;
const U16 = 0xffffn;
const U32 = 0xffffffffn;
const U64 = 0xffffffffffffffffn;

/** Strict parse of a fact file's JSON value: exact keys, exact value formats, values in range. */
export function parseFactFile(input: unknown): FactFileParse {
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
  const kind = top.kind;
  if (kind !== "output" && kind !== "balance") {
    errors.push('file.kind must be "output" or "balance"');
    return { ok: false, errors };
  }
  const chainId = dec(top.chainId, "file.chainId", BigInt(Number.MAX_SAFE_INTEGER));
  const contract = re(top.contract, "file.contract", ADDR, "a lowercase 0x address");
  const id = re(top.id, "file.id", B32, "32 bytes of lowercase hex");

  const asOfObj = obj(top.asOf, "file.asOf", ["btcHeight", "btcBlockHash"]);
  const asOf: AsOf = {
    btcHeight: Number(dec(asOfObj?.btcHeight, "file.asOf.btcHeight", U32)),
    btcBlockHash: re(asOfObj?.btcBlockHash, "file.asOf.btcBlockHash", B32, "32 bytes of lowercase hex"),
  };
  const recObj = obj(top.recording, "file.recording", ["txHash", "blockNumber", "blockHash"]);
  const recording: Recording = {
    txHash: re(recObj?.txHash, "file.recording.txHash", B32, "32 bytes of lowercase hex"),
    blockNumber: dec(recObj?.blockNumber, "file.recording.blockNumber", U64),
    blockHash: re(recObj?.blockHash, "file.recording.blockHash", B32, "32 bytes of lowercase hex"),
  };

  let file: FactFile;
  const base = { schema: SCHEMA, chainId: Number(chainId), contract: contract as Address, id, asOf, recording } as const;
  if (kind === "output") {
    const f = obj(top.fact, "file.fact", [
      "txid",
      "vout",
      "sats",
      "scriptHash",
      "scriptLength",
      "spent",
      "confirmations",
      "script",
    ]);
    if (f && typeof f.spent !== "boolean") errors.push("file.fact.spent must be true or false");
    file = {
      ...base,
      kind,
      fact: {
        txid: re(f?.txid, "file.fact.txid", B32, "32 bytes of lowercase hex"),
        vout: Number(dec(f?.vout, "file.fact.vout", U16)),
        sats: dec(f?.sats, "file.fact.sats", U64),
        scriptHash: re(f?.scriptHash, "file.fact.scriptHash", B32, "32 bytes of lowercase hex"),
        scriptLength: Number(dec(f?.scriptLength, "file.fact.scriptLength", U16)),
        spent: f?.spent === true,
        confirmations: Number(dec(f?.confirmations, "file.fact.confirmations", U32)),
        script: re(f?.script, "file.fact.script", BYTES, "lowercase hex bytes"),
      },
    };
  } else {
    const f = obj(top.fact, "file.fact", ["scriptHash", "sats", "scriptLength", "script"]);
    file = {
      ...base,
      kind,
      fact: {
        scriptHash: re(f?.scriptHash, "file.fact.scriptHash", B32, "32 bytes of lowercase hex"),
        sats: dec(f?.sats, "file.fact.sats", U64),
        scriptLength: Number(dec(f?.scriptLength, "file.fact.scriptLength", U16)),
        script: re(f?.script, "file.fact.script", BYTES, "lowercase hex bytes"),
      },
    };
  }
  return errors.length ? { ok: false, errors } : { ok: true, file };
}

/** Reads and parses a fact file; throws with every problem found. */
export function readFactFile(path: string): FactFile {
  const parsed = parseFactFile(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new Error(`malformed fact file ${path}: ${parsed.errors.join("; ")}`);
  return parsed.file;
}

// ---------------------------------------------------------------------------------------------
// Bitcoin addresses: the network must match the chain's (DECISIONS.md D-012 item 4)
// ---------------------------------------------------------------------------------------------

export type BtcNetwork = "mainnet" | "testnet";

/**
 * Which Bitcoin network a Hemi chain's hVM follows: mainnet for 43111, testnet3 for 743111 (D-010). Any other
 * chain (a local fork) takes `override`, default mainnet. On a Hemi chain an override that disagrees is an error.
 */
export function btcNetworkFor(chainId: number, override?: string): BtcNetwork {
  if (override !== undefined && override !== "mainnet" && override !== "testnet") {
    throw new UsageError('--btc-network must be "mainnet" or "testnet"');
  }
  const fixed: BtcNetwork | undefined =
    chainId === HEMI_MAINNET_CHAIN_ID ? "mainnet" : chainId === HEMI_TESTNET_CHAIN_ID ? "testnet" : undefined;
  if (fixed && override && override !== fixed) {
    throw new UsageError(`chain ${chainId} reads Bitcoin ${fixed}; --btc-network ${override} does not apply`);
  }
  return fixed ?? (override as BtcNetwork | undefined) ?? "mainnet";
}

/**
 * Decodes `address` for `network` and returns its scriptPubKey. Throws a UsageError for an address of the other
 * network (hVM would accept a tb1… address on mainnet and read the mainnet script with that program, D-012) or one
 * that does not decode, so the CLI refuses it before any call.
 */
export function btcAddressScript(address: string, network: BtcNetwork): Hex {
  const net = network === "mainnet" ? NETWORK : TEST_NETWORK;
  const other = network === "mainnet" ? TEST_NETWORK : NETWORK;
  try {
    return bytesToHex(OutScript.encode(BtcAddress(net).decode(address)));
  } catch (error) {
    let isOther = false;
    try {
      BtcAddress(other).decode(address);
      isOther = true;
    } catch {
      // not the other network either
    }
    if (isOther) {
      throw new UsageError(
        `${address} is a Bitcoin ${network === "mainnet" ? "testnet" : "mainnet"} address; this chain reads Bitcoin ${network}`,
      );
    }
    throw new UsageError(`${address} is not a valid Bitcoin ${network} address (${(error as Error).message})`);
  }
}

/** A readable address for a standard script, or undefined. */
export function scriptAddress(script: Hex, network: BtcNetwork): string | undefined {
  try {
    const net = network === "mainnet" ? NETWORK : TEST_NETWORK;
    return BtcAddress(net).encode(OutScript.decode(hexToBytes(script)));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Check (eth_call)
// ---------------------------------------------------------------------------------------------

export interface CheckOptions {
  /** Place this runtime at the contract address for the call (state override), e.g. when it is not deployed. */
  codeOverride?: boolean;
  /** Any further overrides. */
  stateOverride?: StateOverride;
  /** Read the contract's storage at this block (hVM's answers are live whatever the block, D-007). */
  blockNumber?: bigint;
}

export interface OutputCheck {
  kind: "output";
  verdict: Verdict;
  /** Zero when the header is unknown. */
  id: Hex;
  recorded: boolean;
  fact: OutputFields;
  asOf: AsOf;
  /** Set when the verdict was decided by the SDK from an RPC error rather than by the contract. */
  note?: string;
}

export interface BalanceCheck {
  kind: "balance";
  verdict: Verdict;
  id: Hex;
  recorded: boolean;
  fact: BalanceFields;
  asOf: AsOf;
  note?: string;
}

const ZERO32: Hex = `0x${"0".repeat(64)}`;

export function codeOverride(contract: Address): StateOverride {
  return [{ address: contract, code: BITCOIN_FACTS_RUNTIME }];
}

function overrides(contract: Address, options: CheckOptions): StateOverride | undefined {
  const list = [...(options.codeOverride ? codeOverride(contract) : []), ...(options.stateOverride ?? [])];
  return list.length ? list : undefined;
}

/**
 * The JSON-RPC error an hVM precompile raises at the RPC level, if `error` is one: `-32000 tx not found: …` for
 * an unknown txid (0x43) and `-32000 invalid checksum …` and similar for an undecodable address (0x46)
 * (DECISIONS.md D-005, D-012 item 5). viem does not retry -32000, so these come back at once; the SDK reads
 * them as verdicts, never as transport failures.
 */
export function hvmRpcError(
  error: unknown,
): { code: -32000; message: string; notFound: boolean; badAddress: boolean } | undefined {
  let e: unknown = error;
  for (let depth = 0; e && depth < 10; depth++) {
    const x = e as { code?: unknown; message?: unknown; details?: unknown; cause?: unknown };
    if (x.code === -32000) {
      const message = String(x.details ?? x.message ?? "");
      return {
        code: -32000,
        message,
        notFound: /tx not found/i.test(message),
        // btcutil.DecodeAddress / op-geth's address errors; geth's own -32000s ("header not found", "missing trie
        // node", "nonce too low") match neither and are rethrown.
        badAddress: /checksum|charset|invalid character|decode|bech32|base58|address too long|unknown address|witness version|program length/i.test(message),
      };
    }
    e = x.cause;
  }
  return undefined;
}

export async function checkOutput(
  client: PublicClient,
  contract: Address,
  txid: Hex,
  vout: number,
  options: CheckOptions = {},
): Promise<OutputCheck> {
  try {
    const c = await client.readContract({
      address: contract,
      abi: bitcoinFactsAbi,
      functionName: "checkOutput",
      args: [txid, vout],
      stateOverride: overrides(contract, options),
      ...(options.blockNumber !== undefined ? { blockNumber: options.blockNumber } : {}),
    });
    return {
      kind: "output",
      verdict: verdictName(c.verdict),
      id: c.id,
      recorded: c.recorded,
      fact: {
        txid: lower(txid),
        vout,
        sats: c.sats,
        scriptHash: c.scriptHash,
        scriptLength: c.scriptLength,
        spent: c.spent,
        confirmations: c.confirmations,
        script: c.script,
      },
      asOf: { btcHeight: c.btcHeight, btcBlockHash: c.btcBlockHash },
    };
  } catch (error) {
    const rpc = hvmRpcError(error);
    if (!rpc?.notFound) throw error;
    return {
      kind: "output",
      verdict: "NotFound",
      id: ZERO32,
      recorded: false,
      fact: { txid: lower(txid), vout, sats: 0n, scriptHash: ZERO32, scriptLength: 0, spent: false, confirmations: 0, script: "0x" },
      asOf: { btcHeight: 0, btcBlockHash: ZERO32 },
      note: `the RPC answered -32000 ${rpc.message}`,
    };
  }
}

export async function checkBalance(
  client: PublicClient,
  contract: Address,
  btcAddress: string,
  options: CheckOptions = {},
): Promise<BalanceCheck> {
  try {
    const c = await client.readContract({
      address: contract,
      abi: bitcoinFactsAbi,
      functionName: "checkBalance",
      args: [btcAddress],
      stateOverride: overrides(contract, options),
      ...(options.blockNumber !== undefined ? { blockNumber: options.blockNumber } : {}),
    });
    return {
      kind: "balance",
      verdict: verdictName(c.verdict),
      id: c.id,
      recorded: c.recorded,
      fact: { scriptHash: c.scriptHash, sats: c.sats, scriptLength: c.scriptLength, script: c.script },
      asOf: { btcHeight: c.btcHeight, btcBlockHash: c.btcBlockHash },
    };
  } catch (error) {
    const rpc = hvmRpcError(error);
    if (!rpc?.badAddress) throw error;
    return {
      kind: "balance",
      verdict: "BadAddress",
      id: ZERO32,
      recorded: false,
      fact: { scriptHash: ZERO32, sats: 0n, scriptLength: 0, script: "0x" },
      asOf: { btcHeight: 0, btcBlockHash: ZERO32 },
      note: `the RPC answered -32000 ${rpc.message}`,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Stored facts and their recording
// ---------------------------------------------------------------------------------------------

export interface StoredOutput {
  txid: Hex;
  scriptHash: Hex;
  btcBlockHash: Hex;
  sats: bigint;
  confirmations: number;
  btcHeight: number;
  hemiBlock: bigint;
  vout: number;
  scriptLength: number;
  spent: boolean;
}

export interface StoredBalance {
  scriptHash: Hex;
  btcBlockHash: Hex;
  sats: bigint;
  btcHeight: number;
  hemiBlock: bigint;
  scriptLength: number;
}

export type Stored = { kind: "output"; fact: StoredOutput } | { kind: "balance"; fact: StoredBalance };

/** The stored fact with this id, or null. Throws if `contract` does not answer as a BitcoinFacts. */
export async function readStored(
  client: PublicClient,
  contract: Address,
  id: Hex,
  blockNumber?: bigint,
): Promise<Stored | null> {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const kind = KIND_ENUM[await client.readContract({ address: contract, abi: bitcoinFactsAbi, functionName: "kindOf", args: [id], ...at })];
  if (kind === "output") {
    const fact = await client.readContract({ address: contract, abi: bitcoinFactsAbi, functionName: "outputFact", args: [id], ...at });
    return { kind, fact };
  }
  if (kind === "balance") {
    const fact = await client.readContract({ address: contract, abi: bitcoinFactsAbi, functionName: "balanceFact", args: [id], ...at });
    return { kind, fact };
  }
  return null;
}

export function idOfStored(s: Stored): Hex {
  return s.kind === "output"
    ? outputId(s.fact.txid, s.fact.vout, s.fact.btcBlockHash)
    : balanceId(s.fact.scriptHash, s.fact.btcBlockHash);
}

type OutputEvent = {
  id: Hex;
  txid: Hex;
  btcBlockHash: Hex;
  vout: number;
  sats: bigint;
  scriptHash: Hex;
  scriptLength: number;
  spent: boolean;
  confirmations: number;
  btcHeight: number;
  hemiBlock: bigint;
  script: Hex;
};
type BalanceEvent = {
  id: Hex;
  scriptHash: Hex;
  btcBlockHash: Hex;
  sats: bigint;
  scriptLength: number;
  btcHeight: number;
  hemiBlock: bigint;
  script: Hex;
};
export type RecordedEvent = { kind: "output"; args: OutputEvent } | { kind: "balance"; args: BalanceEvent };

/** The OutputRecorded / BalanceRecorded events for `id` among a receipt's (or getLogs') logs from `contract`. */
export function factEvents(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  contract: Address,
  id?: Hex,
): RecordedEvent[] {
  const out: RecordedEvent[] = [];
  for (const log of logs) {
    if (lower(log.address) !== lower(contract)) continue;
    try {
      const ev = decodeEventLog({ abi: bitcoinFactsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "OutputRecorded") {
        if (id === undefined || lower(ev.args.id) === lower(id)) out.push({ kind: "output", args: ev.args as OutputEvent });
      } else if (ev.eventName === "BalanceRecorded") {
        if (id === undefined || lower(ev.args.id) === lower(id)) out.push({ kind: "balance", args: ev.args as BalanceEvent });
      }
    } catch {
      // another event, or not ours
    }
  }
  return out;
}

export interface Located {
  stored: Stored;
  event: RecordedEvent;
  recording: Recording;
}

/** Finds the event that created fact `id`: one getLogs over the single Hemi block the contract stored. */
export async function locateRecording(client: PublicClient, contract: Address, id: Hex, stored: Stored): Promise<Located | null> {
  const block = stored.fact.hemiBlock;
  const logs = await client.getLogs({ address: contract, fromBlock: block, toBlock: block });
  const matches = logs
    .map((log) => ({ log, ev: factEvents([log], contract, id)[0] }))
    .filter((m): m is { log: (typeof logs)[number]; ev: RecordedEvent } => m.ev !== undefined);
  const m = matches[0];
  if (!m || m.log.transactionHash === null || m.log.blockHash === null || m.log.blockNumber === null) return null;
  return {
    stored,
    event: m.ev,
    recording: { txHash: m.log.transactionHash, blockNumber: m.log.blockNumber, blockHash: m.log.blockHash },
  };
}

/** Builds the fact file for a located recording. */
export function fileFromRecording(chainId: number, contract: Address, id: Hex, located: Located): FactFile {
  const { stored, event, recording } = located;
  const asOf: AsOf = { btcHeight: stored.fact.btcHeight, btcBlockHash: stored.fact.btcBlockHash };
  const base = { schema: SCHEMA, chainId, contract: lower(getAddress(contract)), id: lower(id), asOf, recording } as const;
  if (stored.kind === "output") {
    const s = stored.fact;
    return {
      ...base,
      kind: "output",
      fact: {
        txid: s.txid,
        vout: s.vout,
        sats: s.sats,
        scriptHash: s.scriptHash,
        scriptLength: s.scriptLength,
        spent: s.spent,
        confirmations: s.confirmations,
        script: event.args.script,
      },
    };
  }
  const s = stored.fact;
  return {
    ...base,
    kind: "balance",
    fact: { scriptHash: s.scriptHash, sats: s.sats, scriptLength: s.scriptLength, script: event.args.script },
  };
}

// ---------------------------------------------------------------------------------------------
// Record (transaction)
// ---------------------------------------------------------------------------------------------

export class NotRecordableError extends Error {
  constructor(
    readonly verdict: Verdict,
    readonly check: OutputCheck | BalanceCheck,
  ) {
    super(`not recordable: ${verdict} (${VERDICT_MEANING[verdict]})`);
    this.name = "NotRecordableError";
  }
}

export interface RecordResult {
  file: FactFile;
  /** False when the fact was already stored at this Bitcoin tip: nothing was sent, or the transaction was a no-op. */
  created: boolean;
  /** The transaction this call sent, if any (for a no-op it differs from file.recording.txHash). */
  sentTxHash?: Hex;
}

export type Subject = { kind: "output"; txid: Hex; vout: number } | { kind: "balance"; address: string };

/**
 * Checks by eth_call, then sends the record transaction (unless the fact is already stored at this Bitcoin tip),
 * waits for it and builds the fact file from what the contract stored and emitted. The caller is responsible for
 * the mainnet guard (`assertWriteAllowed` in common.ts) before calling this.
 */
export async function recordFact(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chainId: number,
  contract: Address,
  subject: Subject,
  options: { timeoutMs?: number } = {},
): Promise<RecordResult> {
  const check =
    subject.kind === "output"
      ? await checkOutput(client, contract, subject.txid, subject.vout)
      : await checkBalance(client, contract, subject.address);
  if (check.verdict !== "Ok") throw new NotRecordableError(check.verdict, check);

  if (check.recorded) {
    return { file: await factFileForId(client, chainId, contract, check.id), created: false };
  }

  const hash =
    subject.kind === "output"
      ? await wallet.writeContract({
          address: contract,
          abi: bitcoinFactsAbi,
          functionName: "recordOutput",
          args: [subject.txid, subject.vout],
          account,
          chain: wallet.chain,
        })
      : await wallet.writeContract({
          address: contract,
          abi: bitcoinFactsAbi,
          functionName: "recordBalance",
          args: [subject.address],
          account,
          chain: wallet.chain,
        });
  const receipt = await pollTransactionReceipt(client, hash, { timeoutMs: options.timeoutMs });
  if (receipt.status !== "success") throw new Error(`record transaction ${hash} reverted`);
  const ev = factEvents(receipt.logs, contract)[0];
  if (ev) return { file: await factFileForId(client, chainId, contract, ev.args.id, receipt), created: true, sentTxHash: hash };
  const { id, at } = await idAfterNoOp(client, contract, subject, check.id, receipt.blockNumber);
  return { file: await factFileForId(client, chainId, contract, id, { blockNumber: at }), created: false, sentTxHash: hash };
}

/**
 * The stored fact a record transaction found already there. The contract records at the Bitcoin tip it reads when the
 * transaction runs, which may be newer than the tip of the check before it: then the fact stored is the newer tip's,
 * and the check's id may not be stored at all (pre-mainnet audit L-4). So the id is looked up again.
 */
async function idAfterNoOp(
  client: PublicClient,
  contract: Address,
  subject: Subject,
  checkedId: Hex,
  receiptBlock: bigint,
): Promise<{ id: Hex; at: bigint }> {
  // The re-check and the read after it use one block, so a further move of the tip cannot make them disagree (pre-mainnet review R-7).
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const at = latest > receiptBlock ? latest : receiptBlock;
  const after =
    subject.kind === "output"
      ? await checkOutput(client, contract, subject.txid, subject.vout, { blockNumber: at })
      : await checkBalance(client, contract, subject.address, { blockNumber: at });
  if (after.verdict === "Ok" && after.recorded) return { id: after.id, at };
  // Else the fact at the tip the check saw, if someone stored it (a valid fact, though not the one collided with).
  if (await readStored(client, contract, checkedId, receiptBlock)) return { id: checkedId, at: receiptBlock };
  throw new Error(
    `the record transaction changed nothing, and neither the fact at the Bitcoin tip it was checked at (${checkedId}) nor the one at the tip now (${after.id}) is stored: hVM's tip moved while another transaction recorded the fact. Run record again`,
  );
}

/**
 * The fact file for a stored id, read back from the contract and its event. With `receipt`, reads are pinned to
 * its block (a load-balanced RPC may otherwise answer from a node that has not seen it yet).
 */
export async function factFileForId(
  client: PublicClient,
  chainId: number,
  contract: Address,
  id: Hex,
  receipt?: Pick<TransactionReceipt, "blockNumber">,
): Promise<FactFile> {
  return withRetry(
    async () => {
      const stored = await readStored(client, contract, id, receipt?.blockNumber);
      if (!stored) throw new Error(`no fact with id ${id} is stored at ${contract}`);
      const located = await locateRecording(client, contract, id, stored);
      if (!located) throw new Error(`no ${stored.kind === "output" ? "OutputRecorded" : "BalanceRecorded"} event for ${id} in Hemi block ${stored.fact.hemiBlock}`);
      return fileFromRecording(chainId, contract, id, located);
    },
    { retries: receipt ? 5 : 0, baseDelayMs: 1_000 },
  );
}

// ---------------------------------------------------------------------------------------------
// Verify (reads only: RPC + contract address)
// ---------------------------------------------------------------------------------------------

export type HemiStage = "latest" | "safe" | "finalized";

/** The Hemi finality stage of a block by Hemi's own tags: finalized, else safe, else latest (included only). */
export async function hemiStage(client: PublicClient, blockNumber: bigint): Promise<HemiStage> {
  const tag = async (blockTag: "safe" | "finalized"): Promise<bigint | null> => {
    try {
      return (await client.getBlock({ blockTag })).number ?? null;
    } catch {
      return null;
    }
  };
  const finalized = await tag("finalized");
  if (finalized !== null && blockNumber <= finalized) return "finalized";
  const safe = await tag("safe");
  if (safe !== null && blockNumber <= safe) return "safe";
  return "latest";
}

export const INVALID_CODES = [
  "malformed-file",
  "wrong-chain",
  "wrong-contract",
  "id-mismatch",
  "changed-value",
  "no-code",
  "not-a-facts-contract",
  "not-recorded",
  "not-canonical",
  "tx-not-found",
  "tx-failed",
  "tx-wrong-block",
  "no-event",
  "event-mismatch",
] as const;
export type InvalidCode = (typeof INVALID_CODES)[number];

/** The phrase each reason starts with, so the CLI's `invalid: <reason>` is stable to match on. */
export const INVALID_PHRASE: Record<InvalidCode, string> = {
  "malformed-file": "malformed fact file",
  "wrong-chain": "wrong chain",
  "wrong-contract": "wrong contract",
  "id-mismatch": "id does not recompute",
  "changed-value": "changed value",
  "no-code": "no contract code",
  "not-a-facts-contract": "not a BitcoinFacts contract",
  "not-recorded": "not recorded",
  "not-canonical": "recording block is not canonical",
  "tx-not-found": "recording transaction does not exist",
  "tx-failed": "recording transaction failed",
  "tx-wrong-block": "recording transaction is in another block",
  "no-event": "no matching event",
  "event-mismatch": "event does not match",
};

export type VerifyResult =
  | { valid: true; file: FactFile; stage: HemiStage }
  | { valid: false; code: InvalidCode; reason: string; file?: FactFile };

class Invalid extends Error {
  constructor(
    readonly code: InvalidCode,
    detail: string,
  ) {
    super(`${INVALID_PHRASE[code]}: ${detail}`);
  }
}

const show = (v: unknown): string => (typeof v === "bigint" ? v.toString() : String(v));

function compareFields(label: string, pairs: [string, unknown, unknown][], code: InvalidCode, side: [string, string]) {
  for (const [name, a, b] of pairs) {
    const x = typeof a === "string" ? a.toLowerCase() : a;
    const y = typeof b === "string" ? b.toLowerCase() : b;
    if (x !== y) throw new Invalid(code, `${label}${name} is ${show(a)} ${side[0]} but ${show(b)} ${side[1]}`);
  }
}

/** File fields against the stored fact (stored fields only; `script` is checked against the event). */
function fileVsStored(file: FactFile, stored: Stored): [string, unknown, unknown][] {
  const common: [string, unknown, unknown][] = [
    ["asOf.btcHeight", file.asOf.btcHeight, stored.fact.btcHeight],
    ["asOf.btcBlockHash", file.asOf.btcBlockHash, stored.fact.btcBlockHash],
    ["recording.blockNumber", file.recording.blockNumber, stored.fact.hemiBlock],
  ];
  if (file.kind === "output" && stored.kind === "output") {
    const f = file.fact;
    const s = stored.fact;
    return [
      ["fact.txid", f.txid, s.txid],
      ["fact.vout", f.vout, s.vout],
      ["fact.sats", f.sats, s.sats],
      ["fact.scriptHash", f.scriptHash, s.scriptHash],
      ["fact.scriptLength", f.scriptLength, s.scriptLength],
      ["fact.spent", f.spent, s.spent],
      ["fact.confirmations", f.confirmations, s.confirmations],
      ...common,
    ];
  }
  if (file.kind === "balance" && stored.kind === "balance") {
    const f = file.fact;
    const s = stored.fact;
    return [
      ["fact.scriptHash", f.scriptHash, s.scriptHash],
      ["fact.sats", f.sats, s.sats],
      ["fact.scriptLength", f.scriptLength, s.scriptLength],
      ...common,
    ];
  }
  return [["kind", file.kind, stored.kind]];
}

/** Stored fact against its event: every stored field is emitted. */
function storedVsEvent(stored: Stored, event: RecordedEvent, id: Hex): [string, unknown, unknown][] {
  const common: [string, unknown, unknown][] = [
    ["id", id, event.args.id],
    ["btcBlockHash", stored.fact.btcBlockHash, event.args.btcBlockHash],
    ["btcHeight", stored.fact.btcHeight, event.args.btcHeight],
    ["hemiBlock", stored.fact.hemiBlock, event.args.hemiBlock],
    ["scriptHash", stored.fact.scriptHash, event.args.scriptHash],
    ["scriptLength", stored.fact.scriptLength, event.args.scriptLength],
    ["sats", stored.fact.sats, event.args.sats],
    ["script hash", stored.fact.scriptHash, keccak256(event.args.script)],
    ["script length", stored.fact.scriptLength, (event.args.script.length - 2) / 2],
  ];
  if (stored.kind === "output" && event.kind === "output") {
    return [
      ["txid", stored.fact.txid, event.args.txid],
      ["vout", stored.fact.vout, event.args.vout],
      ["spent", stored.fact.spent, event.args.spent],
      ["confirmations", stored.fact.confirmations, event.args.confirmations],
      ...common,
    ];
  }
  if (stored.kind === "balance" && event.kind === "balance") return common;
  return [["kind", stored.kind, event.kind]];
}

async function readStoredOrInvalid(client: PublicClient, contract: Address, id: Hex, options: VerifyOptions): Promise<Stored> {
  const code = await client.getCode({ address: contract });
  if (!code || code === "0x") throw new Invalid("no-code", `there is no contract at ${contract}`);
  if (!options.allowOtherCode && !sameCode(code, BITCOIN_FACTS_RUNTIMES)) {
    throw new Invalid("not-a-facts-contract", `the code at ${contract} is not this SDK's BitcoinFacts (${OTHER_CODE})`);
  }
  let stored: Stored | null;
  try {
    stored = await readStored(client, contract, id);
  } catch (error) {
    // A revert, no return data or undecodable return data: the code there is something else. Transport errors
    // are not this, and are rethrown.
    const notOurs =
      error instanceof BaseError &&
      error.walk(
        (e) =>
          e instanceof Error &&
          (e.name === "ContractFunctionRevertedError" || e.name === "ContractFunctionZeroDataError" || e.name.startsWith("AbiDecoding")),
      ) !== null;
    if (notOurs) throw new Invalid("not-a-facts-contract", `${contract} does not answer kindOf/outputFact/balanceFact`);
    throw error;
  }
  if (!stored) throw new Invalid("not-recorded", `no fact with id ${id} is stored at ${contract}`);
  const recomputed = idOfStored(stored);
  if (lower(recomputed) !== lower(id)) {
    throw new Invalid("id-mismatch", `the fact stored under ${id} gives ${recomputed}`);
  }
  return stored;
}

/** Steps 3 and 4 of docs/SCHEMA.md "Verification", given what the recording should be. */
async function checkRecording(
  client: PublicClient,
  contract: Address,
  id: Hex,
  stored: Stored,
  recording: Recording,
  fileScript: Hex | undefined,
): Promise<HemiStage> {
  // canonical: the block at that height is still the one recorded
  const block = await client.getBlock({ blockNumber: recording.blockNumber }).catch(() => null);
  if (!block) throw new Invalid("not-canonical", `this chain has no block ${recording.blockNumber}`);
  if (lower(block.hash ?? "0x") !== lower(recording.blockHash)) {
    throw new Invalid(
      "not-canonical",
      `block ${recording.blockNumber} is now ${block.hash}, the fact was recorded in ${recording.blockHash}`,
    );
  }
  let receipt: TransactionReceipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: recording.txHash });
  } catch (error) {
    if (error instanceof BaseError && error.name === "TransactionReceiptNotFoundError") {
      throw new Invalid("tx-not-found", `no transaction ${recording.txHash} on this chain`);
    }
    throw error;
  }
  if (receipt.status !== "success") throw new Invalid("tx-failed", `${recording.txHash} reverted`);
  // The transaction may have been sent to another contract that called this one (a Safe, a smart account, a multicall,
  // or someone recording the same fact first): only the event `contract` itself emitted counts (pre-mainnet audit M-1).
  if (receipt.blockNumber !== recording.blockNumber || lower(receipt.blockHash) !== lower(recording.blockHash)) {
    throw new Invalid(
      "tx-wrong-block",
      `${recording.txHash} is in block ${receipt.blockNumber} (${receipt.blockHash}), not ${recording.blockNumber} (${recording.blockHash})`,
    );
  }
  const events = factEvents(receipt.logs, contract, id);
  const event = events[0];
  if (!event) {
    const name = stored.kind === "output" ? "OutputRecorded" : "BalanceRecorded";
    throw new Invalid("no-event", `${recording.txHash} emitted no ${name} event for ${id}`);
  }
  compareFields("event ", storedVsEvent(stored, event, id), "event-mismatch", ["on chain", "in the event"]);
  if (fileScript !== undefined && lower(fileScript) !== lower(event.args.script)) {
    throw new Invalid("changed-value", `fact.script is ${fileScript} in the file but ${event.args.script} in the event`);
  }
  return hemiStage(client, recording.blockNumber);
}

function invalid(error: unknown, file?: FactFile): VerifyResult {
  if (error instanceof Invalid) {
    return { valid: false, code: error.code, reason: error.message, ...(file ? { file } : {}) };
  }
  throw error;
}

/**
 * Verifies a fact file (its parsed JSON) against `contract` on the chain `client` serves, exactly as
 * docs/SCHEMA.md "Verification" says. Never trusts the file: every field is compared with the contract.
 */
export async function verifyFactFile(client: PublicClient, contract: Address, input: unknown, options: VerifyOptions = {}): Promise<VerifyResult> {
  const parsed = parseFactFile(input);
  if (!parsed.ok) return { valid: false, code: "malformed-file", reason: `${INVALID_PHRASE["malformed-file"]}: ${parsed.errors.join("; ")}` };
  const file = parsed.file;
  try {
    const chainId = await client.getChainId();
    if (file.chainId !== chainId) throw new Invalid("wrong-chain", `the file is for chain ${file.chainId}, the RPC serves chain ${chainId}`);
    if (lower(file.contract) !== lower(contract)) {
      throw new Invalid("wrong-contract", `the file names ${file.contract}, verifying against ${lower(contract)}`);
    }
    // The file must agree with itself before it is compared with anything.
    if (lower(keccak256(file.fact.script)) !== lower(file.fact.scriptHash)) {
      throw new Invalid("changed-value", `fact.script does not hash to fact.scriptHash`);
    }
    if ((file.fact.script.length - 2) / 2 !== file.fact.scriptLength) {
      throw new Invalid("changed-value", `fact.script is ${(file.fact.script.length - 2) / 2} bytes, fact.scriptLength says ${file.fact.scriptLength}`);
    }
    const recomputed = idOfFile(file);
    if (lower(recomputed) !== lower(file.id)) {
      throw new Invalid("id-mismatch", `the file's fields give ${recomputed}, the file says ${file.id}`);
    }
    const stored = await readStoredOrInvalid(client, contract, file.id, options);
    if (stored.kind !== file.kind) throw new Invalid("changed-value", `kind is ${file.kind} in the file but ${stored.kind} on chain`);
    compareFields("", fileVsStored(file, stored), "changed-value", ["in the file", "on chain"]);
    const stage = await checkRecording(client, contract, file.id, stored, file.recording, file.fact.script);
    return { valid: true, file, stage };
  } catch (error) {
    return invalid(error, file);
  }
}

/** Verifies the fact stored under `id`: same checks, with the recording found by a one-block getLogs. */
export async function verifyFactId(client: PublicClient, contract: Address, id: Hex, options: VerifyOptions = {}): Promise<VerifyResult> {
  try {
    const chainId = await client.getChainId();
    const stored = await readStoredOrInvalid(client, contract, id, options);
    const located = await locateRecording(client, contract, id, stored);
    if (!located) {
      const name = stored.kind === "output" ? "OutputRecorded" : "BalanceRecorded";
      throw new Invalid("no-event", `no ${name} event for ${id} in Hemi block ${stored.fact.hemiBlock}`);
    }
    const stage = await checkRecording(client, contract, id, stored, located.recording, undefined);
    return { valid: true, file: fileFromRecording(chainId, contract, id, located), stage };
  } catch (error) {
    return invalid(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export interface StatusResult {
  id: Hex;
  recorded: boolean;
  file?: FactFile;
  stage?: HemiStage;
  /** For an output fact: what checkOutput says now (live view). */
  now?: OutputCheck;
}

export async function factStatus(client: PublicClient, contract: Address, id: Hex): Promise<StatusResult> {
  const chainId = await client.getChainId();
  const stored = await readStored(client, contract, id);
  if (!stored) return { id, recorded: false };
  const located = await locateRecording(client, contract, id, stored);
  const result: StatusResult = { id, recorded: true };
  if (located) {
    result.file = fileFromRecording(chainId, contract, id, located);
    result.stage = await hemiStage(client, located.recording.blockNumber);
  }
  if (stored.kind === "output") result.now = await checkOutput(client, contract, stored.fact.txid, stored.fact.vout);
  return result;
}
