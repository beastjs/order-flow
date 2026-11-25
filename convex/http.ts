import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";
import { asgardPositionCountsPath, asgardUsersPageSize } from "../src/lib/asgard/users";

const http = httpRouter();
const batchSize = 20;

function secretsMatch(expected: string | undefined, received: string | null): boolean {
  if (!expected || received?.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return difference === 0;
}

function isUidList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= asgardUsersPageSize && value.every(
    (uid) => typeof uid === "string" && uid.length > 0 && uid.length <= 128,
  );
}

http.route({
  path: asgardPositionCountsPath,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // The Asgard server is responsible for checking which directory users the viewer may see.
    if (!secretsMatch(env.ASGARD_POSITION_COUNTS_SECRET, request.headers.get("x-asgard-secret"))) {
      return new Response(null, { status: 403 });
    }
    const identity = await ctx.auth.getUserIdentity();
    if (identity?.god !== true) return new Response(null, { status: 403 });

    const uids: unknown = await request.json().catch(() => null);
    if (!isUidList(uids)) return new Response(null, { status: 400 });

    const unique = [...new Set(uids)];
    const batches = Array.from({ length: Math.ceil(unique.length / batchSize) }, (_, index) =>
      unique.slice(index * batchSize, (index + 1) * batchSize),
    );
    const results = await Promise.all(batches.map((batch) => ctx.runQuery(internal.asgard.openPositionsByUser, {
      issuer: identity.issuer,
      uids: batch,
    })));
    return Response.json(results.flat(), { headers: { "cache-control": "no-store" } });
  }),
});

export default http;
