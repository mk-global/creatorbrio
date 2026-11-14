import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer";
import sharp from "sharp";
import { imageTypeOf, readUpload } from "./upload-files";
import { wrapSlideHtml, extractFontFamilies, usesItalic } from "./slide-html";
import { getInlinedFontCSS, type FontInstances } from "./fonts";
import { sandboxDisablingFlags } from "./video/render/chrome";
import { UnprintableSlideError, unprintableSlideError } from "./export-pdf";
import { inspectPdf } from "./pdf-content";
import {
  PRINT_CLIP_CSS,
  bodyIsTheSlide,
  comparableCharacters,
  hasClosedShadowRoot,
  printPageCss,
  readPrintableText,
  type PrintableText,
  type ProtocolNode,
} from "./print-check";
import type { Slide, AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

const MAX_EXPORTS_BEFORE_RESTART = 50;

// Every wait below is bounded. A slide that cannot finish loading still yields
// a PNG rather than hanging the export.
const PAGE_LOAD_TIMEOUT_MS = 20_000;
const FONT_READY_TIMEOUT_MS = 10_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const PDF_PRINT_TIMEOUT_MS = 30_000;
const PRINT_CHECK_TIMEOUT_MS = 15_000;
/** DevTools calls time out this long after the longest slide deadline, so a slide's own deadline fires first. */
const PROTOCOL_GRACE_MS = 5_000;

/**
 * Time limits of the export browser itself (#198). A slide's deadline sits
 * above the sum of the bounded waits it contains, so it fires only when the
 * browser stops answering, never on a slide that merely loads slowly. Tests
 * shorten these.
 */
export const exportBrowserLimits = {
  /** One PNG slide, from opening its page to its screenshot: load, fonts and images (40 s together) and the capture. */
  pngSlideMs: 60_000,
  /** One PDF slide: the same waits, the print check (15 s), the print (30 s) and reading the PDF back. */
  pdfSlideMs: 120_000,
  /** The health check after a missed deadline: a fresh context, a tiny page and its screenshot. */
  probeMs: 10_000,
  /** Opening or closing one export's browser context, or closing a page. */
  contextMs: 10_000,
  /** A clean close of the browser before its process group is killed. */
  closeGraceMs: 2_000,
  /** How long to wait for a killed browser process to exit. */
  exitWaitMs: 5_000,
};

/** A slide that missed its deadline in a browser that still passed the health check. */
export class SlideTimeoutError extends Error {
  constructor(
    readonly seconds: number,
    readonly slideNumber: number | null = null
  ) {
    super(
      `${slideNumber === null ? "The slide" : `Slide ${slideNumber}`} took longer than ${seconds} seconds to render, so the export stopped. ` +
        "Try again; if it happens again, simplify that slide."
    );
    this.name = "SlideTimeoutError";
  }
}

/** The export's browser stopped answering and was replaced while this export was using it. */
export class ExportBrowserReplacedError extends Error {
  constructor() {
    super("The export browser stopped responding and was replaced. Try the export again.");
    this.name = "ExportBrowserReplacedError";
  }
}

/**
 * One launched export browser and the exports using it.
 *
 * Exports are counted per browser rather than per server, so an export still
 * finishing on a browser that has been retired never holds up its replacement.
 */
interface BrowserLease {
  launch: Promise<Browser>;
  /** Exports holding this browser that have not closed their context yet. */
  inFlight: number;
  /** Slides this browser has rendered. */
  rendered: number;
  /** A slide missed its deadline here, so the browser is replaced once nothing uses it. */
  retire: boolean;
  /** The health check started after the first missed deadline. */
  probe: Promise<void> | null;
  /** The browser failed the health check and was killed. */
  killed: boolean;
}

/**
 * The headless browser this server process renders exports with.
 *
 * At most one browser is ever alive. Puppeteer closes the browsers a process
 * launched when that process exits, but with two or more alive it misses one,
 * which then keeps running with no owner after the server stops. A new browser
 * is therefore launched only after the previous one has shut down, and every
 * shutdown is bounded: a clean close gets `closeGraceMs`, after which the
 * browser's process group is killed and its exit awaited. Every export shares
 * the current browser, each in its own browser context.
 *
 * The state lives on globalThis rather than in module variables because
 * `next dev` can evaluate this module again in the same process, and a fresh
 * copy would otherwise launch a second browser.
 */
interface ExportBrowserState {
  /** The browser new exports use; null when there is none. */
  current: BrowserLease | null;
  /** Settles when every retired browser has shut down; a launch waits for it. */
  shutdown: Promise<void>;
}

const EXPORT_BROWSER_KEY = Symbol.for("creatorbrio.export-browser.v2");

function exportBrowserState(): ExportBrowserState {
  const store = globalThis as typeof globalThis & {
    [EXPORT_BROWSER_KEY]?: ExportBrowserState;
  };
  store[EXPORT_BROWSER_KEY] ??= { current: null, shutdown: Promise.resolve() };
  return store[EXPORT_BROWSER_KEY];
}

/** Whether `work` settles within `ms`; it is otherwise left to settle on its own. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The flags the export browser is launched with, on top of Puppeteer's
 * defaults. Chromium's process sandbox stays on (#197): slide HTML is
 * untrusted, and with the sandbox each renderer runs confined by the operating
 * system instead of with the server's full access. Never add a flag that turns
 * any part of it off; a browser started with one is refused.
 */
export const EXPORT_CHROME_ARGS: readonly string[] = Object.freeze(["--disable-gpu"]);

/**
 * The export browser could not start because the operating system cannot
 * provide its process sandbox (on Linux, unprivileged user namespaces and
 * Chrome's setuid helper are both unavailable), or it was started with part of
 * the sandbox turned off. The export never falls back to running without it.
 */
export class ExportSandboxError extends Error {
  constructor(detail: "unavailable" | "disabled") {
    super(
      detail === "unavailable"
        ? "Chromium could not start its security sandbox on this system, so slides could not be rendered. CreatorBrio never renders slides without it; see the export browser section of docs/architecture/carousel-export.md."
        : "Chromium was started with its security sandbox turned off, so the export stopped. CreatorBrio never renders slides without it."
    );
    this.name = "ExportSandboxError";
  }
}

/** Launches Chromium with its sandbox on, and refuses one whose command line turns any part of it off. */
async function launchSandboxed(): Promise<Browser> {
  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      // Read at each launch rather than once when Puppeteer loads, so a
      // browser named after that (as the export tests do) is the one used.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [...EXPORT_CHROME_ARGS],
      protocolTimeout: exportBrowserLimits.pdfSlideMs + PROTOCOL_GRACE_MS,
    });
  } catch (error) {
    // Chromium's own words when the kernel offers no sandbox it can use.
    if (/no usable sandbox/i.test(error instanceof Error ? error.message : String(error))) {
      throw new ExportSandboxError("unavailable");
    }
    throw error;
  }
  if (sandboxDisablingFlags(browser.process()?.spawnargs ?? []).length > 0) {
    await killBrowser(browser);
    throw new ExportSandboxError("disabled");
  }
  return browser;
}

