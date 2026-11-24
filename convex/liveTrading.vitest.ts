/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { signOkx } from "./lib/okxTradeCore";
import schema from "./schema";
import { liquidationPrice } from "../src/lib/paper/math";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = { subject: "root", tokenIdentifier: "firebase|root", admin: true };
const USER = { subject: "u", tokenIdentifier: "firebase|u" };
const AAPL = "AAPL-USDT-SWAP";

// ─── fake OKX ────────────────────────────────────────────────

interface Sent {
  method: string;
  host: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

function fakeOkx() {
  const sent: Sent[] = [];
  const orders = new Map<string, Record<string, string>>(); // clOrdId → order
  const state = {
    ask: 353.36,
    bid: 353.3,
    mark: 353.33,
    /** What the next POST /trade/order does. */
    nextPlace: "fill" as "fill" | "reject" | "network" | "timeout",
    /** Fill details for the next filled order. */
    fill: { avgPx: "353.40", accFillSz: "", fee: "-0.25" },
    fillState: "filled",
    posMode: "long_short_mode",
    permissions: "read_only,trade",
    accountUid: "personal-uid",
    accountLevel: "2",
    personalSize: "0",
    personalSide: "long",
    preparationDelayMs: 0,
  };
  const ok = (data: unknown[]) => new Response(JSON.stringify({ code: "0", msg: "", data }));

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, host: url.host, path, body, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})) });

    if (url.pathname === "/api/v5/public/instruments") {
      return ok([{ instId: AAPL, state: "live", settleCcy: "USDT", ctValCcy: "AAPL", instCategory: "3", lever: "20", ctVal: "1", lotSz: "0.01", minSz: "0.01", ruleType: "normal" }]);
    }
    if (url.pathname === "/api/v5/market/ticker") return ok([{ bidPx: String(state.bid), askPx: String(state.ask) }]);
    if (url.pathname === "/api/v5/public/mark-price") return ok([{ instId: AAPL, markPx: String(state.mark) }]);
    if (url.pathname === "/api/v5/account/config") return ok([{ posMode: state.posMode, perm: state.permissions, uid: state.accountUid, acctLv: state.accountLevel }]);
    if (url.pathname === "/api/v5/account/balance") return ok([{ details: [{ ccy: "USDT", availBal: "42.50" }] }]);
    if (url.pathname === "/api/v5/account/positions") return ok(state.personalSize === "0" ? [] : [
      { instId: AAPL, mgnMode: "isolated", posSide: state.personalSide, pos: state.personalSize },
    ]);
    if (url.pathname === "/api/v5/account/set-position-mode") {
      state.posMode = "long_short_mode";
      return ok([{}]);
    }
    if (url.pathname === "/api/v5/account/set-leverage") {
      if (state.preparationDelayMs) vi.setSystemTime(Date.now() + state.preparationDelayMs);
      return ok([{}]);
    }
    if (url.pathname === "/api/v5/trade/order" && method === "POST") {
      if (state.nextPlace === "network") throw new TypeError("fetch failed");
      if (state.nextPlace === "timeout") return new Response(JSON.stringify({ code: "50004", msg: "API endpoint request timeout", data: [] }));
      if (state.nextPlace === "reject") {
        return new Response(JSON.stringify({ code: "1", msg: "", data: [{ sCode: "51008", sMsg: "Order failed. Insufficient USDT margin in account" }] }));
      }
      const ordId = `ord${orders.size + 1}`;
      orders.set(String(body.clOrdId), {
        ordId,
        state: state.fillState,
        avgPx: state.fill.avgPx,
        accFillSz: state.fill.accFillSz || String(body.sz),
        fee: state.fill.fee,
      });
      return ok([{ ordId, clOrdId: body.clOrdId, sCode: "0", sMsg: "" }]);
    }
    if (url.pathname === "/api/v5/trade/order" && method === "GET") {
      const o = orders.get(url.searchParams.get("clOrdId") ?? "");
      if (!o) return new Response(JSON.stringify({ code: "51603", msg: "Order does not exist", data: [] }));
      return ok([o]);
    }
    return new Response(JSON.stringify({ code: "404", msg: `unmocked ${path}`, data: [] }), { status: 404 });
  });
  return { sent, orders, state, fetchMock, placed: () => sent.filter((s) => s.path === "/api/v5/trade/order" && s.method === "POST") };
}

let okx: ReturnType<typeof fakeOkx>;

