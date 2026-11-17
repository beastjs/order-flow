import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import schema from "./schema";
import { currentUser, requireUser } from "./lib/auth";
import { writeLog } from "./lib/log";
import { STARTING_BALANCE } from "../src/lib/paper/math";

export async function getFunds(ctx: QueryCtx | MutationCtx, userId: Doc<"users">["_id"]) {
  return await ctx.db
    .query("funds")
    .withIndex("by_userId_and_currency", (q) => q.eq("userId", userId).eq("currency", "USDT"))
    .unique();
}

export async function requireFunds(ctx: MutationCtx, userId: Doc<"users">["_id"]): Promise<Doc<"funds">> {
  const funds = await getFunds(ctx, userId);
  if (!funds) throw new Error("No funds account.");
  return funds;
}

/** The caller's paper USDT balance, or null when signed out. */
export const mine = query({
  args: {},
  returns: v.union(schema.doc("funds"), v.null()),
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    return user ? await getFunds(ctx, user._id) : null;
  },
});

/** Restore the starting paper balance. Close open positions first. */
export const resetPaper = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const open = await ctx.db
      .query("positions")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", user._id).eq("status", "open"))
      .first();
    if (open) throw new Error("Close your open positions before resetting.");

    const funds = await requireFunds(ctx, user._id);
    const amount = STARTING_BALANCE - funds.balance;
    await ctx.db.patch("funds", funds._id, { balance: STARTING_BALANCE, locked: 0 });
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "funds_reset",
      message: "Paper balance reset",
      amount,
      balanceAfter: STARTING_BALANCE,
    });
    await writeLog(ctx, "info", "funds.resetPaper", "paper balance reset", { userId: user._id, data: { amount } });
    return null;
  },
});
