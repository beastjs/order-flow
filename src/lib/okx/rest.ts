// ============================================================
// OKX REST helpers — instrument catalog (crypto vs stock perps)
// and candle history to seed live charts.
// ============================================================

import { parseCandle, parseTicker } from './channels'
import type { OkxBar, OkxCandle, OkxInstType, OkxTicker } from './types'

const REST = 'https://www.okx.com'

/** OKX `instCategory`: 1 crypto, 3 stocks, 4 commodities. */
export type OkxPerpCategory = 'crypto' | 'stock' | 'commodity' | 'other'

export interface OkxPerpInstrument {
  instId: string // "AAPL-USDT-SWAP"
  /** Underlying family / index id: "AAPL-USDT". */
  family: string
  /** Base symbol: "AAPL", "BTC". */
  base: string
  settleCcy: string
  category: OkxPerpCategory
  /** Base units per contract (stock perps: 1 share). */
  ctVal: number
  tickSz: number
  lotSz: number
  maxLeverage: number
  /** "pre_market" for pre-IPO perps (e.g. OPENAI-USDT-SWAP). */
  ruleType: string
  state: string
  listTime: number
}

const CATEGORY: Record<string, OkxPerpCategory> = { '1': 'crypto', '3': 'stock', '4': 'commodity' }

async function get<T>(path: string): Promise<T[]> {
  const res = await fetch(`${REST}${path}`)
  if (!res.ok) throw new Error(`OKX ${path} → HTTP ${res.status}`)
  const body = (await res.json()) as { code: string; msg: string; data: T[] }
  if (body.code !== '0') throw new Error(`OKX ${path} → ${body.code} ${body.msg}`)
  return body.data
}

let perpsPromise: Promise<OkxPerpInstrument[]> | null = null

/** All live SWAP instruments, fetched once per session. */
export function fetchPerps(): Promise<OkxPerpInstrument[]> {
  perpsPromise ??= get<Record<string, string>>('/api/v5/public/instruments?instType=SWAP')
    .then((rows) =>
      rows.map((r) => ({
        instId: r.instId,
        family: r.instFamily || r.uly,
        base: r.ctValCcy || r.instFamily.split('-')[0],
        settleCcy: r.settleCcy,
        category: CATEGORY[r.instCategory] ?? 'other',
        ctVal: Number(r.ctVal) || 1,
        tickSz: Number(r.tickSz),
        lotSz: Number(r.lotSz),
        maxLeverage: Number(r.lever),
        ruleType: r.ruleType,
        state: r.state,
        listTime: Number(r.listTime)
      }))
    )
    .catch((error) => {
      perpsPromise = null // allow a retry
      throw error
    })
  return perpsPromise
}

/** USDT-margined perps of one category (stock perps are all USDT-margined). */
export async function fetchPerpsByCategory(category: OkxPerpCategory): Promise<OkxPerpInstrument[]> {
  const all = await fetchPerps()
  return all.filter((i) => i.category === category && i.settleCcy === 'USDT' && i.state === 'live')
}

export async function findPerp(instId: string): Promise<OkxPerpInstrument | undefined> {
  return (await fetchPerps()).find((i) => i.instId === instId)
}

/** "AAPL" / "AAPLUSDT" / "AAPL-USDT" → "AAPL-USDT-SWAP". */
export function toPerpInstId(symbol: string): string {
  const s = symbol.toUpperCase()
  if (s.endsWith('-SWAP')) return s
  if (s.includes('-')) return `${s}-SWAP`
  return `${s.replace(/USDT$|USD$/, '')}-USDT-SWAP`
}

/** "AAPL-USDT-SWAP" → "AAPL-USDT" (index / family id). */
export function toIndexId(instId: string): string {
  return instId.replace(/-SWAP$/, '')
}

export type CandleSource = 'trade' | 'mark' | 'index'

/**
 * Recent candles, oldest first (max 300 per OKX request).
 * `index` source expects the family id ("AAPL-USDT").
 */
export async function fetchCandles(
  instId: string,
  bar: OkxBar,
  { limit = 300, source = 'trade' }: { limit?: number; source?: CandleSource } = {}
): Promise<OkxCandle[]> {
  const path =
    source === 'mark' ? 'mark-price-candles' : source === 'index' ? 'index-candles' : 'candles'
  const rows = await get<string[]>(
    `/api/v5/market/${path}?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${Math.min(limit, 300)}`
  )
  return rows.map(parseCandle).reverse()
}

/** One-shot snapshot of every ticker of an instrument type, keyed by instId. */
export async function fetchTickers(instType: OkxInstType = 'SWAP'): Promise<Record<string, OkxTicker>> {
  const rows = await get<Record<string, string>>(`/api/v5/market/tickers?instType=${instType}`)
  const out: Record<string, OkxTicker> = {}
  for (const row of rows) out[row.instId] = parseTicker(row)
  return out
}

export async function fetchTicker(instId: string): Promise<OkxTicker> {
  const [ticker] = await get<Record<string, string>>(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`)
  if (!ticker) throw new Error(`No quote for ${instId}.`)
  return parseTicker(ticker)
}

// ─── rate-limited candle queue ────────────────────────────────
// OKX allows 40 candle requests / 2s per IP. Grids of hundreds of cards
// go through this queue so scrolling never trips the limit.

const QUEUE_PER_SECOND = 12
const queue: Array<() => void> = []
let tokens = QUEUE_PER_SECOND
let refill: ReturnType<typeof setInterval> | null = null

function drain() {
  while (tokens > 0 && queue.length) {
    tokens--
    queue.shift()!()
  }
  if (queue.length === 0 && refill && tokens === QUEUE_PER_SECOND) {
    clearInterval(refill)
    refill = null
  }
}

function schedule<T>(task: () => Promise<T>): Promise<T> {
  refill ??= setInterval(() => {
    tokens = QUEUE_PER_SECOND
    drain()
  }, 1000)
  return new Promise<T>((resolve, reject) => {
    queue.push(() => task().then(resolve, reject))
    drain()
  })
}

const sparkCache = new Map<string, Promise<number[]>>()

/** Close prices for a compact sparkline (default: last 24 hourly bars). Cached per session. */
export function fetchSparkline(instId: string, bar: OkxBar = '1H', points = 24): Promise<number[]> {
  const key = `${instId}|${bar}|${points}`
  let p = sparkCache.get(key)
  if (!p) {
    p = schedule(() => fetchCandles(instId, bar, { limit: points })).then((c) => c.map((x) => x.close))
    p.catch(() => sparkCache.delete(key))
    sparkCache.set(key, p)
  }
  return p
}
