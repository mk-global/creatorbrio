import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { AspectRatio, Slide } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { pdfPageSize } from "@/lib/export-pdf";
import {
  chromiumPath,
  pageFonts,
  pageWords,
  pdfImages,
  pdfInfo,
  pdfTools,
  photoJpeg,
  slide,
  uncompressed,
  withPdfFile,
} from "./helpers/native-pdf";

// End to end through the real renderer: slide HTML -> Chromium's native print
// -> merged PDF, read back with poppler and qpdf. It needs Chromium, which CI
// does not install, and fetches the slides' Google Fonts like a real export.
// The merge and the route are covered everywhere by export-pdf.test.ts and
// export-route.test.ts.
const chromium = chromiumPath();

const SERIF = "'Cormorant Garamond', serif";
const SANS = "'Inter', sans-serif";

/** Text every reader must get back exactly, word for word. */
const TEXT_SLIDE = {
  heading: "Midlife weight: what deserves a closer look?",
  plain: "Weight can change for many reasons, and most of them are ordinary.",
  styled: ["Some changes are", "worth discussing", "with a clinician,", "especially", "when they arrive quickly."],
  list: ["Notice the pattern.", "Record what changed.", "Ask a specific question."],
  unicode: "Café, naïve, Zoë and Straße: “quoted” text, 10–20 %, done!",
};

function textSlide(): string {
  const t = TEXT_SLIDE;
  return `<div style="width:100%;height:100%;background:#f7f3e9;color:#22223b;padding:90px">
    <h1 style="font-family:${SERIF};font-size:88px;font-weight:600;line-height:1.05">${t.heading}</h1>
    <p style="font-family:${SANS};font-size:34px;line-height:1.5;margin-top:40px">${t.plain}</p>
    <p style="font-family:${SANS};font-size:34px;line-height:1.5;margin-top:24px">${t.styled[0]} <b>${t.styled[1]}</b> ${t.styled[2]} <i>${t.styled[3]}</i> ${t.styled[4]}</p>
    <ol style="font-family:${SANS};font-size:32px;line-height:1.6;margin:24px 0 0 48px">${t.list.map((l) => `<li>${l}</li>`).join("")}</ol>
    <p style="font-family:${SERIF};font-size:40px;margin-top:32px">${t.unicode}</p>
  </div>`;
}

const textWords = () =>
  [
    TEXT_SLIDE.heading,
    TEXT_SLIDE.plain,
    ...TEXT_SLIDE.styled,
    ...TEXT_SLIDE.list.map((l, i) => `${i + 1}. ${l}`),
    TEXT_SLIDE.unicode,
  ]
    .join(" ")
    .split(/\s+/);

/** CSS rules, borders and shapes and an SVG diagram with text labels. */
function vectorSlide(): string {
  return `<div style="width:100%;height:100%;background:#ffffff;font-family:${SANS};position:relative">
    <div style="position:absolute;left:80px;top:80px;width:920px;height:6px;background:#c4622d"></div>
    <div style="position:absolute;left:80px;top:140px;width:420px;height:260px;border:6px solid #2f4f4f;border-radius:28px"></div>
    <div style="position:absolute;left:580px;top:140px;width:260px;height:260px;border-radius:50%;background:#8a9a5b"></div>
    <svg width="1080" height="640" style="position:absolute;left:0;top:520px">
      <circle cx="300" cy="300" r="190" fill="none" stroke="#2f4f4f" stroke-width="10"/>
      <path d="M520 300 L800 140 L800 460 Z" fill="#c4622d"/>
      <line x1="100" y1="600" x2="980" y2="600" stroke="#22223b" stroke-width="4"/>
      <text x="300" y="312" font-size="44" text-anchor="middle" font-family="Inter">Observation</text>
      <text x="830" y="312" font-size="44" font-family="Inter">Influence</text>
    </svg>
  </div>`;
}

