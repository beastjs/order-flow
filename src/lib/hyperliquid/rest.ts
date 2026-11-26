// ============================================================
// Hyperliquid REST (`POST /info`) — perp catalog, candle history
// to seed live charts, and a one-shot snapshot of asset contexts.
// ============================================================

import { parseAssetCtx, parseCandle } from './channels'
import type { HlAssetCtx, HlCandle, HlCategory, HlInterval, HlPerpMeta, HlWireAssetCtx, HlWireCandle } from './types'

export const HL_REST = 'https://api.hyperliquid.xyz'

const INTERVAL_MS: Record<HlInterval, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000
}

export async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HL_REST}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`Hyperliquid info ${String(body.type)} → HTTP ${res.status}`)
  return (await res.json()) as T
}

/** Candle history, oldest first. Hyperliquid serves at most the last 5000 candles. */
export async function fetchHlCandles(
  coin: string,
  interval: HlInterval,
  { limit = 300, endTime = Date.now() }: { limit?: number; endTime?: number } = {}
): Promise<HlCandle[]> {
  const startTime = endTime - INTERVAL_MS[interval] * limit
  const rows = await hlInfo<HlWireCandle[]>({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } })
  return rows.map(parseCandle).slice(-limit)
}

type WireMetaAndCtxs = [
  { universe: WirePerp[] },
  HlWireAssetCtx[]
]

type WirePerp = { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }

export async function fetchHlBookQuote(coin: string) {
  const book = await hlInfo<{ coin: string; levels: [{ px: string }[], { px: string }[]] } | null>({ type: 'l2Book', coin })
  if (book?.coin !== coin) return { bid: 0, ask: 0 }
  const bid = Number(book?.levels?.[0]?.[0]?.px)
  const ask = Number(book?.levels?.[1]?.[0]?.px)
  return { bid: Number.isFinite(bid) && bid > 0 ? bid : 0, ask: Number.isFinite(ask) && ask > 0 ? ask : 0 }
}

export async function fetchHlPaperMarket(coin: string) {
  const { dex, base } = splitHlCoin(coin)
  const [meta, categories] = await Promise.all([
    hlInfo<{ universe: WirePerp[] }>({ type: 'meta', dex }),
    dex ? hlInfo<[string, string][]>({ type: 'perpCategories' }).catch(() => []) : []
  ])
  const asset = meta.universe.find((item) => item.name === coin)
  if (!asset || asset.isDelisted || !Number.isSafeInteger(asset.maxLeverage) || asset.maxLeverage < 1) {
    throw new Error(`${coin} is not tradable.`)
  }
  return { base, category: hlCategory(new Map(categories).get(coin), dex), maxLeverage: asset.maxLeverage }
}

export async function fetchHlMarks(coins: readonly string[]): Promise<Map<string, number>> {
  const dexes = [...new Set(coins.map((coin) => splitHlCoin(coin).dex))]
  const markets = await Promise.allSettled(dexes.map((dex) => hlInfo<WireMetaAndCtxs>({ type: 'metaAndAssetCtxs', dex })))
  const marks = new Map<string, number>()
  for (const market of markets) {
    if (market.status !== 'fulfilled' || !Array.isArray(market.value)) continue
    const [meta, contexts] = market.value
    if (!Array.isArray(meta?.universe) || !Array.isArray(contexts) || meta.universe.length !== contexts.length) continue
    meta.universe.forEach(({ name }, index) => {
      const mark = Number(contexts[index]?.markPx)
      if (Number.isFinite(mark) && mark > 0) marks.set(name, mark)
    })
  }
  return marks
}

/** Map Hyperliquid's `perpCategories` labels onto ours. Unlabelled main-dex coins are crypto. */
export function hlCategory(label: string | undefined, dex: string): HlCategory {
  switch (label?.toLowerCase()) {
    case 'crypto':
      return 'crypto'
    case 'stocks':
    case 'stock':
    case 'preipo':
      return 'stock'
    case 'commodities':
      return 'commodity'
    case 'fx':
      return 'fx'
    case 'indices':
      return 'index'
    default:
      return dex ? 'other' : 'crypto'
  }
}

/** Split "xyz:GBP" → { dex: "xyz", base: "GBP" }; main-dex coins have dex "". */
export function splitHlCoin(coin: string): { dex: string; base: string } {
  const i = coin.indexOf(':')
  return i < 0 ? { dex: '', base: coin } : { dex: coin.slice(0, i), base: coin.slice(i + 1) }
}

/**
 * Every listed perp with its live context: the main dex plus every
 * builder-deployed (HIP-3) dex — "xyz:GBP", "xyz:AAPL", "flx:GOLD"…
 * A builder dex that fails to load is skipped; the main dex must load.
 */
