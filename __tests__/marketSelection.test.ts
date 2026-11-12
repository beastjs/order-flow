import { normalizeMarketSelection } from "@/lib/config/marketSelection";
import { loadInitialMarket, marketParams, parseAsMarketType, parseAsSymbol, toMarketQuery } from "@/lib/url/marketParams";
import { createTerminalStore } from "@/lib/store/terminalStore";
import { isParserBijective } from "@octanejs/nuqs/testing";

describe("normalizeMarketSelection", () => {
  it("keeps a valid selection as it is", () => {
    expect(normalizeMarketSelection({ marketType: "spot", symbol: "ETHUSDT", venue: "okx-spot" })).toEqual({
      marketType: "spot",
      symbol: "ETHUSDT",
      venue: "okx-spot",
      selectedVenues: ["okx-spot"],
    });
  });

  it("fills in each market's defaults", () => {
    expect(normalizeMarketSelection({ marketType: "perpetual" })).toMatchObject({ symbol: "BTCUSDT", venue: "bybit-futures" });
    expect(normalizeMarketSelection({ marketType: "spot" })).toMatchObject({ symbol: "BTCUSDT", venue: "bybit-spot" });
    expect(normalizeMarketSelection({ marketType: "forex" })).toEqual({
      marketType: "forex",
      symbol: "EUR/USD",
      venue: "finnhub-forex",
      selectedVenues: ["finnhub-forex"],
    });
  });

  it("replaces an instrument the market doesn't have", () => {
    expect(normalizeMarketSelection({ marketType: "perpetual", symbol: "NOPEUSDT" }).symbol).toBe("BTCUSDT");
    expect(normalizeMarketSelection({ marketType: "forex", symbol: "BTCUSDT", venue: "bybit-futures" })).toMatchObject({
      symbol: "EUR/USD",
      venue: "finnhub-forex",
    });
    expect(normalizeMarketSelection({ marketType: "spot", symbol: "EUR/USD", venue: "finnhub-forex" })).toMatchObject({
      symbol: "BTCUSDT",
      venue: "bybit-spot",
    });
  });

  it("moves a venue from another market to the market default", () => {
    expect(normalizeMarketSelection({ marketType: "perpetual", symbol: "ETHUSDT", venue: "okx-spot" }).venue).toBe("bybit-futures");
    expect(normalizeMarketSelection({ marketType: "spot", symbol: "ETHUSDT", venue: "all-perps" }).venue).toBe("bybit-spot");
  });

  it("falls back to the first exchange listing the coin", () => {
    // Deribit lists BTC and ETH perpetuals only.
    expect(normalizeMarketSelection({ marketType: "perpetual", symbol: "SOLUSDT", venue: "deribit" })).toMatchObject({
      venue: "binance-futures",
      selectedVenues: ["binance-futures"],
    });
  });

  it("expands an aggregate to the exchanges listing the coin", () => {
    const btc = normalizeMarketSelection({ marketType: "perpetual", symbol: "BTCUSDT", venue: "all-perps" });
    const sol = normalizeMarketSelection({ marketType: "perpetual", symbol: "SOLUSDT", venue: "all-perps" });
    expect(btc.venue).toBe("all-perps");
    expect(btc.selectedVenues).toContain("deribit");
    expect(sol.selectedVenues).not.toContain("deribit");
    expect(sol.selectedVenues.length).toBe(btc.selectedVenues.length - 1);
  });
});

describe("market URL params", () => {
  it("round-trips every value", () => {
    for (const market of ["perpetual", "spot", "forex"] as const) expect(isParserBijective(parseAsMarketType, market === "perpetual" ? "perp" : market === "forex" ? "fx" : "spot", market)).toBe(true);
    expect(isParserBijective(parseAsSymbol, "EUR-USD", "EUR/USD")).toBe(true);
    expect(isParserBijective(parseAsSymbol, "BTCUSDT", "BTCUSDT")).toBe(true);
    expect(isParserBijective(marketParams.venue, "all-spot", "all-spot")).toBe(true);
    expect(isParserBijective(marketParams.tf, "4h", "4h")).toBe(true);
    expect(isParserBijective(marketParams.ws, "liquidity", "liquidity")).toBe(true);
  });

  it("rejects values it doesn't know", () => {
    expect(parseAsMarketType.parse("options")).toBeNull();
    expect(marketParams.venue.parse("nasdaq")).toBeNull();
    expect(marketParams.tf.parse("2h")).toBeNull();
  });

  it("resolves a link before the first subscription", () => {
    expect(loadInitialMarket("?market=spot&symbol=ETHUSDT&venue=okx-spot&tf=15m")).toEqual({
      marketType: "spot",
      symbol: "ETHUSDT",
      venue: "okx-spot",
      selectedVenues: ["okx-spot"],
      timeframe: "15m",
    });
    expect(loadInitialMarket("")).toMatchObject({ marketType: "perpetual", symbol: "BTCUSDT", venue: "bybit-futures", timeframe: "5m" });
    expect(loadInitialMarket("?market=fx&symbol=usd-jpy")).toMatchObject({ marketType: "forex", symbol: "USD/JPY" });
    expect(loadInitialMarket("?venue=okx-spot&tf=bogus")).toMatchObject({ venue: "bybit-futures", timeframe: "5m" });
  });

  it("leaves defaults out of the URL", () => {
    expect(toMarketQuery(normalizeMarketSelection({ marketType: "perpetual" }))).toEqual({ market: "perpetual", symbol: null, venue: null });
    expect(toMarketQuery(normalizeMarketSelection({ marketType: "forex" }))).toEqual({ market: "forex", symbol: null, venue: null });
    expect(toMarketQuery(normalizeMarketSelection({ marketType: "spot", symbol: "ETHUSDT", venue: "all-spot" }))).toEqual({
      market: "spot",
      symbol: "ETHUSDT",
      venue: "all-spot",
    });
  });
});

describe("terminal store market", () => {
  it("starts from the linked market", () => {
    const store = createTerminalStore(loadInitialMarket("?venue=all-perps&symbol=SOLUSDT"));
    const s = store.getState();
    expect(s.symbol).toBe("SOLUSDT");
    expect(s.venue).toBe("all-perps");
    expect(s.orderBookMode).toBe("aggregated");
    expect(s.selectedVenues).not.toContain("deribit");
  });

  it("applies a selection in one update and ignores a repeat", () => {
    const store = createTerminalStore();
    let updates = 0;
    store.subscribe(() => updates++);
    const selection = normalizeMarketSelection({ marketType: "spot", symbol: "ETHUSDT", venue: "all-spot" });
    store.getState().setMarket({ ...selection, timeframe: "1h" });
    expect(updates).toBe(1);
    expect(store.getState()).toMatchObject({ marketType: "spot", symbol: "ETHUSDT", venue: "all-spot", timeframe: "1h", orderBookMode: "aggregated" });
    store.getState().setMarket({ ...selection, timeframe: "1h" });
    expect(updates).toBe(1);
  });

  it("keeps the chosen book when only the instrument changes", () => {
    const store = createTerminalStore(loadInitialMarket("?venue=all-perps"));
    store.getState().setOrderBookMode("single");
    store.getState().setMarket(normalizeMarketSelection({ marketType: "perpetual", symbol: "ETHUSDT", venue: "all-perps" }));
    expect(store.getState().orderBookMode).toBe("single");
  });
});
