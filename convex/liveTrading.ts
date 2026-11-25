// ============================================================
// OKX orders on the platform account or a user's connected account.
//
// Ledger model: every user's orders go through ONE OKX account (cross
// margin, long/short mode). OKX nets them into one exchange position per
// instrument+side; `livePositions` is each user's share, funded from their
// USD (top-up) balance. Prices, sizes and fees come from OKX's actual fills.
//
// Order lifecycle (crash-safe):
//   reserve (mutation)  → order row `pending` with a unique clOrdId, funds locked
//   place + poll (action) → OKX market order, read back the fill
//   settle (mutation, idempotent) → book the fill, release unused reservation
//   reconcile (cron)    → resolves any order left `pending` by a crash/timeout
// Personal positions use isolated margin and settle directly on OKX.
// ============================================================

import { ConvexError, v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import schema, { category, liveOrderKind, livePositionStatus, side } from "./schema";
import { currentUser, isAdmin, requireUser } from "./lib/auth";
import { writeLog } from "./lib/log";
import { syncAssetPositionCounts } from "./lib/positionCounts";
import { getUsdFunds } from "./funds";
import { fetchAllMarks, fetchQuote, fetchSwap } from "./lib/okx";
import { contractsForNotional, subtractSz, type OkxAccount } from "./lib/okxTradeCore";
import { ACTIVE_LIVE_STATUSES as OPEN_STATUSES, connectionForUser, personalAccount, personalTradingEnabled } from "./lib/okxCredentials";
import {
  OkxApiError,
  ensureLongShortMode,
  getIsolatedPositionSize,
  getOrder,
  isFinalState,
  placeMarketOrder,
  platformAccount,
  setLeverage,
  tradingConfig,
  type OkxOrderState,
  type PlaceOrderArgs,
} from "./lib/okxTrade";
import { liquidationPrice, type PaperPosition } from "../src/lib/paper/math";

/** Reserve 0.1% of notional for the fee (OKX taker is 0.05% at the base tier). */
const FEE_RESERVE_RATE = 0.001;
const personalVenue = v.optional(v.literal("personal"));
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 400;
/** A pending order unknown to OKX after this long was never placed. */
const NEVER_PLACED_AFTER_MS = 120_000;
const SUBMISSION_WINDOW_MS = 30_000;
const SWEEP_BATCH = 200;
/** OKX: service unavailable, request timeout, system busy, system error. */
const AMBIGUOUS_CODES = new Set(["50001", "50004", "50013", "50026"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (n: number) => `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toFixed(2)}`;
const newClOrdId = (prefix: "o" | "c" | "l") =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);

const toPaper = (p: Doc<"livePositions">): PaperPosition => ({
  instId: p.instId,
  side: p.side,
  margin: p.margin,
  leverage: p.leverage,
  entry: p.entry,
  size: p.size,
  openFee: p.openFee,
  openedAt: p.openedAt ?? 0,
});

// ─── access ─────────────────────────────────────────────────

async function tradeAccess(ctx: QueryCtx | MutationCtx, personal: boolean) {
  const user = await requireUser(ctx);
  const cfg = tradingConfig();
  if (personal) {
    if (!personalTradingEnabled()) throw new ConvexError("Trading with your own OKX account is unavailable.");
    const connection = await connectionForUser(ctx, user._id);
    if (!connection) throw new ConvexError("Connect your OKX account first.");
    return { user, cfg, connection };
  }
  if (!cfg.mode) throw new Error("Real-order trading is not enabled.");
  if (cfg.access === "admins" && !(await isAdmin(ctx, user))) {
    throw new Error("Real-order trading is limited to admins for now.");
  }
  return { user, cfg, connection: null };
}

async function openLiveFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">, instId: string, connectionId?: Id<"okxConnections">) {
  for (const status of OPEN_STATUSES) {
    const p = await ctx.db
      .query("livePositions")
      .withIndex("by_userId_and_okxConnectionId_and_instId_and_status", (q) =>
        q.eq("userId", userId).eq("okxConnectionId", connectionId).eq("instId", instId).eq("status", status))
      .first();
    if (p) return p;
  }
  return null;
}

// ─── reads ───────────────────────────────────────────────────

/** What the UI needs to show (or hide) real-order trading for the caller. */
export const config = query({
  args: {},
  returns: v.object({
    enabled: v.boolean(),
    mode: v.union(v.literal("demo"), v.literal("live"), v.null()),
    canTrade: v.boolean(),
    reason: v.union(v.string(), v.null()),
    maxOrderUsd: v.number(),
    maxUserNotionalUsd: v.number(),
    maxLeverage: v.number(),
  }),
  handler: async (ctx) => {
    const cfg = tradingConfig();
    const base = {
      enabled: Boolean(cfg.mode),
      mode: cfg.mode,
      maxOrderUsd: cfg.maxOrderUsd,
      maxUserNotionalUsd: cfg.maxUserNotionalUsd,
      maxLeverage: cfg.maxLeverage,
    };
    if (!cfg.mode) return { ...base, canTrade: false, reason: "Real-order trading is not enabled." };
    const user = await currentUser(ctx);
    if (!user) return { ...base, canTrade: false, reason: "Sign in to trade with real funds." };
    if (cfg.access === "admins" && !(await isAdmin(ctx, user))) {
      return { ...base, canTrade: false, reason: "Real-order trading is limited to admins for now." };
    }
    return { ...base, canTrade: true, reason: null };
  },
});

/** The caller's live position on one instrument (opening/open/closing), or null. */
export const openFor = query({
  args: { instId: v.string(), venue: personalVenue },
  returns: v.union(schema.doc("livePositions"), v.null()),
  handler: async (ctx, { instId, venue }) => {
    const user = await currentUser(ctx);
    if (!user) return null;
    const connection = venue && await connectionForUser(ctx, user._id);
    if (venue && !connection) return null;
    return await openLiveFor(ctx, user._id, instId, connection?._id);
  },
});

export const personalPositions = query({
  args: {},
  returns: v.array(schema.doc("livePositions")),
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const connection = user && await connectionForUser(ctx, user._id);
    if (!connection) return [];
    const rows = await Promise.all(OPEN_STATUSES.map((status) => ctx.db.query("livePositions")
      .withIndex("by_okxConnectionId_and_status", (q) => q.eq("okxConnectionId", connection._id).eq("status", status))
      .order("desc").take(50)));
    return rows.flat().sort((a, b) => b._creationTime - a._creationTime);
  },
});

