import { api } from '../../convex/_generated/api'
import { useEffect, useState } from 'octane'
import { convex } from '@/lib/convex/client'
import type { PaperPosition, PaperSide } from '@/lib/paper/paper'
import { convexErrorMessage, useConvexAuth, useConvexQuery } from './useConvex'
import type { SimResult } from './usePaperAccount'

// ─── Real orders on the platform OKX account ─────────────────────
// Same shape the simulator uses for paper, backed by liveTrading.*:
// balance = USD (top-ups), prices/fills come from OKX, never the client.

export interface LiveConfig {
  enabled: boolean
  mode: 'demo' | 'live' | null
  canTrade: boolean
  reason: string | null
  maxOrderUsd: number
  maxUserNotionalUsd: number
  maxLeverage: number
}

export interface LiveAccount {
  config: LiveConfig | undefined
  loading: boolean
  /** Free USD balance (top-ups minus margin in use). */
  balance: number | null
  position: PaperPosition | null
  /** opening / closing while an order is in flight on OKX. */
  status: 'opening' | 'open' | 'closing' | null
  balanceError: string | null
  refreshBalance(): void
  open(side: PaperSide, margin: number, leverage: number): Promise<string | null>
  close(): Promise<{ result: SimResult | null; error: string | null; closedExternally?: boolean }>
}

export function useLiveConfig(): LiveConfig | undefined {
  return useConvexQuery(api.liveTrading.config, {}).data
}

export function useOkxConnection() {
  const authed = useConvexAuth().isAuthenticated
  return useConvexQuery(api.okxConnections.status, authed ? {} : 'skip')
}

export function usePersonalPositions() {
  const { isAuthenticated } = useConvexAuth()
  const { data, error } = useConvexQuery(api.liveTrading.personalPositions, isAuthenticated ? {} : 'skip')
  return { rows: isAuthenticated ? data ?? [] : [], error: isAuthenticated ? error : null }
}

export function useLiveAccount(instId: string, venue: 'paper' | 'live' | 'personal', revision?: string): LiveAccount {
  const authed = useConvexAuth().isAuthenticated
  const on = Boolean(convex) && authed && venue !== 'paper'
  const personal = venue === 'personal'
  const config = useLiveConfig()
  const usd = useConvexQuery(api.funds.usd, on && !personal ? {} : 'skip')
  const remote = useConvexQuery(api.liveTrading.openFor, on ? { instId, ...(personal ? { venue: 'personal' } : {}) } : 'skip')
  const doc = on && remote.data?.instId === instId && Boolean(remote.data.okxConnectionId) === personal ? remote.data : null
  const [refresh, setRefresh] = useState(0)
  const [okxBalance, setOkxBalance] = useState<{ key: string; balance: number | null; error: string | null } | null>(null)
  const balanceKey = on && personal && revision ? JSON.stringify([revision, instId, doc?._id, doc?.status, doc?.contractsSz, refresh]) : null
  useEffect(() => {
    if (!balanceKey || !convex || remote.data === undefined) return
    let active = true
    void convex.action(api.okxConnections.balance, {}).then(
      (balance) => { if (active) setOkxBalance({ key: balanceKey, balance, error: null }) },
      (e: unknown) => { if (active) setOkxBalance({ key: balanceKey, balance: null, error: convexErrorMessage(e) }) },
    )
    return () => { active = false }
  }, [balanceKey, remote.data !== undefined])
  const currentBalance = balanceKey && okxBalance?.key === balanceKey ? okxBalance : null

  const position: PaperPosition | null =
    doc && doc.status !== 'opening'
      ? {
          instId: doc.instId,
          side: doc.side,
          margin: doc.margin,
          leverage: doc.leverage,
          entry: doc.entry,
          size: doc.size,
          openFee: doc.openFee,
          openedAt: doc.openedAt ?? 0
        }
      : null

  return {
    config,
    loading: on && (remote.data === undefined ? !remote.error : personal ? Boolean(balanceKey && !currentBalance && !doc) : usd.data === undefined),
    balance: personal ? currentBalance?.balance ?? null : usd.data ?? null,
    balanceError: remote.error ? 'Could not load the current OKX position.' : currentBalance?.error ?? null,
    refreshBalance: () => setRefresh((n) => n + 1),
    position,
    status: doc ? (doc.status as LiveAccount['status']) : null,
    async open(side, margin, leverage) {
      try {
        const r = await convex!.action(api.liveTrading.open, {
          instId, side, margin, leverage, ...(personal ? { venue: 'personal', connectionRevision: revision } : {}),
        })
        if (personal) setRefresh((n) => n + 1)
        if (r.outcome === 'rejected') return r.error ?? 'OKX rejected the order.'
        if (r.outcome === 'pending') return r.error ?? 'Order sent; waiting for OKX to confirm the fill.'
        return null
      } catch (e) {
        return convexErrorMessage(e)
      }
    },
    async close() {
      if (!doc) return { result: null, error: 'No open position.' }
      try {
        const r = await convex!.action(api.liveTrading.close, { positionId: doc._id })
        if (r.outcome === 'closed_externally') return { result: null, error: null, closedExternally: true }
        if (r.outcome === 'filled' && r.exit === null) return { result: null, error: null }
        if (r.outcome !== 'filled' || r.realized === null || r.exit === null) {
          return { result: null, error: r.error ?? 'Close sent; waiting for OKX to confirm the fill.' }
        }
        return {
          result: { side: doc.side, leverage: doc.leverage, margin: doc.margin, exit: r.exit, realized: r.realized, liquidated: false },
          error: null
        }
      } catch (e) {
        return { result: null, error: convexErrorMessage(e) }
      }
    }
  }
}
