import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { followUpCriteria } from "../src/lib/paper/math";

export const side = v.union(v.literal("up"), v.literal("down"));
export const category = v.union(
  v.literal("crypto"),
  v.literal("stock"),
  v.literal("commodity"),
  v.literal("other"),
);
export const positionStatus = v.union(v.literal("open"), v.literal("closed"), v.literal("liquidated"));
export const autoExitReason = v.union(
  v.literal("stop_loss"), v.literal("take_profit"),
  v.literal("total_stop_loss"), v.literal("total_take_profit"),
);
export const exitTargetFields = {
  stopLoss: v.union(v.number(), v.null()),
  takeProfit: v.union(v.number(), v.null()),
};
export const followUpOrder = v.object({
  instId: v.string(),
  side,
  margin: v.number(),
  leverage: v.number(),
  exitTargets: v.object(exitTargetFields),
  criteria: v.optional(v.array(v.union(...followUpCriteria.map(({ code }) => v.literal(code))))),
});
const followUpResult = v.union(
  v.object({ status: v.literal("pending") }),
  v.object({ status: v.literal("opened") }),
  v.object({ status: v.literal("skipped") }),
  v.object({ status: v.literal("failed"), error: v.string() }),
);
// USDT = paper trading balance; USD = real top-ups (never touched by Reset).
export const currency = v.union(v.literal("USDT"), v.literal("USD"));
export const fundsMode = v.union(v.literal("paper"), v.literal("live"));
export const stableSymbol = v.union(v.literal("USDC"), v.literal("USDT"));
export const nativeSymbol = v.union(v.literal("ETH"), v.literal("POL"));
/** Anything a top-up can be paid in: a stablecoin or the chain's native coin. */
export const depositSymbol = v.union(stableSymbol, nativeSymbol);
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
  v.literal("live_position_opened"),
  v.literal("live_position_closed"),
  v.literal("live_position_liquidated"),
  v.literal("live_order_failed"),
);
// Real-order positions on the platform OKX account (ledger per user).
export const livePositionStatus = v.union(
  v.literal("opening"),
  v.literal("open"),
  v.literal("closing"),
  v.literal("closed"),
  v.literal("liquidated"),
);
export const okxMode = v.union(v.literal("demo"), v.literal("live"));
export const okxConnectionFields = {
  mode: okxMode,
  accountUid: v.string(),
  keySuffix: v.string(),
  iv: v.string(),
  ciphertext: v.string(),
};
export const liveOrderKind = v.union(v.literal("open"), v.literal("close"), v.literal("liquidation"));
export const liveOrderStatus = v.union(
  v.literal("pending"),
  v.literal("filled"),
  v.literal("rejected"),
  v.literal("failed"),
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
    paperResetAt: v.optional(v.number()),
    totalExitTargets: v.optional(v.object({ ...exitTargetFields, setAt: v.number() })),
  })
    .index("by_userId_and_currency", ["userId", "currency"])
    .index("by_currency_and_totalExitTargets_setAt", ["currency", "totalExitTargets.setAt"]),

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
    exitTargets: v.optional(v.object({ ...exitTargetFields, setAt: v.number() })),
    autoExitReason: v.optional(autoExitReason),
    followUpOrder: v.optional(followUpOrder),
    followUpResult: v.optional(followUpResult),
  })
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_userId_and_closedAt", ["userId", "closedAt"])
    .index("by_status_and_exitTargets_setAt", ["status", "exitTargets.setAt"])
    .index("by_userId_and_instId_and_status", ["userId", "instId", "status"])
    .index("by_status_and_instId", ["status", "instId"]),

  assetPositionCounts: defineTable({
    instId: v.string(),
    up: v.number(),
    down: v.number(),
    ready: v.boolean(),
  }).index("by_instId", ["instId"]),

  assetPositionMembers: defineTable({
    instId: v.string(),
    userId: v.id("users"),
    up: v.boolean(),
    down: v.boolean(),
  }).index("by_instId_and_userId", ["instId", "userId"]),

  // User-facing feed. `amount` is the signed change to free balance.
  activity: defineTable({
    userId: v.id("users"),
    kind: activityKind,
    message: v.string(),
    positionId: v.optional(v.id("positions")),
    instId: v.optional(v.string()),
    partiallyClosed: v.optional(v.literal(true)),
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
    token: v.optional(depositSymbol),
    from: v.optional(v.string()),
    /** Token base units as a decimal string (bigint-safe): 6dp stables, 18dp (wei) native. */
    amountUnits: v.optional(v.string()),
    /** Native coins only: Chainlink USD price locked when the mined tx was first seen. */
    priceUsd: v.optional(v.number()),
    amountUsd: v.optional(v.number()),
    blockNumber: v.optional(v.number()),
    confirmations: v.optional(v.number()),
    requiredConfirmations: v.number(),
    attempts: v.number(),
    creditedAt: v.optional(v.number()),
  })
    .index("by_chainId_and_txHash", ["chainId", "txHash"])
    .index("by_userId", ["userId"]),

  okxConnections: defineTable({ userId: v.id("users"), ...okxConnectionFields })
    .index("by_userId", ["userId"])
    .index("by_mode_and_accountUid", ["mode", "accountUid"]),

  // Orders with a connection trade against the user's OKX balance. Legacy
  // positions use the platform account and the CFX USD ledger.
  livePositions: defineTable({
    userId: v.id("users"),
    okxConnectionId: v.optional(v.id("okxConnections")),
    okxMode: v.optional(okxMode),
    closedExternally: v.optional(v.boolean()),
    instId: v.string(),
    base: v.string(),
    category,
    side,
    /** Ledger leverage the user chose (exchange leverage is platform-wide). */
    leverage: v.number(),
    /** Base units per contract. */
    ctVal: v.number(),
    /** Filled contracts as OKX's exact `sz` string (used for the closing order). */
    contractsSz: v.string(),
    /** Base units (contracts × ctVal). */
    size: v.number(),
    entry: v.number(),
    /** USD locked from the user's balance. */
    margin: v.number(),
    /** Actual opening fee paid on OKX (positive). */
    openFee: v.number(),
    status: livePositionStatus,
    exit: v.optional(v.number()),
    closeFee: v.optional(v.number()),
    /** Net PnL after both fees (what the user gained/lost). */
    realized: v.optional(v.number()),
    openedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_userId_and_closedAt", ["userId", "closedAt"])
    .index("by_userId_and_instId_and_status", ["userId", "instId", "status"])
    .index("by_userId_and_status_and_okxConnectionId", ["userId", "status", "okxConnectionId"])
    .index("by_userId_and_okxConnectionId_and_instId_and_status", ["userId", "okxConnectionId", "instId", "status"])
    .index("by_okxConnectionId_and_status", ["okxConnectionId", "status"])
    .index("by_okxConnectionId_and_status_and_instId", ["okxConnectionId", "status", "instId"])
    .index("by_status_and_instId", ["status", "instId"]),

  // Every order sent (or about to be sent) to OKX. Written BEFORE placement
  // with a unique clOrdId so a crash can always be reconciled.
  liveOrders: defineTable({
    userId: v.id("users"),
    okxConnectionId: v.optional(v.id("okxConnections")),
    positionId: v.id("livePositions"),
    instId: v.string(),
    kind: liveOrderKind,
    side,
    clOrdId: v.string(),
    /** Requested contracts (OKX sz). */
    sz: v.string(),
    status: liveOrderStatus,
    /** Open orders: USD moved from balance to locked until settlement. */
    reservedUsd: v.optional(v.number()),
    /** Open orders: the margin the user asked for. */
    margin: v.optional(v.number()),
    leverage: v.optional(v.number()),
    ordId: v.optional(v.string()),
    filledSz: v.optional(v.number()),
    avgPx: v.optional(v.number()),
    /** Fee charged (positive USD). */
    fee: v.optional(v.number()),
    error: v.optional(v.string()),
    lastReconciledAt: v.optional(v.number()),
    attempts: v.number(),
  })
    .index("by_clOrdId", ["clOrdId"])
    .index("by_status", ["status"])
    .index("by_status_and_lastReconciledAt", ["status", "lastReconciledAt"])
    .index("by_userId", ["userId"])
    .index("by_positionId", ["positionId"]),

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
