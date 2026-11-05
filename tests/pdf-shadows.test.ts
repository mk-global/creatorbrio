import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import { rewriteMaskedShadows } from "@/lib/pdf-shadows";

// Documents shaped like Chromium's print of a blurred shadow, built directly
// so the matcher's every condition can be exercised without Chromium. The
// real-Chromium side is in export-pdf-render.test.ts.

interface Shape {
  /** Page content; MASK, ALPHA and RESET name the graphics states below. */
  content?: string;
  /** The mask group's content. */
  form?: string;
  formBBox?: number[];
  maskState?: Record<string, unknown>;
  smask?: Record<string, unknown>;
  image?: Record<string, unknown>;
  formState?: Record<string, unknown>;
  /** Wrap the page content into a form XObject drawn by the page. */
  inForm?: boolean;
  contentsArray?: boolean;
}

const SHADOW = "/G7 gs\n111 174 3153 1102 re\nf\n/G8 gs";
const DEFAULT_CONTENT = `q\n0 0 3375 4218.75 re\nW* n\n.7686 .3843 .1765 RG .7686 .3843 .1765 rg\n/G5 gs\n${SHADOW}\nQ\nBT\n/F1 12 Tf\n<0041> Tj\nET`;
const DEFAULT_FORM = "q\n3153 0 0 -1102 111 1276 cm\n0 0 0 RG 0 0 0 rg\n/G3 gs\n/X4 Do\nQ\n";

async function build(shape: Shape = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([810, 1012.5]);
  const ctx = doc.context;
  const grey = ctx.register(
    ctx.stream(new Uint8Array([0, 128, 255, 64]), {
      Type: "XObject",
      Subtype: "Image",
      Width: 2,
      Height: 2,
      ColorSpace: "DeviceGray",
      BitsPerComponent: 8,
      ...shape.image,
    })
  );
  const g3 = ctx.register(ctx.obj({ Type: "ExtGState", ca: 1, BM: "Normal", ...shape.formState }));
  const form = ctx.register(
    ctx.stream(shape.form ?? DEFAULT_FORM, {
      Type: "XObject",
      Subtype: "Form",
      BBox: shape.formBBox ?? [111, 174, 3264, 1276],
      Group: { Type: "Group", S: "Transparency", CS: "DeviceGray", I: true },
      Resources: { ExtGState: { G3: g3 }, XObject: { X4: grey } },
    })
  );
  const states = ctx.obj({
    G5: ctx.obj({ Type: "ExtGState", ca: 0.5 }),
    G7: ctx.obj({ Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: form, ...shape.smask }, ...shape.maskState }),
    G8: ctx.obj({ Type: "ExtGState", SMask: "None" }),
  });
  const content = shape.content ?? DEFAULT_CONTENT;
  if (shape.inForm) {
    const group = ctx.register(
      ctx.stream(content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 3375, 4218.75], Resources: { ExtGState: states } })
    );
    page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { X16: group } }));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("q\n/X16 Do\nQ")));
  } else {
    page.node.set(PDFName.of("Resources"), ctx.obj({ ExtGState: states }));
    const stream = ctx.register(ctx.stream(content));
    page.node.set(PDFName.of("Contents"), shape.contentsArray ? ctx.obj([stream]) : stream);
  }
  return { doc, page, grey };
}

function rawStream(value: unknown): PDFRawStream {
  if (!(value instanceof PDFRawStream)) throw new Error("Expected a stream");
  return value;
}

const text = (stream: unknown) =>
  Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString("latin1");

function pageContent(built: Awaited<ReturnType<typeof build>>): string {
  return text(built.page.node.lookup(PDFName.of("Contents")));
}

function formContent(built: Awaited<ReturnType<typeof build>>): string {
  const xobjects = built.page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  return text(rawStream(xobjects.lookup(PDFName.of("X16"))));
}

