import { useStore } from '@octanejs/zustand'
import { createContext, useContext } from 'octane'
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
