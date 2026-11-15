import { MARKET_CLOSED_FLAG } from '@/lib/adapters/forex'
import { useSessionStore } from '@/lib/session/sessionContext'

/** True while the selected market is forex and the forex market is closed. */
export function useMarketClosed(): boolean {
  return useSessionStore(
    (s) =>
      s.replay === null &&
      s.marketType === 'forex' &&
      s.connections['finnhub-forex']?.stateFlag === MARKET_CLOSED_FLAG
  )
}

export const MARKET_CLOSED_HOURS = 'Forex trades Sunday 17:00 to Friday 17:00, New York time.'