beforeEach(() => {
  okx = fakeOkx();
  vi.stubGlobal("fetch", okx.fetchMock);
  Object.assign(process.env, {
    OKX_API_KEY: "test-key",
    OKX_API_SECRET: "test-secret",
    OKX_API_PASSPHRASE: "test-pass",
    OKX_TRADING_MODE: "demo",
  });
  delete process.env.OKX_TRADING_ACCESS;
  delete process.env.OKX_MAX_ORDER_USD;
  vi.stubEnv("OKX_USER_KEY_ENCRYPTION_KEY", undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("My OKX", () => {
  const keys = { key: "personal-api-key-1234", secret: "personal-secret-1234", passphrase: "personal-pass-1234" };
  const demo = { ...keys, mode: "demo" as const };
  const order = { venue: "personal" as const, instId: AAPL, side: "up" as const, margin: 50, leverage: 2 };

  beforeEach(() => vi.stubEnv("OKX_USER_KEY_ENCRYPTION_KEY", "ab".repeat(32)));

  it("keeps personal trading disabled without a valid encryption key and never falls back to the platform key", async () => {
    const { admin } = await setup();
    for (const encryptionKey of [undefined, "invalid-encryption-key"]) {
      vi.stubEnv("OKX_USER_KEY_ENCRYPTION_KEY", encryptionKey);
      expect(await admin.query(api.okxConnections.status, {})).toEqual({ enabled: false, connection: null });
      await expect(admin.action(api.okxConnections.connect, demo)).rejects.toThrow(/unavailable/);
      await expect(admin.action(api.liveTrading.open, order)).rejects.toThrow(/unavailable/);
    }
    vi.stubEnv("OKX_USER_KEY_ENCRYPTION_KEY", "ab".repeat(32));
    await expect(admin.action(api.liveTrading.open, order)).rejects.toThrow(/Connect your OKX account first/);
    expect(okx.sent).toHaveLength(0);
  });

  it("rejects unsigned, read-only and withdrawal-capable keys and returns only connection metadata", async () => {
    const { t, user, admin } = await setup();
    await expect(t.action(api.okxConnections.connect, demo)).rejects.toThrow(/Not signed in/);
    expect(okx.sent).toHaveLength(0);
    for (const permissions of ["read_only", "read_only,trade,withdraw"]) {
      okx.state.permissions = permissions;
      await expect(user.action(api.okxConnections.connect, demo)).rejects.toThrow(/Read and Trade/);
    }
    okx.state.permissions = "read_only,trade";
    await user.action(api.okxConnections.connect, demo);
    const publicStatus = await user.query(api.okxConnections.status, {});
    expect(publicStatus).toEqual({ enabled: true, connection: { mode: "demo", keySuffix: "1234", revision: expect.any(String) } });
    expect(await admin.query(api.okxConnections.status, {})).toMatchObject({ connection: null });
    await expect(admin.action(api.okxConnections.balance, {})).rejects.toThrow(/Connect your OKX account/);
    await expect(admin.action(api.okxConnections.connect, { ...demo, key: "different-key-1234" })).rejects.toThrow(/already connected/);
    expect(await user.action(api.okxConnections.balance, {})).toBe(42.5);
    const [stored] = await t.run((ctx) => ctx.db.query("okxConnections").take(1));
    expect(stored.ciphertext).toBeTruthy();
    for (const value of Object.values(keys)) expect(JSON.stringify(stored)).not.toContain(value);
  });

  it("places and closes isolated market orders on the owner's demo account without touching CFX funds", async () => {
    const { user, admin, userId, fundsRow } = await setup(0);
    await user.action(api.okxConnections.connect, demo);
    const { connection } = await user.query(api.okxConnections.status, {});
    const opened = await user.action(api.liveTrading.open, { ...order, connectionRevision: connection!.revision });
    expect(opened.outcome).toBe("filled");
    expect(okx.placed()[0]).toMatchObject({
      body: { tdMode: "isolated", side: "buy", posSide: "long", sz: "0.28" },
      headers: { "OK-ACCESS-KEY": demo.key, "x-simulated-trading": "1" },
    });
    expect(Number(okx.placed()[0].headers.expTime)).toBeGreaterThan(Date.now());
    expect(okx.sent.find((req) => req.path === "/api/v5/account/set-leverage")!.body).toEqual({
      instId: AAPL, lever: "2", mgnMode: "isolated", posSide: "long",
    });
    expect(await user.query(api.liveTrading.openFor, { instId: AAPL })).toBeNull();
    expect(await user.query(api.liveTrading.personalPositions, {})).toMatchObject([{ status: "open", okxMode: "demo" }]);
    expect(await admin.query(api.liveTrading.personalPositions, {})).toEqual([]);
    await expect(admin.action(api.liveTrading.close, { positionId: opened.positionId })).rejects.toThrow(/not found/);
    await expect(user.mutation(api.okxConnections.disconnect, {})).rejects.toThrow(/Close your My OKX positions/);
    await expect(user.action(api.okxConnections.connect, { ...demo, mode: "live" })).rejects.toThrow(/Close your My OKX positions/);
    okx.state.mark = 1;
    expect(await admin.action(internal.liveTrading.sweepLiquidations, {})).toBe(0);

    const newKey = "replacement-key-5678";
    await user.action(api.okxConnections.connect, { ...demo, key: newKey });
    await expect(user.action(api.liveTrading.open, { ...order, connectionRevision: connection!.revision })).rejects.toThrow(/connection changed/);
    okx.state.personalSize = "0.28";
    const closed = await user.action(api.liveTrading.close, { positionId: opened.positionId });
    expect(closed.outcome).toBe("filled");
    expect(okx.placed()[1]).toMatchObject({
      body: { tdMode: "isolated", side: "sell", posSide: "long", sz: "0.28" },
      headers: { "OK-ACCESS-KEY": newKey, "x-simulated-trading": "1" },
    });
    expect(await fundsRow(userId)).toMatchObject({ balance: 0, locked: 0 });
    await user.mutation(api.okxConnections.disconnect, {});
    expect((await user.query(api.okxConnections.status, {})).connection).toBeNull();
    const { page } = await user.query(api.liveTrading.history, { paginationOpts: { numItems: 5, cursor: null } });
    expect(page).toMatchObject([{ _id: opened.positionId, status: "closed", okxMode: "demo" }]);
  });

  it("keeps the current key when its replacement has an unsupported account or position mode", async () => {
    const { user } = await setup();
    await user.action(api.okxConnections.connect, demo);
    const original = await user.query(api.okxConnections.status, {});
    const replacement = { ...demo, key: "replacement-key-5678" };

    okx.state.accountLevel = "4";
    await expect(user.action(api.okxConnections.connect, replacement)).rejects.toThrow(/Futures or Multi-currency margin/);
    okx.state.accountLevel = "2";
    okx.state.posMode = "net_mode";
    await expect(user.action(api.okxConnections.connect, replacement)).rejects.toThrow(/Long\/short position mode/);
    expect(okx.sent.some((req) => req.method === "POST")).toBe(false);
    expect(await user.query(api.okxConnections.status, {})).toEqual(original);
    expect(await user.action(api.okxConnections.balance, {})).toBe(42.5);
    expect(okx.sent.at(-1)?.headers["OK-ACCESS-KEY"]).toBe(demo.key);
  });

  it("rejects a slower key replacement after another replacement commits", async () => {
    const { user } = await setup();
    await user.action(api.okxConnections.connect, demo);
    const fetchOkx = okx.fetchMock.getMockImplementation()!;
    let verificationStarted!: () => void;
    const verifying = new Promise<void>((resolve) => { verificationStarted = resolve; });
    let releaseVerification!: () => void;
    const release = new Promise<void>((resolve) => { releaseVerification = resolve; });
    okx.fetchMock.mockImplementationOnce(async (input, init) => {
      const config = await fetchOkx(input, init);
      verificationStarted();
      await release;
      return config;
    });

    const stale = user.action(api.okxConnections.connect, { ...demo, key: "slower-key-4567" });
    const checkStale = expect(stale).rejects.toThrow(/connection changed/i);
    await verifying;
    const currentKey = "current-key-8901";
    try {
      await user.action(api.okxConnections.connect, { ...demo, key: currentKey });
    } finally {
      releaseVerification();
    }
    await checkStale;
    expect(await user.query(api.okxConnections.status, {})).toMatchObject({ connection: { keySuffix: "8901" } });
    expect(await user.action(api.okxConnections.balance, {})).toBe(42.5);
    expect(okx.sent.at(-1)?.headers["OK-ACCESS-KEY"]).toBe(currentKey);
  });

  it("signs order placement and lookup with the correct credentials when three accounts trade the same market", async () => {
    const { admin, user } = await setup();
    const live = { mode: "live" as const, key: "other-api-key-5678", secret: "other-secret", passphrase: "other-passphrase" };
    await user.action(api.okxConnections.connect, demo);
    okx.state.accountUid = "other-personal-uid";
    await admin.action(api.okxConnections.connect, live);
    const { connection: demoConnection } = await user.query(api.okxConnections.status, {});
    const { connection: liveConnection } = await admin.query(api.okxConnections.status, {});

    const [demoFill, liveFill, platformFill] = await Promise.all([
      user.action(api.liveTrading.open, { ...order, connectionRevision: demoConnection!.revision }),
      admin.action(api.liveTrading.open, { ...order, connectionRevision: liveConnection!.revision }),
      admin.action(api.liveTrading.open, { instId: AAPL, side: "down", margin: 50, leverage: 2 }),
    ]);
    expect([demoFill.outcome, liveFill.outcome, platformFill.outcome]).toEqual(["filled", "filled", "filled"]);
    expect(await user.query(api.liveTrading.personalPositions, {})).toMatchObject([{ _id: demoFill.positionId, okxMode: "demo" }]);
    expect(await admin.query(api.liveTrading.personalPositions, {})).toMatchObject([{ _id: liveFill.positionId, okxMode: "live" }]);
    expect(await admin.query(api.liveTrading.openFor, { instId: AAPL })).toMatchObject({ _id: platformFill.positionId });

    const cases = [
      { credentials: demo, host: "openapi.okx.com", marginMode: "isolated" },
      { credentials: live, host: "openapi.okx.com", marginMode: "isolated" },
      { credentials: { mode: "demo", key: "test-key", secret: "test-secret", passphrase: "test-pass" }, host: "www.okx.com", marginMode: "cross" },
    ];
    expect(okx.placed()).toHaveLength(cases.length);
    for (const { credentials, host, marginMode } of cases) {
      const placed = okx.placed().find((req) => req.headers["OK-ACCESS-KEY"] === credentials.key)!;
      expect(placed.body?.tdMode).toBe(marginMode);
      const lookup = okx.sent.find((req) => req.method === "GET" && req.path.endsWith(`&clOrdId=${placed.body!.clOrdId}`))!;
      for (const req of [placed, lookup]) {
        expect(req.host).toBe(host);
        expect(req.headers["OK-ACCESS-KEY"]).toBe(credentials.key);
        expect(req.headers["OK-ACCESS-PASSPHRASE"]).toBe(credentials.passphrase);
        expect(req.headers["x-simulated-trading"]).toBe(credentials.mode === "demo" ? "1" : undefined);
        const signature = await signOkx(credentials.secret, req.headers["OK-ACCESS-TIMESTAMP"], req.method, req.path, req.body ? JSON.stringify(req.body) : "");
        expect(req.headers["OK-ACCESS-SIGN"]).toBe(signature);
      }
    }
  });

  it("places one exchange order when the same user submits simultaneous opens or closes", async () => {
    const { user } = await setup();
    await user.action(api.okxConnections.connect, demo);
    const { connection } = await user.query(api.okxConnections.status, {});
    const args = { ...order, side: "down" as const, connectionRevision: connection!.revision };

    const opens = await Promise.allSettled([
      user.action(api.liveTrading.open, args),
      user.action(api.liveTrading.open, args),
    ]);
    expect(opens.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(opens.find((result) => result.status === "rejected")?.reason.message).toMatch(/already have a live/);
    expect(okx.placed()).toHaveLength(1);
    expect(okx.placed()[0].body).toMatchObject({ side: "sell", posSide: "short", sz: "0.28" });
    const [position] = await user.query(api.liveTrading.personalPositions, {});
    expect(position.status).toBe("open");

    okx.state.personalSize = position.contractsSz;
    okx.state.personalSide = "short";
    const closes = await Promise.allSettled([
      user.action(api.liveTrading.close, { positionId: position._id }),
      user.action(api.liveTrading.close, { positionId: position._id }),
    ]);
    const successfulCloses = closes.filter((result) => result.status === "fulfilled");
    expect(successfulCloses).toMatchObject([{ value: { outcome: "filled" } }]);
    expect(closes.find((result) => result.status === "rejected")?.reason.message).toMatch(/position is not open/);
    expect(okx.placed()).toHaveLength(2);
    expect(okx.placed()[1].body).toMatchObject({ side: "buy", posSide: "short", sz: "0.28", tdMode: "isolated" });
    expect(okx.placed()[1].body).not.toHaveProperty("reduceOnly");
    expect(await user.query(api.liveTrading.personalPositions, {})).toEqual([]);
  });

  it("settles partial fills, checks exchange size before closing, and preserves the CFX balance", async () => {
    const { user, userId, fundsRow } = await setup();
    await user.action(api.okxConnections.connect, demo);
    const { connection } = await user.query(api.okxConnections.status, {});
    okx.state.fillState = "canceled";
    okx.state.fill = { avgPx: "350", accFillSz: "0.20", fee: "-0.10" };
    const { positionId } = await user.action(api.liveTrading.open, { ...order, connectionRevision: connection!.revision });
    expect(okx.placed()[0].body?.sz).toBe("0.28");
    expect(await user.query(api.liveTrading.personalPositions, {})).toMatchObject([
      { _id: positionId, status: "open", contractsSz: "0.20", margin: 35, openFee: 0.1 },
    ]);

    okx.state.personalSize = "0.19";
    expect(await user.action(api.liveTrading.close, { positionId })).toMatchObject({
      outcome: "rejected", error: expect.stringMatching(/position size changed on OKX/),
    });
    expect(okx.placed()).toHaveLength(1);
    expect(await user.query(api.liveTrading.personalPositions, {})).toMatchObject([{ status: "open", contractsSz: "0.20" }]);

    okx.state.personalSize = "0.20";
    okx.state.fill = { avgPx: "360", accFillSz: "0.05", fee: "-0.02" };
    expect(await user.action(api.liveTrading.close, { positionId })).toMatchObject({ outcome: "filled", exit: null });
    const [remaining] = await user.query(api.liveTrading.personalPositions, {});
    expect(remaining).toMatchObject({ status: "open", contractsSz: "0.15", margin: 26.25 });
    expect(remaining.openFee).toBeCloseTo(0.075);

    okx.state.personalSize = "0.15";
    okx.state.fillState = "filled";
    okx.state.fill = { avgPx: "355", accFillSz: "0.15", fee: "-0.07" };
    const closed = await user.action(api.liveTrading.close, { positionId });
    expect(closed).toMatchObject({ outcome: "filled", exit: 355 });
    expect(closed.realized).toBeCloseTo(1.06);
    expect(okx.placed().map((req) => req.body?.sz)).toEqual(["0.28", "0.20", "0.15"]);
    expect(await fundsRow(userId)).toMatchObject({ balance: 1000, locked: 0 });
    const { page } = await user.query(api.liveTrading.history, { paginationOpts: { numItems: 5, cursor: null } });
    expect(page).toMatchObject([{ _id: positionId, status: "closed", exit: 355 }]);
  });

  it("protects existing exchange exposure and rejects an order whose setup expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { user } = await setup();
    await user.action(api.okxConnections.connect, demo);
    const { connection } = await user.query(api.okxConnections.status, {});
    const args = { ...order, connectionRevision: connection!.revision };
    okx.state.personalSize = "1";
    expect(await user.action(api.liveTrading.open, args)).toMatchObject({ outcome: "rejected", error: expect.stringMatching(/existing OKX isolated position/) });
    okx.state.personalSize = "0";
    okx.state.preparationDelayMs = 31_000;
    expect(await user.action(api.liveTrading.open, args)).toMatchObject({ outcome: "rejected", error: expect.stringMatching(/timed out/) });
    expect(await user.query(api.liveTrading.openFor, { instId: AAPL, venue: "personal" })).toBeNull();
    expect(okx.placed()).toHaveLength(0);
  });

  it("reconciles personal orders on their original environment with platform trading disabled", async () => {
    const { t, user } = await setup();
    delete process.env.OKX_TRADING_MODE;
    await user.action(api.okxConnections.connect, { ...demo, mode: "live" });
    const { connection } = await user.query(api.okxConnections.status, {});
    okx.state.nextPlace = "network";
    const opened = await user.action(api.liveTrading.open, { ...order, connectionRevision: connection!.revision });
    expect(opened.outcome).toBe("pending");
    expect(okx.placed()[0].headers["x-simulated-trading"]).toBeUndefined();
    const [pending] = await t.run((ctx) => ctx.db.query("liveOrders").take(1));
    okx.orders.set(pending.clOrdId, { ordId: "live-personal", state: "filled", avgPx: "353.50", accFillSz: pending.sz, fee: "-0.01" });
    await t.action(internal.liveTrading.reconcileOne, { orderId: pending._id });
    expect(okx.sent.at(-1)?.headers).toMatchObject({ "OK-ACCESS-KEY": demo.key });
    expect(okx.sent.at(-1)?.headers["x-simulated-trading"]).toBeUndefined();
    expect(await user.query(api.liveTrading.openFor, { instId: AAPL, venue: "personal" })).toMatchObject({ status: "open", entry: 353.5 });

    const closed = await user.action(api.liveTrading.close, { positionId: opened.positionId });
    expect(closed).toMatchObject({ outcome: "closed_externally", exit: null, realized: null });
    expect(okx.placed()).toHaveLength(1);
  });

  it("reconciles a timed-out close with a rotated key through the scheduler without resubmitting it", async () => {
    vi.useFakeTimers();
    const { t, user, userId, fundsRow } = await setup();
    await user.action(api.okxConnections.connect, demo);
    const { connection } = await user.query(api.okxConnections.status, {});
    const { positionId } = await user.action(api.liveTrading.open, { ...order, connectionRevision: connection!.revision });
    okx.state.personalSize = "0.28";
    okx.state.nextPlace = "timeout";
    expect(await user.action(api.liveTrading.close, { positionId })).toMatchObject({ outcome: "pending" });
    expect(await user.query(api.liveTrading.personalPositions, {})).toMatchObject([{ status: "closing" }]);
    await expect(user.mutation(api.okxConnections.disconnect, {})).rejects.toThrow(/pending orders/);

    const newKey = "rotated-demo-key-5678";
    await user.action(api.okxConnections.connect, { ...demo, key: newKey });
    const [pending] = await t.query(internal.liveTrading.pendingOrders, {});
    expect(pending).toMatchObject({ kind: "close", sz: "0.28" });
    await vi.advanceTimersByTimeAsync(5_000);
    await t.finishInProgressScheduledFunctions();
    expect(await t.query(internal.liveTrading.getOrderRow, { orderId: pending._id })).toMatchObject({ status: "pending", attempts: 1 });

    okx.orders.set(pending.clOrdId, { ordId: "close-fill", state: "filled", avgPx: "356", accFillSz: "0.28", fee: "-0.03" });
    await vi.advanceTimersByTimeAsync(25_000);
    await t.action(internal.liveTrading.reconcilePending, {});
    await t.action(internal.liveTrading.reconcileOne, { orderId: pending._id });
    const lookups = okx.sent.filter((req) => req.method === "GET" && req.path.endsWith(`&clOrdId=${pending.clOrdId}`));
    expect(lookups).toHaveLength(2);
    for (const req of lookups) {
      expect(req.headers).toMatchObject({ "OK-ACCESS-KEY": newKey, "x-simulated-trading": "1" });
    }
    expect(okx.placed()).toHaveLength(2);
    expect(await user.query(api.liveTrading.personalPositions, {})).toEqual([]);
    expect(await fundsRow(userId)).toMatchObject({ balance: 1000, locked: 0 });
    const { page } = await user.query(api.activity.listMine, { kind: "live_position_closed", paginationOpts: { numItems: 5, cursor: null } });
    expect(page).toHaveLength(1);
    expect(page[0]).not.toHaveProperty("balanceAfter");
  });
});

async function setup(usd = 1000) {
  const t = convexTest(schema, modules);
  const admin = t.withIdentity(ADMIN);
  const user = t.withIdentity(USER);
  const adminId = await admin.mutation(api.users.store, {});
  const userId = await user.mutation(api.users.store, {});
  await t.run(async (ctx) => {
    for (const id of [adminId, userId]) {
      await ctx.db.insert("funds", { userId: id, currency: "USD", mode: "live", balance: usd, locked: 0 });
    }
  });
  const usdOf = (who: typeof admin) => who.query(api.funds.usd, {});
  const fundsRow = (id: typeof adminId) =>
    t.run(async (ctx) =>
      ctx.db.query("funds").withIndex("by_userId_and_currency", (q) => q.eq("userId", id).eq("currency", "USD")).unique(),
    );
  return { t, admin, user, adminId, userId, usdOf, fundsRow };
}

// ─── tests ───────────────────────────────────────────────────

describe("switches and access", () => {
  it("is disabled without keys, and refuses to trade", async () => {
    delete process.env.OKX_API_KEY;
    const { admin } = await setup();
    expect(await admin.query(api.liveTrading.config, {})).toMatchObject({ enabled: false, canTrade: false });
    await expect(admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 2 })).rejects.toThrow(/not enabled/);
    expect(okx.placed()).toHaveLength(0);
  });

  it("is admins-only by default", async () => {
    const { admin, user } = await setup();
    expect(await admin.query(api.liveTrading.config, {})).toMatchObject({ enabled: true, mode: "demo", canTrade: true });
    expect(await user.query(api.liveTrading.config, {})).toMatchObject({ canTrade: false });
    await expect(user.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 2 })).rejects.toThrow(/admins/);
    expect(okx.placed()).toHaveLength(0);

    process.env.OKX_TRADING_ACCESS = "all";
    expect(await user.query(api.liveTrading.config, {})).toMatchObject({ canTrade: true });
  });
});