/** Launches a browser once every retired one has shut down, and makes it current. */
function launchBrowser(state: ExportBrowserState): BrowserLease {
  const launch = state.shutdown.then(launchSandboxed);
  const lease: BrowserLease = { launch, inFlight: 0, rendered: 0, retire: false, probe: null, killed: false };
  state.current = lease;
  // A launch that fails is forgotten, so the next export tries again instead of reusing the failure.
  launch.catch(() => {
    if (state.current === lease) state.current = null;
  });
  return lease;
}

/** Kills the browser's whole process group, as Puppeteer itself does, and waits a bounded time for it to exit. */
async function killBrowser(browser: Browser): Promise<void> {
  const child = browser.process();
  if (!child?.pid) return;
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await settlesWithin(exited, exportBrowserLimits.exitWaitMs);
}

/**
 * Stops handing `lease` to new exports and shuts its browser down: closed
 * cleanly when it can be, killed otherwise, or killed at once with `kill`.
 */
function retireBrowser(state: ExportBrowserState, lease: BrowserLease, mode: "close" | "kill"): void {
  if (state.current === lease) state.current = null;
  const done = lease.launch.then(
    async (browser) => {
      if (mode === "close" && (await settlesWithin(browser.close(), exportBrowserLimits.closeGraceMs))) return;
      await killBrowser(browser);
    },
    () => {}
  );
  state.shutdown = Promise.all([state.shutdown, done]).then(() => {});
}

