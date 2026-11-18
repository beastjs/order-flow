// Server-side EVM reads for top-up verification (actions only).
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrum, mainnet, polygon, sepolia } from "viem/chains";
import { PRICE_FEED_ABI, PRICE_FEED_DECIMALS, PUBLIC_RPC, type NativeAsset } from "../../src/lib/deposits/config";

const CHAINS = { 1: mainnet, 137: polygon, 42161: arbitrum, 11155111: sepolia } as const;

/** Override any chain with DEPOSIT_RPC_URL_<chainId> (e.g. a keyed provider) for production. */
export function chainClient(chainId: number): PublicClient {
  const chain = CHAINS[chainId as keyof typeof CHAINS];
  const url = process.env[`DEPOSIT_RPC_URL_${chainId}`] || PUBLIC_RPC[chainId];
  if (!chain || !url) throw new Error(`Unsupported chain ${chainId}.`);
  return createPublicClient({ chain, transport: http(url, { timeout: 15_000, retryCount: 1 }) }) as PublicClient;
}

/**
 * The native coin's USD price from its Chainlink feed. Throws when the feed is
 * stale or non-positive, so a bad price is retried rather than credited.
 */
export async function readNativePrice(client: PublicClient, native: NativeAsset, nowMs = Date.now()): Promise<number> {
  const [, answer, , updatedAt] = await client.readContract({
    address: native.priceFeed,
    abi: PRICE_FEED_ABI,
    functionName: "latestRoundData",
  });
  const ageSec = nowMs / 1000 - Number(updatedAt);
  if (answer <= 0n) throw new Error(`${native.symbol}/USD feed returned a non-positive price.`);
  if (ageSec > native.maxPriceAgeSec) throw new Error(`${native.symbol}/USD price is stale (${Math.round(ageSec / 60)} min old).`);
  return Number(answer) / 10 ** PRICE_FEED_DECIMALS;
}
