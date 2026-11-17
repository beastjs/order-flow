/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { STARTING_BALANCE, TAKER_FEE } from "../src/lib/paper/math";

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
