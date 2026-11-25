import { useLayoutEffect, useRef, useState } from 'octane'

type Point = readonly [x: number, y: number]

export type PriceChartFrame = {
  timestamps: readonly number[]
  points: readonly Point[]
  baselineY: number
  averageY: number
}

const liveTransitionMs = 1000
const priceTransitionMs = 300
const lerp = (start: number, end: number, progress: number) => start + (end - start) * progress
const progressAt = (elapsed: number, duration: number) => (duration <= 0 ? 1 : Math.min(1, elapsed / duration))

function alignFrames(from: PriceChartFrame, to: PriceChartFrame) {
  const offset = from.timestamps.indexOf(to.timestamps[0])
  if (offset < 0) return null

  const overlap = from.timestamps.length - offset
  if (
    overlap < 2 ||
    overlap > to.timestamps.length ||
    !from.timestamps.slice(offset).every((ts, index) => ts === to.timestamps[index])
  )
    return null

  // Keep outgoing candles at the left edge until they scroll out of the viewport.
  // A new right-edge candle grows out of the previous endpoint as the series rolls.
  const outgoing = from.points.slice(0, offset)
  const last = from.points[from.points.length - 1]
  const step = to.points[1][0] - to.points[0][0]
  const start = [...outgoing, ...to.points.map((_, index) => from.points[offset + index] ?? last)]
  const end = [...outgoing.map(([, y], index): Point => [to.points[0][0] - (offset - index) * step, y]), ...to.points]
  if (start.every(([x, y], index) => x === end[index][0] && y === end[index][1])) return null

  return { start, end, timestamps: [...from.timestamps.slice(0, offset), ...to.timestamps] }
}

export function useLivePriceChart(target: PriceChartFrame | null, live: boolean): PriceChartFrame | null {
  const [displayed, setDisplayed] = useState(target)
  const current = useRef(target)
  const timing = useRef({ target, scrollSampleTime: 0, scrollEnd: 0, priceEnd: 0 })

  useLayoutEffect(() => {
    if (!live) {
      current.current = target
      timing.current = { target, scrollSampleTime: 0, scrollEnd: 0, priceEnd: 0 }
      return
    }

    const publish = (frame: PriceChartFrame | null) => {
      current.current = frame
      setDisplayed(frame)
    }
    const previous = current.current
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const transition = !reducedMotion.matches && previous && target ? alignFrames(previous, target) : null
    if (!transition || !previous || !target) {
      timing.current = { target, scrollSampleTime: 0, scrollEnd: 0, priceEnd: 0 }
      publish(target)
      return
    }

    const startTime = performance.now()
    const lastTarget = timing.current.target
    const sameWindow =
      lastTarget &&
      lastTarget.timestamps.length === target.timestamps.length &&
      lastTarget.timestamps.every((ts, index) => ts === target.timestamps[index])
    const samePrices = sameWindow && lastTarget.points.every(([, y], index) => y === target.points[index][1])
    // Intrabar ticks can retarget price movement without slowing the candle's scroll.
    const scrollStart = sameWindow ? timing.current.scrollSampleTime : startTime
    const scrollEnd = sameWindow ? timing.current.scrollEnd : startTime + liveTransitionMs
    const priceEnd = samePrices ? timing.current.priceEnd : startTime + priceTransitionMs
    timing.current = { target, scrollSampleTime: scrollStart, scrollEnd, priceEnd }

    let frame: number
    const draw = (now: number) => {
      const scrollProgress = progressAt(Math.max(0, now - scrollStart), scrollEnd - scrollStart)
      const priceProgress = progressAt(Math.max(0, now - startTime), priceEnd - startTime)
      timing.current.scrollSampleTime = Math.max(now, scrollStart)
      if ((scrollProgress === 1 && priceProgress === 1) || reducedMotion.matches) {
        publish(target)
        return
      }
      publish({
        timestamps: transition.timestamps,
        points: transition.start.map(([x, y], index): Point => [
          lerp(x, transition.end[index][0], scrollProgress),
          lerp(y, transition.end[index][1], priceProgress)
        ]),
        baselineY: lerp(previous.baselineY, target.baselineY, priceProgress),
        averageY: lerp(previous.averageY, target.averageY, priceProgress)
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [target, live])

  return live ? displayed : target
}
