import puppeteer, { type Browser, type Page } from "puppeteer";
import { readFile } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { wrapSlideHtml, extractFontFamilies, usesItalic } from "./slide-html";
import { getInlinedFontCSS, type FontInstances } from "./fonts";
import { UnprintableSlideError, unprintableSlideError } from "./export-pdf";
import { inspectPdf } from "./pdf-content";
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
 * Rules added to the slide document for printing only: the slide's own
 * `@page` rules, margin boxes and page breaks exist only in print, so they are
 * neutralised and the paper is the slide.
 */
function printPageCss(width: number, height: number): string {
  const marginBoxes = [
    "top-left-corner", "top-left", "top-center", "top-right", "top-right-corner",
    "bottom-left-corner", "bottom-left", "bottom-center", "bottom-right", "bottom-right-corner",
    "left-top", "left-middle", "left-bottom", "right-top", "right-middle", "right-bottom",
  ];
  return [
    "* { break-before: auto !important; break-after: auto !important; break-inside: auto !important; }",
    `@page { size: ${width}px ${height}px !important; margin: 0 !important; ` +
      marginBoxes.map((box) => `@${box} { content: none !important; }`).join(" ") +
      " }",
  ].join("\n");
}

/**
 * The screen clips the slide at the viewport, but print layout does not: an
 * element reaching past the right edge makes Chromium shrink the whole slide
 * to fit the paper, and one reaching past the bottom starts another page.
 * Containing the body (layout, paint and size) clips print where the screen
 * does and keeps it to one page.
 *
 * It is only exact while the body is the slide's own box, as `wrapSlideHtml`
 * sizes it: containment stops a body background from filling the page, which
 * a slide that resizes its body relies on. Such a slide is printed as it is,
 * and refused if anything in it reaches past the slide.
 */
const PRINT_CLIP_CSS = "body { position: relative !important; contain: size layout paint !important; }";

/** Whether the body is exactly the slide's box. Runs inside the page. */
function bodyIsTheSlide(): boolean {
  const body = document.body.getBoundingClientRect();
  const root = document.documentElement;
  return body.left === 0 && body.top === 0 && body.width === root.clientWidth && body.height === root.clientHeight;
}

type PrintProblem = "filter" | "backdrop-filter" | "box-reflect" | "overflow";

/**
 * How the slide's visible text would come out of a PDF print, read from the
 * loaded page with the print-only rules applied. Runs inside the page, so it
 * must not reference anything outside itself.
 *
 * Chromium's PDF backend keeps text as text through transforms, opacity,
 * clipping, masks, gradients, shadows and blend modes, but not through these
 * effects on the text or any element around it:
 * - a `filter` (CSS or SVG) or `-webkit-box-reflect` turns the element into
 *   an image of its text;
 * - a `backdrop-filter` leaves the text out of the PDF entirely.
 *
 * Text counts when it is painted: it has a box inside the slide and inside
 * every element that clips it, is neither hidden nor fully transparent, and
 * SVG text has a fill or a stroke. Text generated by `::before` and `::after`
 * counts as painted wherever its element is.
 *
 * Content that still reaches past the slide (possible when the slide resizes
 * its body, see `PRINT_CLIP_CSS`) is reported too: printing would shrink the
 * page or spill onto another.
 */
