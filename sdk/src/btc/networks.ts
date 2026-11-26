/**
 * The Bitcoin networks the bond tooling works on, and which Hemi chain reads which.
 *
 * Hemi mainnet (43111) reads Bitcoin mainnet and Hemi testnet (743111) reads testnet3 (DECISIONS.md D-010). Any
 * other chain id is a local chain (anvil), which may pair with any network, regtest included.
 */
import { NETWORK, TEST_NETWORK } from "@scure/btc-signer";
import { HEMI_MAINNET_CHAIN_ID, HEMI_TESTNET_CHAIN_ID, UsageError } from "../common.js";

export type BtcNet = "mainnet" | "testnet" | "regtest";
export const BTC_NETS: readonly BtcNet[] = ["mainnet", "testnet", "regtest"];

/** Address and WIF parameters in @scure/btc-signer's shape. */
export type BtcParams = typeof NETWORK;

/** Bitcoin Core's regtest: bech32 `bcrt`, base58 and WIF as testnet. */
export const REGTEST_NETWORK: BtcParams = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export const BTC_PARAMS: Record<BtcNet, BtcParams> = {
  mainnet: NETWORK,
  testnet: TEST_NETWORK,
  regtest: REGTEST_NETWORK,
};

/** Esplora instances, tried in order (mempool.space throttles hard after bursts, D-012 item 8). */
export const ESPLORA_URLS: Record<Exclude<BtcNet, "regtest">, string[]> = {
  mainnet: ["https://mempool.space/api", "https://blockstream.info/api"],
  testnet: ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"],
};

export function isBtcNet(value: unknown): value is BtcNet {
  return value === "mainnet" || value === "testnet" || value === "regtest";
}

/**
 * The Bitcoin network a bond for Hemi chain `chainId` lives on. Hemi mainnet and testnet fix it; a local chain takes
 * `requested` (required then). A request that disagrees with a Hemi chain is a usage error: a bond on the wrong
 * Bitcoin network can never be read by that chain's hVM.
 */
export function btcNetForChain(chainId: number, requested?: string): BtcNet {
  if (requested !== undefined && !isBtcNet(requested)) {
    throw new UsageError('--btc-network must be "mainnet", "testnet" or "regtest"');
  }
  const fixed: BtcNet | undefined =
    chainId === HEMI_MAINNET_CHAIN_ID ? "mainnet" : chainId === HEMI_TESTNET_CHAIN_ID ? "testnet" : undefined;
  if (fixed && requested && requested !== fixed) {
    throw new UsageError(`Hemi chain ${chainId} reads Bitcoin ${fixed}; a bond on ${requested} could never be recorded there`);
  }
  const net = fixed ?? requested;
  if (!net) throw new UsageError(`chain ${chainId} is not a Hemi network: --btc-network mainnet|testnet|regtest is required`);
  return net;
}