/** A full-bleed uploaded photograph with text over it. */
function photoSlide(): string {
  return `<div style="width:100%;height:100%;position:relative;font-family:${SANS}">
    <img src="/uploads/photo.jpg" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
    <h2 style="position:absolute;left:80px;bottom:140px;right:80px;font-size:72px;color:#ffffff;font-weight:700">Text over a photograph</h2>
  </div>`;
}

describe.skipIf(!chromium || !pdfTools)("native PDF export through the real renderer", () => {
  let workdir: string;
  let originalCwd: string;
  let previousExecutable: string | undefined;
  let exportAllSlidePdfs: typeof import("@/lib/export-slides").exportAllSlidePdfs;
  let mergeSlidePdfs: typeof import("@/lib/export-pdf").mergeSlidePdfs;
  let inspectPdf: typeof import("@/lib/pdf-content").inspectPdf;

  const slides = (): Slide[] => [textSlide(), vectorSlide(), photoSlide()].map((h, i) => slide(h, i));
  const pdfs = new Map<AspectRatio, Uint8Array>();

  async function exportPdf(list: Slide[], ratio: AspectRatio): Promise<Uint8Array> {
    return mergeSlidePdfs(await exportAllSlidePdfs(list, ratio), ratio, { title: "Synthetic" });
  }

  beforeAll(async () => {
    originalCwd = process.cwd();
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = chromium!;

    // Uploads and the font cache resolve from the working directory, so the
    // test uses a throwaway one rather than the real ./public and ./data.
    workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-native-pdf-"));
    await mkdir(path.join(workdir, "public", "uploads"), { recursive: true });
    await mkdir(path.join(workdir, "data"), { recursive: true });
    await writeFile(path.join(workdir, "public", "uploads", "photo.jpg"), await photoJpeg(1600, 2000, 7));
    process.chdir(workdir);

    ({ exportAllSlidePdfs } = await import("@/lib/export-slides"));
    ({ mergeSlidePdfs } = await import("@/lib/export-pdf"));
    ({ inspectPdf } = await import("@/lib/pdf-content"));

    for (const ratio of ["4:5", "1:1", "9:16"] as AspectRatio[]) {
      pdfs.set(ratio, await exportPdf(slides(), ratio));
    }
  }, 240_000);

  afterAll(async () => {
    process.chdir(originalCwd);
    if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("writes valid, unencrypted documents with one exact-size page per slide", async () => {
    for (const [ratio, pdf] of pdfs) {
      const { width, height } = pdfPageSize(ratio);
      await withPdfFile(pdf, (file) => {
        const info = pdfInfo(file);
        expect(info.pages).toBe(3);
        expect(info.encrypted).toBe(false);
        for (const { media, crop } of info.boxes) {
          expect(media[2] - media[0]).toBeCloseTo(width, 6);
          expect(media[3] - media[1]).toBeCloseTo(height, 6);
          expect(crop).toEqual(media);
        }
        // qpdf finds no structural damage in the merged document.
        expect(() => uncompressed(file)).not.toThrow();
      });
    }
  });

  it("keeps every word of each slide as text on that slide's own page", async () => {
    await withPdfFile(pdfs.get("4:5")!, (file) => {
      expect(pageWords(file, 1)).toEqual(textWords());
      expect(pageWords(file, 2)).toEqual(["Observation", "Influence"]);
      expect(pageWords(file, 3)).toEqual(["Text", "over", "a", "photograph"]);
    });
  });

  it("embeds the brand fonts as subsets with Unicode maps, and only those", async () => {
    await withPdfFile(pdfs.get("4:5")!, (file) => {
      const fonts = pageFonts(file, 1);
      expect(fonts.length).toBeGreaterThan(0);
      for (const font of fonts) {
        expect(font).toMatchObject({ embedded: true, subset: true, unicode: true });
        // A subset is named "ABCDEF+Family-Style".
        expect(font.name).toMatch(/^[A-Z]{6}\+(CormorantGaramond|Inter)-/);
      }
      const families = new Set(fonts.map((f) => f.name.split("+")[1].split("-")[0]));
      expect([...families].sort()).toEqual(["CormorantGaramond", "Inter"]);
      // Bold and italic use their own cuts, not a synthesised slant or weight.
      expect(fonts.some((f) => /Inter-Italic/.test(f.name))).toBe(true);
      expect(fonts.some((f) => /Inter-.*Bold/.test(f.name))).toBe(true);
    });
  });

  it("prints a character the brand font lacks in an embedded fallback font, still as text", async () => {
    // Google's Cormorant Garamond has no micro sign, so Chromium draws it from
    // a system font, exactly as the preview and the PNG export do.
    const pdf = await exportPdf(
      [slide(`<p style="font-family:${SERIF};font-size:60px;padding:90px">Dose: 5 µg daily</p>`)],
      "4:5"
    );
    await withPdfFile(pdf, (file) => {
      expect(pageWords(file, 1)).toEqual(["Dose:", "5", "µg", "daily"]);
      const fonts = pageFonts(file, 1);
      expect(fonts.some((f) => f.name.includes("CormorantGaramond"))).toBe(true);
      for (const font of fonts) {
        expect(font).toMatchObject({ embedded: true, subset: true, unicode: true });
      }
    });
  }, 60_000);

  it("draws text with text operators and never as a page-sized picture or a hidden layer", async () => {
    const pdf = pdfs.get("4:5")!;
    const pages = await inspectPdf(pdf);
    for (const page of pages) expect(page.textShows).toBeGreaterThan(0);

    await withPdfFile(pdf, (file) => {
      // The text and vector slides hold no image at all.
      expect(pdfImages(file).filter((i) => i.page !== 3)).toEqual([]);
      // Invisible text (render mode 3) is how OCR layers hide over a picture.
      expect(uncompressed(file)).not.toMatch(/\b3\s+Tr\b/);
    });
  });

  it("keeps CSS and SVG shapes as vector paths", async () => {
    const [, vector] = await inspectPdf(pdfs.get("4:5")!);
    // Rule, bordered box, circle, SVG circle, triangle and line at the least.
    expect(vector.pathPaints).toBeGreaterThanOrEqual(6);
    expect(vector.images).toEqual([]);
  });

  it("keeps the photograph as its original JPEG while the text over it stays text", async () => {
    await withPdfFile(pdfs.get("4:5")!, (file) => {
      expect(pdfImages(file).filter((i) => i.page === 3)).toEqual([
        { page: 3, width: 1600, height: 2000, encoding: "jpeg" },
      ]);
    });
    const [, , photo] = await inspectPdf(pdfs.get("4:5")!);
    expect(photo.textShows).toBeGreaterThan(0);
  });

  it("leaves the PNG export of the same slides at the exact Instagram dimensions", async () => {
    const { exportAllSlides } = await import("@/lib/export-slides");
    for (const ratio of ["4:5", "1:1", "9:16"] as AspectRatio[]) {
      for (const { buffer } of await exportAllSlides(slides(), ratio)) {
        const meta = await sharp(buffer).metadata();
        expect([meta.width, meta.height]).toEqual([DIMENSIONS[ratio].width, DIMENSIONS[ratio].height]);
      }
    }
  }, 120_000);

  describe("effects Chromium cannot print as text", () => {
    const box = (inner: string, style = "") =>
      `<div style="width:100%;height:100%;background:#fff;font-family:${SANS};font-size:56px;padding:90px;${style}">${inner}</div>`;
    const photo = (style = "") =>
      `<img src="/uploads/photo.jpg" style="width:600px;height:400px;display:block;${style}">`;

    // Every effect probed against Chromium's PDF backend. Each one must either
    // print its text as text, or be refused before a picture of it is shipped.
    const printable: Record<string, [string, string[]]> = {
      "a transform and opacity": [box(`<p style="opacity:.5">Faded words</p><p style="transform:rotate(-6deg);margin-top:60px">Tilted words</p>`), ["Faded", "words", "Tilted", "words"]],
      "a 3D transform": [box(`<p style="transform:rotateY(18deg)">Turned words</p>`, "perspective:800px"), ["Turned", "words"]],
      "a clip-path": [box(`<p style="clip-path:polygon(0 0,100% 0,100% 80%,0 100%);background:#c4622d;padding:30px">Clipped words</p>`), ["Clipped", "words"]],
      "a mask": [box(`<p style="mask-image:linear-gradient(#000,transparent)">Masked words</p>`), ["Masked", "words"]],
      "outlined text": [box(`<p style="-webkit-text-stroke:2px #c4622d;color:transparent">Outlined words</p>`), ["Outlined", "words"]],
      "gradient-filled text": [box(`<p style="background:linear-gradient(90deg,#c4622d,#2f4f4f);-webkit-background-clip:text;background-clip:text;color:transparent">Gradient words</p>`), ["Gradient", "words"]],
      "a text-shadow": [box(`<p style="text-shadow:0 4px 12px rgba(0,0,0,.5)">Shadowed words</p>`), ["Shadowed", "words"]],
      "a box-shadow": [box(`<p style="box-shadow:0 20px 60px rgba(0,0,0,.3);padding:30px">Card words</p>`), ["Card", "words"]],
      "a blend mode": [box(`<p style="mix-blend-mode:multiply;background:#c4622d">Blended words</p>`), ["Blended", "words"]],
      "a filter on a photograph only": [box(`${photo("filter:grayscale(1)")}<p>Caption words</p>`), ["Caption", "words"]],
    };
    const refused: Record<string, [string, RegExp]> = {
      "a filter over the whole slide": [box(`<p>Flattened words</p>`, "filter:contrast(1.1)"), /^Slide 2 applies a CSS filter to text/],
      "a drop-shadow filter on a heading": [box(`<h2 style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))">Heading words</h2><p>Plain words</p>`), /^Slide 2 applies a CSS filter to text/],
      "an SVG filter on SVG text": [`<svg width="1080" height="600" style="font-family:${SANS}"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><text x="100" y="300" font-size="80" filter="url(#f)">Blurred words</text></svg>`, /^Slide 2 applies a CSS filter to text/],
      "a backdrop-filter around text": [box(`<p>Kept words</p><div style="backdrop-filter:blur(4px);padding:30px">Dropped words</div>`), /^Slide 2 has text inside a frosted-glass effect/],
    };

    // Every character, compared regardless of order: a reader may extract
    // transformed text in another order, but nothing may be missing or added.
    const characters = (words: string[]) => [...words.join("")].sort().join("");

    for (const [effect, [html, words]] of Object.entries(printable)) {
      it(`prints text under ${effect} as text`, async () => {
        const pdf = await exportPdf([slide(html)], "4:5");
        await withPdfFile(pdf, (file) => expect(characters(pageWords(file, 1))).toBe(characters(words)));
        const [content] = await inspectPdf(pdf);
        expect(content.textShows).toBeGreaterThan(0);
      }, 60_000);
    }

    for (const [effect, [html, message]] of Object.entries(refused)) {
      it(`refuses text under ${effect}, naming the slide`, async () => {
        const plain = slide(box("<p>First slide</p>"), 0);
        await expect(exportPdf([plain, slide(html, 1)], "4:5")).rejects.toMatchObject({
          status: 422,
          message: expect.stringMatching(message),
        });
      }, 60_000);
    }

    it("accepts a slide that is only a photograph", async () => {
      const pdf = await exportPdf(
        [slide(`<img src="/uploads/photo.jpg" style="width:100%;height:100%;object-fit:cover">`)],
        "4:5"
      );
      await withPdfFile(pdf, (file) => expect(pdfImages(file)).toHaveLength(1));
    }, 60_000);
  });
});
