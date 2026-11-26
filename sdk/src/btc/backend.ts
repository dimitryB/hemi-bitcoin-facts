/**
 * Where the bond tooling reads Bitcoin and sends its two transactions: Esplora (mainnet, testnet3) or a bitcoind
 * JSON-RPC (regtest, or any node of your own). `bond create` and `bond redeem` take a backend and do the same thing
 * whichever it is, so the regtest gate runs the code that mainnet would.
 *
 * The only writes are `broadcast` calls. Esplora GETs are paced (at least 300 ms apart) and rotate from
 * mempool.space to blockstream.info on errors, throttling or a stall (D-012 item 8). A rejection of a broadcast is
 * final and is not retried elsewhere.
 */
import { redactUrl, redactUrls, UsageError } from "../common.js";
import { EsploraClient, type Utxo } from "../vendor/x402-btc/wallet.js";
import { ESPLORA_URLS, type BtcNet } from "./networks.js";

export type { Utxo };

export interface TipInfo {
  height: number;
  /** The newest block's header time. */
  time: number;
  /** Median time past of the newest 11 blocks: what a timestamp nLockTime is compared against (BIP113). */
  medianTime: number;
}

export interface TxInfo {
  /** False when the backend does not know the transaction at all. */
  found: boolean;
  confirmed: boolean;
  confirmations: number;
  blockHeight?: number;
}

export interface BtcBackend {
  readonly network: BtcNet;
  /** A short description for messages, never with credentials. */
  readonly name: string;
  /** Confirmed UTXOs of an address. */
  utxos(address: string): Promise<Utxo[]>;
  /** A fee rate in sat/vB for confirmation within about `targetBlocks`. */
  feeRate(targetBlocks?: number): Promise<number>;
  /** Sends a raw transaction; resolves to the txid the backend reports. Throws BroadcastRejected on a rejection. */
  broadcast(hex: string): Promise<string>;
  tx(txid: string): Promise<TxInfo>;
  tip(): Promise<TipInfo>;
  /** Whether an output is spent (mempool included). Undefined when the backend cannot say. */
  outputSpent(txid: string, vout: number): Promise<boolean | undefined>;
}

/** The node or Esplora refused the transaction; `reason` is its own message (for example "non-final"). */
export class BroadcastRejected extends Error {
  constructor(
    readonly reason: string,
    readonly backend: string,
  ) {
    super(`${backend} rejected the transaction: ${reason}`);
    this.name = "BroadcastRejected";
  }
}

// ---------------------------------------------------------------------------------------------
// Esplora
// ---------------------------------------------------------------------------------------------

const PACE_MS = 300;
const TIMEOUT_MS = 20_000;

/** A fetch that keeps requests at least PACE_MS apart and gives up on a stall after TIMEOUT_MS. */
export function pacedFetch(base: typeof fetch = fetch, paceMs = PACE_MS, timeoutMs = TIMEOUT_MS): typeof fetch {
  let next = 0;
  return async (input, init) => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + paceMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return base(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  };
}

/** HTTP 4xx (but 429) from a broadcast is the server's verdict on the transaction; anything else may be the transport. */
const REJECTION = /^broadcast rejected by \S+: 4(?!29)\d\d /;

