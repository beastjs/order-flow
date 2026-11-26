import { useEffect, useRef, useState, useSyncExternalStore } from 'octane'
import type { FunctionReturnType } from 'convex/server'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { convex, convexAuthStore } from '@/lib/convex/client'
import { TAKER_FEE, paperStore, type ExitTargets, type FollowUpOrder, type PaperFill, type PaperPosition, type PaperSide } from '@/lib/paper/paper'
import { convexErrorMessage, useConvexAuth, useConvexQuery } from './useConvex'
import { fetchHlBookQuote } from '@/lib/hyperliquid/rest'
import { hlPaperCoin, paperAsset } from '@/lib/paper/instruments'

// ─── One paper account, two backends ─────────────────────────────
// Signed in  → Convex: balance in `funds`, positions priced by the
//              server from the position's venue, liquidated by the backend sweep.
// Signed out → this browser's local practice store, priced from the
//              live WebSocket quote.

export type SimResult = Pick<PaperFill, 'side' | 'leverage' | 'margin' | 'exit' | 'realized' | 'liquidated'>

export interface PaperAccount {
  mode: 'cloud' | 'local'
  /** Cloud: true until balance + position have loaded. */
  loading: boolean
  balance: number | null
  position: PaperPosition | null
  positionKey: string | null
  /** Set when the backend or another view closes the position. */
  closedRemotely: boolean
  open(side: PaperSide, margin: number, leverage: number, quote: { bid?: number; ask?: number }): Promise<string | null>
  close(quote: { bid?: number; ask?: number }): Promise<{ result: SimResult | null; error: string | null }>
  reset(): Promise<string | null>
  setExitTargets(targets: ExitTargets): Promise<string | null>
  /** Local mode only: the client liquidates on mark (the server sweeps in cloud mode). */
  liquidateLocal(price: number): SimResult | null
}

async function saveCloudExitTargets(positionId: Id<'positions'>, targets: ExitTargets): Promise<string | null> {
  try {
    await convex!.mutation(api.positions.setExitTargets, { positionId, ...targets })
    return null
  } catch (e) {
    return convexErrorMessage(e)
  }
}

export function usePaperAccount(instId: string): PaperAccount {
  const authState = useConvexAuth()
  const cloud = Boolean(convex) && authState.isAuthenticated

  const local = useSyncExternalStore(paperStore.subscribe, paperStore.get, paperStore.get)
  const funds = useConvexQuery(api.funds.mine, cloud ? {} : 'skip')
  const remote = useConvexQuery(api.positions.openFor, cloud ? { instId } : 'skip')

  // Detect a cloud position disappearing without this view closing it.
  const [closedRemotely, setClosedRemotely] = useState(false)
  const closedByUsRef = useRef<string | null>(null)
  const lastIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!cloud || remote.data === undefined) return
    const id = remote.data?._id ?? null
    if (lastIdRef.current && !id && lastIdRef.current !== closedByUsRef.current) setClosedRemotely(true)
    if (id) setClosedRemotely(false)
    lastIdRef.current = id
  }, [cloud, remote.data])

  if (!cloud) {
    const position = local.positions[instId] ?? null
    return {
      mode: 'local',
      loading: authState.isLoading,
      balance: local.balance,
      position,
      positionKey: position ? `${instId}:${position.openedAt}` : null,
      closedRemotely: false,
      async open(side, margin, leverage, quote) {
        try {
          const market = await practiceQuote(instId, quote)
          const entry = (side === 'up' ? market.ask : market.bid) ?? 0
          return paperStore.open(instId, side, margin, leverage, entry)
        } catch (e) {
          return convexErrorMessage(e)
        }
      },
      async close(quote) {
        const p = paperStore.get().positions[instId]
        if (!p) return { result: null, error: 'No open position.' }
        return await closePracticePosition(p, quote)
      },
      async reset() {
        paperStore.reset()
        return null
      },
      async setExitTargets(targets) {
        if (!position) return 'Position not found or already closed.'
        return paperStore.setExitTargets(instId, position.openedAt, targets)
      },
      liquidateLocal(price) {
        return paperStore.close(instId, price, true)
      }
    }
  }

  const doc = remote.data ?? null
  const position: PaperPosition | null = doc
    ? {
        instId: doc.instId,
        side: doc.side,
        margin: doc.margin,
        leverage: doc.leverage,
        entry: doc.entry,
        size: doc.size,
        openFee: doc.openFee,
        openedAt: doc.openedAt,
        exitTargets: doc.exitTargets
      }
    : null

  return {
    mode: 'cloud',
    loading: funds.data === undefined || remote.data === undefined,
    balance: funds.data?.balance ?? null,
    position,
    positionKey: doc?._id ?? null,
    closedRemotely,
    async open(side, margin, leverage) {
      setClosedRemotely(false)
      try {
        await convex!.action(api.positions.open, { instId, side, margin, leverage })
        return null
      } catch (e) {
        return convexErrorMessage(e)
      }
    },
    async close() {
      if (!doc) return { result: null, error: 'No open position.' }
      closedByUsRef.current = doc._id
      try {
        const { realized, exit } = await convex!.action(api.positions.close, { positionId: doc._id })
        const result: SimResult = { side: doc.side, leverage: doc.leverage, margin: doc.margin, exit, realized, liquidated: false }
        return { result, error: null }
      } catch (e) {
        closedByUsRef.current = null
        return { result: null, error: convexErrorMessage(e) }
      }
    },
    async reset() {
      try {
        await convex!.mutation(api.funds.resetPaper, {})
        return null
      } catch (e) {
        return convexErrorMessage(e)
      }
    },
    async setExitTargets(targets) {
      if (!doc) return 'Position not found or already closed.'
      return saveCloudExitTargets(doc._id, targets)
    },
    liquidateLocal: () => null
  }
}

