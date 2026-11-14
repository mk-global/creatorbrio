/**
 * The Chromium the overlay renderer launches (#144): which executable, which
 * flags, and the checks that keep its OS sandbox on.
 *
 * The overlay browser never shares anything with the carousel export's
 * browser (`src/lib/export-slides.ts`); both keep the OS sandbox on, and the
 * export refuses a browser by the same `sandboxDisablingFlags()` (#197).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import puppeteerPackage from "puppeteer/package.json";

/**
 * The Chromium flags every overlay browser is launched with, on top of
 * Puppeteer's defaults.
 *
 * The first seven are exactly the pinned software-raster flags of the G1
 * gate (`scripts/gates/g1/chrome-args.mjs`; results in
 * `docs/roadmap/video-studio/gates/g1-renderer.md`, "Determinism"): with
 * them, 15 of 15 full renders were frame-identical at 1, 4 and 8 workers,
 * where GPU rasterization made 2 of 7 differ. They also force sRGB output,
 * grayscale anti-aliasing and no hinting, the recorded reason export text is
 * not pixel-identical to the creator's browser.
 *
 * The rest only stop Chromium's own background traffic, which the request
 * interceptor would otherwise have to refuse: background networking (already
 * a Puppeteer default, pinned here so it cannot be lost), the component
 * updater, Domain Reliability reports, and extensions. None of them changes
 * what a page draws.
 *
 * Never add `--no-sandbox` or `--disable-setuid-sandbox`: G1 and #130 measured
 * that rendering works and is hash-identical with the sandbox on, and the
 * launch refuses any browser whose command line disables it.
 */
export const OVERLAY_CHROME_ARGS: readonly string[] = Object.freeze([
  "--disable-gpu",
  "--disable-gpu-rasterization",
  "--disable-gpu-compositing",
  "--force-color-profile=srgb",
  "--disable-lcd-text",
  "--font-render-hinting=none",
  "--disable-partial-raster",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-extensions",
]);

/** Flags that switch off part of Chromium's process sandbox. */
const SANDBOX_DISABLING = new Set([
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-namespace-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--no-zygote",
  "--single-process",
]);

/** The sandbox-disabling flags present in a browser's command line, if any. */
export function sandboxDisablingFlags(spawnArgs: readonly string[]): string[] {
  return spawnArgs.filter((arg) => SANDBOX_DISABLING.has(arg.split("=", 1)[0]));
}

/** The Puppeteer release driving the overlay browsers, for the render manifest. */
export const PUPPETEER_VERSION: string = puppeteerPackage.version;

/**
 * The Chromium executable to launch, or null when none is installed (the
 * render then fails as a `browser_missing` configuration problem).
 *
 * `PUPPETEER_EXECUTABLE_PATH`, when set, is the operator's explicit choice: it
 * is used if it is an absolute path to an existing file and otherwise nothing
 * is, rather than silently falling back to another browser. Without it, the
 * browser Puppeteer installed (`npx puppeteer browsers install chrome`).
 */
export function chromeExecutable(): string | null {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  // Runtime lookups, not build input: the ignore comments stop Next.js tracing the whole project.
  if (fromEnv) return path.isAbsolute(fromEnv) && existsSync(/*turbopackIgnore: true*/ fromEnv) ? fromEnv : null;
  let candidate: string;
  try {
    candidate = puppeteer.executablePath();
  } catch {
    return null;
  }
  return path.isAbsolute(candidate) && existsSync(/*turbopackIgnore: true*/ candidate) ? candidate : null;
}
