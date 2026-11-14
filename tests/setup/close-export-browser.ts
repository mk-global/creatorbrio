/**
 * After each test file, closes the export browser its tests launched (#204).
 *
 * The export browser is shared and stays open between exports, so a test file
 * that exported something ends with it still running. Left to the test
 * worker's exit, Puppeteer kills it there without removing its profile, and a
 * worker that is itself killed leaves it running with no owner. Closing it
 * here, while the worker still runs, lets Puppeteer finish its own cleanup.
 *
 * Only a browser this test run launched is closed: one whose profile is inside
 * the run's `PUPPETEER_TMP_DIR` (tests/global-setup.ts). A test file that
 * replaces Puppeteer with a fake never matches, so its fake processes are
 * never signalled.
 */
import { afterAll } from "vitest";
import path from "node:path";

/** The export browser state's key in `src/lib/export-slides.ts`. */
const EXPORT_BROWSER_KEY = Symbol.for("creatorbrio.export-browser.v2");

interface LaunchedBrowser {
  process(): { spawnargs?: string[] } | null;
}

interface ExportBrowserState {
  current: { launch: Promise<LaunchedBrowser> } | null;
  shutdown: Promise<void>;
}

/** `work`'s result, or `fallback` when it has not settled within `ms`. */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

afterAll(async () => {
  const state = (globalThis as Record<symbol, ExportBrowserState | undefined>)[EXPORT_BROWSER_KEY];
  const root = process.env.PUPPETEER_TMP_DIR;
  if (!state || !root) return;
  const browser = state.current ? await within(state.current.launch, 5_000, null) : null;
  const profile = `--user-data-dir=${root}${path.sep}`;
  if (browser?.process()?.spawnargs?.some((arg) => arg.startsWith(profile))) {
    const { closeExportBrowser } = await import("@/lib/export-slides");
    await closeExportBrowser();
  } else {
    // A browser retired earlier in the file may still be shutting down.
    await within(state.shutdown, 5_000, undefined);
  }
}, 20_000);
