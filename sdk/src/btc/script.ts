/**
 * The bond's scripts, byte for byte as contracts/src/FidelityBonds.sol checks them.
 *
 *   witness script (42 bytes): 04 <locktime: 4 bytes LE> b1 75 21 <33-byte compressed key> ac
 *                              = <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG   (JoinMarket's)
 *   bond output script:        00 20 <sha256(witness script)>                                     (P2WSH)
 *   tag output script (50):    6a 30 "HFB1" <chain id: 4 bytes BE> <contract: 20> <agent: 20>
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { Address as BtcAddress, OutScript } from "@scure/btc-signer";
import { bytesToHex, getAddress, hexToBytes, isAddress, type Address, type Hex } from "viem";
import { BTC_PARAMS, type BtcNet } from "./networks.js";

/** The contract's constants (test/bonds.test.ts reads them from the source). */
export const WITNESS_SCRIPT_LENGTH = 42;
export const TAG_LENGTH = 50;
export const TAG_MAGIC = "HFB1";
export const MIN_LOCKTIME = 500_000_000;
/** Exclusive: from 2^31 the 4-byte script number is negative and CLTV can never pass. */
export const LOCKTIME_LIMIT = 2 ** 31;
export const MIN_SATS = 10_000n;
export const MIN_CONFIRMATIONS = 6;

const OP_CHECKLOCKTIMEVERIFY = 0xb1;
const OP_DROP = 0x75;
const OP_CHECKSIG = 0xac;
const OP_RETURN = 0x6a;

export function isBondLocktime(locktime: number): boolean {
  return Number.isInteger(locktime) && locktime >= MIN_LOCKTIME && locktime < LOCKTIME_LIMIT;
}

/** A compressed secp256k1 public key that is on the curve. */
export function assertCompressedKey(pubkey: Uint8Array): void {
  if (pubkey.length !== 33 || (pubkey[0] !== 0x02 && pubkey[0] !== 0x03)) {
    throw new Error("the bond key must be a 33-byte compressed public key (02/03…)");
  }
  try {
    secp256k1.ProjectivePoint.fromHex(pubkey).assertValidity();
  } catch {
    throw new Error("the bond key is not a point on secp256k1");
  }
}

export function bondWitnessScript(locktime: number, pubkey: Uint8Array): Uint8Array {
  if (!isBondLocktime(locktime)) {
    throw new Error(`locktime ${locktime} is not a bond locktime: a Unix time from ${MIN_LOCKTIME} up to ${LOCKTIME_LIMIT - 1}`);
  }
  assertCompressedKey(pubkey);
  const ws = new Uint8Array(WITNESS_SCRIPT_LENGTH);
  ws[0] = 0x04;
  new DataView(ws.buffer).setUint32(1, locktime, true);
  ws[5] = OP_CHECKLOCKTIMEVERIFY;
  ws[6] = OP_DROP;
  ws[7] = 0x21;
  ws.set(pubkey, 8);
  ws[41] = OP_CHECKSIG;
  return ws;
}

/** The locktime and key of a witness script that matches the template exactly; throws otherwise. */
export function parseBondWitnessScript(ws: Uint8Array): { locktime: number; pubkey: Uint8Array } {
  if (
    ws.length !== WITNESS_SCRIPT_LENGTH ||
    ws[0] !== 0x04 ||
    ws[5] !== OP_CHECKLOCKTIMEVERIFY ||
    ws[6] !== OP_DROP ||
    ws[7] !== 0x21 ||
    (ws[8] !== 0x02 && ws[8] !== 0x03) ||
    ws[41] !== OP_CHECKSIG
  ) {
    throw new Error("not a bond witness script: 04 <locktime LE> b1 75 21 <33-byte key> ac");
  }
  const locktime = new DataView(ws.buffer, ws.byteOffset, ws.length).getUint32(1, true);
  return { locktime, pubkey: ws.slice(8, 41) };
}

/** sha256(witness script): the P2WSH program, which FidelityBonds stores as `witnessProgram`. */
export function witnessProgram(ws: Uint8Array): Uint8Array {
  return sha256(ws);
}

/** 0x0020 ‖ sha256(witness script). */
export function bondOutputScript(ws: Uint8Array): Uint8Array {
  return OutScript.encode({ type: "wsh", hash: witnessProgram(ws) });
}

export function bondAddress(ws: Uint8Array, net: BtcNet): string {
  return BtcAddress(BTC_PARAMS[net]).encode({ type: "wsh", hash: witnessProgram(ws) });
}

/** The 50-byte tag script naming `agent` for `contract` on Hemi chain `chainId`. */
export function tagScript(chainId: number, contract: Address, agent: Address): Uint8Array {
  if (!Number.isInteger(chainId) || chainId < 0 || chainId > 0xffffffff) throw new Error(`chain id ${chainId} does not fit in 4 bytes`);
  if (!isAddress(contract) || !isAddress(agent)) throw new Error("contract and agent must be EVM addresses");
  if (BigInt(agent) === 0n) throw new Error("the agent must not be the zero address");
  const s = new Uint8Array(TAG_LENGTH);
  s[0] = OP_RETURN;
  s[1] = 0x30;
  s.set(new TextEncoder().encode(TAG_MAGIC), 2);
  new DataView(s.buffer).setUint32(6, chainId, false);
  s.set(hexToBytes(contract), 10);
  s.set(hexToBytes(agent), 30);
  return s;
}

/** The fields of a well-formed tag script, or undefined. */
export function parseTagScript(s: Uint8Array): { chainId: number; contract: Address; agent: Address } | undefined {
  if (s.length !== TAG_LENGTH || s[0] !== OP_RETURN || s[1] !== 0x30) return undefined;
  if (new TextDecoder().decode(s.slice(2, 6)) !== TAG_MAGIC) return undefined;
  return {
    chainId: new DataView(s.buffer, s.byteOffset, s.length).getUint32(6, false),
    contract: getAddress(bytesToHex(s.slice(10, 30))),
    agent: getAddress(bytesToHex(s.slice(30, 50))),
  };
}

export const hex = (b: Uint8Array): Hex => bytesToHex(b);
