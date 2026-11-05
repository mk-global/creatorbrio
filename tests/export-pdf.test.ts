import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  mergeSlidePdfs,
  unprintableSlideError,
  pdfPageSize,
  PdfExportError,
  PDF_POINTS_PER_PIXEL,
  LINKEDIN_MAX_PDF_BYTES,
  LINKEDIN_MAX_PDF_PAGES,
} from "@/lib/export-pdf";
import {
  DEFAULT_EXPORT_FORMAT,
  EXPORT_FORMATS,
  filenameFromDisposition,
  linkedInAdvisory,
  parseExportFormat,
} from "@/lib/export-formats";
import { DIMENSIONS, MAX_SLIDES } from "@/types/carousel";
import type { AspectRatio } from "@/types/carousel";
import { inspectPdf } from "@/lib/pdf-content";
import {
  chromiumPrintSize,
  detailedSlidePng,
  hexText,
  readPdfPages,
  rgbPixels,
  slidePdf,
  syntheticSlidePng,
} from "./helpers/export-files";

const RATIOS: AspectRatio[] = ["4:5", "1:1", "9:16"];

// Distinct colours so a page can be matched to the slide it came from.
const PALETTE = [
  { r: 233, g: 69, b: 96 },
  { r: 26, g: 26, b: 46 },
  { r: 22, g: 160, b: 133 },
  { r: 241, g: 196, b: 15 },
];

describe("PDF page size", () => {
  it("converts slide pixels to points at 72/96", () => {
    expect(PDF_POINTS_PER_PIXEL).toBe(0.75);
    expect(pdfPageSize("4:5")).toEqual({ width: 810, height: 1012.5 });
    expect(pdfPageSize("1:1")).toEqual({ width: 810, height: 810 });
    expect(pdfPageSize("9:16")).toEqual({ width: 810, height: 1440 });
  });

  it("keeps each carousel's exact aspect ratio", () => {
    expect(pdfPageSize("4:5").width / pdfPageSize("4:5").height).toBe(4 / 5);
    expect(pdfPageSize("1:1").width / pdfPageSize("1:1").height).toBe(1);
    expect(pdfPageSize("9:16").width / pdfPageSize("9:16").height).toBe(9 / 16);
  });
});

