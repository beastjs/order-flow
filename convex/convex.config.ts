import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({ env: { OKX_USER_KEY_ENCRYPTION_KEY: v.optional(v.string()) } });
