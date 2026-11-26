import { hexToBytes, type Hex, type PublicClient, numberToHex } from "viem";
import { blockTime, findAll, transactionsContaining } from "./bitcoin.js";
import { HEMI_MAINNET, HEMI_TESTNET } from "./chains.js";
import { TokenBucket } from "./client.js";
import { coveringKeystone, decodePopOpReturn, KEYSTONE_PERIOD, KeystoneError, keystoneAbrev, POP_SCRIPT_PREFIX, type AbrevCache, type KeystoneAbrev } from "./keystone.js";
import { unavailableFinality, type FinalityReader } from "./status.js";
import type { FetchLike } from "./submit.js";
import type { BtcFinality } from "./types.js";

/**
 * Bitcoin finality of a Hemi block from public data only (docs/research/STATUS_RESOLUTION.md):
 * rebuild the covering keystone from Hemi RPC, find a Bitcoin PoP transaction carrying it (or a
 * later keystone) through Esplora, and count Bitcoin confirmations.
 */

/** Confirmations (counting the publication block) for btc-final: Hemi docs, bfgd v1, op-node v1. */
export const BTC_FINAL_CONFIRMATIONS = 9;
/** bfgd v2 super-finality: effective_confirmations >= 10, i.e. 11 counting the publication block. */
export const BTC_SUPER_FINAL_CONFIRMATIONS = 11;
/** Hemi block time (measured 12.0 s on both networks). */
export const HEMI_BLOCK_SECONDS = 12;
/** PoP payout transactions: sent by this address at every keystone block, calling mintPoPRewards. */
export const POP_PAYOUT_SENDER = "0x8888888888888888888888888888888888888888";
export const POP_PAYOUT_SELECTOR = "0x1725877d";
/**
 * Effective delays after the keystone block's timestamp, measured over ~70 h of mainnet with one
 * active miner (report §4). Used for "expected by" hints only; an estimate never advances a stage.
 */
export const POP_DELAY_MINUTES = {
  published: { p50: 15, p75: 43, p90: 149, p95: 221, p99: 319 },
  final: { p50: 102, p75: 143, p90: 253, p95: 323, p99: 428 },
} as const;

// ---------------------------------------------------------------------------------------------
// Esplora

export interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface EsploraTx {
  txid: string;
  status: EsploraTxStatus;
  vout: { scriptpubkey: string; scriptpubkey_type?: string; value?: number }[];
}

export interface EsploraBlock {
  id: string;
  height: number;
  timestamp: number;
}

export interface EsploraClientOptions {
  /** Base URLs, e.g. https://blockstream.info/api. Failed requests move on to the next one. */
  baseUrls: string[];
  /** Per-request timeout. Default 20 s (raw blocks are ~1.6 MB). */
  timeoutMs?: number;
  /** Retries after the first attempt on 429, 5xx, timeouts and network errors. Default 4. */
  retries?: number;
  /** Base backoff; the n-th retry waits about 2^n times this (or Retry-After). Default 1,000 ms. */
  retryDelayMs?: number;
  /** Sustained pace across all base URLs. Default 1.5 requests/s (mempool.space 429s quick bursts). */
  requestsPerSecond?: number;
  burst?: number;
  fetch?: FetchLike;
}

export class EsploraError extends Error {
  constructor(message: string, readonly status: number | undefined, readonly url: string) {
    super(message);
    this.name = "EsploraError";
  }
}

