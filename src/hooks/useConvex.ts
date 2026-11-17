import { useEffect, useRef, useState, useSyncExternalStore } from 'octane'
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from 'convex/server'
import { convex, convexAuthStore, type ConvexAuthState } from '@/lib/convex/client'

// ─── Convex hooks for Octane ─────────────────────────────────────
// There is no Octane binding for convex/react, so these sit on the
// framework-agnostic ConvexClient. Queries are live: Convex pushes a
// new result whenever the data they read changes.

export function useConvexAuth(): ConvexAuthState {
  return useSyncExternalStore(convexAuthStore.subscribe, convexAuthStore.get, convexAuthStore.get)
}

/**
 * Live query result: `undefined` while loading (or skipped), then the
 * latest value. Pass "skip" to not subscribe (e.g. while signed out).
 */
export function useConvexQuery<Q extends FunctionReference<'query'>>(
  query: Q,
  args: FunctionArgs<Q> | 'skip'
): { data: FunctionReturnType<Q> | undefined; error: Error | null } {
  const [data, setData] = useState<FunctionReturnType<Q> | undefined>(undefined)
  const [error, setError] = useState<Error | null>(null)
  // `api.x.y` builds a NEW reference object on every access, so the query
  // object can't be an effect dependency (it would resubscribe every render
  // and reset `data` forever). Key on the stable function name instead.
  const name = getFunctionName(query)
  const key = args === 'skip' ? 'skip' : JSON.stringify(args)
  const latest = useRef({ query, args })
  latest.current = { query, args }

  useEffect(() => {
    setData(undefined)
    setError(null)
    const { query: q, args: a } = latest.current
    if (!convex || a === 'skip') return
    const unsubscribe = convex.onUpdate(
      q,
      a,
      (result) => {
        setData(result)
        setError(null)
      },
      (e) => setError(e)
    )
    return () => unsubscribe()
  }, [name, key])

  return { data, error }
}

/** Human-readable message from a Convex function error ("Uncaught Error: X" → "X"). */
export function convexErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const match = raw.match(/Uncaught Error: ([^\n]+)/)
  return (match ? match[1] : raw).replace(/\s+at .*$/s, '').trim()
}
