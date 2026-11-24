/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { STARTING_BALANCE, TAKER_FEE, exitPriceForPnl, netPnlAtExit } from "../src/lib/paper/math";

const modules = import.meta.glob("./**/*.ts");

const ALICE = { subject: "alice-uid", tokenIdentifier: "firebase|alice", email: "alice@example.test", name: "Alice" };
const BOB = { subject: "bob-uid", tokenIdentifier: "firebase|bob", email: "bob@example.test", name: "Bob" };

const AAPL = { instId: "AAPL-USDT-SWAP", base: "AAPL", category: "stock" as const };
const page = { numItems: 20, cursor: null };

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);
  const bob = t.withIdentity(BOB);
  await alice.mutation(api.users.store, {});
  await bob.mutation(api.users.store, {});
  return { t, alice, bob };
}

describe("users + funds", () => {
  it("store creates the user once, with a paper balance and an activity entry", async () => {
    const { t, alice } = await setup();
    const id1 = await alice.mutation(api.users.store, {});
    const id2 = await alice.mutation(api.users.store, {});
    expect(id1).toEqual(id2);

    const me = await alice.query(api.users.me, {});
    expect(me).toMatchObject({ email: ALICE.email, name: "Alice", role: "user", firebaseUid: "alice-uid" });
    expect(await alice.query(api.funds.mine, {})).toMatchObject({ balance: STARTING_BALANCE, locked: 0, currency: "USDT" });

    const feed = await alice.query(api.activity.listMine, { paginationOpts: page });
    expect(feed.page.map((a) => a.kind)).toEqual(["account_created"]);
    expect(await t.query(api.users.me, {})).toBeNull(); // signed out
  });

  it("signed-out callers cannot write", async () => {
    const { t } = await setup();
    await expect(t.mutation(api.users.store, {})).rejects.toThrow(/Not signed in/);
    await expect(t.mutation(api.funds.resetPaper, {})).rejects.toThrow(/Not signed in/);
  });
});

