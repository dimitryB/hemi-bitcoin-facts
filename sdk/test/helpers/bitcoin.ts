/**
 * Test helpers for the Bitcoin side of PopFinality: raw transactions and blocks, PoP scripts, the 0x42 answer
 * MockHvm should give for them, and a fake Esplora HTTP server (a stand-in for mempool.space / blockstream.info).
 */
import { createServer, type Server } from "node:http";
import { bytesToHex, concat, hexToBytes, sha256, toHex, type Hex } from "viem";

const le = (n: bigint, bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
};
const varint = (n: number): Uint8Array => (n < 0xfd ? new Uint8Array([n]) : concatBytes([new Uint8Array([0xfd]), le(BigInt(n), 2)]));
const concatBytes = (parts: Uint8Array[]): Uint8Array => hexToBytes(concat(parts.map((p) => bytesToHex(p))));
const dsha = (b: Uint8Array): Uint8Array => sha256(sha256(b, "bytes"), "bytes");

export interface TxOut {
  value: bigint;
  script: Hex;
}

export interface BuiltTx {
  raw: Uint8Array;
  /** Display order (as explorers print it and hVM takes it). */
  txid: Hex;
}

/** A transaction with one input spending (prevTxid, prevVout); segwit adds a one-item witness. */
export function buildTx(outputs: TxOut[], options: { segwit?: boolean; prevTxid?: Hex; prevVout?: number; coinbase?: boolean } = {}): BuiltTx {
  const prev = options.coinbase ? new Uint8Array(32) : hexToBytes(options.prevTxid ?? `0x${"ab".repeat(32)}`).reverse();
  const input = concatBytes([prev, le(BigInt(options.coinbase ? 0xffffffff : (options.prevVout ?? 0)), 4), varint(options.coinbase ? 2 : 0), ...(options.coinbase ? [new Uint8Array([0x51, 0x51])] : []), le(0xffffffffn, 4)]);
  const outs = concatBytes([varint(outputs.length), ...outputs.map((o) => concatBytes([le(o.value, 8), varint((o.script.length - 2) / 2), hexToBytes(o.script)]))]);
  const version = le(2n, 4);
  const locktime = le(0n, 4);
  const stripped = concatBytes([version, varint(1), input, outs, locktime]);
  const raw = options.segwit
    ? concatBytes([version, new Uint8Array([0x00, 0x01]), varint(1), input, outs, new Uint8Array([0x01, 0x02, 0xab, 0xcd]), locktime])
    : stripped;
  return { raw, txid: toHex(dsha(stripped).reverse()) };
}

/** A raw block: an 80-byte header with `time` at bytes 68..72, then the transactions. */
export function buildBlock(time: number, txs: Uint8Array[]): Uint8Array {
  const header = new Uint8Array(80);
  header.set(le(BigInt(time), 4), 68);
  return concatBytes([header, varint(txs.length), ...txs]);
}

export const POP_PREFIX = "6a4c5048454d49";
export const P2PKH: Hex = "0x76a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac";

export function popScript(abrev: Hex): Hex {
  return `0x${POP_PREFIX}${abrev.slice(2)}`;
}

/** A 76-byte abbreviated keystone from its parts (hashes are cut to their prefixes). */
export function buildAbrev(k: { version?: number; l1?: number; l2: number; parentHash: Hex; prevKeystoneHash: Hex; stateRoot: Hex; blockHash: Hex }): Hex {
  const u32 = (n: number) => toHex(n, { size: 4 }).slice(2);
  return `0x${toHex(k.version ?? 1, { size: 1 }).slice(2)}${u32(k.l1 ?? 26_301_090)}${u32(k.l2)}${k.parentHash.slice(2, 24)}${k.prevKeystoneHash.slice(2, 26)}${k.stateRoot.slice(2)}${k.blockHash.slice(2, 26)}`;
}

/** The answer hVM's 0x42 gives with flags 003c0703 for a PoP transaction: a spent P2PKH, then `script` (UTXO byte 0). */
export function popTxOutputs(script: Hex): Hex {
  const len = (script.length - 2) / 2;
  return `0x0002${"0000000000004510"}0019${P2PKH.slice(2)}00${"0000000000000000"}${toHex(len, { size: 2 }).slice(2)}${script.slice(2)}00`;
}

// ---------------------------------------------------------------------------------------------
// Fake Esplora
// ---------------------------------------------------------------------------------------------

interface FakeBlock {
  height: number;
  hash: string;
  time: number;
  raw: Uint8Array;
}

export class FakeEsplora {
  readonly blocks = new Map<number, FakeBlock>();
  readonly requests: string[] = [];
  tip = 0;
  private server?: Server;
  url = "";

  /**
   * Adds a block at `height` (its hash derived from the height, and from `variant`: another variant is the block a
   * reorg puts at that height) and moves the tip up to it if needed.
   */
  add(height: number, time: number, txs: Uint8Array[] = [], variant = 0): string {
    const coinbase = buildTx([{ value: 50n, script: P2PKH }], { coinbase: true }).raw;
    const hash = `${height.toString(16).padStart(8, "0")}${variant.toString(16).padStart(8, "0")}${"0".repeat(48)}`;
    this.blocks.set(height, { height, hash, time, raw: buildBlock(time, [coinbase, ...txs]) });
    this.tip = Math.max(this.tip, height);
    return hash;
  }

  private page(top: number): { id: string; height: number; timestamp: number }[] {
    const out = [];
    for (let h = top; h > top - 10; h--) {
      const b = this.blocks.get(h);
      if (b) out.push({ id: b.hash, height: b.height, timestamp: b.time });
    }
    return out;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const path = (req.url ?? "/").replace(/\/+$/, "");
      this.requests.push(path);
      const send = (status: number, body: string | Uint8Array, type = "text/plain") => {
        res.statusCode = status;
        res.setHeader("content-type", type);
        res.end(body);
      };
      let m: RegExpMatchArray | null;
      if (path === "/blocks/tip/height") return send(200, String(this.tip));
      if (path === "/blocks") return send(200, JSON.stringify(this.page(this.tip)), "application/json");
      if ((m = path.match(/^\/blocks\/(\d+)$/))) return send(200, JSON.stringify(this.page(Math.min(this.tip, Number(m[1])))), "application/json");
      if ((m = path.match(/^\/block-height\/(\d+)$/))) {
        const b = this.blocks.get(Number(m[1]));
        return b ? send(200, b.hash) : send(404, "Block not found");
      }
      if ((m = path.match(/^\/block\/([0-9a-f]{64})\/raw$/))) {
        const b = [...this.blocks.values()].find((x) => x.hash === m![1]);
        return b ? send(200, b.raw, "application/octet-stream") : send(404, "Block not found");
      }
      if (path.match(/^\/address\/[^/]+\/txs/)) return send(200, "[]", "application/json");
      return send(404, "not in this fake");
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  /** The same, as a fetch function (for EsploraClient's `fetch` option, no server needed). */
  get fetch(): typeof fetch {
    return (async (input: string | URL | Request) => {
      if (!this.url) await this.start();
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return fetch(u.replace(/^https?:\/\/[^/]+(\/api)?/, this.url));
    }) as typeof fetch;
  }

  close(): void {
    this.server?.close();
  }
}
