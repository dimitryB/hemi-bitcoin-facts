/**
 * FidelityBonds from TypeScript: check (eth_call), record and refresh (transactions), live status and verify
 * (reads only), and the `bond` fact file exactly as docs/SCHEMA.md defines it.
 *
 * A bond is proof of locked funds, not collateral: nothing in the contract or here can slash or move it.
 *
 * Every chain read takes a viem PublicClient (use `connect()` from common.ts: fallback RPCs, retry with backoff, at
 * most 4 requests a second). `verifyBondFile` needs nothing but that client and the contract address.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  BaseError,
  decodeEventLog,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  sha256,
  toBytes,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { FIDELITY_BONDS_INIT_CODE, FIDELITY_BONDS_RUNTIME, fidelityBondsAbi } from "./abi/FidelityBonds.js";
import { parseBondWitnessScript } from "./btc/script.js";
import { OTHER_CODE, sameCode, type VerifyOptions } from "./common.js";
import { CREATE2_DEPLOYER, hemiStage, hvmRpcError, SCHEMA, type HemiStage } from "./facts.js";
import { pollTransactionReceipt, withRetry } from "./vendor/receipts/client.js";

export { fidelityBondsAbi, FIDELITY_BONDS_INIT_CODE, FIDELITY_BONDS_RUNTIME };
/**
 * Every FidelityBonds runtime this SDK accepts in `verify` (pre-mainnet audit I-3): this build's. A later release adds
 * its own and keeps these, so earlier deployments' bonds still verify.
 */
export const FIDELITY_BONDS_RUNTIMES: readonly Hex[] = [FIDELITY_BONDS_RUNTIME];

// ---------------------------------------------------------------------------------------------
// Constants (test/bonds.test.ts checks them against the contract and the deploy script)
// ---------------------------------------------------------------------------------------------

export const KIND_BOND: Hex = keccak256(toBytes("hemi-bitcoin-facts/bond"));
/** contracts/script/Deploy.s.sol `Deployments.FIDELITY_BONDS_SALT`. */
export const FIDELITY_BONDS_SALT: Hex = keccak256(toBytes("hemi-bitcoin-facts/FidelityBonds/v1"));

/** Where Deploy.s.sol puts the compiled FidelityBonds, and so the contract address a tag must name. */
export function fidelityBondsCreate2Address(): Address {
  return getContractAddress({ from: CREATE2_DEPLOYER, salt: FIDELITY_BONDS_SALT, bytecode: FIDELITY_BONDS_INIT_CODE, opcode: "CREATE2" });
}

/** FidelityBonds.Verdict, in enum order (the order the checks run). */
export const BOND_VERDICTS = [
  "Ok",
  "BadWitnessScript",
  "BadLocktime",
  "NoBitcoinView",
  "NotFound",
  "TooManyOutputs",
  "NotABond",
  "Spent",
  "SpendUnknown",
  "BadTag",
  "WrongChain",
  "WrongContract",
  "AmbiguousTag",
  "BelowFloor",
  "NoConfirmations",
  "FewConfirmations",
] as const;
export type BondVerdict = (typeof BOND_VERDICTS)[number];

export const BOND_VERDICT_MEANING: Record<BondVerdict, string> = {
  Ok: "a bond: every requirement holds",
  BadWitnessScript: "the witness script is not 04 <locktime> b1 75 21 <33-byte key> ac",
  BadLocktime: "the locktime is not a Unix time in [500000000, 2^31)",
  NoBitcoinView: "0x44 gave no usable Bitcoin header",
  NotFound: "hVM does not list the transaction, or a vout is past its outputs",
  TooManyOutputs: "the transaction has more than 128 outputs, past 0x42's window",
  NotABond: "the bond output's script is not 0x0020 ‖ sha256(witness script)",
  Spent: "the bond output is spent",
  SpendUnknown: "hVM cannot say whether the bond output is spent",
  BadTag: 'the tag output is not a 50-byte OP_RETURN "HFB1" tag naming a nonzero agent',
  WrongChain: "the tag names another chain",
  WrongContract: "the tag names another contract",
  AmbiguousTag: 'another output is also an "HFB1" tag (for any chain, contract or agent)',
  BelowFloor: "the bond holds fewer than MIN_SATS (10,000)",
  NoConfirmations: "0x43 gave no plausible confirmation count",
  FewConfirmations: "fewer than 6 Bitcoin confirmations",
};

