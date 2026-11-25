import { CRYPTO_SYMBOLS } from '@/lib/config/instruments'
import type { HlCategory } from '@/lib/hyperliquid'
import type { OkxPerpCategory } from '@/lib/okx'
import { exitPriceForPnl } from '@/lib/paper/math'

/** Asset class across venues (OKX has no fx/index perps). */
export type AssetCategory = OkxPerpCategory | HlCategory

/** Data source for the /perps pages. OKX is the default (no search param). */
export type MarketVenue = 'okx' | 'hyperliquid'

export const VENUE_LABEL: Record<MarketVenue, string> = { okx: 'OKX', hyperliquid: 'Hyperliquid' }

/** `?venue=` search for links: omitted for the OKX default. */
export const venueSearch = (venue: MarketVenue): { venue?: 'hyperliquid' } => (venue === 'hyperliquid' ? { venue } : {})

export interface AssetIndexItem {
  venue?: MarketVenue
  /** OKX instId ("BTC-USDT-SWAP") or Hyperliquid coin ("BTC", "xyz:GBP"). */
  instId: string
  /** Display symbol ("GBP"). */
  base: string
  /** Hyperliquid builder dex ("xyz") for HIP-3 markets. */
  dex?: string
  category: AssetCategory
  tickSz?: number
  maxLeverage?: number
  preMarket?: boolean
}

export const CATEGORY_LABEL: Record<AssetCategory, string> = {
  crypto: 'Crypto',
  stock: 'Equity',
  commodity: 'Commodity',
  fx: 'FX',
  index: 'Index',
  other: 'Perp'
}

export function decimalsFor(price: number, tickSz?: number): number {
  if (tickSz && tickSz > 0) return Math.min(8, Math.max(0, Math.round(-Math.log10(tickSz))))
  if (!(price > 0)) return 2
  return price >= 1000 ? 1 : price >= 1 ? 2 : Math.min(8, 2 - Math.floor(Math.log10(price)) + 1)
}

export function fmtPrice(price: number | undefined, tickSz?: number): string {
  if (price === undefined || !Number.isFinite(price)) return '—'
  const d = decimalsFor(price, tickSz)
  return price.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

const exitPriceFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

export function fmtExitPrice(position: Parameters<typeof exitPriceForPnl>[0], pnl: number): string {
  return exitPriceFormat.format(exitPriceForPnl(position, pnl))
}

export function fmtCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '—'
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

export function sparkLinePath(points: ReadonlyArray<readonly [number, number]>, precision = 1): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(precision)},${y.toFixed(precision)}`).join(' ')
}

/** SVG line + area for a series of values, scaled into a w×h box. */
export function sparkPaths(
  values: number[],
  w: number,
  h: number,
  pad = 2
): { line: string; area: string; lo: number; hi: number; points: Array<readonly [number, number]> } | null {
  const pts = values.filter(Number.isFinite)
  if (pts.length < 2) return null
  const lo = Math.min(...pts)
  const hi = Math.max(...pts)
  const span = hi - lo || hi * 0.001 || 1
  const step = w / (pts.length - 1)
  const points = pts.map((v, i) => [i * step, h - pad - ((v - lo) / span) * (h - pad * 2)] as const)
  const line = sparkLinePath(points)
  return { line, area: `${line} L${w},${h} L0,${h} Z`, lo, hi, points }
}

/** Terminal deep link for crypto perps the terminal supports; null otherwise. */
export function terminalHref(
  item: Pick<AssetIndexItem, 'base' | 'category' | 'dex'>,
  venue: MarketVenue = 'okx'
): string | null {
  const symbol = `${item.base}USDT`
  return item.category === 'crypto' && !item.dex && CRYPTO_SYMBOLS.includes(symbol)
    ? `/terminal?market=perpetual&symbol=${symbol}&venue=${venue === 'hyperliquid' ? 'hyperliquid' : 'okx-futures'}`
    : null
}

/** Route param ↔ instrument: /perps/AAPL ↔ AAPL-USDT-SWAP; Hyperliquid uses the coin (/perps/xyz:GBP). */
export const assetIdOf = (item: Pick<AssetIndexItem, 'base' | 'instId' | 'venue'>) =>
  item.venue === 'hyperliquid' ? item.instId : item.base
export const instIdFromAssetId = (assetId: string) => `${assetId.toUpperCase()}-USDT-SWAP`

/** Coin icon for a venue's asset. Hyperliquid takes the full coin ("xyz:GBP"). */
export const glyphSrc = (coin: string, venue: MarketVenue = 'okx') =>
  venue === 'hyperliquid'
    ? `https://app.hyperliquid.xyz/coins/${coin}.svg`
    : `https://static.okx.com/cdn/oksupport/asset/currency/icon/${coin.split('-')[0].toLowerCase()}.png`

/** Position/trade size: compact when large, keeps precision for fractional fills. */
export function fmtSize(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '—'
  if (value >= 10_000) return fmtCompact(value)
  const digits = value >= 100 ? 1 : value >= 1 ? 2 : 4
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}
