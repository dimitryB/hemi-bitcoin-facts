/**
 * The Bitcoin half of a bond: create (fund the bond and its tag in one transaction) and redeem (spend it back after
 * the locktime), and the bond file that carries what redeem and record need. The CLI (`hbf bond create|redeem`)
 * and the regtest gate both run these functions; only the backend differs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { UsageError } from "../common.js";
import type { BtcBackend } from "./backend.js";
import type { BtcKey } from "./keys.js";
import { isBtcNet, type BtcNet } from "./networks.js";
import {
  bondAddress,
  bondOutputScript,
  bondWitnessScript,
  hex,
  isBondLocktime,
  MIN_SATS,
  parseBondWitnessScript,
  tagScript,
} from "./script.js";
import { assertFeeRate, buildFundingTx, buildRedeemTx, decodeTx, DEFAULT_MAX_FEE_RATE, type FundingTx, type RedeemTx } from "./tx.js";

// ---------------------------------------------------------------------------------------------
// Caps (Bitcoin mainnet), checked before any key is read or any request is made
// ---------------------------------------------------------------------------------------------

/** The live-bond limits in docs/BRIEF.md "Definition of done": at most 20,000 sats for at most 24 hours. */
export const MAINNET_MAX_SATS = 20_000n;
export const MAINNET_MAX_LOCK_SECONDS = 24 * 3600;

export interface CreateParams {
  network: BtcNet;
  chainId: number;
  contract: Address;
  agent: Address;
  sats: bigint;
  locktime: number;
  /** Broadcasting on Bitcoin mainnet needs this (`--allow-mainnet` on `bond create` / `bond redeem`). */
  allowMainnet?: boolean;
  /** Lifts the mainnet amount and duration caps (`--override-caps`). */
  overrideCaps?: boolean;
  dryRun?: boolean;
  /** Seconds since the epoch; for tests. */
  now?: number;
}

/** Every refusal `bond create` makes without touching a key or the network. Throws a UsageError. */
export function assertCreateAllowed(p: CreateParams): void {
  const now = p.now ?? Math.floor(Date.now() / 1000);
  // What FidelityBonds.tagScript and checkBond refuse, refused before any key or RPC (pre-mainnet audit I-5).
  if (!isAddress(p.agent) || BigInt(p.agent) === 0n) throw new UsageError("--agent must be a nonzero EVM address: a bond tagged for the zero agent can never be recorded");
  if (!Number.isInteger(p.chainId) || p.chainId < 0 || p.chainId > 0xffffffff) {
    throw new UsageError(`chain id ${p.chainId} does not fit in the tag's 4 bytes: a bond tagged for it can never be recorded`);
  }
  if (!isBondLocktime(p.locktime)) {
    throw new UsageError(`--locktime ${p.locktime} is not a bond locktime: a Unix time from 500000000 to 2147483647`);
  }
  if (p.locktime <= now) throw new UsageError(`--locktime ${iso(p.locktime)} is not in the future; such a bond is spendable at once`);
  if (p.sats < MIN_SATS) throw new UsageError(`--sats ${p.sats} is below FidelityBonds.MIN_SATS (${MIN_SATS}); it could not be recorded`);
  if (p.network === "mainnet") {
    if (!p.overrideCaps && p.sats > MAINNET_MAX_SATS) {
      throw new UsageError(`refusing ${p.sats} sats on Bitcoin mainnet: the cap is ${MAINNET_MAX_SATS} sats (--override-caps lifts it)`);
    }
    if (!p.overrideCaps && p.locktime > now + MAINNET_MAX_LOCK_SECONDS) {
      throw new UsageError(
        `refusing a locktime ${((p.locktime - now) / 3600).toFixed(1)} hours ahead on Bitcoin mainnet: the cap is 24 hours (--override-caps lifts it)`,
      );
    }
    if (!p.dryRun && !p.allowMainnet) {
      throw new UsageError("refusing to broadcast on Bitcoin mainnet without --allow-mainnet (this flag is for Bitcoin; Hemi's is separate)");
    }
  }
}

