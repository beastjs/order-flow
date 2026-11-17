import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import schema from "./schema";
import { currentUser, requireIdentity } from "./lib/auth";
import { writeLog } from "./lib/log";
import { STARTING_BALANCE } from "../src/lib/paper/math";

/**
 * Create or refresh the caller's user row from their verified Firebase token.
 * Call once after every sign-in. New accounts get a paper USDT balance.
 */
export const store = mutation({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const profile = {
      email: identity.email ?? undefined,
      name: identity.name ?? undefined,
      photoURL: identity.pictureUrl ?? undefined,
    };

    const existing = await currentUser(ctx);
    if (existing) {
      if (
        existing.email !== profile.email ||
        existing.name !== profile.name ||
        existing.photoURL !== profile.photoURL
      ) {
        await ctx.db.patch("users", existing._id, profile);
      }
      return existing._id;
    }

    const userId = await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      firebaseUid: identity.subject,
      role: "user",
      ...profile,
    });
    await ctx.db.insert("funds", {
      userId,
      currency: "USDT",
      mode: "paper",
      balance: STARTING_BALANCE,
      locked: 0,
    });
    await ctx.db.insert("activity", {
      userId,
      kind: "account_created",
      message: `Account created with ${STARTING_BALANCE.toLocaleString("en-US")} paper USDT`,
      amount: STARTING_BALANCE,
      balanceAfter: STARTING_BALANCE,
    });
    await writeLog(ctx, "info", "users.store", "user created", { userId });
    return userId;
  },
});

/** The signed-in user's profile, or null when signed out / not stored yet. */
export const me = query({
  args: {},
  returns: v.union(schema.doc("users"), v.null()),
  handler: async (ctx) => await currentUser(ctx),
});
