import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import type { Slide } from "@/types/carousel";

// The headless browser is replaced by a fake, so these tests count launches and
// closes without Chromium. The launch mock is created outside the factory so it
// stays the same function across vi.resetModules().
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("puppeteer", () => ({ default: { launch } }));

// The fonts each export asks for, recorded instead of fetched.
const { fontRequests } = vi.hoisted(() => ({ fontRequests: [] as { families: string[]; options: unknown }[] }));
vi.mock("@/lib/fonts", () => ({
  getInlinedFontCSS: async (families: string[], options: unknown) => {
    fontRequests.push({ families, options });
    return "";
  },
}));

type ExportSlides = typeof import("@/lib/export-slides");

const STATE_KEY = Symbol.for("creatorbrio.export-browser.v2");
const MAX_EXPORTS_BEFORE_RESTART = 50;

interface FakeContext {
  open: boolean;
  newPage(): Promise<unknown>;
  close(): Promise<void>;
}

interface FakeBrowser {
  connected: boolean;
  openPages: number;
  /** Every browser context opened in this browser, in order. */
  contexts: FakeContext[];
  /** Pages still open each time close() was called. */
  closes: number[];
  isConnected(): boolean;
  newPage(): Promise<unknown>;
  createBrowserContext(): Promise<FakeContext>;
  process(): FakeProcess | null;
  target(): { createCDPSession(): Promise<FakeSession> };
  /** The browser-wide protocol sessions opened on it, with what was sent and the handlers registered. */
  sessions: FakeSession[];
  /** When set, close() never finishes, as a wedged browser's does not. */
  closeHangs: boolean;
  /** Rejects when the browser's process is killed. */
  death: Promise<never>;
  close(): Promise<void>;
}

/** A browser-wide DevTools session. */
interface FakeSession {
  sent: [string, unknown][];
  handlers: Map<string, (event: unknown) => void>;
  on(event: string, handler: (event: unknown) => void): void;
  send(method: string, params?: unknown): Promise<unknown>;
}

/** Every document an export loaded, in order. */
let loadedDocuments: string[];

/** The browser process, for tests that check it is killed. */
interface FakeProcess {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  once(event: "exit", listener: () => void): void;
  kill(signal: string): void;
}

/** Process ids the code under test signalled, with the signal; the fake process exits on SIGKILL. */
let signalled: [number, string][];
/** Fake browser processes by group id, so a signal to a group reaches its process. */
let fakeProcesses: Map<number, { exit(): void }>;
/** When true, opening a browser context never finishes until the browser is killed. */
let contextsHang: boolean;
/** When true, launched fake browsers have a process the code can kill. */
let supervised: boolean;

let png: Buffer;
let browsers: FakeBrowser[];
/** What the in-page text check reports for every slide, keyed by slide HTML. */
let printable: (html: string) => Check | Promise<Check>;
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
/** The document as the DevTools protocol describes it, keyed by slide HTML. */
let documentTree: (html: string) => unknown;
/** What the check reports in each frame inside the slide, or an error it throws there. */
let frameChecks: (html: string) => (Check | Error)[];
/** A protocol failure reading the document, keyed by slide HTML, or null. */
let documentError: (html: string) => Error | null;
/** The URL a page reports once its document loaded, keyed by its HTML. */
let pageUrl: (html: string) => string;
/** When set, pages opened from now on wait for it before their screenshot. */
let screenshotGate: Promise<void> | null;
/** Whether a page's screenshot never finishes, keyed by its HTML (the health check loads `<p>ok</p>`). */
let hangs: (html: string) => boolean;