export function assertRedeemAllowed(network: BtcNet, allowMainnet: boolean | undefined, dryRun: boolean | undefined): void {
  if (network === "mainnet" && !dryRun && !allowMainnet) {
    throw new UsageError("refusing to broadcast on Bitcoin mainnet without --allow-mainnet (this flag is for Bitcoin; Hemi's is separate)");
  }
}

export const iso = (t: number): string => new Date(t * 1000).toISOString().replace(".000Z", "Z");

// ---------------------------------------------------------------------------------------------
// Bond file: what create writes and redeem and record read. Public data only (no key).
// ---------------------------------------------------------------------------------------------

export const BOND_FILE_SCHEMA = "hemi-bitcoin-facts/bond-file/v1";

export interface BondFile {
  schema: typeof BOND_FILE_SCHEMA;
  network: BtcNet;
  chainId: number;
  contract: Address;
  agent: Address;
  /** Display order. */
  txid: Hex;
  bondVout: number;
  tagVout: number;
  sats: bigint;
  locktime: number;
  pubkey: Hex;
  witnessScript: Hex;
  bondScript: Hex;
  bondAddress: string;
  tagScript: Hex;
  fundingAddress: string;
  fee: bigint;
  feeRate: number;
  /** The signed funding transaction. */
  hex: Hex;
}

export function bondFileJson(f: BondFile): Record<string, string> {
  return {
    schema: f.schema,
    network: f.network,
    chainId: String(f.chainId),
    contract: f.contract.toLowerCase(),
    agent: f.agent.toLowerCase(),
    txid: f.txid.toLowerCase(),
    bondVout: String(f.bondVout),
    tagVout: String(f.tagVout),
    sats: f.sats.toString(),
    locktime: String(f.locktime),
    locktimeIso: iso(f.locktime),
    pubkey: f.pubkey.toLowerCase(),
    witnessScript: f.witnessScript.toLowerCase(),
    bondScript: f.bondScript.toLowerCase(),
    bondAddress: f.bondAddress,
    tagScript: f.tagScript.toLowerCase(),
    fundingAddress: f.fundingAddress,
    fee: f.fee.toString(),
    feeRate: String(f.feeRate),
    hex: f.hex.toLowerCase(),
  };
}

export function writeBondFile(path: string, f: BondFile): void {
  writeFileSync(path, `${JSON.stringify(bondFileJson(f), null, 2)}\n`);
}

