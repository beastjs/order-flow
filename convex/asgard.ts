import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const openPositionsByUser = internalQuery({
  args: { issuer: v.string(), uids: v.array(v.string()) },
  returns: v.array(v.object({ uid: v.string(), up: v.number(), down: v.number() })),
  handler: async (ctx, { issuer, uids }) => {
    return await Promise.all(uids.map(async (uid) => {
      const counts = { uid, up: 0, down: 0 };
      const user = await ctx.db.query("users")
        .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", `${issuer}|${uid}`))
        .unique();
      if (!user) return counts;

      const queries = [
        ctx.db.query("positions").withIndex("by_userId_and_status", (q) => q.eq("userId", user._id).eq("status", "open")),
        ctx.db.query("livePositions").withIndex("by_userId_and_status", (q) => q.eq("userId", user._id).eq("status", "open")),
        ctx.db.query("livePositions").withIndex("by_userId_and_status", (q) => q.eq("userId", user._id).eq("status", "closing")),
      ];
      for (const query of queries) {
        for await (const position of query) counts[position.side] += 1;
      }
      return counts;
    }));
  },
});
