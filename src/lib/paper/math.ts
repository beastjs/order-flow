// ============================================================
// PAPER TRADING MATH — simulated isolated-margin perpetuals.
// Pure functions only (no DOM, no storage): shared by the browser
// simulator (paper.ts) and the Convex backend (convex/positions.ts).
// ============================================================

import { hlPaperCoin } from './instruments'

export type PaperSide = 'up' | 'down'
export const autoExitLabels = {
  stop_loss: 'Stop loss',
  take_profit: 'Take profit',
  total_stop_loss: 'Total stop loss',
  total_take_profit: 'Total take profit'
} as const
export type AutoExitReason = keyof typeof autoExitLabels

export interface ExitTargets {
  stopLoss: number | null
  takeProfit: number | null
}

export const followUpCriteria = [
  { code: 'NL', label: 'Net loss' },
  { code: 'NP', label: 'Net profit' },
  { code: 'TP', label: 'Take profit' },
  { code: 'SL', label: 'Stop loss' },
  { code: 'LQ', label: 'Liquidation' },
  { code: 'CL', label: 'Manual close' }
] as const
export type FollowUpCriterion = (typeof followUpCriteria)[number]['code']

const autoExitCriteria = {
  stop_loss: 'SL',
  take_profit: 'TP',
  total_stop_loss: 'SL',
  total_take_profit: 'TP'
} satisfies Record<AutoExitReason, FollowUpCriterion>

export interface FollowUpOrder {
  instId: string
  side: PaperSide
  margin: number
  leverage: number
  exitTargets: ExitTargets
  criteria?: FollowUpCriterion[]
}

export type FollowUpResult = { status: 'pending' } | { status: 'opened' } | { status: 'skipped' } | { status: 'failed'; error: string }

export interface ExitQuote {
  bid?: number
  ask?: number
  mark?: number
}

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
  exitTargets?: ExitTargets
  followUpOrder?: FollowUpOrder
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
  exitTargets?: ExitTargets
  autoExitReason?: AutoExitReason
  followUpOrder?: FollowUpOrder
  followUpResult?: FollowUpResult
  openedAt: number
  closedAt: number
}

/** OKX-like taker fee and an approximate maintenance margin rate. */
export const TAKER_FEE = 0.0005
export const MAINT_MARGIN = 0.005
export const STARTING_BALANCE = 10_000
export const MAX_PAPER_MARGIN = 1_000_000

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

/** Mark-price PnL after the opening fee and estimated fee at the exit quote. */
export function estimateClosePnl(p: PaperPosition, markPnl: number, exit?: number): number {
  return markPnl - p.openFee - p.size * (exit ?? 0) * TAKER_FEE
}

export function netPnlAtExit(p: PaperPosition, exit: number): number {
  return estimateClosePnl(p, unrealizedPnl(p, exit), exit)
}

/** Invert the fee-inclusive exit PnL for either direction. */
export function exitPriceForPnl(p: Pick<PaperPosition, 'side' | 'entry' | 'size' | 'openFee'>, pnl: number): number {
  const direction = dir(p.side)
  return (direction * p.entry + (pnl + p.openFee) / p.size) / (direction - TAKER_FEE)
}

export function validateExitTargets(p: PaperPosition, { stopLoss, takeProfit }: ExitTargets): string | null {
  if (stopLoss !== null) {
    const price = exitPriceForPnl(p, stopLoss)
    if (!Number.isFinite(price) || price <= 0 || stopLoss >= 0 || isLiquidated(p, price))
      return 'Enter a negative stop loss with a trigger price before liquidation.'
  }
  if (takeProfit !== null) {
    const price = exitPriceForPnl(p, takeProfit)
    if (!Number.isFinite(price) || price <= 0 || takeProfit <= 0)
      return 'Enter a positive take profit with a valid trigger price.'
  }
  return null
}

