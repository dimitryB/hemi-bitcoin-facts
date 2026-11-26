import {
  encodeAbiParameters,
  hexToBigInt,
  hexToNumber,
  isHex,
  size,
  slice,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  serializeTypedData,
  type Address,
  type Hex,
  type LocalAccount,
  type WalletClient,
} from "viem";
import type { ManifestV1 } from "./manifest.js";
import { hashManifest } from "./manifest.js";

/** The five fields that go on chain for one receipt. Everything else stays off chain. */
export interface ReceiptFields {
  runId: Hex;
  manifestHash: Hex;
  agent: Address;
  principal: Address;
  schemaVersion: number;
}

/** EIP-712 domain of ReceiptRegistry. chainId and verifyingContract come from the deployment. */
export const EIP712_DOMAIN_NAME = "HemiAgentReceipts";
export const EIP712_DOMAIN_VERSION = "1";

export type RegistryDomain = {
  name: typeof EIP712_DOMAIN_NAME;
  version: typeof EIP712_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: Address;
};

export function registryDomain(chainId: number, registry: Address): RegistryDomain {
  return { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId, verifyingContract: registry };
}

/** Signed by the agent (or its principal). Mirrors RECEIPT_TYPEHASH in ReceiptRegistry.sol. */
export const receiptTypes = {
  Receipt: [
    { name: "runId", type: "bytes32" },
    { name: "manifestHash", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "principal", type: "address" },
    { name: "schemaVersion", type: "uint16" },
  ],
} as const;

/**
 * Signed by the service for the direct path. `receiptDigest` is the agent's FULL EIP-712
 * digest (0x1901 ‖ domainSeparator ‖ structHash), not the struct hash, so the two
 * signatures are domain-separated.
 */
export const serviceAttestationTypes = {
  ServiceAttestation: [
    { name: "receiptDigest", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/** Signed by the service for the batch path. */
export const batchAttestationTypes = {
  BatchAttestation: [
    { name: "root", type: "bytes32" },
    { name: "count", type: "uint32" },
    { name: "schemaVersion", type: "uint16" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function receiptFromManifest(manifest: ManifestV1): ReceiptFields {
  return {
    runId: manifest.runId,
    manifestHash: hashManifest(manifest),
    agent: manifest.agent,
    principal: manifest.principal,
    schemaVersion: manifest.receiptVersion,
  };
}

/**
 * Merkle leaf: keccak256(abi.encode(runId, manifestHash, agent, principal)). The preimage is
 * 128 bytes, so no leaf can be mistaken for a 64-byte internal node.
 */
export function leafHash(receipt: Pick<ReceiptFields, "runId" | "manifestHash" | "agent" | "principal">): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" }],
      [receipt.runId, receipt.manifestHash, receipt.agent, receipt.principal],
    ),
  );
}

export function receiptTypedData(receipt: ReceiptFields, domain: RegistryDomain) {
  return {
    domain,
    types: receiptTypes,
    primaryType: "Receipt" as const,
    message: {
      runId: receipt.runId,
      manifestHash: receipt.manifestHash,
      agent: receipt.agent,
      principal: receipt.principal,
      schemaVersion: receipt.schemaVersion,
    },
  };
}

/** The full EIP-712 digest the agent signs. */
export function receiptDigest(receipt: ReceiptFields, domain: RegistryDomain): Hex {
  return hashTypedData(receiptTypedData(receipt, domain));
}

/**
 * JSON for eth_signTypedData_v4 (browser wallets). Declares EIP712Domain explicitly: viem's
 * serializer only emits domain fields declared in types.EIP712Domain, and without it the
 * wallet signs `domain: {}`.
 */
const eip712DomainTypes = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export function serializeReceiptTypedData(receipt: ReceiptFields, domain: RegistryDomain): string {
  const typedData = receiptTypedData(receipt, domain);
  return serializeTypedData({
    ...typedData,
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    types: { EIP712Domain: eip712DomainTypes, ...typedData.types },
  });
}

export function serviceAttestationTypedData(digest: Hex, deadline: bigint, domain: RegistryDomain) {
  return {
    domain,
    types: serviceAttestationTypes,
    primaryType: "ServiceAttestation" as const,
    message: { receiptDigest: digest, deadline },
  };
}

export interface BatchEnvelope {
  root: Hex;
  count: number;
  schemaVersion: number;
  deadline: bigint;
}

export function batchAttestationTypedData(batch: BatchEnvelope, domain: RegistryDomain) {
  return {
    domain,
    types: batchAttestationTypes,
    primaryType: "BatchAttestation" as const,
    message: { root: batch.root, count: batch.count, schemaVersion: batch.schemaVersion, deadline: batch.deadline },
  };
}

/** Anything that can sign EIP-712: a viem LocalAccount, or a WalletClient with an account. */
export type TypedDataSigner = Pick<LocalAccount, "signTypedData"> | WalletClient;

/** The agent (or principal) signs the Receipt struct. Returns a 65-byte signature. */
export async function signReceipt(signer: TypedDataSigner, receipt: ReceiptFields, domain: RegistryDomain): Promise<Hex> {
  const typedData = receiptTypedData(receipt, domain);
  if ("account" in signer && signer.account) {
    return (signer as WalletClient).signTypedData({ ...typedData, account: signer.account });
  }
  return (signer as Pick<LocalAccount, "signTypedData">).signTypedData(typedData);
}

/** Half the secp256k1 group order: OpenZeppelin's ECDSA rejects any s above it. */
export const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * True when `signature` is an ECDSA signature in the only form ReceiptRegistry accepts from
 * an EOA (OpenZeppelin ECDSA.tryRecover): exactly 65 bytes r ‖ s ‖ v, v ∈ {27, 28}, and a
 * non-zero low s. viem's recovery is more lenient (64-byte EIP-2098, v ∈ {0, 1}, high s), so
 * the SDK applies this rule itself and agrees with the contract.
 */
export function isCanonicalEcdsaSignature(signature: Hex): boolean {
  if (!isHex(signature) || size(signature) !== 65) return false;
  const s = hexToBigInt(slice(signature, 32, 64));
  const v = hexToNumber(slice(signature, 64, 65));
  return (v === 27 || v === 28) && s !== 0n && s <= SECP256K1_HALF_N;
}

/**
 * Recovers the EOA that signed a receipt, applying the contract's rules
 * (isCanonicalEcdsaSignature). Contract wallets (EIP-1271) need an RPC check instead.
 */
export async function recoverReceiptSigner(receipt: ReceiptFields, signature: Hex, domain: RegistryDomain): Promise<Address> {
  if (!isCanonicalEcdsaSignature(signature)) {
    throw new Error("not a canonical ECDSA signature: it must be 65 bytes with v 27 or 28 and a low s, as ReceiptRegistry requires");
  }
  return recoverTypedDataAddress({ ...receiptTypedData(receipt, domain), signature });
}