/**
 * Shuts the export browser down and waits until every export browser this
 * process launched has shut down: closed cleanly when it can be, so Puppeteer
 * removes its temporary profile, and its process group killed after
 * `closeGraceMs` otherwise. An export already running in it fails; one started
 * afterwards launches a new browser. For a process that is about to end, such
 * as a test worker (#204), which would otherwise leave the browser for its own
 * exit to take down.
 */
export async function closeExportBrowser(): Promise<void> {
  const state = exportBrowserState();
  if (state.current) retireBrowser(state, state.current, "close");
  await state.shutdown;
}

/**
 * The browser for the next export, decided without waiting so that concurrent
 * exports see each other's choice.
 *
 * A browser due for replacement (after `MAX_EXPORTS_BEFORE_RESTART` slides, or
 * after a slide missed its deadline in it) is replaced only when no export is
 * using it, so it never closes under another export, and only one replacement
 * starts. While exports overlap the replacement waits; exports of several
 * carousels at once can interleave so that nothing is ever idle, and it is
 * then put off until that load stops. Every slide's deadline bounds that wait.
 */
function currentLease(state: ExportBrowserState): BrowserLease {
  const lease = state.current;
  if (lease && lease.inFlight === 0 && (lease.retire || lease.rendered >= MAX_EXPORTS_BEFORE_RESTART)) {
    retireBrowser(state, lease, "close");
    return launchBrowser(state);
  }
  return lease ?? launchBrowser(state);
}

/** Whether the browser can still open a context, load a tiny page and capture it, within `probeMs`. */
async function browserAnswers(browser: Browser): Promise<boolean> {
  let context: BrowserContext | null = null;
  let answered = false;
  const check = (async () => {
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 16, height: 16, deviceScaleFactor: 1 });
    await page.setJavaScriptEnabled(false);
    await page.setContent("<p>ok</p>");
    await page.screenshot({ type: "png" });
    answered = true;
  })();
  await settlesWithin(check, exportBrowserLimits.probeMs);
  const opened = context as BrowserContext | null;
  if (opened) await settlesWithin(opened.close(), exportBrowserLimits.contextMs);
  return answered;
}

/**
 * After a missed deadline: the browser is replaced once nothing uses it, and
 * one health check (shared by every slide that missed it) decides whether it
 * is killed at once, failing whatever else is still running in it.
 */
function missedDeadline(state: ExportBrowserState, lease: BrowserLease): Promise<void> {
  lease.retire = true;
  lease.probe ??= lease.launch.then(browserAnswers, () => false).then((answered) => {
    if (answered) return;
    lease.killed = true;
    retireBrowser(state, lease, "kill");
  });
  return lease.probe;
}

/** One export's own browser context, in the browser it was given. */
interface ExportSession {
  state: ExportBrowserState;
  lease: BrowserLease;
  context: BrowserContext;
}

/**
 * Runs one export in its own browser context, closed afterwards whatever
 * happens. A browser found disconnected is replaced once, by whichever export
 * notices first; the others wait for that same replacement.
 */
async function withExportSession<T>(work: (session: ExportSession) => Promise<T>): Promise<T> {
  const state = exportBrowserState();
  let lease = currentLease(state);
  lease.inFlight++;
  let context: BrowserContext | null = null;
  try {
    let browser = await lease.launch;
    if (!browser.isConnected()) {
      if (state.current === lease) retireBrowser(state, lease, "close");
      lease.inFlight--;
      lease = currentLease(state);
      lease.inFlight++;
      browser = await lease.launch;
    }
    const opening = browser.createBrowserContext();
    opening.catch(() => {});
    if (!(await settlesWithin(opening, exportBrowserLimits.contextMs))) {
      await missedDeadline(state, lease);
      throw lease.killed ? new ExportBrowserReplacedError() : new SlideTimeoutError(exportBrowserLimits.contextMs / 1000);
    }
    try {
      context = await opening;
    } catch (error) {
      // A browser killed while this export waited for its context failed it, not the export.
      throw lease.killed ? new ExportBrowserReplacedError() : error;
    }
    return await work({ state, lease, context });
  } finally {
    if (context && !(await settlesWithin(context.close(), exportBrowserLimits.contextMs))) {
      lease.retire = true;
    }
    lease.inFlight--;
    // A browser due for retirement after a missed deadline shuts down as soon as nothing uses it.
    if (lease.inFlight === 0 && lease.retire && state.current === lease) retireBrowser(state, lease, "close");
  }
}

