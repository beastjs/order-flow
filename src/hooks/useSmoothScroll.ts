import { useEffect, useRef } from 'octane'
import Lenis from 'lenis'
import 'lenis/dist/lenis.css'

// ─── Smooth scrolling for a page's scroll container ─────────────
// Site pages scroll inside their own `.site` element (html/body are
// overflow:hidden for the terminal), so Lenis drives that element, not
// the window. It still scrolls natively (scrollTop, no transforms), so
// sticky headers/toolbars stay exactly in place.
//
// Jitter guards:
// - one instance + one rAF loop (autoRaf) per page, destroyed on unmount
// - scroll limits re-measured the instant any section resizes (live
//   grids/charts grow constantly; Lenis alone only watches one element,
//   debounced, so it would stop short then jump)
// - touch stays native (syncTouch off): no emulated inertia on phones
// - nested scrollers (e.g. horizontal filter chips) keep native scroll
// - prefers-reduced-motion: no smoothing at all

export function useSmoothScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const wrapper = ref.current
    if (!wrapper || typeof window === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    const lenis = new Lenis({
      wrapper,
      content: wrapper,
      eventsTarget: wrapper,
      autoRaf: true,
      lerp: 0.1,
      smoothWheel: true,
      syncTouch: false,
      allowNestedScroll: true,
      autoResize: true
    })

    // Re-measure immediately whenever any top-level section changes size.
    const sections = new ResizeObserver(() => lenis.resize())
    const observeSections = () => {
      sections.disconnect()
      for (const child of Array.from(wrapper.children)) sections.observe(child)
    }
    observeSections()
    // Sections come and go (tab switches, loading → loaded states).
    const membership = new MutationObserver(observeSections)
    membership.observe(wrapper, { childList: true })

    return () => {
      membership.disconnect()
      sections.disconnect()
      lenis.destroy()
    }
  }, [])

  return ref
}
