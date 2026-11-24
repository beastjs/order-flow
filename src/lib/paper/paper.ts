// ============================================================
// PAPER TRADING — browser-local store for the position simulator.
// Math lives in ./math (shared with the Convex backend).
// Nothing here touches a real account or exchange.
// ============================================================

import { STARTING_BALANCE, autoExitReason, closePosition, isLiquidated, liquidationPrice, openPosition, priceTotalExit, totalExitReason, validateExitTargets, validateTotalExitTargets, type AutoExitReason, type ExitQuote, type ExitTargets, type PaperFill, type PaperPosition, type PaperSide } from './math'

export * from './math'

// ─── persisted store ─────────────────────────────────────────

export interface PaperState {
  balance: number
  positions: Record<string, PaperPosition>
  history: PaperFill[]
  totalExitTargets?: ExitTargets
}

const KEY = 'cfx-paper-v1'
const fresh = (): PaperState => ({ balance: STARTING_BALANCE, positions: {}, history: [] })

function load(): PaperState {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
    if (!raw) return fresh()
    const s = JSON.parse(raw) as PaperState
    return Number.isFinite(s.balance) && s.positions && Array.isArray(s.history) ? s : fresh()
  } catch {
    return fresh()
  }
}

let state: PaperState = load()
const listeners = new Set<() => void>()

function commit(next: PaperState) {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode / quota: keep in memory */
  }
  listeners.forEach((fn) => fn())
}

if (typeof window !== 'undefined') {
  // Keep tabs in sync.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      state = load()
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
    if (state.positions[instId]) return 'Close the open position first.'
    if (!(margin > 0)) return 'Enter an amount.'
    if (!(entry > 0)) return 'Waiting for a price.'
    const p = openPosition(instId, side, margin, leverage, entry)
    if (margin + p.openFee > state.balance + 1e-9) return 'Not enough paper balance.'
    commit({
      ...state,
      balance: state.balance - margin - p.openFee,
      positions: { ...state.positions, [instId]: p }
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
    commit({ balance, positions: {}, history: [...fills, ...state.history].slice(0, 50) })
  },
  checkExitTargets(instId: string, mark: number, quote: { bid?: number; ask?: number }): void {
    const position = state.positions[instId]
    if (!position?.exitTargets || !Number.isFinite(mark) || mark <= 0) return
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
    commit({
      balance: state.balance + p.margin + fill.realized + p.openFee,
      positions: rest,
      history: [fill, ...state.history].slice(0, 50),
      totalExitTargets: Object.keys(rest).length > 0 ? state.totalExitTargets : undefined
    })
    return fill
  },
  reset() {
    commit(fresh())
  }
}
