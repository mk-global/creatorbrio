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
      return {
        setViewport: async () => {},
        setContent: async () => {},
        waitForFunction: async () => {},
        evaluate: async () => undefined,
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
});
