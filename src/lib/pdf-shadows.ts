import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";

/**
 * Re-expresses the blurred shadows Chromium prints so that Apple's PDF
 * renderers draw them as the screen does.
 *
 * Chromium (Skia) prints a blurred `box-shadow`, `text-shadow` or
 * `drop-shadow` as a rectangle filled with the shadow colour under a
 * luminosity soft mask, whose group paints one greyscale image of the blur.
 * Apple's Core Graphics, and so Preview, Quick Look and Safari, draws that
 * construct wrongly: a text shadow as a solid block, a box shadow cut off.
 * The same pixels drawn as an image whose own soft mask is the blur are drawn
 * correctly by Apple's renderers and by poppler alike.
 *
 * Each such fill is replaced by drawing a one-pixel image of the shadow colour
 * whose soft mask is the existing blur image, placed exactly where the mask
 * group placed it. Nothing is re-rendered: the blur image, the clip, the
 * opacity and every other operator stay as they are.
 *
 * Only Chromium's exact construct is rewritten, after checking every part of
 * it; anything else, including a shadow whose colour cannot be known for
 * certain, is left exactly as printed.
 */
export function rewriteMaskedShadows(doc: PDFDocument, page: PDFPage): number {
  const resources = page.node.Resources();
  const contents = page.node.get(PDFName.of("Contents"));
  if (!resources || !(contents instanceof PDFRef)) return 0;

  let rewritten = 0;
  const visited = new Set<PDFRef>();
  const pending: { ref: PDFRef; resources: PDFDict; fill: Fill }[] = [
    // A page starts with a black fill (DeviceGray 0).
    { ref: contents, resources, fill: [0, 0, 0] },
  ];
  for (let item = pending.pop(); item; item = pending.pop()) {
    if (visited.has(item.ref)) continue;
    visited.add(item.ref);
    const stream = doc.context.lookup(item.ref);
    if (!(stream instanceof PDFRawStream)) continue;
    rewritten += rewriteStream(doc, item.ref, stream, item.resources, item.fill);
    // Forms (opacity and blend groups) hold shadows of their own. They
    // inherit the fill colour of wherever they are drawn, so it is unknown.
    for (const form of formsIn(doc, item.resources)) {
      pending.push({ ref: form.ref, resources: form.resources, fill: null });
    }
  }
  return rewritten;
}

type Fill = [number, number, number] | null;

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const RG_LINE = new RegExp(`^(${NUMBER}) (${NUMBER}) (${NUMBER}) RG (${NUMBER}) (${NUMBER}) (${NUMBER}) rg$`);
const RECT_LINE = new RegExp(`^(${NUMBER}) (${NUMBER}) (${NUMBER}) (${NUMBER}) re$`);
const GS_LINE = /^\/(\S+) gs$/;
/** Operators that set the fill colour to something this module does not read. */
const OTHER_FILL_OPERATORS = new Set(["rg", "g", "k", "sc", "scn", "cs"]);

