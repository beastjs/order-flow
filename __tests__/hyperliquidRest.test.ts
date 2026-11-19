// ─── Hyperliquid REST: catalog merge, failure isolation, rate limit ─
// fetch is scripted per request body, so these cover the multi-dex
// merge, which failures are fatal vs skipped, malformed payloads, the
// candle window, and the sparkline queue's burst/refill/cache rules.
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { fetchHlCandles, fetchHlPerps, fetchHlSparkline, hlInfo } from "@/lib/hyperliquid";

type Body = { type: string; dex?: string; req?: Record<string, unknown> };
type Reply = unknown | ((b: Body) => unknown);
let routes: Record<string, Reply> = {};
let calls: Body[] = [];
const realFetch = globalThis.fetch;

const ctx = (markPx: string) => ({
  funding: "0.0001", openInterest: "10", prevDayPx: "1", dayNtlVlm: "100", premium: null,
  oraclePx: markPx, markPx, midPx: markPx, impactPxs: null, dayBaseVlm: "1",
});
const asset = (name: string, extra: Record<string, unknown> = {}) => ({ name, szDecimals: 2, maxLeverage: 10, ...extra });

beforeEach(() => {
  calls = [];
  routes = {
    perpDexs: [null, { name: "xyz" }, { name: "flx" }],
    perpCategories: [["xyz:GBP", "fx"], ["xyz:AAPL", "stocks"], ["BTC", "crypto"]],
    "metaAndAssetCtxs:": [{ universe: [asset("BTC"), asset("OLD", { isDelisted: true })] }, [ctx("63000"), ctx("1")]],
    "metaAndAssetCtxs:xyz": [{ universe: [asset("xyz:GBP"), asset("xyz:AAPL")] }, [ctx("1.3152"), ctx("353")]],
    "metaAndAssetCtxs:flx": [{ universe: [asset("flx:GOLD")] }, [ctx("3700")]],
  };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    calls.push(body);
    const key = body.type === "metaAndAssetCtxs" ? `metaAndAssetCtxs:${body.dex ?? ""}` : body.type;
    const reply = routes[key];
    if (reply === undefined) return new Response("not found", { status: 404 });
    if (reply instanceof Error) throw reply;
    const value = typeof reply === "function" ? (reply as (b: Body) => unknown)(body) : reply;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("hlInfo", () => {
  it("POSTs JSON and turns HTTP errors into a readable error", async () => {
    routes.perpDexs = new Response("rate limited", { status: 429 });
    await expect(hlInfo({ type: "perpDexs" })).rejects.toThrow("Hyperliquid info perpDexs → HTTP 429");
  });
});

describe("fetchHlPerps", () => {
  it("merges the main dex with every builder dex, keeping dex, base and category", async () => {
    const perps = await fetchHlPerps();
    expect(perps.map((p) => p.meta.name)).toEqual(["BTC", "OLD", "xyz:GBP", "xyz:AAPL", "flx:GOLD"]);
    const gbp = perps.find((p) => p.meta.name === "xyz:GBP")!;
    expect(gbp.meta).toMatchObject({ base: "GBP", dex: "xyz", category: "fx" });
    expect(gbp.ctx.markPx).toBe(1.3152);
    expect(perps.find((p) => p.meta.name === "BTC")!.meta).toMatchObject({ dex: "", category: "crypto" });
    expect(perps.find((p) => p.meta.name === "flx:GOLD")!.meta.category).toBe("other"); // unlabelled builder coin
    expect(perps.find((p) => p.meta.name === "OLD")!.meta.isDelisted).toBe(true);
  });

  it("skips a builder dex that errors, but still returns everything else", async () => {
    routes["metaAndAssetCtxs:xyz"] = new Response("boom", { status: 500 });
    const names = (await fetchHlPerps()).map((p) => p.meta.name);
    expect(names).toEqual(["BTC", "OLD", "flx:GOLD"]);
  });

  it("skips a builder dex whose payload is malformed instead of failing the whole catalog", async () => {
    routes["metaAndAssetCtxs:flx"] = [{ universe: [asset("flx:GOLD"), asset("flx:OIL")] }, [ctx("3700")]]; // ctx missing for OIL
    const names = (await fetchHlPerps()).map((p) => p.meta.name);
    expect(names).toContain("BTC");
    expect(names).toContain("xyz:GBP");
    expect(names).not.toContain("flx:OIL");
  });

  it("works with no builder dexes or categories (both endpoints failing)", async () => {
    routes.perpDexs = new Error("network down");
    routes.perpCategories = new Response("nope", { status: 503 });
    const perps = await fetchHlPerps();
    expect(perps.map((p) => p.meta.name)).toEqual(["BTC", "OLD"]);
    expect(perps[0].meta.category).toBe("crypto");
  });

  it("fails loudly when the main dex payload is malformed", async () => {
    routes["metaAndAssetCtxs:"] = [{ universe: [asset("BTC"), asset("ETH")] }, [ctx("1")]];
    await expect(fetchHlPerps()).rejects.toThrow(/2 assets vs 1 contexts/);
  });

  it("fails when the main dex can't load (nothing useful to show)", async () => {
    routes["metaAndAssetCtxs:"] = new Response("down", { status: 502 });
    await expect(fetchHlPerps()).rejects.toThrow(/HTTP 502/);
  });

  it("asks the main dex without a dex field and each builder dex by name", async () => {
    await fetchHlPerps();
    const metas = calls.filter((c) => c.type === "metaAndAssetCtxs");
    expect(metas.map((c) => c.dex ?? "(main)").sort()).toEqual(["(main)", "flx", "xyz"]);
    expect(metas.find((c) => !c.dex)).not.toHaveProperty("dex");
  });
});

describe("fetchHlCandles", () => {
  it("requests exactly `limit` intervals ending at endTime and returns at most `limit`, oldest first", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ t: i * 60_000, T: i * 60_000 + 59_999, s: "BTC", i: "1m", o: "1", c: String(i), h: "2", l: "0", v: "1", n: 1 }));
    routes.candleSnapshot = rows;
    const out = await fetchHlCandles("BTC", "1m", { limit: 3, endTime: 1_000_000 });
    const req = calls.at(-1)!.req!;
    expect(req).toEqual({ coin: "BTC", interval: "1m", startTime: 1_000_000 - 3 * 60_000, endTime: 1_000_000 });
    expect(out.map((c) => c.close)).toEqual([2, 3, 4]);
  });
});

