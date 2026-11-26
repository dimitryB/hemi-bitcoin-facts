import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
  parseEventLogs,
  recoverTypedDataAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { receiptRegistryAbi } from "./abi.js";
import { createHemiPublicClient, type HemiClientOptions } from "./client.js";
import { hashManifest, validateManifest, type ManifestV1 } from "./manifest.js";
import { verifyMerkleProof } from "./merkle.js";
import { isCanonicalEcdsaSignature, leafHash, receiptTypedData, registryDomain, type ReceiptFields } from "./receipt.js";
import { defaultFinalityReader } from "./finality.js";
import { resolveStatus, type FinalityReader } from "./status.js";
import type { Anchor, ReceiptFile, StatusInfo } from "./types.js";

/**
 * Verifies a receipt file with nothing but an RPC and the registry address the verifier
 * trusts. Never contacts the receipts service. Each check below is reported by name.
 */
export const VERIFY_CHECKS = [
  /** The file is a well-formed hemi-agent-receipt v1. */
  "file",
  /** The registry the caller trusts equals the file's (the trust root comes from the caller). */
  "registry",
  /** The RPC serves the chain the file names (and the caller's chainId, if given). */
  "chainId",
  /** The manifest (file or option) validates, re-hashes to manifestHash and matches the receipt. Skipped when there is none. */
  "manifest",
  /** The EIP-712 Receipt signature is by receipt.agent or receipt.principal (ECDSA, else EIP-1271/6492). */
  "agentSignature",
  /** The file has an anchor (null means not anchored yet), and it is well-formed for its mode. */
  "anchor",
  /** The leaf and proof hash to the anchor's root, computed locally. */
  "merkleProof",
  /** The batch exists on chain, is not voided, and has the anchor's root and the receipt's schemaVersion. */
  "batch",
  /** registry.verifyReceipt(batchId, receipt, proof) is true. */
  "onchainProof",
  /** The BatchAttested log at Batch.blockNumber came from anchor.txHash, and that tx succeeded. */
  "anchorTx",
  /** The finality stage could be read (resolveStatus), and the block it was read for still carries the anchor (a reorg fails this). */
  "status",
  /**
   * The manifest's spend entries that name a transaction on the receipt's own chain agree with
   * it (see SpendCheck). Fails when the chain contradicts one. Skipped when there is no checked
   * manifest or no entry can be compared with the chain.
   */
  "spend",
] as const;

export type VerifyCheck = (typeof VERIFY_CHECKS)[number];
export type CheckOutcome = "pass" | "fail" | "skip";

/**
 * What the chain says about one spend entry. Only `contradicted` makes a receipt invalid.
 * - `confirmed`: the transaction succeeded and moved exactly `amount` of the asset from the
 *   agent or the principal.
 * - `unattributed`: it moved exactly `amount` of the asset, but from another address. The payment
 *   happened; nothing ties it to this run.
 * - `contradicted`: there is no such transaction, it reverted, or it moved no `amount` of the asset.
 * - `unchecked`: nothing on this chain to compare: no txHash, an asset that is not a token on
 *   this chain, or native ETH moved inside a contract call.
 * - `undetermined`: the RPC failed, or the transaction is not mined yet.
 */
export type SpendOutcome = "confirmed" | "unattributed" | "contradicted" | "unchecked" | "undetermined";

export interface SpendCheck {
  /** Position in the manifest's spend list. */
  index: number;
  asset: string;
  amount: string;
  txHash: Hex | null;
  outcome: SpendOutcome;
  /** Where the matching transfer came from, when one was found. */
  payer?: Address;
  /** The block that holds the transaction, when it was found mined. */
  blockNumber?: number;
  /** What was found, or why the entry was not compared. */
  detail: string;
}

/** At most this many distinct spend transactions are read per receipt; entries naming more are reported unchecked. */
export const MAX_SPEND_TXS = 100;

export interface VerifyProblem {
  check: VerifyCheck;
  /** Stable machine-readable code, e.g. "manifest-hash-mismatch". */
  code: string;
  message: string;
}

