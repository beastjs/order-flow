import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    ASGARD_POSITION_COUNTS_SECRET: v.optional(v.string()),
    OKX_USER_KEY_ENCRYPTION_KEY: v.optional(v.string()),
    PAPER_TOTAL_EXIT_POLL_SECONDS: v.optional(v.string()),
  },
});
