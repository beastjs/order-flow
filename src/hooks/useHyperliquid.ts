import { useEffect, useState } from 'octane'
import {
  fetchHlCandles,
  fetchHlPerps,
  fetchHlSparkline,
  hl,
  hlStream,
  type HlAssetCtx,
  type HlBbo,
  type HlBook,
  type HlCandle,
  type HlInterval,
  type HlPerpMeta,
  type HlSocketStatus,
  type HlTrade
} from '@/lib/hyperliquid'

// ─── Hyperliquid live-data hooks ─────────────────────────────────
// All hooks share the app-wide Hyperliquid socket; mounting the same
// feed in ten components costs one subscription. Updates are coalesced
// to at most one render per `throttleMs`. Coins are Hyperliquid names
// ("BTC", "ETH", "kPEPE") — use `toHlCoin` to convert other symbols.

function throttled<T>(set: (v: T) => void, ms: number) {
  let pending: { v: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const push = (v: T) => {
    pending = { v }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (pending) set(pending.v)
      pending = null
    }, ms)
  }
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
  }
  return { push, cancel }
}

/** Latest value from any single-value channel helper. */
function useHlLatest<T>(
  subscribe: (coin: string, cb: (v: T) => void) => () => void,
  coin: string | null | undefined,
  throttleMs: number
): T | null {
  const [value, setValue] = useState<T | null>(null)
  useEffect(() => {
    setValue(null)
    if (!coin) return
    const t = throttled(setValue, throttleMs)
    const off = subscribe(coin, t.push)
    return () => {
      off()
      t.cancel()
    }
  }, [coin, throttleMs])
  return value
}

/** Mark / oracle / mid, funding, OI, 24h volume for one coin. */
export const useHlAssetCtx = (coin: string | null | undefined, throttleMs = 500) =>
  useHlLatest<HlAssetCtx>(hl.assetCtx, coin, throttleMs)

/** Top-20 L2 book (sizes in coins). */
export const useHlBook = (coin: string | null | undefined, throttleMs = 100) =>
  useHlLatest<HlBook>(hl.book, coin, throttleMs)

/** Best bid / offer. */
export const useHlBbo = (coin: string | null | undefined, throttleMs = 100) =>
  useHlLatest<HlBbo>(hl.bbo, coin, throttleMs)

/** Live mid prices for all coins of a dex (main dex by default). */
export function useHlMids(dex?: string, throttleMs = 500): Record<string, number> {
  const [mids, setMids] = useState<Record<string, number>>({})
  useEffect(() => {
    const t = throttled(setMids, throttleMs)
    const off = hl.allMids(t.push, dex)
    return () => {
      off()
      t.cancel()
    }
  }, [dex, throttleMs])
  return mids
}

/** Asset contexts for many coins, keyed by coin. */
export function useHlAssetCtxs(coins: readonly string[], throttleMs = 500): Record<string, HlAssetCtx> {
  const [ctxs, setCtxs] = useState<Record<string, HlAssetCtx>>({})
  const key = coins.join(',')
  useEffect(() => {
    const latest: Record<string, HlAssetCtx> = {}
    const t = throttled(setCtxs, throttleMs)
    const offs = coins.map((coin) =>
      hl.assetCtx(coin, (c) => {
        latest[coin] = c
        t.push({ ...latest })
      })
    )
    return () => {
      offs.forEach((off) => off())
      t.cancel()
    }
  }, [key, throttleMs])
  return ctxs
}

/** Most recent fills, newest first. */
export function useHlTrades(coin: string | null | undefined, max = 40, throttleMs = 200): HlTrade[] {
  const [trades, setTrades] = useState<HlTrade[]>([])
  useEffect(() => {
    setTrades([])
    if (!coin) return
    let buf: HlTrade[] = []
    const t = throttled(setTrades, throttleMs)
    const off = hl.trades(coin, (trade) => {
      buf = [trade, ...buf].slice(0, max)
      t.push(buf)
    })
    return () => {
      off()
      t.cancel()
    }
  }, [coin, max, throttleMs])
  return trades
}

export interface HlCandlesState {
  candles: HlCandle[]
  loading: boolean
  error: string | null
}

/** Candle history (REST `candleSnapshot`) merged with the live `candle` stream. */
export function useHlCandles(
  coin: string | null | undefined,
  interval: HlInterval,
  { limit = 300, throttleMs = 250 }: { limit?: number; throttleMs?: number } = {}
): HlCandlesState {
  const [state, setState] = useState<HlCandlesState>({ candles: [], loading: true, error: null })
  useEffect(() => {
    if (!coin) {
      setState({ candles: [], loading: false, error: null })
      return
    }
    setState({ candles: [], loading: true, error: null })
    let alive = true
    let series: HlCandle[] = []
    let seeded = false
    const early: HlCandle[] = [] // live bars that arrive before history
    const t = throttled((c: HlCandle[]) => alive && setState({ candles: c, loading: false, error: null }), throttleMs)

    const merge = (c: HlCandle) => {
      const last = series[series.length - 1]
      if (last && last.ts === c.ts) series = [...series.slice(0, -1), c]
      else if (!last || c.ts > last.ts) series = [...series, c].slice(-limit)
      else return
      t.push(series)
    }

    const off = hl.candles(coin, interval, (c) => (seeded ? merge(c) : early.push(c)))

    fetchHlCandles(coin, interval, { limit })
      .then((history) => {
        if (!alive) return
        series = history
        seeded = true
        early.forEach(merge)
        setState({ candles: series, loading: false, error: null })
      })
      .catch((error) => {
        if (!alive) return
        seeded = true
        early.forEach(merge)
        setState({ candles: series, loading: false, error: error instanceof Error ? error.message : String(error) })
      })

    return () => {
      alive = false
      off()
      t.cancel()
    }
  }, [coin, interval, limit, throttleMs])
  return state
}

/** Listed (non-delisted) perps with a one-shot context snapshot, shared across callers. */
let perpsPromise: Promise<{ meta: HlPerpMeta; ctx: HlAssetCtx }[]> | null = null
export function useHlPerps(enabled = true): { perps: { meta: HlPerpMeta; ctx: HlAssetCtx }[]; error: string | null } {
  const [state, setState] = useState<{ perps: { meta: HlPerpMeta; ctx: HlAssetCtx }[]; error: string | null }>({
    perps: [],
    error: null
  })
  useEffect(() => {
    if (!enabled) return
    let alive = true
    perpsPromise ??= fetchHlPerps().catch((e) => {
      perpsPromise = null
      throw e
    })
    perpsPromise
      .then((all) => alive && setState({ perps: all.filter((p) => !p.meta.isDelisted), error: null }))
      .catch((e) => alive && setState({ perps: [], error: e instanceof Error ? e.message : String(e) }))
    return () => {
      alive = false
    }
  }, [enabled])
  return state
}

/** Connection status of the shared Hyperliquid socket. */
export function useHlStatus(): HlSocketStatus {
  const [status, setStatus] = useState<HlSocketStatus>(hlStream.getStatus())
  useEffect(() => hlStream.onStatus(setStatus), [])
  return status
}

/** Hourly close prices for a sparkline, fetched through the rate-limited queue once `enabled`. */
export function useHlSparkline(coin: string, enabled = true, interval: HlInterval = '1h', points = 24): number[] {
  const [closes, setCloses] = useState<number[]>([])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    fetchHlSparkline(coin, interval, points)
      .then((c) => alive && setCloses(c))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [coin, enabled, interval, points])
  return closes
}