/** The caller's live positions with a given status, newest first. */
export const listMine = query({
  args: { status: livePositionStatus, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("livePositions")),
  handler: async (ctx, { status, paginationOpts }) => {
    const user = await currentUser(ctx);
    if (!user) return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("livePositions")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", user._id).eq("status", status))
      .order("desc")
      .paginate(paginationOpts);
  },
});

/** The caller's completed OKX positions, most recently settled first. */
export const history = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("livePositions")),
  handler: async (ctx, { paginationOpts }) => {
    const user = await currentUser(ctx);
    if (!user) return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("livePositions")
      .withIndex("by_userId_and_closedAt", (q) => q.eq("userId", user._id).gt("closedAt", undefined))
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const accessCheck = internalQuery({
  args: { venue: personalVenue },
  returns: v.union(v.null(), schema.doc("okxConnections")),
  handler: async (ctx, { venue }) => {
    const { connection } = await tradeAccess(ctx, venue === "personal");
    return connection;
  },
});

// ─── reserve ─────────────────────────────────────────────────

/** Lock margin + fee buffer and record the order BEFORE it is sent to OKX. */
export const reserveOpen = internalMutation({
  args: {
    instId: v.string(),
    base: v.string(),
    category,
    side,
    margin: v.number(),
    leverage: v.number(),
    sz: v.string(),
    ctVal: v.number(),
    estNotional: v.number(),
    connectionId: v.optional(v.id("okxConnections")),
  },
  returns: v.object({ orderId: v.id("liveOrders"), positionId: v.id("livePositions"), clOrdId: v.string(), submitBy: v.number() }),
  handler: async (ctx, a) => {
    const { user, cfg, connection } = await tradeAccess(ctx, !!a.connectionId);
    if (connection?._id !== a.connectionId) throw new ConvexError("Your OKX connection changed. Review and submit the order again.");
    if (a.leverage > cfg.maxLeverage) throw new ConvexError(`Max multiplier is ${cfg.maxLeverage}×.`);
    if (a.estNotional > cfg.maxOrderUsd * 1.02) throw new ConvexError(`Max order size is $${cfg.maxOrderUsd}.`);
    if (await openLiveFor(ctx, user._id, a.instId, connection?._id)) throw new ConvexError(`You already have a live ${a.base} position on this account.`);

    let openNotional = 0;
    for (const status of OPEN_STATUSES) {
      const positions = await ctx.db.query("livePositions")
        .withIndex("by_userId_and_status_and_okxConnectionId", (q) =>
          q.eq("userId", user._id).eq("status", status).eq("okxConnectionId", connection?._id)).take(200);
      for (const p of positions) openNotional += p.margin * p.leverage;
    }
    if (openNotional + a.estNotional > cfg.maxUserNotionalUsd) {
      throw new ConvexError(`That would exceed your $${cfg.maxUserNotionalUsd} live exposure limit.`);
    }

    const funds = connection ? null : await getUsdFunds(ctx, user._id);
    const reserved = a.margin + a.estNotional * FEE_RESERVE_RATE;
    if (!connection && (!funds || funds.balance + 1e-9 < reserved)) {
      throw new Error(`Not enough USD balance (need $${reserved.toFixed(2)} incl. fees). Top up first.`);
    }

    const positionId = await ctx.db.insert("livePositions", {
      userId: user._id,
      ...(connection ? { okxConnectionId: connection._id, okxMode: connection.mode } : {}),
      instId: a.instId,
      base: a.base,
      category: a.category,
      side: a.side,
      leverage: a.leverage,
      ctVal: a.ctVal,
      contractsSz: a.sz,
      size: Number(a.sz) * a.ctVal,
      entry: 0,
      margin: a.margin,
      openFee: 0,
      status: "opening",
    });
    const clOrdId = newClOrdId("o");
    const orderId = await ctx.db.insert("liveOrders", {
      userId: user._id,
      okxConnectionId: connection?._id,
      positionId,
      instId: a.instId,
      kind: "open",
      side: a.side,
      clOrdId,
      sz: a.sz,
      status: "pending",
      reservedUsd: connection ? undefined : reserved,
      margin: a.margin,
      leverage: a.leverage,
      attempts: 0,
    });
    if (funds) await ctx.db.patch("funds", funds._id, { balance: funds.balance - reserved, locked: funds.locked + reserved });
    await writeLog(ctx, "info", "liveTrading.reserveOpen", `reserved ${a.instId}`, {
      userId: user._id,
      data: { orderId, clOrdId, sz: a.sz, reserved: connection ? 0 : reserved, mode: connection?.mode ?? cfg.mode },
    });
    return { orderId, positionId, clOrdId, submitBy: Date.now() + SUBMISSION_WINDOW_MS };
  },
});

/** Mark a position closing and record the reduce-only order before sending it. */
export const reserveClose = internalMutation({
  args: { positionId: v.id("livePositions"), kind: liveOrderKind, asOwner: v.boolean() },
  returns: v.union(
    v.null(),
    v.object({ orderId: v.id("liveOrders"), clOrdId: v.string(), instId: v.string(), side, sz: v.string(), submitBy: v.number(),
      userId: v.id("users"), connectionId: v.optional(v.id("okxConnections")) }),
  ),
  handler: async (ctx, { positionId, kind, asOwner }) => {
    const p = await ctx.db.get("livePositions", positionId);
    if (asOwner) {
      const user = await requireUser(ctx);
      if (!p || p.userId !== user._id) throw new Error("Position not found.");
    }
    if (!p || p.status !== "open") {
      if (asOwner) throw new Error("This position is not open (it may be opening or already closing).");
      return null;
    }
    if (p.okxConnectionId) {
      if (kind === "liquidation") return null;
      if (!personalTradingEnabled()) throw new ConvexError("Trading with your own OKX account is unavailable.");
    } else if (!tradingConfig().mode) throw new Error("Real-order trading is not enabled.");
    await ctx.db.patch("livePositions", positionId, { status: "closing" });
    await syncAssetPositionCounts(ctx, p.instId, p.userId);
    const clOrdId = newClOrdId(kind === "liquidation" ? "l" : "c");
    const orderId = await ctx.db.insert("liveOrders", {
      userId: p.userId,
      okxConnectionId: p.okxConnectionId,
      positionId,
      instId: p.instId,
      kind,
      side: p.side,
      clOrdId,
      sz: p.contractsSz,
      status: "pending",
      attempts: 0,
    });
    return { orderId, clOrdId, instId: p.instId, side: p.side, sz: p.contractsSz, userId: p.userId,
      connectionId: p.okxConnectionId, submitBy: Date.now() + SUBMISSION_WINDOW_MS };
  },
});

// ─── settle / reject (idempotent) ────────────────────────────

async function releaseOpen(ctx: MutationCtx, order: Doc<"liveOrders">, reason: string) {
  const funds = order.okxConnectionId ? null : await getUsdFunds(ctx, order.userId);
  const reserved = order.reservedUsd ?? 0;
  if (funds && reserved > 0) {
    await ctx.db.patch("funds", funds._id, { balance: funds.balance + reserved, locked: Math.max(0, funds.locked - reserved) });
  }
  const p = await ctx.db.get("livePositions", order.positionId);
  if (p && p.status === "opening") await ctx.db.delete("livePositions", p._id);
  await ctx.db.insert("activity", {
    userId: order.userId,
    kind: "live_order_failed",
    message: `Live order for ${order.instId} not filled: ${reason}`,
    instId: order.instId,
  });
}

async function restoreOpen(ctx: MutationCtx, positionId: Id<"livePositions">) {
  const p = await ctx.db.get("livePositions", positionId);
  if (!p || p.status !== "closing") return;
  await ctx.db.patch("livePositions", p._id, { status: "open" });
  await syncAssetPositionCounts(ctx, p.instId, p.userId);
}

export const rejectOrder = internalMutation({
  args: { orderId: v.id("liveOrders"), reason: v.string(), status: v.union(v.literal("rejected"), v.literal("failed")) },
  returns: v.null(),
  handler: async (ctx, { orderId, reason, status }) => {
    const order = await ctx.db.get("liveOrders", orderId);
    if (!order || order.status !== "pending") return null;
    await ctx.db.patch("liveOrders", orderId, { status, error: reason });
    if (order.kind === "open") {
      await releaseOpen(ctx, order, reason);
    } else {
      await restoreOpen(ctx, order.positionId);
    }
    await writeLog(ctx, status === "failed" ? "error" : "warn", "liveTrading.reject", `${order.kind} order ${status}`, {
      userId: order.userId,
      data: { orderId, clOrdId: order.clOrdId, instId: order.instId, reason },
    });
    return null;
  },
});

export const settleOrder = internalMutation({
  args: {
    orderId: v.id("liveOrders"),
    ordId: v.string(),
    state: v.string(),
    avgPx: v.number(),
    accFillSz: v.string(),
    fee: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, fill) => {
    const order = await ctx.db.get("liveOrders", fill.orderId);
    if (!order || order.status !== "pending") return null; // already settled: idempotent
    const filled = Number(fill.accFillSz);
    if (!(filled > 0) || !(fill.avgPx > 0)) {
      await ctx.db.patch("liveOrders", order._id, { status: "rejected", ordId: fill.ordId, error: `Not filled (${fill.state}).` });
      if (order.kind === "open") await releaseOpen(ctx, order, `not filled (${fill.state})`);
      else await restoreOpen(ctx, order.positionId);
      return null;
    }
    // OKX reports fees as negative charges; a positive value is a rebate.
    const cost = -fill.fee;
    await ctx.db.patch("liveOrders", order._id, {
      status: "filled",
      ordId: fill.ordId,
      filledSz: filled,
      avgPx: fill.avgPx,
      fee: cost,
    });
    if (order.kind === "open") await applyOpenFill(ctx, order, fill.accFillSz, fill.avgPx, cost);
    else await applyCloseFill(ctx, order, fill.accFillSz, fill.avgPx, cost);
    return null;
  },
});

async function applyOpenFill(ctx: MutationCtx, order: Doc<"liveOrders">, filledSz: string, avgPx: number, cost: number) {
  const p = await ctx.db.get("livePositions", order.positionId);
  if (!p) return;
  const frac = Math.min(1, Number(filledSz) / Number(order.sz));
  const margin = p.okxConnectionId ? Number(filledSz) * p.ctVal * avgPx / p.leverage : (order.margin ?? 0) * frac;
  const reserved = order.reservedUsd ?? 0;
  const funds = order.okxConnectionId ? null : await getUsdFunds(ctx, order.userId);
  const balanceAfter = (funds?.balance ?? 0) + reserved - margin - cost;
  if (funds) {
    await ctx.db.patch("funds", funds._id, {
      balance: balanceAfter,
      locked: Math.max(0, funds.locked - reserved + margin),
    });
  }
  await ctx.db.patch("livePositions", p._id, {
    status: "open",
    contractsSz: filledSz,
    size: Number(filledSz) * p.ctVal,
    entry: avgPx,
    margin,
    openFee: cost,
    openedAt: Date.now(),
  });
  await syncAssetPositionCounts(ctx, p.instId, p.userId);
  await ctx.db.insert("activity", {
    userId: order.userId,
    kind: "live_position_opened",
    message: `Opened ${p.okxMode ? `My OKX ${p.okxMode}` : "LIVE"} ${p.side === "up" ? "Up" : "Down"} ${p.leverage}× ${p.base} at ${avgPx}`,
    instId: p.instId,
    ...(funds ? { amount: -(margin + cost), balanceAfter } : {}),
  });
  await writeLog(ctx, "info", "liveTrading.open", `filled ${p.instId}`, {
    userId: order.userId,
    data: { orderId: order._id, filledSz, avgPx, fee: cost, margin },
  });
}

async function applyCloseFill(ctx: MutationCtx, order: Doc<"liveOrders">, filledSz: string, avgPx: number, cost: number) {
  const p = await ctx.db.get("livePositions", order.positionId);
  if (!p) return;
  const total = Number(p.contractsSz);
  const frac = Math.min(1, Number(filledSz) / total);
  const dir = p.side === "up" ? 1 : -1;
  const pnl = dir * (avgPx - p.entry) * Number(filledSz) * p.ctVal;
  const marginPart = p.margin * frac;
  const openFeePart = p.openFee * frac;
  // A user can lose at most their margin; any gap loss beyond it is the platform's.
  const credit = Math.max(0, marginPart + pnl - cost);
  const realized = p.okxConnectionId ? pnl - cost - openFeePart : credit - marginPart - openFeePart;
  const liquidated = order.kind === "liquidation";

  const funds = p.okxConnectionId ? null : await getUsdFunds(ctx, p.userId);
  const balanceAfter = (funds?.balance ?? 0) + credit;
  if (funds) {
    await ctx.db.patch("funds", funds._id, { balance: balanceAfter, locked: Math.max(0, funds.locked - marginPart) });
  }

  const remaining = subtractSz(p.contractsSz, filledSz);
  const partiallyClosed = Number(remaining) > 0;
  if (partiallyClosed) {
    // Partial close: keep the rest open, proportionally reduced.
    await ctx.db.patch("livePositions", p._id, {
      status: "open",
      contractsSz: remaining,
      size: Number(remaining) * p.ctVal,
      margin: p.margin - marginPart,
      openFee: p.openFee - openFeePart,
      realized: (p.realized ?? 0) + realized,
    });
  } else {
    await ctx.db.patch("livePositions", p._id, {
      status: liquidated ? "liquidated" : "closed",
      exit: avgPx,
      closeFee: cost,
      realized: (p.realized ?? 0) + realized,
      closedAt: Date.now(),
    });
  }
  await syncAssetPositionCounts(ctx, p.instId, p.userId);
  await ctx.db.insert("activity", {
    userId: p.userId,
    kind: liquidated ? "live_position_liquidated" : "live_position_closed",
    message: `${liquidated ? "Liquidated" : "Closed"} ${p.okxMode ? `My OKX ${p.okxMode}` : "LIVE"} ${p.side === "up" ? "Up" : "Down"} ${p.leverage}× ${p.base} at ${avgPx} · ${usd(realized)}`,
    instId: p.instId,
    ...(partiallyClosed && { partiallyClosed: true as const }),
    ...(funds ? { amount: credit, balanceAfter } : {}),
  });
  await writeLog(ctx, liquidated ? "warn" : "info", "liveTrading.close", `${order.kind} filled ${p.instId}`, {
    userId: p.userId,
    data: { orderId: order._id, filledSz, avgPx, fee: cost, realized, ...(funds ? { platformLoss: Math.max(0, -(marginPart + pnl - cost)) } : {}) },
  });
}

// ─── placement (actions) ─────────────────────────────────────

type OrderOutcome = "filled" | "rejected" | "pending" | "closed_externally";

async function accountForOrder(ctx: ActionCtx, userId: Id<"users">, connectionId?: Id<"okxConnections">): Promise<OkxAccount> {
  if (!connectionId) return platformAccount(tradingConfig());
  const connection = await ctx.runQuery(internal.okxConnections.readForOrder, { connectionId, userId });
  if (!connection) throw new ConvexError("The OKX connection for this position is unavailable.");
  return await personalAccount(connection);
}

/** Poll a just-placed order until it's final, then settle. Pending if OKX hasn't finished. */
async function pollAndSettle(ctx: ActionCtx, account: OkxAccount, orderId: Id<"liveOrders">, instId: string, clOrdId: string): Promise<OrderOutcome> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const o: OkxOrderState | null = await getOrder(account, instId, clOrdId).catch(() => null);
    if (o && isFinalState(o.state)) {
      await ctx.runMutation(internal.liveTrading.settleOrder, {
        orderId,
        ordId: o.ordId,
        state: o.state,
        avgPx: o.avgPx,
        accFillSz: o.accFillSz,
        fee: o.fee,
      });
      return Number(o.accFillSz) > 0 ? "filled" : "rejected";
    }
    await sleep(POLL_DELAY_MS);
  }
  await ctx.scheduler.runAfter(5_000, internal.liveTrading.reconcileOne, { orderId });
  return "pending";
}

