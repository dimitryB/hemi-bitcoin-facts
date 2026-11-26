import { defineChain, type Address, type Chain } from "viem";

/**
 * Hemi networks. RPC order matters: the first URL is tried first.
 * Testnet leaves dRPC out: when checked on 2026-10-29, hemi-testnet.drpc.org reported head
 * 4,443,639 while the public RPC reported 7,100,459, about 2.66 million blocks behind
 * (docs/DECISIONS.md D-6).
 */
export interface HemiNetwork {
  key: "hemi" | "hemi-testnet";
  chainId: number;
  caip2: `eip155:${number}`;
  name: string;
  rpcUrls: string[];
  explorer: string;
}

export const HEMI_MAINNET: HemiNetwork = {
  key: "hemi",
  chainId: 43_111,
  caip2: "eip155:43111",
  name: "Hemi",
  rpcUrls: ["https://rpc.hemi.network/rpc", "https://hemi.drpc.org"],
  explorer: "https://explorer.hemi.xyz",
};

export const HEMI_TESTNET: HemiNetwork = {
  key: "hemi-testnet",
  chainId: 743_111,
  caip2: "eip155:743111",
  name: "Hemi Testnet",
  rpcUrls: ["https://testnet.rpc.hemi.network/rpc"],
  explorer: "https://testnet.explorer.hemi.xyz",
};

export const HEMI_NETWORKS: Record<number, HemiNetwork> = {
  [HEMI_MAINNET.chainId]: HEMI_MAINNET,
  [HEMI_TESTNET.chainId]: HEMI_TESTNET,
};

function toChain(network: HemiNetwork): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: network.rpcUrls } },
    blockExplorers: { default: { name: "Hemi Explorer", url: network.explorer } },
    testnet: network.key === "hemi-testnet",
  });
}

export const hemiMainnet = toChain(HEMI_MAINNET);
export const hemiTestnet = toChain(HEMI_TESTNET);

/** A viem chain for any chain id: Hemi's own, or a local chain (anvil) with the given RPC. */
export function chainFor(chainId: number, rpcUrls: string[] = []): Chain {
  const known = HEMI_NETWORKS[chainId];
  if (known) return rpcUrls.length ? toChain({ ...known, rpcUrls }) : toChain(known);
  return defineChain({
    id: chainId,
    name: `Local ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls.length ? rpcUrls : ["http://127.0.0.1:8545"] } },
  });
}

export interface Deployment {
  registry: Address;
  deployBlock: bigint;
  deployTx: `0x${string}`;
}

/**
 * Known ReceiptRegistry deployments. The CLI's default --registry comes from here, never
 * from the receipt file being verified.
 */
export const DEPLOYMENTS: Record<number, Deployment | undefined> = {
  // Deployed 2026-10-29, source verified on testnet.explorer.hemi.xyz (docs/DECISIONS.md D-10).
  [HEMI_TESTNET.chainId]: {
    registry: "0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe",
    deployBlock: 7_100_598n,
    deployTx: "0x4a4ccaf43738405a2f88c38ec309c6e3c7377204e56b7261bd5abc4a380ce09c",
  },
  // Deployed 2026-11-13 (docs/DECISIONS.md D-14). Owner: a Safe.
  [HEMI_MAINNET.chainId]: {
    registry: "0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40",
    deployBlock: 5_722_390n,
    deployTx: "0xa03cba69f0b7beae8c0547182de386c90ba779248d013893fcecba8000aab3ff",
  },
};

export function explorerTxUrl(chainId: number, txHash: string): string | undefined {
  const network = HEMI_NETWORKS[chainId];
  return network ? `${network.explorer}/tx/${txHash}` : undefined;
}