describe("open", () => {
  it("places a signed demo market order and books the ACTUAL fill", async () => {
    const { admin, adminId, fundsRow } = await setup(1000);
    const r = await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    expect(r).toMatchObject({ outcome: "filled", error: null });

    const [order] = okx.placed();
    // $500 notional / $353.36 ask = 1.415 → rounded DOWN to whole 0.01 lots
    expect(order.body).toMatchObject({ instId: AAPL, tdMode: "cross", side: "buy", posSide: "long", ordType: "market", sz: "1.41" });
    expect(order.body?.reduceOnly).toBeUndefined();
    expect(order.headers["x-simulated-trading"]).toBe("1");
    expect(order.headers["OK-ACCESS-KEY"]).toBe("test-key");
    expect(order.headers["OK-ACCESS-SIGN"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(okx.sent.some((s) => s.path === "/api/v5/account/set-leverage" && s.body?.lever === "10")).toBe(true);

    const pos = await admin.query(api.liveTrading.openFor, { instId: AAPL });
    const margin = (1.41 * 353.36) / 10;
    expect(pos).toMatchObject({ status: "open", entry: 353.4, contractsSz: "1.41", openFee: 0.25 });
    expect(pos!.margin).toBeCloseTo(margin, 6);
    const funds = await fundsRow(adminId);
    expect(funds!.balance).toBeCloseTo(1000 - margin - 0.25, 6);
    expect(funds!.locked).toBeCloseTo(margin, 6);
  });

  it("switches the account to long/short mode if needed", async () => {
    okx.state.posMode = "net_mode";
    const { admin } = await setup();
    await admin.action(api.liveTrading.open, { instId: AAPL, side: "down", margin: 30, leverage: 2 });
    expect(okx.sent.some((s) => s.path === "/api/v5/account/set-position-mode" && s.body?.posMode === "long_short_mode")).toBe(true);
    expect(okx.placed()[0].body).toMatchObject({ side: "sell", posSide: "short" });
  });

  it("an OKX rejection releases every reserved cent", async () => {
    okx.state.nextPlace = "reject";
    const { admin, adminId, fundsRow } = await setup(1000);
    const r = await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    expect(r.outcome).toBe("rejected");
    expect(r.error).toMatch(/51008/);
    expect(await fundsRow(adminId)).toMatchObject({ balance: 1000, locked: 0 });
    expect(await admin.query(api.liveTrading.openFor, { instId: AAPL })).toBeNull();
  });

  it("enforces limits BEFORE anything is sent", async () => {
    process.env.OKX_MAX_ORDER_USD = "100";
    const { admin } = await setup(1000);
    await expect(admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 })).rejects.toThrow(/Max order size/);
    await expect(admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 5, leverage: 11 })).rejects.toThrow(/Max multiplier/);
    await expect(admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 0.5, leverage: 1 })).rejects.toThrow(/minimum order/);
    expect(okx.placed()).toHaveLength(0);
  });

  it("requires enough USD balance, and allows one live position per instrument", async () => {
    const { admin } = await setup(20);
    await expect(admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 2 })).rejects.toThrow(/Not enough USD/);
    expect(okx.placed()).toHaveLength(0);
    await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 10, leverage: 2 });
    await expect(admin.action(api.liveTrading.open, { instId: AAPL, side: "down", margin: 5, leverage: 2 })).rejects.toThrow(/already have a live/);
    expect(okx.placed()).toHaveLength(1);
  });
});

