// ============================================================
// HYPERLIQUID WEBSOCKET — wire + normalized types
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
// ============================================================

/** Candle intervals accepted by `candle` subscriptions and `candleSnapshot`. */
export type HlInterval =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '8h'
  | '12h'
  | '1d'
  | '3d'
  | '1w'
  | '1M'

/** Public market-data subscriptions (no user address needed). */
export type HlSubscription =
  /** `dex` selects a builder-deployed dex ("xyz"); omitted = main dex. */
  | { type: 'allMids'; dex?: string }
  | { type: 'l2Book'; coin: string }
  | { type: 'trades'; coin: string }
  | { type: 'bbo'; coin: string }
  | { type: 'candle'; coin: string; interval: HlInterval }
  | { type: 'activeAssetCtx'; coin: string }

export type HlSubscriptionType = HlSubscription['type']

/** A raw push frame: `{ channel, data }`. */
export interface HlFrame<T = unknown> {
  channel: string
  data: T
}

export type HlSocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

// ─── wire payloads ──────────────────────────────────────────

export interface HlWireLevel {
  px: string
  sz: string
  n: number
}

export interface HlWireBook {
  coin: string
  time: number
  levels: [HlWireLevel[], HlWireLevel[]]
}

export interface HlWireTrade {
  coin: string
  side: 'A' | 'B'
  px: string
  sz: string
  time: number
  hash: string
  tid: number
  users: [string, string]
}

export interface HlWireCandle {
  t: number
  T: number
  s: string
  i: HlInterval
  o: string
  c: string
  h: string
  l: string
  v: string
  n: number
}

export interface HlWireAssetCtx {
  funding: string
  openInterest: string
  prevDayPx: string
  dayNtlVlm: string
  premium: string | null
  oraclePx: string
  markPx: string
  midPx: string | null
  impactPxs: [string, string] | null
  dayBaseVlm: string
}

// ─── normalized ─────────────────────────────────────────────

export interface HlBookLevel {
  price: number
  /** Size in base units (coins, not contracts). */
  size: number
  orders: number
}

export interface HlBook {
  coin: string
  bids: HlBookLevel[]
  asks: HlBookLevel[]
  ts: number
}

export interface HlBbo {
  coin: string
  bid: HlBookLevel | null
  ask: HlBookLevel | null
  ts: number
}

export interface HlTrade {
  coin: string
  tid: number
  price: number
  size: number
  /** Aggressor side: "B" (bid) lifted the ask → buy. */
  side: 'buy' | 'sell'
  ts: number
  hash: string
  /** [buyer, seller] addresses. */
  users: [string, string]
}

export interface HlCandle {
  /** Open time (ms). */
  ts: number
  closeTs: number
  coin: string
  interval: HlInterval
  open: number
  high: number
  low: number
  close: number
  /** Base volume. */
  vol: number
  trades: number
}

export interface HlAssetCtx {
  coin: string
  markPx: number
  midPx: number | null
  oraclePx: number
  prevDayPx: number
  /** Hourly funding rate (fraction, not %). */
  funding: number
  premium: number | null
  /** Open interest in base units. */
  openInterest: number
  dayNtlVlm: number
  dayBaseVlm: number
  impactPxs: [number, number] | null
  /** Hyperliquid funds hourly, on the hour. */
  nextFundingTime: number
  /** Local receive time (the channel carries no timestamp). */
  ts: number
}

/** Asset class, from Hyperliquid's `perpCategories`. */
export type HlCategory = 'crypto' | 'stock' | 'commodity' | 'fx' | 'index' | 'other'

export interface HlPerpMeta {
  /** Full coin: "BTC" or "xyz:GBP". */
  name: string
  /** Display symbol without the dex prefix: "GBP". */
  base: string
  /** Builder dex ("xyz"), or "" for the main dex. */
  dex: string
  category: HlCategory
  szDecimals: number
  maxLeverage: number
  isDelisted: boolean
}