/** An `/uploads/` reference in a `src` attribute or a CSS `url()`, up to the character that ends it. */
const UPLOAD_REFERENCE = /(?:src=["']|url\(["']?)(\/uploads\/[^"'\s)]+)/g;

/**
 * Replaces each uploaded image a slide references, in `src` attributes and
 * CSS `url()`, with a `data:` URI of its bytes, so the export page needs no
 * server to load it.
 *
 * Slide HTML is untrusted (#145), so only a reference to one file directly
 * under `/uploads/` is read, through `readUpload()`, the same confined reader
 * that serves uploads to the preview: it accepts only the names the app
 * creates, inside the real uploads folder, never through a link. The bytes
 * must then be a PNG, JPEG or WebP image. Any other reference is left as it
 * is and never read; with no server behind the export page it does not load,
 * as a path the preview cannot serve does not load there either. Every
 * occurrence of a reference is replaced, and each file is read once.
 */
export async function inlineImages(html: string): Promise<string> {
  const inlined = new Map<string, string | null>();
  const dataUri = async (reference: string): Promise<string | null> => {
    if (inlined.has(reference)) return inlined.get(reference)!;
    const name = reference.slice("/uploads/".length);
    let uri: string | null = null;
    if (!name.includes("/")) {
      const file = await readUpload([name]);
      const type = file && imageTypeOf(file.bytes);
      if (file && type) uri = `data:${type};base64,${file.bytes.toString("base64")}`;
    }
    inlined.set(reference, uri);
    return uri;
  };

  let result = "";
  let copied = 0;
  for (const match of html.matchAll(UPLOAD_REFERENCE)) {
    const reference = match[1];
    const uri = await dataUri(reference);
    if (uri === null) continue;
    const start = match.index + match[0].length - reference.length;
    result += html.slice(copied, start) + uri;
    copied = start + reference.length;
  }
  return result + html.slice(copied);
}

/**
 * Turns an export failure into something the user can act on.
 *
 * The underlying errors are Puppeteer and Sharp internals: browser process
 * output, absolute paths, stack traces. None of that belongs in the UI, but
 * "Export failed" on its own is what made a broken Chromium install look like a
 * spinner that quietly gave up. The full error is logged server-side.
 */
export function describeExportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  // Written for the person already; matched by name, since `next dev` can load
  // a second copy of this module whose classes are different objects.
  if (name === "SlideTimeoutError" || name === "ExportBrowserReplacedError" || name === "ExportSandboxError") return message;

  // Puppeteer words a missing or damaged browser several different ways
  // depending on whether the path was configured, downloaded or corrupt. All of
  // them mean the same thing to the user and have the same fix.
  if (
    /could not find chrome|could not find browser|failed to launch|browser process|browser was not found|no executable was found|tried to find the browser|is not downloaded|spawn .*chrome/i.test(
      message
    )
  ) {
    return (
      "Chromium could not start, so slides could not be rendered. " +
      "Reinstall it with: npx puppeteer browsers install chrome"
    );
  }

  if (name === "TimeoutError" || /timeout|timed out/i.test(message)) {
    return (
      "A slide took too long to render and the export timed out. " +
      "Check that any images the slide references are reachable, then try again."
    );
  }

  if (/ENOSPC|no space left/i.test(message)) {
    return "There is not enough disk space to write the exported images.";
  }

  if (/ENOMEM|out of memory/i.test(message)) {
    return "The export ran out of memory. Try exporting fewer slides at a time.";
  }

  return "The export failed while rendering slides. See the server console for details.";
}