/** Reads a bond file and checks it agrees with itself (scripts, address and locktime recompute). */
export function readBondFile(path: string): BondFile {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new UsageError(`cannot read bond file ${path}: ${(error as Error).message}`);
  }
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== "string") throw new UsageError(`bond file ${path}: ${k} is missing`);
    return v;
  };
  const int = (k: string): number => {
    const v = str(k);
    if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new UsageError(`bond file ${path}: ${k} must be a decimal string`);
    return Number(v);
  };
  const hx = (k: string, bytes?: number): Hex => {
    const v = str(k);
    if (!isHex(v) || (bytes !== undefined && v.length !== 2 + 2 * bytes)) throw new UsageError(`bond file ${path}: ${k} must be hex`);
    return v;
  };
  const uint = (k: string, min = 0n): bigint => {
    const v = str(k);
    if (!/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) < min) throw new UsageError(`bond file ${path}: ${k} must be a decimal string of at least ${min}`);
    return BigInt(v);
  };
  if (str("schema") !== BOND_FILE_SCHEMA) throw new UsageError(`bond file ${path}: schema must be ${BOND_FILE_SCHEMA}`);
  const network = str("network");
  if (!isBtcNet(network)) throw new UsageError(`bond file ${path}: unknown network ${network}`);
  const contract = str("contract");
  const agent = str("agent");
  if (!isAddress(contract) || !isAddress(agent)) throw new UsageError(`bond file ${path}: contract and agent must be addresses`);
  const f: BondFile = {
    schema: BOND_FILE_SCHEMA,
    network,
    chainId: int("chainId"),
    contract: getAddress(contract),
    agent: getAddress(agent),
    txid: hx("txid", 32),
    bondVout: int("bondVout"),
    tagVout: int("tagVout"),
    sats: uint("sats", 1n),
    locktime: int("locktime"),
    pubkey: hx("pubkey", 33),
    witnessScript: hx("witnessScript", 42),
    bondScript: hx("bondScript", 34),
    bondAddress: str("bondAddress"),
    tagScript: hx("tagScript", 50),
    fundingAddress: str("fundingAddress"),
    fee: uint("fee"),
    feeRate: Number(str("feeRate")),
    hex: hx("hex"),
  };
  const ws = Buffer.from(f.witnessScript.slice(2), "hex");
  const parsed = parseBondWitnessScript(ws);
  const problems: string[] = [];
  if (parsed.locktime !== f.locktime) problems.push("locktime differs from the witness script's");
  if (hex(parsed.pubkey) !== f.pubkey.toLowerCase()) problems.push("pubkey differs from the witness script's");
  if (hex(bondOutputScript(ws)) !== f.bondScript.toLowerCase()) problems.push("bondScript is not 0x0020 ‖ sha256(witnessScript)");
  if (bondAddress(ws, f.network) !== f.bondAddress) problems.push("bondAddress does not encode bondScript");
  let tag: Uint8Array | undefined;
  try {
    tag = tagScript(f.chainId, f.contract, f.agent);
  } catch (error) {
    problems.push(`no tag can name chainId, contract and agent: ${(error as Error).message}`);
  }
  if (tag && hex(tag) !== f.tagScript.toLowerCase()) problems.push("tagScript does not name chainId, contract and agent");
  if (!Number.isFinite(f.feeRate) || f.feeRate <= 0) problems.push("feeRate is not a positive number");
  // The funding transaction itself must be the bond the file describes (pre-mainnet audit I-6).
  let funding: ReturnType<typeof decodeTx> | undefined;
  try {
    funding = decodeTx(f.hex.slice(2));
  } catch (error) {
    problems.push(`hex does not decode as a transaction (${(error as Error).message})`);
  }
  if (funding) {
    if (funding.txid !== bare(f.txid)) problems.push(`txid is not hex's transaction id (${funding.txid})`);
    const bond = funding.outputs[f.bondVout];
    if (!bond || bond.sats !== f.sats || hex(bond.script) !== f.bondScript.toLowerCase()) problems.push("hex's output bondVout is not sats paid to bondScript");
    const tagOut = funding.outputs[f.tagVout];
    if (f.tagVout === f.bondVout || !tagOut || tagOut.sats !== 0n || hex(tagOut.script) !== f.tagScript.toLowerCase()) {
      problems.push("hex's output tagVout is not the zero-value tagScript");
    }
  }
  if (problems.length) throw new UsageError(`bond file ${path} disagrees with itself: ${problems.join("; ")}`);
  return f;
}

/** The display-order txid without 0x, as Bitcoin tools print it. */
export const bare = (txid: Hex | string): string => txid.replace(/^0x/, "").toLowerCase();

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export interface CreateOptions extends CreateParams {
  backend: BtcBackend;
  key: BtcKey;
  /** The key the bond locks to (33 bytes, compressed); defaults to the funding key's. */
  bondPubkey?: Uint8Array;
  feeRate?: number;
  maxFeeRate?: number;
  /** Called with the bond file after signing and before broadcasting (the CLI writes it to disk here). */
  beforeBroadcast?: (file: BondFile, tx: FundingTx) => void;
}

export interface CreateResult {
  file: BondFile;
  tx: FundingTx;
  broadcast: boolean;
}

/**
 * Builds, signs and (unless dry-run) broadcasts a bond's funding transaction. This library function does not check
 * that a FidelityBonds contract is deployed at `o.contract`: the `hbf bond create` command does that first (its
 * registry check, independent audit finding 2). A caller using this directly should check it the same way, since a
 * bond tagged for an address without the contract can never be recorded.
 */
