import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import schema, { activityKind } from "./schema";
import { currentUser } from "./lib/auth";

/** The caller's activity feed, newest first; optionally one kind only. */
export const listMine = query({
  args: { kind: v.optional(activityKind), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("activity")),
  handler: async (ctx, { kind, paginationOpts }) => {
    const user = await currentUser(ctx);
    if (!user) return { page: [], isDone: true, continueCursor: "" };
    const q = kind
      ? ctx.db.query("activity").withIndex("by_userId_and_kind", (i) => i.eq("userId", user._id).eq("kind", kind))
      : ctx.db.query("activity").withIndex("by_userId", (i) => i.eq("userId", user._id));
    return await q.order("desc").paginate(paginationOpts);
  },
});
