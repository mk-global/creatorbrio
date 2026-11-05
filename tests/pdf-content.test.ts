import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
import { inspectPdf, parseToUnicode } from "@/lib/pdf-content";
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
    // The standard fonts carry no Unicode map, so their text is not read.
    expect(textPage).toEqual({ textShows: 2, text: "", pathPaints: 0, images: [] });
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
    expect(content).toEqual({ textShows: 1, text: "", pathPaints: 0, images: [] });
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

/** A Unicode map as Chromium writes one, with the given entries. */
function cmap(codeSpace: string, entries: string): string {
  return [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    `1 begincodespacerange ${codeSpace} endcodespacerange`,
    entries,
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
}

/**
 * A one-page PDF drawing `content` with Chromium's two kinds of font: F1 a
 * two-byte CID font (`Type0`), F2 a one-byte Type 3 font. `form` is drawn by
 * `/X1 Do` and has no fonts of its own.
 */
async function pdfWithFonts(content: string, form = ""): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const cid = ctx.obj({
    Type: "Font",
    Subtype: "Type0",
    BaseFont: "AAAAAA+Inter-Regular",
    Encoding: "Identity-H",
    ToUnicode: ctx.register(
      ctx.flateStream(
        cmap(
          "<0000> <FFFF>",
          "3 beginbfchar <0001> <0054> <0002> <0069> <0003> <00660069> endbfchar\n" +
            "2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<63D0> <9AD8>] endbfrange"
        )
      )
    ),
  });
  const type3 = ctx.obj({
    Type: "Font",
    Subtype: "Type3",
    ToUnicode: ctx.register(ctx.flateStream(cmap("<00> <FF>", "1 beginbfchar <E0> <D83DDE80> endbfchar"))),
  });
  const page = doc.addPage([200, 200]);
  const formStream = ctx.register(ctx.flateStream(form, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 200] }));
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: cid, F2: type3 }, XObject: { X1: formStream } }));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
  return doc.save();
}

describe("reading a page's text", () => {
  it("decodes shown strings through each font's Unicode map, with its code length", async () => {
    const [content] = await inspectPdf(
      await pdfWithFonts("BT /F1 40 Tf <00010002> Tj [<0003> -20 <001000110012>] TJ /F2 40 Tf <e0> Tj ET")
    );
    // bfchar entries, a ligature mapping to two letters, an incrementing
    // range, and a one-byte code mapping to a surrogate pair.
    expect(content.text).toBe("Tifiabc\u{1F680}");
  });

  it("reads a range's array form", async () => {
    const [content] = await inspectPdf(await pdfWithFonts("BT /F1 40 Tf <00200021> Tj ET"));
    expect(content.text).toBe("提高");
  });

  it("reads an ActualText in place of the text shown inside it, in hex UTF-16 or as a literal string", async () => {
    const [content] = await inspectPdf(
      await pdfWithFonts(
        // A synthesized small capital: the glyph is "T", the text is "m".
        "BT /F1 40 Tf /Span<</ActualText <feff00650301> >> BDC <0001> Tj EMC " +
          "/Span<</ActualText (m) >> BDC <0001> Tj EMC " +
          "/Span<</ActualText (\\376\\377\\000x) >> BDC EMC " +
          // Marked content without ActualText leaves the text as shown.
          "/P <</MCID 0>> BDC <0002> Tj EMC /Artifact BMC <0002> Tj EMC ET"
      )
    );
    expect(content.text).toBe("e\u0301mxii");
  });

  it("replaces text in nested spans and drawn forms with the outer ActualText alone", async () => {
    const [content] = await inspectPdf(
      await pdfWithFonts("BT /F1 40 Tf /Span<</ActualText (ab) >> BDC <0001> Tj /Span<</ActualText (c) >> BDC EMC /X1 Do EMC <0002> Tj ET", "<0001> Tj")
    );
    expect(content.text).toBe("abi");
  });

  it("follows the font through saved and restored states and into drawn forms", async () => {
    const [content] = await inspectPdf(
      await pdfWithFonts("BT /F1 40 Tf q /F2 40 Tf Q <0001> Tj /X1 Do ET", "<0002> Tj")
    );
    // After Q the CID font is back; the form inherits it from where it is drawn.
    expect(content.text).toBe("Ti");
  });

  it("reads nothing for a font without a Unicode map, or text shown before any font", async () => {
    const [content] = await inspectPdf(await pdfWithFonts("BT <0001> Tj /F9 12 Tf <0001> Tj ET"));
    expect(content.textShows).toBe(2);
    expect(content.text).toBe("");
  });
});

describe("parseToUnicode", () => {
  it("takes the code length from the code space, else from the font kind", () => {
    expect(parseToUnicode(cmap("<00> <FF>", ""), 2).codeLength).toBe(1);
    expect(parseToUnicode(cmap("<0000> <FFFF>", ""), 1).codeLength).toBe(2);
    expect(parseToUnicode("", 2).codeLength).toBe(2);
  });

  it("maps nothing rather than guessing when a range is impossibly large or reversed", () => {
    const huge = parseToUnicode(cmap("<000000> <FFFFFF>", "1 beginbfrange <000000> <FFFFFF> <0041> endbfrange"), 2);
    expect(huge.unicode.size).toBe(0);
    const reversed = parseToUnicode(cmap("<0000> <FFFF>", "1 beginbfrange <0005> <0001> <0041> endbfrange"), 2);
    expect(reversed.unicode.size).toBe(0);
  });
});

describe("forms drawn many times", () => {
  it("reads a shared form once per font, so nested shared forms stay linear", async () => {
    // Each level draws the next twice: 2^25 draws of the innermost form,
    // which only a reader that remembers forms can count in time.
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    let inner = ctx.register(ctx.flateStream("0 0 1 1 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] }));
    for (let level = 0; level < 25; level++) {
      inner = ctx.register(
        ctx.flateStream("/X Do /X Do", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1], Resources: { XObject: { X: inner } } })
      );
    }
    const page = doc.addPage([10, 10]);
    page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { X: inner } }));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream("/X Do")));

    const started = Date.now();
    const [content] = await inspectPdf(await doc.save());
    expect(content.pathPaints).toBe(2 ** 25);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
