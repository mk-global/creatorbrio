/**
 * The browser and build an app-level browser test needs, and whether it may
 * skip without them (#175).
 *
 * CI installs dependencies with install scripts off, so Puppeteer never
 * downloads its own Chromium there; the runner's system Chrome is used
 * instead. Locally a missing browser or a stale build skips the test with the
 * reason, as the other built-app tests do. In CI nothing is allowed to skip:
 * a missing prerequisite fails the run, so the browser tests cannot quietly
 * stop running.
 */
import { existsSync } from "node:fs";
import { chromiumPath } from "./native-pdf";
import { builtAppMissing } from "./studio-app";

// The real binaries come first: /usr/bin/google-chrome on Linux is a shell
// wrapper that needs readlink and dirname on PATH, and the test server's PATH
// holds only Node and the media tools, so the wrapper cannot start there.
const SYSTEM_BROWSERS = [
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Puppeteer's Chromium when it is installed, otherwise a system Chrome or Chromium, otherwise null. */
export function appBrowser(): string | null {
  return chromiumPath() ?? SYSTEM_BROWSERS.find((candidate) => existsSync(candidate)) ?? null;
}

export const inCi = Boolean(process.env.CI);

/** Why an app browser test cannot run here, or null when it can. */
export function appBrowserTestMissing(): string | null {
  return builtAppMissing() ?? (appBrowser() ? null : "no Chromium or Chrome found");
}
