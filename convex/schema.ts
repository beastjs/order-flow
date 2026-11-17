import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const side = v.union(v.literal("up"), v.literal("down"));
export const category = v.union(
  v.literal("crypto"),
  v.literal("stock"),
  v.literal("commodity"),
  v.literal("other"),
);
export const positionStatus = v.union(v.literal("open"), v.literal("closed"), v.literal("liquidated"));
// USDT = paper trading balance; USD = real top-ups (never touched by Reset).
export const currency = v.union(v.literal("USDT"), v.literal("USD"));
export const fundsMode = v.union(v.literal("paper"), v.literal("live"));
export const stableSymbol = v.union(v.literal("USDC"), v.literal("USDT"));
export const depositStatus = v.union(
  v.literal("pending"),
  v.literal("credited"),
  v.literal("under_minimum"),
  v.literal("rejected"),
  v.literal("failed"),
);
export const activityKind = v.union(
  v.literal("account_created"),
  v.literal("position_opened"),
  v.literal("position_closed"),
  v.literal("position_liquidated"),
  v.literal("funds_reset"),
  v.literal("wallet_linked"),
  v.literal("deposit_credited"),
);
export const logLevel = v.union(v.literal("debug"), v.literal("info"), v.literal("warn"), v.literal("error"));
/** Small, flat, typed context for log lines (no `any`). */
export const logData = v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()));

export default defineSchema({
  // One row per Firebase account. Identity is derived server-side from the
  // verified token; `tokenIdentifier` is the canonical ownership key.
  users: defineTable({
    tokenIdentifier: v.string(),
    firebaseUid: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    photoURL: v.optional(v.string()),
    role: v.union(v.literal("user"), v.literal("admin")),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_email", ["email"]),

  // Balance per user per currency. `locked` is margin held by open positions;
  // `balance` is what is free to trade.
  funds: defineTable({
    userId: v.id("users"),
    currency,
    mode: fundsMode,
    balance: v.number(),
    locked: v.number(),
  }).index("by_userId_and_currency", ["userId", "currency"]),

  // Isolated-margin perpetual positions. Entry/exit prices come from OKX,
  // fetched server-side, never from the client.
  positions: defineTable({
    userId: v.id("users"),
    instId: v.string(),
    base: v.string(),
    category,
    side,
    margin: v.number(),
    leverage: v.number(),
    entry: v.number(),
    size: v.number(),
    openFee: v.number(),
    status: positionStatus,
    exit: v.optional(v.number()),
    closeFee: v.optional(v.number()),
    realized: v.optional(v.number()),
    openedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_userId_and_instId_and_status", ["userId", "instId", "status"])
    .index("by_status_and_instId", ["status", "instId"]),

  // User-facing feed. `amount` is the signed change to free balance.
  activity: defineTable({
    userId: v.id("users"),
    kind: activityKind,
    message: v.string(),
    positionId: v.optional(v.id("positions")),
    instId: v.optional(v.string()),
    amount: v.optional(v.number()),
    balanceAfter: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_kind", ["userId", "kind"]),

  // Wallets a user proved they own (signed message). Top-ups are only
  // credited when sent FROM one of these, so a watcher can't claim someone
  // else's transaction hash.
  wallets: defineTable({
    userId: v.id("users"),
    /** Checksummed EVM address. */
    address: v.string(),
    linkedAt: v.number(),
  })
    .index("by_address", ["address"])
    .index("by_userId", ["userId"]),

  // On-chain top-ups, one row per (chain, tx). Credited at most once.
  deposits: defineTable({
    userId: v.id("users"),
    chainId: v.number(),
    /** Lower-case 0x-prefixed hash. */
    txHash: v.string(),
    status: depositStatus,
    reason: v.optional(v.string()),
    token: v.optional(stableSymbol),
    from: v.optional(v.string()),
    /** Token base units as a decimal string (bigint-safe). */
    amountUnits: v.optional(v.string()),
    amountUsd: v.optional(v.number()),
    blockNumber: v.optional(v.number()),
    confirmations: v.optional(v.number()),
    requiredConfirmations: v.number(),
    attempts: v.number(),
    creditedAt: v.optional(v.number()),
  })
    .index("by_chainId_and_txHash", ["chainId", "txHash"])
    .index("by_userId", ["userId"]),

  // Server-side operational log. Written only by backend code.
  logs: defineTable({
    level: logLevel,
    source: v.string(),
    message: v.string(),
    userId: v.optional(v.id("users")),
    data: v.optional(logData),
  })
    .index("by_level", ["level"])
    .index("by_source", ["source"])
    .index("by_userId", ["userId"]),
});