function rewriteStream(doc: PDFDocument, ref: PDFRef, stream: PDFRawStream, resources: PDFDict, initialFill: Fill): number {
  let text: string;
  try {
    text = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
  } catch {
    return 0;
  }
  const lines = text.split("\n");
  // Inline image data can hold any bytes, newlines included.
  if (lines.some((line) => line === "BI" || line.startsWith("BI "))) return 0;

  const masks = new Map<string, ShadowMask | null>();
  const maskFor = (name: string) => {
    if (!masks.has(name)) masks.set(name, readShadowMask(doc, resources, name));
    return masks.get(name)!;
  };

  const replacements: { at: number; mask: ShadowMask; fill: [number, number, number] }[] = [];
  const stack: Fill[] = [];
  let fill: Fill = initialFill;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const rg = line.match(RG_LINE);
    if (rg) {
      fill = [Number(rg[4]), Number(rg[5]), Number(rg[6])];
      continue;
    }
    if (line === "q") {
      stack.push(fill);
      continue;
    }
    if (line === "Q") {
      fill = stack.length > 0 ? stack.pop()! : null;
      continue;
    }
    const gs = line.match(GS_LINE);
    if (gs) {
      const mask = maskFor(gs[1]);
      if (mask && fill && isMaskedFill(lines, i, mask, resources, doc)) {
        replacements.push({ at: i, mask, fill });
        i += 2;
      }
      continue;
    }
    // Any other way of setting the fill colour, or a q or Q this reading
    // does not follow, makes the colour unknown.
    const tokens = line.trim().split(/\s+/);
    if (tokens.some((t) => OTHER_FILL_OPERATORS.has(t) || t === "q" || t === "Q")) fill = null;
  }
  if (replacements.length === 0) return 0;

  const xobjects = xobjectDict(doc, resources);
  const images = new Map<string, string>();
  for (const { at, mask, fill: colour } of replacements.reverse()) {
    const rgb = colour.map((c) => Math.min(255, Math.max(0, Math.round(c * 255))));
    const key = `${mask.image.toString()} ${rgb.join(" ")}`;
    let name = images.get(key);
    if (!name) {
      name = unusedName(xobjects, "CBShadow");
      const pixel = doc.context.stream(new Uint8Array(rgb), {
        Type: "XObject",
        Subtype: "Image",
        Width: 1,
        Height: 1,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
        SMask: mask.image,
      });
      xobjects.set(PDFName.of(name), doc.context.register(pixel));
      images.set(key, name);
    }
    // `/Mask gs`, `re`, `f` become the image drawn where the mask placed it;
    // the line after them, which removes the mask again, stays.
    lines.splice(at, 3, "q", `${mask.matrix} cm`, `/${name} Do`, "Q");
  }

  const dict = stream.dict.clone(doc.context);
  for (const key of ["Filter", "DecodeParms", "Length", "DL"]) dict.delete(PDFName.of(key));
  const updated = doc.context.flateStream(Buffer.from(lines.join("\n"), "latin1"));
  for (const [key, value] of dict.entries()) updated.dict.set(key, value);
  doc.context.assign(ref, updated);
  return replacements.length;
}

interface ShadowMask {
  /** The blur image, used as the replacement image's soft mask. */
  image: PDFRef;
  /** The matrix that places the image, "a 0 0 d e f". */
  matrix: string;
  /** The rectangle the image covers, as the fill's `re` operands. */
  rect: [number, number, number, number];
}

/**
 * The ExtGState `name`, when it is exactly Chromium's shadow mask: a
 * luminosity soft mask and nothing else, whose group draws one 8-bit grey
 * image with no transparency of its own at full opacity over exactly its
 * bounding box.
 */
function readShadowMask(doc: PDFDocument, resources: PDFDict, name: string): ShadowMask | null {
  try {
    const gs = resources.lookup(PDFName.of("ExtGState"), PDFDict).lookup(PDFName.of(name));
    if (!(gs instanceof PDFDict) || !hasOnlyKeys(gs, ["Type", "SMask"])) return null;
    const smask = gs.lookup(PDFName.of("SMask"));
    if (!(smask instanceof PDFDict) || !hasOnlyKeys(smask, ["Type", "S", "G"])) return null;
    if (smask.get(PDFName.of("S")) !== PDFName.of("Luminosity")) return null;
    const form = smask.lookup(PDFName.of("G"));
    if (!(form instanceof PDFRawStream)) return null;

    const content = Buffer.from(decodePDFRawStream(form).decode()).toString("latin1");
    const m = content.match(
      new RegExp(`^q\\n(${NUMBER}) 0 0 (${NUMBER}) (${NUMBER}) (${NUMBER}) cm\\n0 0 0 RG 0 0 0 rg\\n(?:/(\\S+) gs\\n)?/(\\S+) Do\\nQ\\n?$`)
    );
    if (!m) return null;
    const [a, d, e, f] = [m[1], m[2], m[3], m[4]].map(Number);
    if (!(a > 0 && d < 0)) return null;

    const formResources = form.dict.lookup(PDFName.of("Resources"));
    if (!(formResources instanceof PDFDict)) return null;
    if (m[5] && !isPlainOpaqueState(formResources, m[5])) return null;
    const xobjects = formResources.lookup(PDFName.of("XObject"));
    if (!(xobjects instanceof PDFDict) || xobjects.entries().length !== 1) return null;
    const imageRef = xobjects.get(PDFName.of(m[6]));
    if (!(imageRef instanceof PDFRef)) return null;
    const image = doc.context.lookup(imageRef);
    if (!(image instanceof PDFStream) || !isGreyImage(image.dict)) return null;

    const bbox = form.dict.lookup(PDFName.of("BBox"));
    const rect: [number, number, number, number] = [e, f + d, a, -d];
    if (!(bbox instanceof PDFArray) || !sameNumbers(numbers(bbox), [e, f + d, e + a, f])) return null;
    return { image: imageRef, matrix: `${m[1]} 0 0 ${m[2]} ${m[3]} ${m[4]}`, rect };
  } catch {
    return null;
  }
}

