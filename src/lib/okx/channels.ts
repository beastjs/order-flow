// ============================================================
// OKX typed channel helpers — parse wire strings into numbers and
// hand consumers normalized objects. Every helper returns an
// unsubscribe function.
// ============================================================

import { OkxStream, type PushHandler } from './client'
import type {
  OkxBar,
  OkxBook,
  OkxBookLevel,
  OkxCandle,
  OkxFundingRate,
  OkxIndexTicker,
  OkxInstType,
  OkxLiquidation,
  OkxMarkPrice,
  OkxOpenInterest,
  OkxPriceLimit,
  OkxPush,
  OkxTicker,
  OkxTrade
} from './types'

type Raw = Record<string, string | undefined>

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(x) ? x : NaN
}
const opt = (v: unknown): number | undefined => (v === undefined || v === '' ? undefined : n(v))

// ─── parsers (exported for tests / REST reuse) ──────────────

export function parseTicker(d: Raw): OkxTicker {
  return {
    instId: d.instId!,
    last: n(d.last),
    lastSz: n(d.lastSz),
    bidPx: n(d.bidPx),
    bidSz: n(d.bidSz),
    askPx: n(d.askPx),
    askSz: n(d.askSz),
    open24h: n(d.open24h),
    high24h: n(d.high24h),
    low24h: n(d.low24h),
    sodUtc0: n(d.sodUtc0),
    sodUtc8: n(d.sodUtc8),
    vol24h: n(d.vol24h),
    volCcy24h: n(d.volCcy24h),
    ts: n(d.ts)
  }
}

export function parseTrade(d: Raw): OkxTrade {
  return {
    instId: d.instId!,
    tradeId: d.tradeId!,
    price: n(d.px),
    size: n(d.sz),
    side: d.side === 'sell' ? 'sell' : 'buy',
    ts: n(d.ts),
    count: opt(d.count)
  }
}

/** Trade candles: [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]; mark/index: [ts,o,h,l,c,confirm]. */
export function parseCandle(row: string[]): OkxCandle {
  const priceOnly = row.length <= 6
  return {
    ts: n(row[0]),
    open: n(row[1]),
    high: n(row[2]),
    low: n(row[3]),
    close: n(row[4]),
    vol: priceOnly ? 0 : n(row[5]),
    volCcy: priceOnly ? 0 : n(row[6]),
    volQuote: priceOnly ? 0 : n(row[7]),
    confirmed: (priceOnly ? row[5] : row[8]) === '1'
  }
}

const level = (l: string[]): OkxBookLevel => ({ price: n(l[0]), size: n(l[1]), orders: n(l[3]) })

// ─── local order book (books channel: snapshot + deltas) ───

export class OkxLocalBook {
  private bids = new Map<number, OkxBookLevel>()
  private asks = new Map<number, OkxBookLevel>()
  ts = 0
  seqId?: number

  constructor(readonly instId: string) {}

  apply(push: OkxPush<{ bids: string[][]; asks: string[][]; ts: string; seqId?: number }>): void {
    if (push.action !== 'update') {
      this.bids.clear()
      this.asks.clear()
    }
    for (const d of push.data) {
      for (const l of d.bids) this.set(this.bids, level(l))
      for (const l of d.asks) this.set(this.asks, level(l))
      this.ts = n(d.ts)
      this.seqId = d.seqId
    }
  }

  snapshot(depth = 50): OkxBook {
    const bids = [...this.bids.values()].sort((a, b) => b.price - a.price).slice(0, depth)
    const asks = [...this.asks.values()].sort((a, b) => a.price - b.price).slice(0, depth)
    return { instId: this.instId, bids, asks, ts: this.ts, seqId: this.seqId }
  }

  private set(side: Map<number, OkxBookLevel>, l: OkxBookLevel): void {
    if (!(l.size > 0)) side.delete(l.price)
    else side.set(l.price, l)
  }
}

// ─── typed subscriptions ────────────────────────────────────

const each =
  <T>(parse: (d: any) => T, cb: (v: T) => void): PushHandler<any> =>
  (push) => {
    for (const d of push.data) cb(parse(d))
  }

