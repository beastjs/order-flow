/// <reference types="vite/client" />
// ─── Paper positions: the public actions, with OKX scripted ───────────
// Covers what backend.vitest.ts doesn't: input validation on the public
// `open` action, server-side pricing (the client can't name a price),
// double-close races, insufficient funds, the loss floor, and a
// conservation invariant over a random trading session.
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { STARTING_BALANCE, TAKER_FEE } from "../src/lib/paper/math";

const okx = {
  swap: { instId: "BTC-USDT-SWAP", base: "BTC", category: "crypto" as const, maxLeverage: 50, ctVal: 0.01, lotSz: "0.01", minSz: "0.01", ruleType: "normal" },
  quote: { bid: 99, ask: 101 },
  marks: new Map<string, number>(),
};

vi.mock("./lib/okx", () => ({
  fetchSwap: async (instId: string) => {
    if (!/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(instId)) throw new Error("Unsupported instrument.");
    return { ...okx.swap, instId, base: instId.split("-")[0] };
  },
  fetchQuote: async () => okx.quote,
  fetchAllMarks: async () => okx.marks,
}));

const modules = import.meta.glob("./**/*.ts");
const ALICE = { subject: "alice", tokenIdentifier: "firebase|alice" };
const BOB = { subject: "bob", tokenIdentifier: "firebase|bob" };
const open = (args: Partial<{ instId: string; side: "up" | "down"; margin: number; leverage: number }> = {}) => ({
  instId: "BTC-USDT-SWAP",
  side: "up" as const,
  margin: 100,
  leverage: 10,
  ...args,
});

beforeEach(() => {
  okx.quote = { bid: 99, ask: 101 };
  okx.marks = new Map();
});

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE);
  const bob = t.withIdentity(BOB);
  await alice.mutation(api.users.store, {});
  await bob.mutation(api.users.store, {});
  return { t, alice, bob };
}

type Caller = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
const balance = async (u: Caller) => (await u.query(api.funds.mine, {}))!;

describe("positions.open (public action)", () => {
  it("rejects every malformed amount and multiplier before touching OKX or funds", async () => {
    const { alice } = await setup();
    for (const margin of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001]) {
      await expect(alice.action(api.positions.open, open({ margin }))).rejects.toThrow(/Invalid amount/);
    }
    for (const leverage of [0, -2, 1.5, Number.NaN]) {
      await expect(alice.action(api.positions.open, open({ leverage }))).rejects.toThrow(/Invalid multiplier/);
    }
    await expect(alice.action(api.positions.open, open({ leverage: 51 }))).rejects.toThrow(/Max multiplier for BTC is 50×/);
    for (const instId of ["btc-usdt-swap", "BTC-USDC-SWAP", "BTC-USDT", "../../etc", "BTC-USDT-SWAP&x=1"]) {
      await expect(alice.action(api.positions.open, open({ instId }))).rejects.toThrow(/Unsupported instrument/);
    }
    expect(await balance(alice)).toMatchObject({ balance: STARTING_BALANCE, locked: 0 });
  });

  it("refuses signed-out callers", async () => {
    const { t } = await setup();
    await expect(t.action(api.positions.open, open())).rejects.toThrow(/Not signed in/);
  });

  it("fills Up at the ask and Down at the bid — never at a client price", async () => {
    const { alice } = await setup();
    await alice.action(api.positions.open, open({ instId: "BTC-USDT-SWAP", side: "up" }));
    await alice.action(api.positions.open, open({ instId: "ETH-USDT-SWAP", side: "down" }));
    expect((await alice.query(api.positions.openFor, { instId: "BTC-USDT-SWAP" }))!.entry).toBe(101);
    expect((await alice.query(api.positions.openFor, { instId: "ETH-USDT-SWAP" }))!.entry).toBe(99);
  });

  it("allows spending the whole balance (margin + fee) but not a cent more", async () => {
    const { alice } = await setup();
    const exact = STARTING_BALANCE / (1 + 10 * TAKER_FEE); // margin + margin·10·fee = balance
    await expect(alice.action(api.positions.open, open({ margin: exact + 0.01 }))).rejects.toThrow(/Not enough paper balance/);
    await alice.action(api.positions.open, open({ margin: exact }));
    expect((await balance(alice)).balance).toBeCloseTo(0, 6);
  });
});

