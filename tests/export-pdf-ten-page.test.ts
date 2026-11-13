import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Slide } from "@/types/carousel";
import { TEN_PAGE_CAROUSEL } from "./fixtures/ten-page-carousel";
import {
  changedBlocks,
  chromiumPath,
  MAX_CHANGED_BLOCKS,
  pageFonts,
  pageWords,
  pdfImages,
  pdfInfo,
  pdfTools,
  photoJpeg,
  pixelAt,
  rasterisePage,
  slide,
  uncompressed,
  withPdfFile,
} from "./helpers/native-pdf";

// A realistic ten-page LinkedIn document, printed natively by the real
// renderer and compared page by page with the PNG export of the same slides.
// Needs Chromium and poppler, like export-pdf-render.test.ts.
const chromium = chromiumPath();

/** The text of slide HTML, as the words a reader should find on its page. */
function slideText(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const characters = (text: string) => [...text.replace(/\s+/g, "")].sort().join("");

describe.skipIf(!chromium || !pdfTools)("a ten-page LinkedIn document", () => {
  let workdir: string;
  let originalCwd: string;
  let previousExecutable: string | undefined;
  let exportAllSlides: typeof import("@/lib/export-slides").exportAllSlides;
  let inspectPdf: typeof import("@/lib/pdf-content").inspectPdf;
  let pdf: Uint8Array;
  let pngs: Buffer[];
  let pages: Buffer[];

  const slides = (): Slide[] => TEN_PAGE_CAROUSEL.map((s, i) => slide(s.html, i));

  beforeAll(async () => {
    originalCwd = process.cwd();
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = chromium!;
    workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-ten-page-"));
    await mkdir(path.join(workdir, "public", "uploads"), { recursive: true });
    await mkdir(path.join(workdir, "data"), { recursive: true });
    await writeFile(path.join(workdir, "public", "uploads", "7c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f.png"), await photoJpeg(1600, 1200, 3));
    process.chdir(workdir);

    const slidesModule = await import("@/lib/export-slides");
    const { mergeSlidePdfs } = await import("@/lib/export-pdf");
    ({ inspectPdf } = await import("@/lib/pdf-content"));
    exportAllSlides = slidesModule.exportAllSlides;

    pdf = await mergeSlidePdfs(await slidesModule.exportAllSlidePdfs(slides(), "4:5"), "4:5", {
      title: "Ten-page guide",
    });
    pngs = (await exportAllSlides(slides(), "4:5")).map((p) => p.buffer);
    pages = await withPdfFile(pdf, async (file) => {
      const out: Buffer[] = [];
      for (let p = 1; p <= 10; p++) out.push(await rasterisePage(file, p));
      return out;
    });
  }, 300_000);

  afterAll(async () => {
    process.chdir(originalCwd);
    if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("is one valid document of exactly ten 4:5 pages", async () => {
    await withPdfFile(pdf, (file) => {
      const info = pdfInfo(file);
      expect(info.pages).toBe(10);
      expect(info.encrypted).toBe(false);
      for (const { media } of info.boxes) {
        expect(media[2] - media[0]).toBeCloseTo(810, 6);
        expect(media[3] - media[1]).toBeCloseTo(1012.5, 6);
      }
      expect(() => uncompressed(file)).not.toThrow();
    });
    for (const page of pages) {
      const { width, height } = await import("sharp").then((m) => m.default(page).metadata());
      expect([width, height]).toEqual([1080, 1350]);
    }
  });

  it("keeps each slide's text, whole and in order, on its own page", async () => {
    await withPdfFile(pdf, (file) => {
      for (const [i, { html, phrases }] of TEN_PAGE_CAROUSEL.entries()) {
        const text = pageWords(file, i + 1).join(" ");
        for (const phrase of phrases) expect(text, `page ${i + 1}`).toContain(phrase);
        // Every character of the slide exactly once: nothing missing or doubled.
        expect(characters(text), `page ${i + 1}`).toBe(characters(slideText(html)));
      }
    });
  });

  it("embeds only the brand fonts, as TrueType subsets with Unicode maps", async () => {
    await withPdfFile(pdf, (file) => {
      for (let p = 1; p <= 10; p++) {
        const fonts = pageFonts(file, p);
        expect(fonts.length).toBeGreaterThan(0);
        for (const font of fonts) {
          expect(font).toMatchObject({ type: "CID TrueType", embedded: true, subset: true, unicode: true });
          // Google names some static cuts by their source master, such as
          // "CormorantGaramondLight-SemiBold".
          expect(font.name).toMatch(/^[A-Z]{6}\+(CormorantGaramond\w*|Inter\w*)-/);
        }
      }
    });
  });

  it("draws text as text on every page, with the cover photograph as the only image", async () => {
    for (const page of await inspectPdf(pdf)) expect(page.textShows).toBeGreaterThan(0);
    await withPdfFile(pdf, (file) => {
      expect(pdfImages(file)).toEqual([{ page: 1, width: 1600, height: 1200, encoding: "jpeg" }]);
      expect(uncompressed(file)).not.toMatch(/\b3\s+Tr\b/);
    });
  });

  it("keeps the diagrams as vector paths", async () => {
    const content = await inspectPdf(pdf);
    // The observation diagram, the connected factors and the decision arrows.
    for (const index of [2, 5, 8]) {
      expect(content[index].pathPaints, `page ${index + 1}`).toBeGreaterThanOrEqual(4);
      expect(content[index].images).toEqual([]);
    }
  });

  it("looks like the PNG export of the same slides on every page", async () => {
    for (const [i, page] of pages.entries()) {
      expect(await changedBlocks(page, pngs[i]), `page ${i + 1}`).toBeLessThanOrEqual(MAX_CHANGED_BLOCKS);
    }
  });

  it("keeps brand colours exact on solid fills", async () => {
    const samples: [number, number, number, string][] = [
      [1, 40, 700, "#f7f3e9"], // ivory page background
      [3, 940, 700, "#2b2b2b"], // charcoal comparison panel
      [3, 480, 700, "#f7f3e9"], // ivory inside the outlined panel
      [7, 960, 330, "#8a9a5b"], // sage table header
      [8, 960, 250, "#c4622d"], // terracotta answer box
      [9, 104, 342, "#c4622d"], // terracotta step marker
      [9, 104, 440, "#8a9a5b"], // sage step marker
    ];
    for (const [index, x, y, colour] of samples) {
      expect(await pixelAt(pngs[index], x, y), `PNG page ${index + 1}`).toBe(colour);
      expect(await pixelAt(pages[index], x, y), `PDF page ${index + 1}`).toBe(colour);
    }
  });

  describe("the comparison catches real regressions", () => {
    const variants: [string, number, (html: string) => string][] = [
      ["a swapped word", 1, (h) => h.replace("ordinary", "unusual")],
      ["a block moved 60 px", 3, (h) => h.replace("margin-top:20px", "margin-top:96px")],
      ["a missing diagram node", 5, (h) => h.replace(/<circle cx="688" cy="440"[^>]*\/>/, "")],
      ["the wrong heading font", 6, (h) => h.replaceAll("'Cormorant Garamond', serif", "'Inter', sans-serif")],
    ];
    for (const [change, index, edit] of variants) {
      it(`flags ${change}`, async () => {
        const original = TEN_PAGE_CAROUSEL[index].html;
        const changed = edit(original);
        expect(changed).not.toBe(original);
        const [png] = await exportAllSlides([slide(changed, index)], "4:5");
        expect(await changedBlocks(pages[index], png.buffer)).toBeGreaterThan(MAX_CHANGED_BLOCKS);
      }, 60_000);
    }
  });
});