/**
 * Send an order. Definitive rejections release the reservation; anything
 * ambiguous (network error, timeout) stays pending for the reconciler, because
 * OKX may have received it.
 */
async function sendAndSettle(
  ctx: ActionCtx,
  account: OkxAccount,
  orderId: Id<"liveOrders">,
  order: PlaceOrderArgs,
): Promise<{ outcome: OrderOutcome; error: string | null }> {
  if (Date.now() >= order.submitBy) {
    const reason = "Order preparation timed out. Review the order and try again.";
    await ctx.runMutation(internal.liveTrading.rejectOrder, { orderId, reason, status: "failed" });
    return { outcome: "rejected", error: reason };
  }
  try {
    await placeMarketOrder(account, order);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Definitive: a per-order rejection (sCode), or a request-level error OKX
    // returns before accepting anything. NOT definitive: timeouts/busy codes,
    // where the order may still have been placed — leave those to reconcile.
    const ambiguous = e instanceof OkxApiError && (AMBIGUOUS_CODES.has(e.code) || (e.sCode && AMBIGUOUS_CODES.has(e.sCode)));
    if (e instanceof OkxApiError && !ambiguous && (e.sCode || e.code === "1" || /^5\d{4}$/.test(e.code))) {
      await ctx.runMutation(internal.liveTrading.rejectOrder, { orderId, reason: message, status: "rejected" });
      return { outcome: "rejected", error: message };
    }
    await ctx.scheduler.runAfter(5_000, internal.liveTrading.reconcileOne, { orderId });
    return { outcome: "pending", error: `Order status unknown (${message}); it will be reconciled automatically.` };
  }
  return { outcome: await pollAndSettle(ctx, account, orderId, order.instId, order.clOrdId), error: null };
}