function fakeBrowser(): FakeBrowser {
  let child: FakeProcess | null = null;
  let die!: (reason: Error) => void;
  const death = new Promise<never>((_, reject) => (die = reject));
  death.catch(() => {});
  if (supervised) {
    const pid = 900_000 + fakeProcesses.size;
    const listeners: (() => void)[] = [];
    child = {
      pid,
      exitCode: null,
      signalCode: null,
      once: (_event, listener) => void listeners.push(listener),
      kill: (signal) => void signalled.push([pid, signal]),
    };
    const proc = child;
    fakeProcesses.set(pid, {
      exit() {
        proc.signalCode = "SIGKILL";
        browser.connected = false;
        die(new Error("Protocol error: Target closed"));
        for (const listener of listeners) listener();
      },
    });
  }
  const browser: FakeBrowser = {
    connected: true,
    openPages: 0,
    contexts: [],
    closes: [],
    isConnected: () => browser.connected,
    process: () => child,
    sessions: [],
    target: () => ({
      async createCDPSession() {
        const session: FakeSession = {
          sent: [],
          handlers: new Map(),
          on: (event, handler) => void session.handlers.set(event, handler),
          send: async (method, params) => void session.sent.push([method, params]),
        };
        browser.sessions.push(session);
        return session;
      },
    }),
    closeHangs: false,
    death,
    async createBrowserContext() {
      if (contextsHang) await browser.death;
      const pages: { close(): Promise<void> }[] = [];
      const context: FakeContext = {
        open: true,
        async newPage() {
          const page = (await browser.newPage()) as { close(): Promise<void> };
          pages.push(page);
          return page;
        },
        async close() {
          context.open = false;
          for (const page of pages) await page.close();
        },
      };
      browser.contexts.push(context);
      return context;
    },
    async newPage() {
      browser.openPages++;
      const gate = screenshotGate;
      let open = true;
      let html = "";
      const setup: string[] = [];
      pageSetup.push(setup);
      const page = {
        setViewport: async () => {},
        setJavaScriptEnabled: async (enabled: boolean) => {
          setup.push(`scripts:${enabled}`);
        },
        setContent: async (content: string) => {
          setup.push("load");
          html = content;
          loadedDocuments.push(content);
        },
        addStyleTag: async ({ content }: { content: string }) => {
          setup.push("style");
          addedStyles.push(content);
        },
        waitForFunction: async () => {},
        url: () => pageUrl(html),
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
        createCDPSession: async () => ({
          send: async (method: string) => {
            expect(method).toBe("DOM.getDocument");
            const error = documentError(html);
            if (error) throw error;
            return { root: documentTree(html) };
          },
          detach: async () => {},
        }),
        mainFrame: () => page,
        frames: () => [
          page,
          ...frameChecks(html).map((check) => ({
            evaluate: async (fn: { name: string }, isSlide: boolean) => {
              expect([fn.name, isSlide]).toEqual(["readPrintableText", false]);
              setup.push("check frame");
              if (check instanceof Error) throw check;
              return check;
            },
          })),
        ],
        emulateMediaType: async (type: string | null) => {
          mediaTypes.push(type);
        },
        pdf: async (options: Record<string, unknown>) => {
          printOptions.push(options);
          return printed(html);
        },
        screenshot: async () => {
          // A killed browser fails whatever is still waiting in it, as Chromium's connection does.
          await Promise.race([gate, browser.death]);
          if (hangs(html)) await Promise.race([new Promise(() => {}), browser.death]);
          return png;
        },
        close: async () => {
          if (open) browser.openPages--;
          open = false;
        },
      };
      return page;
    },
    async close() {
      browser.closes.push(browser.openPages);
      if (browser.closeHangs) return new Promise<void>(() => {});
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

/** What the in-page check reports for one document. */
interface Check {
  hasText: boolean;
  visibleText: string;
  problem: string | null;
}

/**
 * A one-page PDF at the 4:5 print size showing `text` in a CID font with a
 * Unicode map, one code per character, as Chromium writes text.
 */
async function unicodePdf(text: string): Promise<Uint8Array> {
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const chars = [...text];
  const hex = (n: number, digits: number) => n.toString(16).padStart(digits, "0");
  const utf16 = (c: string) => [...c].map((_, i) => hex(c.charCodeAt(i), 4)).join("");
  const entries = chars.map((c, i) => `<${hex(i + 1, 4)}> <${utf16(c)}>`).join(" ");
  const map = `1 begincodespacerange <0000> <FFFF> endcodespacerange ${chars.length} beginbfchar ${entries} endbfchar`;
  const font = ctx.obj({ Type: "Font", Subtype: "Type0", Encoding: "Identity-H", ToUnicode: ctx.register(ctx.flateStream(map)) });
  const page = doc.addPage([810, 1013.04]);
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font } }));
  const codes = chars.map((_, i) => hex(i + 1, 4)).join("");
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(`BT /F1 40 Tf 10 900 Td <${codes}> Tj ET`)));
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
  fontRequests.length = 0;
  documentTree = () => ({ nodeName: "#document", children: [] });
  documentError = () => null;
  frameChecks = () => [];
  png ??= await sharp({
    create: { width: 8, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  browsers = [];
  screenshotGate = null;
  pageUrl = () => "about:blank";
  hangs = () => false;
  printable = () => ({ hasText: true, visibleText: "", problem: null });
  printed = (html) => textPdf(html.includes("Slide 2") ? "Second" : "Any");
  printOptions = [];
  mediaTypes = [];
  pageSetup = [];
  addedStyles = [];
  bodyIsSlide = true;
  launch.mockReset();
  launch.mockImplementation(launchFake);
  signalled = [];
  fakeProcesses = new Map();
  supervised = false;
  loadedDocuments = [];
  contextsHang = false;
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
      // Page breaks are left alone: overriding them would break column
      // layouts, and a forced break does not start a page in a one-page print.
      expect(pageCss).not.toMatch(/break-/);
      // ...and the body, which already clips, becomes the containing block of
      // positioned content, so print clips where the screen clips.
      expect(clipCss).toBe("body { position: relative !important; }");
    });

    it("prints a slide that resizes its body without the clip, which would move what is positioned in it", async () => {
      const { exportSlidePdf } = await freshModule();
      bodyIsSlide = false;

      await exportSlidePdf(slides(1)[0], "4:5");

      expect(pageSetup).toEqual([["scripts:false", "load", "style", "measure", "check"]]);
      expect(addedStyles).toHaveLength(1);
      expect(addedStyles[0]).not.toMatch(/position/);
    });

    it("loads the PNG export with scripts off before its content, and otherwise as it was (#130)", async () => {
      const { exportSlide } = await freshModule();

      await exportSlide(slides(1)[0], "4:5");

      expect(pageSetup).toEqual([["scripts:false", "load"]]);
      expect(addedStyles).toEqual([]);
    });

    it("asks for static font instances for the PDF and leaves the PNG export's fonts as they were", async () => {
      const { exportSlide, exportSlidePdf } = await freshModule();
      const fonted: Slide = { ...slides(1)[0], html: `<div style="font-family: 'Inter'; font-style: italic">Hi</div>` };

      await exportSlide(fonted, "4:5");
      await exportSlidePdf(fonted, "4:5");

      expect(fontRequests).toEqual([
        { families: ["Inter"], options: { italic: true } },
        { families: ["Inter"], options: { italic: true, instances: "static" } },
      ]);
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
      ["backdrop-filter", /^Slide 2 uses a frosted-glass effect \(backdrop-filter\)/],
      ["box-reflect", /^Slide 2 reflects text \(-webkit-box-reflect\)/],
      ["gradient-text", /^Slide 2 fills text with a gradient or image \(background-clip: text\)/],
      ["text-paint", /^Slide 2 draws text inside an SVG pattern or uses text as an SVG clip path/],
      ["mask", /^Slide 2 uses a CSS or SVG mask/],
      ["blend", /^Slide 2 uses mix-blend-mode plus-lighter or plus-darker/],
      ["backface", /^Slide 2 turns an element's back to the viewer \(backface-visibility: hidden\)/],
      ["overflow", /^Slide 2 has content reaching past its edges/],
      ["unreadable", /^Slide 2 could not be checked before printing/],
    ])("refuses a slide whose check reports %s before printing, naming the slide", async (problem, message) => {
      const { exportAllSlidePdfs } = await freshModule();
      printable = (html) => ({
        hasText: true,
        visibleText: "",
        problem: html.includes("Slide 2") ? problem : null,
      });

      const attempt = exportAllSlidePdfs(slides(3), "4:5");

      await expect(attempt).rejects.toMatchObject({ name: "PdfExportError", status: 422 });
      await expect(attempt).rejects.toThrow(message);
      // The refused slide was never printed, and no page was left open.
      expect(printOptions).toHaveLength(2);
      expect(browsers[0].openPages).toBe(0);
    });

    it("refuses a slide holding a closed shadow root, which the in-page check cannot see into", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      documentTree = (html) => ({
        children: [
          {
            children: html.includes("Slide 2")
              ? [{ shadowRoots: [{ shadowRootType: "user-agent" }] }, { shadowRoots: [{ shadowRootType: "closed" }] }]
              : [{ shadowRoots: [{ shadowRootType: "open" }, { shadowRootType: "user-agent" }] }],
          },
        ],
      });

      const attempt = exportAllSlidePdfs(slides(3), "4:5");

      await expect(attempt).rejects.toThrow(/^Slide 2 could not be checked before printing/);
      expect(printOptions).toHaveLength(2);
      expect(browsers[0].openPages).toBe(0);
    });

    it("checks every frame inside the slide, and refuses an effect found in one", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      frameChecks = (html) =>
        html.includes("Slide 2")
          ? [{ hasText: false, visibleText: "", problem: null }, { hasText: true, visibleText: "", problem: "filter" }]
          : [{ hasText: true, visibleText: "", problem: null }];

      const attempt = exportAllSlidePdfs(slides(3), "4:5");

      await expect(attempt).rejects.toThrow(/^Slide 2 applies a CSS filter to text/);
      expect(pageSetup[1]).toEqual(["scripts:false", "load", "style", "measure", "style", "check", "check frame", "check frame"]);
      expect(printOptions).toHaveLength(2);
    });

    it("refuses a slide with a frame the check cannot run in", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      frameChecks = (html) => (html.includes("Slide 1") ? [new Error("Execution context was destroyed")] : []);

      await expect(exportAllSlidePdfs(slides(2), "4:5")).rejects.toThrow(/^Slide 1 could not be checked before printing/);
    });

    it("refuses a slide whose visible text reached the PDF only as a picture", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      printed = (html) => textPdf(html.includes("Slide 2") ? null : "Fine");

      const attempt = exportAllSlidePdfs(slides(3), "4:5");

      await expect(attempt).rejects.toMatchObject({ status: 422 });
      await expect(attempt).rejects.toThrow(/^Slide 2 could only be printed as a picture/);
      expect(browsers[0].openPages).toBe(0);
    });

    it("accepts a page whose text holds every letter and digit the slide shows, however cased or composed", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      // Shown with an uppercase transform and printed with composed accents;
      // punctuation, spaces and emoji are not compared.
      printable = () => ({ hasText: true, visibleText: "Cafe\u0301 Straße, 10 🚀 1\uFE0F\u20E3!", problem: null });
      printed = () => unicodePdf("CAFÉ STRASSE 10");

      await expect(exportAllSlidePdfs(slides(2), "4:5")).resolves.toHaveLength(2);
    });

    it("refuses a page that leaves out characters the slide shows, quoting them, before the picture check", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      // As Chromium prints Chinese that fell back to a font it cannot embed:
      // the characters are simply absent from the page.
      printable = (html) => ({ hasText: true, visibleText: html.includes("Slide 2") ? "5 Tips 提高效率" : "5 Tips", problem: null });
      printed = () => unicodePdf("5 Tips");

      const attempt = exportAllSlidePdfs(slides(3), "4:5");

      await expect(attempt).rejects.toMatchObject({ name: "PdfExportError", status: 422 });
      await expect(attempt).rejects.toThrow(
        /^Slide 2 shows text that would not reach the PDF as text \(such as "提", "高", "效", "率"\)\. /
      );
      expect(browsers[0].openPages).toBe(0);

      // A page with no text at all is named by what it lost, too.
      printable = () => ({ hasText: true, visibleText: "提高效率", problem: null });
      printed = () => textPdf(null);
      await expect(exportAllSlidePdfs(slides(1), "4:5")).rejects.toThrow(/^Slide 1 shows text that would not reach the PDF as text/);
    });

    it("refuses a page that lost characters the slide also shows elsewhere, counting each", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      // A heading in a font that cannot be embedded, and the same words in a
      // Noto paragraph that prints: the page holds them once, the slide twice.
      printable = () => ({ hasText: true, visibleText: "5 Tips 提高效率 提高效率", problem: null });
      printed = () => unicodePdf("5 Tips 提高效率");

      await expect(exportAllSlidePdfs(slides(1), "4:5")).rejects.toThrow(
        /^Slide 1 shows text that would not reach the PDF as text \(such as "提", "高", "效", "率"\)\. /
      );
    });

    it("refuses a slide whose document the DevTools protocol cannot read, as one nested too deeply", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      documentError = (html) =>
        html.includes("Slide 2") ? new Error("Protocol error (DOM.getDocument): Object reference chain is too long") : null;

      const attempt = exportAllSlidePdfs(slides(3), "4:5");

      await expect(attempt).rejects.toThrow(/^Slide 2 could not be checked before printing/);
      expect(printOptions).toHaveLength(2);
      expect(browsers[0].openPages).toBe(0);
    });

    it("refuses a slide whose check does not finish in time, and closes its page", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      vi.useFakeTimers();
      try {
        printable = (html) =>
          html.includes("Slide 2") ? new Promise<Check>(() => {}) : { hasText: true, visibleText: "", problem: null };

        const outcome = exportAllSlidePdfs(slides(2), "4:5").then(
          () => null,
          (error: Error) => error
        );
        await vi.advanceTimersByTimeAsync(20_000);

        expect((await outcome)?.message).toMatch(/^Slide 2 could not be checked before printing/);
        expect(printOptions).toHaveLength(1);
        expect(browsers[0].openPages).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("accepts a slide with no text at all, such as a full-bleed photo", async () => {
      const { exportAllSlidePdfs } = await freshModule();
      printable = () => ({ hasText: false, visibleText: "", problem: null });
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

// #198: a browser that stays connected but stops completing captures must not
// block later exports or need the server restarted. Fake timers make every
// deadline exact; the defaults are used, so these also pin their values.
describe("unhealthy export browser (#198)", () => {
  const PNG_DEADLINE = 60_000;
  const PROBE = 10_000;

  /** Settles `work` into its error message, or null when it succeeds. */
  function outcome(work: Promise<unknown>): Promise<string | null> {
    return work.then(
      () => null,
      (error: Error) => error.message
    );
  }

  /** Stands in for process.kill: records the signal and lets the fake process exit. */
  function interceptKill() {
    return vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      signalled.push([pid, String(signal)]);
      fakeProcesses.get(Math.abs(pid))?.exit();
      return true;
    }) as typeof process.kill);
  }

  it("renders each export in its own browser context and closes it afterwards", async () => {
    const { exportAllSlides } = await freshModule();
    await Promise.all([exportAllSlides(slides(3), "4:5"), exportAllSlides(slides(2), "4:5")]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(browsers[0].contexts).toHaveLength(2);
    expect(browsers[0].contexts.every((context) => !context.open)).toBe(true);
    expect(browsers[0].openPages).toBe(0);
  });

  it("fails a slide that misses its deadline, naming it, without disturbing a concurrent export or killing a browser that still answers", async () => {
    supervised = true;
    const kill = interceptKill();
    const { exportAllSlides } = await freshModule();
    vi.useFakeTimers();
    try {
      // Only slide 2 hangs; the browser itself still answers, the health check included.
      hangs = (html) => html.includes("Slide 2");
      const stuck = outcome(exportAllSlides(slides(3), "4:5"));
      await vi.advanceTimersByTimeAsync(PNG_DEADLINE / 2);
      hangs = () => false;
      const concurrent = outcome(exportAllSlides(slides(3), "4:5"));
      await vi.advanceTimersByTimeAsync(PNG_DEADLINE / 2 + PROBE);

      expect(await stuck).toBe(
        "Slide 2 took longer than 60 seconds to render, so the export stopped. Try again; if it happens again, simplify that slide."
      );
      expect(await concurrent).toBeNull();
      expect(signalled).toEqual([]);
      expect(browsers[0].contexts.every((context) => !context.open)).toBe(true);
      // Nothing uses that browser any more, so it closes without waiting for another export.
      expect(browsers[0].closes).toEqual([0]);

      // The next export gets a new one.
      const next = outcome(exportAllSlides(slides(2), "4:5"));
      await vi.advanceTimersByTimeAsync(100);
      expect(await next).toBeNull();
      expect(launch).toHaveBeenCalledTimes(2);
      expect(browsers[0].closes).toEqual([0]);
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
    }
  });

  it("kills a browser that no longer completes any capture, fails what still runs in it at once, and the next export works", async () => {
    supervised = true;
    const kill = interceptKill();
    const { exportAllSlides } = await freshModule();
    vi.useFakeTimers();
    try {
      const warm = outcome(exportAllSlides(slides(1), "4:5"));
      await vi.advanceTimersByTimeAsync(10);
      expect(await warm).toBeNull();

      // From now on the browser completes no screenshot at all, the health check's included.
      hangs = () => true;
      const first = outcome(exportAllSlides(slides(3), "4:5"));
      await vi.advanceTimersByTimeAsync(PNG_DEADLINE / 2);
      const second = outcome(exportAllSlides(slides(2), "4:5"));
      await vi.advanceTimersByTimeAsync(PNG_DEADLINE / 2 + PROBE + 10);

      const replaced = "The export browser stopped responding and was replaced. Try the export again.";
      expect(await first).toBe(replaced);
      // Started half a deadline later, it fails with the kill rather than waiting out its own deadline.
      expect(await second).toBe(replaced);
      expect(signalled).toEqual([[-browsers[0].process()!.pid, "SIGKILL"]]);

      hangs = () => false;
      const next = outcome(exportAllSlides(slides(3), "4:5"));
      await vi.advanceTimersByTimeAsync(100);
      expect(await next).toBeNull();
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
    }
  });

  it("fails an export still opening its context in a browser that is killed as replaced, not with the connection's error", async () => {
    supervised = true;
    const kill = interceptKill();
    const { exportAllSlides } = await freshModule();
    vi.useFakeTimers();
    try {
      const warm = outcome(exportAllSlides(slides(1), "4:5"));
      await vi.advanceTimersByTimeAsync(10);
      expect(await warm).toBeNull();

      // The whole browser stops answering: captures, and then even opening a context.
      hangs = () => true;
      const first = outcome(exportAllSlides(slides(2), "4:5"));
      await vi.advanceTimersByTimeAsync(PNG_DEADLINE / 2);
      contextsHang = true;
      const second = outcome(exportAllSlides(slides(2), "4:5"));
      await vi.advanceTimersByTimeAsync(PNG_DEADLINE / 2 + PROBE + 10);

      const replaced = "The export browser stopped responding and was replaced. Try the export again.";
      expect(await first).toBe(replaced);
      expect(await second).toBe(replaced);
      expect(signalled).toHaveLength(1);

      hangs = () => false;
      contextsHang = false;
      const next = outcome(exportAllSlides(slides(2), "4:5"));
      await vi.advanceTimersByTimeAsync(100);
      expect(await next).toBeNull();
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
    }
  });

  it("kills a retired browser whose clean close does not finish, and still launches its replacement", async () => {
    supervised = true;
    const kill = interceptKill();
    const { exportSlide } = await freshModule();
    vi.useFakeTimers();
    try {
      const warm = exportSlide(slides(1)[0], "4:5");
      await vi.advanceTimersByTimeAsync(10);
      await warm;
      browsers[0].closeHangs = true;
      browsers[0].connected = false;

      const next = outcome(exportSlide(slides(1)[0], "4:5"));
      await vi.advanceTimersByTimeAsync(2_000 + 100);

      expect(await next).toBeNull();
      expect(browsers[0].closes).toHaveLength(1);
      expect(signalled).toEqual([[-browsers[0].process()!.pid, "SIGKILL"]]);
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
    }
  });

  it("names the PDF slide that missed its deadline", async () => {
    const { exportAllSlidePdfs } = await freshModule();
    vi.useFakeTimers();
    try {
      printed = (html) => (html.includes("Slide 2") ? new Promise<Uint8Array>(() => {}) : textPdf("Any"));
      const pdfs = outcome(exportAllSlidePdfs(slides(2), "4:5"));
      await vi.advanceTimersByTimeAsync(120_000 + PROBE + 10);
      expect(await pdfs).toMatch(/^Slide 2 took longer than 120 seconds to render, so the export stopped\./);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains a missed deadline and a replaced browser in the person's words", async () => {
    const { describeExportFailure, SlideTimeoutError, ExportBrowserReplacedError } = await freshModule();
    expect(describeExportFailure(new SlideTimeoutError(60, 4))).toMatch(/^Slide 4 took longer than 60 seconds/);
    expect(describeExportFailure(new ExportBrowserReplacedError())).toBe(
      "The export browser stopped responding and was replaced. Try the export again."
    );
  });
});

// #196: the export browser loads nothing from the network. The fake checks the
// configuration; tests/export-network.test.ts checks real Chromium against a
// local listener.
describe("export browser network (#196)", () => {
  it("launches the export browser resolving no host, and intercepts every request before any export runs", async () => {
    const { exportSlide } = await freshModule();
    await exportSlide(slides(1)[0], "4:5");
    const options = launch.mock.calls[0][0] as { args: string[] };
    expect(options.args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
    expect(browsers[0].sessions).toHaveLength(1);
    expect(browsers[0].sessions[0].sent).toEqual([["Fetch.enable", { patterns: [{ urlPattern: "*" }] }]]);
  });

  it("cancels a navigation, so the page and its frames stay as they are, and fails every other request", async () => {
    const { exportSlide } = await freshModule();
    await exportSlide(slides(1)[0], "4:5");
    const [session] = browsers[0].sessions;
    const paused = session.handlers.get("Fetch.requestPaused")!;
    paused({ requestId: "n1", resourceType: "Document", request: { url: "http://127.0.0.1:9/" } });
    paused({ requestId: "i1", resourceType: "Image", request: { url: "http://127.0.0.1:9/x.png" } });
    paused({ requestId: "s1", resourceType: "Stylesheet", request: { url: "https://example.com/a.css" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.sent.slice(1)).toEqual([
      ["Fetch.fulfillRequest", { requestId: "n1", responseCode: 204 }],
      ["Fetch.failRequest", { requestId: "i1", errorReason: "BlockedByClient" }],
      ["Fetch.failRequest", { requestId: "s1", errorReason: "BlockedByClient" }],
    ]);
  });

  it("loads every slide as an export document under the export policy, with no stylesheet link", async () => {
    const { exportSlide, exportSlidePdf } = await freshModule();
    const { EXPORT_DOCUMENT_CSP } = await import("@/lib/slide-html");
    await exportSlide({ ...slides(1)[0], html: '<p style="font-family: Inter">Slide 1</p>' }, "4:5");
    await exportSlidePdf({ ...slides(1)[0], html: '<p style="font-family: Inter">Slide 1</p>' }, "4:5");
    expect(loadedDocuments).toHaveLength(2);
    for (const document of loadedDocuments) {
      expect(document).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPORT_DOCUMENT_CSP}">`);
      expect(document).not.toContain("fonts.googleapis.com");
    }
  });

  it("never captures a page that is no longer the slide's own document, as PNG or PDF", async () => {
    const { exportSlide, exportSlidePdf, describeExportFailure } = await freshModule();
    pageUrl = (html) => (html.includes("Away") ? "http://127.0.0.1:9/" : "about:blank");
    const away = { ...slides(1)[0], html: "<p>Away</p>" };
    const png = await exportSlide(away, "4:5").catch((error: unknown) => error);
    const pdf = await exportSlidePdf(away, "4:5").catch((error: unknown) => error);
    for (const error of [png, pdf]) {
      expect((error as Error).name).toBe("SlideLeftDocumentError");
      expect(describeExportFailure(error)).toMatch(/tried to open another page/);
    }
    // The browser is healthy, so the next slide exports on it.
    await expect(exportSlide(slides(1)[0], "4:5")).resolves.toBeInstanceOf(Buffer);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