describe("fetchHlSparkline queue", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it("bursts 30 requests, then releases one per second", async () => {
    routes.candleSnapshot = (b: Body) => [{ t: 0, T: 1, s: String(b.req!.coin), i: "1h", o: "1", c: "5", h: "1", l: "1", v: "1", n: 1 }];
    const coins = Array.from({ length: 33 }, (_, i) => `Q${i}`);
    for (const c of coins) void fetchHlSparkline(c);
    await flush();
    expect(calls.length).toBe(30);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(calls.length).toBe(31);
    jest.advanceTimersByTime(2_000);
    await flush();
    expect(calls.length).toBe(33);
    // Let the bucket refill fully so the queue's interval stops on this fake clock.
    for (let s = 0; s < 31; s++) {
      jest.advanceTimersByTime(1_000);
      await flush();
    }
  });

  it("dedupes concurrent requests for the same coin and evicts failures so they can retry", async () => {
    let fail = true;
    routes.candleSnapshot = () => (fail ? new Response("x", { status: 500 }) : [{ t: 0, T: 1, s: "D", i: "1h", o: "1", c: "9", h: "1", l: "1", v: "1", n: 1 }]);
    const before = calls.length;
    const a = fetchHlSparkline("DEDUPE");
    const b = fetchHlSparkline("DEDUPE");
    expect(a).toBe(b);
    await expect(a).rejects.toThrow(/HTTP 500/);
    expect(calls.length - before).toBe(1);
    fail = false;
    await expect(fetchHlSparkline("DEDUPE")).resolves.toEqual([9]);
  });
});
