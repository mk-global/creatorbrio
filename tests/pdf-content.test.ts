import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
import { inspectPdf } from "@/lib/pdf-content";
import { syntheticSlidePng } from "./helpers/export-files";

/** A one-page PDF whose content stream is exactly `content`. */
async function pdfWithContent(content: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(content)));
  return doc.save();
}

describe("inspectPdf", () => {
  it("counts text, vector paths and images drawn with pdf-lib", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const png = await doc.embedPng(await syntheticSlidePng(240, 120, { r: 1, g: 2, b: 3 }));
    const text = doc.addPage([300, 300]);
    text.drawText("Hello", { x: 10, y: 10, size: 12, font });
    text.drawText("World", { x: 10, y: 40, size: 12, font });
    const shapes = doc.addPage([300, 300]);
    shapes.drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(1, 0, 0) });
    shapes.drawImage(png, { x: 100, y: 100, width: 120, height: 60 });

    const [textPage, shapePage] = await inspectPdf(await doc.save());
    expect(textPage).toEqual({ textShows: 2, pathPaints: 0, images: [] });
    expect(shapePage.textShows).toBe(0);
    expect(shapePage.pathPaints).toBe(1);
    expect(shapePage.images).toEqual([{ width: 240, height: 120 }]);
  });

  it("counts what a page draws through an embedded form, as Chromium nests content", async () => {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    source.addPage([100, 100]).drawText("Inside a form", { x: 5, y: 5, size: 10, font });
    const doc = await PDFDocument.create();
    const [form] = await doc.embedPdf(await source.save());
    const page = doc.addPage([200, 200]);
    page.drawPage(form);
    page.drawPage(form, { x: 100, y: 100 });

    const [content] = await inspectPdf(await doc.save());
    expect(content.textShows).toBe(2);
  });

  it("recognises every text-showing operator", async () => {
    const [content] = await inspectPdf(
      await pdfWithContent("BT /F1 12 Tf (a) Tj [(b) 10 (c)] TJ (d) ' 1 2 (e) \" ET")
    );
    expect(content.textShows).toBe(4);
  });

  it("is not fooled by operator names inside strings, hex strings, names or comments", async () => {
    const [content] = await inspectPdf(
      await pdfWithContent(
        [
          "% a comment that says Tj f S",
          "BT (Tj \\) TJ \\\\ (nested ( Tj ) parens) f) Tj ET",
          "<54 6A> pop", // hex for "Tj", followed by an unknown operator
          "/Tj gs",
          "<< /Tj 1 >> BDC EMC",
        ].join("\n")
      )
    );
    expect(content).toEqual({ textShows: 1, pathPaints: 0, images: [] });
  });

  it("skips inline image data, whatever bytes it holds", async () => {
    const [content] = await inspectPdf(
      await pdfWithContent("q BI /W 2 /H 1 /CS /G /BPC 8 ID Tj f S EI Q 0 0 10 10 re f")
    );
    expect(content.textShows).toBe(0);
    expect(content.pathPaints).toBe(1);
    expect(content.images).toEqual([{ width: 0, height: 0 }]);
  });

  it("counts every path-painting operator and nothing else", async () => {
    const [content] = await inspectPdf(
      await pdfWithContent("0 0 m 1 1 l f F f* S s B B* b b* n W n 0 0 1 1 re h")
    );
    expect(content.pathPaints).toBe(9);
  });
});