export async function createBond(o: CreateOptions): Promise<CreateResult> {
  assertCreateAllowed(o);
  if (o.backend.network !== o.network || o.key.network !== o.network) throw new Error("backend, key and bond networks differ");
  const pubkey = o.bondPubkey ?? o.key.publicKey;
  const witnessScript = bondWitnessScript(o.locktime, pubkey);
  const tag = tagScript(o.chainId, o.contract, o.agent);
  const feeRate = o.feeRate ?? (await o.backend.feeRate(3));
  assertFeeRate(feeRate, o.maxFeeRate ?? DEFAULT_MAX_FEE_RATE);
  const utxos = await o.backend.utxos(o.key.address);
  if (utxos.length === 0) throw new Error(`no confirmed UTXOs at ${o.key.address} (${o.backend.name})`);
  const tx = buildFundingTx(o.key, utxos, { sats: o.sats, witnessScript, tag, feeRate });
  const file: BondFile = {
    schema: BOND_FILE_SCHEMA,
    network: o.network,
    chainId: o.chainId,
    contract: getAddress(o.contract),
    agent: getAddress(o.agent),
    txid: `0x${tx.txid}`,
    bondVout: tx.bondVout,
    tagVout: tx.tagVout,
    sats: o.sats,
    locktime: o.locktime,
    pubkey: hex(pubkey),
    witnessScript: hex(witnessScript),
    bondScript: hex(bondOutputScript(witnessScript)),
    bondAddress: bondAddress(witnessScript, o.network),
    tagScript: hex(tag),
    fundingAddress: o.key.address,
    fee: tx.fee,
    feeRate,
    hex: `0x${tx.hex}`,
  };
  o.beforeBroadcast?.(file, tx);
  if (o.dryRun) return { file, tx, broadcast: false };
  const reported = await o.backend.broadcast(tx.hex);
  if (reported.toLowerCase() !== tx.txid) throw new Error(`${o.backend.name} reported txid ${reported}, expected ${tx.txid}`);
  return { file, tx, broadcast: true };
}

// ---------------------------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------------------------

/** The node's median time past has not passed the locktime: Bitcoin would refuse the redeem as non-final. */
export class NotYetRedeemable extends Error {
  constructor(
    readonly medianTime: number,
    readonly locktime: number,
  ) {
    super(
      `not yet redeemable: the median time past is ${iso(medianTime)}, and Bitcoin accepts the redeem only once it is ` +
        `after the locktime ${iso(locktime)} (${Math.ceil((locktime - medianTime + 1) / 60)} more minutes of median time)`,
    );
    this.name = "NotYetRedeemable";
  }
}

export interface RedeemOptions {
  backend: BtcBackend;
  key: BtcKey;
  bond: { network: BtcNet; txid: Hex; bondVout: number; sats: bigint; witnessScript: Hex; locktime: number };
  to: string;
  feeRate?: number;
  maxFeeRate?: number;
  allowMainnet?: boolean;
  /** Broadcast even when the node's median time past says it is too early (the node will refuse it). */
  skipLocktimeCheck?: boolean;
  dryRun?: boolean;
}

export interface RedeemResult {
  tx: RedeemTx;
  broadcast: boolean;
  medianTime: number;
}

export async function redeemBond(o: RedeemOptions): Promise<RedeemResult> {
  assertRedeemAllowed(o.bond.network, o.allowMainnet, o.dryRun);
  if (o.backend.network !== o.bond.network || o.key.network !== o.bond.network) throw new Error("backend, key and bond networks differ");
  const txid = bare(o.bond.txid);
  const spent = await o.backend.outputSpent(txid, o.bond.bondVout);
  if (spent === true) throw new Error(`the bond output ${txid}:${o.bond.bondVout} is already spent`);
  const tip = await o.backend.tip();
  if (!o.skipLocktimeCheck && !(tip.medianTime > o.bond.locktime)) throw new NotYetRedeemable(tip.medianTime, o.bond.locktime);
  const feeRate = o.feeRate ?? (await o.backend.feeRate(6));
  assertFeeRate(feeRate, o.maxFeeRate ?? DEFAULT_MAX_FEE_RATE);
  const tx = buildRedeemTx({
    txid,
    vout: o.bond.bondVout,
    sats: o.bond.sats,
    witnessScript: Buffer.from(o.bond.witnessScript.slice(2), "hex"),
    privateKey: o.key.privateKey,
    to: o.to,
    network: o.bond.network,
    feeRate,
  });
  if (o.dryRun) return { tx, broadcast: false, medianTime: tip.medianTime };
  const reported = await o.backend.broadcast(tx.hex);
  if (reported.toLowerCase() !== tx.txid) throw new Error(`${o.backend.name} reported txid ${reported}, expected ${tx.txid}`);
  return { tx, broadcast: true, medianTime: tip.medianTime };
}
