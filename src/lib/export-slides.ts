import puppeteer, { type Browser, type Page } from "puppeteer";
import { readFile } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { wrapSlideHtml, extractFontFamilies, usesItalic } from "./slide-html";
import { getInlinedFontCSS, type FontInstances } from "./fonts";
import { UnprintableSlideError, unprintableSlideError } from "./export-pdf";
import { inspectPdf } from "./pdf-content";
import { PRINT_CLIP_CSS, bodyIsTheSlide, printPageCss, readPrintableText } from "./print-check";
import type { Slide, AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

const MAX_EXPORTS_BEFORE_RESTART = 50;

// Every wait below is bounded. A slide that cannot finish loading still yields
// a PNG rather than hanging the export.
const PAGE_LOAD_TIMEOUT_MS = 20_000;
const FONT_READY_TIMEOUT_MS = 10_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const PDF_PRINT_TIMEOUT_MS = 30_000;

/**
 * The one headless browser this server process renders exports with.
 *
 * At most one browser is ever alive. Puppeteer closes the browsers a process
 * launched when that process exits, but with two or more alive it misses one,
 * which then keeps running with no owner after the server stops. Every slide
 * export shares the same launch, so slides rendered concurrently cannot each
 * start a browser.
 *
 * The state lives on globalThis rather than in module variables because
 * `next dev` can evaluate this module again in the same process, and a fresh
 * copy would otherwise launch a second browser.
 */
interface ExportBrowserState {
  /** The launch of the current browser, shared by every caller; null when there is none. */
  browser: Promise<Browser> | null;
  /** Slides the current browser has rendered. */
  exportCount: number;
  /** Slide exports between taking the browser and closing their page. */
  inFlight: number;
}

const EXPORT_BROWSER_KEY = Symbol.for("creatorbrio.export-browser");

function exportBrowserState(): ExportBrowserState {
  const store = globalThis as typeof globalThis & {
    [EXPORT_BROWSER_KEY]?: ExportBrowserState;
  };
  store[EXPORT_BROWSER_KEY] ??= { browser: null, exportCount: 0, inFlight: 0 };
  return store[EXPORT_BROWSER_KEY];
}

/**
 * Starts a new browser in place of `previous`, which is closed first so the two
 * are never alive together. A launch that fails is forgotten, so the next
 * export tries again instead of reusing the failure.
 */
function replaceBrowser(
  state: ExportBrowserState,
  previous: Promise<Browser> | null
): Promise<Browser> {
  const closed = previous
    ? previous.then((old) => old.close()).catch(() => {})
    : Promise.resolve();
  const next = closed.then(() =>
    puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    })
  );
  state.browser = next;
  state.exportCount = 0;
  next.catch(() => {
    if (state.browser === next) state.browser = null;
  });
  return next;
}

/**
 * The browser for the next slide, decided without waiting so that concurrent
 * callers see each other's choice.
 *
 * The periodic restart only happens when no slide export is in flight, so it
 * never closes a browser another export still has a page open in, and only one
 * replacement starts. While exports overlap the restart waits, and `exportCount`
 * keeps growing past the limit. A single carousel export goes idle between
 * batches, because `exportAllSlides` finishes each batch before starting the
 * next, but exports of several carousels at once can interleave so that nothing
 * is ever idle; the restart is then put off until that load stops. Rendering is
 * unaffected, since the restart only recycles the browser's memory.
 */
function currentBrowser(state: ExportBrowserState): Promise<Browser> {
  if (
    state.browser &&
    state.inFlight === 0 &&
    state.exportCount >= MAX_EXPORTS_BEFORE_RESTART
  ) {
    return replaceBrowser(state, state.browser);
  }
  return state.browser ?? replaceBrowser(state, null);
}

/**
 * Runs `render` with the shared browser and counts it as one rendered slide when
 * it succeeds. A browser found disconnected is replaced once, by whichever
 * caller notices first; the others wait for that same replacement.
 */
async function withBrowser<T>(render: (browser: Browser) => Promise<T>): Promise<T> {
  const state = exportBrowserState();
  const launch = currentBrowser(state);
  state.inFlight++;
  try {
    let browser = await launch;
    if (!browser.isConnected()) {
      if (state.browser === launch) replaceBrowser(state, launch);
      browser = await currentBrowser(state);
    }
    const result = await render(browser);
    state.exportCount++;
    return result;
  } finally {
    state.inFlight--;
  }
}

/**
 * Inline all image references in slide HTML.
 * Replaces /uploads/xxx.png paths with data: URIs.
 */