/**
 * Loads one slide in a page of the export's own browser context, exactly as
 * every export sees it, and hands the page to `capture`, all within
 * `deadlineMs`. The page is closed afterwards whatever happens.
 *
 * A slide that misses its deadline marks the browser for replacement and waits
 * for the health check: it fails with `ExportBrowserReplacedError` when the
 * browser was found unresponsive and killed, and with `SlideTimeoutError`
 * otherwise. Any slide still running in a browser that was killed fails with
 * `ExportBrowserReplacedError`.
 *
 * The document is the shared `wrapSlideHtml()` contract with the slide's fonts
 * and uploaded images inlined, sized to the carousel's dimensions, and every
 * wait is bounded: a slide that cannot finish loading is still captured rather
 * than hanging the export.
 *
 * The slide's scripts never run, for the PNG and the PDF alike: slide HTML is
 * untrusted (#130), and the preview's sandboxed iframe never runs them, so
 * every export shows the slide as the person approved it there. The waits
 * below are the export's own, evaluated by Puppeteer, and run either way.
 */
async function withLoadedSlide<T>(
  session: ExportSession,
  slide: Slide,
  aspectRatio: AspectRatio,
  capture: (page: Page) => Promise<T>,
  options: { deadlineMs: number; fontInstances?: FontInstances }
): Promise<T> {
  const { width, height } = DIMENSIONS[aspectRatio];

  // Get inlined font CSS
  const fontFamilies = extractFontFamilies(slide.html);
  const inlinedFontCss = await getInlinedFontCSS(fontFamilies, {
    italic: usesItalic(slide.html),
    ...(options.fontInstances ? { instances: options.fontInstances } : {}),
  });

  // Inline images
  const inlinedHtml = await inlineImages(slide.html);

  // Build self-contained HTML
  const fullHtml = wrapSlideHtml(inlinedHtml, aspectRatio, {
    inlineFontCss: inlinedFontCss,
  });

  const { state, lease, context } = session;
  let page: Page | null = null;
  const render = (async () => {
    page = await context.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setJavaScriptEnabled(false);

    // `load` rather than `domcontentloaded`: it waits for stylesheets and image
    // bytes. Previously the page was screenshotted as soon as the DOM parsed,
    // and images only made it in because the font wait below always stalled for
    // its full timeout. Removing that accidental delay without waiting for
    // images explicitly would have introduced a race.
    await page.setContent(fullHtml, {
      waitUntil: "load",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });

    // Wait until the font loads the page actually started have settled.
    // The previous check required every *declared* face to reach "loaded",
    // which never happens: Google ships dozens of faces per family across
    // weights and unicode subsets, and the ones this slide does not use stay
    // unloaded forever. That check therefore ran to its full timeout on every
    // slide. `document.fonts.status` reports exactly the pending-loads state.
    await page
      .waitForFunction(() => document.fonts.status === "loaded", {
        timeout: FONT_READY_TIMEOUT_MS,
      })
      .catch(() => {
        console.warn(
          `[export] fonts did not settle within ${FONT_READY_TIMEOUT_MS}ms; capturing anyway`
        );
      });

    // `load` guarantees image bytes arrived, not that they are decoded and
    // paintable. Decoding explicitly makes the capture deterministic.
    await page
      .evaluate(
        (timeoutMs: number) =>
          Promise.race([
            Promise.all(
              Array.from(document.images).map((img) =>
                img.decode().catch(() => undefined)
              )
            ).then(() => undefined),
            new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), timeoutMs)
            ),
          ]),
        IMAGE_DECODE_TIMEOUT_MS
      )
      .catch(() => {
        console.warn("[export] image decode wait failed; capturing anyway");
      });

    return await capture(page);
  })();
  // Abandoned when the deadline passes; it then fails as its page or browser closes.
  render.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), options.deadlineMs);
  });
  try {
    const outcome = await Promise.race([render, late]);
    if (outcome === "late") {
      await missedDeadline(state, lease);
      throw lease.killed ? new ExportBrowserReplacedError() : new SlideTimeoutError(options.deadlineMs / 1000);
    }
    lease.rendered++;
    return outcome;
  } catch (error) {
    if (lease.killed && !(error instanceof ExportBrowserReplacedError)) throw new ExportBrowserReplacedError();
    throw error;
  } finally {
    clearTimeout(timer);
    const opened = page as Page | null;
    if (opened) await settlesWithin(opened.close(), exportBrowserLimits.contextMs);
  }
}