const orderResult = v.object({
  positionId: v.id("livePositions"),
  outcome: v.union(v.literal("filled"), v.literal("rejected"), v.literal("pending"), v.literal("closed_externally")),
  error: v.union(v.string(), v.null()),
  /** Close only, once filled: net PnL booked and the actual exit price. */
  realized: v.union(v.number(), v.null()),
  exit: v.union(v.number(), v.null()),
});
type OrderResult = {
  positionId: Id<"livePositions">;
  outcome: OrderOutcome;
  error: string | null;
  realized: number | null;
  exit: number | null;
};

export const getPosition = internalQuery({
  args: { positionId: v.id("livePositions") },
  returns: v.union(schema.doc("livePositions"), v.null()),
  handler: async (ctx, { positionId }) => await ctx.db.get("livePositions", positionId),
});

/** Open a market order on the requested OKX account. */
export const open = action({
  args: { instId: v.string(), side, margin: v.number(), leverage: v.number(), venue: personalVenue, connectionRevision: v.optional(v.string()) },
  returns: orderResult,
  handler: async (ctx, args): Promise<OrderResult> => {
    if (!(await ctx.auth.getUserIdentity())) throw new Error("Not signed in.");
    const connection: Doc<"okxConnections"> | null = await ctx.runQuery(internal.liveTrading.accessCheck, { venue: args.venue });
    const cfg = tradingConfig();
    if (connection && connection.iv !== args.connectionRevision) {
      throw new ConvexError("Your OKX connection changed. Review and submit the order again.");
    }
    if (!Number.isFinite(args.margin) || args.margin <= 0) throw new ConvexError("Invalid amount.");
    if (!Number.isInteger(args.leverage) || args.leverage < 1) throw new ConvexError("Invalid multiplier.");

    const swap = await fetchSwap(args.instId);
    const maxLev = Math.min(cfg.maxLeverage, swap.maxLeverage);
    if (args.leverage > maxLev) throw new ConvexError(`Max multiplier for ${swap.base} is ${maxLev}×.`);
    const notional = args.margin * args.leverage;
    if (notional > cfg.maxOrderUsd) throw new ConvexError(`Max order size is $${cfg.maxOrderUsd} (amount × multiplier).`);

    const quote = await fetchQuote(args.instId);
    const price = args.side === "up" ? quote.ask : quote.bid;
    const sz = contractsForNotional(notional, price, swap);
    if (!sz) {
      const minUsd = Number(swap.minSz) * swap.ctVal * price;
      throw new ConvexError(`Below ${swap.base}'s minimum order (~$${minUsd.toFixed(2)} notional).`);
    }
    // Margin follows the whole lots actually ordered, not the rounded-away remainder.
    const estNotional = Number(sz) * swap.ctVal * price;
    const margin = estNotional / args.leverage;
    const account = connection ? await personalAccount(connection) : platformAccount(cfg);

    const r = await ctx.runMutation(internal.liveTrading.reserveOpen, {
      instId: swap.instId,
      base: swap.base,
      category: swap.category,
      side: args.side,
      margin,
      leverage: args.leverage,
      sz,
      ctVal: swap.ctVal,
      estNotional,
      connectionId: connection?._id,
    });

    const posSide = args.side === "up" ? "long" : "short";
    try {
      await ensureLongShortMode(account);
      if (connection && await getIsolatedPositionSize(account, swap.instId, posSide) > 0) {
        throw new Error("Close your existing OKX isolated position for this market and side before opening through CFX.");
      }
      // Exchange leverage is account-wide per instrument: pin it to the platform cap.
      await setLeverage(account, swap.instId, connection ? args.leverage : maxLev, posSide);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.liveTrading.rejectOrder, { orderId: r.orderId, reason: `Account setup failed: ${reason}`, status: "rejected" });
      return { positionId: r.positionId, outcome: "rejected", error: `Account setup failed: ${reason}`, realized: null, exit: null };
    }

    const { outcome, error } = await sendAndSettle(ctx, account, r.orderId, {
      instId: swap.instId,
      side: args.side === "up" ? "buy" : "sell",
      posSide,
      sz,
      clOrdId: r.clOrdId,
      reduceOnly: false,
      submitBy: r.submitBy,
    });
    return { positionId: r.positionId, outcome, error, realized: null, exit: null };
  },
});

