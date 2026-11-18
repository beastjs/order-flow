import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Verified Firebase identity, or throw. Never trust an id passed as an argument. */
export async function requireIdentity(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in.");
  return identity;
}

/** The caller's `users` row, or null if they haven't been stored yet. */
export async function currentUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

/** The caller's `users` row, or throw. Call `users.store` after sign-in to create it. */
export async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  await requireIdentity(ctx);
  const user = await currentUser(ctx);
  if (!user) throw new Error("Account not initialised. Call users.store after sign-in.");
  return user;
}

/** Non-throwing admin check (role or Firebase `admin`/`god` claim). */
export async function isAdmin(ctx: QueryCtx | MutationCtx, user: Doc<"users">): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  const claims = (identity ?? {}) as unknown as Record<string, unknown>;
  return user.role === "admin" || claims.admin === true || claims.god === true;
}

/** Admins: `role: "admin"` in Convex, or Firebase custom claim `admin`/`god` on the token. */
export async function requireAdmin(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const identity = await requireIdentity(ctx);
  const user = await requireUser(ctx);
  const claims = identity as unknown as Record<string, unknown>;
  if (user.role !== "admin" && claims.admin !== true && claims.god !== true) throw new Error("Admins only.");
  return user;
}
