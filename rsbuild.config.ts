import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "@rsbuild/core";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";
import { beastOctane } from "beast-tsrx/rsbuild";
import { beastDevtools } from "@beastjs/devtools/rsbuild";
import { beastPageBuilder } from "@beastjs/page-builder/rsbuild";

// `npx convex dev` owns CONVEX_URL in .env.local. Expose it to the browser as
// PUBLIC_CONVEX_URL without a second copy in .env.local (a duplicate stops
// Convex from updating the file). An explicit PUBLIC_CONVEX_URL still wins.
const { parsed } = loadEnv({ mode: process.env.NODE_ENV === "production" ? "production" : "development" });
const convexUrl = process.env.PUBLIC_CONVEX_URL || parsed.PUBLIC_CONVEX_URL || process.env.CONVEX_URL || parsed.CONVEX_URL || "";

export default defineConfig({
  source: {
    entry: { index: "./src/main.ts" },
    define: { "import.meta.env.PUBLIC_CONVEX_URL": JSON.stringify(convexUrl) },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  html: { template: "./index.html" },
  server: { historyApiFallback: true },
  plugins: [pluginTailwindcss(), ...beastOctane({ octane: { profile: process.env.NODE_ENV !== "production" } }), beastDevtools(), beastPageBuilder()],
});