export const settleExternalClose = internalMutation({
  args: { orderId: v.id("liveOrders") },
  returns: v.boolean(),
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get("liveOrders", orderId);
    if (!order?.okxConnectionId || order.kind !== "close" || order.status !== "pending") return false;
    const p = await ctx.db.get("livePositions", order.positionId);
    if (p?.status !== "closing") return false;
    await ctx.db.patch("liveOrders", orderId, { status: "failed", error: "OKX position already closed before submission." });
    await ctx.db.patch("livePositions", p._id, { status: "closed", closedAt: Date.now(), closedExternally: true, realized: undefined });
    await ctx.db.insert("activity", {
      userId: p.userId, kind: "live_position_closed", message: `${p.base} position already closed on OKX`, instId: p.instId,
    });
    await syncAssetPositionCounts(ctx, p.instId, p.userId);
    return true;
  },
});

/** Close the caller's live position at market (reduce-only). */
export const close = action({
  args: { positionId: v.id("livePositions") },
  returns: orderResult,
  handler: async (ctx, { positionId }): Promise<OrderResult> => {
    if (!(await ctx.auth.getUserIdentity())) throw new Error("Not signed in.");
    const r = await ctx.runMutation(internal.liveTrading.reserveClose, { positionId, kind: "close", asOwner: true });
    if (!r) throw new Error("This position is not open.");
    const posSide = r.side === "up" ? "long" : "short";
    let account: OkxAccount;
    try {
      account = await accountForOrder(ctx, r.userId, r.connectionId);
      if (account.personal) {
        await ensureLongShortMode(account);
        const exchangeSize = await getIsolatedPositionSize(account, r.instId, posSide);
        if (exchangeSize === 0) {
          const settled: boolean = await ctx.runMutation(internal.liveTrading.settleExternalClose, { orderId: r.orderId });
          if (!settled) throw new Error("The position changed while checking OKX. Refresh and try again.");
          return { positionId, outcome: "closed_externally", error: null, realized: null, exit: null };
        }
        if (exchangeSize !== Number(r.sz)) throw new Error("Your position size changed on OKX. Close the remaining position in OKX, then return here to update CFX.");
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : "Could not read the OKX position.";
      await ctx.runMutation(internal.liveTrading.rejectOrder, { orderId: r.orderId, reason, status: "rejected" });
      return { positionId, outcome: "rejected", error: reason, realized: null, exit: null };
    }
    const { outcome, error } = await sendAndSettle(ctx, account, r.orderId, {
      instId: r.instId,
      side: r.side === "up" ? "sell" : "buy",
      posSide,
      sz: r.sz,
      clOrdId: r.clOrdId,
      reduceOnly: true,
      submitBy: r.submitBy,
    });
    const after = outcome === "filled" ? await ctx.runQuery(internal.liveTrading.getPosition, { positionId }) : null;
    return { positionId, outcome, error, realized: after?.realized ?? null, exit: after?.exit ?? null };
  },
});

// ─── reconciliation + liquidation (crons) ────────────────────

export const getOrderRow = internalQuery({
  args: { orderId: v.id("liveOrders") },
  returns: v.union(schema.doc("liveOrders"), v.null()),
  handler: async (ctx, { orderId }) => await ctx.db.get("liveOrders", orderId),
});

export const pendingOrders = internalQuery({
  args: {},
  returns: v.array(schema.doc("liveOrders")),
  handler: async (ctx) =>
    await ctx.db.query("liveOrders").withIndex("by_status_and_lastReconciledAt", (q) => q.eq("status", "pending")).take(50),
});

export const bumpAttempts = internalMutation({
  args: { orderId: v.id("liveOrders") },
  returns: v.null(),
  handler: async (ctx, { orderId }) => {
    const o = await ctx.db.get("liveOrders", orderId);
    if (o && o.status === "pending") await ctx.db.patch("liveOrders", orderId, { attempts: o.attempts + 1, lastReconciledAt: Date.now() });
    return null;
  },
});

async function reconcile(ctx: ActionCtx, order: Doc<"liveOrders">): Promise<void> {
  if (order.status !== "pending") return;
  let state: OkxOrderState | null;
  try {
    const account = await accountForOrder(ctx, order.userId, order.okxConnectionId);
    state = await getOrder(account, order.instId, order.clOrdId);
  } catch {
    await ctx.runMutation(internal.liveTrading.bumpAttempts, { orderId: order._id });
    return; // OKX unreachable: try again next sweep
  }
  if (state && isFinalState(state.state)) {
    await ctx.runMutation(internal.liveTrading.settleOrder, {
      orderId: order._id,
      ordId: state.ordId,
      state: state.state,
      avgPx: state.avgPx,
      accFillSz: state.accFillSz,
      fee: state.fee,
    });
    return;
  }
  if (!state && Date.now() - order._creationTime > NEVER_PLACED_AFTER_MS) {
    await ctx.runMutation(internal.liveTrading.rejectOrder, {
      orderId: order._id,
      reason: "OKX has no record of this order (it was never placed).",
      status: "failed",
    });
    return;
  }
  await ctx.runMutation(internal.liveTrading.bumpAttempts, { orderId: order._id });
}

export const reconcileOne = internalAction({
  args: { orderId: v.id("liveOrders") },
  returns: v.null(),
  handler: async (ctx, { orderId }) => {
    const order = await ctx.runQuery(internal.liveTrading.getOrderRow, { orderId });
    if (order) await reconcile(ctx, order);
    return null;
  },
});

export const reconcilePending = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const orders = await ctx.runQuery(internal.liveTrading.pendingOrders, {});
    for (const order of orders) {
      // Give the placing action time to finish its own polling first.
      if (Date.now() - order._creationTime < 15_000) continue;
      await reconcile(ctx, order);
    }
    return null;
  },
});

