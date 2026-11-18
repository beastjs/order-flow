import { CRYPTO_SYMBOLS } from '@/lib/config/instruments'
import type { OkxPerpCategory } from '@/lib/okx'

export interface AssetIndexItem {
  instId: string
  base: string
  category: OkxPerpCategory
  tickSz?: number
  maxLeverage?: number
  preMarket?: boolean
}

export const CATEGORY_LABEL: Record<OkxPerpCategory, string> = {
  crypto: 'Crypto',
  stock: 'Equity',
  commodity: 'Commodity',
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

export function fmtCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '—'
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
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
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return { line, area: `${line} L${w},${h} L0,${h} Z`, lo, hi, points }
}

/** Terminal deep link for crypto perps the terminal supports; null otherwise. */
export function terminalHref(item: Pick<AssetIndexItem, 'base' | 'category'>): string | null {
  const symbol = `${item.base}USDT`
  return item.category === 'crypto' && CRYPTO_SYMBOLS.includes(symbol)
    ? `/terminal?market=perpetual&symbol=${symbol}&venue=okx-futures`
    : null
}

/** Route param ↔ instrument: /perps/AAPL ↔ AAPL-USDT-SWAP. */
export const assetIdOf = (item: Pick<AssetIndexItem, 'base'>) => item.base
export const instIdFromAssetId = (assetId: string) => `${assetId.toUpperCase()}-USDT-SWAP`

/** Position/trade size: compact when large, keeps precision for fractional fills. */
export function fmtSize(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '—'
  if (value >= 10_000) return fmtCompact(value)
  const digits = value >= 100 ? 1 : value >= 1 ? 2 : 4
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}
