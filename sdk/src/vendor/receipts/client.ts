import { createPublicClient, fallback, http, type Chain, type PublicClient, type Transport } from "viem";
import { chainFor, HEMI_NETWORKS } from "./chains.js";

/**
 * Hemi RPCs can be flaky (an outage in June 2026 during a node rewrite; testnet mined no
 * ordinary transactions from 2026-11-04 to 2026-11-05) and the public RPC allows about 300
 * requests a minute. Every chain read in the SDK, CLI and
 * service goes through a client built here:
 *  - RPC URLs are tried in order (viem `fallback`), each with a per-request timeout;
 *  - transient failures (timeouts, resets, HTTP 403/408/413/429/5xx, JSON-RPC -32603,
 *    -32005, 429, -32007) are retried with exponential backoff; reverts are not;
 *  - every HTTP attempt, retries and fallbacks included, takes a token from one bucket, so one
 *    process stays under the public limit even while an RPC is failing.
 */
export interface HemiClientOptions {
  chainId: number;
  /** Defaults to the network's RPCs from chains.ts. */
  rpcUrls?: string[];
  /** Retries after the first attempt. Default 6 (delays 0.5, 1, 2, 4, 8, 16 s with the default base). */
  retryCount?: number;
  /** Base backoff in ms; the n-th retry waits 2^n times this. Default 250. */
  retryDelayMs?: number;
  /** Per-request timeout in ms. Default 15,000. */
  timeoutMs?: number;
  /** Sustained request rate. Default 4 per second (240/min, under the public RPC's ~300/min). */
  requestsPerSecond?: number;
  /** Burst size. Default 8. */
  burst?: number;
}

export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
  }

  /** Resolves when a token is available. Callers are served in FIFO order. */
  take(): Promise<void> {
    const next = this.queue.then(() => this.wait());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async wait(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000)));
    }
  }
}

function rateLimited(transport: Transport, bucket: TokenBucket): Transport {
  return ((params: Parameters<Transport>[0]) => {
    const inner = transport(params);
    return {
      ...inner,
      async request(args: Parameters<typeof inner.request>[0], options?: Parameters<typeof inner.request>[1]) {
        await bucket.take();
        return inner.request(args, options);
      },
    };
  }) as Transport;
}

export function hemiTransport(options: HemiClientOptions): { transport: Transport; chain: Chain; rpcUrls: string[] } {
  const rpcUrls = options.rpcUrls?.length ? options.rpcUrls : (HEMI_NETWORKS[options.chainId]?.rpcUrls ?? []);
  if (rpcUrls.length === 0) throw new Error(`no RPC URL for chain ${options.chainId}; pass rpcUrls`);
  const timeout = options.timeoutMs ?? 15_000;
  // The bucket wraps each URL's transport, inside the fallback: the fallback's retries and its
  // move to the next URL each make a new HTTP request, and each must take a token. Wrapping the
  // fallback itself would pay one token per logical call however many requests it sends.
  const bucket = new TokenBucket(options.requestsPerSecond ?? 4, options.burst ?? 8);
  const transport = fallback(
    rpcUrls.map((url) => rateLimited(http(url, { timeout, retryCount: 0 }), bucket)),
    { retryCount: options.retryCount ?? 6, retryDelay: options.retryDelayMs ?? 250 },
  );
  return { transport, chain: chainFor(options.chainId, rpcUrls), rpcUrls };
}

export function createHemiPublicClient(options: HemiClientOptions): PublicClient {
  const { transport, chain } = hemiTransport(options);
  return createPublicClient({ chain, transport, cacheTime: 0 }) as PublicClient;
}

/**
 * Generic retry with exponential backoff and full jitter, for multi-step operations that
 * are safe to repeat (e.g. "read, then decide"). Single RPC calls are already retried by
 * the client; use this around sequences or non-RPC I/O.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: { retries?: number; baseDelayMs?: number; maxDelayMs?: number; shouldRetry?: (error: unknown) => boolean } = {},
): Promise<T> {
  const retries = options.retries ?? 5;
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 30_000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= retries || (options.shouldRetry && !options.shouldRetry(error))) throw error;
      const delay = Math.random() * Math.min(max, base * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Polls eth_getTransactionReceipt until the transaction is mined. Unlike viem's
 * waitForTransactionReceipt it does not wait for a new block first, so it also returns on a
 * chain that produces blocks only on demand (an anvil fork that just mined the transaction).
 */
export async function pollTransactionReceipt(
  client: PublicClient,
  hash: `0x${string}`,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>> {
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  for (;;) {
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => undefined);
    if (receipt) return receipt;
    if (Date.now() > deadline) throw new Error(`transaction ${hash} was not mined within ${Math.round((options.timeoutMs ?? 300_000) / 1000)} s`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
  }
}
