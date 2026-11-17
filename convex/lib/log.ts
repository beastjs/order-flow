import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { logData, logLevel } from "../schema";

/** Append to the `logs` table inside the caller's transaction. */
export async function writeLog(
  ctx: MutationCtx,
  level: Infer<typeof logLevel>,
  source: string,
  message: string,
  extra: { userId?: Id<"users">; data?: Infer<typeof logData> } = {},
): Promise<void> {
  await ctx.db.insert("logs", { level, source, message, ...extra });
}