/** A small Esplora (blockstream.info / mempool.space) client with pacing, backoff and fallback. */
export class EsploraClient {
  readonly stats = { requests: 0, retries: 0 };
  private readonly bucket: TokenBucket;
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: EsploraClientOptions) {
    if (!options.baseUrls?.length) throw new TypeError("EsploraClient: at least one base URL is required");
    this.bucket = new TokenBucket(options.requestsPerSecond ?? 1.5, options.burst ?? 2);
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  get baseUrls(): string[] {
    return this.options.baseUrls;
  }

  private async get(path: string, kind: "json" | "text" | "bytes"): Promise<unknown> {
    const urls = this.options.baseUrls.map((u) => u.replace(/\/+$/, ""));
    const retries = this.options.retries ?? 4;
    const base = this.options.retryDelayMs ?? 1_000;
    let lastError: EsploraError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const url = `${urls[attempt % urls.length]}${path}`;
      let wait: number | undefined;
      let retryable = true;
      await this.bucket.take();
      this.stats.requests++;
      try {
        // Called on its own, never as this.fetchFn(…): a browser's fetch rejects any `this` but the
        // window with "Illegal invocation" (Node's does not check).
        const fetchFn = this.fetchFn;
        const res = await fetchFn(url, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000) });
        if (res.ok) {
          if (kind === "bytes") return new Uint8Array(await res.arrayBuffer());
          const text = await res.text();
          return kind === "json" ? JSON.parse(text) : text.trim();
        }
        const body = (await res.text().catch(() => "")).slice(0, 200);
        lastError = new EsploraError(`GET ${url} answered ${res.status}${body ? `: ${body}` : ""}`, res.status, url);
        if (res.status !== 429 && res.status < 500) retryable = false;
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(retryAfter, 60) * 1_000;
      } catch (error) {
        lastError = new EsploraError(`GET ${url} failed: ${(error as Error).message}`, undefined, url);
      }
      if (!retryable) throw lastError;
      if (attempt === retries) break;
      this.stats.retries++;
      const delay = wait ?? Math.min(30_000, base * 2 ** attempt) * (0.5 + Math.random() / 2);
      await new Promise((r) => setTimeout(r, delay));
    }
    throw lastError ?? new EsploraError(`GET ${path} failed`, undefined, path);
  }

  async tipHeight(): Promise<number> {
    const n = Number(await this.get("/blocks/tip/height", "text"));
    if (!Number.isSafeInteger(n)) throw new EsploraError("bad tip height", undefined, "/blocks/tip/height");
    return n;
  }

  /** Mempool txs plus the newest confirmed txs; with `afterTxid`, the confirmed txs after it. */
  addressTxs(address: string, afterTxid?: string): Promise<EsploraTx[]> {
    return this.get(`/address/${address}/txs${afterTxid ? `/chain/${afterTxid}` : ""}`, "json") as Promise<EsploraTx[]>;
  }

  async blockHashAtHeight(height: number): Promise<string> {
    return String(await this.get(`/block-height/${height}`, "text")).toLowerCase();
  }

  rawBlock(hash: string): Promise<Uint8Array> {
    return this.get(`/block/${hash}/raw`, "bytes") as Promise<Uint8Array>;
  }

  /** Ten blocks, newest first, starting at `height` (or the tip). */
  blocks(height?: number): Promise<EsploraBlock[]> {
    return this.get(`/blocks${height === undefined ? "" : `/${height}`}`, "json") as Promise<EsploraBlock[]>;
  }

  /** A transaction, or null when Esplora does not know it (404). */
  async tx(txid: string): Promise<EsploraTx | null> {
    try {
      return (await this.get(`/tx/${txid}`, "json")) as EsploraTx;
    } catch (error) {
      if (error instanceof EsploraError && error.status === 404) return null;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// PoP finality reader

export interface PopFinalityOptions {
  /** Esplora base URLs for the Bitcoin network Hemi's PoP publishes to. */
  esploraUrls: string[];
  /** Mode A: Bitcoin addresses of known PoP miners, polled through /address/{a}/txs. */
  minerAddresses?: string[];
  /** Mode B: raw Bitcoin blocks to scan from the keystone's time. 0 (default) disables scanning. */
  scanMaxBlocks?: number;
  /**
   * Liveness gate window, in keystones (25 Hemi blocks, 5 min each). Default 72 (6 h): mainnet
   * PoP runs in bursts with a backlog, so payouts can pause for well over half an hour while
   * publications continue.
   */
  livenessWindowKeystones?: number;
  /** Sample every n-th keystone block of the window, newest first. Default 4 (18 calls at most). */
  livenessStride?: number;
  /** @deprecated Use livenessWindowKeystones (this one samples every keystone). */
  livenessKeystones?: number;
  /** Mode A: how many address pages (25 confirmed txs each) to read back per miner. Default 40. */
  maxAddressPages?: number;
  /** Esplora client or its tuning. */
  esplora?: EsploraClient | Omit<EsploraClientOptions, "baseUrls">;
}

/** A PoP transaction carrying keystone `l2`, as seen on Bitcoin. */
export interface PopCandidate {
  txid: string;
  l2: number;
  abrev: Hex;
  /** null while unconfirmed. */
  height: number | null;
  blockHash: string | null;
}

export interface PopFinalityReader extends FinalityReader {
  readonly esplora: EsploraClient;
}

interface ScanEntry {
  hash: string;
  time: number;
  /** Tip when this hash was last checked against the canonical chain. */
  checkedAtTip: number;
  pops: { txid: string; l2: number; abrev: Hex }[];
}

const MAGIC = hexToBytes(POP_SCRIPT_PREFIX);
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

export interface LivenessWindow {
  /** Keystones (25 Hemi blocks each) to look back over. */
  windowKeystones: number;
  /** Check every n-th keystone block of the window. */
  stride: number;
}

export interface LivenessResult {
  live: boolean;
  payoutBlock?: number;
  /** Keystone blocks read, newest first. */
  checked: number[];
  /** The window looked at, in keystones. */
  windowKeystones: number;
}

/**
 * Is PoP alive? True when a sampled keystone block in the window carries a PoP payout
 * transaction (from 0x8888…8888, selector mintPoPRewards). Blocks are read newest first and
 * the search stops at the first payout, so a live network costs one or two calls. A number
 * as the third argument means "the last n keystone blocks, every one".
 */
export async function popLiveness(client: PublicClient, latest: bigint, window: number | LivenessWindow): Promise<LivenessResult> {
  const { windowKeystones, stride } = typeof window === "number" ? { windowKeystones: window, stride: 1 } : window;
  const checked: number[] = [];
  const top = (latest / BigInt(KEYSTONE_PERIOD)) * BigInt(KEYSTONE_PERIOD);
  for (let i = 0; i < windowKeystones; i += Math.max(1, stride)) {
    const k = top - BigInt(i * KEYSTONE_PERIOD);
    if (k <= 0n) break;
    checked.push(Number(k));
    const block = await client.request({ method: "eth_getBlockByNumber", params: [numberToHex(k), true] });
    const payout = block?.transactions.some(
      (tx) => typeof tx !== "string" && tx.from?.toLowerCase() === POP_PAYOUT_SENDER && tx.input?.toLowerCase().startsWith(POP_PAYOUT_SELECTOR),
    );
    if (payout) return { live: true, payoutBlock: Number(k), checked, windowKeystones };
  }
  return { live: false, checked, windowKeystones };
}

/** "6 h", "30 min": the span of a window of keystones (5 minutes each). */
export function describeLivenessWindow(windowKeystones: number): string {
  const minutes = (windowKeystones * KEYSTONE_PERIOD * 12) / 60;
  return minutes >= 120 ? `${Math.round((minutes / 60) * 10) / 10} h` : `${Math.round(minutes)} min`;
}

/**
 * A FinalityReader that reads the Bitcoin stages from Bitcoin itself (source "bitcoin").
 *
 *  a. K = coveringKeystone(B); the canonical abrev of K (and of any later keystone a candidate
 *     carries) comes from Hemi RPC.
 *  b. Candidates: mode A polls known miner addresses; mode B scans raw Bitcoin blocks from the
 *     first block at or after t_K − 10 min (one /block-height and one /block/{hash}/raw per
 *     height, cached per height: far cheaper than paging /block/{hash}/txs, ~150 pages a block).
 *  c. A candidate counts only if its full abrev equals the canonical abrev of its keystone
 *     K' ≥ K. Publication = the lowest confirmed Bitcoin height (descendants anchor ancestors).
 *  d. Below 9 confirmations the publication block's hash is re-checked against Esplora's
 *     canonical block at that height (Bitcoin reorgs).
 *  e. Nothing found: a liveness gate on PoP payouts decides between "estimate" (expected-by
 *     times from measured percentiles) and "unavailable" (no PoP activity).
 */
export function createPopFinalityReader(options: PopFinalityOptions): PopFinalityReader {
  const esplora = options.esplora instanceof EsploraClient ? options.esplora : new EsploraClient({ ...options.esplora, baseUrls: options.esploraUrls });
  const miners = options.minerAddresses ?? [];
  const scanMax = options.scanMaxBlocks ?? 0;
  const livenessWindow: LivenessWindow =
    options.livenessKeystones !== undefined && options.livenessWindowKeystones === undefined
      ? { windowKeystones: options.livenessKeystones, stride: 1 }
      : { windowKeystones: options.livenessWindowKeystones ?? 72, stride: options.livenessStride ?? 4 };
  const maxPages = options.maxAddressPages ?? 40;
  const abrevs: AbrevCache = new Map();
  const scanned = new Map<number, ScanEntry>();
  const blockTimes = new Map<number, number>();
  let liveness: { keystone: bigint; at: number; result: Awaited<ReturnType<typeof popLiveness>> } | undefined;

  async function canonical(client: PublicClient, l2: number): Promise<KeystoneAbrev | null> {
    try {
      return await keystoneAbrev(client, l2, { cache: abrevs });
    } catch (error) {
      if (error instanceof KeystoneError) return null; // not a keystone this chain has: not canonical
      throw error;
    }
  }

  /**
   * PoP outputs in a miner's address history, newest page first, back to the page where the
   * NEWEST confirmed keystone is already older than k. Anyone can put a transaction into an
   * address's history (dust to the address with a "HEMI" OP_RETURN), and mempool entries are
   * free, so neither an unconfirmed output nor the oldest output of a page may end the search:
   * a forged low keystone would stop it before an older genuine publication is read. Stopping
   * on the newest confirmed keystone of the page needs the whole page to be older than k.
   */
  async function minerCandidates(address: string, k: number): Promise<PopCandidate[]> {
    const out: PopCandidate[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const txs = await esplora.addressTxs(address, after);
      if (txs.length === 0) break;
      let newestConfirmed = -1;
      for (const tx of txs) {
        for (const v of tx.vout) {
          const pop = decodePopOpReturn(v.scriptpubkey);
          if (!pop) continue;
          if (tx.status.confirmed && pop.l2 % KEYSTONE_PERIOD === 0) newestConfirmed = Math.max(newestConfirmed, pop.l2);
          out.push({ txid: tx.txid, l2: pop.l2, abrev: pop.abrev, height: tx.status.confirmed ? (tx.status.block_height ?? null) : null, blockHash: tx.status.block_hash?.toLowerCase() ?? null });
        }
      }
      const confirmed = txs.filter((t) => t.status.confirmed);
      if (confirmed.length === 0 || (newestConfirmed >= 0 && newestConfirmed < k)) break;
      after = confirmed[confirmed.length - 1]!.txid;
    }
    return out;
  }

  async function blocksPage(top: number): Promise<EsploraBlock[]> {
    const page = await esplora.blocks(top);
    for (const b of page) blockTimes.set(b.height, b.timestamp);
    return [...page].sort((a, b) => a.height - b.height);
  }

  /** Lowest height whose block (and every later block in its page) is at or after `target`. */
  async function firstHeightAtOrAfter(target: number, tip: number): Promise<number | null> {
    let hi = tip;
    let lo = -1;
    let top = tip;
    for (let iter = 0; iter < 24; iter++) {
      const asc = await blocksPage(top);
      if (asc.length === 0) return null;
      const newest = asc[asc.length - 1]!;
      if (iter === 0 && newest.timestamp < target) return null; // nothing that recent on Bitcoin yet
      let j = -1;
      asc.forEach((b, i) => {
        if (b.timestamp < target) j = i;
      });
      if (j >= 0 && j < asc.length - 1) return asc[j + 1]!.height;
      if (j === asc.length - 1) {
        lo = newest.height; // the whole page is older
        if (hi - lo <= 1) return hi;
        top = Math.min(hi, newest.height + Math.max(10, Math.ceil((target - newest.timestamp) / 600) + 5));
      } else {
        if (asc[0]!.height === 0) return 0;
        hi = asc[0]!.height; // the whole page is newer
        if (hi - lo <= 1) return hi;
        top = Math.max(lo + 10, asc[0]!.height - 1 - Math.max(0, Math.ceil((asc[0]!.timestamp - target) / 600) - 5));
        top = Math.min(top, hi - 1);
      }
    }
    return hi;
  }

  async function scanHeight(height: number, tip: number): Promise<ScanEntry> {
    const cached = scanned.get(height);
    // A young block can reorg before the next read. Age alone cannot finalize its
    // cached hash: it must have been checked at super-final depth at least once.
    if (cached && cached.checkedAtTip - height + 1 >= BTC_SUPER_FINAL_CONFIRMATIONS && tip >= cached.checkedAtTip) return cached;
    const hash = await esplora.blockHashAtHeight(height);
    if (cached && cached.hash === hash) {
      cached.checkedAtTip = tip;
      return cached;
    }
    const raw = await esplora.rawBlock(hash);
    const txs = transactionsContaining(raw, findAll(raw, MAGIC));
    const pops: ScanEntry["pops"] = [];
    for (const tx of txs) {
      for (const script of tx.outputs) {
        const pop = decodePopOpReturn(script);
        if (pop) pops.push({ txid: tx.txid.slice(2), l2: pop.l2, abrev: pop.abrev });
      }
    }
    const entry = { hash, time: blockTime(raw), checkedAtTip: tip, pops };
    scanned.set(height, entry);
    blockTimes.set(height, entry.time);
    return entry;
  }

  /**
   * The lowest confirmed canonical publication among `candidates` for keystone k, checked against
   * Bitcoin reorgs. Unconfirmed canonical candidates are returned for the detail line.
   */
  async function choose(client: PublicClient, candidates: PopCandidate[], k: number, state: { tip?: number; notes: string[] }) {
    const relevant = candidates.filter((c) => c.l2 >= k && c.l2 % KEYSTONE_PERIOD === 0);
    const queue = relevant.filter((c) => c.height !== null).sort((a, b) => a.height! - b.height! || a.l2 - b.l2);
    const seen = new Set<string>();
    let rejected = 0;
    while (queue.length > 0) {
      const c = queue.shift()!;
      const key = `${c.txid}:${c.l2}:${c.height}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const canon = await canonical(client, c.l2);
      if (!canon || canon.abrev !== c.abrev.toLowerCase()) {
        rejected++;
        continue;
      }
      state.tip ??= await esplora.tipHeight();
      const confirmations = state.tip - c.height! + 1;
      if (confirmations < BTC_FINAL_CONFIRMATIONS) {
        const hash = await esplora.blockHashAtHeight(c.height!);
        if (c.blockHash && hash !== c.blockHash) {
          state.notes.push(`Bitcoin block ${c.height} was reorged; re-reading PoP tx ${c.txid}`);
          const now = await esplora.tx(c.txid);
          if (now?.status.confirmed && now.status.block_height !== undefined) {
            queue.push({ ...c, height: now.status.block_height, blockHash: now.status.block_hash?.toLowerCase() ?? null });
            queue.sort((a, b) => a.height! - b.height! || a.l2 - b.l2);
          }
          continue;
        }
        c.blockHash ??= hash;
      }
      return { publication: c, rejected };
    }
    return { publication: undefined, rejected };
  }

  async function mempoolMatches(client: PublicClient, candidates: PopCandidate[], k: number): Promise<PopCandidate[]> {
    const pending = candidates.filter((c) => c.height === null && c.l2 >= k).sort((a, b) => a.l2 - b.l2).slice(0, 3);
    const out: PopCandidate[] = [];
    for (const c of pending) {
      const canon = await canonical(client, c.l2);
      if (canon && canon.abrev === c.abrev.toLowerCase()) out.push(c);
    }
    return out;
  }

  return {
    esplora,
    async read(input) {
      const { client } = input;
      const B = input.blockNumber;
      const K = coveringKeystone(B);
      const k = Number(K);
      const tK = input.blockTimestamp + Number(K - B) * HEMI_BLOCK_SECONDS;
      const latest = input.latestBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
      const state: { tip?: number; notes: string[] } = { notes: [] };
      const base: Partial<BtcFinality> = { coveringKeystone: k };
      let pub: PopCandidate | undefined;
      let pending: PopCandidate[] = [];
      let rejected = 0;

      if (K <= latest) {
        const candidates: PopCandidate[] = [];
        for (const address of miners) candidates.push(...(await minerCandidates(address, k)));
        const a = await choose(client, candidates, k, state);
        pub = a.publication;
        rejected += a.rejected;
        pending = candidates;

        if (scanMax > 0) {
          state.tip ??= await esplora.tipHeight();
          const start = await firstHeightAtOrAfter(tK - 600, state.tip);
          if (start !== null) {
            const end = Math.min(state.tip, start + scanMax - 1, (pub?.height ?? Number.POSITIVE_INFINITY) - 1);
            for (let h = start; h <= end; h++) {
              const entry = await scanHeight(h, state.tip);
              const found = entry.pops.filter((p) => p.l2 >= k).map((p) => ({ ...p, height: h, blockHash: entry.hash }));
              if (found.length === 0) continue;
              const b = await choose(client, found, k, state);
              rejected += b.rejected;
              if (b.publication) {
                pub = b.publication;
                break;
              }
            }
          }
        }
      }

      const rejectedNote = rejected ? `; ignored ${rejected} "HEMI" OP_RETURN${rejected > 1 ? "s" : ""} that do not match the canonical keystone` : "";
      if (pub) {
        const tip = state.tip ?? (await esplora.tipHeight());
        const confirmations = tip - pub.height! + 1;
        const via = pub.l2;
        return {
          ...base,
          source: "bitcoin",
          publishedAtBtcHeight: pub.height!,
          btcConfirmations: confirmations,
          btcBlockHash: pub.blockHash ?? undefined,
          popTxid: pub.txid,
          viaKeystone: via,
          inherited: via !== k,
          superFinal: confirmations >= BTC_SUPER_FINAL_CONFIRMATIONS,
          detail:
            `keystone ${via}${via !== k ? ` (a descendant of covering keystone ${k})` : ""} published in Bitcoin block ${pub.height} by tx ${pub.txid}, ` +
            `${confirmations} confirmation${confirmations === 1 ? "" : "s"}${state.notes.length ? `; ${state.notes.join("; ")}` : ""}${rejectedNote}`,
        };
      }

      // Unconfirmed canonical publications are only worth a detail line.
      const mempool = await mempoolMatches(client, pending, k);
      const searched = miners.length > 0 || scanMax > 0;
      const prefix = [
        K > latest
          ? `covering keystone ${k} is not produced yet (latest Hemi block ${latest})`
          : searched
            ? `keystone ${k} not found on Bitcoin yet`
            : `keystone ${k} not searched on Bitcoin (no PoP miner addresses or block scan configured)`,
        ...(mempool.length ? [`in Bitcoin mempool: ${mempool.map((m) => `keystone ${m.l2} in tx ${m.txid}`).join(", ")}`] : []),
        ...state.notes,
      ].join("; ") + rejectedNote;

      const latestKeystone = (latest / BigInt(KEYSTONE_PERIOD)) * BigInt(KEYSTONE_PERIOD);
      if (!liveness || liveness.keystone !== latestKeystone || Date.now() - liveness.at > 300_000) {
        liveness = { keystone: latestKeystone, at: Date.now(), result: await popLiveness(client, latest, livenessWindow) };
      }
      const live = liveness.result;
      const range = live.checked.length ? `blocks ${live.checked[live.checked.length - 1]}…${live.checked[0]}` : "no keystone blocks yet";
      if (!live.live) {
        return {
          ...base,
          source: "unavailable",
          popLive: false,
          detail: `no PoP activity: no PoP payout in ${live.checked.length} keystone block${live.checked.length === 1 ? "" : "s"} sampled over the last ${describeLivenessWindow(live.windowKeystones)} (${range}); ${prefix}`,
        };
      }
      const P = POP_DELAY_MINUTES;
      return {
        ...base,
        source: "estimate",
        popLive: true,
        estimatedPublishedAt: tK + P.published.p50 * 60,
        estimatedFinalAt: tK + P.final.p50 * 60,
        detail:
          `${prefix}; PoP is live (payout in keystone block ${live.payoutBlock}). ESTIMATE, not verified: ` +
          `published by ~${iso(tK + P.published.p50 * 60)} (p50; p90 ${iso(tK + P.published.p90 * 60)}), ` +
          `final by ~${iso(tK + P.final.p50 * 60)} (p50; p90 ${iso(tK + P.final.p90 * 60)})`,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Defaults

/** Known mainnet PoP miner (BTC P2PKH) as of 2026-10-29. Miner identities rotate (report §3.3): mode B finds new ones. */
export const KNOWN_POP_MINERS_MAINNET = ["17Fv7httdZvqMubbvMkQ9KLPiTSPobxAqF"];

export const DEFAULT_FINALITY_OPTIONS: Record<number, PopFinalityOptions> = {
  [HEMI_MAINNET.chainId]: {
    esploraUrls: ["https://blockstream.info/api", "https://mempool.space/api"],
    minerAddresses: KNOWN_POP_MINERS_MAINNET,
    scanMaxBlocks: 36,
  },
  // Testnet showed no PoP activity when checked on 2026-10-29 (report §3.5): no miners, no scanning; the
  // liveness gate answers "unavailable" from at most 18 Hemi RPC calls (cached 5 min) and never touches Esplora.
  [HEMI_TESTNET.chainId]: {
    esploraUrls: ["https://blockstream.info/testnet/api"],
    minerAddresses: [],
    scanMaxBlocks: 0,
  },
};

const defaults = new Map<number, FinalityReader>();

/**
 * The Bitcoin finality reader for a chain: PoP-based on Hemi mainnet and testnet, and
 * `unavailableFinality` on any other chain (a local anvil) unless `overrides.esploraUrls` is given.
 * Readers without overrides are shared per chain, so their caches are too.
 */
export function defaultFinalityReader(chainId: number, overrides: Partial<PopFinalityOptions> = {}): FinalityReader {
  const hasOverrides = Object.values(overrides).some((v) => v !== undefined);
  const base = DEFAULT_FINALITY_OPTIONS[chainId];
  if (!base && !overrides.esploraUrls?.length) return unavailableFinality;
  if (!hasOverrides) {
    let reader = defaults.get(chainId);
    if (!reader) defaults.set(chainId, (reader = createPopFinalityReader(base!)));
    return reader;
  }
  const merged = { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as PopFinalityOptions;
  return createPopFinalityReader(merged);
}
