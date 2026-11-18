import { api } from '../../convex/_generated/api'
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
  open(side: PaperSide, margin: number, leverage: number): Promise<string | null>
  close(): Promise<{ result: SimResult | null; error: string | null }>
}

export function useLiveConfig(): LiveConfig | undefined {
  return useConvexQuery(api.liveTrading.config, {}).data
}

export function useLiveAccount(instId: string, enabled: boolean): LiveAccount {
  const authed = useConvexAuth().isAuthenticated
  const on = Boolean(convex) && authed && enabled
  const config = useLiveConfig()
  const usd = useConvexQuery(api.funds.usd, on ? {} : 'skip')
  const remote = useConvexQuery(api.liveTrading.openFor, on ? { instId } : 'skip')
  const doc = remote.data ?? null

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
    loading: on && (usd.data === undefined || remote.data === undefined),
    balance: usd.data ?? null,
    position,
    status: doc ? (doc.status as LiveAccount['status']) : null,
    async open(side, margin, leverage) {
      try {
        const r = await convex!.action(api.liveTrading.open, { instId, side, margin, leverage })
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