describe("rewriteMaskedShadows", () => {
  it("draws Chromium's masked shadow fill as an image carrying the blur as its own soft mask", async () => {
    const built = await build();

    expect(rewriteMaskedShadows(built.doc, built.page)).toBe(1);

    expect(pageContent(built)).toBe(
      DEFAULT_CONTENT.replace(SHADOW, "q\n3153 0 0 -1102 111 1276 cm\n/CBShadow0 Do\nQ\n/G8 gs")
    );
    const xobjects = built.page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const pixel = rawStream(xobjects.lookup(PDFName.of("CBShadow0")));
    expect(pixel.dict.get(PDFName.of("SMask"))).toBe(built.grey);
    expect(pixel.dict.get(PDFName.of("ColorSpace"))).toBe(PDFName.of("DeviceRGB"));
    expect([...decodePDFRawStream(pixel).decode()]).toEqual([196, 98, 45]);
  });

  it("is a no-op on a page without masked shadows, leaving its content object as it was", async () => {
    const built = await build({ content: "q\n0 0 0 rg\n0 0 10 10 re\nf\nQ" });
    const before = built.page.node.get(PDFName.of("Contents"));

    expect(rewriteMaskedShadows(built.doc, built.page)).toBe(0);
    expect(built.page.node.get(PDFName.of("Contents"))).toBe(before);
    expect(pageContent(built)).toBe("q\n0 0 0 rg\n0 0 10 10 re\nf\nQ");
  });

  it("takes the shadow colour from the fill in effect, through saved and restored states", async () => {
    // The second of two shadows often has no colour of its own: it is the
    // one set earlier, restored by Q.
    const content = `0 0 0 RG 0 0 0 rg\nq\n.5 .5 .5 RG .5 .5 .5 rg\nQ\n${SHADOW}`;
    const built = await build({ content });

    expect(rewriteMaskedShadows(built.doc, built.page)).toBe(1);
    const xobjects = built.page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    expect([...decodePDFRawStream(rawStream(xobjects.lookup(PDFName.of("CBShadow0")))).decode()]).toEqual([0, 0, 0]);
  });

  it("rewrites a shadow inside a form, as Chromium prints an element with opacity or a blend mode", async () => {
    const built = await build({ inForm: true });

    expect(rewriteMaskedShadows(built.doc, built.page)).toBe(1);
    expect(formContent(built)).toContain("/CBShadow0 Do");
    expect(formContent(built)).not.toContain("/G7 gs");
  });

  it("leaves a form's shadow alone when its colour is inherited from where the form is drawn", async () => {
    const built = await build({ inForm: true, content: `/G5 gs\n${SHADOW}` });

    expect(rewriteMaskedShadows(built.doc, built.page)).toBe(0);
    expect(formContent(built)).toBe(`/G5 gs\n${SHADOW}`);
  });

  // Each is one condition of the match broken; the page must be left exactly as printed.
  const mismatches: Record<string, Shape> = {
    "a fill of another rectangle": { content: DEFAULT_CONTENT.replace("111 174 3153 1102 re", "111 174 3153 1100 re") },
    "a stroke instead of a fill": { content: DEFAULT_CONTENT.replace("re\nf\n/G8", "re\nS\n/G8") },
    "no reset of the mask after the fill": { content: DEFAULT_CONTENT.replace("f\n/G8 gs", "f\n/G5 gs") },
    "a fill colour set some other way": { content: DEFAULT_CONTENT.replace(".7686 .3843 .1765 RG .7686 .3843 .1765 rg", "/Cs1 cs\n1 0 0 scn") },
    "a grey fill colour": { content: DEFAULT_CONTENT.replace(".7686 .3843 .1765 RG .7686 .3843 .1765 rg", ".5 g") },
    "inline image data in the stream": { content: `BI\n/W 1 /H 1 /CS /G /BPC 8\nID\n\u0000\nEI\n${DEFAULT_CONTENT}` },
    "content split into several streams": { contentsArray: true },
    "a mask state that also sets opacity": { maskState: { ca: 0.5 } },
    "an alpha soft mask": { smask: { S: "Alpha" } },
    "a soft mask with a backdrop colour": { smask: { BC: [0.5] } },
    "a mask group that draws more than the image": { form: DEFAULT_FORM.replace("/X4 Do", "/X4 Do\n0 0 1 1 re\nf") },
    "a mask group whose image is not where its box is": { formBBox: [0, 0, 3153, 1102] },
    "a mask group drawing at partial opacity": { formState: { ca: 0.5 } },
    "a mask image in colour": { image: { ColorSpace: "DeviceRGB" } },
    "a mask image with an inverted decode": { image: { Decode: [1, 0] } },
    "a mask image with transparency of its own": { image: { SMask: PDFRef.of(1) } },
    "a mask image of 16-bit samples": { image: { BitsPerComponent: 16 } },
  };
  for (const [what, shape] of Object.entries(mismatches)) {
    it(`leaves the page as printed for ${what}`, async () => {
      const built = await build(shape);
      const before = shape.contentsArray ? null : pageContent(built);
      const contentsBefore = built.page.node.get(PDFName.of("Contents"));

      expect(rewriteMaskedShadows(built.doc, built.page)).toBe(0);
      expect(built.page.node.get(PDFName.of("Contents"))).toBe(contentsBefore);
      if (before !== null) expect(pageContent(built)).toBe(before);
      expect(built.page.node.Resources()!.get(PDFName.of("XObject"))).toBeUndefined();
    });
  }

  it("keeps a one-pixel image per colour and blur, shared by repeated shadows", async () => {
    const content = `0 0 0 RG 0 0 0 rg\n${SHADOW}\n${SHADOW}\n1 1 1 RG 1 1 1 rg\n${SHADOW}`;
    const built = await build({ content });

    expect(rewriteMaskedShadows(built.doc, built.page)).toBe(3);
    const xobjects = built.page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    expect(xobjects.keys().map((k) => k.decodeText()).sort()).toEqual(["CBShadow0", "CBShadow1"]);
    expect(pageContent(built).match(/\/CBShadow\d Do/g)).toHaveLength(3);
  });

  it("keeps the form's own dictionary when rewriting its content", async () => {
    const built = await build({ inForm: true });
    rewriteMaskedShadows(built.doc, built.page);
    const xobjects = built.page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const form = rawStream(xobjects.lookup(PDFName.of("X16")));
    expect(form.dict.get(PDFName.of("Subtype"))).toBe(PDFName.of("Form"));
    expect(form.dict.lookup(PDFName.of("BBox"), PDFArray).asArray().map((n: unknown) => (n as PDFNumber).asNumber())).toEqual([0, 0, 3375, 4218.75]);
    expect(form.dict.lookup(PDFName.of("Resources"), PDFDict).has(PDFName.of("ExtGState"))).toBe(true);
  });
});