async function inlineImages(html: string): Promise<string> {
  const uploadDir = path.resolve(process.cwd(), "public");
  const imgRegex = /(?:src=["']|url\(["']?)(\/uploads\/[^"'\s)]+)/g;
  const matches = [...html.matchAll(imgRegex)];

  let result = html;
  for (const match of matches) {
    const imgPath = match[1];
    try {
      const fullPath = path.join(uploadDir, imgPath);
      const buffer = await readFile(fullPath);
      const ext = path.extname(imgPath).toLowerCase();
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : "image/webp";
      const base64 = buffer.toString("base64");
      result = result.replace(imgPath, `data:${mime};base64,${base64}`);
    } catch {
      // Keep original path — Puppeteer can fetch from localhost
    }
  }

  return result;
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
 * Loads one slide in a page of the shared export browser, exactly as every
 * export sees it, and hands the page to `capture`. The page is closed
 * afterwards whatever happens.
 *
 * The document is the shared `wrapSlideHtml()` contract with the slide's fonts
 * and uploaded images inlined, sized to the carousel's dimensions, and every
 * wait is bounded: a slide that cannot finish loading is still captured rather
 * than hanging the export.
 *
 * `scripts: false` loads the slide without running its scripts, as the
 * preview's sandboxed iframe shows it. The PNG export keeps the default.
 */
async function withLoadedSlide<T>(
  slide: Slide,
  aspectRatio: AspectRatio,
  capture: (page: Page) => Promise<T>,
  options: { fontInstances?: FontInstances; scripts?: boolean } = {}
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

  return withBrowser(async (br) => {
    const page = await br.newPage();

    try {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      if (options.scripts === false) await page.setJavaScriptEnabled(false);

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
    } finally {
      await page.close().catch(() => {});
    }
  });
}

/**
 * Export a single slide to PNG buffer.
 */
export async function exportSlide(
  slide: Slide,
  aspectRatio: AspectRatio
): Promise<Buffer> {
  const { width, height } = DIMENSIONS[aspectRatio];

  const screenshotBuffer = await withLoadedSlide(slide, aspectRatio, (page) =>
    page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width, height },
    })
  );

  // Post-process with Sharp: enforce sRGB
  const processed = await sharp(screenshotBuffer)
    .toColorspace("srgb")
    .png()
    .toBuffer();

  return processed;
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
  const { width, height } = DIMENSIONS[aspectRatio];

  return withLoadedSlide(
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

      const text = await page.evaluate(readPrintableText);
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

      // Defence against effects not covered above: when the slide shows text,
      // the PDF must hold text, never only an image of the slide.
      if (text.hasText) {
        const [content] = await inspectPdf(pdf);
        if (!content || content.textShows === 0) {
          throw new UnprintableSlideError("flattened");
        }
      }
      return pdf;
    },
    { fontInstances: "static", scripts: false }
  );
}

/**
 * Prints every slide of a carousel to its own one-page PDF, in slide order,
 * up to 3 at a time like the PNG export. A slide that cannot be printed as text
 * stops the export with a message naming that slide.
 */
export async function exportAllSlidePdfs(
  slides: Slide[],
  aspectRatio: AspectRatio
): Promise<Uint8Array[]> {
  const results: Uint8Array[] = [];
  const CONCURRENCY = 3;

  for (let i = 0; i < slides.length; i += CONCURRENCY) {
    const batch = slides.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((slide) => exportSlidePdf(slide, aspectRatio))
    );
    for (const [batchIdx, outcome] of settled.entries()) {
      if (outcome.status === "fulfilled") continue;
      if (outcome.reason instanceof UnprintableSlideError) {
        throw unprintableSlideError(i + batchIdx + 1, outcome.reason.reason);
      }
      throw outcome.reason;
    }
    results.push(
      ...settled.map((o) => (o as PromiseFulfilledResult<Uint8Array>).value)
    );
  }

  return results;
}

/**
 * Export all slides of a carousel to PNG buffers.
 * Processes up to 3 slides concurrently.
 */
export async function exportAllSlides(
  slides: Slide[],
  aspectRatio: AspectRatio,
  onProgress?: (current: number, total: number) => void
): Promise<{ name: string; buffer: Buffer }[]> {
  const results: { name: string; buffer: Buffer }[] = [];
  const CONCURRENCY = 3;

  for (let i = 0; i < slides.length; i += CONCURRENCY) {
    const batch = slides.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (slide, batchIdx) => {
        const idx = i + batchIdx;
        const buffer = await exportSlide(slide, aspectRatio);
        onProgress?.(idx + 1, slides.length);
        return { name: `slide-${idx + 1}.png`, buffer };
      })
    );
    results.push(...batchResults);
  }

  return results;
}