/** Renders one slide to a PNG in the export's session. */
async function renderPng(session: ExportSession, slide: Slide, aspectRatio: AspectRatio): Promise<Buffer> {
  const { width, height } = DIMENSIONS[aspectRatio];

  const screenshotBuffer = await withLoadedSlide(
    session,
    slide,
    aspectRatio,
    (page) =>
      page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width, height },
      }),
    { deadlineMs: exportBrowserLimits.pngSlideMs }
  );

  // Post-process with Sharp: enforce sRGB
  const processed = await sharp(screenshotBuffer)
    .toColorspace("srgb")
    .png()
    .toBuffer();

  return processed;
}

/**
 * Export a single slide to PNG buffer.
 */
export async function exportSlide(
  slide: Slide,
  aspectRatio: AspectRatio
): Promise<Buffer> {
  return withExportSession((session) => renderPng(session, slide, aspectRatio));
}

/** Settles with `fallback` if `work` takes longer than `ms`; `work` is left to settle on its own. */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

const UNREADABLE: PrintableText = { hasText: true, visibleText: "", problem: "unreadable" };

/**
 * Runs the print checks of `print-check.ts` on a loaded slide: refuses a closed
 * shadow root, which the in-page check cannot see into, then checks the slide
 * and every frame in it. A document the DevTools protocol cannot read (one
 * nested too deeply, say), a frame the check cannot run in, and a check that
 * does not finish in time are refused as unreadable. The slide's own document
 * failing to run the check at all is an error, not a refusal.
 */
async function checkForPrint(page: Page): Promise<PrintableText> {
  const session = await page.createCDPSession();
  try {
    const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: ProtocolNode };
    if (hasClosedShadowRoot(root)) return UNREADABLE;
  } catch {
    return UNREADABLE;
  } finally {
    await session.detach().catch(() => {});
  }

  let hasText = false;
  let visibleText = "";
  for (const frame of page.frames()) {
    const isSlide = frame === page.mainFrame();
    let result: PrintableText;
    try {
      // Abandoning a check that overruns is safe: the page is closed after.
      result = await within(frame.evaluate(readPrintableText, isSlide), PRINT_CHECK_TIMEOUT_MS, UNREADABLE);
    } catch (error) {
      if (isSlide) throw error;
      return UNREADABLE;
    }
    if (result.problem) return result;
    hasText ||= result.hasText;
    if (isSlide) visibleText = result.visibleText;
  }
  return { hasText, visibleText, problem: null };
}

/**
 * Prints one slide to a one-page native PDF with Chromium: text stays text
 * with its fonts embedded, CSS and SVG graphics stay vector wherever Chromium
 * can draw them as vectors, and images stay images.
 *
 * The slide is loaded as the preview shows it, without running scripts, and
 * printed as the screen shows it (screen media, backgrounds, no margins, the
 * print-only rules of `printPageCss` and `PRINT_CLIP_CSS`) at the slide's
 * exact size, with static instances of the slide's Google Fonts so they
 * embed as TrueType rather than Type 3 (see `FontInstances`). A slide whose
 * text or effects could not be printed faithfully (see `readPrintableText`)
 * is refused with `UnprintableSlideError` instead of being flattened or
 * shrunk.
 */
export async function exportSlidePdf(
  slide: Slide,
  aspectRatio: AspectRatio
): Promise<Uint8Array> {
  return withExportSession((session) => printPdf(session, slide, aspectRatio));
}

