import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Owns the run's browser profiles and checks no browser outlives the run;
    // in CI also builds the app the browser tests start (tests/global-setup.ts).
    globalSetup: ["tests/global-setup.ts"],
    // Closes the export browser each test file launched (#204).
    setupFiles: ["tests/setup/close-export-browser.ts"],
    // Storage tests redirect the data directory by changing the working
    // directory, which is only available in child processes, not worker
    // threads. Running one file at a time keeps that switch deterministic.
    pool: "forks",
    fileParallelism: false,
  },
});
