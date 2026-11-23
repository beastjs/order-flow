// ============================================================
// PAPER TRADING — browser-local store for the position simulator.
// Math lives in ./math (shared with the Convex backend).
// Nothing here touches a real account or exchange.
// ============================================================

import { STARTING_BALANCE, autoExitReason, closePosition, isLiquidated, liquidationPrice, openPosition, validateExitTargets, type AutoExitReason, type ExitTargets, type PaperFill, type PaperPosition, type PaperSide } from './math'

export * from './math'

// ─── persisted store ─────────────────────────────────────────

export interface PaperState {
  balance: number
  positions: Record<string, PaperPosition>
  history: PaperFill[]
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
      history: [fill, ...state.history].slice(0, 50)
    })
    return fill
  },
  reset() {
    commit(fresh())
  }
}