describe("mergeSlidePdfs", () => {
  async function slidesFor(ratio: AspectRatio, count: number): Promise<Uint8Array[]> {
    const { width, height } = DIMENSIONS[ratio];
    return Promise.all(
      Array.from({ length: count }, (_, i) =>
        slidePdf(`Slide ${i + 1}`, { slideWidth: width, slideHeight: height })
      )
    );
  }

  it("produces a structurally valid, unencrypted PDF", async () => {
    const bytes = await mergeSlidePdfs(await slidesFor("4:5", 2), "4:5", {
      title: "Launch week",
    });
    const text = Buffer.from(bytes).toString("latin1");
    // Object syntax only: compressed streams can contain any byte sequence.
    const objects = text.replace(/stream\r?\n[\s\S]*?endstream/g, "stream endstream");

    expect(text.startsWith("%PDF-1.")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // A classic xref table, readable by every PDF reader.
    expect(objects).toContain("\nxref\n");
    expect(objects).not.toContain("/Encrypt");
    expect(objects).not.toContain("/ObjStm");
    // Nothing interactive or scripted. pdf-lib writes an empty `/Annots [ ]`.
    expect(objects).not.toMatch(/\/JavaScript|\/JS\b|\/AcroForm|\/OpenAction/);
    expect(objects).not.toMatch(/\/Annots\s*\[\s*[^\]\s]/);

    // Loading with pdf-lib's defaults would overwrite the producer in memory.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.isEncrypted).toBe(false);
    expect(doc.getTitle()).toBe("Launch week");
    expect(doc.getCreator()).toBe("CreatorBrio");
    expect(doc.getProducer()).toBe("CreatorBrio");
    expect(doc.getCreationDate()).toBeInstanceOf(Date);
  });

  it("creates exactly one page per slide, in slide order", async () => {
    for (const count of [1, 3, MAX_SLIDES]) {
      const pages = await readPdfPages(
        await mergeSlidePdfs(await slidesFor("1:1", count), "1:1")
      );
      expect(pages).toHaveLength(count);
      pages.forEach((page, i) => expect(page.operators).toContain(hexText(`Slide ${i + 1}`)));
    }
  });

  it("copies each page's drawing as it is: text stays text and nothing becomes an image", async () => {
    const slides = await slidesFor("4:5", 3);
    const merged = await inspectPdf(await mergeSlidePdfs(slides, "4:5"));
    const originals = await Promise.all(slides.map(async (s) => (await inspectPdf(s))[0]));

    expect(merged).toEqual(originals);
    for (const page of merged) {
      expect(page.textShows).toBeGreaterThan(0);
      expect(page.pathPaints).toBeGreaterThan(0);
      expect(page.images).toEqual([]);
    }
    const sourceOps = (await readPdfPages(slides[1]))[0].operators;
    expect((await readPdfPages(await mergeSlidePdfs(slides, "4:5")))[1].operators).toBe(sourceOps);
  });

  it("keeps a slide's image as an image without re-encoding it", async () => {
    const png = await syntheticSlidePng(240, 240, PALETTE[2]);
    const slide = await slidePdf("Photo slide", { png });
    const [page] = await readPdfPages(await mergeSlidePdfs([slide], "4:5"));
    expect(page.images).toHaveLength(1);
    expect(page.images[0].pixels.equals(await rgbPixels(png))).toBe(true);
    expect(page.operators).toContain(hexText("Photo slide"));
  });

  for (const ratio of RATIOS) {
    it(`trims each ${ratio} page to the slide's exact size, keeping its top edge`, async () => {
      const expected = pdfPageSize(ratio);
      const { width, height } = DIMENSIONS[ratio];
      const [, printedHeight] = chromiumPrintSize(width, height);
      const pages = await readPdfPages(await mergeSlidePdfs(await slidesFor(ratio, 3), ratio));

      for (const page of pages) {
        expect({ width: page.width, height: page.height }).toEqual(expected);
        // The box keeps the printed page's top edge, where the slide starts,
        // and drops the rounding sliver from the bottom.
        expect(page.mediaBoxOrigin.x).toBe(0);
        expect(page.mediaBoxOrigin.y).toBeCloseTo(printedHeight - expected.height, 6);
        expect(page.mediaBoxOrigin.y + page.height).toBeCloseTo(printedHeight, 6);
        expect(page.cropBox).toEqual({
          x: 0,
          y: page.mediaBoxOrigin.y,
          width: expected.width,
          height: expected.height,
        });
        expect(page.rotation).toBe(0);
      }
    });
  }

  it("takes a print that is already the exact size as it is", async () => {
    const exact = await slidePdf("Exact", { size: [810, 1012.5] });
    const [page] = await readPdfPages(await mergeSlidePdfs([exact], "4:5"));
    expect(page).toMatchObject({ width: 810, height: 1012.5, mediaBoxOrigin: { x: 0, y: 0 } });
  });

  it("refuses a slide printed at another size rather than cropping or stretching it", async () => {
    const square = await slidePdf("Square", { slideWidth: 1080, slideHeight: 1080 });
    await expect(mergeSlidePdfs([square], "4:5")).rejects.toThrow(
      /Slide 1 printed at 810x810 pt, expected 810x1012.5/
    );
    // More than Chromium's 0.01 in rounding is a different size, not rounding.
    const tooTall = await slidePdf("Too tall", { size: [810, 1012.5 + 0.8] });
    await expect(mergeSlidePdfs([tooTall], "4:5")).rejects.toThrow(/printed at/);
    const tooShort = await slidePdf("Too short", { size: [810, 1012] });
    await expect(mergeSlidePdfs([tooShort], "4:5")).rejects.toThrow(/printed at/);
  });

  it("refuses a slide that printed to more than one page instead of dropping pages", async () => {
    const two = await slidePdf("Overflow", { pages: 2 });
    const one = await slidePdf("Fine");
    await expect(mergeSlidePdfs([one, two], "4:5")).rejects.toThrow(
      /Slide 2 printed to 2 pages, expected 1/
    );
  });

  it("refuses data that is not a PDF", async () => {
    await expect(
      mergeSlidePdfs([new Uint8Array(Buffer.from("not a pdf"))], "4:5")
    ).rejects.toThrow();
  });

  it("lets other work run while it builds the PDF", async () => {
    // Copying pages is synchronous in pdf-lib; without yielding between slides
    // nothing else on the server could run until the whole PDF was finished.
    const slides = await slidesFor("4:5", 6);
    let turns = 0;
    let done = false;
    const turn = () => {
      if (done) return;
      turns++;
      setImmediate(turn);
    };
    setImmediate(turn);
    try {
      await mergeSlidePdfs(slides, "4:5");
    } finally {
      done = true;
    }
    expect(turns).toBeGreaterThanOrEqual(slides.length - 1);
  });

  it("does not modify the slide PDFs it is given", async () => {
    const slides = await slidesFor("4:5", 2);
    const copies = slides.map((bytes) => Uint8Array.from(bytes));
    await mergeSlidePdfs(slides, "4:5");
    slides.forEach((bytes, i) => expect(Buffer.from(bytes).equals(Buffer.from(copies[i]))).toBe(true));
  });

  it("refuses an empty export", async () => {
    const attempt = mergeSlidePdfs([], "4:5");
    await expect(attempt).rejects.toBeInstanceOf(PdfExportError);
    await expect(attempt).rejects.toMatchObject({ status: 400 });
  });

  it("enforces the size limit with an actionable message", async () => {
    const photo = await detailedSlidePng(1080, 1350, 3);
    const slide = await slidePdf("Detailed", { png: photo });
    const attempt = mergeSlidePdfs([slide], "4:5", { maxBytes: 1_000_000 });
    await expect(attempt).rejects.toBeInstanceOf(PdfExportError);
    await expect(attempt).rejects.toMatchObject({ status: 422 });
    await expect(attempt).rejects.toThrow(
      /The PDF is \d+\.\d MB, above LinkedIn's 1\.0 MB limit\. Remove slides or use simpler, smaller images/
    );
  });

  it("uses LinkedIn's document limits by default", async () => {
    expect(LINKEDIN_MAX_PDF_BYTES).toBe(100_000_000);
    expect(LINKEDIN_MAX_PDF_PAGES).toBe(300);
    // CreatorBrio's own slide limit sits well inside LinkedIn's page limit.
    expect(MAX_SLIDES).toBeLessThanOrEqual(LINKEDIN_MAX_PDF_PAGES);

    const tooMany = Array.from({ length: LINKEDIN_MAX_PDF_PAGES + 1 }, () => new Uint8Array());
    const attempt = mergeSlidePdfs(tooMany, "4:5");
    await expect(attempt).rejects.toMatchObject({ status: 422 });
    await expect(attempt).rejects.toThrow(/at most 300 pages/);
  });
});

describe("refusing a slide whose text cannot be printed as text", () => {
  it.each([
    ["filter", /^Slide 4 applies a CSS filter to text, .*remove the filter from the text/],
    ["backdrop-filter", /^Slide 4 has text inside a frosted-glass effect \(backdrop-filter\), which PDF printing leaves out\./],
    ["flattened", /^Slide 4 could only be printed as a picture, .*simplify the slide's visual effects/],
  ] as const)("explains %s with the slide number and what to do", (reason, message) => {
    const error = unprintableSlideError(4, reason);
    expect(error).toBeInstanceOf(PdfExportError);
    expect(error.status).toBe(422);
    expect(error.message).toMatch(message);
    expect(error.message).toMatch(/then export the PDF again\. The PNG export is not affected\.$/);
  });
});

describe("export formats", () => {
  it("defaults to the PNG ZIP when no format is given", () => {
    expect(DEFAULT_EXPORT_FORMAT).toBe("png");
    expect(parseExportFormat(null)).toBe("png");
    expect(parseExportFormat("")).toBe("png");
  });

  it("accepts the two formats and rejects anything else", () => {
    expect(parseExportFormat("png")).toBe("png");
    expect(parseExportFormat("pdf")).toBe("pdf");
    for (const value of ["PDF", "zip", "jpeg", "pdf ", "../pdf"]) {
      expect(parseExportFormat(value)).toBeNull();
    }
  });

  it("offers Instagram PNG ZIP first and LinkedIn PDF second", () => {
    expect(
      EXPORT_FORMATS.map((f) => `${f.platform} · ${f.label}`)
    ).toEqual(["Instagram · PNG ZIP", "LinkedIn · PDF"]);
    expect(EXPORT_FORMATS.map((f) => f.extension)).toEqual(["zip", "pdf"]);
  });

  it("advises on 9:16 LinkedIn exports only", () => {
    expect(linkedInAdvisory("4:5")).toBeNull();
    expect(linkedInAdvisory("1:1")).toBeNull();
    expect(linkedInAdvisory("9:16")).toMatch(/4:5 generally displays better/);
  });

  it("reads the attachment filename the server sends", () => {
    expect(
      filenameFromDisposition('attachment; filename="carousel-Launch_week.pdf"')
    ).toBe("carousel-Launch_week.pdf");
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition("attachment")).toBeNull();
    expect(filenameFromDisposition('attachment; filename="../../x.pdf"')).toBe(
      ".._.._x.pdf"
    );
  });
});
