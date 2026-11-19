// ============================================================
// TOP-UPS — shared constants for the browser and the Convex backend.
// USD stablecoins (1 token = $1) or each network's native coin, sent
// from the user's linked wallet to DEPOSIT_DESTINATION_ADDRESS.
// Native coins are credited at the Chainlink USD price the server reads
// when it first sees the mined transaction. Contract and feed addresses
// were checked on-chain (symbol / description + decimals) before listing.
// ============================================================

export const MIN_TOPUP_USD = 25
export const STABLE_DECIMALS = 6

export type StableSymbol = 'USDC' | 'USDT'
export type NativeSymbol = 'ETH' | 'POL'
export type DepositSymbol = StableSymbol | NativeSymbol

export const NATIVE_DECIMALS = 18

export interface DepositToken {
  symbol: StableSymbol
  address: `0x${string}`
}

export interface NativeAsset {
  symbol: NativeSymbol
  /** Chainlink <symbol>/USD aggregator on the same chain (8 decimals). */
  priceFeed: `0x${string}`
  /** Refuse a price older than this (feed heartbeat + slack). */
  maxPriceAgeSec: number
}

export interface DepositChain {
  chainId: number
  name: string
  /** Blocks on top of the transfer's block before it is credited. */
  confirmations: number
  /** Test networks credit real USD from free tokens: off unless DEPOSIT_ALLOW_TESTNET=true. */
  testnet: boolean
  /** ERC-20 stablecoins. */
  tokens: DepositToken[]
  /** The chain's own coin, sent as a plain value transfer. */
  native: NativeAsset
}

export const DEPOSIT_CHAINS: DepositChain[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    confirmations: 6,
    testnet: false,
    tokens: [
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
      { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }
    ],
    native: { symbol: 'ETH', priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', maxPriceAgeSec: 2 * 3600 }
  },
  {
    chainId: 42161,
    name: 'Arbitrum',
    confirmations: 3,
    testnet: false,
    tokens: [
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
      { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' }
    ],
    native: { symbol: 'ETH', priceFeed: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', maxPriceAgeSec: 25 * 3600 }
  },
  {
    chainId: 137,
    name: 'Polygon',
    confirmations: 32,
    testnet: false,
    tokens: [
      { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
      { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' }
    ],
    // Chainlink still labels this feed "MATIC / USD"; it prices POL.
    native: { symbol: 'POL', priceFeed: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0', maxPriceAgeSec: 25 * 3600 }
  },
  {
    chainId: 11155111,
    name: 'Sepolia',
    confirmations: 3,
    testnet: true,
    tokens: [
      { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
      // Aave v3 faucet USDT (6 decimals) — mint at app.aave.com/faucet.
      { symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' }
    ],
    native: { symbol: 'ETH', priceFeed: '0x694AA1769357215DE4FAC081bf1f309aDC325306', maxPriceAgeSec: 25 * 3600 }
  }
]

/**
 * Public RPCs that serve eth_getTransactionReceipt for recent blocks without a
 * key (checked against live receipts). publicnode's Arbitrum endpoint refuses
 * receipts without a token and polygon-rpc.com is disabled, so neither is used.
 * The server can override per chain with DEPOSIT_RPC_URL_<chainId>.
 */
export const PUBLIC_RPC: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  42161: 'https://arb1.arbitrum.io/rpc',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com'
}

export function depositChain(chainId: number): DepositChain | undefined {
  return DEPOSIT_CHAINS.find((c) => c.chainId === chainId)
}

/**
 * True when `usd` is a finite amount in whole cents. Float-safe: `32.02 * 100`
 * is 3202.0000000000005, so an exact `=== Math.round(x)` test wrongly rejects it.
 */
export function isWholeCents(usd: number): boolean {
  if (!Number.isFinite(usd)) return false
  const cents = usd * 100
  return Math.abs(cents - Math.round(cents)) < 1e-6
}

/** USD (2dp) → token base units (6dp), exactly. */
export function usdToUnits(usd: number): bigint {
  return BigInt(Math.round(usd * 100)) * 10n ** BigInt(STABLE_DECIMALS - 2)
}

/** Token base units → USD number (stablecoins at par). */
export function unitsToUsd(units: bigint): number {
  return Number(units) / 10 ** STABLE_DECIMALS
}

/** Chainlink aggregator reads (shared by the server's verifier and the browser's estimate). */
export const PRICE_FEED_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' }
    ]
  }
] as const
export const PRICE_FEED_DECIMALS = 8

/** Native base units (wei) → USD, rounded down to the cent. */
export function nativeUnitsToUsd(units: bigint, priceUsd: number): number {
  // Exact integer math: floats turn 631847.99999… cents into 631847 (a cent short).
  const cents = (units * priceUnits(priceUsd) * 100n) / WEI_PRICE_SCALE
  return Number(cents) / 100
}

/** USD → native base units at `priceUsd`, rounded up so the credit reaches the amount. */
export function usdToNativeUnits(usd: number, priceUsd: number): bigint {
  const cents = BigInt(Math.round(usd * 100))
  const num = cents * WEI_PRICE_SCALE
  const den = 100n * priceUnits(priceUsd)
  return (num + den - 1n) / den // ceil, so nativeUnitsToUsd(result) ≥ usd exactly
}

/** Chainlink answers are integers at 8 decimals; recover that integer from the float. */
function priceUnits(priceUsd: number): bigint {
  const units = BigInt(Math.round(priceUsd * 10 ** PRICE_FEED_DECIMALS))
  if (units <= 0n) throw new Error('Price must be positive.')
  return units
}
const WEI_PRICE_SCALE = 10n ** BigInt(NATIVE_DECIMALS + PRICE_FEED_DECIMALS)

/** Wallets link by signing this exact text; the server rebuilds it to verify. */
export function linkWalletMessage(accountId: string, address: string, issuedAt: string): string {
  return [
    'SuperCEX — link wallet',
    '',
    `Wallet: ${address}`,
    `Account: ${accountId}`,
    `Issued at: ${issuedAt}`,
    '',
    'Signing proves you own this wallet so top-ups from it can be credited to your account.',
    'It does not send a transaction or cost gas.'
  ].join('\n')
}

export const LINK_MESSAGE_TTL_MS = 10 * 60_000
