import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import type { Slide } from "@/types/carousel";

// The headless browser is replaced by a fake, so these tests count launches and
// closes without Chromium. The launch mock is created outside the factory so it
// stays the same function across vi.resetModules().
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("puppeteer", () => ({ default: { launch } }));

type ExportSlides = typeof import("@/lib/export-slides");

const STATE_KEY = Symbol.for("creatorbrio.export-browser");
const MAX_EXPORTS_BEFORE_RESTART = 50;

interface FakeBrowser {
  connected: boolean;
  openPages: number;
  /** Pages still open each time close() was called. */
  closes: number[];
  isConnected(): boolean;
  newPage(): Promise<unknown>;
  close(): Promise<void>;
}

let png: Buffer;
let browsers: FakeBrowser[];
/** What the in-page text check reports for every slide, keyed by slide HTML. */
let printable: (html: string) => { hasText: boolean; problem: string | null };
/** The PDF a page prints, keyed by slide HTML. */
let printed: (html: string) => Promise<Uint8Array>;
/** The options each print was called with. */
let printOptions: Record<string, unknown>[];
let mediaTypes: (string | null)[];
/** The calls each page received that set up how the slide loads and prints, in order. */
let pageSetup: string[][];
/** Stylesheets added to pages after loading. */
let addedStyles: string[];
/** Whether the loaded page's body is exactly the slide's box. */
let bodyIsSlide: boolean;
/** When set, pages opened from now on wait for it before their screenshot. */
let screenshotGate: Promise<void> | null;

function fakeBrowser(): FakeBrowser {
  const browser: FakeBrowser = {
    connected: true,
    openPages: 0,
    closes: [],
    isConnected: () => browser.connected,
    async newPage() {
      browser.openPages++;
      const gate = screenshotGate;
      let open = true;
      let html = "";
      const setup: string[] = [];
      pageSetup.push(setup);
      return {
        setViewport: async () => {},
        setJavaScriptEnabled: async (enabled: boolean) => {
          setup.push(`scripts:${enabled}`);
        },
        setContent: async (content: string) => {
          setup.push("load");
          html = content;
        },
        addStyleTag: async ({ content }: { content: string }) => {
          setup.push("style");
          addedStyles.push(content);
        },
        waitForFunction: async () => {},
        // The text check is the only evaluation whose result is used.
        evaluate: async (fn: { name: string }) => {
          if (fn.name === "bodyIsTheSlide") {
            setup.push("measure");
            return bodyIsSlide;
          }
          if (fn.name !== "readPrintableText") return undefined;
          setup.push("check");
          return printable(html);
        },
        emulateMediaType: async (type: string | null) => {
          mediaTypes.push(type);
        },
        pdf: async (options: Record<string, unknown>) => {
          printOptions.push(options);
          return printed(html);
        },
        screenshot: async () => {
          await gate;
          return png;
        },
        close: async () => {
          if (open) browser.openPages--;
          open = false;
        },
      };
    },
    async close() {
      browser.closes.push(browser.openPages);
      browser.connected = false;
    },
  };
  return browser;
}

/** A launch that takes a moment, as a real one does, so callers can overlap. */
async function launchFake(): Promise<FakeBrowser> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const browser = fakeBrowser();
  browsers.push(browser);
  return browser;
}

function slides(count: number): Slide[] {
  // No font family and no /uploads/ path, so nothing reaches the network or disk.
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    html: `<div>Slide ${i + 1}</div>`,
    previousVersions: [],
    order: i,
    notes: "",
  }));
}

/** A one-page PDF at the 4:5 print size: text when `label` is set, else only a shape. */
async function textPdf(label: string | null): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([810, 1013.04]);
  page.drawRectangle({ x: 0, y: 0, width: 810, height: 1013.04 });
  if (label) {
    page.drawText(label, { x: 10, y: 900, font: await doc.embedFont(StandardFonts.Helvetica) });
  }
  return doc.save();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function freshModule(): Promise<ExportSlides> {
  vi.resetModules();
  return import("@/lib/export-slides");
}

