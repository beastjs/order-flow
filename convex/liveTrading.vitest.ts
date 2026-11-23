/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { liquidationPrice } from "../src/lib/paper/math";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = { subject: "root", tokenIdentifier: "firebase|root", admin: true };
const USER = { subject: "u", tokenIdentifier: "firebase|u" };
const AAPL = "AAPL-USDT-SWAP";

// ─── fake OKX ────────────────────────────────────────────────

interface Sent {
  method: string;
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
    posMode: "long_short_mode",
  };
  const ok = (data: unknown[]) => new Response(JSON.stringify({ code: "0", msg: "", data }));

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, path, body, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})) });

    if (url.pathname === "/api/v5/public/instruments") {
      return ok([{ instId: AAPL, state: "live", settleCcy: "USDT", ctValCcy: "AAPL", instCategory: "3", lever: "20", ctVal: "1", lotSz: "0.01", minSz: "0.01", ruleType: "normal" }]);
    }
    if (url.pathname === "/api/v5/market/ticker") return ok([{ bidPx: String(state.bid), askPx: String(state.ask) }]);
    if (url.pathname === "/api/v5/public/mark-price") return ok([{ instId: AAPL, markPx: String(state.mark) }]);
    if (url.pathname === "/api/v5/account/config") return ok([{ posMode: state.posMode }]);
    if (url.pathname === "/api/v5/account/set-position-mode") {
      state.posMode = "long_short_mode";
      return ok([{}]);
    }
    if (url.pathname === "/api/v5/account/set-leverage") return ok([{}]);
    if (url.pathname === "/api/v5/trade/order" && method === "POST") {
      if (state.nextPlace === "network") throw new TypeError("fetch failed");
      if (state.nextPlace === "timeout") return new Response(JSON.stringify({ code: "50004", msg: "API endpoint request timeout", data: [] }));
      if (state.nextPlace === "reject") {
        return new Response(JSON.stringify({ code: "1", msg: "", data: [{ sCode: "51008", sMsg: "Order failed. Insufficient USDT margin in account" }] }));
      }
      const ordId = `ord${orders.size + 1}`;
      orders.set(String(body.clOrdId), {
        ordId,
        state: "filled",
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
