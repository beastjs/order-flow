// ============================================================
// PAPER TRADING — browser-local store for the position simulator.
// Math lives in ./math (shared with the Convex backend).
// Nothing here touches a real account or exchange.
// ============================================================

import { STARTING_BALANCE, autoExitReason, closePosition, isLiquidated, liquidationPrice, openPosition, priceTotalExit, totalExitReason, validateExitTargets, validateFollowUpOrder, validateTotalExitTargets, type AutoExitReason, type ExitQuote, type ExitTargets, type FollowUpOrder, type FollowUpResult, type PaperFill, type PaperPosition, type PaperSide } from './math'

export * from './math'

// ─── persisted store ─────────────────────────────────────────

export interface PaperState {
  balance: number
  positions: Record<string, PaperPosition>
  history: PaperFill[]
  totalExitTargets?: ExitTargets
  pendingFollowUps?: PendingFollowUp[]
}

type PendingFollowUp = Pick<PaperFill, 'instId' | 'openedAt' | 'closedAt'> & { order: FollowUpOrder }

const KEY = 'cfx-paper-v1'
const fresh = (): PaperState => ({ balance: STARTING_BALANCE, positions: {}, history: [] })

function loadSaved(): PaperState | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as PaperState
    return Number.isFinite(s.balance) && s.positions && Array.isArray(s.history) ? s : null
  } catch {
    return null
  }
}

let state: PaperState = loadSaved() ?? fresh()
let savedLocally = true
const listeners = new Set<() => void>()

function commit(next: PaperState) {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
    savedLocally = true
  } catch {
    savedLocally = false
  }
  listeners.forEach((fn) => fn())
}

function recordCloses(positions: PaperState['positions'], fills: PaperFill[], balance: number, totalExitTargets?: ExitTargets): void {
  const pending = fills.flatMap(({ instId, openedAt, closedAt, followUpOrder }) =>
    followUpOrder ? [{ instId, openedAt, closedAt, order: followUpOrder }] : [])
  commit({
    balance, positions, totalExitTargets,
    history: [...fills, ...state.history].slice(0, 50),
    pendingFollowUps: pending.length ? [...(state.pendingFollowUps ?? []), ...pending] : state.pendingFollowUps
  })
}

type OpenResult = { position: PaperPosition; balance: number; error?: never } | { position?: never; error: string }

function prepareOpen(account: PaperState, instId: string, side: PaperSide, margin: number, leverage: number, entry: number): OpenResult {
  if (account.positions[instId]) return { error: 'Close the open position first.' }
  if (!(margin > 0)) return { error: 'Enter an amount.' }
  if (!Number.isFinite(entry) || entry <= 0) return { error: 'Waiting for a price.' }
  const position = openPosition(instId, side, margin, leverage, entry)
  const cost = margin + position.openFee
  if (cost > account.balance + 1e-9) return { error: 'Not enough paper balance.' }
  return { position, balance: account.balance - cost }
}

if (typeof window !== 'undefined') {
  // Keep tabs in sync.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      state = loadSaved() ?? fresh()
      savedLocally = true
      listeners.forEach((fn) => fn())
    }
  })
}