/** FidelityBonds.Status, in enum order. */
export const BOND_STATUSES = ["NotRecorded", "Live", "Expired", "Ended", "Unknown"] as const;
export type BondStatus = (typeof BOND_STATUSES)[number];

export const BOND_STATUS_MEANING: Record<BondStatus, string> = {
  NotRecorded: "no bond is stored under this id",
  Live: "unspent, and both the hVM Bitcoin header's time and Hemi's clock are before the locktime",
  Expired: "unspent, and the hVM Bitcoin header's time or Hemi's clock is at or past the locktime (Bitcoin lets the owner redeem about 1-2 hours after Hemi's clock reaches it)",
  Ended: "spent",
  Unknown: "hVM cannot say whether it is spent right now; never treated as live",
};

const name = <T extends readonly string[]>(list: T, n: number, what: string): T[number] => {
  const v = list[n];
  if (v === undefined) throw new Error(`unknown ${what} ${n}`);
  return v;
};

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

/** keccak256(txid ‖ vout as 2 big-endian bytes). */
export function bondSubject(txid: Hex, vout: number): Hex {
  return keccak256(encodePacked(["bytes32", "uint16"], [txid, vout]));
}

/** keccak256(abi.encode(KIND_BOND, bondSubject(txid, vout))): one id per output. */
export function bondId(txid: Hex, vout: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [KIND_BOND, bondSubject(txid, vout)]));
}

// ---------------------------------------------------------------------------------------------
// Check, live status and the stored bond (eth_call)
// ---------------------------------------------------------------------------------------------

export interface BondRef {
  txid: Hex;
  bondVout: number;
  tagVout: number;
  witnessScript: Hex;
}

export interface BondCheck {
  verdict: BondVerdict;
  bondId: Hex;
  recorded: boolean;
  agent: Address;
  sats: bigint;
  locktime: number;
  witnessProgram: Hex;
  confirmations: number;
  btcHeight: number;
  btcBlockHash: Hex;
  btcTime: number;
  expired: boolean;
  /** Set when the SDK decided the verdict from an RPC error rather than the contract. */
  note?: string;
}

export interface CallOptions {
  /** Place the compiled FidelityBonds at the contract address for the call (state override). */
  codeOverride?: boolean;
  stateOverride?: StateOverride;
  blockNumber?: bigint;
}

export function bondsCodeOverride(contract: Address): StateOverride {
  return [{ address: contract, code: FIDELITY_BONDS_RUNTIME }];
}

function overrides(contract: Address, o: CallOptions): StateOverride | undefined {
  const list = [...(o.codeOverride ? bondsCodeOverride(contract) : []), ...(o.stateOverride ?? [])];
  return list.length ? list : undefined;
}

const lower = <T extends string>(s: T): T => s.toLowerCase() as T;
const ZERO32: Hex = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export async function checkBond(client: PublicClient, contract: Address, ref: BondRef, options: CallOptions = {}): Promise<BondCheck> {
  try {
    const c = await client.readContract({
      address: contract,
      abi: fidelityBondsAbi,
      functionName: "checkBond",
      args: [ref.txid, ref.bondVout, ref.tagVout, ref.witnessScript],
      stateOverride: overrides(contract, options),
    });
    return {
      verdict: name(BOND_VERDICTS, c.verdict, "verdict"),
      bondId: c.bondId,
      recorded: c.recorded,
      agent: c.agent,
      sats: c.sats,
      locktime: c.locktime,
      witnessProgram: c.witnessProgram,
      confirmations: c.confirmations,
      btcHeight: c.btcHeight,
      btcBlockHash: c.btcBlockHash,
      btcTime: c.btcTime,
      expired: c.expired,
    };
  } catch (error) {
    // Inside the contract a failing 0x43 just returns false (D-005); a raw RPC "tx not found" would mean the node
    // surfaced it anyway. Read it as NotFound, as facts.ts does.
    const rpc = hvmRpcError(error);
    if (!rpc?.notFound) throw error;
    return {
      verdict: "NotFound",
      bondId: bondId(ref.txid, ref.bondVout),
      recorded: false,
      agent: ZERO_ADDRESS,
      sats: 0n,
      locktime: 0,
      witnessProgram: ZERO32,
      confirmations: 0,
      btcHeight: 0,
      btcBlockHash: ZERO32,
      btcTime: 0,
      expired: false,
      note: `the RPC answered -32000 ${rpc.message}`,
    };
  }
}

