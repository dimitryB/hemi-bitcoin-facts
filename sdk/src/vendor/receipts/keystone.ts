import { concat, numberToHex, sha256, toHex, type Hex, type PublicClient } from "viem";
import { HEMI_NETWORKS } from "./chains.js";

/**
 * Hemi keystones and their Bitcoin PoP encoding (docs/research/STATUS_RESOLUTION.md §2–§3).
 *
 * A keystone is cut at every L2 block K with K % 25 == 0. PoP miners publish its 76-byte
 * abbreviated form in a Bitcoin OP_RETURN. Publishing keystone K' commits to block K' and so to
 * every earlier block, which is how a block's covering keystone can inherit an earlier Bitcoin
 * publication from a descendant.
 */

/** hemi.KeystoneHeaderPeriod: one keystone every 25 L2 blocks (every 5 minutes). */
export const KEYSTONE_PERIOD = 25;
/** The OP-stack L1-info deposit predeploy; the first transaction of every Hemi block calls it. */
export const L1_INFO_ADDRESS = "0x4200000000000000000000000000000000000015";
/** setL1BlockValues selectors whose packed layout has the L1 block number at input bytes [28:36]. */
export const L1_INFO_SELECTORS = { isthmus: "0x098999be", ecotone: "0x440a5e20" } as const;
/** OP_RETURN OP_PUSHDATA1 0x50 "HEMI": the first 7 bytes of every PoP output script. */
export const POP_SCRIPT_PREFIX = "0x6a4c5048454d49" as const;
/** Length of a PoP OP_RETURN script: 3 + 4 ("HEMI") + 76 (abrev). */
export const POP_SCRIPT_BYTES = 83;
export const ABREV_BYTES = 76;

export class KeystoneError extends Error {
  override name = "KeystoneError";
}

/**
 * The keystone that gives block B its Bitcoin finality: B itself when B % 25 == 0, else the next
 * multiple of 25 (op-node getKeystoneProvidingFinality).
 */
export function coveringKeystone(block: bigint): bigint;
export function coveringKeystone(block: number): number;
export function coveringKeystone(block: bigint | number): bigint | number {
  if (typeof block === "bigint") {
    const p = BigInt(KEYSTONE_PERIOD);
    return block % p === 0n ? block : (block / p + 1n) * p;
  }
  return Math.ceil(block / KEYSTONE_PERIOD) * KEYSTONE_PERIOD;
}

export interface KeystoneAbrev {
  /** The 76-byte abbreviated keystone (heminetwork L2KeystoneAbrev.Serialize). */
  abrev: Hex;
  /** doubleSHA256(abrev), byte-reversed (Bitcoin chainhash display order, as bfgd and op-node print it). */
  abrevHash: Hex;
  /** L1 (Ethereum) origin block of K. */
  l1: number;
  /** The keystone's L2 block number K. */
  l2: number;
  /** Timestamp of block K (unix seconds). */
  timestamp: number;
  /** Hash of block K. */
  blockHash: Hex;
}

/** doubleSHA256 of the abrev, byte-reversed. */
export function abrevHash(abrev: Hex): Hex {
  const digest = sha256(sha256(abrev, "bytes"), "bytes");
  return toHex(digest.reverse());
}

const be32 = (n: number) => numberToHex(n, { size: 4 });
const bytes = (hex: Hex, from: number, to: number): Hex => `0x${hex.slice(2 + from * 2, 2 + to * 2)}`;

/** Reads the L1 origin block number from the L1-info deposit input (Isthmus or Ecotone layout). */
export function l1OriginFromInput(input: Hex, blockNumber: number | bigint): number {
  const selector = input.slice(0, 10).toLowerCase();
  if (selector !== L1_INFO_SELECTORS.isthmus && selector !== L1_INFO_SELECTORS.ecotone) {
    throw new KeystoneError(
      `block ${blockNumber}: first transaction calls selector ${selector}, not setL1BlockValues (Isthmus ${L1_INFO_SELECTORS.isthmus} or Ecotone ${L1_INFO_SELECTORS.ecotone}); cannot read the L1 origin`,
    );
  }
  if (input.length < 2 + 36 * 2) throw new KeystoneError(`block ${blockNumber}: L1-info input is only ${(input.length - 2) / 2} bytes`);
  const l1 = BigInt(bytes(input, 28, 36));
  if (l1 > 0xffffffffn) throw new KeystoneError(`block ${blockNumber}: L1 origin ${l1} does not fit the abrev's 4 bytes`);
  return Number(l1);
}

/** Builds the 76-byte abrev from its parts. */
export function serializeAbrev(k: {
  l1: number;
  l2: number;
  parentHash: Hex;
  prevKeystoneHash: Hex;
  stateRoot: Hex;
  blockHash: Hex;
}): Hex {
  const out = concat(["0x01", be32(k.l1), be32(k.l2), bytes(k.parentHash, 0, 11), bytes(k.prevKeystoneHash, 0, 12), k.stateRoot, bytes(k.blockHash, 0, 12)]);
  if ((out.length - 2) / 2 !== ABREV_BYTES) throw new KeystoneError(`abrev is ${(out.length - 2) / 2} bytes, expected ${ABREV_BYTES}`);
  return out.toLowerCase() as Hex;
}

/**
 * Where keystoneAbrev keeps abrevs of old keystones. Age alone does not make a block canonical,
 * so an entry is checked against the block's current hash on every read until the chain reports
 * the block `finalized` (the OP-stack tag: derived from finalized Ethereum data, so no reorg can
 * remove it). A hash that changed (a reorg) drops the entry, and the abrev is read again.
 */
