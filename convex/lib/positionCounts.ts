import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export function assetPositionCounts(ctx: QueryCtx | MutationCtx, instId: string) {
  return ctx.db.query("assetPositionCounts").withIndex("by_instId", (q) => q.eq("instId", instId)).unique();
}

export async function hasOpenPositions(ctx: QueryCtx | MutationCtx, instId: string): Promise<boolean> {
  const rows = await Promise.all([
    ctx.db.query("positions").withIndex("by_status_and_instId", (q) => q.eq("status", "open").eq("instId", instId)).first(),
    ctx.db.query("livePositions").withIndex("by_status_and_instId", (q) => q.eq("status", "open").eq("instId", instId)).first(),
    ctx.db.query("livePositions").withIndex("by_status_and_instId", (q) => q.eq("status", "closing").eq("instId", instId)).first(),
  ]);
  return rows.some(Boolean);
}

export async function startPositionCountBackfill(ctx: MutationCtx, instId: string): Promise<Omit<Doc<"assetPositionCounts">, "_creationTime">> {
  const counts = { instId, up: 0, down: 0, ready: false };
  const countsId = await ctx.db.insert("assetPositionCounts", counts);
  await ctx.scheduler.runAfter(0, internal.positions.backfillAssetPositionCounts, { countsId, source: "paper", cursor: null });
  return { _id: countsId, ...counts };
}

/** Maintain one membership per user and instrument, with independent Up and Down flags. */
export async function syncAssetPositionCounts(ctx: MutationCtx, instId: string, userId: Id<"users">): Promise<void> {
  const [member, paper, liveOpen, liveClosing] = await Promise.all([
    ctx.db.query("assetPositionMembers").withIndex("by_instId_and_userId", (q) => q.eq("instId", instId).eq("userId", userId)).unique(),
    ctx.db.query("positions").withIndex("by_userId_and_instId_and_status", (q) =>
      q.eq("userId", userId).eq("instId", instId).eq("status", "open")).first(),
    ctx.db.query("livePositions").withIndex("by_userId_and_instId_and_status", (q) =>
      q.eq("userId", userId).eq("instId", instId).eq("status", "open")).first(),
    ctx.db.query("livePositions").withIndex("by_userId_and_instId_and_status", (q) =>
      q.eq("userId", userId).eq("instId", instId).eq("status", "closing")).first(),
  ]);
  const positions = [paper, liveOpen, liveClosing];
  const up = positions.some((position) => position?.side === "up");
  const down = positions.some((position) => position?.side === "down");
  const upChange = Number(up) - Number(member?.up ?? false);
  const downChange = Number(down) - Number(member?.down ?? false);
  if (!upChange && !downChange) return;

  const counts = await assetPositionCounts(ctx, instId) ?? await startPositionCountBackfill(ctx, instId);
  if (member && !up && !down) await ctx.db.delete("assetPositionMembers", member._id);
  else if (member) await ctx.db.patch("assetPositionMembers", member._id, { up, down });
  else await ctx.db.insert("assetPositionMembers", { instId, userId, up, down });

  await ctx.db.patch("assetPositionCounts", counts._id, {
    up: counts.up + upChange,
    down: counts.down + downChange,
  });
}
