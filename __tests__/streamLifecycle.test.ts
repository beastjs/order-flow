// ─── WebSocket client lifecycles under fake time ──────────────────
// Connection management is where live feeds silently die: half-open
// sockets, reconnect storms, leaked sockets, unsubscribes sent to the
// wrong socket. These drive HlStream / OkxStream with a fake socket and
// fake timers (jitter pinned) so every timing rule is asserted exactly.
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { HlStream, hlChannels } from "@/lib/hyperliquid";
import { OkxStream, okxChannels } from "@/lib/okx";

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    if (this.readyState !== 1) throw new Error("send() on a socket that isn't open");
    this.sent.push(s);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(frame: unknown) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  /** Server drops the connection. */
  drop() {
    this.close();
  }
  json() {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s));
  }
}
const WS = FakeWS as unknown as new (url: string) => WebSocket;
const last = () => FakeWS.all[FakeWS.all.length - 1];
const tick = (ms: number) => jest.advanceTimersByTime(ms);

let randomSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  FakeWS.all = [];
  jest.useFakeTimers();
  randomSpy = spyOn(Math, "random").mockReturnValue(0.5); // backoff jitter factor = 1.0
});
afterEach(() => {
  jest.useRealTimers();
  randomSpy.mockRestore();
});

// ─── Hyperliquid ─────────────────────────────────────────────────

