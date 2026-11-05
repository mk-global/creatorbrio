import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  type PDFPage,
} from "pdf-lib";

/**
 * What a PDF page draws, read from its content streams: how it shows text,
 * paints vector paths and places images. Used to check that an exported page
 * holds real text rather than a picture of it.
 */
export interface PdfPageContent {
  /** Text-showing operators (`Tj`, `TJ`, `'`, `"`), including inside drawn forms. */
  textShows: number;
  /**
   * The text the page carries, as a reader would extract it: every shown
   * string decoded through its font's Unicode map, except inside marked
   * content with an `ActualText`, which replaces the text shown in it.
   * Chromium writes one for ligatures, synthesized small capitals and other
   * glyphs that do not map one to one. In content order. Spacing and layout are not
   * reconstructed: it answers which characters a reader can find, not where.
   * A font without a Unicode map contributes nothing (Chromium writes one for
   * every font it embeds).
   */
  text: string;
  /** Path-painting operators: fills, strokes and both. */
  pathPaints: number;
  /** Every image the page paints, with its size in pixels (0 when inline and unknown). */
  images: { width: number; height: number }[];
}

const TEXT_SHOWS = new Set(["Tj", "TJ", "'", '"']);
const PATH_PAINTS = new Set(["f", "F", "f*", "S", "s", "B", "B*", "b", "b*"]);
const DELIMITERS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\0";
}

interface Operator {
  op: string;
  /** The last name operand before the operator, such as the XObject `Do` paints. */
  name: string | null;
  /**
   * The string operands before the operator, as bytes in a latin1 string, each
   * with the name just before it: `null` in a `TJ` array, `ActualText` in a
   * marked-content dictionary.
   */
  strings: { key: string | null; bytes: string }[];
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

/** A literal string's bytes, from just after its `(`; returns them and the index after its `)`. */
function literalString(content: string, start: number): [string, number] {
  let out = "";
  let depth = 1;
  let i = start;
  while (i < content.length) {
    const c = content[i++];
    if (c === "\\") {
      const e = content[i++] ?? "";
      if (e in ESCAPES) out += ESCAPES[e];
      else if (/[0-7]/.test(e)) {
        let octal = e;
        while (octal.length < 3 && /[0-7]/.test(content[i] ?? "")) octal += content[i++];
        out += String.fromCharCode(parseInt(octal, 8) & 0xff);
      } else if (e === "\r") {
        if (content[i] === "\n") i++;
      } else if (e !== "\n") out += e;
    } else if (c === "(") {
      depth++;
      out += c;
    } else if (c === ")") {
      if (--depth === 0) break;
      out += c;
    } else out += c;
  }
  return [out, i];
}

/** A hex string's bytes; odd digit counts end in an implied 0, as the format says. */
function hexBytes(hex: string): string {
  const digits = hex.replace(/[^0-9a-fA-F]/g, "");
  const even = digits.length % 2 ? digits + "0" : digits;
  let out = "";
  for (let i = 0; i < even.length; i += 2) out += String.fromCharCode(parseInt(even.slice(i, i + 2), 16));
  return out;
}

/**
 * The operators of a content stream, in order. Strings, names, numbers, arrays
 * and dictionaries are read as operands, so an operator spelled inside a
 * string (`(Tj) Tj`) is never mistaken for one.
 */
function* operators(content: string): Generator<Operator> {
  let i = 0;
  let name: string | null = null;
  let strings: Operator["strings"] = [];
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (isSpace(ch)) {
      i++;
    } else if (ch === "%") {
      while (i < n && content[i] !== "\n" && content[i] !== "\r") i++;
    } else if (ch === "(") {
      const [bytes, next] = literalString(content, i + 1);
      strings.push({ key: name, bytes });
      i = next;
    } else if (ch === "<") {
      if (content[i + 1] === "<") i += 2;
      else {
        const end = content.indexOf(">", i);
        strings.push({ key: name, bytes: hexBytes(content.slice(i + 1, end === -1 ? n : end)) });
        i = end === -1 ? n : end + 1;
      }
    } else if (ch === "[") {
      // A TJ array's strings carry no key of their own.
      name = null;
      i++;
    } else if (ch === ">" || ch === "]" || ch === "{" || ch === "}" || ch === ")") {
      i++;
    } else if (ch === "/") {
      let j = i + 1;
      while (j < n && !isSpace(content[j]) && !DELIMITERS.has(content[j])) j++;
      name = content.slice(i + 1, j);
      i = j;
    } else {
      let j = i;
      while (j < n && !isSpace(content[j]) && !DELIMITERS.has(content[j])) j++;
      const token = content.slice(i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token) || token === "true" || token === "false" || token === "null") {
        continue;
      }
      if (token === "ID") {
        // Inline image data is binary and ends at the first EI on its own.
        const end = content.slice(i).search(/\sEI(?=\s|$)/);
        i = end === -1 ? n : i + end + 3;
      }
      yield { op: token, name, strings };
      strings = [];
    }
  }
}

