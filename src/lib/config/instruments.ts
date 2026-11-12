// Crypto instrument catalog. Venue coverage was checked against each
// exchange's public instruments endpoint; coins without a bundled logo fall
// back to a monogram badge in their brand colour.

import { IconName } from '../icons'

export interface CryptoAsset {
  base: string // e.g. "BTC"
  name: string
  color: string // brand colour, used for monogram fallback
  icon: IconName
}

export const CRYPTO_ASSETS: CryptoAsset[] = [
  { base: 'BTC', name: 'Bitcoin', color: '#F7931A', icon: 'btc' },
  { base: 'ETH', name: 'Ethereum', color: '#627EEA', icon: 'eth' },
  { base: 'XRP', name: 'XRP', color: '#23292F', icon: 'xrp' },
  { base: 'BNB', name: 'BNB', color: '#F3BA2F', icon: 'bnb' },
  { base: 'SOL', name: 'Solana', color: '#9945FF', icon: 'sol' },
  { base: 'DOGE', name: 'Dogecoin', color: '#C2A633', icon: 'doge' },
  { base: 'TRX', name: 'TRON', color: '#FF060A', icon: 'trx' },
  { base: 'ADA', name: 'Cardano', color: '#0033AD', icon: 'ada' },
  { base: 'HYPE', name: 'Hyperliquid', color: '#97FCE4', icon: 'hype' },
  { base: 'LINK', name: 'Chainlink', color: '#2A5ADA', icon: 'link' },
  { base: 'SUI', name: 'Sui', color: '#4DA2FF', icon: 'sui' },
  { base: 'AVAX', name: 'Avalanche', color: '#E84142', icon: 'avax' },
  { base: 'BCH', name: 'Bitcoin Cash', color: '#8DC351', icon: 'bch' },
  { base: 'LTC', name: 'Litecoin', color: '#345D9D', icon: 'ltc' },
  { base: 'DOT', name: 'Polkadot', color: '#E6007A', icon: 'dot' },
  { base: 'UNI', name: 'Uniswap', color: '#FF007A', icon: 'uni' },
  { base: 'NEAR', name: 'NEAR', color: '#00C08B', icon: 'near' },
  { base: 'APT', name: 'Aptos', color: '#2ED8A7', icon: 'apt' },
  { base: 'AAVE', name: 'Aave', color: '#B6509E', icon: 'aave' },
  { base: 'ETC', name: 'Ethereum Classic', color: '#328332', icon: 'etc' },
  { base: 'ATOM', name: 'Cosmos', color: '#6F7390', icon: 'atom' },
  { base: 'ARB', name: 'Arbitrum', color: '#28A0F0', icon: 'arb' },
  { base: 'OP', name: 'Optimism', color: '#FF0420', icon: 'op' },
  { base: 'INJ', name: 'Injective', color: '#0082FA', icon: 'inj' },
  { base: 'FIL', name: 'Filecoin', color: '#0090FF', icon: 'fil' },
  { base: 'SEI', name: 'Sei', color: '#9E1F19', icon: 'sei' },
  { base: 'TIA', name: 'Celestia', color: '#7B2BF9', icon: 'tia' }
]

export const CRYPTO_SYMBOLS = CRYPTO_ASSETS.map((asset) => `${asset.base}USDT`)

const BY_BASE = new Map(CRYPTO_ASSETS.map((asset) => [asset.base, asset]))

export function baseOf(symbol: string): string {
  if (symbol.includes('/')) return symbol.split('/')[0].toUpperCase()
  return symbol.toUpperCase().replace(/(USDT|USDC|USD)$/, '')
}

export function assetFor(symbol: string): CryptoAsset | undefined {
  return BY_BASE.get(baseOf(symbol))
}

export const VENUE_LOGOS: Partial<Record<string, IconName>> = {
  'binance-futures': 'binance',
  'binance-spot': 'binance',
  'bybit-futures': 'bybit',
  'bybit-spot': 'bybit',
  'okx-futures': 'okx',
  'okx-spot': 'okx',
  'bitget-futures': 'bitget',
  'bitget-spot': 'bitget',
  'coinbase-spot': 'coinbase'
}
