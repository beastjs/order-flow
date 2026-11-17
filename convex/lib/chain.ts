// Server-side EVM reads for top-up verification (actions only).
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrum, mainnet, polygon, sepolia } from "viem/chains";
import { PUBLIC_RPC } from "../../src/lib/deposits/config";

const CHAINS = { 1: mainnet, 137: polygon, 42161: arbitrum, 11155111: sepolia } as const;

/** Override any chain with DEPOSIT_RPC_URL_<chainId> (e.g. a keyed provider) for production. */
export function chainClient(chainId: number): PublicClient {
  const chain = CHAINS[chainId as keyof typeof CHAINS];
  const url = process.env[`DEPOSIT_RPC_URL_${chainId}`] || PUBLIC_RPC[chainId];
  if (!chain || !url) throw new Error(`Unsupported chain ${chainId}.`);
  return createPublicClient({ chain, transport: http(url, { timeout: 15_000, retryCount: 1 }) }) as PublicClient;
}