function decode(stream: unknown): string {
  if (!(stream instanceof PDFRawStream)) return "";
  return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
}

function contentOf(doc: PDFDocument, contents: unknown): string {
  if (contents instanceof PDFArray) {
    return contents
      .asArray()
      .map((ref) => decode(doc.context.lookup(ref)))
      .join("\n");
  }
  return decode(contents instanceof PDFRef ? doc.context.lookup(contents) : contents);
}

/** Decodes a font's shown strings to text through its `ToUnicode` map. */
interface FontText {
  /** Bytes per character code: 2 for Chromium's CID fonts, 1 for its Type 3 fonts. */
  codeLength: number;
  unicode: Map<string, string>;
}

/** Upper bound on the codes one `bfrange` may expand to; a 2-byte font has 65,536 at most. */
const MAX_RANGE_CODES = 0x10000;

function utf16be(bytes: string): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  }
  return out;
}

/**
 * Reads a `ToUnicode` CMap: its `bfchar` entries and its `bfrange` entries,
 * both the incrementing and the array form. A map that cannot be read, or a
 * range larger than any font's codes, maps nothing, so its text counts as
 * missing rather than being guessed.
 */
export function parseToUnicode(cmap: string, defaultCodeLength: number): FontText {
  const unicode = new Map<string, string>();
  const space = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(cmap);
  const codeLength = space ? Math.ceil(space[1].length / 2) : defaultCodeLength;
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>/g)) {
      unicode.set(hexBytes(src), utf16be(hexBytes(dst)));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst, list] of block[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g
    )) {
      const first = parseInt(lo, 16);
      const last = parseInt(hi, 16);
      if (!(last >= first) || last - first >= MAX_RANGE_CODES) return { codeLength, unicode: new Map() };
      const code = (value: number) => hexBytes(value.toString(16).padStart(lo.length, "0"));
      if (list !== undefined) {
        const targets = [...list.matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => utf16be(hexBytes(m[1])));
        targets.slice(0, last - first + 1).forEach((target, k) => unicode.set(code(first + k), target));
      } else {
        // The destination's last unit counts up through the range.
        const base = utf16be(hexBytes(dst!));
        if (base === "") continue;
        const stem = base.slice(0, -1);
        const start = base.charCodeAt(base.length - 1);
        for (let k = 0; k <= last - first; k++) unicode.set(code(first + k), stem + String.fromCharCode(start + k));
      }
    }
  }
  return { codeLength, unicode };
}

function fontText(doc: PDFDocument, font: unknown, cache: Map<unknown, FontText | null>): FontText | null {
  if (cache.has(font)) return cache.get(font)!;
  const dict = font instanceof PDFRef ? doc.context.lookup(font) : font;
  let result: FontText | null = null;
  if (dict instanceof PDFDict) {
    const composite = dict.get(PDFName.of("Subtype")) === PDFName.of("Type0");
    const map = dict.get(PDFName.of("ToUnicode"));
    const stream = map instanceof PDFRef ? doc.context.lookup(map) : map;
    result = stream instanceof PDFRawStream ? parseToUnicode(decode(stream), composite ? 2 : 1) : null;
  }
  cache.set(font, result);
  return result;
}

