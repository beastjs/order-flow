import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator, type FunctionReturnType } from "convex/server";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema, { category, exitTargetFields, positionStatus, side } from "./schema";
import { currentUser, requireUser } from "./lib/auth";
import { writeLog } from "./lib/log";
import { fetchAllMarks, fetchQuote, fetchSwap, fetchSwapQuotes } from "./lib/okx";
import { requireFunds } from "./funds";
import { TAKER_FEE, autoExitReason, closePosition, isLiquidated, liquidationPrice, openPosition, validateExitTargets, type AutoExitReason, type PaperPosition } from "../src/lib/paper/math";

const MAX_MARGIN = 1_000_000;
const SWEEP_BATCH = 500;

const toPaper = (p: Doc<"positions">): PaperPosition => ({
  instId: p.instId,
  side: p.side,
  margin: p.margin,
  leverage: p.leverage,
  entry: p.entry,
  size: p.size,
  openFee: p.openFee,
  openedAt: p.openedAt,
  exitTargets: p.exitTargets,
});

const usd = (n: number) => `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toFixed(2)}`;

// ─── reads ───────────────────────────────────────────────────

/** The caller's positions with a given status, newest first. */
export const listMine = query({
  args: { status: positionStatus, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("positions")),
  handler: async (ctx, { status, paginationOpts }) => {
    const user = await currentUser(ctx);
    if (!user) return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("positions")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", user._id).eq("status", status))
      .order("desc")
      .paginate(paginationOpts);
  },
});

/** The caller's completed paper trades, most recently settled first. */
export const history = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("positions")),
  handler: async (ctx, { paginationOpts }) => {
    const user = await currentUser(ctx);
    if (!user) return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("positions")
      .withIndex("by_userId_and_closedAt", (q) => q.eq("userId", user._id).gt("closedAt", undefined))
      .order("desc")
      .paginate(paginationOpts);
  },
});

/** The caller's open position on one instrument (the asset page), or null. */
export const openFor = query({
  args: { instId: v.string() },
  returns: v.union(schema.doc("positions"), v.null()),
  handler: async (ctx, { instId }) => {
    const user = await currentUser(ctx);
    if (!user) return null;
    return await ctx.db
      .query("positions")
      .withIndex("by_userId_and_instId_and_status", (q) =>
        q.eq("userId", user._id).eq("instId", instId).eq("status", "open"),
      )
      .unique();
  },
});

/** Ownership-checked lookup for the close action (auth flows through runQuery). */
export const getOwnedOpen = internalQuery({
  args: { positionId: v.id("positions") },
  returns: v.union(v.object({ instId: v.string(), side }), v.null()),
  handler: async (ctx, { positionId }) => {
    const user = await requireUser(ctx);
    const p = await ctx.db.get("positions", positionId);
    if (!p || p.userId !== user._id || p.status !== "open") return null;
    return { instId: p.instId, side: p.side };
  },
});

// ─── open ────────────────────────────────────────────────────

/** Open a position at the live OKX ask (up) or bid (down). Prices never come from the client. */
export const open = action({
  args: {
    instId: v.string(),
    side,
    margin: v.number(),
    leverage: v.number(),
  },
  returns: v.id("positions"),
  handler: async (ctx, args): Promise<Id<"positions">> => {
    if (!(await ctx.auth.getUserIdentity())) throw new Error("Not signed in.");
    if (!Number.isFinite(args.margin) || args.margin <= 0 || args.margin > MAX_MARGIN) throw new Error("Invalid amount.");
    if (!Number.isInteger(args.leverage) || args.leverage < 1) throw new Error("Invalid multiplier.");

    const swap = await fetchSwap(args.instId);
    if (args.leverage > swap.maxLeverage) throw new Error(`Max multiplier for ${swap.base} is ${swap.maxLeverage}×.`);
    const quote = await fetchQuote(args.instId);

    return await ctx.runMutation(internal.positions.openPriced, {
      instId: swap.instId,
      base: swap.base,
      category: swap.category,
      side: args.side,
      margin: args.margin,
      leverage: args.leverage,
      entry: args.side === "up" ? quote.ask : quote.bid,
    });
  },
});