/** What output `tagVout` of `txid` says as a tag for this chain and contract (FidelityBonds.readTag). */
export async function readTag(
  client: PublicClient,
  contract: Address,
  txid: Hex,
  tagVout: number,
  options: CallOptions = {},
): Promise<{ verdict: BondVerdict; agent: Address }> {
  const [verdict, agent] = await client.readContract({
    address: contract,
    abi: fidelityBondsAbi,
    functionName: "readTag",
    args: [txid, tagVout],
    stateOverride: overrides(contract, options),
  });
  return { verdict: name(BOND_VERDICTS, verdict, "verdict"), agent };
}

export interface LiveBond {
  status: BondStatus;
  agent: Address;
  sats: bigint;
  locktime: number;
}

export async function liveBond(client: PublicClient, contract: Address, id: Hex, options: CallOptions = {}): Promise<LiveBond> {
  const [status, agent, sats, locktime] = await client.readContract({
    address: contract,
    abi: fidelityBondsAbi,
    functionName: "liveBond",
    args: [id],
    stateOverride: overrides(contract, options),
    ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
  });
  return { status: name(BOND_STATUSES, status, "status"), agent, sats, locktime };
}

export interface StoredBond {
  txid: Hex;
  witnessProgram: Hex;
  btcBlockHash: Hex;
  agent: Address;
  sats: bigint;
  locktime: number;
  hemiBlock: bigint;
  endedHemiBlock: bigint;
  btcHeight: number;
  endedBtcHeight: number;
  confirmations: number;
  vout: number;
  tagVout: number;
}