function readPrintableText(): { hasText: boolean; problem: PrintProblem | null } {
  const root = document.documentElement;
  const slideWidth = root.clientWidth;
  const slideHeight = root.clientHeight;
  if (root.scrollWidth > slideWidth || root.scrollHeight > slideHeight) {
    return { hasText: false, problem: "overflow" };
  }

  type Box = { left: number; top: number; right: number; bottom: number };
  const MIN_VISIBLE_PX = 2;
  const visible = (b: Box) =>
    b.right - b.left >= MIN_VISIBLE_PX && b.bottom - b.top >= MIN_VISIBLE_PX;
  const intersect = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });

  /** The area of `element` its clipping ancestors (and itself) let through. */
  function clipBox(element: Element): Box {
    let box: Box = { left: 0, top: 0, right: slideWidth, bottom: slideHeight };
    for (let el: Element | null = element; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      const clipsOverflow = style.overflowX !== "visible" || style.overflowY !== "visible";
      if (clipsOverflow) box = intersect(box, el.getBoundingClientRect());
      // `clip` (absolutely positioned elements only); anything but `auto`
      // is the visually-hidden pattern or a crop, read as its own rect.
      if (style.clip && style.clip !== "auto" && /^(absolute|fixed)$/.test(style.position)) {
        const [top, right, bottom, left] = (style.clip.match(/-?[\d.]+/g) ?? []).map(Number);
        const r = el.getBoundingClientRect();
        if ([top, right, bottom, left].every(Number.isFinite)) {
          box = intersect(box, { left: r.left + left, top: r.top + top, right: r.left + right, bottom: r.top + bottom });
        }
      }
    }
    return box;
  }

  /** The effect around `element` that keeps its text from printing as text. */
  function problemAround(element: Element, own?: CSSStyleDeclaration): PrintProblem | null {
    let problem: PrintProblem | null = null;
    const styles = own ? [own] : [];
    for (let el: Element | null = element; el; el = el.parentElement) styles.push(getComputedStyle(el));
    for (const style of styles) {
      if (style.backdropFilter && style.backdropFilter !== "none") return "backdrop-filter";
      if (!problem && style.filter && style.filter !== "none") problem = "filter";
      const reflect = style.getPropertyValue("-webkit-box-reflect");
      if (!problem && reflect && reflect !== "none") problem = "box-reflect";
    }
    return problem;
  }

  /** Whether text drawn by `element` (or its pseudo-element) can be seen. */
  function shown(element: Element, own?: CSSStyleDeclaration): boolean {
    let opacity = own ? Number(own.opacity) : 1;
    for (let el: Element | null = element; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      opacity *= Number(style.opacity);
      // A clip-path's area is not readable, so its text is not relied on.
      if (style.clipPath && style.clipPath !== "none") return false;
    }
    const style = own ?? getComputedStyle(element);
    if (style.visibility !== "visible" || opacity === 0) return false;
    if (element instanceof SVGElement && style.fill === "none" && style.stroke === "none") return false;
    return true;
  }

  let hasText = false;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element || !node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const clip = clipBox(element);
    const painted = Array.from(range.getClientRects()).some((r) => visible(intersect(r, clip)));
    if (!painted || !shown(element)) continue;
    const problem = problemAround(element);
    if (problem) return { hasText: true, problem };
    hasText = true;
  }

  for (const element of Array.from(document.body.querySelectorAll("*")).concat(document.body)) {
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      if (style.display === "none") continue;
      // Only quoted strings are text; counters, attr() and images are not
      // relied on.
      const strings = style.content.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
      if (!strings.some((quoted) => quoted.slice(1, -1).trim())) continue;
      if (!visible(intersect(element.getBoundingClientRect(), clipBox(element)))) continue;
      if (!shown(element, style)) continue;
      const problem = problemAround(element, style);
      if (problem) return { hasText: true, problem };
      hasText = true;
    }
  }

  return { hasText, problem: null };
}

/**
 * Prints one slide to a one-page native PDF with Chromium: text stays text
 * with its fonts embedded, CSS and SVG graphics stay vector wherever Chromium
 * can draw them as vectors, and images stay images.
 *
 * The slide is loaded as the preview shows it, without running scripts, and
 * printed as the screen shows it (screen media, backgrounds, no margins, the
 * print-only rules of `printPageCss` and `PRINT_CLIP_CSS`) at the slide's
 * exact size, with static
 * instances of the slide's Google Fonts so they embed as TrueType rather than
 * Type 3 (see `FontInstances`). A slide whose text could not be printed as
 * text, or that would not print at its own size, is refused with
 * `UnprintableSlideError` instead of being flattened or shrunk.
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