// ─── all open positions (the /perps Positions tab) ─────────

export interface OpenPositionRow {
  key: string
  instId: string
  base: string
  position: PaperPosition
}

export interface OpenPositions {
  mode: 'cloud' | 'local'
  loading: boolean
  balance: number | null
  rows: OpenPositionRow[]
  allRowsLoaded: boolean
  totalExitTargets: ExitTargets | null
  close(row: OpenPositionRow, quote: CloseQuote): Promise<{ result: SimResult | null; error: string | null }>
  closeAll(getQuote: (instId: string) => CloseQuote): Promise<BulkCloseResult>
  setExitTargets(row: OpenPositionRow, targets: ExitTargets): Promise<string | null>
  setFollowUpOrder(row: OpenPositionRow, order: FollowUpOrder | null): Promise<string | null>
  setTotalExitTargets(targets: ExitTargets): Promise<string | null>
}

type CloseQuote = { bid?: number; ask?: number }
type BulkCloseResult = {
  closed: number
  realized: number
  failures: { instId: string; message: string }[]
}

const OPEN_PAGE = { numItems: 200, cursor: null }

function practiceQuote(instId: string, quote: CloseQuote) {
  const coin = hlPaperCoin(instId)
  return coin ? fetchHlBookQuote(coin) : quote
}

async function closePracticePosition(position: PaperPosition, quote: CloseQuote): Promise<{ result: PaperFill | null; error: string | null }> {
  try {
    const market = await practiceQuote(position.instId, quote)
    if (paperStore.get().positions[position.instId]?.openedAt !== position.openedAt) {
      return { result: null, error: 'Position already closed.' }
    }
    const exit = (position.side === 'up' ? market.bid : market.ask) ?? 0
    const fill = paperStore.close(position.instId, exit)
    return fill ? { result: fill, error: null } : { result: null, error: 'Waiting for a price.' }
  } catch (e) {
    return { result: null, error: convexErrorMessage(e) }
  }
}

