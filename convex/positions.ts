import { v, type Infer } from "convex/values";
import { paginationOptsValidator, paginationResultValidator, type FunctionReturnType } from "convex/server";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import schema, { category, exitTargetFields, followUpOrder, positionStatus, side } from "./schema";
import { currentUser, requireUser } from "./lib/auth";
import { writeLog } from "./lib/log";
import { assetPositionCounts, hasOpenPositions, startPositionCountBackfill, syncAssetPositionCounts } from "./lib/positionCounts";
import { fetchAllMarks, fetchQuote, fetchSwap, fetchSwapQuotes } from "./lib/okx";
import { getFunds, requireFunds } from "./funds";
import { MAX_PAPER_MARGIN, TAKER_FEE, autoExitLabels, autoExitReason, closePosition, isLiquidated, liquidationPrice, openPosition, priceTotalExit, totalExitReason, validateExitTargets, validateFollowUpOrder, validateTotalExitTargets, type AutoExitReason, type ExitTargets, type PaperPosition } from "../src/lib/paper/math";

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
  followUpOrder: p.followUpOrder,
});

const usd = (n: number) => `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toFixed(2)}`;

const openPositionsFor = (ctx: QueryCtx, userId: Id<"users">) => ctx.db.query("positions")
  .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "open"));

export const userCountsForAsset = query({
  args: { instId: v.string() },
  returns: v.union(v.object({ up: v.number(), down: v.number() }), v.null()),
  handler: async (ctx, { instId }) => {
    const counts = await assetPositionCounts(ctx, instId);
    if (counts) return counts.ready ? { up: counts.up, down: counts.down } : null;
    return (await hasOpenPositions(ctx, instId)) ? null : { up: 0, down: 0 };
  },
});

/** Initialize existing positions the first time their asset page needs counts. */
export const initializeAssetPositionCounts = mutation({
  args: { instId: v.string() },
  returns: v.null(),
  handler: async (ctx, { instId }) => {
    if (!(await assetPositionCounts(ctx, instId)) && await hasOpenPositions(ctx, instId)) {
      await startPositionCountBackfill(ctx, instId);
    }
    return null;
  },
});

export const backfillAssetPositionCounts = internalMutation({
  args: {
    countsId: v.id("assetPositionCounts"),
    source: v.union(v.literal("paper"), v.literal("live-open"), v.literal("live-closing")),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { countsId, source, cursor }): Promise<null> => {
    const counts = await ctx.db.get("assetPositionCounts", countsId);
    if (!counts || counts.ready) return null;
    const instId = counts.instId;
    const opts = { numItems: 50, cursor };
    const page = source === "paper"
      ? await ctx.db.query("positions").withIndex("by_status_and_instId", (q) =>
          q.eq("status", "open").eq("instId", instId)).paginate(opts)
      : await ctx.db.query("livePositions").withIndex("by_status_and_instId", (q) =>
          q.eq("status", source === "live-open" ? "open" : "closing").eq("instId", instId)).paginate(opts);
    for (const { userId } of page.page) await syncAssetPositionCounts(ctx, instId, userId);

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.positions.backfillAssetPositionCounts, { countsId, source, cursor: page.continueCursor });
    } else if (source === "live-closing") {
      await ctx.db.patch("assetPositionCounts", countsId, { ready: true });
    } else {
      const next = source === "paper" ? "live-open" : "live-closing";
      await ctx.scheduler.runAfter(0, internal.positions.backfillAssetPositionCounts, { countsId, source: next, cursor: null });
    }
    return null;
  },
});

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
    if (!Number.isFinite(args.margin) || args.margin <= 0 || args.margin > MAX_PAPER_MARGIN) throw new Error("Invalid amount.");
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

const pricedOpen = v.object({
  instId: v.string(), base: v.string(), category, side,
  margin: v.number(), leverage: v.number(), entry: v.number(),
});