describe("positions.close (public action)", () => {
  it("closes Up at the bid and Down at the ask", async () => {
    const { alice } = await setup();
    const up = await alice.action(api.positions.open, open({ side: "up" }));
    const down = await alice.action(api.positions.open, open({ instId: "ETH-USDT-SWAP", side: "down" }));
    okx.quote = { bid: 110, ask: 111 };
    expect((await alice.action(api.positions.close, { positionId: up })).exit).toBe(110);
    expect((await alice.action(api.positions.close, { positionId: down })).exit).toBe(111);
  });

  it("a second close of the same position fails and pays nothing", async () => {
    const { alice } = await setup();
    const id = await alice.action(api.positions.open, open());
    await alice.action(api.positions.close, { positionId: id });
    const after = await balance(alice);
    await expect(alice.action(api.positions.close, { positionId: id })).rejects.toThrow(/not found or already closed/);
    await expect(alice.mutation(internal.positions.settle, { positionId: id, exit: 1e9, liquidated: false, asOwner: true })).rejects.toThrow(/already closed/);
    expect(await balance(alice)).toEqual(after);
  });

  it("another user cannot close it, even through settle", async () => {
    const { alice, bob } = await setup();
    const id = await alice.action(api.positions.open, open());
    await expect(bob.action(api.positions.close, { positionId: id })).rejects.toThrow(/not found/);
    await expect(bob.mutation(internal.positions.settle, { positionId: id, exit: 1e9, liquidated: false, asOwner: true })).rejects.toThrow(/not found/);
    expect((await alice.query(api.positions.openFor, { instId: "BTC-USDT-SWAP" }))!.status).toBe("open");
  });

  it("a catastrophic exit can't lose more than margin + opening fee", async () => {
    const { alice } = await setup();
    const id = await alice.action(api.positions.open, open({ side: "up", margin: 100, leverage: 50 }));
    okx.quote = { bid: 0.000001, ask: 0.000002 }; // price collapses
    const { realized } = await alice.action(api.positions.close, { positionId: id });
    const openFee = 100 * 50 * TAKER_FEE;
    expect(realized).toBeCloseTo(-(100 + openFee), 9);
    expect(await balance(alice)).toMatchObject({ locked: 0 });
    expect((await balance(alice)).balance).toBeCloseTo(STARTING_BALANCE - 100 - openFee, 9);
  });
});

describe("liquidation sweep (cron action)", () => {
  it("liquidates only crossed positions, at the liquidation price, and is idempotent", async () => {
    const { t, alice, bob } = await setup();
    const a = await alice.action(api.positions.open, open({ side: "up", leverage: 50 }));
    await bob.action(api.positions.open, open({ side: "up", leverage: 2 }));
    okx.marks = new Map([["BTC-USDT-SWAP", 98]]); // ~3% drop: kills 50×, not 2×
    expect(await t.action(internal.positions.sweepLiquidations, {})).toBe(1);
    expect(await t.action(internal.positions.sweepLiquidations, {})).toBe(0);
    const [liq] = (await alice.query(api.positions.listMine, { status: "liquidated", paginationOpts: { numItems: 5, cursor: null } })).page;
    expect(liq._id).toBe(a);
    expect(await bob.query(api.positions.openFor, { instId: "BTC-USDT-SWAP" })).not.toBeNull();
  });

  it("does nothing when OKX has no mark for the instrument", async () => {
    const { t, alice } = await setup();
    await alice.action(api.positions.open, open({ leverage: 50 }));
    okx.marks = new Map([["ETH-USDT-SWAP", 1]]);
    expect(await t.action(internal.positions.sweepLiquidations, {})).toBe(0);
  });
});

describe("money invariant", () => {
  it("over a random session, final balance = start + Σ realized and nothing stays locked", async () => {
    const { alice } = await setup();
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const insts = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"];
    const openIds = new Map<string, string>();
    let realizedSum = 0;

    for (let step = 0; step < 60; step++) {
      const mid = 50 + rand() * 100;
      okx.quote = { bid: mid * 0.999, ask: mid * 1.001 };
      const inst = insts[Math.floor(rand() * insts.length)];
      const id = openIds.get(inst);
      if (id) {
        realizedSum += (await alice.action(api.positions.close, { positionId: id as never })).realized;
        openIds.delete(inst);
      } else {
        const side = rand() < 0.5 ? "up" : "down";
        const leverage = 1 + Math.floor(rand() * 20);
        openIds.set(inst, await alice.action(api.positions.open, open({ instId: inst, side, margin: 10 + rand() * 200, leverage })));
      }
      const f = await balance(alice);
      expect(f.balance).toBeGreaterThanOrEqual(-1e-9);
      expect(f.locked).toBeGreaterThanOrEqual(-1e-9);
    }
    for (const id of openIds.values()) realizedSum += (await alice.action(api.positions.close, { positionId: id as never })).realized;

    const f = await balance(alice);
    expect(f.locked).toBeCloseTo(0, 9);
    expect(f.balance).toBeCloseTo(STARTING_BALANCE + realizedSum, 6);
  });
});

describe("funds.resetPaper", () => {
  it("is per-user: resetting Alice never touches Bob", async () => {
    const { alice, bob } = await setup();
    await bob.action(api.positions.open, open());
    const bobBefore = await balance(bob);
    await alice.mutation(api.funds.resetPaper, {});
    expect(await balance(bob)).toEqual(bobBefore);
  });
});