export function useOpenPositions(): OpenPositions {
  const authState = useConvexAuth()
  const cloud = Boolean(convex) && authState.isAuthenticated
  const local = useSyncExternalStore(paperStore.subscribe, paperStore.get, paperStore.get)
  const funds = useConvexQuery(api.funds.mine, cloud ? {} : 'skip')
  const remote = useConvexQuery(api.positions.listMine, cloud ? { status: 'open', paginationOpts: OPEN_PAGE } : 'skip')

  if (!cloud) {
    const rows = Object.values(local.positions)
      .sort((a, b) => b.openedAt - a.openedAt)
      .map((p) => ({ key: p.instId, instId: p.instId, base: paperAsset(p.instId).base, position: p }))
    return {
      mode: 'local',
      loading: authState.isLoading,
      balance: local.balance,
      rows,
      allRowsLoaded: true,
      totalExitTargets: local.totalExitTargets ?? null,
      async setTotalExitTargets(targets) {
        return paperStore.setTotalExitTargets(targets)
      },
      async setExitTargets(row, targets) {
        return paperStore.setExitTargets(row.instId, row.position.openedAt, targets)
      },
      async setFollowUpOrder(row, order) {
        return paperStore.setFollowUpOrder(row.instId, row.position.openedAt, order)
      },
      async close(row, quote) {
        return await closePracticePosition(row.position, quote)
      },
      async closeAll(getQuote) {
        const summary: BulkCloseResult = { closed: 0, realized: 0, failures: [] }
        for (const position of Object.values(paperStore.get().positions)) {
          const { result, error } = await closePracticePosition(position, getQuote(position.instId))
          if (result) {
            summary.closed += 1
            summary.realized += result.realized
          } else {
            summary.failures.push({ instId: position.instId, message: error ?? 'Waiting for a price.' })
          }
        }
        return summary
      }
    }
  }

  const docs = remote.data?.page ?? []
  return {
    mode: 'cloud',
    loading: funds.data === undefined || remote.data === undefined,
    balance: funds.data?.balance ?? null,
    allRowsLoaded: remote.data?.isDone === true,
    totalExitTargets: funds.data?.totalExitTargets ?? null,
    rows: docs.map((d) => ({
      key: d._id,
      instId: d.instId,
      base: d.base,
      position: {
        instId: d.instId,
        side: d.side,
        margin: d.margin,
        leverage: d.leverage,
        entry: d.entry,
        size: d.size,
        openFee: d.openFee,
        openedAt: d.openedAt,
        exitTargets: d.exitTargets,
        followUpOrder: d.followUpOrder
      }
    })),
    async setTotalExitTargets(targets) {
      try {
        await convex!.mutation(api.positions.setTotalExitTargets, targets)
        return null
      } catch (e) {
        return convexErrorMessage(e)
      }
    },
    async setExitTargets(row, targets) {
      const doc = docs.find((d) => d._id === row.key)
      if (!doc) return 'Position not found or already closed.'
      return saveCloudExitTargets(doc._id, targets)
    },
    async setFollowUpOrder(row, order) {
      const doc = docs.find((d) => d._id === row.key)
      if (!doc) return 'Position not found or already closed.'
      if (convexAuthStore.get() !== authState) return 'Account changed. Try again.'
      try {
        await convex!.mutation(api.positions.setFollowUpOrder, { positionId: doc._id, order })
        return null
      } catch (e) {
        return convexErrorMessage(e)
      }
    },
    async close(row) {
      const doc = docs.find((d) => d._id === row.key)
      if (!doc) return { result: null, error: 'Position already closed.' }
      try {
        const { realized, exit } = await convex!.action(api.positions.close, { positionId: doc._id })
        return { result: { side: doc.side, leverage: doc.leverage, margin: doc.margin, exit, realized, liquidated: false }, error: null }
      } catch (e) {
        return { result: null, error: convexErrorMessage(e) }
      }
    },
    async closeAll() {
      const client = convex!
      const positions: typeof docs = []
      let cursor: string | null = null
      do {
        const page: FunctionReturnType<typeof api.positions.listMine> = await client.query(api.positions.listMine, {
          status: 'open',
          paginationOpts: { ...OPEN_PAGE, cursor }
        })
        positions.push(...page.page)
        cursor = page.isDone ? null : page.continueCursor
      } while (cursor !== null && convexAuthStore.get() === authState)
      if (convexAuthStore.get() !== authState) throw new Error('Account changed. Try again.')

      const summary: BulkCloseResult = { closed: 0, realized: 0, failures: [] }
      for (const position of positions) {
        try {
          const { realized } = await client.action(api.positions.close, { positionId: position._id })
          summary.closed += 1
          summary.realized += realized
        } catch (e) {
          summary.failures.push({ instId: position.instId, message: convexErrorMessage(e) })
        }
      }
      return summary
    }
  }
}

// ─── available balance (topbar + simulator) ─────────────────────

export interface AvailableBalance {
  mode: 'cloud' | 'local'
  /** Free paper balance (excludes margin locked in open positions); null while loading. */
  balance: number | null
}

/** The free paper trading balance: your account when signed in, practice mode otherwise. */
export function useAvailableBalance(): AvailableBalance {
  const authState = useConvexAuth()
  const cloud = Boolean(convex) && authState.isAuthenticated
  const local = useSyncExternalStore(paperStore.subscribe, paperStore.get, paperStore.get)
  const funds = useConvexQuery(api.funds.mine, cloud ? {} : 'skip')
  if (cloud) return { mode: 'cloud', balance: funds.data?.balance ?? null }
  return { mode: 'local', balance: authState.isLoading ? null : local.balance }
}

/** Largest margin affordable at `leverage` once the opening fee is included, floored to cents. */
export function maxMargin(available: number, leverage: number): number {
  return Math.max(0, Math.floor((available / (1 + leverage * TAKER_FEE)) * 100) / 100)
}
