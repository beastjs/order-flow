import { applyLevelZScores, applyTradeToCandle, applyZScores, computeVolumeProfile, createEmptyCandle, ProfileAccumulator } from "@/lib/engine/orderFlowEngine";
import { MarketDataManager } from "@/lib/managers/marketDataManager";
import { createTerminalStore } from "@/lib/store/terminalStore";
import type { FootprintCandle, NormalizedOrderBook, NormalizedTrade } from "@/lib/types/market";

const trade = (id: number, price: number, quantity: number, side: "buy" | "sell", timestamp: number): NormalizedTrade => ({
  id: `t${id}`, venue: "bybit-futures", symbol: "BTCUSDT", timestamp, localTimestamp: timestamp,
  price, quantity, quoteVolume: price * quantity, side, marketType: "perpetual",
});

function candles(count: number): FootprintCandle[] {
  const out: FootprintCandle[] = [];
  let id = 0;
  for (let c = 0; c < count; c++) {
    let candle = createEmptyCandle(c * 60_000, "1m");
    for (let i = 0; i < 12; i++) {
      const price = 100 + ((c * 7 + i * 3) % 15);
      candle = applyTradeToCandle(candle, trade(id++, price, 1 + ((c + i) % 5), i % 2 ? "buy" : "sell", c * 60_000 + i * 1000), 1, 3);
    }
    out.push(candle);
  }
  return out;
}

describe("ProfileAccumulator", () => {
  it("matches a full recompute as candles close and age out", () => {
    const all = candles(8);
    const accumulator = new ProfileAccumulator();
    const window: FootprintCandle[] = [];
    for (const candle of all.slice(0, 7)) {
      accumulator.add(candle);
      window.push(candle);
      if (window.length > 4) accumulator.remove(window.shift()!);
    }
    const live = all[7];
    expect(accumulator.profile(live, 0.7)).toEqual(computeVolumeProfile([...window, live], 0.7));
    expect(accumulator.profile(null, 0.8)).toEqual(computeVolumeProfile(window, 0.8));
  });
});

describe("level z-scores", () => {
  it("scores from running sums the same as from the level list", () => {
    const [a, b, c] = candles(3);
    const levels = [...a.levels.values(), ...b.levels.values()];
    const expected = structuredClone(c);
    applyZScores(expected, levels);
    const sum = levels.reduce((s, l) => s + l.totalVolume, 0);
    const sumSq = levels.reduce((s, l) => s + l.totalVolume ** 2, 0);
    const mean = sum / levels.length;
    applyLevelZScores(c, mean, Math.sqrt(sumSq / levels.length - mean * mean));
    for (const [price, level] of c.levels) {
      expect(level.zScore).toBeCloseTo(expected.levels.get(price)!.zScore, 9);
      // A score sitting exactly on the threshold can round either way.
      if (Math.abs(level.zScore - 2) > 1e-6) expect(level.isHighVolume).toBe(expected.levels.get(price)!.isHighVolume);
    }
  });
});

describe("MarketDataManager flush", () => {
  const replay = () => {
    const store = createTerminalStore();
    const manager = new MarketDataManager(store);
    manager.beginReplay({ venue: "bybit-futures", symbol: "BTCUSDT", marketType: "perpetual", timeframe: "1m", imbalanceThreshold: 3, selectedVenues: ["bybit-futures"] }, 0);
    return { store, manager };
  };
  const book = (timestamp: number): NormalizedOrderBook => ({
    venue: "bybit-futures", symbol: "BTCUSDT", timestamp, localTimestamp: timestamp,
    bids: [{ price: 99, size: 3 }], asks: [{ price: 101, size: 1 }],
  } as NormalizedOrderBook);

  it("publishes candle, ticker, session and profile for the prints in a flush", () => {
    const { store, manager } = replay();
    manager.ingest("t", trade(1, 100, 2, "buy", 1000), 1000);
    manager.ingest("t", trade(2, 101, 1, "sell", 1500), 1500);
    manager.flushNow();
    const s = store.getState();
    expect(s.currentCandle?.volume).toBe(3);
    expect(s.ticker?.price).toBe(101);
    expect(s.session?.trades).toBe(2);
    expect(s.volumeProfile?.totalVolume).toBe(3);
    expect(s.liveBar?.volume).toBe(3);
    manager.disconnect();
  });

  it("aggregates the book once per flush and leaves print state untouched", () => {
    const { store, manager } = replay();
    manager.ingest("t", trade(1, 100, 2, "buy", 1000), 1000);
    manager.flushNow();
    const before = store.getState();
    manager.ingest("b", book(1100), 1100);
    manager.ingest("b", book(1200), 1200);
    manager.flushNow();
    const after = store.getState();
    expect(after.aggregatedBook?.midPrice).toBe(100);
    expect(after.obiHistory).toHaveLength(1);
    expect(after.obiHistory[0].timestamp).toBe(1200);
    expect(after.currentOBI).toBe(0.5);
    // A book-only flush keeps the print-driven objects' identity.
    expect(after.session).toBe(before.session);
    expect(after.liveBar).toBe(before.liveBar);
    expect(after.currentCandle).toBe(before.currentCandle);
    expect(after.ticker).toBe(before.ticker);
    manager.disconnect();
  });

  it("keeps the session profile across a candle close", () => {
    const { store, manager } = replay();
    manager.ingest("t", trade(1, 100, 2, "buy", 1000), 1000);
    manager.ingest("t", trade(2, 102, 4, "sell", 61_000), 61_000);
    manager.flushNow();
    const s = store.getState();
    expect(s.candles).toHaveLength(1);
    expect(s.volumeProfile).toEqual(computeVolumeProfile([...s.candles, s.currentCandle!], s.valueAreaPct));
    expect(s.volumeProfile?.totalVolume).toBe(6);
    manager.disconnect();
  });
});