export interface VerifyOptions {
  /** The ReceiptRegistry the verifier trusts. Required: never taken from the file. */
  registry: Address;
  /** RPC to read the chain from. Defaults to the Hemi network's RPCs for the file's chainId. */
  rpcUrl?: string;
  rpcUrls?: string[];
  /** A ready client; overrides rpcUrl(s). */
  client?: PublicClient;
  /** Tuning for the client verify builds (retries, rate limit, timeouts). */
  clientOptions?: Omit<HemiClientOptions, "chainId" | "rpcUrls">;
  /** The chain the verifier expects. When given, the file's chainId must equal it. */
  chainId?: number;
  /** A manifest to check instead of the file's own. */
  manifest?: unknown;
  /** Hemi confirmations for `hemi-confirmed`. Default 10. */
  confirmations?: number;
  /**
   * Bitcoin finality source. Default: defaultFinalityReader(file chainId): PoP data from Bitcoin
   * (Esplora) on Hemi mainnet, the PoP liveness gate on testnet, "unavailable" on other chains.
   * Pass unavailableFinality to skip Bitcoin entirely.
   */
  finality?: FinalityReader;
}

export interface VerifyResult {
  /** True only when every check passed (the manifest and spend checks may be skipped). */
  valid: boolean;
  /**
   * True when every check except `spend` passed: the receipt is genuine, signed and anchored.
   * With `valid` false, it is only what the manifest says was spent that does not hold.
   */
  authentic: boolean;
  /** One entry per spend item of the checked manifest; empty when there is none or it did not check out. */
  spend: SpendCheck[];
  /** Finality of the anchoring block; `pending` when not anchored, `voided` for a voided batch, null when unknown. */
  status: StatusInfo | null;
  /** The transaction that emitted BatchAttested for this batch, as read from the chain. */
  batchTx: Hex | null;
  leaf: Hex | null;
  /** Human-readable reasons, one per problem. */
  reasons: string[];
  problems: VerifyProblem[];
  checks: Record<VerifyCheck, CheckOutcome>;
  /** Who signed the receipt, when the signature check passed. */
  signer: { address: Address; role: "agent" | "principal"; method: "ecdsa" | "eip1271" } | null;
  /**
   * True when an RPC failure stopped a check from completing, or the chain changed under it, and
   * nothing else has ruled the receipt out: it might still be valid.
   */
  incomplete: boolean;
}

const BYTES32_ANY = /^0x[0-9a-fA-F]{64}$/;
/** Problems that do not rule a receipt out: the chain did not answer or changed, or it is not anchored yet. */
const UNDECIDED_CODES = new Set(["rpc-error", "anchor-reorged", "not-anchored", "spend-tx-pending"]);
/** A CAIP-19 id this check can read: an ERC-20 token, or native ETH (slip44:60), on an eip155 chain. */
const CAIP19_EVM = /^eip155:([1-9][0-9]{0,15})\/(?:erc20:(0x[0-9a-fA-F]{40})|slip44:60)$/;
const WHOLE = /^(0|[1-9][0-9]*)$/;
const ADDRESS_ANY = /^0x[0-9a-fA-F]{40}$/;
const HEX_ANY = /^0x([0-9a-fA-F]{2})+$/;
const ERC6492_SUFFIX = "6492649264926492649264926492649264926492649264926492649264926492";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isUint = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const lower = <T extends string>(v: T): T => v.toLowerCase() as T;
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export type ReceiptFileParse = { ok: true; file: ReceiptFile } | { ok: false; errors: string[] };

/**
 * Checks the shape of a receipt file (docs/SCHEMA.md §2) and returns a copy with hex and
 * addresses lowercased. Unknown members (such as the service's `status`) are dropped.
 */