export type AbrevCache = Map<string, KeystoneAbrev & { finalized?: boolean }>;

/** Abrevs of keystone blocks older than this are cached: OP-stack `finalized` lags ~15–28 min. */
const CACHE_AFTER_SECONDS = 3_600;

/**
 * Whether the chain reports block `k` finalized. Only Hemi networks' `finalized` tag means it; a
 * local chain's is synthetic, so there an entry is always re-checked. A failed read says no.
 */
async function finalizedAt(client: PublicClient, k: bigint): Promise<boolean> {
  if (!HEMI_NETWORKS[client.chain?.id ?? -1]) return false;
  try {
    const finalized = await client.request({ method: "eth_getBlockByNumber", params: ["finalized", false] });
    return finalized?.number != null && BigInt(finalized.number) >= k;
  } catch {
    return false;
  }
}

const withoutFlag = ({ finalized: _finalized, ...abrev }: KeystoneAbrev & { finalized?: boolean }): KeystoneAbrev => abrev;

/**
 * The canonical abbreviated keystone for L2 block K (a multiple of 25), from two Hemi RPC calls:
 * block K with transactions (parentHash, stateRoot, hash, the L1-info deposit) and block K−25
 * (its hash). Throws KeystoneError when K is not a keystone, does not exist yet, or its first
 * transaction is not an L1-info deposit.
 */
export async function keystoneAbrev(client: PublicClient, keystone: bigint | number, options: { cache?: AbrevCache } = {}): Promise<KeystoneAbrev> {
  const k = BigInt(keystone);
  if (k <= 0n || k % BigInt(KEYSTONE_PERIOD) !== 0n) throw new KeystoneError(`${k} is not a keystone block (a positive multiple of ${KEYSTONE_PERIOD})`);
  if (k > 0xffffffffn) throw new KeystoneError(`keystone ${k} does not fit the abrev's 4 bytes`);
  const key = `${client.chain?.id ?? "?"}:${k}`;
  const cached = options.cache?.get(key);
  if (cached?.finalized) return withoutFlag(cached);
  if (cached) {
    // One header read: K's hash commits to its whole ancestry, K − 25 included.
    const header = await client.request({ method: "eth_getBlockByNumber", params: [numberToHex(k), false] });
    if (header?.hash && header.hash.toLowerCase() === cached.blockHash) {
      if (await finalizedAt(client, k)) cached.finalized = true;
      return withoutFlag(cached);
    }
    options.cache!.delete(key); // reorged: read it again below
  }

  const [block, prev] = await Promise.all([
    client.request({ method: "eth_getBlockByNumber", params: [numberToHex(k), true] }),
    client.request({ method: "eth_getBlockByNumber", params: [numberToHex(k - BigInt(KEYSTONE_PERIOD)), false] }),
  ]);
  if (!block) throw new KeystoneError(`keystone block ${k} does not exist yet`);
  if (!prev) throw new KeystoneError(`block ${k - BigInt(KEYSTONE_PERIOD)} does not exist`);
  const first = block.transactions[0];
  if (!first || typeof first === "string") throw new KeystoneError(`block ${k} has no transactions; expected the L1-info deposit first`);
  if (first.to?.toLowerCase() !== L1_INFO_ADDRESS) {
    throw new KeystoneError(`block ${k}: first transaction goes to ${first.to}, not the L1-info deposit ${L1_INFO_ADDRESS}`);
  }
  const l1 = l1OriginFromInput(first.input, k);
  const abrev = serializeAbrev({
    l1,
    l2: Number(k),
    parentHash: block.parentHash,
    prevKeystoneHash: prev.hash!,
    stateRoot: block.stateRoot,
    blockHash: block.hash!,
  });
  const result: KeystoneAbrev = { abrev, abrevHash: abrevHash(abrev), l1, l2: Number(k), timestamp: Number(BigInt(block.timestamp)), blockHash: block.hash!.toLowerCase() as Hex };
  if (options.cache && Date.now() / 1000 - result.timestamp > CACHE_AFTER_SECONDS) {
    options.cache.set(key, { ...result, finalized: await finalizedAt(client, k) });
  }
  return result;
}

/** The PoP OP_RETURN script for an abrev: 0x6a4c50 ‖ "HEMI" ‖ abrev. */
export function popOpReturnScript(abrev: Hex): Hex {
  if ((abrev.length - 2) / 2 !== ABREV_BYTES) throw new KeystoneError(`abrev must be ${ABREV_BYTES} bytes`);
  return `${POP_SCRIPT_PREFIX}${abrev.slice(2).toLowerCase()}` as Hex;
}

/** Decodes a PoP OP_RETURN output script; null when the script is anything else. */
export function decodePopOpReturn(script: string): { l2: number; abrev: Hex } | null {
  const hex = (script.startsWith("0x") || script.startsWith("0X") ? script.slice(2) : script).toLowerCase();
  if (hex.length !== POP_SCRIPT_BYTES * 2 || !hex.startsWith(POP_SCRIPT_PREFIX.slice(2)) || !/^[0-9a-f]*$/.test(hex)) return null;
  const abrev = `0x${hex.slice(14)}` as Hex;
  return { l2: Number.parseInt(abrev.slice(2 + 10, 2 + 18), 16), abrev };
}