describe("crash safety", () => {
  it("a network failure leaves the order pending; the reconciler settles the real fill", async () => {
    const { t, admin, adminId, fundsRow } = await setup(1000);
    okx.state.nextPlace = "network";
    const r = await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    expect(r.outcome).toBe("pending");
    expect((await fundsRow(adminId))!.balance).toBeLessThan(1000); // still reserved, not released

    // OKX actually did receive it: simulate the order existing, then reconcile.
    const [order] = await t.run((ctx) => ctx.db.query("liveOrders").collect());
    okx.orders.set(order.clOrdId, { ordId: "ordX", state: "filled", avgPx: "353.50", accFillSz: order.sz, fee: "-0.25" });
    await t.action(internal.liveTrading.reconcileOne, { orderId: order._id });
    expect(await admin.query(api.liveTrading.openFor, { instId: AAPL })).toMatchObject({ status: "open", entry: 353.5 });
  });

  it("a timeout code is NOT treated as a rejection", async () => {
    okx.state.nextPlace = "timeout";
    const { admin } = await setup(1000);
    const r = await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    expect(r.outcome).toBe("pending");
    expect(await admin.query(api.liveTrading.openFor, { instId: AAPL })).toMatchObject({ status: "opening" });
  });

  it("an order OKX never received is failed and refunded after the grace period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { t, admin, adminId, fundsRow } = await setup(1000);
    okx.state.nextPlace = "network";
    await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    const [order] = await t.run((ctx) => ctx.db.query("liveOrders").collect());

    await t.action(internal.liveTrading.reconcileOne, { orderId: order._id }); // too early: still pending
    expect((await t.run((ctx) => ctx.db.get("liveOrders", order._id)))!.status).toBe("pending");

    vi.setSystemTime(Date.now() + 3 * 60_000);
    await t.action(internal.liveTrading.reconcileOne, { orderId: order._id });
    expect((await t.run((ctx) => ctx.db.get("liveOrders", order._id)))!.status).toBe("failed");
    expect(await fundsRow(adminId)).toMatchObject({ balance: 1000, locked: 0 });
  });

  it("settling the same fill twice never double-books", async () => {
    const { t, admin, adminId, fundsRow } = await setup(1000);
    await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    const before = await fundsRow(adminId);
    const [order] = await t.run((ctx) => ctx.db.query("liveOrders").collect());
    await t.mutation(internal.liveTrading.settleOrder, { orderId: order._id, ordId: "x", state: "filled", avgPx: 999, accFillSz: "9", fee: -9 });
    expect(await fundsRow(adminId)).toMatchObject({ balance: before!.balance, locked: before!.locked });
  });
});

