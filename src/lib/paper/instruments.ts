// Keep the venue in paper position keys, including when both exchanges list the same asset.
export const hlPaperId = (coin: string) => `hl:${coin}`

export function hlPaperCoin(instId: string): string | undefined {
  if (/^hl:(?:[a-zA-Z0-9_-]{1,32}:)?[a-zA-Z0-9_.-]{1,32}$/.test(instId)) return instId.slice(3)
}

export function paperAsset(instId: string, base = instId.split('-')[0]) {
  const coin = hlPaperCoin(instId)
  return coin
    ? { assetId: coin, base: coin.slice(coin.lastIndexOf(':') + 1), venue: 'hyperliquid' as const, search: { venue: 'hyperliquid' as const } }
    : { assetId: base, base, venue: 'okx' as const, search: {} }
}
