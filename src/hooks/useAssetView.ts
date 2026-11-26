import { useEffect, useState } from 'octane'
import {
  okxChangePct,
  useOkxBook,
  useOkxCandles,
  useOkxFunding,
  useOkxIndexTicker,
  useOkxMarkPrice,
  useOkxOpenInterest,
  useOkxTicker,
  useOkxTrades
} from '@/hooks/useOkx'
import { useHlAssetCtx, useHlBook, useHlCandles, useHlPerps, useHlTrades } from '@/hooks/useHyperliquid'
import { fetchPerps, toIndexId, type OkxBar, type OkxPerpInstrument, type OkxTicker } from '@/lib/okx'
import { hlChangePct, hlTickSz, toHlCoin, type HlInterval } from '@/lib/hyperliquid'
import type { AssetCategory } from '@/components/app/assetFormat'

// ─── venue-agnostic asset page data ──────────────────────────────
// The asset page renders one shape; each venue fills it from its own
// feeds. Call both hooks and pass `null` to the inactive one — it then
// opens no subscriptions.

export type RangeKey = 'live' | '1h' | '1d' | '1w' | '1m'

export const RANGE_LABELS: { key: RangeKey; label: string }[] = [
  { key: 'live', label: 'Live' },
  { key: '1h', label: '1H' },
  { key: '1d', label: '1D' },
  { key: '1w', label: '1W' },
  { key: '1m', label: '1M' }
]

const OKX_RANGES: Record<RangeKey, { bar: OkxBar; limit: number }> = {
  live: { bar: '1s', limit: 300 },
  '1h': { bar: '1m', limit: 60 },
  '1d': { bar: '5m', limit: 288 },
  '1w': { bar: '1H', limit: 168 },
  '1m': { bar: '4H', limit: 180 }
}

// Hyperliquid has no 1s candles; "Live" is the last 3h of 1m bars.
const HL_RANGES: Record<RangeKey, { interval: HlInterval; limit: number }> = {
  live: { interval: '1m', limit: 180 },
  '1h': { interval: '1m', limit: 60 },
  '1d': { interval: '5m', limit: 288 },
  '1w': { interval: '1h', limit: 168 },
  '1m': { interval: '4h', limit: 180 }
}

export interface AssetMeta {
  base: string
  /** OKX instId or Hyperliquid coin ("BTC", "xyz:GBP"). */
  instId: string
  /** Hyperliquid builder dex ("xyz"), if any. */
  dex?: string
  category: AssetCategory
  tickSz?: number
  maxLeverage: number
  preMarket: boolean
  /** Multiplier from book/trade size to base units (OKX contracts). */
  ctVal: number
}

