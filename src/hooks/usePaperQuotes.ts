import { useHlAssetCtxs, useHlBbos } from './useHyperliquid'
import { useOkxMarkPrices, useOkxTickers } from './useOkx'
import { hlPaperCoin } from '@/lib/paper/instruments'

export function usePaperQuotes(instIds: readonly string[], throttleMs: number) {
  const ids = [...new Set(instIds)].sort()
  const coins = ids.flatMap((id) => hlPaperCoin(id) ?? [])
  const okxIds = ids.filter((id) => !hlPaperCoin(id))
  const tickers = useOkxTickers(okxIds, throttleMs)
  const marks = useOkxMarkPrices(okxIds, throttleMs)
  const books = useHlBbos(coins, throttleMs)
  const contexts = useHlAssetCtxs(coins, throttleMs)

  return (id: string) => {
    const coin = hlPaperCoin(id)
    if (coin) {
      const book = books[coin]
      return { mark: contexts[coin]?.markPx, bid: book?.bid?.price, ask: book?.ask?.price, last: undefined }
    }
    const ticker = tickers[id]
    return { mark: marks[id], bid: ticker?.bidPx, ask: ticker?.askPx, last: ticker?.last }
  }
}
