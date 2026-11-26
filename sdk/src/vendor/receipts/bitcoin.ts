import { sha256, toHex, type Hex } from "viem";

/**
 * Minimal Bitcoin raw-block parsing for the PoP scanner: find the transactions that contain a
 * byte pattern, with their txids and output scripts. Only what the scanner needs.
 */

function varint(b: Uint8Array, i: number): [number, number] {
  const x = b[i]!;
  if (x < 0xfd) return [x, i + 1];
  if (x === 0xfd) return [b[i + 1]! | (b[i + 2]! << 8), i + 3];
  if (x === 0xfe) return [(b[i + 1]! | (b[i + 2]! << 8) | (b[i + 3]! << 16)) + b[i + 4]! * 2 ** 24, i + 5];
  let n = 0;
  for (let k = 8; k >= 1; k--) n = n * 256 + b[i + k]!;
  return [n, i + 9];
}

/** All start offsets of `needle` in `haystack`. */
export function findAll(haystack: Uint8Array, needle: Uint8Array): number[] {
  const out: number[] = [];
  const first = needle[0]!;
  outer: for (let i = haystack.indexOf(first); i !== -1 && i <= haystack.length - needle.length; i = haystack.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    out.push(i);
  }
  return out;
}

export interface RawTx {
  txid: Hex;
  /** Byte range of the transaction in the block. */
  start: number;
  end: number;
  /** Output scripts, in order. */
  outputs: Hex[];
}

const dsha = (b: Uint8Array): Uint8Array => sha256(sha256(b, "bytes"), "bytes");

/** Block header timestamp (unix seconds). */
export function blockTime(raw: Uint8Array): number {
  return raw[68]! | (raw[69]! << 8) | (raw[70]! << 16) | (raw[71]! * 2 ** 24);
}

/**
 * Walks a raw block and returns the transactions whose bytes include one of `offsets`
 * (txid computed without witness data, as Bitcoin does). Other transactions are skipped
 * without hashing.
 */
export function transactionsContaining(raw: Uint8Array, offsets: number[]): RawTx[] {
  if (offsets.length === 0) return [];
  const wanted = [...offsets].sort((a, b) => a - b);
  const out: RawTx[] = [];
  let [count, i] = varint(raw, 80);
  for (let t = 0; t < count && i < raw.length; t++) {
    const start = i;
    i += 4;
    const segwit = raw[i] === 0 && raw[i + 1] === 1;
    if (segwit) i += 2;
    const [nin, afterNin] = varint(raw, i);
    i = afterNin;
    for (let k = 0; k < nin; k++) {
      i += 36;
      const [len, j] = varint(raw, i);
      i = j + len + 4;
    }
    const [nout, afterNout] = varint(raw, i);
    i = afterNout;
    const outputs: [number, number][] = [];
    for (let k = 0; k < nout; k++) {
      i += 8;
      const [len, j] = varint(raw, i);
      outputs.push([j, j + len]);
      i = j + len;
    }
    const ioEnd = i;
    if (segwit) {
      for (let k = 0; k < nin; k++) {
        const [items, j] = varint(raw, i);
        i = j;
        for (let w = 0; w < items; w++) {
          const [len, j2] = varint(raw, i);
          i = j2 + len;
        }
      }
    }
    i += 4;
    const end = i;
    if (wanted.some((o) => o >= start && o < end)) {
      const ser = segwit
        ? new Uint8Array([...raw.subarray(start, start + 4), ...raw.subarray(start + 6, ioEnd), ...raw.subarray(end - 4, end)])
        : raw.subarray(start, end);
      out.push({ txid: toHex(dsha(ser).reverse()), start, end, outputs: outputs.map(([a, b]) => toHex(raw.subarray(a, b))) });
    }
  }
  return out;
}