async function openForUser(
  ctx: MutationCtx, userId: Id<"users">, args: Infer<typeof pricedOpen>,
  followUp?: { exitTargets: ExitTargets; closedAt: number },
): Promise<{ positionId: Id<"positions"> } | { error: string }> {
  const existing = await ctx.db.query("positions")
    .withIndex("by_userId_and_instId_and_status", (q) =>
      q.eq("userId", userId).eq("instId", args.instId).eq("status", "open"))
    .first();
  if (existing) return { error: `Close your open ${args.base} position first.` };

  const funds = await getFunds(ctx, userId);
  if (!funds) return { error: "No funds account." };
  if (followUp && (funds.paperResetAt ?? -Infinity) >= followUp.closedAt) {
    return { error: "The paper balance was reset." };
  }
  const now = Date.now();
  const p = openPosition(args.instId, args.side, args.margin, args.leverage, args.entry, now);
  const cost = p.margin + p.openFee;
  if (cost > funds.balance + 1e-9) return { error: "Not enough paper balance." };
  const targets = followUp?.exitTargets;
  const exitTargets = targets && (targets.stopLoss !== null || targets.takeProfit !== null)
    ? { ...targets, setAt: now } : undefined;

  const positionId = await ctx.db.insert("positions", {
    ...args, userId, size: p.size, openFee: p.openFee, status: "open", openedAt: now, exitTargets,
  });
  await syncAssetPositionCounts(ctx, p.instId, userId);
  const balanceAfter = funds.balance - cost;
  await ctx.db.patch("funds", funds._id, { balance: balanceAfter, locked: funds.locked + p.margin });
  await ctx.db.insert("activity", {
    userId,
    kind: "position_opened",
    message: `${followUp ? "Follow-up opened" : "Opened"} ${p.side === "up" ? "Up" : "Down"} ${p.leverage}× ${args.base} at ${p.entry}`,
    positionId,
    instId: args.instId,
    amount: -cost,
    balanceAfter,
  });
  return { positionId };
}