export function okxChannels(stream: OkxStream) {
  return {
    // ── public endpoint ──
    ticker: (instId: string, cb: (t: OkxTicker) => void) =>
      stream.subscribe({ channel: 'tickers', instId }, each(parseTicker, cb)),

    /** Aggregated prints (one message may cover several fills — see `count`). */
    trades: (instId: string, cb: (t: OkxTrade) => void) =>
      stream.subscribe({ channel: 'trades', instId }, each(parseTrade, cb)),

    /** Top-5 levels, full snapshot every push (~100ms). Stateless. */
    books5: (instId: string, cb: (b: OkxBook) => void) =>
      stream.subscribe<{ bids: string[][]; asks: string[][]; ts: string }>({ channel: 'books5', instId }, (push) => {
        for (const d of push.data) cb({ instId, bids: d.bids.map(level), asks: d.asks.map(level), ts: n(d.ts) })
      }),

    /** Full 400-level book, maintained locally from snapshot + deltas. */
    book: (instId: string, cb: (b: OkxBook) => void, depth = 50) => {
      const local = new OkxLocalBook(instId)
      return stream.subscribe<{ bids: string[][]; asks: string[][]; ts: string }>({ channel: 'books', instId }, (push) => {
        local.apply(push)
        cb(local.snapshot(depth))
      })
    },

    fundingRate: (instId: string, cb: (f: OkxFundingRate) => void) =>
      stream.subscribe(
        { channel: 'funding-rate', instId },
        each(
          (d: Raw): OkxFundingRate => ({
            instId: d.instId!,
            fundingRate: n(d.fundingRate),
            fundingTime: n(d.fundingTime),
            nextFundingTime: n(d.nextFundingTime),
            nextFundingRate: opt(d.nextFundingRate),
            minFundingRate: opt(d.minFundingRate),
            maxFundingRate: opt(d.maxFundingRate),
            ts: n(d.ts)
          }),
          cb
        )
      ),

    markPrice: (instId: string, cb: (m: OkxMarkPrice) => void) =>
      stream.subscribe(
        { channel: 'mark-price', instId },
        each((d: Raw): OkxMarkPrice => ({ instId: d.instId!, markPx: n(d.markPx), ts: n(d.ts) }), cb)
      ),

    openInterest: (instId: string, cb: (o: OkxOpenInterest) => void) =>
      stream.subscribe(
        { channel: 'open-interest', instId },
        each(
          (d: Raw): OkxOpenInterest => ({
            instId: d.instId!,
            oi: n(d.oi),
            oiCcy: n(d.oiCcy),
            oiUsd: n(d.oiUsd),
            ts: n(d.ts)
          }),
          cb
        )
      ),

    /** Index instId is the family, e.g. "AAPL-USDT" / "BTC-USDT" (no -SWAP). */
    indexTicker: (indexId: string, cb: (t: OkxIndexTicker) => void) =>
      stream.subscribe(
        { channel: 'index-tickers', instId: indexId },
        each(
          (d: Raw): OkxIndexTicker => ({
            instId: d.instId!,
            idxPx: n(d.idxPx),
            open24h: n(d.open24h),
            high24h: n(d.high24h),
            low24h: n(d.low24h),
            sodUtc0: n(d.sodUtc0),
            sodUtc8: n(d.sodUtc8),
            ts: n(d.ts)
          }),
          cb
        )
      ),

    priceLimit: (instId: string, cb: (p: OkxPriceLimit) => void) =>
      stream.subscribe(
        { channel: 'price-limit', instId },
        each(
          (d: any): OkxPriceLimit => ({
            instId: d.instId,
            buyLmt: n(d.buyLmt),
            sellLmt: n(d.sellLmt),
            enabled: d.enabled !== false,
            ts: n(d.ts)
          }),
          cb
        )
      ),

    /** Published per instrument type only; filter by instId client-side. */
    liquidations: (cb: (l: OkxLiquidation) => void, instType: OkxInstType = 'SWAP') =>
      stream.subscribe<{ instId: string; instFamily: string; details: Raw[] }>(
        { channel: 'liquidation-orders', instType },
        (push) => {
          for (const item of push.data) {
            for (const d of item.details ?? []) {
              cb({
                instId: item.instId,
                instFamily: item.instFamily,
                side: d.side === 'buy' ? 'buy' : 'sell',
                posSide: (d.posSide as OkxLiquidation['posSide']) || 'net',
                bkPx: n(d.bkPx),
                size: n(d.sz),
                ts: n(d.ts)
              })
            }
          }
        }
      ),

    // ── business endpoint ──

    /** Every individual fill (unaggregated). */
    tradesAll: (instId: string, cb: (t: OkxTrade) => void) =>
      stream.subscribe({ channel: 'trades-all', instId }, each(parseTrade, cb)),

    candles: (instId: string, bar: OkxBar, cb: (c: OkxCandle) => void) =>
      stream.subscribe<string[]>({ channel: `candle${bar}`, instId }, each(parseCandle, cb)),

    markPriceCandles: (instId: string, bar: OkxBar, cb: (c: OkxCandle) => void) =>
      stream.subscribe<string[]>({ channel: `mark-price-candle${bar}`, instId }, each(parseCandle, cb)),

    /** Index instId is the family, e.g. "AAPL-USDT". */
    indexCandles: (indexId: string, bar: OkxBar, cb: (c: OkxCandle) => void) =>
      stream.subscribe<string[]>({ channel: `index-candle${bar}`, instId: indexId }, each(parseCandle, cb))
  }
}

export type OkxChannels = ReturnType<typeof okxChannels>
