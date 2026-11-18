import { createRootRoute, createRoute, createRouter, redirect } from '@octanejs/tanstack-router'
import RootLayout from './routes/RootLayout.btsx'
import Landing from './routes/Landing.btsx'
import TerminalPage from './routes/TerminalPage.btsx'
import Perps from './routes/Perps.btsx'
import AssetPage from './routes/AssetPage.btsx'

const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Landing })
const terminalRoute = createRoute({ getParentRoute: () => rootRoute, path: 'terminal', component: TerminalPage })

export type PerpsTab = 'markets' | 'positions'
const validatePerpsSearch = (search: Record<string, unknown>): { tab?: PerpsTab } =>
  search.tab === 'positions' ? { tab: 'positions' } : {}

const perpsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'perps',
  component: Perps,
  // ?tab=positions — omitted for the default Markets tab.
  validateSearch: validatePerpsSearch
})
const assetRoute = createRoute({ getParentRoute: () => rootRoute, path: 'perps/$assetId', component: AssetPage })

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

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, terminalRoute, perpsRoute, assetRoute, legacyPerpsRoute, legacyAssetRoute])
})

declare module '@octanejs/tanstack-router' {
  interface Register {
    router: typeof router
  }
}