export const openPriced = internalMutation({
  args: pricedOpen.fields,
  returns: v.id("positions"),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const result = await openForUser(ctx, user._id, args);
    if ("error" in result) throw new Error(result.error);
    return result.positionId;
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
  const fill = closePosition(toPaper(p), exit, liquidated, Date.now(), reason);
  const closeFee = liquidated ? 0 : p.size * fill.exit * TAKER_FEE;
  await ctx.db.patch("positions", p._id, {
    status: liquidated ? "liquidated" : "closed",
    exit: fill.exit,
    closeFee,
    realized: fill.realized,
    closedAt: fill.closedAt,
    autoExitReason: fill.autoExitReason,
    followUpResult: fill.followUpResult,
  });
  await syncAssetPositionCounts(ctx, p.instId, p.userId);

  const funds = await requireFunds(ctx, p.userId);
  // Margin + open fee left the balance at open; `realized` already nets both fees.
  const credit = p.margin + p.openFee + fill.realized;
  const balanceAfter = funds.balance + credit;
  const clearTargets = funds.totalExitTargets && !(await openPositionsFor(ctx, p.userId).first());
  await ctx.db.patch("funds", funds._id, {
    balance: balanceAfter,
    locked: Math.max(0, funds.locked - p.margin),
    ...(clearTargets && { totalExitTargets: undefined }),
  });
  await ctx.db.insert("activity", {
    userId: p.userId,
    kind: liquidated ? "position_liquidated" : "position_closed",
    message: `${liquidated ? "Liquidated" : reason ? `${autoExitLabels[reason]} closed` : "Closed"} ${p.side === "up" ? "Up" : "Down"} ${p.leverage}× ${p.base} at ${fill.exit} · ${usd(fill.realized)}`,
    positionId: p._id,
    instId: p.instId,
    amount: credit,
    balanceAfter,
  });
  if (fill.followUpResult?.status === "pending") {
    await ctx.scheduler.runAfter(0, internal.positions.executeFollowUp, { positionId: p._id });
  }
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

export const setFollowUpOrder = mutation({
  args: { positionId: v.id("positions"), order: v.union(followUpOrder, v.null()) },
  returns: v.null(),
  handler: async (ctx, { positionId, order }) => {
    const user = await requireUser(ctx);
    const position = await ctx.db.get("positions", positionId);
    if (!position || position.userId !== user._id || position.status !== "open") {
      throw new Error("Position not found or already closed.");
    }
    const error = order && validateFollowUpOrder(order);
    if (error) throw new Error(error);
    await ctx.db.patch("positions", positionId, { followUpOrder: order ?? undefined });
    return null;
  },
});

export const pendingFollowUp = internalQuery({
  args: { positionId: v.id("positions") },
  returns: v.union(followUpOrder, v.null()),
  handler: async (ctx, { positionId }) => {
    const source = await ctx.db.get("positions", positionId);
    return source?.followUpResult?.status === "pending" ? source.followUpOrder ?? null : null;
  },
});

const followUpQuote = v.union(v.object({ base: v.string(), category, entry: v.number() }), v.object({ error: v.string() }));

export const completeFollowUp = internalMutation({
  args: { positionId: v.id("positions"), quote: followUpQuote },
  returns: v.null(),
  handler: async (ctx, { positionId, quote }) => {
    const source = await ctx.db.get("positions", positionId);
    if (!source?.followUpOrder || source.closedAt === undefined || source.followUpResult?.status !== "pending") return null;
    const { instId, side, margin, leverage, exitTargets } = source.followUpOrder;
    const result = "error" in quote ? quote : await openForUser(ctx, source.userId, { instId, side, margin, leverage, ...quote }, {
      exitTargets, closedAt: source.closedAt,
    });
    await ctx.db.patch("positions", positionId, {
      followUpResult: "error" in result ? { status: "failed", error: result.error } : { status: "opened" },
    });
    return null;
  },
});

export const executeFollowUp = internalAction({
  args: { positionId: v.id("positions") },
  returns: v.null(),
  handler: async (ctx, { positionId }) => {
    const order: Infer<typeof followUpOrder> | null = await ctx.runQuery(internal.positions.pendingFollowUp, { positionId });
    if (!order) return null;

    let quote: Infer<typeof followUpQuote>;
    try {
      const [swap, market] = await Promise.all([fetchSwap(order.instId), fetchQuote(order.instId)]);
      const error = validateFollowUpOrder(order, swap.maxLeverage);
      quote = error ? { error } : { base: swap.base, category: swap.category, entry: order.side === "up" ? market.ask : market.bid };
    } catch (error) {
      quote = { error: error instanceof Error ? error.message : "Could not get a market quote." };
    }
    await ctx.runMutation(internal.positions.completeFollowUp, { positionId, quote });
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

export const setTotalExitTargets = mutation({
  args: exitTargetFields,
  returns: v.null(),
  handler: async (ctx, targets) => {
    const user = await requireUser(ctx);
    const error = validateTotalExitTargets(targets);
    if (error) throw new Error(error);

    const funds = await requireFunds(ctx, user._id);
    const enabled = targets.stopLoss !== null || targets.takeProfit !== null;
    if (enabled && !(await openPositionsFor(ctx, user._id).first())) throw new Error("No open paper positions.");
    await ctx.db.patch("funds", funds._id, {
      totalExitTargets: enabled
        ? { ...targets, setAt: Math.max(Date.now(), (funds.totalExitTargets?.setAt ?? 0) + 1) }
        : undefined,
    });
    return null;
  },
});

export const totalExitTargetPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator, checkedAt: v.number() },
  returns: paginationResultValidator(v.object({ fundsId: v.id("funds"), setAt: v.number() })),
  handler: async (ctx, { paginationOpts, checkedAt }) => {
    const page = await ctx.db.query("funds")
      .withIndex("by_currency_and_totalExitTargets_setAt", (q) =>
        q.eq("currency", "USDT").gt("totalExitTargets.setAt", undefined).lte("totalExitTargets.setAt", checkedAt))
      .paginate(paginationOpts);
    return { ...page, page: page.page.map((funds) => ({ fundsId: funds._id, setAt: funds.totalExitTargets!.setAt })) };
  },
});

const totalExitQuote = v.object({ instId: v.string(), bid: v.number(), ask: v.number(), mark: v.number() });

export const settleTotalExitTargets = internalMutation({
  args: { fundsId: v.id("funds"), setAt: v.number(), checkedAt: v.number(), quotes: v.array(totalExitQuote) },
  returns: v.number(),
  handler: async (ctx, { fundsId, setAt, checkedAt, quotes }) => {
    const funds = await ctx.db.get("funds", fundsId);
    const targets = funds?.totalExitTargets;
    if (!funds || funds.currency !== "USDT" || !targets || targets.setAt !== setAt || setAt > checkedAt) return 0;

    const positions: Doc<"positions">[] = [];
    for await (const position of openPositionsFor(ctx, funds.userId)) {
      if (position.openedAt > checkedAt) return 0;
      positions.push(position);
    }
    const market = new Map(quotes.map((quote) => [quote.instId, quote]));
    const basket = priceTotalExit(positions, (instId) => market.get(instId));
    const reason = basket && totalExitReason(targets, basket.pnl);
    if (!basket || !reason) return 0;

    await ctx.db.patch("funds", fundsId, { totalExitTargets: undefined });
    for (const { position, exit, liquidated } of basket.exits) {
      await settlePosition(ctx, position, exit, liquidated, liquidated ? undefined : reason);
    }
    return basket.exits.length;
  },
});

export const sweepTotalExitTargets = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const checkedAt = Date.now();
    let totalQuotes: { instId: string; bid: number; ask: number; mark: number }[] | undefined;
    let cursor: string | null = null;
    do {
      const page: FunctionReturnType<typeof internal.positions.totalExitTargetPage> = await ctx.runQuery(
        internal.positions.totalExitTargetPage, { paginationOpts: { numItems: 100, cursor }, checkedAt },
      );
      if (page.page.length > 0) {
        if (!totalQuotes) {
          const [market, marks] = await Promise.all([fetchSwapQuotes(), fetchAllMarks()]);
          totalQuotes = Array.from(marks, ([instId, mark]) => ({
            instId, mark, bid: market.get(instId)?.bid ?? 0, ask: market.get(instId)?.ask ?? 0,
          }));
        }
        for (const account of page.page) {
          await ctx.runMutation(internal.positions.settleTotalExitTargets, { ...account, checkedAt, quotes: totalQuotes });
        }
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    return null;
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
