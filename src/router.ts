import { createRootRoute, createRoute, createRouter, redirect } from '@octanejs/tanstack-router'
import { createConsoleFallbackRoutes, selectConsoleRouteTree } from './routes/consoleRoutes'
import RootLayout from './routes/RootLayout.btsx'
import Landing from './routes/Landing.btsx'
import TerminalPage from './routes/TerminalPage.btsx'
import Perps from './routes/Perps.btsx'
import AssetPage from './routes/AssetPage.btsx'

const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Landing })
const terminalRoute = createRoute({ getParentRoute: () => rootRoute, path: 'terminal', component: TerminalPage })

export type PerpsTab = 'markets' | 'positions' | 'history'
type VenueSearch = { venue?: 'hyperliquid' }
// ?venue=hyperliquid — omitted for the default OKX feed.
const validateVenue = (search: Record<string, unknown>): VenueSearch =>
  search.venue === 'hyperliquid' ? { venue: 'hyperliquid' } : {}
const validatePerpsSearch = (search: Record<string, unknown>): { tab?: PerpsTab } & VenueSearch => ({
  ...(search.tab === 'positions' || search.tab === 'history' ? { tab: search.tab } : {}),
  ...validateVenue(search)
})

const perpsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'perps',
  component: Perps,
  // Omit tab for the default Markets view.
  validateSearch: validatePerpsSearch
})
const assetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'perps/$assetId',
  component: AssetPage,
  validateSearch: (search): VenueSearch & { trade?: 'personal' } => ({
    ...validateVenue(search),
    ...(search.trade === 'personal' ? { trade: 'personal' } : {})
  })
})

// Old /predictions URLs (bookmarks, shared links) → /perps, keeping the tab and asset.
const legacyPerpsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'predictions',
  validateSearch: validatePerpsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/perps', search, replace: true })
  }
})
const legacyAssetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'predictions/$assetId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/perps/$assetId', params: { assetId: params.assetId }, replace: true })
  }
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  terminalRoute,
  perpsRoute,
  assetRoute,
  legacyPerpsRoute,
  legacyAssetRoute,
  ...createConsoleFallbackRoutes(rootRoute)
])

export const router = createRouter({ routeTree: selectConsoleRouteTree() ?? routeTree })

declare module '@octanejs/tanstack-router' {
  interface Register {
    router: typeof router
  }
}
