import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { AspectRatio, Slide } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { pdfPageSize } from "@/lib/export-pdf";
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
  rasterisePage,
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
        // TrueType, not Type 3 glyph procedures, so every reader, Apple's
        // PDFKit included, selects and searches the text in whole words.
        expect(font).toMatchObject({ type: "CID TrueType", embedded: true, subset: true, unicode: true });
        // A subset is named "ABCDEF+Family-Style". Google names some static
        // cuts by their source master, such as "CormorantGaramondLight-SemiBold".
        expect(font.name).toMatch(/^[A-Z]{6}\+(CormorantGaramond\w*|Inter\w*)-/);
      }
      const families = new Set(
        fonts.map((f) => f.name.split("+")[1].split("-")[0].replace(/^(CormorantGaramond|Inter)\w*$/, "$1"))
      );
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
        expect(font.type).not.toBe("Type 3");
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
      "a text-shadow": [box(`<p style="text-shadow:0 4px 12px rgba(0,0,0,.5)">Shadowed words</p>`), ["Shadowed", "words"]],
      "a box-shadow": [box(`<p style="box-shadow:0 20px 60px rgba(0,0,0,.3);padding:30px">Card words</p>`), ["Card", "words"]],
      "a blend mode": [box(`<p style="mix-blend-mode:multiply;background:#c4622d">Blended words</p>`), ["Blended", "words"]],
      "a filter on a photograph only": [box(`${photo("filter:grayscale(1)")}<p>Caption words</p>`), ["Caption", "words"]],
      "generated content": [box(`<style>.g::before{content:"Generated words"}</style><p class="g"></p>`), ["Generated", "words"]],
      // Filters are refused only around something that can draw text.
      "a drop-shadow on a shape beside it": [box(`<div style="width:200px;height:200px;background:#c4622d;filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"></div><p>Caption words</p>`), ["Caption", "words"]],
      "a declarative shadow root": [box(`<div><template shadowrootmode="open"><p>Shadow words</p></template></div>`), ["Shadow", "words"]],
      "a framed document": [box(`<iframe srcdoc="<p style='font-size:48px;font-family:sans-serif'>Framed words</p>" style="width:600px;height:300px;border:0"></iframe>`), ["Framed", "words"]],
      "a drop-shadow on a broken image without alt text beside it": [box(`<img src="/uploads/missing.png" alt="" style="width:200px;height:200px;filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"><p>Caption words</p>`), ["Caption", "words"]],
      "a drop-shadow on an icon-only SVG symbol beside it": [box(`<svg width="300" height="300"><defs><symbol id="icon" viewBox="0 0 10 10"><path d="M0 0L10 0L5 10z" fill="#c4622d"/></symbol></defs><use href="#icon" width="300" height="300" style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"/></svg><p>Caption words</p>`), ["Caption", "words"]],
    };
    const refused: Record<string, [string, RegExp]> = {
      "a filter over the whole slide": [box(`<p>Flattened words</p>`, "filter:contrast(1.1)"), /^Slide 2 applies a CSS filter to text/],
      "a drop-shadow filter on a heading": [box(`<h2 style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))">Heading words</h2><p>Plain words</p>`), /^Slide 2 applies a CSS filter to text/],
      "an SVG filter on SVG text": [`<svg width="1080" height="600" style="font-family:${SANS}"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><text x="100" y="300" font-size="80" filter="url(#f)">Blurred words</text></svg>`, /^Slide 2 applies a CSS filter to text/],
      "a backdrop-filter around text": [box(`<p>Kept words</p><div style="backdrop-filter:blur(4px);padding:30px">Dropped words</div>`), /^Slide 2 uses a frosted-glass effect \(backdrop-filter\)/],
      "a filter around generated text": [box(`<style>.h::before{content:"Generated heading"}</style><div class="h" style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"></div>`), /^Slide 2 applies a CSS filter to text/],
      "a reflected heading beside plain text": [box(`<h2 style="-webkit-box-reflect:below 0px">Reflected words</h2><p>Plain words</p>`), /^Slide 2 reflects text \(-webkit-box-reflect\)/],
      // Broken in Apple Preview and poppler alike, though printed as text.
      "gradient-filled text": [box(`<p style="background:linear-gradient(90deg,#c4622d,#2f4f4f);-webkit-background-clip:text;background-clip:text;color:transparent">Gradient words</p>`), /^Slide 2 fills text with a gradient or image \(background-clip: text\)/],
      "a mask on text": [box(`<p style="mask-image:linear-gradient(#000,transparent)">Masked words</p>`), /^Slide 2 uses a CSS or SVG mask/],
      "a mask on a photograph beside text": [box(`${photo("-webkit-mask-image:linear-gradient(#000,transparent)")}<p>Caption words</p>`), /^Slide 2 uses a CSS or SVG mask/],
      // A backdrop-filter also drops what is painted after it, even when it
      // holds no text itself.
      "an empty backdrop-filter panel before a caption": [box(`<div style="position:absolute;inset:0;backdrop-filter:blur(4px)"></div><p>Caption words</p>`), /^Slide 2 uses a frosted-glass effect \(backdrop-filter\)/],
      // Text is refused under a filter whether or not it is painted.
      "a filter around a banner cut by a clip-path": [box(`<div style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"><p style="clip-path:inset(0);background:#c4622d;padding:20px">Banner words</p></div>`), /^Slide 2 applies a CSS filter to text/],
      "a filter on an empty box whose ::before draws text": [box(`<style>.h{width:0;height:0;filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))}.h::before{content:"Generated words";position:absolute;white-space:nowrap}</style><div class="h"></div>`), /^Slide 2 applies a CSS filter to text/],
      "a filter around counter numbers": [box(`<style>ol{counter-reset:n;list-style:none}li{counter-increment:n}li::before{content:counter(n)}</style><ol style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"><li></li><li></li></ol>`), /^Slide 2 applies a CSS filter to text/],
      "a filter on a form field": [box(`<input value="Typed words" style="font-size:48px;filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))">`), /^Slide 2 applies a CSS filter to text/],
      "a filter on an SVG symbol that holds text": [`<svg width="1080" height="600" style="font-family:${SANS}"><defs><symbol id="label"><text x="100" y="300" font-size="80">Symbol words</text></symbol></defs><use href="#label" style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"/></svg>`, /^Slide 2 applies a CSS filter to text/],
      "a filter on a framed document": [box(`<iframe srcdoc="<p style='font-size:48px'>Framed words</p>" style="width:600px;height:300px;border:0;filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"></iframe>`), /^Slide 2 applies a CSS filter to text/],
      // Declarative shadow DOM renders without scripts, in the preview too.
      "a filter around an open shadow root": [box(`<div style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"><template shadowrootmode="open"><p>Shadow words</p></template></div>`), /^Slide 2 applies a CSS filter to text/],
      "a filter inside an open shadow root": [box(`<div><template shadowrootmode="open"><p style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))">Shadow words</p></template></div>`), /^Slide 2 applies a CSS filter to text/],
      "a closed shadow root, which cannot be checked": [box(`<div><template shadowrootmode="closed"><p>Shadow words</p></template></div>`), /^Slide 2 could not be checked before printing/],
      "a filter inside a framed document": [box(`<iframe srcdoc="<p style='font-size:48px;filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))'>Framed words</p>" style="width:600px;height:300px;border:0"></iframe>`), /^Slide 2 applies a CSS filter to text/],
      "a filter around a broken image's alt text": [box(`<div style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))"><img src="/uploads/missing.png" alt="Alt words" style="width:600px;height:200px"></div>`), /^Slide 2 applies a CSS filter to text/],
      "a filter beside elements named after the document's own properties": [box(`<img name="body"><img name="documentElement"><form name="createTreeWalker"><input name="parentElement"><input name="querySelectorAll"></form><p style="filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))">Clobbered words</p>`), /^Slide 2 applies a CSS filter to text/],
      "CSS that defeats the print clip": [`<style>body{overflow:visible!important;position:static!important}</style>${box("<p>Shrunk words</p>")}<div style="position:absolute;top:200px;right:-300px;width:600px;height:600px;background:#c4622d"></div>`, /^Slide 2 has content reaching past its edges/],
    };

    // Every character, compared regardless of order: a reader may extract
    // transformed text in another order, but nothing may be missing or added.
    const characters = (words: string[]) => [...words.join("")].sort().join("");

    it("prints outlined text as text, once for its fill and once for its outline", async () => {
      // Chromium draws -webkit-text-stroke as two layers of text: the fill in
      // the TrueType font, then the outline in a Type 3 copy of it, which also
      // maps to Unicode. Readers find the words whole, from the fill, and
      // extract them a second time from the outline (see the README's
      // native PDF limits).
      const words = ["Outlined", "words"];
      const pdf = await exportPdf(
        [slide(box(`<p style="-webkit-text-stroke:2px #c4622d;color:transparent">Outlined words</p>`))],
        "4:5"
      );
      await withPdfFile(pdf, (file) => {
        expect(pageWords(file, 1).slice(0, 2)).toEqual(words);
        expect(characters(pageWords(file, 1))).toBe(characters([...words, ...words]));
        const types = pageFonts(file, 1).map((f) => f.type);
        expect(types).toContain("Type 3");
        expect(types.filter((t) => t !== "Type 3").every((t) => t === "CID TrueType")).toBe(true);
      });
    }, 60_000);

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

    // Text that is not painted is not expected in the PDF: Chromium leaves it
    // out, and that is not a sign of flattening.
    const unpainted: Record<string, string> = {
      "a visually hidden label beside a shape": `<div style="width:100%;height:100%;background:#fff"><div style="width:400px;height:400px;margin:90px;background:#c4622d"></div><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Accessible label</span></div>`,
      "text scrolled out of a clipping box": `<div style="width:100%;height:100%;background:#fff"><div style="width:300px;height:300px;margin:90px;overflow:hidden;background:#8a9a5b"><p style="margin-top:600px;font-size:40px">Hidden words</p></div></div>`,
      "SVG text with neither fill nor stroke": `<svg width="1080" height="1350"><rect x="90" y="90" width="400" height="400" fill="#c4622d"/><text x="100" y="700" font-size="60" fill="none">Unpainted words</text></svg>`,
      "a visually hidden label clipped by clip-path": `<div style="width:100%;height:100%;background:#fff"><div style="width:400px;height:400px;margin:90px;background:#2f4f4f"></div><span style="position:absolute;clip-path:inset(50%);white-space:nowrap">Accessible label</span></div>`,
    };
    for (const [effect, html] of Object.entries(unpainted)) {
      it(`accepts ${effect}`, async () => {
        await expect(exportPdf([slide(html)], "4:5")).resolves.toBeInstanceOf(Uint8Array);
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
  describe("prints the slide the screen shows", () => {
    // Every slide here sets its own background: a page left unpainted is
    // white paper in the PDF but Chromium's dark canvas in the PNG export.
    const panel = (inner: string) =>
      `<div style="width:100%;height:100%;background:#1f3a4d;color:#f7f3e9;font-family:${SANS};font-size:60px;padding:80px">${inner}</div>`;
    const shape = (style: string) => `<div style="background:#c4622d;${style}"></div>`;

    async function pageAndPng(html: string, ratio: AspectRatio = "4:5") {
      const { exportAllSlides } = await import("@/lib/export-slides");
      const pdf = await exportPdf([slide(html)], ratio);
      const [png] = await exportAllSlides([slide(html)], ratio);
      const page = await withPdfFile(pdf, (file) => rasterisePage(file, 1));
      return { pdf, page, png: png.buffer };
    }

    // Chromium prints a blurred shadow as a fill under a luminosity soft
    // mask, which Apple's renderers (Preview, Quick Look, Safari) draw wrongly:
    // a text shadow as a solid block, a box shadow cut off. The merge draws
    // each as an image carrying the blur as its own soft mask instead. If a
    // Chromium update changed how shadows print, the count here would differ.
    const card = (style: string) =>
      `<div style="background:#fff;color:#1f3a4d;border-radius:24px;padding:40px;margin-bottom:60px;${style}">Card words</div>`;
    const shadows: Record<string, [string, number]> = {
      "a box shadow and a text shadow": [panel(card("box-shadow:0 30px 80px rgba(0,0,0,.35)") + `<p style="text-shadow:0 6px 14px rgba(0,0,0,.5)">Shadowed words</p>`), 2],
      "coloured shadows": [panel(card("box-shadow:0 20px 60px rgba(196,98,45,.6)") + `<p style="text-shadow:0 4px 12px rgba(196,98,45,.8)">Shadowed words</p>`), 2],
      "several shadows on one element": [panel(card("box-shadow:0 2px 4px rgba(0,0,0,.2),0 20px 60px rgba(0,0,0,.3)") + `<p style="text-shadow:0 2px 3px #c4622d,0 8px 20px rgba(0,0,0,.4)">Shadowed words</p>`), 4],
      "an inset shadow": [panel(card("box-shadow:inset 0 10px 30px rgba(0,0,0,.4)")), 1],
      "shadows inside an opacity group": [panel(`<div style="opacity:.85">${card("box-shadow:0 20px 60px rgba(0,0,0,.35)")}<p style="text-shadow:0 4px 12px rgba(0,0,0,.5)">Shadowed words</p></div>`), 2],
      "a shadow inside a blend group": [panel(`<div style="mix-blend-mode:multiply">${card("box-shadow:0 20px 60px rgba(0,0,0,.35)")}</div>`), 1],
    };
    for (const [what, [html, count]] of Object.entries(shadows)) {
      it(`draws ${what} as images with their own soft masks, matching the screen`, async () => {
        const printed = await exportAllSlidePdfs([slide(html)], "4:5");
        const masks = await withPdfFile(printed[0], (file) => uncompressed(file).match(/\/S \/Luminosity/g)?.length ?? 0);
        expect(masks).toBe(count);

        const { pdf, page, png } = await pageAndPng(html);
        await withPdfFile(pdf, (file) => {
          expect(uncompressed(file).match(/\/CBShadow\d+ Do/g)?.length ?? 0).toBe(count);
          expect(pageWords(file, 1).length).toBeGreaterThan(0);
        });
        expect(await changedBlocks(page, png)).toBeLessThanOrEqual(MAX_CHANGED_BLOCKS);
      }, 60_000);
    }

    it("prints a drop-shadow filter on a shape as a picture of it, with no masked fill to rewrite", async () => {
      // A filter makes the element an image (and is refused around text), which
      // every reader tried draws as the screen does.
      const html = panel(`<div style="width:300px;height:300px;border-radius:50%;background:#c4622d;filter:drop-shadow(0 20px 30px rgba(0,0,0,.5))"></div>`);
      const { pdf, page, png } = await pageAndPng(html);
      await withPdfFile(pdf, (file) => {
        expect(uncompressed(file)).not.toMatch(/\/S \/Luminosity|\/CBShadow/);
        expect(pdfImages(file).length).toBeGreaterThan(0);
      });
      expect(await changedBlocks(page, png)).toBeLessThanOrEqual(MAX_CHANGED_BLOCKS);
    }, 60_000);

    // [decoration, top edge of the shape when it is not inside the slide's top]
    const bleeds: Record<string, [string, number]> = {
      "past the right edge": [shape("position:absolute;top:200px;right:-300px;width:600px;height:600px;border-radius:50%"), 200],
      "past the bottom edge": [shape("position:absolute;bottom:-20px;left:0;width:1080px;height:100px"), 0],
      "past the bottom edge by a long way": [shape("position:absolute;top:1200px;left:200px;width:300px;height:600px"), 1200],
      "past the left and top edges": [shape("position:absolute;top:-100px;left:-100px;width:300px;height:300px"), 0],
      "as a fixed-position element": [shape("position:fixed;top:1200px;left:900px;width:600px;height:600px"), 1200],
    };
    for (const ratio of ["4:5", "1:1", "9:16"] as AspectRatio[]) {
      for (const [where, [decoration, top]] of Object.entries(bleeds)) {
        if (top >= DIMENSIONS[ratio].height) {
          // Wholly below the slide, the shape shows nothing on screen, but the
          // print clip cannot keep it from starting a second page.
          it(`refuses a ${ratio} shape placed wholly below the slide ${where.replace("past the bottom edge ", "")}, naming the slide`, async () => {
            await expect(exportPdf([slide(panel("First")), slide(panel("Hello world") + decoration, 1)], ratio)).rejects.toMatchObject({
              status: 422,
              message: expect.stringMatching(/^Slide 2 did not print as a single page at the slide's size\./),
            });
          }, 60_000);
          continue;
        }
        it(`clips a ${ratio} shape reaching ${where} as the screen does, without shrinking the page`, async () => {
          const { pdf, page, png } = await pageAndPng(panel("Hello world") + decoration, ratio);
          await withPdfFile(pdf, (file) => {
            expect(pdfInfo(file).pages).toBe(1);
            expect(pageWords(file, 1)).toEqual(["Hello", "world"]);
          });
          expect(await changedBlocks(page, png)).toBeLessThanOrEqual(MAX_CHANGED_BLOCKS);
        }, 60_000);
      }
    }

    // A slide may style its own body, or its root. A body the slide resizes or
    // moves prints without the clip (positioning it would move its content);
    // every one must still match the screen.
    const bodyStyled: Record<string, string> = {
      "a body background": `<style>body{background:#1f3a4d}</style><p style="font-size:60px;padding:80px;color:#fff">Hello world</p>`,
      "a body sized to its content": `<style>body{height:auto;background:#1f3a4d}</style><p style="font-size:60px;padding:80px;color:#fff">Hello world</p>`,
      "a narrower centred body": `<style>body{width:800px;margin:0 auto;background:#1f3a4d}</style><p style="font-size:60px;padding:80px;color:#fff">Hello world</p>`,
      "a root background": `<style>html{background:#1f3a4d}</style><p style="font-size:60px;padding:80px;color:#fff">Hello world</p>`,
      "a layer behind the body's content": `<div style="position:absolute;inset:0;z-index:-1;background:#1f3a4d"></div><p style="font-size:60px;padding:80px;color:#fff">Hello world</p>`,
      // The body paints its own background over a layer behind it; the print
      // clip must not make the body a stacking context and lift the layer.
      "a layer hidden under the root and body backgrounds": `<style>html,body{background:#1f3a4d}</style><div style="position:absolute;top:100px;left:100px;width:400px;height:400px;z-index:-1;background:#c4622d"></div><p style="font-size:60px;padding:80px;color:#fff">Hello world</p>`,
      // A first child's top margin stays inside the body, which is its own
      // formatting context on screen; it must not collapse through in print.
      "a first child's top margin": `<style>body{background:#1f3a4d}</style><div style="width:100%;height:100%;background:#1f3a4d"><p style="margin:90px;font-size:60px;color:#fff;font-family:${SANS}">Hello world</p></div>`,
      // Columns whose cards must not split, which a print break override would undo.
      "masonry columns of unbroken cards": `<div style="width:100%;height:100%;background:#1f3a4d;padding:60px;columns:2;column-gap:40px;font-family:${SANS};font-size:40px;color:#1f3a4d">${[180, 320, 240, 280, 200, 260]
        .map((h, i) => `<div style="break-inside:avoid;height:${h}px;margin-bottom:40px;background:#f7f3e9;padding:20px">Card ${i + 1}</div>`)
        .join("")}</div>`,
    };
    for (const [styling, html] of Object.entries(bodyStyled)) {
      it(`prints a slide with ${styling} as the screen shows it`, async () => {
        const { page, png } = await pageAndPng(html);
        expect(await changedBlocks(page, png)).toBeLessThanOrEqual(MAX_CHANGED_BLOCKS);
      }, 60_000);
    }

    it("refuses a slide that resizes its body and reaches past the slide, rather than shrinking it", async () => {
      const html =
        `<style>body{height:auto;background:#1f3a4d}</style><p style="font-size:60px;padding:80px;color:#fff">Hello world</p>` +
        `<div style="position:absolute;top:200px;right:-300px;width:600px;height:600px;background:#c4622d"></div>`;
      await expect(exportPdf([slide("<p>First</p>"), slide(html, 1)], "4:5")).rejects.toMatchObject({
        status: 422,
        message: expect.stringMatching(/^Slide 2 has content reaching past its edges/),
      });
    }, 60_000);

    it("ignores the slide's own print page rules, margin boxes and page breaks", async () => {
      const html =
        `<style>@page{size:300px 300px;margin:150px;@top-center{content:"Print-only header"}} p{break-after:page}</style>` +
        panel("<p>First words</p><p>Second words</p>");
      const { pdf, page, png } = await pageAndPng(html);
      await withPdfFile(pdf, (file) => {
        expect(pdfInfo(file).pages).toBe(1);
        expect(pageWords(file, 1)).toEqual(["First", "words", "Second", "words"]);
      });
      expect(await changedBlocks(page, png)).toBeLessThanOrEqual(MAX_CHANGED_BLOCKS);
    }, 60_000);

    it("does not run the slide's scripts, as the preview does not", async () => {
      const html =
        panel(`<p id="t">Static words</p>`) +
        `<script>document.getElementById("t").textContent += " scripted"; addEventListener("beforeprint", () => document.body.append("print-only"))</script>`;
      const pdf = await exportPdf([slide(html)], "4:5");
      await withPdfFile(pdf, (file) => expect(pageWords(file, 1)).toEqual(["Static", "words"]));
    }, 60_000);

    it("leaves out links, which the preview and the PNG have nothing to click on", async () => {
      const html = panel(
        `<a href="https://phish.example/" style="position:absolute;inset:0;display:block"></a>` +
          `<a href="javascript:alert(1)" style="color:inherit">Linked words</a> <a href="#nowhere" style="color:inherit">anchor</a>`
      );
      const pdf = await exportPdf([slide(html)], "4:5");
      await withPdfFile(pdf, (file) => {
        expect(pageWords(file, 1)).toEqual(["Linked", "words", "anchor"]);
        expect(uncompressed(file)).not.toMatch(/\/Annots|\/URI|\/Link\b|javascript:|phish\.example|\/Dests?\b/);
      });
    }, 60_000);
  });
});