export async function fetchHlPerps(): Promise<{ meta: HlPerpMeta; ctx: HlAssetCtx }[]> {
  const [dexes, categories] = await Promise.all([
    hlInfo<({ name: string } | null)[]>({ type: 'perpDexs' }).catch(() => [null]),
    hlInfo<[string, string][]>({ type: 'perpCategories' }).catch(() => [] as [string, string][])
  ])
  const labels = new Map(categories)
  const names = ['', ...dexes.flatMap((d) => (d?.name ? [d.name] : []))]
  const results = await Promise.allSettled(
    names.map((dex) => hlInfo<WireMetaAndCtxs>(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }))
  )
  if (results[0].status === 'rejected') throw results[0].reason
  const now = Date.now()
  return results.flatMap((r, d) => {
    if (r.status !== 'fulfilled') return []
    const dex = names[d]
    try {
      return parseDex(r.value, dex, labels, now)
    } catch (error) {
      // A malformed builder dex is dropped; a malformed main dex is fatal.
      if (!dex) throw error
      console.warn(`[hyperliquid] skipped malformed dex "${dex}"`, error)
      return []
    }
  })
}

function parseDex(value: WireMetaAndCtxs, dex: string, labels: Map<string, string>, now: number) {
  const [meta, ctxs] = value
  if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs) || ctxs.length !== meta.universe.length) {
    throw new Error(`metaAndAssetCtxs for "${dex || 'main'}": ${meta?.universe?.length ?? '?'} assets vs ${ctxs?.length ?? '?'} contexts`)
  }
  return meta.universe.map((u, i) => ({
    meta: {
      name: u.name,
      base: splitHlCoin(u.name).base,
      dex,
      category: hlCategory(labels.get(u.name), dex),
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage,
      isDelisted: !!u.isDelisted
    },
    ctx: parseAssetCtx(u.name, ctxs[i], now)
  }))
}

/** Normalize "BTCUSDT" / "BTC-USDT-SWAP" / "btc" → "BTC"; keeps "xyz:GBP" and "kPEPE" intact. */
export function toHlCoin(symbol: string): string {
  const { dex, base } = splitHlCoin(symbol)
  const s = base.toUpperCase().replace(/-USDT-SWAP$|-USDT$|-USDC$|USDT$|USDC$|-PERP$/, '')
  // Hyperliquid's 1000x coins (kPEPE, kBONK…) keep a lowercase k — pass them through as given.
  const coin = /^k[A-Z]/.test(base) ? `k${s.slice(1)}` : s
  return dex ? `${dex.toLowerCase()}:${coin}` : coin
}

/**
 * Price increment for display. Hyperliquid prices carry at most 5
 * significant figures and at most (6 − szDecimals) decimals.
 */
export function hlTickSz(szDecimals: number, refPx?: number): number {
  let decimals = Math.max(0, 6 - szDecimals)
  if (refPx && refPx > 0) decimals = Math.min(decimals, Math.max(0, 4 - Math.floor(Math.log10(refPx))))
  return 10 ** -decimals
}

// ─── rate-limited sparkline queue ─────────────────────────────
// /info allows 1200 weight / min per IP and a candleSnapshot costs ~20,
// so grids burst up to BURST requests, then refill one per second.

const BURST = 30
let tokens = BURST
let refill: ReturnType<typeof setInterval> | null = null
const queue: Array<() => void> = []

function drain() {
  while (tokens > 0 && queue.length) {
    tokens--
    queue.shift()!()
  }
}

function schedule<T>(task: () => Promise<T>): Promise<T> {
  refill ??= setInterval(() => {
    tokens = Math.min(BURST, tokens + 1)
    drain()
    if (!queue.length && tokens === BURST && refill) {
      clearInterval(refill)
      refill = null
    }
  }, 1000)
  return new Promise<T>((resolve, reject) => {
    queue.push(() => task().then(resolve, reject))
    drain()
  })
}

const sparkCache = new Map<string, Promise<number[]>>()

/** Close prices for a compact sparkline (default: last 24 hourly bars). Cached per session. */
export function fetchHlSparkline(coin: string, interval: HlInterval = '1h', points = 24): Promise<number[]> {
  const key = `${coin}|${interval}|${points}`
  let p = sparkCache.get(key)
  if (!p) {
    p = schedule(() => fetchHlCandles(coin, interval, { limit: points })).then((c) => c.map((x) => x.close))
    p.catch(() => sparkCache.delete(key))
    sparkCache.set(key, p)
  }
  return p
}
