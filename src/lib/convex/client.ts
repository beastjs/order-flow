// ============================================================
// Convex browser client + Firebase auth bridge.
// One shared ConvexClient for the app. When Firebase signs a user
// in, their ID token is handed to Convex (refreshed on demand) and
// `users.store` creates/refreshes their row; on sign-out auth is
// cleared. UI reads the bridged state through `convexAuthStore`.
// ============================================================

import { ConvexClient } from 'convex/browser'
import { onIdTokenChanged } from 'firebase/auth'
import { api } from '../../../convex/_generated/api'
import { auth } from '@/lib/firebase'

const url = import.meta.env.PUBLIC_CONVEX_URL as string | undefined

if (!url) console.warn('Convex is disabled: set PUBLIC_CONVEX_URL (see .env.example).')

export const convex: ConvexClient | null = url ? new ConvexClient(url) : null

export interface ConvexAuthState {
  /** Firebase or Convex still deciding. */
  isLoading: boolean
  /** Convex accepted the Firebase token and the user row exists. */
  isAuthenticated: boolean
  error: string | null
}

let state: ConvexAuthState = { isLoading: Boolean(convex && auth), isAuthenticated: false, error: null }
const listeners = new Set<() => void>()
const set = (next: Partial<ConvexAuthState>) => {
  state = { ...state, ...next }
  listeners.forEach((fn) => fn())
}

export const convexAuthStore = {
  get: (): ConvexAuthState => state,
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
}

let started = false

/** Call once at startup. Safe when Firebase or Convex is not configured. */
export function startConvexAuthSync(): void {
  if (started || !convex || !auth) {
    if (!started) set({ isLoading: false })
    started = true
    return
  }
  started = true
  const client = convex
  let currentUid: string | null = null

  onIdTokenChanged(auth, (user) => {
    if (!user) {
      currentUid = null
      client.client.clearAuth()
      set({ isLoading: false, isAuthenticated: false, error: null })
      return
    }
    // Token refreshes fire this too; only re-handshake when the account changes.
    if (user.uid === currentUid) return
    currentUid = user.uid
    set({ isLoading: true, isAuthenticated: false, error: null })

    client.setAuth(
      async ({ forceRefreshToken }) => {
        try {
          return await user.getIdToken(forceRefreshToken)
        } catch {
          return null
        }
      },
      (ok) => {
        if (user.uid !== currentUid) return
        if (!ok) {
          set({ isLoading: false, isAuthenticated: false, error: 'Convex rejected the sign-in token.' })
          return
        }
        client
          .mutation(api.users.store, {})
          .then(() => user.uid === currentUid && set({ isLoading: false, isAuthenticated: true, error: null }))
          .catch((e: unknown) =>
            set({ isLoading: false, isAuthenticated: false, error: e instanceof Error ? e.message : String(e) })
          )
      }
    )
  })
}