export interface AssetView {
  /** undefined while loading, null when the venue doesn't list it. */
  meta: AssetMeta | null | undefined
  last?: number
  change: number | null
  markPx?: number
  /** OKX index price / Hyperliquid oracle price. */
  indexPx?: number
  indexLabel: string
  fundingPct: number | null
  fundingHours: number
  nextFunding?: number
  oiUsd?: number
  volUsd?: number
  high24h?: number
  low24h?: number
  book: { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null
  trades: { id: string; price: number; size: number; side: 'buy' | 'sell'; ts: number }[]
  candles: { ts: number; close: number }[]
  candlesLoading: boolean
  /** OKX only — feeds the position simulator. */
  okxTicker: OkxTicker | null
}

export function useOkxAssetView(instId: string | null, range: RangeKey): AssetView {
  const [inst, setInst] = useState<OkxPerpInstrument | null | undefined>(undefined)
  useEffect(() => {
    if (!instId) return
    let alive = true
    setInst(undefined)
    fetchPerps()
      .then((all) => alive && setInst(all.find((p) => p.instId === instId) ?? null))
      .catch(() => alive && setInst(null))
    return () => {
      alive = false
    }
  }, [instId])

  const live = instId && inst ? instId : null
  const ticker = useOkxTicker(live, 250)
  const mark = useOkxMarkPrice(live)
  const index = useOkxIndexTicker(live ? toIndexId(live) : null)
  const funding = useOkxFunding(live)
  const oi = useOkxOpenInterest(live)
  const book = useOkxBook(live, 10, 150)
  const trades = useOkxTrades(live, 24)
  const r = OKX_RANGES[range]
  const chart = useOkxCandles(live, r.bar, { limit: r.limit, throttleMs: 400 })
  const ctVal = inst?.ctVal ?? 1

  return {
    meta: inst
      ? {
          base: inst.base,
          instId: inst.instId,
          category: inst.category,
          tickSz: inst.tickSz,
          maxLeverage: inst.maxLeverage || 1,
          preMarket: inst.ruleType === 'pre_market',
          ctVal
        }
      : inst,
    last: ticker?.last,
    change: okxChangePct(ticker, '24h'),
    markPx: mark?.markPx,
    indexPx: index?.idxPx,
    indexLabel: 'Index price',
    fundingPct: funding ? funding.fundingRate * 100 : null,
    fundingHours: 8,
    nextFunding: funding?.fundingTime,
    oiUsd: oi?.oiUsd,
    volUsd: ticker ? ticker.volCcy24h * ticker.last : undefined,
    high24h: ticker?.high24h,
    low24h: ticker?.low24h,
    book: book
      ? {
          bids: book.bids.map((l) => ({ price: l.price, size: l.size * ctVal })),
          asks: book.asks.map((l) => ({ price: l.price, size: l.size * ctVal }))
        }
      : null,
    trades: trades.map((t) => ({ id: t.tradeId, price: t.price, size: t.size * ctVal, side: t.side, ts: t.ts })),
    candles: chart.candles,
    candlesLoading: chart.loading || inst === undefined,
    okxTicker: ticker
  }
}

export function useHlAssetView(coin: string | null, range: RangeKey): AssetView {
  const { perps, error } = useHlPerps(coin !== null)
  const found = coin ? perps.find((p) => p.meta.name === coin) ?? perps.find((p) => p.meta.name === toHlCoin(coin)) : undefined
  const meta: AssetMeta | null | undefined = found
    ? {
        base: found.meta.base,
        instId: found.meta.name,
        dex: found.meta.dex || undefined,
        category: found.meta.category,
        tickSz: hlTickSz(found.meta.szDecimals, found.ctx.markPx),
        maxLeverage: found.meta.maxLeverage,
        preMarket: false,
        ctVal: 1
      }
    : perps.length || error
      ? null
      : undefined

  const live = meta?.instId ?? null
  const streamCtx = useHlAssetCtx(live, 250)
  const ctx = streamCtx?.coin === live ? streamCtx : found?.ctx
  const book = useHlBook(live, 150)
  const trades = useHlTrades(live, 24)
  const r = HL_RANGES[range]
  const chart = useHlCandles(live, r.interval, { limit: r.limit, throttleMs: 400 })
  // Hyperliquid's ctx has no 24h high/low; take it from the chart when it covers ~24h
  // (the 1D range is exactly 288 × 5m, so allow one hour of slack).
  const dayAgo = Date.now() - 86_400_000
  const day = chart.candles.filter((c) => c.ts >= dayAgo)
  const spansDay = chart.candles.length > 0 && chart.candles[0].ts <= dayAgo + 3_600_000

  return {
    meta,
    last: ctx ? (ctx.midPx ?? ctx.markPx) : undefined,
    change: hlChangePct(ctx),
    markPx: ctx?.markPx,
    indexPx: ctx?.oraclePx,
    indexLabel: 'Oracle price',
    fundingPct: ctx ? ctx.funding * 100 : null,
    fundingHours: 1,
    nextFunding: ctx?.nextFundingTime,
    oiUsd: ctx ? ctx.openInterest * ctx.markPx : undefined,
    volUsd: ctx?.dayNtlVlm,
    high24h: spansDay ? Math.max(...day.map((c) => c.high)) : undefined,
    low24h: spansDay ? Math.min(...day.map((c) => c.low)) : undefined,
    book: book?.coin === live ? book : null,
    trades: trades.map((t) => ({ id: String(t.tid), price: t.price, size: t.size, side: t.side, ts: t.ts })),
    candles: chart.candles,
    candlesLoading: chart.loading || meta === undefined,
    okxTicker: null
  }
}