/**
 * Whether lines `at` to `at + 3` are the mask, then a fill of exactly the
 * mask's rectangle, then a graphics state that removes the mask again.
 */
function isMaskedFill(lines: string[], at: number, mask: ShadowMask, resources: PDFDict, doc: PDFDocument): boolean {
  const rect = lines[at + 1]?.match(RECT_LINE);
  if (!rect || !sameNumbers(rect.slice(1, 5).map(Number), mask.rect)) return false;
  if (lines[at + 2] !== "f" && lines[at + 2] !== "f*") return false;
  const reset = lines[at + 3]?.match(GS_LINE);
  if (!reset) return false;
  try {
    const gs = resources.lookup(PDFName.of("ExtGState"), PDFDict).lookup(PDFName.of(reset[1]));
    return gs instanceof PDFDict && doc.context.lookup(gs.get(PDFName.of("SMask"))) === PDFName.of("None");
  } catch {
    return false;
  }
}

/** An 8-bit DeviceGray image with no transparency or decoding of its own. */
function isGreyImage(dict: PDFDict): boolean {
  if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) return false;
  if (dict.get(PDFName.of("ColorSpace")) !== PDFName.of("DeviceGray")) return false;
  const bits = dict.get(PDFName.of("BitsPerComponent"));
  if (!(bits instanceof PDFNumber) || bits.asNumber() !== 8) return false;
  for (const key of ["SMask", "Mask", "ImageMask", "SMaskInData", "Intent"]) {
    if (dict.has(PDFName.of(key))) return false;
  }
  const decode = dict.get(PDFName.of("Decode"));
  return decode === undefined || (decode instanceof PDFArray && sameNumbers(numbers(decode), [0, 1]));
}

/** An ExtGState that draws at full opacity in normal blending, and nothing else. */
function isPlainOpaqueState(resources: PDFDict, name: string): boolean {
  const gs = resources.lookup(PDFName.of("ExtGState"), PDFDict).lookup(PDFName.of(name));
  if (!(gs instanceof PDFDict) || !hasOnlyKeys(gs, ["Type", "BM", "ca", "CA"])) return false;
  const bm = gs.get(PDFName.of("BM"));
  const ca = gs.get(PDFName.of("ca"));
  return (bm === undefined || bm === PDFName.of("Normal")) && (ca === undefined || (ca instanceof PDFNumber && ca.asNumber() === 1));
}

function formsIn(doc: PDFDocument, resources: PDFDict): { ref: PDFRef; resources: PDFDict }[] {
  const xobjects = resources.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return [];
  const forms: { ref: PDFRef; resources: PDFDict }[] = [];
  for (const [, value] of xobjects.entries()) {
    if (!(value instanceof PDFRef)) continue;
    const stream = doc.context.lookup(value);
    if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of("Subtype")) !== PDFName.of("Form")) continue;
    const formResources = stream.dict.lookup(PDFName.of("Resources"));
    if (formResources instanceof PDFDict) forms.push({ ref: value, resources: formResources });
  }
  return forms;
}

function xobjectDict(doc: PDFDocument, resources: PDFDict): PDFDict {
  const existing = resources.lookup(PDFName.of("XObject"));
  if (existing instanceof PDFDict) return existing;
  const created = doc.context.obj({});
  resources.set(PDFName.of("XObject"), created);
  return created;
}

function unusedName(dict: PDFDict, prefix: string): string {
  for (let n = 0; ; n++) {
    if (!dict.has(PDFName.of(`${prefix}${n}`))) return `${prefix}${n}`;
  }
}

function hasOnlyKeys(dict: PDFDict, allowed: string[]): boolean {
  return dict.keys().every((key) => allowed.includes(key.decodeText()));
}

function numbers(array: PDFArray): number[] {
  return array.asArray().map((item) => (item instanceof PDFNumber ? item.asNumber() : NaN));
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) < 1e-6);
}