/** The stored bond, or null. Throws if `contract` does not answer as a FidelityBonds. */
export async function readStoredBond(client: PublicClient, contract: Address, id: Hex, blockNumber?: bigint): Promise<StoredBond | null> {
  const b = await client.readContract({
    address: contract,
    abi: fidelityBondsAbi,
    functionName: "bond",
    args: [id],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return b.hemiBlock === 0n ? null : b;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

export interface RecordedEvent {
  bondId: Hex;
  agent: Address;
  txid: Hex;
  vout: number;
  tagVout: number;
  sats: bigint;
  locktime: number;
  witnessProgram: Hex;
  confirmations: number;
  btcHeight: number;
  btcBlockHash: Hex;
  hemiBlock: bigint;
  witnessScript: Hex;
}

export interface EndedEvent {
  bondId: Hex;
  agent: Address;
  btcHeight: number;
  btcBlockHash: Hex;
  hemiBlock: bigint;
}

type Log = { address: Address; topics: readonly Hex[]; data: Hex };

export function bondEvents(logs: readonly Log[], contract: Address, id?: Hex): { recorded: RecordedEvent[]; ended: EndedEvent[] } {
  const recorded: RecordedEvent[] = [];
  const ended: EndedEvent[] = [];
  for (const log of logs) {
    if (lower(log.address) !== lower(contract)) continue;
    try {
      const ev = decodeEventLog({ abi: fidelityBondsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (id !== undefined && lower(ev.args.bondId) !== lower(id)) continue;
      if (ev.eventName === "BondRecorded") recorded.push(ev.args as RecordedEvent);
      else if (ev.eventName === "BondEnded") ended.push(ev.args as EndedEvent);
    } catch {
      // not one of ours
    }
  }
  return { recorded, ended };
}

// ---------------------------------------------------------------------------------------------
// Bond fact files (docs/SCHEMA.md `bond`)
// ---------------------------------------------------------------------------------------------

export interface BondFields {
  agent: Address;
  txid: Hex;
  vout: number;
  tagVout: number;
  sats: bigint;
  locktime: number;
  witnessProgram: Hex;
  confirmations: number;
  /** Emitted, not stored. */
  witnessScript: Hex;
}

export interface BondFactFile {
  schema: typeof SCHEMA;
  kind: "bond";
  chainId: number;
  contract: Address;
  id: Hex;
  fact: BondFields;
  asOf: { btcHeight: number; btcBlockHash: Hex };
  recording: { txHash: Hex; blockNumber: bigint; blockHash: Hex };
}

export function bondFactFileJson(f: BondFactFile): Record<string, unknown> {
  return {
    schema: f.schema,
    kind: f.kind,
    chainId: String(f.chainId),
    contract: lower(f.contract),
    id: lower(f.id),
    fact: {
      agent: lower(f.fact.agent),
      txid: lower(f.fact.txid),
      vout: String(f.fact.vout),
      tagVout: String(f.fact.tagVout),
      sats: f.fact.sats.toString(),
      locktime: String(f.fact.locktime),
      witnessProgram: lower(f.fact.witnessProgram),
      confirmations: String(f.fact.confirmations),
      witnessScript: lower(f.fact.witnessScript),
    },
    asOf: { btcHeight: String(f.asOf.btcHeight), btcBlockHash: lower(f.asOf.btcBlockHash) },
    recording: {
      txHash: lower(f.recording.txHash),
      blockNumber: f.recording.blockNumber.toString(),
      blockHash: lower(f.recording.blockHash),
    },
  };
}

export function serializeBondFactFile(f: BondFactFile): string {
  return `${JSON.stringify(bondFactFileJson(f), null, 2)}\n`;
}

export function writeBondFactFile(path: string, f: BondFactFile): void {
  writeFileSync(path, serializeBondFactFile(f));
}

const DEC = /^(0|[1-9][0-9]*)$/;
const B32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const BYTES = /^0x([0-9a-f]{2})*$/;

export type BondFactFileParse = { ok: true; file: BondFactFile } | { ok: false; errors: string[] };

/** Strict parse: exact keys, exact value formats, values in range (as facts.ts's parseFactFile). */
export function parseBondFactFile(input: unknown): BondFactFileParse {
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
  if (top.kind !== "bond") {
    errors.push('file.kind must be "bond"');
    return { ok: false, errors };
  }
  const f = obj(top.fact, "file.fact", ["agent", "txid", "vout", "tagVout", "sats", "locktime", "witnessProgram", "confirmations", "witnessScript"]);
  const a = obj(top.asOf, "file.asOf", ["btcHeight", "btcBlockHash"]);
  const r = obj(top.recording, "file.recording", ["txHash", "blockNumber", "blockHash"]);
  const h32 = "32 bytes of lowercase hex";
  const file: BondFactFile = {
    schema: SCHEMA,
    kind: "bond",
    chainId: Number(dec(top.chainId, "file.chainId", BigInt(Number.MAX_SAFE_INTEGER))),
    contract: re(top.contract, "file.contract", ADDR, "a lowercase 0x address") as Address,
    id: re(top.id, "file.id", B32, h32),
    fact: {
      agent: re(f?.agent, "file.fact.agent", ADDR, "a lowercase 0x address") as Address,
      txid: re(f?.txid, "file.fact.txid", B32, h32),
      vout: Number(dec(f?.vout, "file.fact.vout", 0xffffn)),
      tagVout: Number(dec(f?.tagVout, "file.fact.tagVout", 0xffffn)),
      sats: dec(f?.sats, "file.fact.sats", 0xffffffffffffffffn),
      locktime: Number(dec(f?.locktime, "file.fact.locktime", 0xffffffffn)),
      witnessProgram: re(f?.witnessProgram, "file.fact.witnessProgram", B32, h32),
      confirmations: Number(dec(f?.confirmations, "file.fact.confirmations", 0xffffffffn)),
      witnessScript: re(f?.witnessScript, "file.fact.witnessScript", BYTES, "lowercase hex bytes"),
    },
    asOf: {
      btcHeight: Number(dec(a?.btcHeight, "file.asOf.btcHeight", 0xffffffffn)),
      btcBlockHash: re(a?.btcBlockHash, "file.asOf.btcBlockHash", B32, h32),
    },
    recording: {
      txHash: re(r?.txHash, "file.recording.txHash", B32, h32),
      blockNumber: dec(r?.blockNumber, "file.recording.blockNumber", 0xffffffffffffffffn),
      blockHash: re(r?.blockHash, "file.recording.blockHash", B32, h32),
    },
  };
  return errors.length ? { ok: false, errors } : { ok: true, file };
}

export function readBondFactFile(path: string): BondFactFile {
  const p = parseBondFactFile(JSON.parse(readFileSync(path, "utf8")));
  if (!p.ok) throw new Error(`malformed bond fact file ${path}: ${p.errors.join("; ")}`);
  return p.file;
}

/** Locates the BondRecorded event for `id` (one getLogs over the stored Hemi block) and builds the fact file. */
export async function bondFactFileForId(
  client: PublicClient,
  chainId: number,
  contract: Address,
  id: Hex,
  receipt?: TransactionReceipt,
): Promise<{ file: BondFactFile; stored: StoredBond }> {
  return withRetry(
    async () => {
      const stored = await readStoredBond(client, contract, id, receipt?.blockNumber);
      if (!stored) throw new Error(`no bond with id ${id} is stored at ${contract}`);
      const located = await locateRecording(client, contract, id, stored);
      if (!located) throw new Error(`no BondRecorded event for ${id} in Hemi block ${stored.hemiBlock}`);
      return { file: fileFromRecording(chainId, contract, id, stored, located.event, located.recording), stored };
    },
    { retries: receipt ? 5 : 0, baseDelayMs: 1_000 },
  );
}

async function locateRecording(
  client: PublicClient,
  contract: Address,
  id: Hex,
  stored: StoredBond,
): Promise<{ event: RecordedEvent; recording: BondFactFile["recording"] } | null> {
  const logs = await client.getLogs({ address: contract, fromBlock: stored.hemiBlock, toBlock: stored.hemiBlock });
  for (const log of logs) {
    const ev = bondEvents([log], contract, id).recorded[0];
    if (!ev || log.transactionHash === null || log.blockHash === null || log.blockNumber === null) continue;
    return { event: ev, recording: { txHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash } };
  }
  return null;
}

function fileFromRecording(
  chainId: number,
  contract: Address,
  id: Hex,
  s: StoredBond,
  ev: RecordedEvent,
  recording: BondFactFile["recording"],
): BondFactFile {
  return {
    schema: SCHEMA,
    kind: "bond",
    chainId,
    contract: lower(getAddress(contract)),
    id: lower(id),
    fact: {
      agent: lower(s.agent),
      txid: lower(s.txid),
      vout: s.vout,
      tagVout: s.tagVout,
      sats: s.sats,
      locktime: s.locktime,
      witnessProgram: lower(s.witnessProgram),
      confirmations: s.confirmations,
      witnessScript: lower(ev.witnessScript),
    },
    asOf: { btcHeight: s.btcHeight, btcBlockHash: lower(s.btcBlockHash) },
    recording,
  };
}

// ---------------------------------------------------------------------------------------------
// Record and refresh (transactions; the caller runs the mainnet guard first)
// ---------------------------------------------------------------------------------------------

export class BondNotRecordable extends Error {
  constructor(
    readonly verdict: BondVerdict,
    readonly check: BondCheck,
  ) {
    super(`not recordable: ${verdict} (${BOND_VERDICT_MEANING[verdict]})`);
    this.name = "BondNotRecordable";
  }
}

export interface RecordBondResult {
  file: BondFactFile;
  check: BondCheck;
  created: boolean;
  sentTxHash?: Hex;
  gasUsed?: bigint;
}

/** Checks by eth_call, sends recordBond unless already stored, and builds the fact file from what was stored. */
export async function recordBond(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chainId: number,
  contract: Address,
  ref: BondRef,
  options: { timeoutMs?: number } = {},
): Promise<RecordBondResult> {
  const check = await checkBond(client, contract, ref);
  if (check.verdict !== "Ok") throw new BondNotRecordable(check.verdict, check);
  if (check.recorded) return { ...(await bondFactFileForId(client, chainId, contract, check.bondId)), check, created: false };
  const hash = await wallet.writeContract({
    address: contract,
    abi: fidelityBondsAbi,
    functionName: "recordBond",
    args: [ref.txid, ref.bondVout, ref.tagVout, ref.witnessScript],
    account,
    chain: wallet.chain,
  });
  const receipt = await pollTransactionReceipt(client, hash, { timeoutMs: options.timeoutMs });
  if (receipt.status !== "success") throw new Error(`recordBond transaction ${hash} reverted`);
  const ev = bondEvents(receipt.logs, contract).recorded[0];
  const id = ev?.bondId ?? check.bondId;
  const { file } = await bondFactFileForId(client, chainId, contract, id, receipt);
  return { file, check, created: ev !== undefined, sentTxHash: hash, gasUsed: receipt.gasUsed };
}

export interface RefreshResult {
  /** Ended after this call. */
  ended: boolean;
  /** It was already marked ended before; nothing was sent. */
  already: boolean;
  /** What liveBond says (before sending, when nothing was sent). */
  live: LiveBond;
  sentTxHash?: Hex;
  event?: EndedEvent;
  gasUsed?: bigint;
}

/** What `previewRefresh` finds. */
export interface RefreshPreview {
  stored: StoredBond;
  live: LiveBond;
  /** Marked ended before: refresh would change nothing. */
  already: boolean;
  /** refresh would mark it ended now (eth_call). */
  wouldEnd: boolean;
}

/**
 * What `refresh` would do, by eth_call. refresh is permissionless, so no key is needed: without `account` the call is
 * made from no particular sender (pre-mainnet audit I-5: the CLI asks for a key only when there is something to send).
 */
export async function previewRefresh(client: PublicClient, contract: Address, id: Hex, account?: Account): Promise<RefreshPreview> {
  const stored = await readStoredBond(client, contract, id);
  if (!stored) throw new Error(`no bond with id ${id} is stored at ${contract}`);
  const live = await liveBond(client, contract, id);
  if (stored.endedHemiBlock !== 0n) return { stored, live, already: true, wouldEnd: false };
  const { result } = await client.simulateContract({ address: contract, abi: fidelityBondsAbi, functionName: "refresh", args: [id], ...(account ? { account } : {}) });
  return { stored, live, already: false, wouldEnd: result };
}

/** Simulates refresh by eth_call; sends it only when it would mark the bond ended now. */
export async function refreshBond(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  contract: Address,
  id: Hex,
  options: { timeoutMs?: number } = {},
): Promise<RefreshResult> {
  const { live, already, wouldEnd } = await previewRefresh(client, contract, id, account);
  if (already) return { ended: true, already: true, live };
  if (!wouldEnd) return { ended: false, already: false, live };
  const hash = await wallet.writeContract({ address: contract, abi: fidelityBondsAbi, functionName: "refresh", args: [id], account, chain: wallet.chain });
  const receipt = await pollTransactionReceipt(client, hash, { timeoutMs: options.timeoutMs });
  if (receipt.status !== "success") throw new Error(`refresh transaction ${hash} reverted`);
  const event = bondEvents(receipt.logs, contract, id).ended[0];
  return { ended: event !== undefined, already: false, live, sentTxHash: hash, event, gasUsed: receipt.gasUsed };
}

// ---------------------------------------------------------------------------------------------
// Verify (reads only: RPC + contract address)
// ---------------------------------------------------------------------------------------------

export const BOND_INVALID_CODES = [
  "malformed-file",
  "wrong-chain",
  "wrong-contract",
  "id-mismatch",
  "changed-value",
  "no-code",
  "not-a-bonds-contract",
  "not-recorded",
  "not-canonical",
  "tx-not-found",
  "tx-failed",
  "tx-wrong-block",
  "no-event",
  "event-mismatch",
] as const;
export type BondInvalidCode = (typeof BOND_INVALID_CODES)[number];

export const BOND_INVALID_PHRASE: Record<BondInvalidCode, string> = {
  "malformed-file": "malformed fact file",
  "wrong-chain": "wrong chain",
  "wrong-contract": "wrong contract",
  "id-mismatch": "id does not recompute",
  "changed-value": "changed value",
  "no-code": "no contract code",
  "not-a-bonds-contract": "not a FidelityBonds contract",
  "not-recorded": "not recorded",
  "not-canonical": "recording block is not canonical",
  "tx-not-found": "recording transaction does not exist",
  "tx-failed": "recording transaction failed",
  "tx-wrong-block": "recording transaction is in another block",
  "no-event": "no matching event",
  "event-mismatch": "event does not match",
};

class Invalid extends Error {
  constructor(
    readonly code: BondInvalidCode,
    detail: string,
  ) {
    super(`${BOND_INVALID_PHRASE[code]}: ${detail}`);
  }
}

export type BondVerifyResult =
  | { valid: true; file: BondFactFile; stage: HemiStage; stored: StoredBond }
  | { valid: false; code: BondInvalidCode; reason: string };

const show = (v: unknown): string => (typeof v === "bigint" ? v.toString() : String(v));

function compare(label: string, pairs: [string, unknown, unknown][], code: BondInvalidCode, side: [string, string]): void {
  for (const [n, a, b] of pairs) {
    const x = typeof a === "string" ? a.toLowerCase() : a;
    const y = typeof b === "string" ? b.toLowerCase() : b;
    if (x !== y) throw new Invalid(code, `${label}${n} is ${show(a)} ${side[0]} but ${show(b)} ${side[1]}`);
  }
}

/** The file must agree with itself before anything is read: the witness script fixes the program and the locktime. */
function selfCheck(f: BondFactFile): void {
  let parsed: { locktime: number };
  try {
    parsed = parseBondWitnessScript(toBytes(f.fact.witnessScript));
  } catch (error) {
    throw new Invalid("changed-value", `fact.witnessScript: ${(error as Error).message}`);
  }
  if (lower(sha256(f.fact.witnessScript)) !== lower(f.fact.witnessProgram)) {
    throw new Invalid("changed-value", "fact.witnessScript does not hash (sha256) to fact.witnessProgram");
  }
  if (parsed.locktime !== f.fact.locktime) {
    throw new Invalid("changed-value", `fact.locktime is ${f.fact.locktime}, the witness script says ${parsed.locktime}`);
  }
  const recomputed = bondId(f.fact.txid, f.fact.vout);
  if (lower(recomputed) !== lower(f.id)) throw new Invalid("id-mismatch", `the file's txid and vout give ${recomputed}, the file says ${f.id}`);
}

async function readStoredOrInvalid(client: PublicClient, contract: Address, id: Hex, options: VerifyOptions): Promise<StoredBond> {
  const code = await client.getCode({ address: contract });
  if (!code || code === "0x") throw new Invalid("no-code", `there is no contract at ${contract}`);
  if (!options.allowOtherCode && !sameCode(code, FIDELITY_BONDS_RUNTIMES)) {
    throw new Invalid("not-a-bonds-contract", `the code at ${contract} is not this SDK's FidelityBonds (${OTHER_CODE})`);
  }
  let stored: StoredBond | null;
  try {
    stored = await readStoredBond(client, contract, id);
  } catch (error) {
    const notOurs =
      error instanceof BaseError &&
      error.walk(
        (e) =>
          e instanceof Error &&
          (e.name === "ContractFunctionRevertedError" || e.name === "ContractFunctionZeroDataError" || e.name.startsWith("AbiDecoding")),
      ) !== null;
    if (notOurs) throw new Invalid("not-a-bonds-contract", `${contract} does not answer bond(bytes32)`);
    throw error;
  }
  if (!stored) throw new Invalid("not-recorded", `no bond with id ${id} is stored at ${contract}`);
  const recomputed = bondId(stored.txid, stored.vout);
  if (lower(recomputed) !== lower(id)) throw new Invalid("id-mismatch", `the bond stored under ${id} gives ${recomputed}`);
  return stored;
}

function fileVsStored(f: BondFactFile, s: StoredBond): [string, unknown, unknown][] {
  return [
    ["fact.agent", f.fact.agent, s.agent],
    ["fact.txid", f.fact.txid, s.txid],
    ["fact.vout", f.fact.vout, s.vout],
    ["fact.tagVout", f.fact.tagVout, s.tagVout],
    ["fact.sats", f.fact.sats, s.sats],
    ["fact.locktime", f.fact.locktime, s.locktime],
    ["fact.witnessProgram", f.fact.witnessProgram, s.witnessProgram],
    ["fact.confirmations", f.fact.confirmations, s.confirmations],
    ["asOf.btcHeight", f.asOf.btcHeight, s.btcHeight],
    ["asOf.btcBlockHash", f.asOf.btcBlockHash, s.btcBlockHash],
    ["recording.blockNumber", f.recording.blockNumber, s.hemiBlock],
  ];
}

function storedVsEvent(s: StoredBond, e: RecordedEvent, id: Hex): [string, unknown, unknown][] {
  return [
    ["bondId", id, e.bondId],
    ["agent", s.agent, e.agent],
    ["txid", s.txid, e.txid],
    ["vout", s.vout, e.vout],
    ["tagVout", s.tagVout, e.tagVout],
    ["sats", s.sats, e.sats],
    ["locktime", s.locktime, e.locktime],
    ["witnessProgram", s.witnessProgram, e.witnessProgram],
    ["confirmations", s.confirmations, e.confirmations],
    ["btcHeight", s.btcHeight, e.btcHeight],
    ["btcBlockHash", s.btcBlockHash, e.btcBlockHash],
    ["hemiBlock", s.hemiBlock, e.hemiBlock],
    ["witnessScript hash", s.witnessProgram, sha256(e.witnessScript)],
  ];
}

async function checkRecording(
  client: PublicClient,
  contract: Address,
  id: Hex,
  stored: StoredBond,
  recording: BondFactFile["recording"],
  fileScript: Hex | undefined,
): Promise<HemiStage> {
  const block = await client.getBlock({ blockNumber: recording.blockNumber }).catch(() => null);
  if (!block) throw new Invalid("not-canonical", `this chain has no block ${recording.blockNumber}`);
  if (lower(block.hash ?? "0x") !== lower(recording.blockHash)) {
    throw new Invalid("not-canonical", `block ${recording.blockNumber} is now ${block.hash}, the bond was recorded in ${recording.blockHash}`);
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
  const event = bondEvents(receipt.logs, contract, id).recorded[0];
  if (!event) throw new Invalid("no-event", `${recording.txHash} emitted no BondRecorded event for ${id}`);
  compare("event ", storedVsEvent(stored, event, id), "event-mismatch", ["on chain", "in the event"]);
  if (fileScript !== undefined && lower(fileScript) !== lower(event.witnessScript)) {
    throw new Invalid("changed-value", `fact.witnessScript is ${fileScript} in the file but ${event.witnessScript} in the event`);
  }
  return hemiStage(client, recording.blockNumber);
}

function invalid(error: unknown): BondVerifyResult {
  if (error instanceof Invalid) return { valid: false, code: error.code, reason: error.message };
  throw error;
}

/** Verifies a bond fact file (its parsed JSON) against `contract`, as docs/SCHEMA.md says. Never trusts the file. */
export async function verifyBondFile(client: PublicClient, contract: Address, input: unknown, options: VerifyOptions = {}): Promise<BondVerifyResult> {
  const parsed = parseBondFactFile(input);
  if (!parsed.ok) return { valid: false, code: "malformed-file", reason: `${BOND_INVALID_PHRASE["malformed-file"]}: ${parsed.errors.join("; ")}` };
  const file = parsed.file;
  try {
    const chainId = await client.getChainId();
    if (file.chainId !== chainId) throw new Invalid("wrong-chain", `the file is for chain ${file.chainId}, the RPC serves chain ${chainId}`);
    if (lower(file.contract) !== lower(contract)) throw new Invalid("wrong-contract", `the file names ${file.contract}, verifying against ${lower(contract)}`);
    selfCheck(file);
    const stored = await readStoredOrInvalid(client, contract, file.id, options);
    compare("", fileVsStored(file, stored), "changed-value", ["in the file", "on chain"]);
    const stage = await checkRecording(client, contract, file.id, stored, file.recording, file.fact.witnessScript);
    return { valid: true, file, stage, stored };
  } catch (error) {
    return invalid(error);
  }
}

/** Verifies the bond stored under `id`: the same checks, with the recording found by a one-block getLogs. */
export async function verifyBondId(client: PublicClient, contract: Address, id: Hex, options: VerifyOptions = {}): Promise<BondVerifyResult> {
  try {
    const chainId = await client.getChainId();
    const stored = await readStoredOrInvalid(client, contract, id, options);
    const located = await locateRecording(client, contract, id, stored);
    if (!located) throw new Invalid("no-event", `no BondRecorded event for ${id} in Hemi block ${stored.hemiBlock}`);
    const stage = await checkRecording(client, contract, id, stored, located.recording, undefined);
    return { valid: true, file: fileFromRecording(chainId, contract, id, stored, located.event, located.recording), stage, stored };
  } catch (error) {
    return invalid(error);
  }
}

/** The BondEnded event of a stored ended bond (one getLogs over the Hemi block that ended it). */
export async function endedEvent(client: PublicClient, contract: Address, id: Hex, stored: StoredBond): Promise<EndedEvent | undefined> {
  if (stored.endedHemiBlock === 0n) return undefined;
  const logs = await client.getLogs({ address: contract, fromBlock: stored.endedHemiBlock, toBlock: stored.endedHemiBlock });
  return bondEvents(logs, contract, id).ended[0];
}