export const openLivePositions = internalQuery({
  args: {},
  returns: v.array(schema.doc("livePositions")),
  handler: async (ctx) =>
    await ctx.db
      .query("livePositions")
      .withIndex("by_okxConnectionId_and_status_and_instId", (q) => q.eq("okxConnectionId", undefined).eq("status", "open"))
      .take(SWEEP_BATCH),
});

/** Close (reduce-only) any user position whose mark crossed its ledger liquidation price. */
export const sweepLiquidations = internalAction({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const cfg = tradingConfig();
    if (!cfg.mode) return 0;
    const account = platformAccount(cfg);
    const positions = await ctx.runQuery(internal.liveTrading.openLivePositions, {});
    if (positions.length === 0) return 0;
    const marks = await fetchAllMarks();
    let count = 0;
    for (const p of positions) {
      const mark = marks.get(p.instId);
      if (!mark) continue;
      const liq = liquidationPrice(toPaper(p));
      if (p.side === "up" ? mark > liq : mark < liq) continue;
      const r = await ctx.runMutation(internal.liveTrading.reserveClose, { positionId: p._id, kind: "liquidation", asOwner: false });
      if (!r) continue;
      await sendAndSettle(ctx, account, r.orderId, {
        instId: r.instId,
        side: r.side === "up" ? "sell" : "buy",
        posSide: r.side === "up" ? "long" : "short",
        sz: r.sz,
        clOrdId: r.clOrdId,
        reduceOnly: true,
        submitBy: r.submitBy,
      });
      count++;
    }
    return count;
  },
});