export const paperStore = {
  get: (): PaperState => state,
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  open(instId: string, side: PaperSide, margin: number, leverage: number, entry: number): string | null {
    const result = prepareOpen(state, instId, side, margin, leverage, entry)
    if (!result.position) return result.error
    commit({
      ...state,
      balance: result.balance,
      positions: { ...state.positions, [instId]: result.position }
    })
    return null
  },
  setExitTargets(instId: string, openedAt: number, targets: ExitTargets): string | null {
    const position = state.positions[instId]
    if (!position || position.openedAt !== openedAt) return 'Position not found or already closed.'
    const error = validateExitTargets(position, targets)
    if (error) return error
    const exitTargets = targets.stopLoss === null && targets.takeProfit === null ? undefined : targets
    commit({ ...state, positions: { ...state.positions, [instId]: { ...position, exitTargets } } })
    return null
  },
  setFollowUpOrder(instId: string, openedAt: number, order: FollowUpOrder | null): string | null {
    const position = state.positions[instId]
    if (!position || position.openedAt !== openedAt) return 'Position not found or already closed.'
    const error = order && validateFollowUpOrder(order)
    if (error) return error
    commit({ ...state, positions: { ...state.positions, [instId]: { ...position, followUpOrder: order ?? undefined } } })
    return null
  },
  completeFollowUp(source: PendingFollowUp, quote: { entry: number } | { error: string }): void {
    const matches = (fill: Pick<PaperFill, 'instId' | 'openedAt' | 'closedAt'>) =>
      fill.instId === source.instId && fill.openedAt === source.openedAt && fill.closedAt === source.closedAt
    // Another practice tab may have completed the same order before its storage event arrives.
    const account = (savedLocally && loadSaved()) || state
    const pending = account.pendingFollowUps?.find(matches)
    if (!pending) return

    const { instId, side, margin, leverage, exitTargets } = pending.order
    const result: OpenResult = 'error' in quote ? quote : prepareOpen(account, instId, side, margin, leverage, quote.entry)
    const outcome: FollowUpResult = result.position ? { status: 'opened' } : { status: 'failed', error: result.error }
    const exit = exitTargets.stopLoss !== null || exitTargets.takeProfit !== null ? exitTargets : undefined
    const updates = result.position ? {
      balance: result.balance,
      positions: { ...account.positions, [instId]: { ...result.position, exitTargets: exit } }
    } : {}
    commit({
      ...account, ...updates,
      history: account.history.map((fill) => matches(fill) ? { ...fill, followUpResult: outcome } : fill),
      pendingFollowUps: account.pendingFollowUps?.filter((order) => !matches(order))
    })
  },
  setTotalExitTargets(targets: ExitTargets): string | null {
    const error = validateTotalExitTargets(targets)
    if (error) return error
    const enabled = targets.stopLoss !== null || targets.takeProfit !== null
    if (enabled && Object.keys(state.positions).length === 0) return 'No open paper positions.'
    commit({ ...state, totalExitTargets: enabled ? targets : undefined })
    return null
  },
  checkTotalExitTargets(getQuote: (instId: string) => ExitQuote | undefined): void {
    if (!state.totalExitTargets) return
    const basket = priceTotalExit(Object.values(state.positions), getQuote)
    const reason = basket && totalExitReason(state.totalExitTargets, basket.pnl)
    if (!basket || !reason) return

    const now = Date.now()
    let balance = state.balance
    const fills = basket.exits.map(({ position, exit, liquidated }) => {
      const fill = closePosition(position, exit, liquidated, now)
      balance += position.margin + position.openFee + fill.realized
      return liquidated ? fill : { ...fill, autoExitReason: reason }
    })
    recordCloses({}, fills, balance)
  },
  checkExitTargets(instId: string, mark: number, quote: { bid?: number; ask?: number }): void {
    const position = state.positions[instId]
    if (!position || (!position.exitTargets && !position.followUpOrder) || !Number.isFinite(mark) || mark <= 0) return
    if (isLiquidated(position, mark)) {
      paperStore.close(instId, liquidationPrice(position), true)
      return
    }
    const exit = (position.side === 'up' ? quote.bid : quote.ask) ?? 0
    const reason = autoExitReason(position, exit)
    if (reason) paperStore.close(instId, exit, false, reason)
  },
  close(instId: string, exit: number, liquidated = false, reason?: AutoExitReason): PaperFill | null {
    const p = state.positions[instId]
    if (!p || !(exit > 0)) return null
    const fill = { ...closePosition(p, exit, liquidated), autoExitReason: reason }
    const { [instId]: _, ...rest } = state.positions
    // Margin + open fee were debited at open; return margin plus realized (realized already nets the open fee).
    recordCloses(rest, [fill], state.balance + p.margin + fill.realized + p.openFee,
      Object.keys(rest).length > 0 ? state.totalExitTargets : undefined)
    return fill
  },
  reset() {
    commit(fresh())
  }
}
