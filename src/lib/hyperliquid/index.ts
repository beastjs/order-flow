// Hyperliquid market data — wss://api.hyperliquid.xyz/ws, perps.
//
//   import { hl } from '@/lib/hyperliquid'
//   const off = hl.assetCtx('BTC', (c) => console.log(c.markPx, c.funding))
//   const off2 = hl.candles('ETH', '1m', (c) => ...)
//   off(); off2()

import { HlStream } from './client'
import { hlChannels } from './channels'

export * from './types'
export * from './client'
export * from './channels'
export * from './rest'

/** App-wide shared stream: one socket. */
export const hlStream = new HlStream()
export const hl = hlChannels(hlStream)
