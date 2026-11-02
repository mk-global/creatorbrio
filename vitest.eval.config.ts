import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Evaluations that call the real Claude CLI. They cost money and are not
 * deterministic, so they never run under `npm test`; run them explicitly with
 * `npx vitest run --config vitest.eval.config.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["eval/**/*.eval.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 120_000,
  },
});