export function validateFollowUpOrder(order: FollowUpOrder, maxLeverage?: number): string | null {
  if (!hlPaperCoin(order.instId) && !/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(order.instId)) return 'Choose a supported perpetual.'
  if (!Number.isFinite(order.margin) || order.margin <= 0 || order.margin > MAX_PAPER_MARGIN) return 'Enter a valid amount.'
  if (!Number.isSafeInteger(order.leverage) || order.leverage < 1) return 'Enter a whole-number multiplier of at least 1×.'
  if (maxLeverage !== undefined && order.leverage > maxLeverage) return `The maximum multiplier is ${maxLeverage}×.`
  if (order.criteria && (order.criteria.length > followUpCriteria.length || new Set(order.criteria).size !== order.criteria.length)) {
    return 'Choose each close criterion only once.'
  }
  // Dollar targets scale with notional, so their validity is independent of the entry price.
  const position = openPosition(order.instId, order.side, order.margin, order.leverage, 1, 0)
  return validateExitTargets(position, order.exitTargets)
}

function targetReached({ stopLoss, takeProfit }: ExitTargets, pnl: number) {
  if (stopLoss !== null && pnl <= stopLoss) return 'stop_loss'
  if (takeProfit !== null && pnl >= takeProfit) return 'take_profit'
  return null
}

export function autoExitReason(p: PaperPosition, exit: number): AutoExitReason | null {
  if (!p.exitTargets || !isPrice(exit)) return null
  return targetReached(p.exitTargets, netPnlAtExit(p, exit))
}

export function validateTotalExitTargets({ stopLoss, takeProfit }: ExitTargets): string | null {
  if (stopLoss !== null && (!Number.isFinite(stopLoss) || stopLoss >= 0)) return 'Enter a negative stop loss.'
  if (takeProfit !== null && (!Number.isFinite(takeProfit) || takeProfit <= 0)) return 'Enter a positive take profit.'
  return null
}

export function totalExitReason(targets: ExitTargets, pnl: number): AutoExitReason | null {
  const reason = targetReached(targets, pnl)
  return reason === null ? null : `total_${reason}`
}

function isPrice(price: number | undefined): price is number {
  return price !== undefined && Number.isFinite(price) && price > 0
}

/** Price the entire basket using executable sides and the same fees and loss cap as settlement. */
export function priceTotalExit<P extends PaperPosition>(positions: Iterable<P>, getQuote: (instId: string) => ExitQuote | undefined) {
  const exits: { position: P; exit: number; liquidated: boolean }[] = []
  let pnl = 0
  for (const position of positions) {
    const quote = getQuote(position.instId)
    if (!isPrice(quote?.mark)) return null
    const liquidated = isLiquidated(position, quote.mark)
    const exit = liquidated ? liquidationPrice(position) : position.side === 'up' ? quote.bid : quote.ask
    if (!isPrice(exit)) return null
    pnl += realizedPnl(position, exit, liquidated)
    exits.push({ position, exit, liquidated })
  }
  return exits.length > 0 && Number.isFinite(pnl) ? { pnl, exits } : null
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

function realizedPnl(p: PaperPosition, exit: number, liquidated: boolean): number {
  // Everything committed (margin + opening fee) is the most a position can lose.
  const floor = -(p.margin + p.openFee)
  return liquidated ? floor : Math.max(netPnlAtExit(p, exit), floor)
}

function matchesFollowUp(criteria: FollowUpCriterion[] | undefined, realized: number, liquidated: boolean, reason?: AutoExitReason): boolean {
  if (!criteria?.length) return true
  const closeCriterion = liquidated ? 'LQ' : reason ? autoExitCriteria[reason] : 'CL'
  return criteria.includes(closeCriterion) || (realized < 0 && criteria.includes('NL')) || (realized > 0 && criteria.includes('NP'))
}

export function closePosition(p: PaperPosition, exit: number, liquidated = false, now = Date.now(), reason?: AutoExitReason): PaperFill {
  const realized = realizedPnl(p, exit, liquidated)
  const followUpOrder = p.followUpOrder
  return {
    instId: p.instId,
    side: p.side,
    leverage: p.leverage,
    margin: p.margin,
    entry: p.entry,
    exit,
    realized,
    liquidated,
    openedAt: p.openedAt,
    closedAt: now,
    ...(p.exitTargets && { exitTargets: { ...p.exitTargets } }),
    ...(reason && !liquidated && { autoExitReason: reason }),
    ...(followUpOrder && {
      followUpOrder,
      followUpResult: { status: matchesFollowUp(followUpOrder.criteria, realized, liquidated, reason) ? 'pending' : 'skipped' }
    })
  }
}
