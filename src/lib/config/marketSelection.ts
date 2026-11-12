import { venueSupports, venuesForSelection } from "@/lib/adapters/capabilities";
import { CRYPTO_SYMBOLS } from "@/lib/config/instruments";
import { FOREX_SYMBOLS } from "@/lib/config/venues";
import type { MarketType, Venue, VenueSelection } from "@/lib/types/market";

// ─── Market selection ────────────────────────────────────────────
// One place that turns a requested market / instrument / venue — from a
// topbar control or a shared link — into a combination that exists.

export interface MarketSelectionInput {
  marketType: MarketType;
  symbol?: string | null;
  venue?: VenueSelection | null;
}

export interface MarketSelection {
  marketType: MarketType;
  symbol: string;
  venue: VenueSelection;
  selectedVenues: Venue[];
}

const DEFAULT_SYMBOL: Record<MarketType, string> = {
  perpetual: "BTCUSDT",
  spot: "BTCUSDT",
  forex: "EUR/USD",
};

const DEFAULT_VENUE: Record<MarketType, Venue> = {
  perpetual: "bybit-futures",
  spot: "bybit-spot",
  forex: "finnhub-forex",
};

export function defaultSymbol(marketType: MarketType): string {
  return DEFAULT_SYMBOL[marketType];
}

export function defaultVenue(marketType: MarketType): Venue {
  return DEFAULT_VENUE[marketType];
}

export function aggregateVenue(marketType: MarketType): VenueSelection | null {
  return marketType === "perpetual" ? "all-perps" : marketType === "spot" ? "all-spot" : null;
}

function resolveSymbol(marketType: MarketType, symbol: string | null | undefined): string {
  const requested = (symbol ?? "").toUpperCase();
  const known: readonly string[] = marketType === "forex" ? FOREX_SYMBOLS : CRYPTO_SYMBOLS;
  return known.includes(requested) ? requested : DEFAULT_SYMBOL[marketType];
}

export function normalizeMarketSelection(input: MarketSelectionInput): MarketSelection {
  const { marketType } = input;
  const symbol = resolveSymbol(marketType, input.symbol);
  const aggregate = aggregateVenue(marketType);

  if (!aggregate) {
    const venue = DEFAULT_VENUE[marketType];
    return { marketType, symbol, venue, selectedVenues: [venue] };
  }

  // Every exchange of this market that lists the instrument, in display order.
  const listed = venuesForSelection(aggregate, marketType, symbol);
  const requested = input.venue ?? DEFAULT_VENUE[marketType];

  if (requested === aggregate) {
    return { marketType, symbol, venue: aggregate, selectedVenues: listed };
  }
  if (requested !== "all-perps" && requested !== "all-spot" && venueSupports(requested, symbol, marketType)) {
    return { marketType, symbol, venue: requested, selectedVenues: [requested] };
  }

  // An exchange of this market that doesn't list the coin falls back to the
  // first one that does; a venue from another market falls back to the default.
  const sameMarket = venuesForSelection(aggregate, marketType, DEFAULT_SYMBOL[marketType]).includes(requested as Venue);
  const preferred = DEFAULT_VENUE[marketType];
  const venue = !sameMarket && listed.includes(preferred) ? preferred : listed[0] ?? preferred;
  return { marketType, symbol, venue, selectedVenues: [venue] };
}