export function parseReceiptFile(input: unknown): ReceiptFileParse {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["receipt file must be a JSON object"] };
  if (input.format !== "hemi-agent-receipt") errors.push(`format: expected "hemi-agent-receipt", got ${JSON.stringify(input.format)}`);
  if (input.formatVersion !== 1) errors.push(`formatVersion: expected 1, got ${JSON.stringify(input.formatVersion)}`);
  if (!isUint(input.chainId) || input.chainId === 0) errors.push("chainId: must be a positive integer");
  if (typeof input.registry !== "string" || !ADDRESS_ANY.test(input.registry)) errors.push("registry: must be a 20-byte 0x address");
  const r = input.receipt;
  if (!isObj(r)) errors.push("receipt: must be an object with runId, manifestHash, agent, principal, schemaVersion");
  else {
    for (const key of ["runId", "manifestHash"]) if (typeof r[key] !== "string" || !BYTES32_ANY.test(r[key] as string)) errors.push(`receipt.${key}: must be 32-byte 0x hex`);
    for (const key of ["agent", "principal"]) if (typeof r[key] !== "string" || !ADDRESS_ANY.test(r[key] as string)) errors.push(`receipt.${key}: must be a 20-byte 0x address`);
    if (!isUint(r.schemaVersion, 0xffff) || r.schemaVersion === 0) errors.push("receipt.schemaVersion: must be an integer from 1 to 65535");
  }
  if (typeof input.agentSignature !== "string" || !HEX_ANY.test(input.agentSignature)) errors.push("agentSignature: must be 0x hex bytes");
  const a = input.anchor;
  if (a !== null) {
    if (!isObj(a)) errors.push("anchor: must be an object, or null while pending");
    else {
      if (a.mode !== "batch" && a.mode !== "direct") errors.push(`anchor.mode: must be "batch" or "direct", got ${JSON.stringify(a.mode)}`);
      if (!isUint(a.batchId) || a.batchId === 0) errors.push("anchor.batchId: must be a positive integer");
      if (typeof a.root !== "string" || !BYTES32_ANY.test(a.root)) errors.push("anchor.root: must be 32-byte 0x hex");
      if (!Array.isArray(a.proof) || !a.proof.every((p) => typeof p === "string" && BYTES32_ANY.test(p))) errors.push("anchor.proof: must be an array of 32-byte 0x hex");
      if (typeof a.txHash !== "string" || !BYTES32_ANY.test(a.txHash)) errors.push("anchor.txHash: must be 32-byte 0x hex");
      if (!isUint(a.blockNumber)) errors.push("anchor.blockNumber: must be a non-negative integer");
    }
  }
  if (input.manifest !== undefined && !isObj(input.manifest)) errors.push("manifest: must be an object when present");
  if (errors.length) return { ok: false, errors };

  const receipt = r as unknown as ReceiptFields;
  const anchor = a as Anchor | null;
  const file: ReceiptFile = {
    format: "hemi-agent-receipt",
    formatVersion: 1,
    chainId: input.chainId as number,
    registry: lower(input.registry as Address),
    receipt: {
      runId: lower(receipt.runId),
      manifestHash: lower(receipt.manifestHash),
      agent: lower(receipt.agent),
      principal: lower(receipt.principal),
      schemaVersion: receipt.schemaVersion,
    },
    agentSignature: lower(input.agentSignature as Hex),
    anchor: anchor && {
      mode: anchor.mode,
      batchId: anchor.batchId,
      root: lower(anchor.root),
      proof: anchor.proof.map(lower),
      txHash: lower(anchor.txHash),
      blockNumber: anchor.blockNumber,
    },
  };
  if (input.manifest !== undefined) file.manifest = input.manifest as unknown as ReceiptFile["manifest"];
  return { ok: true, file };
}

type ReadError = { kind: "revert"; name?: string; message: string } | { kind: "no-data"; message: string } | { kind: "rpc"; message: string };

function classify(error: unknown): ReadError {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof ContractFunctionZeroDataError)) return { kind: "no-data", message: error.shortMessage };
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    // A revert we can name is a real answer from the contract. One without data may be a
    // transport-level -32603 that viem reports as a revert, so treat it as an RPC failure.
    if (revert && (revert.data?.errorName || revert.reason)) {
      return { kind: "revert", name: revert.data?.errorName ?? revert.reason, message: revert.shortMessage };
    }
    return { kind: "rpc", message: error.shortMessage };
  }
  return { kind: "rpc", message: error instanceof Error ? error.message : String(error) };
}

type SpendTx =
  | { kind: "missing" }
  | { kind: "pending" }
  | { kind: "mined"; success: boolean; blockNumber: number; logs: Log[]; from: Address; value?: bigint }
  | { kind: "error"; error: unknown };

const notFound = (error: unknown, type: typeof TransactionNotFoundError | typeof TransactionReceiptNotFoundError): boolean =>
  error instanceof BaseError && !!error.walk((e) => e instanceof type);

