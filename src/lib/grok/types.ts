export type AsyncStatus = 'loading' | 'ready' | 'error'

export type OptionalAsyncStatus = AsyncStatus | 'idle'

export interface GrokProfileApiData {
  title: string | null
  factChecked: string | null
  leadHtml: string
  leadText: string
}

export interface GrokProfileApiResponse {
  page: string
  url: string
  data: GrokProfileApiData
}

export interface CompanyPriceClientProps {
  symbol: string
}

export type FinancialMetric = {
  label: string
  value: string
}

export type GrokCacheEntry = {
  error: string | null
  profile: GrokProfileApiResponse | null
  status: OptionalAsyncStatus
}
