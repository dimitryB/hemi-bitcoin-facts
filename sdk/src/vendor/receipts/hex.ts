import type { Address, Hex } from "viem";

/** 0x-prefixed, lowercase, exactly 32 bytes. The only accepted spelling of a bytes32 in a manifest. */
export const BYTES32_RE = /^0x[0-9a-f]{64}$/;
/** 0x-prefixed, lowercase, exactly 20 bytes. The only accepted spelling of an address in a manifest. */
export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
/** Any-case variants, accepted by the normalizers only. */
const BYTES32_ANYCASE_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_ANYCASE_RE = /^0x[0-9a-fA-F]{40}$/;

export const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;
export const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

export function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && BYTES32_RE.test(value);
}

export function isLowerAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

/** Lowercases a bytes32 written in any case; returns the input unchanged if it is not one. */
export function lowerBytes32(value: unknown): unknown {
  return typeof value === "string" && BYTES32_ANYCASE_RE.test(value) ? value.toLowerCase() : value;
}

/** Lowercases an address written in any case (EIP-55 or not); returns the input unchanged if it is not one. */
export function lowerAddress(value: unknown): unknown {
  return typeof value === "string" && ADDRESS_ANYCASE_RE.test(value) ? value.toLowerCase() : value;
}