function decodeShown(bytes: string, font: FontText | null): string {
  if (!font) return "";
  let out = "";
  for (let i = 0; i + font.codeLength <= bytes.length; i += font.codeLength) {
    out += font.unicode.get(bytes.slice(i, i + font.codeLength)) ?? "";
  }
  return out;
}

/** An `ActualText` value: UTF-16BE after a byte-order mark, else PDFDocEncoding (latin1 here). */
function textString(bytes: string): string {
  return bytes.startsWith("\xfe\xff") ? utf16be(bytes.slice(2)) : bytes;
}

interface Walk {
  doc: PDFDocument;
  result: PdfPageContent;
  visiting: Set<string>;
  fonts: Map<unknown, FontText | null>;
}

/**
 * @param replaced Whether the content is drawn inside an `ActualText` span,
 *   whose replacement text stands for everything shown in it.
 */
function inspect(
  walk: Walk,
  content: string,
  resources: PDFDict | undefined,
  initialFont: FontText | null,
  replaced: boolean
): void {
  const { doc, result } = walk;
  const xObjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  const fontResources = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
  // The font is part of the graphics state, so q and Q save and restore it.
  let font = initialFont;
  const saved: (FontText | null)[] = [];
  // One entry per open marked-content sequence: whether it carries ActualText.
  const spans: boolean[] = [];
  const inActualText = () => replaced || spans.includes(true);
  for (const { op, name, strings } of operators(content)) {
    if (TEXT_SHOWS.has(op)) {
      result.textShows++;
      const shown = op === "TJ" ? strings : strings.slice(-1);
      if (!inActualText()) for (const { bytes } of shown) result.text += decodeShown(bytes, font);
    } else if (op === "Tf") {
      font = name && fontResources ? fontText(doc, fontResources.get(PDFName.of(name)), walk.fonts) : null;
    } else if (op === "q") saved.push(font);
    else if (op === "Q") font = saved.pop() ?? font;
    else if (op === "BDC" || op === "BMC") {
      const actual = op === "BDC" ? strings.filter((s) => s.key === "ActualText") : [];
      // A span nested in another's replacement adds nothing of its own.
      if (!inActualText()) for (const { bytes } of actual) result.text += textString(bytes);
      spans.push(actual.length > 0);
    } else if (op === "EMC") spans.pop();
    else if (PATH_PAINTS.has(op)) result.pathPaints++;
    else if (op === "ID") result.images.push({ width: 0, height: 0 });
    else if (op === "Do" && name && xObjects) {
      const ref = xObjects.get(PDFName.of(name));
      const stream = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (!(stream instanceof PDFRawStream)) continue;
      const subtype = stream.dict.get(PDFName.of("Subtype"));
      if (subtype === PDFName.of("Image")) {
        const size = (key: string) =>
          stream.dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber() ?? 0;
        result.images.push({ width: size("Width"), height: size("Height") });
      } else if (subtype === PDFName.of("Form")) {
        // A form can be drawn more than once, but never from inside itself.
        const key = ref instanceof PDFRef ? ref.toString() : name;
        if (walk.visiting.has(key)) continue;
        walk.visiting.add(key);
        const own = stream.dict.lookupMaybe(PDFName.of("Resources"), PDFDict);
        inspect(walk, decode(stream), own ?? resources, font, inActualText());
        walk.visiting.delete(key);
      }
    }
  }
}

/** Reads what one page of a loaded document draws. */
export function inspectPdfPage(doc: PDFDocument, page: PDFPage): PdfPageContent {
  const result: PdfPageContent = { textShows: 0, text: "", pathPaints: 0, images: [] };
  const walk: Walk = { doc, result, visiting: new Set(), fonts: new Map() };
  inspect(walk, contentOf(doc, page.node.Contents()), page.node.Resources(), null, false);
  return result;
}

/** What each page of a PDF draws, in page order. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfPageContent[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => inspectPdfPage(doc, page));
}
