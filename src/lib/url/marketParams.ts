import { createLoader, createParser, parseAsStringLiteral } from "@octanejs/nuqs";
import { defaultSymbol, defaultVenue, normalizeMarketSelection, type MarketSelection } from "@/lib/config/marketSelection";
import { VENUE_CONFIG } from "@/lib/config/venues";
import type { MarketType, Timeframe, ToolProfile, VenueSelection } from "@/lib/types/market";

// ─── URL state ───────────────────────────────────────────────────
//   ?market=spot&symbol=ETHUSDT&venue=okx-spot&tf=15m&ws=liquidity
// Defaults are left out of the URL. `ws` has no default: the workspace is
// also saved per browser, so a link without it keeps the reader's own.

const MARKET_SLUG: Record<MarketType, string> = { perpetual: "perp", spot: "spot", forex: "fx" };
const MARKET_BY_SLUG = new Map(Object.entries(MARKET_SLUG).map(([type, slug]) => [slug, type as MarketType]));

export const TIMEFRAME_VALUES = ["1m", "5m", "15m", "30m", "1h", "4h"] as const satisfies readonly Timeframe[];
export const TOOL_PROFILE_VALUES = ["order-flow", "liquidity", "volatility"] as const satisfies readonly ToolProfile[];
const VENUE_VALUES = [...(Object.keys(VENUE_CONFIG) as VenueSelection[]), "all-perps", "all-spot"] as const;

export const parseAsMarketType = createParser<MarketType>({
  parse: (value) => MARKET_BY_SLUG.get(value.toLowerCase()) ?? null,
  serialize: (value) => MARKET_SLUG[value],
});

/** `EUR/USD` is written as `EUR-USD` so the slash never needs escaping. */
export const parseAsSymbol = createParser<string>({
  parse: (value) => value.toUpperCase().replace("-", "/") || null,
  serialize: (value) => value.replace("/", "-"),
});

export const marketParams = {
  market: parseAsMarketType.withDefault("perpetual"),
  symbol: parseAsSymbol,
  venue: parseAsStringLiteral<VenueSelection>(VENUE_VALUES),
  tf: parseAsStringLiteral(TIMEFRAME_VALUES).withDefault("5m"),
  ws: parseAsStringLiteral(TOOL_PROFILE_VALUES),
};

/** The query values for a selection, with each market's defaults omitted. */
export function toMarketQuery(selection: MarketSelection) {
  return {
    market: selection.marketType,
    symbol: selection.symbol === defaultSymbol(selection.marketType) ? null : selection.symbol,
    venue: selection.venue === defaultVenue(selection.marketType) ? null : selection.venue,
  };
}

const loadMarketParams = createLoader(marketParams);

/** The market a link points at, resolved before the first feed subscription. */
export function loadInitialMarket(search: string): MarketSelection & { timeframe: Timeframe } {
  const query = loadMarketParams(search);
  return {
    ...normalizeMarketSelection({ marketType: query.market, symbol: query.symbol, venue: query.venue }),
    timeframe: query.tf,
  };
}