/** Prints one slide to a one-page PDF in the export's session; see `exportSlidePdf`. */
async function printPdf(session: ExportSession, slide: Slide, aspectRatio: AspectRatio): Promise<Uint8Array> {
  const { width, height } = DIMENSIONS[aspectRatio];

  return withLoadedSlide(
    session,
    slide,
    aspectRatio,
    async (page) => {
      await page.addStyleTag({ content: printPageCss(width, height) });
      if (await page.evaluate(bodyIsTheSlide)) {
        await page.addStyleTag({ content: PRINT_CLIP_CSS });
      }
      // Printing switches to print media by default, which could apply
      // `@media print` rules the preview never shows.
      await page.emulateMediaType("screen");

      const text = await checkForPrint(page);
      if (text.problem) throw new UnprintableSlideError(text.problem);

      const pdf = await page.pdf({
        width: `${width}px`,
        height: `${height}px`,
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        // A slide is one page; merging cannot carry a document-level structure
        // tree or outline across documents, so neither is generated.
        tagged: false,
        outline: false,
        timeout: PDF_PRINT_TIMEOUT_MS,
      });

      // Defence against what the checks above cannot foresee: every letter and
      // digit the slide visibly shows must be in the page's text, as often as
      // it is shown (a font that cannot be embedded leaves its characters out
      // entirely), and a slide that shows text must print text, never only an
      // image of itself.
      if (text.hasText) {
        const [content] = await inspectPdf(pdf);
        const printed = comparableCharacters(content?.text ?? "");
        const missing = [...comparableCharacters(text.visibleText)]
          .filter(([character, shown]) => (printed.get(character) ?? 0) < shown)
          .map(([character]) => character);
        if (missing.length > 0) throw new UnprintableSlideError("missing-text", missing);
        if (!content || content.textShows === 0) {
          throw new UnprintableSlideError("flattened");
        }
      }
      return pdf;
    },
    { deadlineMs: exportBrowserLimits.pdfSlideMs, fontInstances: "static" }
  );
}

/**
 * The first failure among one batch of slides, in slide order, with the slide
 * it happened on named where the message can say so. `first` is the batch's
 * first slide number.
 */
function batchFailure(settled: PromiseSettledResult<unknown>[], first: number): { reason: unknown } | null {
  for (const [batchIdx, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") continue;
    const slideNumber = first + batchIdx;
    if (outcome.reason instanceof UnprintableSlideError) {
      return { reason: unprintableSlideError(slideNumber, outcome.reason.reason, outcome.reason.characters) };
    }
    if (outcome.reason instanceof SlideTimeoutError) return { reason: new SlideTimeoutError(outcome.reason.seconds, slideNumber) };
    return { reason: outcome.reason };
  }
  return null;
}

/**
 * Prints every slide of a carousel to its own one-page PDF, in slide order,
 * up to 3 at a time like the PNG export, in one browser context. A slide that
 * cannot be printed as text, or misses its deadline, stops the export with a
 * message naming that slide.
 */
export async function exportAllSlidePdfs(
  slides: Slide[],
  aspectRatio: AspectRatio
): Promise<Uint8Array[]> {
  const CONCURRENCY = 3;

  return withExportSession(async (session) => {
    const results: Uint8Array[] = [];
    for (let i = 0; i < slides.length; i += CONCURRENCY) {
      const batch = slides.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((slide) => printPdf(session, slide, aspectRatio))
      );
      const failure = batchFailure(settled, i + 1);
      if (failure) throw failure.reason;
      results.push(
        ...settled.map((o) => (o as PromiseFulfilledResult<Uint8Array>).value)
      );
    }
    return results;
  });
}

/**
 * Export all slides of a carousel to PNG buffers, up to 3 slides at a time,
 * in one browser context. A slide that misses its deadline stops the export
 * with a message naming that slide.
 */
export async function exportAllSlides(
  slides: Slide[],
  aspectRatio: AspectRatio,
  onProgress?: (current: number, total: number) => void
): Promise<{ name: string; buffer: Buffer }[]> {
  const CONCURRENCY = 3;

  return withExportSession(async (session) => {
    const results: { name: string; buffer: Buffer }[] = [];
    for (let i = 0; i < slides.length; i += CONCURRENCY) {
      const batch = slides.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (slide, batchIdx) => {
          const idx = i + batchIdx;
          const buffer = await renderPng(session, slide, aspectRatio);
          onProgress?.(idx + 1, slides.length);
          return { name: `slide-${idx + 1}.png`, buffer };
        })
      );
      const failure = batchFailure(settled, i + 1);
      if (failure) throw failure.reason;
      results.push(
        ...settled.map((o) => (o as PromiseFulfilledResult<{ name: string; buffer: Buffer }>).value)
      );
    }
    return results;
  });
}
