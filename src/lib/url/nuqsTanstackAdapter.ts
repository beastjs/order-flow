import { useMemo } from 'octane'
import { useRouter, useRouterState } from '@octanejs/tanstack-router'
import {
  renderQueryString,
  unstable_createAdapterProvider,
  type unstable_AdapterInterface,
  type unstable_AdapterOptions
} from '@octanejs/nuqs/adapters/custom'

// ─── nuqs ⇄ TanStack Router ──────────────────────────────────────
// nuqs's stock `react` adapter writes window.history directly, which the
// router never hears about — its `useSearch`/`Link` would go stale. This
// adapter reads the raw query string from router state and writes through
// the router's history, so both stay in sync. Raw strings are used on both
// sides so nuqs keeps its own serialization (TanStack JSON-quotes values).

function useNuqsTanstackAdapter(): unstable_AdapterInterface {
  const router = useRouter()
  const searchStr = useRouterState({ select: (s) => s.location.searchStr })
  const searchParams = useMemo(() => new URLSearchParams(searchStr), [searchStr])
  const updateUrl = useMemo(
    () => (search: URLSearchParams, options: Required<unstable_AdapterOptions>) => {
      const { pathname, hash, state } = router.history.location
      const url = `${pathname}${renderQueryString(search)}${hash}`
      if (options.history === 'push') router.history.push(url, state)
      else router.history.replace(url, state)
      if (options.scroll) window.scrollTo({ top: 0 })
    },
    [router]
  )
  return {
    searchParams,
    updateUrl,
    getSearchParamsSnapshot: () => new URLSearchParams(router.history.location.search)
  }
}

/** Mount inside the RouterProvider (e.g. the root layout). */
export const NuqsTanstackAdapter = unstable_createAdapterProvider(useNuqsTanstackAdapter)
