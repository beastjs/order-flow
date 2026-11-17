import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import schema, { logData, logLevel } from "./schema";
import { requireAdmin } from "./lib/auth";
import { writeLog } from "./lib/log";

/** Admin-only log viewer, newest first; optionally filtered by level. */
export const list = query({
  args: { level: v.optional(logLevel), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("logs")),
  handler: async (ctx, { level, paginationOpts }) => {
    await requireAdmin(ctx);
    const q = level
      ? ctx.db.query("logs").withIndex("by_level", (i) => i.eq("level", level))
      : ctx.db.query("logs");
    return await q.order("desc").paginate(paginationOpts);
  },
});

/** For actions and crons: append a log line (mutations call writeLog directly). */
export const write = internalMutation({
  args: {
    level: logLevel,
    source: v.string(),
    message: v.string(),
    userId: v.optional(v.id("users")),
    data: v.optional(logData),
  },
  returns: v.null(),
  handler: async (ctx, { level, source, message, ...extra }) => {
    await writeLog(ctx, level, source, message, extra);
    return null;
  },
});
