import { defineConfig } from "vitest/config";

// Convex function tests (convex-test). Named *.vitest.ts so `bun test`
// (which owns *.test.ts) doesn't try to run them without import.meta.glob.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.vitest.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
