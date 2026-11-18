import { parseAsString, parseAsStringLiteral } from '@octanejs/nuqs'

// ─── /perps toolbar URL state ────────────────────────────────────
//   /perps?venue=hyperliquid&cat=fx&sort=gainers&q=gbp
// Defaults are left out of the URL (nuqs clearOnDefault).

export const PERPS_VENUES = ['okx', 'hyperliquid'] as const
export const PERPS_FILTERS = ['all', 'crypto', 'stock', 'commodity', 'fx', 'index', 'other'] as const
export const PERPS_SORTS = ['volume', 'gainers', 'losers', 'name'] as const

export type PerpsFilter = (typeof PERPS_FILTERS)[number]
export type PerpsSort = (typeof PERPS_SORTS)[number]

export const perpsParams = {
  venue: parseAsStringLiteral(PERPS_VENUES).withDefault('okx'),
  cat: parseAsStringLiteral(PERPS_FILTERS).withDefault('all'),
  sort: parseAsStringLiteral(PERPS_SORTS).withDefault('volume'),
  q: parseAsString.withDefault('')
}
