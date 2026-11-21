import { GrokCacheEntry, GrokProfileApiResponse } from '@/lib/grok/types'

const grokCache = new Map<string, GrokCacheEntry>()
const grokPromiseCache = new Map<string, Promise<GrokCacheEntry>>()

const readApiError = async (response: Response, fallbackMessage: string) => {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const payload = (await response.json()) as { error?: string }
    return payload.error || fallbackMessage
  }

  return (await response.text()) || fallbackMessage
}
const getGrokipediaHref = (query: string) =>
  `https://grokipedia.com/page/${encodeURIComponent(query.trim().replace(/\s+/g, '_'))}`

const fetchGrokProfile = async (query: string, signal?: AbortSignal) => {
  const response = await fetch(`/api/grok?query=${encodeURIComponent(query)}`, {
    signal
  })

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to load Grokipedia profile'))
  }

  return (await response.json()) as GrokProfileApiResponse
}

export const normalizeCompanySymbol = (value: string) => value.trim().toUpperCase()

export const useGrokipedia = () => {
  const getCachedGrokEntry = (symbol: string) => grokCache.get(normalizeCompanySymbol(symbol))

  const loadGrokCacheEntry = (symbol: string, query: string | null) => {
    const normalizedSymbol = normalizeCompanySymbol(symbol)
    const cachedEntry = grokCache.get(normalizedSymbol)

    if (cachedEntry) {
      return Promise.resolve(cachedEntry)
    }

    const existingPromise = grokPromiseCache.get(normalizedSymbol)

    if (existingPromise) {
      return existingPromise
    }

    if (!query) {
      const idleEntry: GrokCacheEntry = {
        error: null,
        profile: null,
        status: 'idle'
      }

      grokCache.set(normalizedSymbol, idleEntry)
      return Promise.resolve(idleEntry)
    }

    const promise = fetchGrokProfile(query)
      .then(
        (profile) =>
          ({
            error: null,
            profile,
            status: 'ready'
          }) satisfies GrokCacheEntry
      )
      .catch(
        (error) =>
          ({
            error: error instanceof Error ? error.message : 'Unknown error',
            profile: null,
            status: 'error'
          }) satisfies GrokCacheEntry
      )
      .then((entry) => {
        grokCache.set(normalizedSymbol, entry)
        return entry
      })
      .finally(() => {
        grokPromiseCache.delete(normalizedSymbol)
      })

    grokPromiseCache.set(normalizedSymbol, promise)

    return promise
  }
}