/** A spend transaction as the chain has it. `withValue` also reads the transaction for its ETH value. */
async function readSpendTx(client: PublicClient, hash: Hex, withValue: boolean): Promise<SpendTx> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (!notFound(error, TransactionReceiptNotFoundError)) return { kind: "error", error };
    // No receipt: either never sent, or still waiting in a mempool.
    try {
      const tx = await client.getTransaction({ hash });
      if (tx.blockNumber === null) return { kind: "pending" };
      return { kind: "error", error: new Error(`transaction ${hash} was mined while it was being read`) };
    } catch (error2) {
      return notFound(error2, TransactionNotFoundError) ? { kind: "missing" } : { kind: "error", error: error2 };
    }
  }
  const mined = { kind: "mined" as const, success: receipt.status === "success", blockNumber: Number(receipt.blockNumber), logs: receipt.logs, from: lower(receipt.from) };
  if (!withValue) return mined;
  try {
    return { ...mined, value: (await client.getTransaction({ hash })).value };
  } catch (error) {
    return { kind: "error", error };
  }
}

/** Verifies a receipt file. See VERIFY_CHECKS for what is checked; reasons say what failed. */
export async function verify(input: unknown, options: VerifyOptions): Promise<VerifyResult> {
  if (typeof options?.registry !== "string" || !ADDRESS_ANY.test(options.registry)) {
    throw new TypeError(`verify: options.registry must be the registry address you trust (got ${JSON.stringify(options?.registry)})`);
  }
  const checks = Object.fromEntries(VERIFY_CHECKS.map((c) => [c, "skip"])) as Record<VerifyCheck, CheckOutcome>;
  const problems: VerifyProblem[] = [];
  let incomplete = false;
  let status: StatusInfo | null = null;
  let batchTx: Hex | null = null;
  let leaf: Hex | null = null;
  let signer: VerifyResult["signer"] = null;
  let checkedManifest: ManifestV1 | undefined;
  const spend: SpendCheck[] = [];

  const fail = (check: VerifyCheck, code: string, message: string) => {
    checks[check] = "fail";
    problems.push({ check, code, message });
  };
  const pass = (check: VerifyCheck) => {
    if (checks[check] !== "fail") checks[check] = "pass";
  };
  const rpcFail = (check: VerifyCheck, what: string, error: unknown) => {
    incomplete = true;
    fail(check, "rpc-error", `${what}: RPC failed after retries: ${classify(error).message}`);
  };
  const finish = (): VerifyResult => {
    const holds = (c: VerifyCheck) => checks[c] === "pass" || ((c === "manifest" || c === "spend") && checks[c] === "skip");
    const valid = problems.length === 0 && VERIFY_CHECKS.every(holds);
    const authentic = problems.every((p) => p.check === "spend") && VERIFY_CHECKS.every((c) => c === "spend" || holds(c));
    const undecided = incomplete && problems.every((p) => UNDECIDED_CODES.has(p.code));
    return { valid, authentic, spend, status, batchTx, leaf, reasons: problems.map((p) => p.message), problems, checks, signer, incomplete: undecided };
  };

  // file
  const parsed = parseReceiptFile(input);
  if (!parsed.ok) {
    fail("file", "file-shape", `not a valid receipt file: ${parsed.errors.join("; ")}`);
    return finish();
  }
  pass("file");
  const file = parsed.file;
  const { receipt, anchor } = file;
  const registry = lower(options.registry);
  leaf = leafHash(receipt);

  // registry: the caller's address is the trust root
  if (!sameAddress(file.registry, registry)) {
    fail("registry", "registry-mismatch", `receipt file names registry ${file.registry}, but you are verifying against registry ${registry}`);
  } else pass("registry");

  // manifest (local)
  const manifest = options.manifest !== undefined ? options.manifest : file.manifest;
  if (manifest !== undefined) {
    const source = options.manifest !== undefined ? "the manifest you supplied" : "the file's manifest";
    const validation = validateManifest(manifest);
    if (!validation.ok) {
      fail("manifest", "manifest-invalid", `${source} is not a valid v1 manifest: ${validation.errors.join("; ")}`);
    } else {
      const m = validation.manifest;
      const hash = hashManifest(m);
      if (hash !== receipt.manifestHash) {
        fail("manifest", "manifest-hash-mismatch", `manifest hash mismatch: ${source} hashes to ${hash}, receipt says ${receipt.manifestHash}`);
      }
      for (const key of ["runId", "agent", "principal"] as const) {
        if (m[key] !== receipt[key]) fail("manifest", "manifest-field-mismatch", `manifest ${key} ${m[key]} differs from receipt ${key} ${receipt[key]}`);
      }
      if (m.receiptVersion !== receipt.schemaVersion) {
        fail("manifest", "manifest-field-mismatch", `manifest receiptVersion ${m.receiptVersion} differs from receipt schemaVersion ${receipt.schemaVersion}`);
      }
      pass("manifest");
      // Only a manifest the receipt commits to says anything about this run.
      if (checks.manifest === "pass") checkedManifest = m;
    }
  }

  // anchor shape and the local Merkle proof
  if (anchor === null) {
    fail("anchor", "not-anchored", "not anchored yet: the receipt file has no anchor (the service has not put its batch on chain)");
    status = { stage: "pending", estimated: false, checkedAt: Math.floor(Date.now() / 1000) };
  } else {
    if (anchor.mode === "direct" && anchor.proof.length > 0) {
      fail("anchor", "anchor-invalid", `anchor says mode "direct" (a batch of one) but carries a ${anchor.proof.length}-element proof`);
    } else pass("anchor");
    if (verifyMerkleProof(leaf, anchor.proof, anchor.root)) pass("merkleProof");
    else {
      fail("merkleProof", "proof-local-mismatch", `proof does not verify against the anchor's root ${anchor.root}: leaf ${leaf} with this ${anchor.proof.length}-element proof hashes to a different root`);
    }
  }

  // chain
  let client: PublicClient;
  if (options.client) client = options.client;
  else {
    const rpcUrls = options.rpcUrls?.length ? options.rpcUrls : options.rpcUrl ? [options.rpcUrl] : undefined;
    client = createHemiPublicClient({ ...options.clientOptions, chainId: file.chainId, rpcUrls });
  }
  let chainOk = false;
  if (options.chainId !== undefined && options.chainId !== file.chainId) {
    fail("chainId", "chain-mismatch", `receipt is for chain ${file.chainId}, but you are verifying on chain ${options.chainId}`);
  }
  try {
    const rpcChain = await client.getChainId();
    if (rpcChain !== file.chainId) fail("chainId", "chain-mismatch", `RPC serves chain ${rpcChain}, but the receipt is for chain ${file.chainId}`);
    else if (checks.chainId !== "fail") {
      pass("chainId");
      chainOk = true;
    }
  } catch (error) {
    rpcFail("chainId", "eth_chainId", error);
  }

  // agent signature: EIP-712 domain from the file's chainId and the caller's registry
  const typed = receiptTypedData(receipt, registryDomain(file.chainId, registry));
  let recovered: Address | undefined;
  let recoverError: string | undefined;
  if (!isCanonicalEcdsaSignature(file.agentSignature)) {
    recoverError = "not a canonical ECDSA signature (ReceiptRegistry requires 65 bytes, v 27 or 28, low s)";
  } else {
    try {
      recovered = lower(await recoverTypedDataAddress({ ...typed, signature: file.agentSignature }));
    } catch (error) {
      recoverError = error instanceof BaseError ? error.shortMessage : (error as Error).message;
    }
  }
  const roleOf = (address: string): "agent" | "principal" | undefined =>
    address === receipt.agent ? "agent" : address === receipt.principal ? "principal" : undefined;
  if (recovered && roleOf(recovered)) {
    signer = { address: recovered, role: roleOf(recovered)!, method: "ecdsa" };
    pass("agentSignature");
  } else if (!chainOk) {
    if (checks.chainId === "fail" && !incomplete) {
      fail("agentSignature", "signature-mismatch", recovered
        ? `agent signature recovers to ${recovered}, expected agent ${receipt.agent} or principal ${receipt.principal} (contract-wallet signatures not checked: wrong chain)`
        : `agent signature is not a valid ECDSA signature (${recoverError}); contract-wallet signatures not checked: wrong chain`);
    } else {
      incomplete = true;
      fail("agentSignature", "rpc-error", `agent signature does not recover to agent or principal by ECDSA, and the EIP-1271 check needs the RPC, which failed`);
    }
  } else {
    const wrapped6492 = file.agentSignature.endsWith(ERC6492_SUFFIX);
    const tried: string[] = [];
    try {
      for (const address of [...new Set([receipt.agent, receipt.principal])]) {
        const code = await client.getCode({ address });
        if ((!code || code === "0x") && !wrapped6492) continue;
        tried.push(address);
        const ok = await client.verifyTypedData({ ...typed, address, signature: file.agentSignature });
        if (ok) {
          signer = { address, role: roleOf(address)!, method: "eip1271" };
          break;
        }
      }
      if (signer) pass("agentSignature");
      else {
        const ecdsa = recovered ? `agent signature recovers to ${recovered}, expected agent ${receipt.agent} or principal ${receipt.principal}` : `agent signature is not a valid ECDSA signature (${recoverError})`;
        const wallets = tried.length ? `; contract wallet${tried.length > 1 ? "s" : ""} ${tried.join(" and ")} rejected it (EIP-1271/6492)` : "; neither agent nor principal is a contract wallet";
        fail("agentSignature", "signature-mismatch", ecdsa + wallets);
      }
    } catch (error) {
      rpcFail("agentSignature", "EIP-1271 signature check", error);
    }
  }

  // The anchor, read from the chain. Runs only for an anchored receipt on the right chain.
  async function checkAnchor(anchor: Anchor): Promise<void> {
    // batch
    const batchId = BigInt(anchor.batchId);
    let batch: { root: Hex; count: number; schemaVersion: number; voided: boolean; blockNumber: bigint } | undefined;
    try {
      const b = await client.readContract({ address: registry, abi: receiptRegistryAbi, functionName: "getBatch", args: [batchId] });
      batch = { root: lower(b.root), count: b.count, schemaVersion: b.schemaVersion, voided: b.voided, blockNumber: b.blockNumber };
    } catch (error) {
      const e = classify(error);
      if (e.kind === "revert") fail("batch", "batch-unknown", `batch ${anchor.batchId} does not exist on registry ${registry} (getBatch reverted: ${e.name})`);
      else if (e.kind === "no-data") fail("batch", "registry-no-code", `no ReceiptRegistry at ${registry} on chain ${file.chainId} (getBatch returned no data)`);
      else rpcFail("batch", `getBatch(${anchor.batchId})`, error);
      return;
    }
    if (/^0x0+$/.test(batch.root) && batch.blockNumber === 0n) {
      fail("batch", "batch-unknown", `batch ${anchor.batchId} does not exist on registry ${registry}`);
      return;
    }
    if (batch.voided) {
      fail("batch", "batch-voided", `batch ${anchor.batchId} was voided by the registry owner; its receipts no longer verify`);
      status = { stage: "voided", estimated: false, checkedAt: Math.floor(Date.now() / 1000), notes: [`batch ${anchor.batchId} voided`] };
    }
    if (batch.root !== anchor.root) {
      fail("batch", "batch-root-mismatch", `batch ${anchor.batchId}'s on-chain root is ${batch.root}, but the receipt's anchor says ${anchor.root}`);
    }
    if (batch.schemaVersion !== receipt.schemaVersion) {
      fail("batch", "batch-schema-mismatch", `batch ${anchor.batchId} holds schemaVersion ${batch.schemaVersion} receipts, but this receipt is schemaVersion ${receipt.schemaVersion}`);
    }
    if (anchor.mode === "direct" && batch.count !== 1) {
      fail("batch", "batch-count-mismatch", `anchor says mode "direct" (a batch of one), but batch ${anchor.batchId} holds ${batch.count} receipts`);
    }
    pass("batch");

    // on-chain proof
    try {
      const ok = await client.readContract({
        address: registry,
        abi: receiptRegistryAbi,
        functionName: "verifyReceipt",
        args: [batchId, receipt, anchor.proof],
      });
      if (ok) pass("onchainProof");
      else if (batch.voided) fail("onchainProof", "proof-onchain-false", `registry.verifyReceipt returned false: batch ${anchor.batchId} is voided`);
      else fail("onchainProof", "proof-onchain-false", `registry.verifyReceipt returned false: proof does not verify against batch ${anchor.batchId}'s root ${batch.root}`);
    } catch (error) {
      const e = classify(error);
      if (e.kind === "rpc") rpcFail("onchainProof", "verifyReceipt", error);
      else fail("onchainProof", "proof-onchain-false", `registry.verifyReceipt(${anchor.batchId}) failed: ${e.kind === "revert" ? (e.name ?? e.message) : e.message}`);
    }

    // the anchoring transaction, found from the chain rather than trusted from the file
    let anchorBlockHash: Hex | undefined;
    try {
      const logs = await client.getContractEvents({
        address: registry,
        abi: receiptRegistryAbi,
        eventName: "BatchAttested",
        args: { batchId },
        fromBlock: batch.blockNumber,
        toBlock: batch.blockNumber,
        strict: true,
      });
      const log = logs.find((l) => l.args.batchId === batchId);
      if (!log) {
        fail("anchorTx", "anchor-tx-missing", `no BatchAttested(${anchor.batchId}) log from registry ${registry} in block ${batch.blockNumber}, where the registry says the batch was recorded`);
      } else {
        batchTx = lower(log.transactionHash);
        anchorBlockHash = log.blockHash;
        if (batchTx !== anchor.txHash) {
          fail("anchorTx", "anchor-tx-mismatch", `batch ${anchor.batchId} was anchored by tx ${batchTx}, but the receipt's anchor says tx ${anchor.txHash}`);
        }
        if (Number(batch.blockNumber) !== anchor.blockNumber) {
          fail("anchorTx", "anchor-block-mismatch", `batch ${anchor.batchId} was anchored in block ${batch.blockNumber}, but the receipt's anchor says block ${anchor.blockNumber}`);
        }
        if (lower(log.args.root) !== batch.root) {
          fail("anchorTx", "anchor-log-mismatch", `BatchAttested(${anchor.batchId}) log carries root ${log.args.root}, but getBatch says ${batch.root}`);
        }
        const txReceipt = await client.getTransactionReceipt({ hash: log.transactionHash });
        if (txReceipt.status !== "success") fail("anchorTx", "anchor-tx-failed", `anchoring tx ${batchTx} did not succeed (status ${txReceipt.status})`);
        pass("anchorTx");
      }
    } catch (error) {
      rpcFail("anchorTx", "reading the anchoring transaction", error);
    }

    // status: only for a receipt the chain actually includes
    if (!batch.voided && checks.batch === "pass" && checks.onchainProof === "pass") {
      try {
        status = await resolveStatus({
          client,
          blockNumber: batch.blockNumber,
          confirmations: options.confirmations,
          finality: options.finality ?? defaultFinalityReader(file.chainId),
          anchorBlockHash,
        });
        // resolveStatus answers `pending` here only when the block at the anchor's height no longer
        // has the hash the BatchAttested log was read from: the chain changed between two reads
        // (a reorg in progress, or RPCs behind a load balancer disagreeing). The checks above passed
        // against a view that is gone, so the receipt is not verified; it may be again once settled.
        if (status.stage === "pending") {
          incomplete = true;
          fail("status", "anchor-reorged", `${status.notes?.[0] ?? `block ${batch.blockNumber} no longer carries the anchor`}; the chain changed while verifying, so this result does not stand: verify again once the reorg settles`);
        } else pass("status");
      } catch (error) {
        rpcFail("status", "reading the finality status", error);
      }
    }
  }

  // What the run says it spent, compared with the receipt's own chain. Only a payment can be
  // checked this way: tool calls, the model, the prompt and the output stay what the signer says.
  async function checkSpend(m: ManifestV1): Promise<void> {
    const reads = new Map<string, Promise<SpendTx>>();
    const txs = new Set<Hex>();
    const roles: Record<string, "agent" | "principal"> = { [receipt.principal]: "principal", [receipt.agent]: "agent" };
    let compared = false;
    for (const [index, item] of m.spend.entries()) {
      const txHash = item.txHash ?? null;
      const entry = (outcome: SpendOutcome, detail: string, extra: Partial<SpendCheck> = {}): SpendCheck => {
        const check: SpendCheck = { index, asset: item.asset, amount: item.amount, txHash, outcome, ...extra, detail };
        spend.push(check);
        if (outcome === "confirmed" || outcome === "unattributed" || outcome === "contradicted") compared = true;
        return check;
      };
      if (!txHash) {
        entry("unchecked", "no transaction named");
        continue;
      }
      const caip = CAIP19_EVM.exec(item.asset);
      if (!caip) {
        entry("unchecked", `asset ${JSON.stringify(item.asset)} is not a CAIP-19 token or native ETH on an EVM chain, so there is nothing on chain to compare`);
        continue;
      }
      if (Number(caip[1]) !== file.chainId) {
        entry("unchecked", `the asset is on chain ${caip[1]}; only the receipt's own chain ${file.chainId} is read`);
        continue;
      }
      if (!WHOLE.test(item.amount)) {
        entry("unchecked", `amount ${item.amount} is not a whole number of base units`);
        continue;
      }
      const token = caip[2] ? lower(caip[2] as Address) : null;
      if (!txs.has(txHash) && txs.size >= MAX_SPEND_TXS) {
        entry("unchecked", `the manifest names more than ${MAX_SPEND_TXS} spend transactions; only the first ${MAX_SPEND_TXS} are read`);
        continue;
      }
      txs.add(txHash);
      const key = `${txHash}:${token === null}`;
      if (!reads.has(key)) reads.set(key, readSpendTx(client, txHash, token === null));
      const tx = await reads.get(key)!;
      const amount = BigInt(item.amount);
      const where = `spend[${index}]`;

      if (tx.kind === "error") {
        entry("undetermined", "the RPC did not answer");
        rpcFail("spend", `${where}: reading transaction ${txHash}`, tx.error);
        continue;
      }
      if (tx.kind === "pending") {
        incomplete = true;
        const e = entry("undetermined", `transaction ${txHash} is not mined yet`);
        fail("spend", "spend-tx-pending", `${where}: ${e.detail}; check again once it is`);
        continue;
      }
      if (tx.kind === "missing") {
        const e = entry("contradicted", `there is no transaction ${txHash} on chain ${file.chainId}`);
        fail("spend", "spend-tx-missing", `${where}: ${e.detail}`);
        continue;
      }
      const at = { blockNumber: tx.blockNumber };
      if (!tx.success) {
        const e = entry("contradicted", `transaction ${txHash} reverted, so it moved nothing`, at);
        fail("spend", "spend-tx-failed", `${where}: ${e.detail}`);
        continue;
      }

      // The payments the transaction made in this asset: Transfer logs from the token, or the
      // transaction's own ETH value.
      const paid: { from: Address; value: bigint }[] = token
        ? parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: tx.logs })
            .filter((l) => sameAddress(l.address, token))
            .map((l) => ({ from: lower(l.args.from), value: l.args.value }))
        : [{ from: tx.from, value: tx.value ?? 0n }];
      const exact = paid.filter((p) => p.value === amount);
      const own = exact.find((p) => roles[p.from]);
      const what = token ? `${item.amount} of token ${token}` : `${item.amount} wei`;
      if (own) {
        entry("confirmed", `transaction ${txHash} moved ${what} from the ${roles[own.from]} ${own.from}`, { ...at, payer: own.from });
      } else if (exact.length) {
        entry("unattributed", `transaction ${txHash} moved ${what}, but from ${exact[0]!.from}, which is neither the agent nor the principal`, { ...at, payer: exact[0]!.from });
      } else if (!token) {
        // Native ETH sent by a contract (a smart wallet, a router) leaves no trace in the receipt.
        entry("unchecked", `transaction ${txHash} carries ${tx.value ?? 0n} wei itself; ETH moved inside a contract call cannot be seen without a trace`, at);
      } else {
        const moved = paid.length ? `it moved ${[...new Set(paid.map((p) => p.value.toString()))].slice(0, 5).join(", ")} of it` : "it has no transfer of that token";
        const e = entry("contradicted", `transaction ${txHash} moved no ${what} (${moved})`, at);
        fail("spend", "spend-transfer-missing", `${where}: ${e.detail}`);
      }
    }
    if (compared) pass("spend");
  }

  if (anchor !== null && chainOk) await checkAnchor(anchor);
  if (chainOk && checkedManifest) await checkSpend(checkedManifest);
  return finish();
}