beforeEach(async () => {
  // Each test starts as a newly started server: no browser and a cold module.
  delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
  png ??= await sharp({
    create: { width: 8, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  browsers = [];
  screenshotGate = null;
  printable = () => ({ hasText: true, problem: null });
  printed = (html) => textPdf(html.includes("Slide 2") ? "Second" : "Any");
  printOptions = [];
  mediaTypes = [];
  pageSetup = [];
  addedStyles = [];
  bodyIsSlide = true;
  launch.mockReset();
  launch.mockImplementation(launchFake);
});

describe("export browser", () => {
  it("launches one browser for a multi-slide export on a cold server", async () => {
    const { exportAllSlides } = await freshModule();

    const files = await exportAllSlides(slides(5), "4:5");

    expect(launch).toHaveBeenCalledTimes(1);
    expect(files.map((f) => f.name)).toEqual([
      "slide-1.png",
      "slide-2.png",
      "slide-3.png",
      "slide-4.png",
      "slide-5.png",
    ]);
    expect(browsers[0].closes).toEqual([]);
    expect(browsers[0].openPages).toBe(0);
  });

  it("shares one launch between exports that start together", async () => {
    const { exportAllSlides, exportSlide } = await freshModule();

    await Promise.all([
      exportAllSlides(slides(3), "1:1"),
      exportAllSlides(slides(2), "9:16"),
      exportSlide(slides(1)[0], "4:5"),
    ]);

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("keeps each slide's image as the post-processed screenshot", async () => {
    const { exportSlide } = await freshModule();

    const buffer = await exportSlide(slides(1)[0], "4:5");

    const expected = await sharp(png).toColorspace("srgb").png().toBuffer();
    expect(buffer.equals(expected)).toBe(true);
  });

  it("does not reuse a failed launch, and the next export launches again", async () => {
    launch.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("Failed to launch the browser process!");
    });
    const { exportAllSlides } = await freshModule();

    await expect(exportAllSlides(slides(3), "4:5")).rejects.toThrow(/failed to launch/i);
    // The three concurrent slides waited on the same failed launch.
    expect(launch).toHaveBeenCalledTimes(1);

    const files = await exportAllSlides(slides(3), "4:5");
    expect(files).toHaveLength(3);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(browsers).toHaveLength(1);
  });

  it("replaces a disconnected browser once, closing it first", async () => {
    const { exportAllSlides } = await freshModule();
    await exportAllSlides(slides(1), "4:5");
    browsers[0].connected = false;

    await Promise.all([
      exportAllSlides(slides(3), "4:5"),
      exportAllSlides(slides(3), "4:5"),
    ]);

    expect(launch).toHaveBeenCalledTimes(2);
    expect(browsers[0].closes).toEqual([0]);
    expect(browsers[1].closes).toEqual([]);
  });

  it("restarts the browser once when concurrent exports reach the restart point", async () => {
    const { exportAllSlides, exportSlide } = await freshModule();
    for (let i = 0; i < MAX_EXPORTS_BEFORE_RESTART; i++) {
      await exportSlide(slides(1)[0], "4:5");
    }
    expect(launch).toHaveBeenCalledTimes(1);

    await Promise.all([
      exportAllSlides(slides(3), "4:5"),
      exportAllSlides(slides(3), "4:5"),
    ]);

    expect(launch).toHaveBeenCalledTimes(2);
    expect(browsers[0].closes).toEqual([0]);
    expect(browsers[1].closes).toEqual([]);
  });

  it("does not close the browser while another export still has a page open in it", async () => {
    const { exportSlide } = await freshModule();
    for (let i = 0; i < MAX_EXPORTS_BEFORE_RESTART - 1; i++) {
      await exportSlide(slides(1)[0], "4:5");
    }

    // One slow slide holds its page open while a fast one reaches the restart point.
    const slow = deferred();
    screenshotGate = slow.promise;
    const held = exportSlide(slides(1)[0], "4:5");
    await vi.waitFor(() => expect(browsers[0].openPages).toBe(1));
    screenshotGate = null;
    await exportSlide(slides(1)[0], "4:5");

    // Past the restart point, but the slow slide is still rendering.
    await exportSlide(slides(1)[0], "4:5");
    expect(browsers[0].closes).toEqual([]);
    expect(launch).toHaveBeenCalledTimes(1);

    slow.resolve();
    await held;

    // Nothing is in flight now, so the next slide restarts the browser.
    await exportSlide(slides(1)[0], "4:5");
    expect(browsers[0].closes).toEqual([0]);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("keeps the same browser when the module is evaluated again in the same process", async () => {
    const first = await freshModule();
    await first.exportAllSlides(slides(3), "4:5");
    expect(launch).toHaveBeenCalledTimes(1);

    // As `next dev` does after a recompile: a new copy of the module, same process.
    const second = await freshModule();
    expect(second).not.toBe(first);
    await second.exportAllSlides(slides(3), "4:5");

    expect(launch).toHaveBeenCalledTimes(1);
    expect(browsers[0].closes).toEqual([]);
  });

  describe("native PDF printing", () => {
    it("prints every slide in the one shared browser and closes every page", async () => {
      const { exportAllSlidePdfs, exportAllSlides } = await freshModule();

      const [pdfs] = await Promise.all([
        exportAllSlidePdfs(slides(5), "4:5"),
        exportAllSlides(slides(2), "4:5"),
      ]);

      expect(pdfs).toHaveLength(5);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(browsers[0].openPages).toBe(0);
      expect(browsers[0].closes).toEqual([]);
    });

    it("prints as the screen shows it, at the slide's exact size, without margins", async () => {
      const { exportSlidePdf } = await freshModule();

      await exportSlidePdf(slides(1)[0], "4:5");

      expect(mediaTypes).toEqual(["screen"]);
      expect(printOptions).toEqual([
        {
          width: "1080px",
          height: "1350px",
          printBackground: true,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          tagged: false,
          outline: false,
          timeout: 30_000,
        },
      ]);
    });

    it("loads the slide without its scripts, as the preview does, and checks it with the print-only rules applied", async () => {
      const { exportSlidePdf } = await freshModule();

      await exportSlidePdf(slides(1)[0], "4:5");

      expect(pageSetup).toEqual([["scripts:false", "load", "style", "measure", "style", "check"]]);
      const [pageCss, clipCss] = addedStyles;
      // The slide's own page rules and breaks cannot change the paper...
      expect(pageCss).toMatch(/@page \{ size: 1080px 1350px !important; margin: 0 !important;/);
      expect(pageCss).toMatch(/@top-center \{ content: none !important; \}/);
      expect(pageCss).toMatch(/break-before: auto !important/);
      // ...and the body clips print layout where the screen clips it.
      expect(clipCss).toBe("body { position: relative !important; contain: size layout paint !important; }");
    });

    it("prints a slide that resizes its body without the clip, which would change its background", async () => {
      const { exportSlidePdf } = await freshModule();
      bodyIsSlide = false;

      await exportSlidePdf(slides(1)[0], "4:5");

      expect(pageSetup).toEqual([["scripts:false", "load", "style", "measure", "check"]]);
      expect(addedStyles).toHaveLength(1);
      expect(addedStyles[0]).not.toMatch(/contain/);
    });

    it("leaves the PNG export's loading exactly as it was", async () => {
      const { exportSlide } = await freshModule();

      await exportSlide(slides(1)[0], "4:5");

      expect(pageSetup).toEqual([["load"]]);
      expect(addedStyles).toEqual([]);
    });

    it("returns each slide's PDF in slide order", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      const { hexText, readPdfPages } = await import("./helpers/export-files");
      printed = (html) => textPdf(html.match(/Slide \d+/)![0]);

      const pdfs = await exportAllSlidePdfs(slides(7), "4:5");

      expect(pdfs).toHaveLength(7);
      for (const [i, bytes] of pdfs.entries()) {
        const [page] = await readPdfPages(bytes);
        expect(page.operators).toContain(hexText(`Slide ${i + 1}`));
      }
    });

    it.each([
      ["filter", /^Slide 2 applies a CSS filter to text/],
      ["backdrop-filter", /^Slide 2 has text inside a frosted-glass effect/],
      ["box-reflect", /^Slide 2 reflects text \(-webkit-box-reflect\)/],
      ["overflow", /^Slide 2 has content reaching past its edges/],
    ])("refuses a slide whose check reports %s before printing, naming the slide", async (problem, message) => {
      const { exportAllSlidePdfs } = await freshModule();
      printable = (html) => ({
        hasText: true,
        problem: html.includes("Slide 2") ? problem : null,
      });

      const attempt = exportAllSlidePdfs(slides(3), "4:5");

      await expect(attempt).rejects.toMatchObject({ name: "PdfExportError", status: 422 });
      await expect(attempt).rejects.toThrow(message);
      // The refused slide was never printed, and no page was left open.
      expect(printOptions).toHaveLength(2);
      expect(browsers[0].openPages).toBe(0);
    });

    it("refuses a slide whose visible text reached the PDF only as a picture", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      printed = (html) => textPdf(html.includes("Slide 2") ? null : "Fine");

      const attempt = exportAllSlidePdfs(slides(3), "4:5");

      await expect(attempt).rejects.toMatchObject({ status: 422 });
      await expect(attempt).rejects.toThrow(/^Slide 2 could only be printed as a picture/);
      expect(browsers[0].openPages).toBe(0);
    });

    it("accepts a slide with no text at all, such as a full-bleed photo", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      printable = () => ({ hasText: false, problem: null });
      printed = () => textPdf(null);

      await expect(exportAllSlidePdfs(slides(2), "4:5")).resolves.toHaveLength(2);
    });

    it("passes an unexpected print failure through unchanged for the route to report", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      printed = async () => {
        throw new Error("Protocol error (Page.printToPDF): Printing failed");
      };

      await expect(exportAllSlidePdfs(slides(2), "4:5")).rejects.toThrow(
        /Page\.printToPDF/
      );
      expect(browsers[0].openPages).toBe(0);
    });
  });
});