export const openPriced = internalMutation({
  args: {
    instId: v.string(),
    base: v.string(),
    category,
    side,
    margin: v.number(),
    leverage: v.number(),
    entry: v.number(),
  },
  returns: v.id("positions"),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const existing = await ctx.db
      .query("positions")
      .withIndex("by_userId_and_instId_and_status", (q) =>
        q.eq("userId", user._id).eq("instId", args.instId).eq("status", "open"),
      )
      .first();
    if (existing) throw new Error(`Close your open ${args.base} position first.`);

    const now = Date.now();
    const p = openPosition(args.instId, args.side, args.margin, args.leverage, args.entry, now);
    const funds = await requireFunds(ctx, user._id);
    const cost = p.margin + p.openFee;
    if (cost > funds.balance + 1e-9) throw new Error("Not enough paper balance.");

    const positionId = await ctx.db.insert("positions", {
      userId: user._id,
      instId: args.instId,
      base: args.base,
      category: args.category,
      side: p.side,
      margin: p.margin,
      leverage: p.leverage,
      entry: p.entry,
      size: p.size,
      openFee: p.openFee,
      status: "open",
      openedAt: now,
    });
    const balanceAfter = funds.balance - cost;
    await ctx.db.patch("funds", funds._id, { balance: balanceAfter, locked: funds.locked + p.margin });
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "position_opened",
      message: `Opened ${p.side === "up" ? "Up" : "Down"} ${p.leverage}× ${args.base} at ${p.entry}`,
      positionId,
      instId: args.instId,
      amount: -cost,
      balanceAfter,
    });
    return positionId;
  },
});

// ─── close ───────────────────────────────────────────────────

/** Close at the live OKX bid (up) or ask (down). Returns the fill price and realized PnL net of fees. */
export const close = action({
  args: { positionId: v.id("positions") },
  returns: v.object({ realized: v.number(), exit: v.number() }),
  handler: async (ctx, { positionId }): Promise<{ realized: number; exit: number }> => {
    const owned = await ctx.runQuery(internal.positions.getOwnedOpen, { positionId });
    if (!owned) throw new Error("Position not found or already closed.");
    const quote = await fetchQuote(owned.instId);
    const exit = owned.side === "up" ? quote.bid : quote.ask;
    const realized: number = await ctx.runMutation(internal.positions.settle, {
      positionId,
      exit,
      liquidated: false,
      asOwner: true,
    });
    return { realized, exit };
  },
});

async function settlePosition(ctx: MutationCtx, p: Doc<"positions">, exit: number, liquidated: boolean, reason?: AutoExitReason): Promise<number> {
  const fill = closePosition(toPaper(p), exit, liquidated, Date.now());
  const closeFee = liquidated ? 0 : p.size * fill.exit * TAKER_FEE;
  await ctx.db.patch("positions", p._id, {
    status: liquidated ? "liquidated" : "closed",
    exit: fill.exit,
    closeFee,
    realized: fill.realized,
    closedAt: fill.closedAt,
    autoExitReason: reason,
  });

  const funds = await requireFunds(ctx, p.userId);
  // Margin + open fee left the balance at open; `realized` already nets both fees.
  const credit = p.margin + p.openFee + fill.realized;
  const balanceAfter = funds.balance + credit;
  await ctx.db.patch("funds", funds._id, { balance: balanceAfter, locked: Math.max(0, funds.locked - p.margin) });
  await ctx.db.insert("activity", {
    userId: p.userId,
    kind: liquidated ? "position_liquidated" : "position_closed",
    message: `${liquidated ? "Liquidated" : reason === "stop_loss" ? "Stop loss closed" : reason === "take_profit" ? "Take profit closed" : "Closed"} ${p.side === "up" ? "Up" : "Down"} ${p.leverage}× ${p.base} at ${fill.exit} · ${usd(fill.realized)}`,
    positionId: p._id,
    instId: p.instId,
    amount: credit,
    balanceAfter,
  });
  return fill.realized;
}

/** Settle one position. `asOwner` re-checks the caller owns it (the public close path). */
export const settle = internalMutation({
  args: { positionId: v.id("positions"), exit: v.number(), liquidated: v.boolean(), asOwner: v.boolean() },
  returns: v.number(),
  handler: async (ctx, { positionId, exit, liquidated, asOwner }) => {
    const p = await ctx.db.get("positions", positionId);
    if (!p || p.status !== "open") throw new Error("Position not found or already closed.");
    if (asOwner) {
      const user = await requireUser(ctx);
      if (p.userId !== user._id) throw new Error("Position not found or already closed.");
    }
    return await settlePosition(ctx, p, exit, liquidated);
  },
});

export const setExitTargets = mutation({
  args: { positionId: v.id("positions"), ...exitTargetFields },
  returns: v.null(),
  handler: async (ctx, { positionId, stopLoss, takeProfit }) => {
    const user = await requireUser(ctx);
    const position = await ctx.db.get("positions", positionId);
    if (!position || position.userId !== user._id || position.status !== "open")
      throw new Error("Position not found or already closed.");
    const error = validateExitTargets(toPaper(position), { stopLoss, takeProfit });
    if (error) throw new Error(error);
    await ctx.db.patch("positions", positionId, {
      exitTargets: stopLoss === null && takeProfit === null ? undefined : { stopLoss, takeProfit, setAt: Date.now() },
    });
    return null;
  },
});

