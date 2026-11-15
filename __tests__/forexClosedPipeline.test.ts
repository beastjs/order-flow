import { FinnhubForexAdapter, MARKET_CLOSED_FLAG } from "@/lib/adapters/forex";

// Same order as the real pool: the adapter connects before it is handed over.
// (Mocked here because other suites replace the pool with event-only fakes.)
jest.mock("@/lib/session/adapterPool", () => ({
  acquireAdapter: (_venue: string, symbol: string) => {
    const adapter = new FinnhubForexAdapter(symbol);
    adapter.connect();
    return adapter;
  },
  releaseAdapter: () => undefined,
}));

import { MarketDataManager } from "@/lib/managers/marketDataManager";
import { createTerminalStore } from "@/lib/store/terminalStore";

// The adapter reports "closed" synchronously inside connect(), before the
// manager has attached its status listener, so the manager must pick up the
// status the adapter already has.
describe("forex closed-market status", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-11-15T08:30:00.000Z")); // Sunday 03:30 New York
  });
  afterEach(() => jest.useRealTimers());

  it("reaches the store when the market is closed at subscribe time", () => {
    const store = createTerminalStore();
    const manager = new MarketDataManager(store);
    manager.subscribe("finnhub-forex", "EUR/USD", "forex", "5m", 0.0001, 3, ["finnhub-forex"]);
    jest.advanceTimersByTime(200);
    expect(store.getState().connections["finnhub-forex"]?.stateFlag).toBe(MARKET_CLOSED_FLAG);
    manager.disconnect();
  });
});
