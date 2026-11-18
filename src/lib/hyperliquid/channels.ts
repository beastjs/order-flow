// ============================================================
// Hyperliquid typed channel helpers — parse wire strings into
// numbers and hand consumers normalized objects. Every helper
// returns an unsubscribe function.
// ============================================================

import type { HlStream } from './client'
import type {
  HlAssetCtx,
  HlBbo,
  HlBook,
  HlBookLevel,
  HlCandle,
  HlInterval,
  HlTrade,
  HlWireAssetCtx,
  HlWireBook,
  HlWireCandle,
  HlWireLevel,
  HlWireTrade
} from './types'

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(x) ? x : NaN
}
const opt = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : n(v))

const HOUR = 3_600_000

// ─── parsers (exported for tests / REST reuse) ──────────────

export const parseLevel = (l: HlWireLevel): HlBookLevel => ({ price: n(l.px), size: n(l.sz), orders: l.n })

export function parseBook(d: HlWireBook): HlBook {
  return { coin: d.coin, bids: d.levels[0].map(parseLevel), asks: d.levels[1].map(parseLevel), ts: d.time }
}

export function parseTrade(d: HlWireTrade): HlTrade {
  return {
    coin: d.coin,
    tid: d.tid,
    price: n(d.px),
    size: n(d.sz),
    side: d.side === 'B' ? 'buy' : 'sell',
    ts: d.time,
    hash: d.hash,
    users: d.users
  }
}

export function parseCandle(d: HlWireCandle): HlCandle {
  return {
    ts: d.t,
    closeTs: d.T,
    coin: d.s,
    interval: d.i,
    open: n(d.o),
    high: n(d.h),
    low: n(d.l),
    close: n(d.c),
    vol: n(d.v),
    trades: d.n
  }
}

export function parseAssetCtx(coin: string, c: HlWireAssetCtx, now = Date.now()): HlAssetCtx {
  return {
    coin,
    markPx: n(c.markPx),
    midPx: opt(c.midPx),
    oraclePx: n(c.oraclePx),
    prevDayPx: n(c.prevDayPx),
    funding: n(c.funding),
    premium: opt(c.premium),
    openInterest: n(c.openInterest),
    dayNtlVlm: n(c.dayNtlVlm),
    dayBaseVlm: n(c.dayBaseVlm),
    impactPxs: c.impactPxs ? [n(c.impactPxs[0]), n(c.impactPxs[1])] : null,
    nextFundingTime: Math.floor(now / HOUR) * HOUR + HOUR,
    ts: now
  }
}

/** % change vs the previous day's price. */
export function hlChangePct(ctx: HlAssetCtx | null | undefined): number | null {
  if (!ctx || !(ctx.prevDayPx > 0)) return null
  const px = ctx.midPx ?? ctx.markPx
  return ((px - ctx.prevDayPx) / ctx.prevDayPx) * 100
}

// ─── typed subscriptions ────────────────────────────────────

export function hlChannels(stream: HlStream) {
  return {
    /** Mid price of every perp (and spot pair), keyed by coin. Pass `dex` ("xyz") for a builder dex. */
    allMids: (cb: (mids: Record<string, number>) => void, dex?: string) =>
      stream.subscribe<{ mids: Record<string, string> }>(dex ? { type: 'allMids', dex } : { type: 'allMids' }, (d) => {
        const mids: Record<string, number> = {}
        for (const coin in d.mids) mids[coin] = n(d.mids[coin])
        cb(mids)
      }),

    /** Top 20 levels per side, full snapshot every push (~0.5s). Stateless. */
    book: (coin: string, cb: (b: HlBook) => void) =>
      stream.subscribe<HlWireBook>({ type: 'l2Book', coin }, (d) => cb(parseBook(d))),

    /** Best bid/offer, pushed on change. */
    bbo: (coin: string, cb: (b: HlBbo) => void) =>
      stream.subscribe<{ coin: string; time: number; bbo: [HlWireLevel | null, HlWireLevel | null] }>(
        { type: 'bbo', coin },
        (d) =>
          cb({
            coin: d.coin,
            bid: d.bbo[0] ? parseLevel(d.bbo[0]) : null,
            ask: d.bbo[1] ? parseLevel(d.bbo[1]) : null,
            ts: d.time
          })
      ),

    /** Individual fills. The first push after subscribing is a batch of recent trades. */
    trades: (coin: string, cb: (t: HlTrade) => void) =>
      stream.subscribe<HlWireTrade[]>({ type: 'trades', coin }, (d) => {
        for (const t of d) cb(parseTrade(t))
      }),

    /** Current (forming) candle, pushed on every update. */
    candles: (coin: string, interval: HlInterval, cb: (c: HlCandle) => void) =>
      stream.subscribe<HlWireCandle>({ type: 'candle', coin, interval }, (d) => cb(parseCandle(d))),

    /** Mark / oracle / mid, funding, OI and 24h volume. */
    assetCtx: (coin: string, cb: (c: HlAssetCtx) => void) =>
      stream.subscribe<{ coin: string; ctx: HlWireAssetCtx }>({ type: 'activeAssetCtx', coin }, (d) => {
        if (d?.ctx) cb(parseAssetCtx(d.coin, d.ctx))
      })
  }
}

export type HlChannels = ReturnType<typeof hlChannels>
