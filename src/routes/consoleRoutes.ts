import { createRootRoute, createRoute, lazyRouteComponent } from '@octanejs/tanstack-router'
import type { AnyRoute } from '@tanstack/router-core'
import { isAsgardSubdomainHostname, asgardRoutePrefix } from '@/lib/routing/asgard-console'
import { isAdminSubdomainHostname, adminRoutePrefix } from '@/lib/routing/admin-console'

/**
 * `lazyRouteComponent` declares `preload` as possibly returning `undefined`,
 * while the route options require `Promise<void>`. The value behaves correctly
 * at runtime; only the declarations disagree, so the cast is confined here
 * instead of being repeated at every route.
 */
type RouteComponentOption = NonNullable<Parameters<typeof createRootRoute>[0]>['component']

const lazy = (load: () => Promise<unknown>): RouteComponentOption =>
  lazyRouteComponent(load as () => Promise<{ default: never }>) as RouteComponentOption

const asgardShell = lazy(() => import('@/pages/asgard-page.btsx'))
const asgardOverview = lazy(() => import('@/pages/asgard-overview-page.btsx'))
const asgardAccounts = lazy(() => import('@/pages/asgard-accounts-page.btsx'))
const asgardUsers = lazy(() => import('@/pages/asgard-users-page.btsx'))
const adminShell = lazy(() => import('@/pages/admin-page.btsx'))
const adminOverview = lazy(() => import('@/pages/admin-overview-page.btsx'))

function createAsgardRoutes<TParentRoute extends AnyRoute>(parentRoute: TParentRoute) {
  const overviewRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: '/',
    component: asgardOverview
  })
  const accountsRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: 'accounts',
    component: asgardAccounts
  })
  const usersRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: 'users',
    component: asgardUsers
  })

  return [overviewRoute, accountsRoute, usersRoute] as const
}

/** Asgard as the whole site, which is what it is on its own subdomain. */
function createAsgardRouteTree() {
  const rootRoute = createRootRoute({ component: asgardShell })

  return rootRoute.addChildren(createAsgardRoutes(rootRoute))
}

/** Admin as the whole site, which is what it is on its own subdomain. */
function createAdminRouteTree() {
  const rootRoute = createRootRoute({ component: adminShell })

  const overviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: adminOverview
  })

  return rootRoute.addChildren([overviewRoute])
}

/**
 * The console tree for this host, or `null` when this is the app.
 *
 * The host decides once, at module load: on a console's subdomain the console
 * *is* the site, so nothing downstream has to ask which host it is on and the
 * main bundle never carries a console.
 */
export function selectConsoleRouteTree() {
  if (typeof window === 'undefined') return null

  const hostname = window.location.hostname

  if (isAsgardSubdomainHostname(hostname)) return createAsgardRouteTree()
  if (isAdminSubdomainHostname(hostname)) return createAdminRouteTree()

  return null
}

/**
 * The consoles mounted as paths on the app's own tree.
 *
 * These are what make a console reachable before DNS exists — on the dev
 * server, on a `*.workers.dev` origin, on an IP. Where the subdomain works, the
 * tree above is chosen instead and these never render.
 */
export function createConsoleFallbackRoutes<TRootRoute extends AnyRoute>(rootRoute: TRootRoute) {
  const asgardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: asgardRoutePrefix,
    component: asgardShell
  })

  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: adminRoutePrefix,
    component: adminShell
  })

  const adminIndexRoute = createRoute({
    getParentRoute: () => adminRoute,
    path: '/',
    component: adminOverview
  })

  return [asgardRoute.addChildren(createAsgardRoutes(asgardRoute)), adminRoute.addChildren([adminIndexRoute])] as const
}