export const exitTargetPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator, checkedAt: v.number() },
  returns: paginationResultValidator(v.object({ positionId: v.id("positions"), instId: v.string(), side })),
  handler: async (ctx, { paginationOpts, checkedAt }) => {
    const result = await ctx.db.query("positions")
      .withIndex("by_status_and_exitTargets_setAt", (q) =>
        q.eq("status", "open").gt("exitTargets.setAt", undefined).lte("exitTargets.setAt", checkedAt))
      .paginate(paginationOpts);
    return { ...result, page: result.page.map((p) => ({ positionId: p._id, instId: p.instId, side: p.side })) };
  },
});

export const settleExitTargets = internalMutation({
  args: { checkedAt: v.number(), quotes: v.array(v.object({ positionId: v.id("positions"), exit: v.number(), mark: v.number() })) },
  returns: v.number(),
  handler: async (ctx, { checkedAt, quotes }) => {
    let count = 0;
    for (const { positionId, exit, mark } of quotes) {
      const doc = await ctx.db.get("positions", positionId);
      if (!doc || doc.status !== "open" || !doc.exitTargets || doc.exitTargets.setAt > checkedAt) continue;
      const position = toPaper(doc);
      if (!Number.isFinite(mark) || mark <= 0 || isLiquidated(position, mark)) continue;
      const reason = autoExitReason(position, exit);
      if (!reason) continue;
      await settlePosition(ctx, doc, exit, false, reason);
      count++;
    }
    return count;
  },
});

export const sweepExitTargets = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const checkedAt = Date.now();
    let cursor: string | null = null;
    let snapshot: [Awaited<ReturnType<typeof fetchSwapQuotes>>, Awaited<ReturnType<typeof fetchAllMarks>>] | undefined;
    do {
      const page: FunctionReturnType<typeof internal.positions.exitTargetPage> = await ctx.runQuery(
        internal.positions.exitTargetPage, { paginationOpts: { numItems: 100, cursor }, checkedAt },
      );
      if (page.page.length > 0) {
        const [market, marks] = snapshot ??= await Promise.all([fetchSwapQuotes(), fetchAllMarks()]);
        const quotes = page.page.flatMap(({ positionId, instId, side }) => {
          const quote = market.get(instId);
          const exit = side === "up" ? quote?.bid : quote?.ask;
          const mark = marks.get(instId);
          return exit !== undefined && Number.isFinite(exit) && exit > 0 && mark !== undefined
            ? [{ positionId, exit, mark }]
            : [];
        });
        if (quotes.length > 0) await ctx.runMutation(internal.positions.settleExitTargets, { checkedAt, quotes });
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    return null;
  },
});

// ─── liquidation sweep (cron) ────────────────────────────────

/** Fetch every SWAP mark in one OKX call and liquidate open positions that crossed. */
export const sweepLiquidations = internalAction({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const marks = await fetchAllMarks();
    const instIds: string[] = await ctx.runQuery(internal.positions.openInstruments, {});
    const relevant = instIds.filter((id) => marks.has(id)).map((instId) => ({ instId, markPx: marks.get(instId)! }));
    if (relevant.length === 0) return 0;
    return await ctx.runMutation(internal.positions.liquidateCrossed, { marks: relevant });
  },
});

/** Distinct instruments with open positions (bounded). */
export const openInstruments = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("positions")
      .withIndex("by_status_and_instId", (q) => q.eq("status", "open"))
      .take(SWEEP_BATCH);
    return [...new Set(rows.map((r) => r.instId))];
  },
});

export const liquidateCrossed = internalMutation({
  args: { marks: v.array(v.object({ instId: v.string(), markPx: v.number() })) },
  returns: v.number(),
  handler: async (ctx, { marks }) => {
    let count = 0;
    for (const { instId, markPx } of marks) {
      const open = await ctx.db
        .query("positions")
        .withIndex("by_status_and_instId", (q) => q.eq("status", "open").eq("instId", instId))
        .take(SWEEP_BATCH);
      for (const p of open) {
        const liq = liquidationPrice(toPaper(p));
        if (p.side === "up" ? markPx > liq : markPx < liq) continue;
        await settlePosition(ctx, p, liq, true);
        await writeLog(ctx, "warn", "positions.liquidate", `liquidated ${p.instId}`, {
          userId: p.userId,
          data: { positionId: p._id, markPx, liq },
        });
        count++;
      }
    }
    return count;
  },
});
