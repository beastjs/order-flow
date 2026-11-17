import { useEffect, useRef, useState } from 'octane'
import {
  fetchCandles,
  fetchSparkline,
  fetchTickers,
  fetchPerpsByCategory,
  okx,
  okxStream,
  type CandleSource,
  type OkxBar,
  type OkxBook,
  type OkxCandle,
  type OkxEndpoint,
  type OkxFundingRate,
  type OkxIndexTicker,
  type OkxMarkPrice,
  type OkxOpenInterest,
  type OkxTrade,
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

/** Shared one-shot REST snapshot of all SWAP tickers (seed for big grids). */
let snapshotPromise: Promise<Record<string, OkxTicker>> | null = null
export function useOkxTickerSnapshot(): Record<string, OkxTicker> {
  const [snap, setSnap] = useState<Record<string, OkxTicker>>({})
  useEffect(() => {
    let alive = true
    snapshotPromise ??= fetchTickers('SWAP').catch((e) => {
      snapshotPromise = null
      throw e
    })
    snapshotPromise.then((s) => alive && setSnap(s)).catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return snap
}

/** Hourly close prices for a sparkline, fetched through the rate-limited queue once `enabled`. */
export function useOkxSparkline(instId: string, enabled = true, bar: OkxBar = '1H', points = 24): number[] {
  const [closes, setCloses] = useState<number[]>([])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    fetchSparkline(instId, bar, points)
      .then((c) => alive && setCloses(c))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [instId, enabled, bar, points])
  return closes
}

/** True once the element has been near the viewport; `visible` tracks it live. */
export function useInView<T extends Element>(rootMargin = '200px'): { ref: { current: T | null }; visible: boolean; seen: boolean } {
  const ref = useRef<T | null>(null)
  const [visible, setVisible] = useState(false)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      setSeen(true)
      return
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting)
        if (entry.isIntersecting) setSeen(true)
      },
      { rootMargin }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin])
  return { ref, visible, seen }
}

/** Latest value from any single-value OKX channel helper (funding, mark, OI, index…). */
function useOkxLatest<T>(
  subscribe: (id: string, cb: (v: T) => void) => () => void,
  id: string | null | undefined,
  throttleMs: number
): T | null {
  const [value, setValue] = useState<T | null>(null)
  useEffect(() => {
    setValue(null)
    if (!id) return
    const t = throttled(setValue, throttleMs)
    const off = subscribe(id, t.push)
    return () => {
      off()
      t.cancel()
    }
  }, [id, throttleMs])
  return value
}

export const useOkxFunding = (instId: string | null | undefined, throttleMs = 1000) =>
  useOkxLatest<OkxFundingRate>(okx.fundingRate, instId, throttleMs)
export const useOkxMarkPrice = (instId: string | null | undefined, throttleMs = 500) =>
  useOkxLatest<OkxMarkPrice>(okx.markPrice, instId, throttleMs)
export const useOkxOpenInterest = (instId: string | null | undefined, throttleMs = 1000) =>
  useOkxLatest<OkxOpenInterest>(okx.openInterest, instId, throttleMs)
/** Index id is the family: "AAPL-USDT". */
export const useOkxIndexTicker = (indexId: string | null | undefined, throttleMs = 500) =>
  useOkxLatest<OkxIndexTicker>(okx.indexTicker, indexId, throttleMs)

/** Most recent individual fills (business `trades-all`), newest first. */
export function useOkxTrades(instId: string | null | undefined, max = 40, throttleMs = 200): OkxTrade[] {
  const [trades, setTrades] = useState<OkxTrade[]>([])
  useEffect(() => {
    setTrades([])
    if (!instId) return
    let buf: OkxTrade[] = []
    const t = throttled(setTrades, throttleMs)
    const off = okx.tradesAll(instId, (trade) => {
      buf = [trade, ...buf].slice(0, max)
      t.push(buf)
    })
    return () => {
      off()
      t.cancel()
    }
  }, [instId, max, throttleMs])
  return trades
}
