import { HlStream, frameKey, hlCategory, hlChannels, hlChangePct, hlTickSz, splitHlCoin, subKey, toHlCoin, type HlAssetCtx, type HlCandle, type HlTrade } from "@/lib/hyperliquid";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeWS.instances.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  push(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  ops() { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.method !== "ping"); }
}

function setup() {
  FakeWS.instances = [];
  const stream = new HlStream({ WebSocketImpl: FakeWS as unknown as new (url: string) => WebSocket });
  return { stream, ch: hlChannels(stream) };
}

describe("hyperliquid routing", () => {
  it("keys pushes back to their subscription", () => {
    expect(frameKey({ channel: "l2Book", data: { coin: "BTC" } })).toBe(subKey({ type: "l2Book", coin: "BTC" }));
    expect(frameKey({ channel: "trades", data: [{ coin: "ETH" }] })).toBe(subKey({ type: "trades", coin: "ETH" }));
    expect(frameKey({ channel: "candle", data: { s: "SOL", i: "1m" } })).toBe(subKey({ type: "candle", coin: "SOL", interval: "1m" }));
    expect(frameKey({ channel: "activeSpotAssetCtx", data: { coin: "@107" } })).toBe(subKey({ type: "activeAssetCtx", coin: "@107" }));
    expect(frameKey({ channel: "allMids", data: { mids: {} } })).toBe(subKey({ type: "allMids" }));
    expect(frameKey({ channel: "trades", data: [] })).toBeNull();
  });

  it("normalizes symbols to Hyperliquid coins", () => {
    expect(toHlCoin("BTCUSDT")).toBe("BTC");
    expect(toHlCoin("eth-usdt-swap")).toBe("ETH");
    expect(toHlCoin("SOL")).toBe("SOL");
    expect(toHlCoin("kPEPE")).toBe("kPEPE");
    expect(toHlCoin("xyz:GBP")).toBe("xyz:GBP");
    expect(toHlCoin("XYZ:gbp")).toBe("xyz:GBP");
  });

  it("handles builder-dex (HIP-3) coins", () => {
    expect(splitHlCoin("xyz:GBP")).toEqual({ dex: "xyz", base: "GBP" });
    expect(splitHlCoin("BTC")).toEqual({ dex: "", base: "BTC" });
    expect(frameKey({ channel: "l2Book", data: { coin: "xyz:GBP" } })).toBe(subKey({ type: "l2Book", coin: "xyz:GBP" }));
    expect(frameKey({ channel: "allMids", data: { dex: "xyz", mids: {} } })).toBe(subKey({ type: "allMids", dex: "xyz" }));
    expect(subKey({ type: "allMids", dex: "xyz" })).not.toBe(subKey({ type: "allMids" }));
  });

  it("maps perpCategories labels", () => {
    expect(hlCategory("fx", "xyz")).toBe("fx");
    expect(hlCategory("FX", "xyz")).toBe("fx");
    expect(hlCategory("indices", "xyz")).toBe("index");
    expect(hlCategory("preipo", "io")).toBe("stock");
    expect(hlCategory(undefined, "")).toBe("crypto");
    expect(hlCategory(undefined, "mkts")).toBe("other");
  });

  it("caps display decimals at 5 significant figures", () => {
    expect(hlTickSz(5, 63_000)).toBe(1);
    expect(hlTickSz(1, 1.3152)).toBeCloseTo(0.0001);
    expect(hlTickSz(0, 0.000012)).toBeCloseTo(0.000001);
  });
});

describe("hyperliquid subscriptions", () => {
  it("opens one socket, ref-counts listeners, subscribes once", () => {
    const { ch, stream } = setup();
    const a: number[] = [], b: number[] = [];
    const offA = ch.assetCtx("BTC", (c) => a.push(c.markPx));
    const offB = ch.assetCtx("BTC", (c) => b.push(c.markPx));
    ch.trades("ETH", () => {});
    expect(FakeWS.instances).toHaveLength(1);
    const ws = FakeWS.instances[0];
    expect(ws.url).toBe("wss://api.hyperliquid.xyz/ws");
    ws.open();
    expect(ws.ops()).toEqual([
      { method: "subscribe", subscription: { type: "activeAssetCtx", coin: "BTC" } },
      { method: "subscribe", subscription: { type: "trades", coin: "ETH" } },
    ]);
    ws.push({ channel: "activeAssetCtx", data: { coin: "BTC", ctx: { markPx: "63182.0", funding: "0.0000125", openInterest: "1", prevDayPx: "60000", dayNtlVlm: "0", premium: null, oraclePx: "63211.3", midPx: null, impactPxs: null, dayBaseVlm: "0" } } });
    expect(a).toEqual([63182]);
    expect(b).toEqual([63182]);
    offA();
    expect(ws.ops()).toHaveLength(2);
    offB();
    expect(ws.ops().at(-1)).toEqual({ method: "unsubscribe", subscription: { type: "activeAssetCtx", coin: "BTC" } });
    expect(stream.size).toBe(1);
  });

  it("parses trades, candles and books", () => {
    const { ch } = setup();
    const trades: HlTrade[] = [], candles: HlCandle[] = [];
    let bestBid = 0;
    ch.trades("BTC", (t) => trades.push(t));
    ch.candles("BTC", "1m", (c) => candles.push(c));
    ch.book("BTC", (bk) => { bestBid = bk.bids[0].price; });
    const ws = FakeWS.instances[0];
    ws.open();
    ws.push({ channel: "trades", data: [{ coin: "BTC", side: "A", px: "100.5", sz: "2", time: 1, hash: "0x", tid: 7, users: ["0xa", "0xb"] }] });
    ws.push({ channel: "candle", data: { t: 0, T: 59999, s: "BTC", i: "1m", o: "1", c: "2", h: "3", l: "0.5", v: "10", n: 4 } });
    ws.push({ channel: "candle", data: { t: 0, T: 59999, s: "BTC", i: "5m", o: "9", c: "9", h: "9", l: "9", v: "9", n: 9 } });
    ws.push({ channel: "l2Book", data: { coin: "BTC", time: 2, levels: [[{ px: "99", sz: "1", n: 1 }], [{ px: "101", sz: "1", n: 1 }]] } });
    expect(trades[0]).toMatchObject({ price: 100.5, size: 2, side: "sell", tid: 7 });
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 1, close: 2, high: 3, low: 0.5, vol: 10, interval: "1m" });
    expect(bestBid).toBe(99);
  });

  it("resubscribes everything after a reconnect", async () => {
    const { ch } = setup();
    ch.bbo("BTC", () => {});
    ch.allMids(() => {});
    FakeWS.instances[0].open();
    FakeWS.instances[0].close();
    await new Promise((r) => setTimeout(r, 1000));
    const ws2 = FakeWS.instances[1];
    expect(ws2).toBeDefined();
    ws2.open();
    expect(ws2.ops().map((o) => o.subscription.type).sort()).toEqual(["allMids", "bbo"]);
  });

  it("reports server errors without throwing", () => {
    const { stream } = setup();
    const errors: string[] = [];
    stream.onError((e) => errors.push(e.msg));
    stream.handleFrame(JSON.stringify({ channel: "error", data: "bad request" }));
    stream.handleFrame("not json");
    expect(errors).toHaveLength(2);
  });

  it("computes 24h change from prevDayPx", () => {
    expect(hlChangePct({ prevDayPx: 100, midPx: 110, markPx: 0 } as HlAssetCtx)).toBeCloseTo(10);
    expect(hlChangePct(null)).toBeNull();
  });
});
