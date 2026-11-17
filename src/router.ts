import { createRootRoute, createRoute, createRouter } from '@octanejs/tanstack-router'
import RootLayout from './routes/RootLayout.btsx'
import Landing from './routes/Landing.btsx'
import TerminalPage from './routes/TerminalPage.btsx'
import Predictions from './routes/Predictions.btsx'
import AssetPage from './routes/AssetPage.btsx'

const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Landing })
const terminalRoute = createRoute({ getParentRoute: () => rootRoute, path: 'terminal', component: TerminalPage })
const predictionsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'predictions', component: Predictions })
const assetRoute = createRoute({ getParentRoute: () => rootRoute, path: 'predictions/$assetId', component: AssetPage })

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, terminalRoute, predictionsRoute, assetRoute])
})

declare module '@octanejs/tanstack-router' {
  interface Register {
    router: typeof router
  }
}
