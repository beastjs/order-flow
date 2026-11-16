// ============================================================
// OKX V5 WEBSOCKET — wire + normalized types
// Docs: https://www.okx.com/docs-v5/en/#overview-websocket
// ============================================================

/** OKX splits its public market data across two endpoints. */
export type OkxEndpoint = 'public' | 'business'

export type OkxInstType = 'SPOT' | 'MARGIN' | 'SWAP' | 'FUTURES' | 'OPTION' | 'ANY'

/** Candle bar sizes accepted by the business `candle*` channels. */
export type OkxBar =
  | '1s'
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1H'
  | '2H'
  | '4H'
  | '6H'
  | '12H'
  | '1D'
  | '2D'
  | '3D'
  | '1W'
  | '1M'
  | '3M'
  | '6Hutc'
  | '12Hutc'
  | '1Dutc'
  | '2Dutc'
  | '3Dutc'
  | '1Wutc'
  | '1Mutc'
  | '3Mutc'

/** Channels served by wss://ws.okx.com/ws/v5/public */
export type OkxPublicChannel =
  | 'tickers'
  | 'trades'
  | 'books'
  | 'books5'
  | 'bbo-tbt'
  | 'funding-rate'
  | 'mark-price'
  | 'open-interest'
  | 'index-tickers'
  | 'price-limit'
  | 'liquidation-orders'
  | 'estimated-price'

/** Channels served by wss://ws.okx.com/ws/v5/business */
export type OkxBusinessChannel =
  | 'trades-all'
  | `candle${OkxBar}`
  | `mark-price-candle${OkxBar}`
  | `index-candle${OkxBar}`

export type OkxChannel = OkxPublicChannel | OkxBusinessChannel

export interface OkxSubscriptionArg {
  channel: OkxChannel
  instId?: string
  instType?: OkxInstType
  instFamily?: string
}

/** A raw push frame: `{ arg, action?, data }`. */
export interface OkxPush<T = unknown> {
  arg: OkxSubscriptionArg
  action?: 'snapshot' | 'update'
  data: T[]
}

export interface OkxEventFrame {
  event: 'subscribe' | 'unsubscribe' | 'error' | 'notice' | 'channel-conn-count' | 'channel-conn-count-error'
  arg?: OkxSubscriptionArg
  code?: string
  msg?: string
  connId?: string
}

export type OkxSocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

// ----------------------------------------------------------
// Normalized payloads (numbers parsed; timestamps in ms)
// Sizes on SWAP instruments are in CONTRACTS — multiply by the
// instrument's ctVal for base units (stock perps use ctVal = 1).
// ----------------------------------------------------------

export interface OkxTicker {
  instId: string
  last: number
  lastSz: number
  bidPx: number
  bidSz: number
  askPx: number
  askSz: number
  open24h: number
  high24h: number
  low24h: number
  /** Open at 00:00 UTC — the usual "today" reference for % change. */
  sodUtc0: number
  sodUtc8: number
  /** 24h volume in contracts. */
  vol24h: number
  /** 24h volume in base currency (shares for stock perps). */
  volCcy24h: number
  ts: number
}

export interface OkxTrade {
  instId: string
  tradeId: string
  price: number
  /** Contracts. */
  size: number
  side: 'buy' | 'sell'
  ts: number
  /** Number of fills aggregated into this print (public `trades` only). */
  count?: number
}

export interface OkxCandle {
  /** Bar open time (ms). */
  ts: number
  open: number
  high: number
  low: number
  close: number
  /** Volume in contracts (0 for mark/index candles). */
  vol: number
  /** Volume in base currency. */
  volCcy: number
  /** Volume in quote currency. */
  volQuote: number
  /** false while the bar is still forming. */
  confirmed: boolean
}

export interface OkxBookLevel {
  price: number
  /** Contracts. */
  size: number
  orders: number
}

export interface OkxBook {
  instId: string
  bids: OkxBookLevel[]
  asks: OkxBookLevel[]
  ts: number
  seqId?: number
}

export interface OkxFundingRate {
  instId: string
  fundingRate: number
  /** Settlement time of the current funding period (ms). */
  fundingTime: number
  nextFundingTime: number
  nextFundingRate?: number
  minFundingRate?: number
  maxFundingRate?: number
  ts: number
}

export interface OkxMarkPrice {
  instId: string
  markPx: number
  ts: number
}

export interface OkxOpenInterest {
  instId: string
  /** Contracts. */
  oi: number
  /** Base currency. */
  oiCcy: number
  oiUsd: number
  ts: number
}

export interface OkxIndexTicker {
  instId: string
  idxPx: number
  open24h: number
  high24h: number
  low24h: number
  sodUtc0: number
  sodUtc8: number
  ts: number
}

export interface OkxPriceLimit {
  instId: string
  buyLmt: number
  sellLmt: number
  enabled: boolean
  ts: number
}

export interface OkxLiquidation {
  instId: string
  instFamily: string
  side: 'buy' | 'sell'
  posSide: 'long' | 'short' | 'net'
  /** Bankruptcy price. */
  bkPx: number
  /** Contracts. */
  size: number
  ts: number
}
