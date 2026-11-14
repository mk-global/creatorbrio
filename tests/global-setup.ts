/**
 * Owns the browsers the test run launches (#204): it creates a folder for the
 * run, in which every browser Puppeteer launches with a temporary profile, in
 * the test workers and in the app servers they start, keeps that profile, and
 * when the run ends it fails the run if any of those browsers is still
 * running, after stopping it, and removes the folder with every profile left
 * in it. A run whose runner was killed before its end is cleaned up by the
 * next run. See tests/helpers/browser-census.ts.
 *
 * Before the suite runs in CI, it also makes sure the production build the browser
 * tests start is there and current (#175). CI checks out the sources with no
 * build, and the workflow's own Build step runs after the tests, so without
 * this every built-app test would have nothing to start. Locally nothing is
 * built: a stale build skips those tests with the reason instead, so a test
 * run never rewrites a developer's `.next` folder behind their back.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { builtAppMissing } from "./helpers/studio-app";
import { createTestRun, endAbandonedRuns, endTestRun } from "./helpers/browser-census";

export default async function setup(): Promise<() => Promise<void>> {
  const abandoned = await endAbandonedRuns();
  if (abandoned.runs > 0) {
    console.log(
      `[global-setup] cleaned up ${abandoned.runs} earlier test run(s) whose runner had stopped, stopping ${abandoned.survivors} browser process(es)`
    );
  }
  const run = createTestRun();
  // Inherited by the test workers, which start after global setup.
  process.env.PUPPETEER_TMP_DIR = run.workers;
  process.env.CREATORBRIO_TEST_APP_BROWSER_DIR = run.appServers;

  buildForCi();

  return async () => {
    const census = await endTestRun(run);
    const left = census.workerProfiles + census.appServerProfiles;
    if (left > 0) console.log(`[global-setup] removed ${left} browser profile(s) the run left behind`);
    if (census.survivors > 0) {
      // Vitest reports an error thrown here but still exits 0 (4.1.11), so
      // the exit status is set as well, which fails the run in CI.
      process.exitCode = 1;
      throw new Error(
        `${census.survivors} browser process(es) launched by this test run were still running after it, and have been stopped. ` +
          "A test launched a browser and never closed it (#204)."
      );
    }
  };
}

function buildForCi(): void {
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