describe("HlStream lifecycle", () => {
  const setup = () => {
    const stream = new HlStream({ WebSocketImpl: WS });
    const statuses: string[] = [];
    stream.onStatus((s) => statuses.push(s));
    stream.onError(() => {});
    return { stream, ch: hlChannels(stream), statuses };
  };

  it("opens nothing until the first subscription, then exactly one socket", () => {
    const { ch } = setup();
    expect(FakeWS.all).toHaveLength(0);
    ch.trades("BTC", () => {});
    ch.book("ETH", () => {});
    ch.candles("SOL", "1m", () => {});
    expect(FakeWS.all).toHaveLength(1);
  });

  it("an unsubscribe before the socket opens sends nothing; only live subs go out on open", () => {
    const { ch } = setup();
    const off = ch.trades("BTC", () => {});
    ch.book("ETH", () => {});
    off();
    last().open();
    expect(last().json()).toEqual([{ method: "subscribe", subscription: { type: "l2Book", coin: "ETH" } }]);
  });

  it("closes the socket 5s after the last listener leaves, unless one comes back first", () => {
    const { ch, statuses } = setup();
    const off = ch.trades("BTC", () => {});
    last().open();
    off();
    tick(4_999);
    expect(last().readyState).toBe(1);
    const off2 = ch.trades("BTC", () => {}); // came back in time: reuse the socket
    tick(10_000);
    expect(FakeWS.all).toHaveLength(1);
    expect(last().readyState).toBe(1);
    off2();
    tick(5_000);
    expect(last().readyState).toBe(3);
    expect(statuses.at(-1)).toBe("idle");
  });

  it("reconnects with exponential backoff capped at 30s, and resubscribes everything", () => {
    const { ch, statuses } = setup();
    ch.trades("BTC", () => {});
    ch.assetCtx("ETH", () => {});
    last().open();
    const delays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const delay of delays) {
      const before = FakeWS.all.length;
      last().drop();
      expect(statuses.at(-1)).toBe("reconnecting");
      tick(delay - 1);
      expect(FakeWS.all.length).toBe(before); // not a millisecond early
      tick(1);
      expect(FakeWS.all.length).toBe(before + 1);
    }
    last().open(); // success resets the backoff
    expect(last().json().map((m) => m.subscription.type).sort()).toEqual(["activeAssetCtx", "trades"]);
    last().drop();
    tick(500);
    expect(FakeWS.all.length).toBe(delays.length + 2);
  });

  it("pings after 30s of silence and replaces a half-open socket after 45s", () => {
    const { ch } = setup();
    ch.trades("BTC", () => {});
    const ws = last();
    ws.open();
    tick(30_000);
    expect(ws.sent).toHaveLength(1); // just the subscribe
    tick(5_000);
    expect(ws.sent.at(-1)).toBe(JSON.stringify({ method: "ping" }));
    ws.push({ channel: "pong" }); // alive: the silence clock resets
    tick(40_000);
    expect(ws.readyState).toBe(1);
    tick(10_000); // > 45s since the pong, no reply
    expect(ws.readyState).toBe(3);
    tick(500);
    expect(FakeWS.all).toHaveLength(2);
  });

  it("ignores frames from a socket it has already replaced", () => {
    const { ch } = setup();
    const got: number[] = [];
    ch.trades("BTC", (t) => got.push(t.price));
    const old = last();
    old.open();
    old.drop();
    tick(500);
    last().open();
    old.push({ channel: "trades", data: [{ coin: "BTC", side: "B", px: "1", sz: "1", time: 1, hash: "0x", tid: 1, users: ["a", "b"] }] });
    expect(got).toEqual([]);
  });

  it("a throwing listener doesn't stop the others", () => {
    const { ch } = setup();
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const got: string[] = [];
    ch.trades("BTC", () => {
      throw new Error("boom");
    });
    ch.trades("BTC", (t) => got.push(t.coin));
    last().open();
    last().push({ channel: "trades", data: [{ coin: "BTC", side: "A", px: "1", sz: "1", time: 1, hash: "0x", tid: 1, users: ["a", "b"] }] });
    expect(got).toEqual(["BTC"]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("calling an unsubscribe twice is harmless and never drops another listener", () => {
    const { ch } = setup();
    const got: number[] = [];
    const offA = ch.trades("BTC", () => {});
    ch.trades("BTC", (t) => got.push(t.price));
    last().open();
    offA();
    offA();
    expect(last().json().filter((m) => m.method === "unsubscribe")).toEqual([]);
    last().push({ channel: "trades", data: [{ coin: "BTC", side: "A", px: "7", sz: "1", time: 1, hash: "0x", tid: 1, users: ["a", "b"] }] });
    expect(got).toEqual([7]);
  });

  it("destroy() closes for good: no reconnect, no idle timer, status closed", () => {
    const { stream, ch, statuses } = setup();
    ch.trades("BTC", () => {});
    last().open();
    stream.destroy();
    tick(120_000);
    expect(FakeWS.all).toHaveLength(1);
    expect(statuses.at(-1)).toBe("closed");
  });

  it("survives garbage frames and reports server errors", () => {
    const { stream, ch } = setup();
    const errors: string[] = [];
    stream.onError((e) => errors.push(e.msg));
    ch.trades("BTC", () => {});
    last().open();
    for (const junk of ["", "{", "null", "42", '"x"', "[]", '{"channel":"trades","data":null}', '{"channel":"l2Book"}', '{"channel":"candle","data":7}']) last().push(junk);
    last().push({ channel: "error", data: "Already subscribed" });
    expect(errors.some((e) => e === "Already subscribed")).toBe(true);
    expect(last().readyState).toBe(1);
  });
});

// ─── OKX ─────────────────────────────────────────────────────────

describe("OkxStream lifecycle", () => {
  const setup = () => {
    const stream = new OkxStream({ WebSocketImpl: WS });
    stream.onError(() => {});
    return { stream, ch: okxChannels(stream) };
  };
  const socket = (path: string) => FakeWS.all.filter((w) => w.url.endsWith(path)).at(-1)!;

  it("batches subscriptions at 100 args per request on open", () => {
    const { ch } = setup();
    for (let i = 0; i < 250; i++) ch.ticker(`C${i}-USDT-SWAP`, () => {});
    socket("/public").open();
    expect(socket("/public").json().map((m) => m.args.length)).toEqual([100, 100, 50]);
  });

  it("pings with a bare 'ping' after 20s of silence and replaces a dead socket after 35s", () => {
    const { ch } = setup();
    ch.ticker("BTC-USDT-SWAP", () => {});
    const ws = socket("/public");
    ws.open();
    tick(25_000);
    expect(ws.sent.at(-1)).toBe("ping");
    ws.push("pong");
    tick(30_000);
    expect(ws.readyState).toBe(1);
    tick(10_000);
    expect(ws.readyState).toBe(3);
    tick(500);
    expect(FakeWS.all.filter((w) => w.url.endsWith("/public"))).toHaveLength(2);
  });

  it("keeps the public and business sockets independent", () => {
    const { ch } = setup();
    const offT = ch.ticker("BTC-USDT-SWAP", () => {});
    ch.candles("BTC-USDT-SWAP", "1m", () => {});
    socket("/public").open();
    socket("/business").open();
    offT();
    tick(5_000);
    expect(socket("/public").readyState).toBe(3); // idle-closed
    expect(socket("/business").readyState).toBe(1); // still wanted
    socket("/business").drop();
    tick(500);
    expect(FakeWS.all.filter((w) => w.url.endsWith("/public"))).toHaveLength(1); // no reconnect for an unwanted socket
    expect(FakeWS.all.filter((w) => w.url.endsWith("/business"))).toHaveLength(2);
  });

  it("survives garbage frames without dropping the socket", () => {
    const { ch } = setup();
    const btc: number[] = [];
    ch.ticker("BTC-USDT-SWAP", (t) => btc.push(t.last));
    socket("/public").open();
    for (const junk of ["", "{", "null", "42", '"x"', "[]", '{"arg":null}', '{"arg":{"channel":"tickers","instId":"BTC-USDT-SWAP"},"data":null}']) {
      socket("/public").push(junk);
    }
    socket("/public").push({ arg: { channel: "tickers", instId: "BTC-USDT-SWAP" }, data: [{ instId: "BTC-USDT-SWAP", last: "5" }] });
    expect(btc).toEqual([5]);
    expect(socket("/public").readyState).toBe(1);
  });

  it("routes a push only to listeners of that exact channel + instrument", () => {
    const { ch } = setup();
    const btc: number[] = [];
    const eth: number[] = [];
    ch.ticker("BTC-USDT-SWAP", (t) => btc.push(t.last));
    ch.ticker("ETH-USDT-SWAP", (t) => eth.push(t.last));
    socket("/public").open();
    socket("/public").push({ arg: { channel: "tickers", instId: "BTC-USDT-SWAP" }, data: [{ instId: "BTC-USDT-SWAP", last: "100" }] });
    socket("/public").push({ arg: { channel: "mark-price", instId: "BTC-USDT-SWAP" }, data: [{ instId: "BTC-USDT-SWAP", markPx: "1" }] });
    expect(btc).toEqual([100]);
    expect(eth).toEqual([]);
  });
});
