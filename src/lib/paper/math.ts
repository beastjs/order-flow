// ============================================================
// PAPER TRADING MATH — simulated isolated-margin perpetuals.
// Pure functions only (no DOM, no storage): shared by the browser
// simulator (paper.ts) and the Convex backend (convex/positions.ts).
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
  /** Net of both fees; −(margin + open fee) when liquidated. */
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
  const closeFee = liquidated ? 0 : p.size * exit * TAKER_FEE
  // Everything committed (margin + opening fee) is the most a position can lose.
  const floor = -(p.margin + p.openFee)
  const realized = liquidated ? floor : unrealizedPnl(p, exit) - p.openFee - closeFee
  return {
    instId: p.instId,
    side: p.side,
    leverage: p.leverage,
    margin: p.margin,
    entry: p.entry,
    exit,
    realized: Math.max(realized, floor),
    liquidated,
    openedAt: p.openedAt,
    closedAt: now
  }
}
