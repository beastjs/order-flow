// OKX market data — public + business WebSocket, crypto & stock perps.
//
//   import { okx } from '@/lib/okx'
//   const off = okx.ticker('AAPL-USDT-SWAP', (t) => console.log(t.last))
//   const off2 = okx.candles('BTC-USDT-SWAP', '1m', (c) => ...)   // business ws
//   off(); off2()

import { OkxStream } from './client'
import { okxChannels } from './channels'

export * from './types'
export * from './client'
export * from './channels'
export * from './rest'

/** App-wide shared stream: one public + one business socket. */
export const okxStream = new OkxStream()
export const okx = okxChannels(okxStream)
