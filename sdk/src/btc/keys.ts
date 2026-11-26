/**
 * The single Bitcoin key `bond create` funds from and `bond redeem` signs with. It comes from a file under a
 * `.secrets/` directory (`--btc-key-file`), never a prompt (docs/DECISIONS.md D-029), as a WIF for the network or 32 bytes of hex. It is
 * never printed, logged or written anywhere; only the public key and addresses derived from it are shown.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { p2tr, p2wpkh, WIF } from "@scure/btc-signer";
import { keyFileRequired, readSecretPath, UsageError } from "../common.js";
import { isAddressType, type AddressType } from "../vendor/x402-btc/derive.js";
import { BTC_PARAMS, type BtcNet } from "./networks.js";

export type { AddressType };

export interface BtcKey {
  readonly network: BtcNet;
  readonly addressType: AddressType;
  /** Compressed SEC1 public key. */
  readonly publicKey: Uint8Array;
  /** The funding address (P2WPKH or BIP86 key-path P2TR) and its scriptPubKey. */
  readonly address: string;
  readonly script: Uint8Array;
  /** The private key. Kept in memory only; never print or log it. */
  readonly privateKey: Uint8Array;
}

/** Parses a WIF for `network` (compressed) or 32 bytes of hex (0x optional). The message never echoes the input. */
export function parsePrivateKey(text: string, network: BtcNet): Uint8Array {
  const t = text.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) {
    const key = Uint8Array.from(Buffer.from(t.replace(/^0x/, ""), "hex"));
    if (!secp256k1.utils.isValidPrivateKey(key)) throw new UsageError("the Bitcoin key is not a valid secp256k1 private key");
    return key;
  }
  try {
    return WIF(BTC_PARAMS[network]).decode(t);
  } catch {
    throw new UsageError(`the Bitcoin key must be a compressed WIF for ${network} or 32 bytes of hex`);
  }
}

export function btcKey(privateKey: Uint8Array, network: BtcNet, addressType: AddressType = "p2wpkh"): BtcKey {
  if (!isAddressType(addressType)) throw new UsageError('--address-type must be "p2wpkh" or "p2tr"');
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const params = BTC_PARAMS[network];
  const out = addressType === "p2tr" ? p2tr(publicKey.subarray(1), undefined, params) : p2wpkh(publicKey, params);
  if (!out.address) throw new Error(`cannot encode a ${addressType} address`);
  return { network, addressType, publicKey, address: out.address, script: out.script, privateKey };
}

/** Reads a key file. It must resolve inside a `.secrets/` directory (gitignored), as `--key-file` must. */
export function readSecretFile(path: string, flag: string): string {
  return readSecretPath(path, flag);
}

export async function loadBtcKey(options: { keyFile?: string; network: BtcNet; addressType?: AddressType }): Promise<BtcKey> {
  if (!options.keyFile) throw keyFileRequired("--btc-key-file", `the ${options.network} key as WIF or hex`);
  const text = readSecretFile(options.keyFile, "--btc-key-file");
  return btcKey(parsePrivateKey(text, options.network), options.network, options.addressType);
}
