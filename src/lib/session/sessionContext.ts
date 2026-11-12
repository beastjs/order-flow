import { useStore } from '@octanejs/zustand'
import { createContext, useContext, useEffect, useRef, useState } from 'octane'
import type { MarketSession, SessionStore } from './MarketSession'

export const SessionContext = createContext<MarketSession | null>(null)

export function useMarketSession(): MarketSession {
  const session = useContext(SessionContext)
  if (!session)
    throw new Error('useMarketSession must be used inside MarketSessionProvider')
  return session
}

export function useSessionStore<T>(selector: (state: ReturnType<SessionStore['getState']>) => T): T {
  return useStore(useMarketSession().store, selector)
}

export function useSessionStoreApi(): SessionStore {
  return useMarketSession().store
}

/**
 * Like `useSessionStore`, but the component sees a new value at most every
 * `intervalMs`. For panels that would otherwise re-render on every feed flush
 * (20×/s) to show something nobody can read that fast.
 */
export function useThrottledSessionStore<T>(
  selector: (state: ReturnType<SessionStore['getState']>) => T,
  intervalMs = 250
): T {
  const store = useMarketSession().store
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const [value, setValue] = useState<T>(() => selector(store.getState()))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = 0
    const read = () => {
      timer = null
      last = Date.now()
      const next = selectorRef.current(store.getState())
      setValue(() => next)
    }
    read()
    const unsubscribe = store.subscribe(() => {
      if (timer === null) timer = setTimeout(read, Math.max(0, intervalMs - (Date.now() - last)))
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [store, intervalMs])

  return value
}