describe("close + liquidation", () => {
  it("backfills user counts and deduplicates paper and OKX positions per side", async () => {
    const { t, admin, user, adminId, userId } = await setup();
    const market = { instId: AAPL, base: "AAPL", category: "stock" as const };
    const prices = { entry: 353.4, margin: 50, leverage: 2, size: 0.28, openFee: 0.05 };
    const userPaperId = await t.run(async (ctx) => {
      const openedAt = Date.now();
      await ctx.db.insert("positions", { ...market, ...prices, userId: adminId, side: "up", status: "open", openedAt });
      await ctx.db.insert("livePositions", {
        ...market, ...prices, ctVal: 1, contractsSz: "0.28", userId, side: "up", status: "closing", openedAt,
      });
      return await ctx.db.insert("positions", { ...market, ...prices, userId, side: "down", status: "open", openedAt });
    });
    const readCounts = () => t.query(api.positions.userCountsForAsset, { instId: AAPL });
    expect(await readCounts()).toBeNull();
    vi.useFakeTimers();
    try {
      await t.mutation(api.positions.initializeAssetPositionCounts, { instId: AAPL });
      await t.mutation(api.positions.initializeAssetPositionCounts, { instId: AAPL });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(await readCounts()).toEqual({ up: 2, down: 1 });
    expect(await t.query(api.positions.userCountsForAsset, { instId: "BTC-USDT-SWAP" })).toEqual({ up: 0, down: 0 });

    const { positionId } = await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 2 });
    expect(await readCounts()).toEqual({ up: 2, down: 1 });
    await admin.action(api.liveTrading.close, { positionId });
    expect(await readCounts()).toEqual({ up: 2, down: 1 });
    await user.mutation(internal.positions.settle, { positionId: userPaperId, exit: 351, liquidated: false, asOwner: true });
    expect(await readCounts()).toEqual({ up: 2, down: 0 });
    const liveOnly = await admin.action(api.liveTrading.open, { instId: AAPL, side: "down", margin: 50, leverage: 2 });
    expect(await readCounts()).toEqual({ up: 2, down: 1 });
    await admin.action(api.liveTrading.close, { positionId: liveOnly.positionId });
    expect(await readCounts()).toEqual({ up: 2, down: 0 });
  });

  it("close sends a reduce-only order and the balance moves by exactly the realized PnL", async () => {
    const { admin, adminId, user, fundsRow } = await setup(1000);
    const paginationOpts = { numItems: 5, cursor: null };
    const { positionId } = await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    expect((await admin.query(api.liveTrading.history, { paginationOpts })).page).toEqual([]);
    okx.state.fill = { avgPx: "360.00", accFillSz: "", fee: "-0.26" };
    const r = await admin.action(api.liveTrading.close, { positionId });
    expect(r.outcome).toBe("filled");
    expect(okx.placed()[1].body).toMatchObject({ side: "sell", posSide: "long", sz: "1.41", reduceOnly: true });

    const [closed] = (await admin.query(api.liveTrading.listMine, { status: "closed", paginationOpts: { numItems: 5, cursor: null } })).page;
    const expected = (360 - 353.4) * 1.41 - 0.25 - 0.26;
    expect(closed.realized).toBeCloseTo(expected, 6);
    expect((await admin.query(api.liveTrading.history, { paginationOpts })).page).toEqual([closed]);
    expect((await user.query(api.liveTrading.history, { paginationOpts })).page).toEqual([]);
    const funds = await fundsRow(adminId);
    expect(funds!.balance).toBeCloseTo(1000 + expected, 6);
    expect(funds!.locked).toBeCloseTo(0, 9);
  });

  it("a partial close keeps the remainder open with exact contracts", async () => {
    const { admin } = await setup(1000);
    const { positionId } = await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    okx.state.fill = { avgPx: "353.40", accFillSz: "0.41", fee: "-0.07" };
    await admin.action(api.liveTrading.close, { positionId });
    expect(await admin.query(api.liveTrading.openFor, { instId: AAPL })).toMatchObject({ status: "open", contractsSz: "1" });
  });

  it("another user cannot close someone else's position", async () => {
    process.env.OKX_TRADING_ACCESS = "all";
    const { admin, user } = await setup(1000);
    const { positionId } = await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    await expect(user.action(api.liveTrading.close, { positionId })).rejects.toThrow(/not found/);
    expect(okx.placed()).toHaveLength(1);
  });

  it("the sweep liquidates on mark; a gap loss beyond margin is the platform's, not the user's", async () => {
    const { admin, adminId, fundsRow } = await setup(1000);
    await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    const margin = (1.41 * 353.36) / 10;
    const pos = (await admin.query(api.liveTrading.openFor, { instId: AAPL }))!;
    const liqPx = liquidationPrice({ ...pos, openedAt: 0 });
    expect(liqPx).toBeGreaterThan(319);
    expect(liqPx).toBeLessThan(321);

    okx.state.mark = liqPx - 0.5; // just through the ledger liquidation price
    okx.state.fill = { avgPx: "300.00", accFillSz: "", fee: "-0.21" }; // gapped far through it
    expect(await admin.action(internal.liveTrading.sweepLiquidations, {})).toBe(1);
    expect(okx.placed()[1].body).toMatchObject({ side: "sell", posSide: "long", reduceOnly: true });

    const [liq] = (await admin.query(api.liveTrading.listMine, { status: "liquidated", paginationOpts: { numItems: 5, cursor: null } })).page;
    expect(liq.realized).toBeCloseTo(-(margin + 0.25), 6); // lost margin + opening fee, nothing more
    const funds = await fundsRow(adminId);
    expect(funds!.balance).toBeCloseTo(1000 - margin - 0.25, 6);
    expect(funds!.locked).toBeCloseTo(0, 9);
  });

  it("the sweep leaves healthy positions alone", async () => {
    const { admin } = await setup(1000);
    await admin.action(api.liveTrading.open, { instId: AAPL, side: "up", margin: 50, leverage: 10 });
    okx.state.mark = 321; // down ~9%, but still above the ~319.8 liquidation price
    expect(await admin.action(internal.liveTrading.sweepLiquidations, {})).toBe(0);
    expect(okx.placed()).toHaveLength(1);
  });
});
