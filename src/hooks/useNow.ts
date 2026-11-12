import { useEffect, useState } from 'octane'

// One timer per interval, shared by every component that asks for it, so a
// second's worth of clocks updates in a single render pass.
const tickers = new Map<number, { listeners: Set<() => void>; id: ReturnType<typeof setInterval> }>()

function onTick(intervalMs: number, listener: () => void): () => void {
  let ticker = tickers.get(intervalMs)
  if (!ticker) {
    const listeners = new Set<() => void>()
    ticker = { listeners, id: setInterval(() => listeners.forEach((fn) => fn()), intervalMs) }
    tickers.set(intervalMs, ticker)
  }
  ticker.listeners.add(listener)
  return () => {
    const current = tickers.get(intervalMs)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      clearInterval(current.id)
      tickers.delete(intervalMs)
    }
  }
}

/**
 * Wall-clock milliseconds, refreshed every `intervalMs` (for countdowns and
 * rolling windows). Returns 0 until mounted: reading the clock during render
 * would be frozen into the prerendered page.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const stop = onTick(intervalMs, tick)
    return () => {
      clearTimeout(first)
      stop()
    }
  }, [intervalMs])
  return now
}
