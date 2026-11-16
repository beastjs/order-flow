import { OkxStream, argKey, endpointFor, okxChannels, toIndexId, toPerpInstId, parseCandle } from "@/lib/okx";

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
  ops() { return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s)); }
}

function setup() {
  FakeWS.instances = [];
  const stream = new OkxStream({ WebSocketImpl: FakeWS as unknown as new (url: string) => WebSocket });
  return { stream, ch: okxChannels(stream) };
}

describe("okx routing", () => {
  it("sends candles and trades-all to business, the rest to public", () => {
    expect(endpointFor("candle1m")).toBe("business");
    expect(endpointFor("mark-price-candle1H")).toBe("business");
    expect(endpointFor("index-candle1D")).toBe("business");
    expect(endpointFor("trades-all")).toBe("business");
    expect(endpointFor("tickers")).toBe("public");
    expect(endpointFor("mark-price")).toBe("public");
    expect(endpointFor("books")).toBe("public");
  });

  it("normalizes symbols to perp and index ids", () => {
    expect(toPerpInstId("AAPL")).toBe("AAPL-USDT-SWAP");
    expect(toPerpInstId("BTCUSDT")).toBe("BTC-USDT-SWAP");
    expect(toPerpInstId("AAPL-USDT")).toBe("AAPL-USDT-SWAP");
    expect(toIndexId("AAPL-USDT-SWAP")).toBe("AAPL-USDT");
  });

  it("opens one socket per endpoint on port 443", () => {
    const { ch } = setup();
    ch.ticker("AAPL-USDT-SWAP", () => {});
    ch.candles("BTC-USDT-SWAP", "1m", () => {});
    expect(FakeWS.instances.map((w) => w.url).sort()).toEqual([
      "wss://ws.okx.com/ws/v5/business",
      "wss://ws.okx.com/ws/v5/public",
    ]);
  });
});

describe("okx subscriptions", () => {
  it("ref-counts listeners and subscribes once", () => {
    const { ch, stream } = setup();
    const a: number[] = [], b: number[] = [];
    const offA = ch.ticker("AAPL-USDT-SWAP", (t) => a.push(t.last));
    const offB = ch.ticker("AAPL-USDT-SWAP", (t) => b.push(t.last));
    const ws = FakeWS.instances[0];
    ws.open();
    expect(ws.ops()).toEqual([{ op: "subscribe", args: [{ channel: "tickers", instId: "AAPL-USDT-SWAP" }] }]);

    ws.push({ arg: { channel: "tickers", instId: "AAPL-USDT-SWAP" }, data: [{ instId: "AAPL-USDT-SWAP", last: "357.84", sodUtc0: "359.27", ts: "1" }] });
    expect(a).toEqual([357.84]);
    expect(b).toEqual([357.84]);

    offA();
    expect(ws.ops()).toHaveLength(1); // B still listening
    offB();
    expect(ws.ops()[1]).toEqual({ op: "unsubscribe", args: [{ channel: "tickers", instId: "AAPL-USDT-SWAP" }] });
    expect(stream.public.size).toBe(0);
  });

  it("re-subscribes everything after a reconnect", async () => {
    const { ch } = setup();
    ch.ticker("AAPL-USDT-SWAP", () => {});
    ch.ticker("BTC-USDT-SWAP", () => {});
    const first = FakeWS.instances[0];
    first.open();
    first.close(); // server drop
    await new Promise((r) => setTimeout(r, 900));
    const second = FakeWS.instances[1];
    expect(second).toBeDefined();
    second.open();
    expect(second.ops()[0].args.map(argKey).sort()).toEqual([
      "tickers|AAPL-USDT-SWAP||",
      "tickers|BTC-USDT-SWAP||",
    ]);
  });

  it("parses business candles and confirm flag", () => {
    const { ch } = setup();
    const got: ReturnType<typeof parseCandle>[] = [];
    ch.candles("AAPL-USDT-SWAP", "1m", (c) => got.push(c));
    const ws = FakeWS.instances[0];
    ws.open();
    ws.push({ arg: { channel: "candle1m", instId: "AAPL-USDT-SWAP" }, data: [["1794834060000", "357.85", "357.92", "357.81", "357.81", "12.5", "12.5", "4473.1", "1"]] });
    expect(got[0]).toMatchObject({ ts: 1794834060000, open: 357.85, close: 357.81, vol: 12.5, confirmed: true });
    // mark/index candles have only 6 fields
    expect(parseCandle(["1", "2", "3", "1", "2", "0"])).toMatchObject({ close: 2, vol: 0, confirmed: false });
  });

  it("maintains a local book from snapshot + deltas", () => {
    const { ch } = setup();
    const books: { bids: number[][]; asks: number[][] }[] = [];
    ch.book("AAPL-USDT-SWAP", (b) => books.push({ bids: b.bids.map((l) => [l.price, l.size]), asks: b.asks.map((l) => [l.price, l.size]) }));
    const ws = FakeWS.instances[0];
    ws.open();
    const arg = { channel: "books", instId: "AAPL-USDT-SWAP" };
    ws.push({ arg, action: "snapshot", data: [{ bids: [["100", "1", "0", "1"], ["99", "2", "0", "1"]], asks: [["101", "3", "0", "1"]], ts: "1" }] });
    ws.push({ arg, action: "update", data: [{ bids: [["100", "0", "0", "0"], ["99.5", "4", "0", "1"]], asks: [], ts: "2" }] });
    expect(books[1]).toEqual({ bids: [[99.5, 4], [99, 2]], asks: [[101, 3]] });
  });

  it("surfaces OKX error events", () => {
    const { ch, stream } = setup();
    const errors: string[] = [];
    stream.onError((e) => errors.push(`${e.endpoint}:${e.code}`));
    ch.tradesAll("NOPE-USDT-SWAP", () => {});
    const ws = FakeWS.instances[0];
    ws.open();
    ws.push({ event: "error", code: "60018", msg: "doesn't exist" });
    expect(errors).toEqual(["business:60018"]);
  });
});
