/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asgardPositionCountsPath } from "../src/lib/asgard/users";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const issuer = "https://securetoken.google.com/asgard-test";
const secret = "asgard-test-secret";
const god = { subject: "asgard-viewer", issuer, god: true };
const headers = { "x-asgard-secret": secret, "content-type": "application/json" };
const instrument = { instId: "AAPL-USDT-SWAP", base: "AAPL", category: "stock" as const };

afterEach(() => vi.unstubAllEnvs());

describe("Asgard open position counts", () => {
  it("requires both the Asgard server credential and the viewer's god claim", async () => {
    vi.stubEnv("ASGARD_POSITION_COUNTS_SECRET", secret);
    const t = convexTest(schema, modules);
    const body = JSON.stringify(["target"]);
    const viewer = t.withIdentity(god);
    const admin = t.withIdentity({ subject: "admin", issuer, admin: true });
    expect((await viewer.fetch(asgardPositionCountsPath, { method: "POST", body })).status).toBe(403);
    expect((await t.fetch(asgardPositionCountsPath, { method: "POST", headers, body })).status).toBe(403);
    expect((await admin.fetch(asgardPositionCountsPath, { method: "POST", headers, body })).status).toBe(403);
    expect((await viewer.fetch(asgardPositionCountsPath, { method: "POST", headers, body: "{}" })).status).toBe(400);
  });

  it("counts open paper and open or closing OKX positions per authorized directory UID", async () => {
    vi.stubEnv("ASGARD_POSITION_COUNTS_SECRET", secret);
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { tokenIdentifier: `${issuer}|target`, firebaseUid: "target", role: "user" });
      const otherUserId = await ctx.db.insert("users", { tokenIdentifier: "other-issuer|target", firebaseUid: "target", role: "user" });
      const paper = { ...instrument, userId, side: "up" as const, margin: 10, leverage: 1, entry: 10, size: 1, openFee: 0, openedAt: 10 };
      const live = { ...paper, ctVal: 1, contractsSz: "1" };

      await ctx.db.insert("positions", { ...paper, status: "open" });
      await ctx.db.insert("positions", { ...paper, status: "open", userId: otherUserId });
      await ctx.db.insert("positions", { ...paper, status: "closed", side: "down" });
      await ctx.db.insert("livePositions", { ...live, status: "open", side: "down" });
      await ctx.db.insert("livePositions", { ...live, status: "closing", side: "down" });
      await ctx.db.insert("livePositions", { ...live, status: "opening" });
      await ctx.db.insert("livePositions", { ...live, status: "closed" });
    });

    const response = await t.withIdentity(god).fetch(asgardPositionCountsPath, {
      method: "POST",
      headers,
      body: JSON.stringify(["target", "unregistered", "target"]),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual([
      { uid: "target", up: 1, down: 2 },
      { uid: "unregistered", up: 0, down: 0 },
    ]);
  });
});
