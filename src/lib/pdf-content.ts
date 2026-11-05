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
}

/**
 * The operators of a content stream, in order. Strings, names, numbers, arrays
 * and dictionaries are skipped as operands, so an operator spelled inside a
 * string (`(Tj) Tj`) is never mistaken for one.
 */
function* operators(content: string): Generator<Operator> {
  let i = 0;
  let name: string | null = null;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (isSpace(ch)) {
      i++;
    } else if (ch === "%") {
      while (i < n && content[i] !== "\n" && content[i] !== "\r") i++;
    } else if (ch === "(") {
      let depth = 0;
      for (; i < n; i++) {
        const c = content[i];
        if (c === "\\") i++;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) break;
      }
      i++;
    } else if (ch === "<") {
      if (content[i + 1] === "<") i += 2;
      else {
        const end = content.indexOf(">", i);
        i = end === -1 ? n : end + 1;
      }
    } else if (ch === ">" || ch === "[" || ch === "]" || ch === "{" || ch === "}" || ch === ")") {
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
      yield { op: token, name };
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

function inspect(
  doc: PDFDocument,
  content: string,
  resources: PDFDict | undefined,
  result: PdfPageContent,
  visiting: Set<string>
): void {
  const xObjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  for (const { op, name } of operators(content)) {
    if (TEXT_SHOWS.has(op)) result.textShows++;
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
        if (visiting.has(key)) continue;
        visiting.add(key);
        const own = stream.dict.lookupMaybe(PDFName.of("Resources"), PDFDict);
        inspect(doc, decode(stream), own ?? resources, result, visiting);
        visiting.delete(key);
      }
    }
  }
}

/** Reads what one page of a loaded document draws. */
export function inspectPdfPage(doc: PDFDocument, page: PDFPage): PdfPageContent {
  const result: PdfPageContent = { textShows: 0, pathPaints: 0, images: [] };
  inspect(doc, contentOf(doc, page.node.Contents()), page.node.Resources(), result, new Set());
  return result;
}

/** What each page of a PDF draws, in page order. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfPageContent[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => inspectPdfPage(doc, page));
}