describe("positions", () => {
  it.each([
    { stopLoss: null, takeProfit: 15, bid: 114, ask: 104, reason: "total_take_profit" },
    { stopLoss: -15, takeProfit: null, bid: 86, ask: 96, reason: "total_stop_loss" },
  ])("closes the whole paper basket once for $reason", async ({ stopLoss, takeProfit, bid, ask, reason }) => {
    const { t, alice, bob } = await setup();
    const btc = { instId: "BTC-USDT-SWAP", base: "BTC", category: "crypto" as const };
    const longId = await alice.mutation(internal.positions.openPriced, { ...AAPL, side: "up", margin: 100, leverage: 2, entry: 100 });
    const shortId = await alice.mutation(internal.positions.openPriced, { ...btc, side: "down", margin: 100, leverage: 2, entry: 100 });
    await bob.mutation(internal.positions.openPriced, { ...AAPL, side: "up", margin: 100, leverage: 2, entry: 100 });
    await expect(t.mutation(api.positions.setTotalExitTargets, { stopLoss, takeProfit })).rejects.toThrow(/Not signed in/);
    await expect(alice.mutation(api.positions.setTotalExitTargets, { stopLoss: 15, takeProfit })).rejects.toThrow(/negative/);
    await alice.mutation(api.positions.setTotalExitTargets, { stopLoss, takeProfit });

    const funds = (await alice.query(api.funds.mine, {}))!;
    const setAt = funds.totalExitTargets!.setAt;
    const quote = { instId: AAPL.instId, mark: 100, bid, ask: bid + 1 };
    const quotes = [quote, { instId: btc.instId, mark: 100, bid: ask - 1, ask }];
    expect(await t.mutation(internal.positions.settleTotalExitTargets, {
      fundsId: funds._id, setAt, checkedAt: setAt, quotes: [quote],
    })).toBe(0);
    expect(await t.mutation(internal.positions.settleTotalExitTargets, {
      fundsId: funds._id, setAt: setAt - 1, checkedAt: setAt, quotes,
    })).toBe(0);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const data = quotes.map(({ instId, mark, bid, ask }) => String(input).includes("mark-price")
        ? { instId, markPx: String(mark) }
        : { instId, bidPx: String(bid), askPx: String(ask) });
      return Response.json({ code: "0", data });
    });
    try {
      await t.action(internal.positions.sweepTotalExitTargets, {});
      await t.action(internal.positions.sweepTotalExitTargets, {});
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
    const history = (await alice.query(api.positions.history, { paginationOpts: page })).page;
    expect(history).toHaveLength(2);
    expect(history.find((p) => p._id === longId)).toMatchObject({ exit: bid, autoExitReason: reason });
    expect(history.find((p) => p._id === shortId)).toMatchObject({ exit: ask, autoExitReason: reason });
    const after = (await alice.query(api.funds.mine, {}))!;
    expect(after.totalExitTargets).toBeUndefined();
    expect(after.locked).toBe(0);
    expect(after.balance).toBeCloseTo(STARTING_BALANCE + history.reduce((pnl, fill) => pnl + fill.realized!, 0));
    expect(await bob.query(api.positions.openFor, { instId: AAPL.instId })).not.toBeNull();
  });

  it("keeps a total exit armed after a partial manual close and clears it when the account is flat", async () => {
    const { alice } = await setup();
    const targets = { stopLoss: -25, takeProfit: null };
    await expect(alice.mutation(api.positions.setTotalExitTargets, targets)).rejects.toThrow(/No open/);
    const a = await alice.mutation(internal.positions.openPriced, { ...AAPL, side: "up", margin: 100, leverage: 2, entry: 100 });
    const b = await alice.mutation(internal.positions.openPriced, { ...AAPL, instId: "BTC-USDT-SWAP", base: "BTC", side: "down", margin: 100, leverage: 2, entry: 100 });
    await alice.mutation(api.positions.setTotalExitTargets, targets);
    await alice.mutation(internal.positions.settle, { positionId: a, exit: 100, liquidated: false, asOwner: true });
    expect((await alice.query(api.funds.mine, {}))?.totalExitTargets).toMatchObject(targets);
    await alice.mutation(internal.positions.settle, { positionId: b, exit: 100, liquidated: false, asOwner: true });
    expect((await alice.query(api.funds.mine, {}))?.totalExitTargets).toBeUndefined();
  });

  it("saves owner-only exit targets and settles the stop loss and take profit at the executable quote", async () => {
    const { t, alice, bob } = await setup();
    const longId = await alice.mutation(internal.positions.openPriced, { ...AAPL, side: "up", margin: 100, leverage: 2, entry: 100 });
    const shortId = await alice.mutation(internal.positions.openPriced, { ...AAPL, instId: "BTC-USDT-SWAP", base: "BTC", side: "down", margin: 100, leverage: 2, entry: 100 });
    const long = (await alice.query(api.positions.openFor, { instId: AAPL.instId }))!;
    const short = (await alice.query(api.positions.openFor, { instId: "BTC-USDT-SWAP" }))!;
    expect(netPnlAtExit(long, exitPriceForPnl(long, -10))).toBeCloseTo(-10, 10);
    expect(netPnlAtExit(short, exitPriceForPnl(short, 10))).toBeCloseTo(10, 10);
    await expect(bob.mutation(api.positions.setExitTargets, { positionId: longId, stopLoss: -10, takeProfit: null })).rejects.toThrow(/not found/);
    await expect(alice.mutation(api.positions.setExitTargets, { positionId: longId, stopLoss: -200, takeProfit: null })).rejects.toThrow(/before liquidation/);
    await alice.mutation(api.positions.setExitTargets, { positionId: longId, stopLoss: -10, takeProfit: null });
    await alice.mutation(api.positions.setExitTargets, { positionId: shortId, stopLoss: null, takeProfit: 10 });
    expect(await t.mutation(internal.positions.settleExitTargets, {
      checkedAt: Date.now(), quotes: [{ positionId: longId, exit: 94, mark: 40 }, { positionId: shortId, exit: 96, mark: 96 }],
    })).toBe(0);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const data = String(input).includes("mark-price")
        ? [{ instId: long.instId, markPx: "94.5" }, { instId: short.instId, markPx: "94.5" }]
        : [{ instId: long.instId, bidPx: "94", askPx: "96" }, { instId: short.instId, bidPx: "93", askPx: "94" }];
      return Response.json({ code: "0", data });
    });
    try {
      await t.action(internal.positions.sweepExitTargets, {});
      await t.action(internal.positions.sweepExitTargets, {});
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
    const history = (await alice.query(api.positions.history, { paginationOpts: page })).page;
    expect(history).toHaveLength(2);
    expect(history.find((p) => p._id === longId)).toMatchObject({ exit: 94, autoExitReason: "stop_loss", realized: netPnlAtExit(long, 94) });
    expect(history.find((p) => p._id === shortId)).toMatchObject({ exit: 94, autoExitReason: "take_profit", realized: netPnlAtExit(short, 94) });
    expect(await alice.query(api.funds.mine, {})).toMatchObject({ locked: 0 });
  });

  it("open → close moves funds by exactly the realized PnL and records activity", async () => {
    const { alice } = await setup();
    const id = await alice.mutation(internal.positions.openPriced, { ...AAPL, side: "up", margin: 500, leverage: 10, entry: 100 });

    const openFee = 5000 * TAKER_FEE;
    expect(await alice.query(api.funds.mine, {})).toMatchObject({ balance: STARTING_BALANCE - 500 - openFee, locked: 500 });
    expect(await alice.query(api.positions.openFor, { instId: AAPL.instId })).toMatchObject({ _id: id, size: 50 });

    const realized = await alice.mutation(internal.positions.settle, { positionId: id, exit: 102, liquidated: false, asOwner: true });
    expect(realized).toBeCloseTo(100 - openFee - 5100 * TAKER_FEE);

    const funds = await alice.query(api.funds.mine, {});
    expect(funds!.balance).toBeCloseTo(STARTING_BALANCE + realized);
    expect(funds!.locked).toBe(0);
    expect(await alice.query(api.positions.openFor, { instId: AAPL.instId })).toBeNull();

    const closed = await alice.query(api.positions.listMine, { status: "closed", paginationOpts: page });
    expect(closed.page[0]).toMatchObject({ status: "closed", exit: 102 });
    const feed = await alice.query(api.activity.listMine, { paginationOpts: page });
    expect(feed.page.map((a) => a.kind)).toEqual(["position_closed", "position_opened", "account_created"]);
  });

  it("rejects a second open position on the same instrument and oversize margin", async () => {
    const { alice } = await setup();
    await alice.mutation(internal.positions.openPriced, { ...AAPL, side: "up", margin: 100, leverage: 2, entry: 100 });
    await expect(
      alice.mutation(internal.positions.openPriced, { ...AAPL, side: "down", margin: 100, leverage: 2, entry: 100 }),
    ).rejects.toThrow(/Close your open AAPL/);
    await expect(
      alice.mutation(internal.positions.openPriced, { instId: "BTC-USDT-SWAP", base: "BTC", category: "crypto", side: "up", margin: 50_000, leverage: 2, entry: 100 }),
    ).rejects.toThrow(/Not enough/);
  });

  it("paginates only the owner's completed trades in closing order", async () => {
    const { t, alice, bob } = await setup();
    const args = { ...AAPL, side: "up" as const, margin: 100, leverage: 5, entry: 100 };
    const olderOpen = await alice.mutation(internal.positions.openPriced, args);
    const newerOpen = await alice.mutation(internal.positions.openPriced, { ...args, instId: "BTC-USDT-SWAP", base: "BTC" });
    await alice.mutation(internal.positions.settle, { positionId: newerOpen, exit: 101, liquidated: false, asOwner: true });
    await alice.mutation(internal.positions.settle, { positionId: olderOpen, exit: 80, liquidated: true, asOwner: true });
    await alice.mutation(internal.positions.openPriced, args);
    await t.run(async (ctx) => {
      await ctx.db.patch("positions", newerOpen, { closedAt: 100 });
      await ctx.db.patch("positions", olderOpen, { closedAt: 200 });
    });

    const first = await alice.query(api.positions.history, { paginationOpts: { numItems: 1, cursor: null } });
    expect(first.page).toMatchObject([{ _id: olderOpen, status: "liquidated" }]);
    expect(first.isDone).toBe(false);
    const next = await alice.query(api.positions.history, { paginationOpts: { numItems: 10, cursor: first.continueCursor } });
    expect(next.page).toMatchObject([{ _id: newerOpen, status: "closed", exit: 101 }]);
    expect(next.isDone).toBe(true);
    expect((await bob.query(api.positions.history, { paginationOpts: page })).page).toEqual([]);
    expect((await t.query(api.positions.history, { paginationOpts: page })).page).toEqual([]);
  });

  it("another user cannot see or close someone else's position", async () => {
    const { alice, bob } = await setup();
    const id = await alice.mutation(internal.positions.openPriced, { ...AAPL, side: "up", margin: 100, leverage: 5, entry: 100 });

    expect(await bob.query(api.positions.openFor, { instId: AAPL.instId })).toBeNull();
    expect((await bob.query(api.positions.listMine, { status: "open", paginationOpts: page })).page).toHaveLength(0);
    expect(await bob.query(internal.positions.getOwnedOpen, { positionId: id })).toBeNull();
    await expect(
      bob.mutation(internal.positions.settle, { positionId: id, exit: 200, liquidated: false, asOwner: true }),
    ).rejects.toThrow(/not found/);
    expect(await alice.query(api.positions.openFor, { instId: AAPL.instId })).not.toBeNull();
  });

  it("the sweep liquidates only positions whose mark crossed, forfeiting margin + fee", async () => {
    const { alice, bob } = await setup();
    // Alice: 20× long from 100 → liq ≈ 95.5. Bob: 2× long → liq ≈ 50.
    await alice.mutation(internal.positions.openPriced, { ...AAPL, side: "up", margin: 1000, leverage: 20, entry: 100 });
    await bob.mutation(internal.positions.openPriced, { ...AAPL, side: "up", margin: 1000, leverage: 2, entry: 100 });

    const count = await alice.mutation(internal.positions.liquidateCrossed, { marks: [{ instId: AAPL.instId, markPx: 94 }] });
    expect(count).toBe(1);

    const liquidated = await alice.query(api.positions.listMine, { status: "liquidated", paginationOpts: page });
    expect(liquidated.page).toHaveLength(1);
    expect((await alice.query(api.funds.mine, {}))!.balance).toBeCloseTo(STARTING_BALANCE - 1000 - 20_000 * TAKER_FEE);
    expect(await bob.query(api.positions.openFor, { instId: AAPL.instId })).not.toBeNull();
  });
});

describe("reset + logs", () => {
  it("reset is blocked while a position is open, then restores the balance", async () => {
    const { alice } = await setup();
    const id = await alice.mutation(internal.positions.openPriced, { ...AAPL, side: "down", margin: 100, leverage: 3, entry: 100 });
    await expect(alice.mutation(api.funds.resetPaper, {})).rejects.toThrow(/Close your open positions/);
    await alice.mutation(internal.positions.settle, { positionId: id, exit: 90, liquidated: false, asOwner: true });
    await alice.mutation(api.funds.resetPaper, {});
    expect(await alice.query(api.funds.mine, {})).toMatchObject({ balance: STARTING_BALANCE, locked: 0 });
  });

  it("logs are admin-only (role or Firebase admin claim)", async () => {
    const { t, alice } = await setup();
    await expect(alice.query(api.logs.list, { paginationOpts: page })).rejects.toThrow(/Admins only/);

    const admin = t.withIdentity({ subject: "root", tokenIdentifier: "firebase|root", admin: true });
    await admin.mutation(api.users.store, {});
    const logs = await admin.query(api.logs.list, { paginationOpts: page });
    expect(logs.page.some((l) => l.source === "users.store")).toBe(true);
  });
});
