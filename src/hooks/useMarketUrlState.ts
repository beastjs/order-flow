import { useQueryStates } from '@octanejs/nuqs'
import { normalizeMarketSelection, type MarketSelectionInput } from '@/lib/config/marketSelection'
import { useSessionStore, useSessionStoreApi } from '@/lib/session/sessionContext'
import { useUIStore } from '@/lib/store/uiStore'
import type { MarketType, Timeframe, ToolProfile, VenueSelection } from '@/lib/types/market'
import { marketParams, toMarketQuery } from '@/lib/url/marketParams'
import { useEffect } from 'octane'

// ─── useMarketUrlState ───────────────────────────────────────────
// The topbar's market controls, mirrored in the URL. The session store stays
// what the feed reads; every change is written to both, and the URL is applied
// back to the store on back / forward and hand-edited links.

export function useMarketUrlState() {
  const store = useSessionStoreApi()
  const marketType = useSessionStore((s) => s.marketType)
  const symbol = useSessionStore((s) => s.symbol)
  const venue = useSessionStore((s) => s.venue)
  const timeframe = useSessionStore((s) => s.timeframe)
  // During a replay the market is fixed by the recording.
  const replaying = useSessionStore((s) => s.replay !== null)
  const toolProfile = useUIStore((s) => s.toolProfile)
  const [query, setQuery] = useQueryStates(marketParams)

  const select = (input: MarketSelectionInput) => {
    const selection = normalizeMarketSelection(input)
    store.getState().setMarket(selection)
    void setQuery(toMarketQuery(selection), { history: 'push' })
  }

  const chooseMarketType = (next: MarketType) => {
    if (next !== marketType) select({ marketType: next, symbol, venue })
  }
  const chooseSymbol = (next: string) => select({ marketType, symbol: next, venue })
  const chooseVenue = (next: VenueSelection) => select({ marketType, symbol, venue: next })

  const chooseTimeframe = (next: Timeframe) => {
    store.getState().setTimeframe(next)
    void setQuery({ tf: next }, { history: 'replace' })
  }

  const chooseToolProfile = (next: ToolProfile) => {
    useUIStore.getState().setToolProfile(next)
    void setQuery({ ws: next }, { history: 'replace' })
  }

  // URL → store.
  useEffect(() => {
    if (replaying) return
    const selection = normalizeMarketSelection({ marketType: query.market, symbol: query.symbol, venue: query.venue })
    store.getState().setMarket({ ...selection, timeframe: query.tf })
    // A link naming a combination that doesn't exist is rewritten to the one shown.
    const canonical = toMarketQuery(selection)
    if (canonical.symbol !== query.symbol || canonical.venue !== query.venue) {
      void setQuery(canonical, { history: 'replace' })
    }
  }, [store, setQuery, replaying, query.market, query.symbol, query.venue, query.tf])

  // The workspace preset replaces the panel layout, so it is applied only when
  // the link asks for a different one than the saved preferences hold.
  useEffect(() => {
    const linked = query.ws
    if (!linked) return
    const apply = () => {
      const ui = useUIStore.getState()
      if (ui.toolProfile !== linked) ui.setToolProfile(linked)
    }
    if (useUIStore.persist.hasHydrated()) {
      apply()
      return
    }
    return useUIStore.persist.onFinishHydration(apply)
  }, [query.ws])

  return {
    marketType,
    symbol,
    venue,
    timeframe,
    toolProfile,
    replaying,
    chooseMarketType,
    chooseSymbol,
    chooseVenue,
    chooseTimeframe,
    chooseToolProfile,
  }
}
