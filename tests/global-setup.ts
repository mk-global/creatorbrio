/**
 * Before the suite runs in CI, make sure the production build the browser
 * tests start is there and current (#175). CI checks out the sources with no
 * build, and the workflow's own Build step runs after the tests, so without
 * this every built-app test would have nothing to start. Locally nothing is
 * built: a stale build skips those tests with the reason instead, so a test
 * run never rewrites a developer's `.next` folder behind their back.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { builtAppMissing } from "./helpers/studio-app";

export default function setup(): void {
  if (!process.env.CI) return;
  const missing = builtAppMissing();
  if (!missing) return;
  console.log(`[global-setup] building the app for the browser tests: ${missing}`);
  const root = path.resolve(__dirname, "..");
  execFileSync(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build"], {
    cwd: root,
    stdio: "inherit",
    // Vitest sets NODE_ENV=test, which Next.js refuses for a production build.
    env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
  });
}
