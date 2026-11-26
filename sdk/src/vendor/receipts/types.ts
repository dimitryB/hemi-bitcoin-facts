import type { Address, Hex } from "viem";
import type { ManifestV1 } from "./manifest.js";
import type { ReceiptFields } from "./receipt.js";

/** The finality ladder, in order. Reorgs can undo progress before finality. */
export const STAGES = ["pending", "hemi-included", "hemi-confirmed", "btc-published", "btc-final"] as const;
export type Stage = (typeof STAGES)[number];
/** Off-ladder terminal state: the owner voided the batch (incident response). */
export type ReceiptStage = Stage | "voided";

export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

/** Where the receipt's leaf was anchored. Present once the anchoring transaction is mined. */
export interface Anchor {
  mode: "batch" | "direct";
  /** On-chain batch id (a direct attestation is a batch of one). */
  batchId: number;
  root: Hex;
  /** Sorted-pair Merkle proof from the leaf to root; empty for a batch of one. */
  proof: Hex[];
  txHash: Hex;
  blockNumber: number;
}

/**
 * A receipt file: everything needed to verify a receipt with only an RPC and the registry
 * address. Defined in docs/SCHEMA.md §2.
 */
export interface ReceiptFile {
  format: "hemi-agent-receipt";
  formatVersion: 1;
  chainId: number;
  registry: Address;
  receipt: ReceiptFields;
  /** EIP-712 signature over the Receipt struct by receipt.agent or receipt.principal. */
  agentSignature: Hex;
  anchor: Anchor | null;
  /** Optional: when present, verify re-hashes it and checks it against receipt.manifestHash. */
  manifest?: ManifestV1;
}

export interface BtcFinality {
  /**
   * How the Bitcoin stages were determined:
   *  - "bitcoin": read from Bitcoin itself: a PoP transaction carrying the canonical keystone was
   *    found through Esplora and its confirmations counted (verified data)
   *  - "bfg": read from a Bitcoin Finality Governor endpoint (verified data)
   *  - "estimate": not found yet; PoP is live, so "expected by" times are given (never advances a stage)
   *  - "unavailable": no data source, or no PoP activity; Bitcoin stages are not reported
   */
  source: "bitcoin" | "bfg" | "estimate" | "unavailable";
  /** Bitcoin block height that carries the PoP publication of the covering keystone, if known. */
  publishedAtBtcHeight?: number;
  /** Bitcoin confirmations of that publication (tip − height + 1), if known. */
  btcConfirmations?: number;
  /** Hash of the Bitcoin block carrying the publication. */
  btcBlockHash?: string;
  /** The PoP transaction (Bitcoin txid, display order). */
  popTxid?: string;
  /** The keystone covering the anchoring block: ceil(B / 25) * 25. */
  coveringKeystone?: number;
  /** The keystone whose publication is counted: the covering keystone or a later one. */
  viaKeystone?: number;
  /** True when the covering keystone was not published itself and inherits a later keystone's publication. */
  inherited?: boolean;
  /** bfgd v2 super-finality: at least 11 confirmations. */
  superFinal?: boolean;
  /** Result of the PoP liveness gate (a payout in a recent keystone block), when it was checked. */
  popLive?: boolean;
  /** For estimates: unix seconds by which btc-published / btc-final are expected (median). */
  estimatedPublishedAt?: number;
  estimatedFinalAt?: number;
  detail?: string;
}

export interface StatusInfo {
  stage: ReceiptStage;
  /**
   * True when the reported stage rests on an estimate rather than data read from a source. The
   * SDK never advances a stage from an estimate, so resolveStatus always reports false here.
   */
  estimated: boolean;
  hemi?: {
    blockNumber: number;
    blockTimestamp: number;
    latestBlock: number;
    confirmations: number;
    requiredConfirmations: number;
    /** The OP-stack safe head when it was read; hemi-confirmed requires blockNumber <= safeBlock. */
    safeBlock?: number;
  };
  btc?: BtcFinality;
  checkedAt: number;
  notes?: string[];
}
