import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { currentUser, requireUser } from "./lib/auth";
import { ACTIVE_LIVE_STATUSES, connectionForUser, encryptCredentials, personalAccount, personalTradingEnabled } from "./lib/okxCredentials";
import { getAccountConfig, getAvailableUsdt, tradingConfig } from "./lib/okxTrade";
import schema, { okxConnectionFields, okxMode } from "./schema";

export const status = query({
  args: {},
  returns: v.object({
    enabled: v.boolean(),
    connection: v.union(v.null(), v.object({ mode: okxMode, keySuffix: v.string(), revision: v.string() })),
  }),
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const connection = user && await connectionForUser(ctx, user._id);
    return {
      enabled: !!user && personalTradingEnabled(),
      connection: connection ? { mode: connection.mode, keySuffix: connection.keySuffix, revision: connection.iv } : null,
    };
  },
});

export const readMine = internalQuery({
  args: {},
  returns: v.object({ userId: v.id("users"), connection: v.union(v.null(), schema.doc("okxConnections")) }),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return { userId: user._id, connection: await connectionForUser(ctx, user._id) };
  },
});

export const readForOrder = internalQuery({
  args: { connectionId: v.id("okxConnections"), userId: v.id("users") },
  returns: v.union(v.null(), schema.doc("okxConnections")),
  handler: async (ctx, { connectionId, userId }) => {
    const connection = await ctx.db.get("okxConnections", connectionId);
    return connection?.userId === userId ? connection : null;
  },
});

async function requireFlat(ctx: MutationCtx, connectionId: Id<"okxConnections">) {
  for (const status of ACTIVE_LIVE_STATUSES) {
    const active = await ctx.db.query("livePositions")
      .withIndex("by_okxConnectionId_and_status", (q) => q.eq("okxConnectionId", connectionId).eq("status", status))
      .first();
    if (active) throw new ConvexError("Close your My OKX positions and wait for pending orders before changing accounts or disconnecting.");
  }
}

export const save = internalMutation({
  args: { ...okxConnectionFields, previousRevision: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { previousRevision, ...data }) => {
    const user = await requireUser(ctx);
    const existing = await connectionForUser(ctx, user._id);
    if ((existing?.iv ?? null) !== previousRevision) throw new ConvexError("Your connection changed. Try again.");
    const claimed = await ctx.db.query("okxConnections")
      .withIndex("by_mode_and_accountUid", (q) => q.eq("mode", data.mode).eq("accountUid", data.accountUid))
      .unique();
    if (claimed && claimed.userId !== user._id) throw new ConvexError("This OKX account is already connected to CFX.");
    if (existing && existing.mode === data.mode && existing.accountUid === data.accountUid) {
      await ctx.db.patch("okxConnections", existing._id, data);
    } else {
      if (existing) {
        await requireFlat(ctx, existing._id);
        await ctx.db.delete("okxConnections", existing._id);
      }
      await ctx.db.insert("okxConnections", { userId: user._id, ...data });
    }
    return null;
  },
});

export const connect = action({
  args: { mode: okxMode, key: v.string(), secret: v.string(), passphrase: v.string() },
  returns: v.null(),
  handler: async (ctx, { mode, ...args }): Promise<null> => {
    const { userId, connection }: { userId: Id<"users">; connection: Doc<"okxConnections"> | null } =
      await ctx.runQuery(internal.okxConnections.readMine, {});
    if (!personalTradingEnabled()) throw new ConvexError("Trading with your own OKX account is unavailable.");
    const credentials = { key: args.key.trim(), secret: args.secret.trim(), passphrase: args.passphrase.trim() };
    if (credentials.key.length < 8 || Object.values(credentials).some((value) => !/^[\x21-\x7e]{1,256}$/.test(value))) {
      throw new ConvexError("Enter a valid OKX API key, secret and passphrase.");
    }
    if (credentials.key === tradingConfig().credentials?.key) throw new ConvexError("Use an API key from your own OKX account.");
    const config = await getAccountConfig({ mode, credentials, personal: true }).catch(() => {
      throw new ConvexError("Could not verify your OKX key. Check the key, secret, passphrase, environment and any IP restrictions.");
    });
    const permissions = new Set(config?.perm?.split(",").map((permission) => permission.trim()));
    if (!config?.uid || permissions.size !== 2 || !permissions.has("read_only") || !permissions.has("trade")) {
      throw new ConvexError("Use an OKX API key with Read and Trade permissions only.");
    }
    if ((config.acctLv !== "2" && config.acctLv !== "3") || config.posMode !== "long_short_mode") {
      throw new ConvexError("In OKX, select Futures or Multi-currency margin account mode and Long/short position mode.");
    }
    const accountUid = config.uid;
    const encrypted = await encryptCredentials({ userId, mode, accountUid }, credentials);
    return await ctx.runMutation(internal.okxConnections.save, {
      ...encrypted, mode, accountUid, keySuffix: credentials.key.slice(-4), previousRevision: connection?.iv ?? null,
    });
  },
});

export const disconnect = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const existing = await connectionForUser(ctx, user._id);
    if (existing) {
      await requireFlat(ctx, existing._id);
      await ctx.db.delete("okxConnections", existing._id);
    }
    return null;
  },
});

export const balance = action({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const { connection }: { connection: Doc<"okxConnections"> | null } = await ctx.runQuery(internal.okxConnections.readMine, {});
    if (!connection) throw new ConvexError("Connect your OKX account first.");
    const account = await personalAccount(connection);
    return await getAvailableUsdt(account).catch(() => {
      throw new ConvexError("Could not read your OKX balance. Check your connection or refresh the balance.");
    });
  },
});