export class EsploraBackend implements BtcBackend {
  readonly name: string;
  private readonly clients: EsploraClient[];
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly network: Exclude<BtcNet, "regtest">,
    bases: string[] = ESPLORA_URLS[network],
    fetchImpl: typeof fetch = pacedFetch(),
  ) {
    if (bases.length === 0) throw new Error("no Esplora URL");
    this.fetchImpl = fetchImpl;
    this.clients = bases.map((b) => new EsploraClient(b.replace(/\/$/, ""), fetchImpl));
    this.name = `Esplora (${this.clients.map((c) => redactUrl(c.base)).join(", ")})`;
  }

  /** Runs `f` on each instance in turn until one answers. */
  private async rotate<T>(f: (c: EsploraClient) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const c of this.clients) {
      try {
        return await f(c);
      } catch (error) {
        if (error instanceof BroadcastRejected) throw error;
        last = error;
      }
    }
    throw last;
  }

  private async getJson<T>(c: EsploraClient, path: string): Promise<T> {
    const res = await this.fetchImpl(`${c.base}${path}`);
    if (!res.ok) throw new Error(`GET ${redactUrl(c.base)}${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  utxos(address: string): Promise<Utxo[]> {
    return this.rotate(async (c) => (await c.utxos(address)).filter((u) => u.status?.confirmed !== false));
  }

  feeRate(targetBlocks = 3): Promise<number> {
    return this.rotate((c) => c.feeRate(targetBlocks));
  }

  broadcast(hex: string): Promise<string> {
    return this.rotate(async (c) => {
      try {
        return await c.broadcast(hex);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (REJECTION.test(message)) throw new BroadcastRejected(redactUrls(message.replace(REJECTION, "")), redactUrl(c.base));
        throw error;
      }
    });
  }

  tx(txid: string): Promise<TxInfo> {
    return this.rotate(async (c) => {
      // `/tx/:txid` is 404 for an unknown transaction; `/tx/:txid/status` answers {"confirmed":false} for anything.
      const res = await this.fetchImpl(`${c.base}/tx/${txid}`);
      if (res.status === 404) return { found: false, confirmed: false, confirmations: 0 };
      if (!res.ok) throw new Error(`GET ${redactUrl(c.base)}/tx/${txid}: ${res.status}`);
      const s = ((await res.json()) as { status: { confirmed: boolean; block_height?: number } }).status;
      if (!s.confirmed || s.block_height === undefined) return { found: true, confirmed: false, confirmations: 0 };
      const tip = await c.tipHeight();
      return { found: true, confirmed: true, confirmations: tip - s.block_height + 1, blockHeight: s.block_height };
    });
  }

  tip(): Promise<TipInfo> {
    return this.rotate(async (c) => {
      const hash = (await (await this.fetchImpl(`${c.base}/blocks/tip/hash`)).text()).trim();
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`GET ${redactUrl(c.base)}/blocks/tip/hash: ${hash.slice(0, 80)}`);
      const b = await this.getJson<{ height: number; timestamp: number; mediantime: number }>(c, `/block/${hash}`);
      return { height: b.height, time: b.timestamp, medianTime: b.mediantime };
    });
  }

  /** `/outspend` says "not spent" for an unknown transaction too, so a false needs `tx()` to be found. */
  outputSpent(txid: string, vout: number): Promise<boolean | undefined> {
    return this.rotate(async (c) => {
      if ((await this.getJson<{ spent: boolean }>(c, `/tx/${txid}/outspend/${vout}`)).spent) return true;
      return (await this.tx(txid)).found ? false : undefined;
    });
  }
}

// ---------------------------------------------------------------------------------------------
// bitcoind JSON-RPC
// ---------------------------------------------------------------------------------------------

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Satoshis from a bitcoind BTC amount (a JSON number with at most 8 decimals). */
export function btcToSats(amount: number): number {
  return Math.round(amount * 1e8);
}

/**
 * A bitcoind node by JSON-RPC: `http://user:password@host:port` (the credentials go in an Authorization header and
 * are never printed). Needs no wallet: UTXOs come from `scantxoutset`. With `-txindex` it can report any
 * transaction; without, only mempool and wallet ones.
 */
export class BitcoindBackend implements BtcBackend {
  readonly name: string;
  private readonly url: string;
  private readonly auth?: string;
  private id = 0;

  constructor(
    readonly network: BtcNet,
    rpcUrl: string,
    /** sat/vB when estimatesmartfee has no data, as on a fresh regtest chain. */
    private readonly fallbackFeeRate = 2,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const u = new URL(rpcUrl);
    if (u.username || u.password) {
      this.auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`;
      u.username = "";
      u.password = "";
    }
    this.url = u.toString();
    this.name = `bitcoind ${u.host}`;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.auth ? { authorization: this.auth } : {}) },
      body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let body: { result?: T; error?: { code: number; message: string } | null };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`${this.name} ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (body.error) throw new RpcError(body.error.code, body.error.message);
    return body.result as T;
  }

  async utxos(address: string): Promise<Utxo[]> {
    const r = await this.call<{ success: boolean; unspents: { txid: string; vout: number; amount: number; height: number }[] }>(
      "scantxoutset",
      ["start", [{ desc: `addr(${address})` }]],
    );
    if (!r.success) throw new Error(`${this.name} scantxoutset did not finish`);
    return r.unspents.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: btcToSats(u.amount),
      status: { confirmed: true, block_height: u.height },
    }));
  }

  async feeRate(targetBlocks = 3): Promise<number> {
    const r = await this.call<{ feerate?: number }>("estimatesmartfee", [targetBlocks]);
    // feerate is BTC per 1,000 vbytes
    if (r.feerate === undefined) return this.fallbackFeeRate;
    return Math.max(1, Math.ceil(r.feerate * 1e5 * 10) / 10);
  }

  async broadcast(hex: string): Promise<string> {
    try {
      return await this.call<string>("sendrawtransaction", [hex]);
    } catch (error) {
      // -25 missing inputs / -26 rejected by policy or consensus (e.g. "non-final") / -27 already in the chain
      if (error instanceof RpcError) throw new BroadcastRejected(`${error.message} (RPC code ${error.code})`, this.name);
      throw error;
    }
  }

  async tx(txid: string): Promise<TxInfo> {
    try {
      const t = await this.call<{ confirmations?: number; blockhash?: string }>("getrawtransaction", [txid, true]);
      const confirmations = t.confirmations ?? 0;
      if (!t.blockhash || confirmations === 0) return { found: true, confirmed: false, confirmations: 0 };
      const h = await this.call<{ height: number }>("getblockheader", [t.blockhash]);
      return { found: true, confirmed: true, confirmations, blockHeight: h.height };
    } catch (error) {
      if (error instanceof RpcError && error.code === -5) return { found: false, confirmed: false, confirmations: 0 };
      throw error;
    }
  }

  async tip(): Promise<TipInfo> {
    const info = await this.call<{ blocks: number; bestblockhash: string; mediantime: number }>("getblockchaininfo");
    const h = await this.call<{ time: number; mediantime: number }>("getblockheader", [info.bestblockhash]);
    return { height: info.blocks, time: h.time, medianTime: h.mediantime };
  }

  async outputSpent(txid: string, vout: number): Promise<boolean | undefined> {
    const out = await this.call<unknown>("gettxout", [txid, vout, true]);
    if (out !== null) return false;
    // gettxout is null for spent and for unknown outputs; only a known transaction makes it "spent"
    return (await this.tx(txid)).found ? true : undefined;
  }
}

export interface BackendOptions {
  network: BtcNet;
  /** A bitcoind JSON-RPC URL; required for regtest. */
  btcRpc?: string;
  /** Esplora base URLs to use instead of the defaults. */
  esplora?: string[];
}

export function backendFor(o: BackendOptions): BtcBackend {
  if (o.btcRpc) return new BitcoindBackend(o.network, o.btcRpc);
  if (o.network === "regtest") throw new UsageError("regtest needs --btc-rpc <http://user:pass@host:port> (a bitcoind node)");
  return new EsploraBackend(o.network, o.esplora?.length ? o.esplora : ESPLORA_URLS[o.network]);
}
