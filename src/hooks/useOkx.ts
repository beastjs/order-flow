import { useEffect, useState } from 'octane'
import {
  fetchCandles,
  fetchPerpsByCategory,
  okx,
  okxStream,
  type CandleSource,
  type OkxBar,
  type OkxBook,
  type OkxCandle,
  type OkxEndpoint,
  type OkxPerpCategory,
  type OkxPerpInstrument,
  type OkxSocketStatus,
  type OkxTicker
} from '@/lib/okx'

// ─── OKX live-data hooks ─────────────────────────────────────────
// All hooks share the app-wide OKX sockets; mounting the same feed in
// ten components costs one OKX subscription. Updates are coalesced to
// at most one render per `throttleMs`.

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

/** Live ticker for one instrument ("AAPL-USDT-SWAP", "BTC-USDT-SWAP"). */
export function useOkxTicker(instId: string | null | undefined, throttleMs = 250): OkxTicker | null {
  const [ticker, setTicker] = useState<OkxTicker | null>(null)
  useEffect(() => {
    setTicker(null)
    if (!instId) return
    const t = throttled(setTicker, throttleMs)
    const off = okx.ticker(instId, t.push)
    return () => {
      off()
      t.cancel()
    }
  }, [instId, throttleMs])
  return ticker
}

/** Live tickers for many instruments, keyed by instId. One render per tick window. */
export function useOkxTickers(instIds: readonly string[], throttleMs = 500): Record<string, OkxTicker> {
  const [tickers, setTickers] = useState<Record<string, OkxTicker>>({})
  const key = instIds.join(',')
  useEffect(() => {
    const latest: Record<string, OkxTicker> = {}
    const t = throttled(setTickers, throttleMs)
    const offs = instIds.map((id) =>
      okx.ticker(id, (tick) => {
        latest[id] = tick
        t.push({ ...latest })
      })
    )
    return () => {
      offs.forEach((off) => off())
      t.cancel()
    }
  }, [key, throttleMs])
  return tickers
}

/** % change vs the 00:00 UTC open (OKX's "today"), or vs 24h open. */
export function okxChangePct(t: OkxTicker | null | undefined, ref: 'utc0' | '24h' = 'utc0'): number | null {
  if (!t) return null
  const base = ref === 'utc0' ? t.sodUtc0 : t.open24h
  return base > 0 ? ((t.last - base) / base) * 100 : null
}

export interface OkxCandlesState {
  candles: OkxCandle[]
  loading: boolean
  error: string | null
}

/**
 * Candle history (REST) merged with the live business-WS stream.
 * `source: 'index'` expects the family id ("AAPL-USDT").
 */
export function useOkxCandles(
  instId: string | null | undefined,
  bar: OkxBar,
  { limit = 300, source = 'trade', throttleMs = 250 }: { limit?: number; source?: CandleSource; throttleMs?: number } = {}
): OkxCandlesState {
  const [state, setState] = useState<OkxCandlesState>({ candles: [], loading: true, error: null })
  useEffect(() => {
    if (!instId) {
      setState({ candles: [], loading: false, error: null })
      return
    }
    setState({ candles: [], loading: true, error: null })
    let alive = true
    let series: OkxCandle[] = []
    let seeded = false
    const early: OkxCandle[] = [] // live bars that arrive before history
    const t = throttled((c: OkxCandle[]) => alive && setState({ candles: c, loading: false, error: null }), throttleMs)

    const merge = (c: OkxCandle) => {
      const last = series[series.length - 1]
      if (last && last.ts === c.ts) series = [...series.slice(0, -1), c]
      else if (!last || c.ts > last.ts) series = [...series, c].slice(-limit)
      else return
      t.push(series)
    }

    const sub = source === 'mark' ? okx.markPriceCandles : source === 'index' ? okx.indexCandles : okx.candles
    const off = sub(instId, bar, (c) => (seeded ? merge(c) : early.push(c)))

    fetchCandles(instId, bar, { limit, source })
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
  }, [instId, bar, limit, source, throttleMs])
  return state
}

/** Locally maintained order book (public `books`), top `depth` levels. Sizes in contracts. */
export function useOkxBook(instId: string | null | undefined, depth = 20, throttleMs = 100): OkxBook | null {
  const [book, setBook] = useState<OkxBook | null>(null)
  useEffect(() => {
    setBook(null)
    if (!instId) return
    const t = throttled(setBook, throttleMs)
    const off = okx.book(instId, t.push, depth)
    return () => {
      off()
      t.cancel()
    }
  }, [instId, depth, throttleMs])
  return book
}

/** Live USDT perps of a category from OKX's catalog ("stock" → 220+ US equities). */
export function useOkxPerps(category: OkxPerpCategory): { perps: OkxPerpInstrument[]; error: string | null } {
  const [state, setState] = useState<{ perps: OkxPerpInstrument[]; error: string | null }>({ perps: [], error: null })
  useEffect(() => {
    let alive = true
    fetchPerpsByCategory(category)
      .then((perps) => alive && setState({ perps, error: null }))
      .catch((e) => alive && setState({ perps: [], error: e instanceof Error ? e.message : String(e) }))
    return () => {
      alive = false
    }
  }, [category])
  return state
}

/** Connection status of both OKX sockets. */
export function useOkxStatus(): Record<OkxEndpoint, OkxSocketStatus> {
  const [status, setStatus] = useState<Record<OkxEndpoint, OkxSocketStatus>>({
    public: okxStream.public.getStatus(),
    business: okxStream.business.getStatus()
  })
  useEffect(
    () =>
      okxStream.onStatus((s, endpoint) => setStatus((prev) => ({ ...prev, [endpoint]: s }))),
    []
  )
  return status
}
