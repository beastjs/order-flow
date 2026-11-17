// ============================================================
// PAPER TRADING — simulated isolated-margin perpetual positions.
// Pure math + a tiny persisted store (localStorage, per browser).
// Nothing here touches a real account or exchange.
// ============================================================

export type PaperSide = 'up' | 'down'

export interface PaperPosition {
  instId: string
  side: PaperSide
  /** Margin committed, USDT. */
  margin: number
  leverage: number
  entry: number
  /** Base units (shares / coins). */
  size: number
  openFee: number
  openedAt: number
}

export interface PaperFill {
  instId: string
  side: PaperSide
  leverage: number
  margin: number
  entry: number
  exit: number
  /** Net of both fees; −margin when liquidated. */
  realized: number
  liquidated: boolean
  openedAt: number
  closedAt: number
}

/** OKX-like taker fee and an approximate maintenance margin rate. */
export const TAKER_FEE = 0.0005
export const MAINT_MARGIN = 0.005
export const STARTING_BALANCE = 10_000

const dir = (side: PaperSide) => (side === 'up' ? 1 : -1)

export function openPosition(
  instId: string,
  side: PaperSide,
  margin: number,
  leverage: number,
  entry: number,
  now = Date.now()
): PaperPosition {
  const notional = margin * leverage
  return {
    instId,
    side,
    margin,
    leverage,
    entry,
    size: notional / entry,
    openFee: notional * TAKER_FEE,
    openedAt: now
  }
}

/** Unrealized PnL at `price`, before fees. */
export function unrealizedPnl(p: PaperPosition, price: number): number {
  return dir(p.side) * (price - p.entry) * p.size
}

/** Estimated liquidation price: equity falls to maintenance margin. */
export function liquidationPrice(p: PaperPosition): number {
  const equity0 = p.margin - p.openFee
  if (p.side === 'up') return Math.max(0, (p.entry * p.size - equity0) / (p.size * (1 - MAINT_MARGIN)))
  return (equity0 + p.entry * p.size) / (p.size * (1 + MAINT_MARGIN))
}

export function isLiquidated(p: PaperPosition, mark: number): boolean {
  const liq = liquidationPrice(p)
  return p.side === 'up' ? mark <= liq : mark >= liq
}

export interface PaperMetrics {
  pnl: number
  /** PnL net of the opening fee, as % of margin. */
  roe: number
  notional: number
  liq: number
  /** 0 = at liquidation, 1 = at entry or better. */
  safety: number
}

export function metrics(p: PaperPosition, mark: number): PaperMetrics {
  const pnl = unrealizedPnl(p, mark)
  const liq = liquidationPrice(p)
  const span = Math.abs(p.entry - liq) || 1
  const safety = Math.max(0, Math.min(1, Math.abs(mark - liq) / span))
  return { pnl, roe: ((pnl - p.openFee) / p.margin) * 100, notional: p.size * mark, liq, safety }
}

export function closePosition(p: PaperPosition, exit: number, liquidated = false, now = Date.now()): PaperFill {
  const closeFee = p.size * exit * TAKER_FEE
  const realized = liquidated ? -p.margin : unrealizedPnl(p, exit) - p.openFee - closeFee
  return {
    instId: p.instId,
    side: p.side,
    leverage: p.leverage,
    margin: p.margin,
    entry: p.entry,
    exit,
    realized: Math.max(realized, -p.margin),
    liquidated,
    openedAt: p.openedAt,
    closedAt: now
  }
}

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
  close(instId: string, exit: number, liquidated = false): PaperFill | null {
    const p = state.positions[instId]
    if (!p || !(exit > 0)) return null
    const fill = closePosition(p, exit, liquidated)
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
