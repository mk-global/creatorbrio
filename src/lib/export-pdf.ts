import { PDFDocument, PDFName } from "pdf-lib";
import { rewriteMaskedShadows } from "./pdf-shadows";
import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

/**
 * Slides are rendered in CSS pixels, which are defined at 96 per inch. PDF
 * pages are measured in points, 72 per inch. Scaling by 72/96 keeps every
 * aspect ratio exact (1080x1350 px -> 810x1012.5 pt, still 4:5) and gives the
 * page the physical size a browser would print the slide at.
 */
export const PDF_POINTS_PER_PIXEL = 72 / 96;

/**
 * LinkedIn's limits for document posts. The size limit is taken as decimal
 * megabytes, the stricter reading of "100 MB".
 */
export const LINKEDIN_MAX_PDF_BYTES = 100_000_000;
export const LINKEDIN_MAX_PDF_PAGES = 300;

/**
 * A PDF export failure whose message is safe to show the user as is.
 * `status` is the HTTP status the export route answers with.
 */
export class PdfExportError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "PdfExportError";
  }
}

/** The PDF page size, in points, for a carousel's aspect ratio. */
export function pdfPageSize(aspectRatio: AspectRatio): {
  width: number;
  height: number;
} {
  const { width, height } = DIMENSIONS[aspectRatio];
  return {
    width: width * PDF_POINTS_PER_PIXEL,
    height: height * PDF_POINTS_PER_PIXEL,
  };
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Chromium sizes the paper in hundredths of an inch, rounding up, so a printed
 * slide can come out up to 0.72 pt (0.01 in) larger than the slide in each
 * direction: a 4:5 slide, 14.0625 in tall, prints on a page 14.07 in tall
 * (1013.04 pt for 1012.5 pt). A page further off than that was not printed at
 * the slide's size, so it is refused rather than cropped or stretched.
 */
const MAX_PRINT_ROUNDING_PT = 0.75;

/**
 * Copying pages is synchronous work in pdf-lib. Handing the event loop back
 * between slides keeps a large export from stalling the rest of the server,
 * such as a chat response that is streaming at the same time.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The most a slide's own file structure (header, catalog, page tree, document
 * information, cross-reference table) could account for: merging drops it and
 * keeps everything else. Measured at about 300 bytes per Chromium-printed
 * slide; this allowance is over ten times that, so slides whose printed size
 * exceeds the limit by more than it cannot merge into a file within the limit.
 */
const MAX_STRUCTURE_BYTES_PER_SLIDE = 4096;

function tooLargeError(bytes: number, maxBytes: number, estimate: boolean): PdfExportError {
  return new PdfExportError(
    `The PDF ${estimate ? "would be over" : "is"} ${formatMegabytes(bytes)}, above LinkedIn's ${formatMegabytes(maxBytes)} limit. ` +
      "Remove slides or use simpler, smaller images, then export again.",
    422
  );
}

/**
 * Why a slide cannot be printed faithfully as a native PDF page. Each reason
 * names the CSS that causes it, so the user knows what to change.
 */
export type UnprintableSlideReason =
  | "filter"
  | "backdrop-filter"
  | "box-reflect"
  | "text-paint"
  | "gradient-text"
  | "mask"
  | "blend"
  | "backface"
  | "overflow"
  | "unreadable"
  | "page-size"
  | "missing-text"
  | "flattened";

/**
 * Raised by the slide renderer for one slide; `unprintableSlideError` turns it
 * into the message for the user once the slide's number is known.
 */
export class UnprintableSlideError extends Error {
  /**
   * @param characters For `missing-text`, a few of the characters the page
   *   would lose. They are slide content, so they go into the user's message
   *   only, never into this error's own message, which may be logged.
   */
  constructor(
    readonly reason: UnprintableSlideReason,
    readonly characters: readonly string[] = []
  ) {
    super(`Slide cannot be printed as text: ${reason}`);
    this.name = "UnprintableSlideError";
  }
}

/** How many of the missing characters a refusal quotes. */
const MAX_QUOTED_CHARACTERS = 5;

/**
 * The user-facing refusal for slide `slideNumber` (1-based). `characters`
 * are quoted for `missing-text`, so the user can find the text concerned.
 */
export function unprintableSlideError(
  slideNumber: number,
  reason: UnprintableSlideReason,
  characters: readonly string[] = []
): PdfExportError {
  const quoted = characters.slice(0, MAX_QUOTED_CHARACTERS).map((c) => `"${c}"`).join(", ");
  const advice = {
    filter:
      "applies a CSS filter to text, which a PDF can only store as a picture of that text, so it could not be selected or searched. " +
      "Ask the design agent to remove the filter from the text (a text-shadow is fine)",
    "backdrop-filter":
      "uses a frosted-glass effect (backdrop-filter), which PDF printing drops along with text and shapes drawn over it. " +
      "Ask the design agent to use a plain semi-transparent background instead",
    "gradient-text":
      "fills text with a gradient or image (background-clip: text), which PDF readers such as Apple Preview draw as a solid block. " +
      "Ask the design agent to use a solid text colour instead",
    "box-reflect":
      "reflects text (-webkit-box-reflect), which a PDF can only store as a picture of that text, so it could not be selected or searched. " +
      "Ask the design agent to remove the reflection",
    "text-paint":
      "draws text inside an SVG pattern or uses text as an SVG clip path, which a PDF stores as a picture or as a shape that readers such as Apple Preview draw wrongly. " +
      "Ask the design agent to use ordinary SVG or HTML text instead",
    mask:
      "uses a CSS or SVG mask, which PDF readers such as Apple Preview draw without its fade. " +
      "Ask the design agent to replace the mask with a gradient overlay or a plain shape",
    blend:
      "uses mix-blend-mode plus-lighter or plus-darker, which PDF has no equivalent for, so it would print as an ordinary overlay. " +
      "Ask the design agent to use another blend mode, such as screen or multiply",
    backface:
      "turns an element's back to the viewer (backface-visibility: hidden), which the screen hides but PDF printing shows, mirrored. " +
      "Ask the design agent to remove the hidden face or hide it with display: none",
    unreadable:
      "could not be checked before printing, because part of it is hidden from inspection (a closed shadow root, an unreadable frame, or nesting too deep or a check too slow to complete). " +
      "Ask the design agent to rebuild the slide as plain HTML inside the page body",
    overflow:
      "has content reaching past its edges that the PDF could not clip, so the page would come out shrunk. " +
      "Ask the design agent to keep everything inside the slide",
    "page-size":
      "did not print as a single page at the slide's size. " +
      "Ask the design agent to keep everything inside the slide and to remove any print page rules (@page)",
    "missing-text":
      `shows text that would not reach the PDF as text${quoted ? ` (such as ${quoted})` : ""}. ` +
      "Most often the slide's fonts do not cover those characters and they fall back to a system font that cannot be embedded, which leaves them out. " +
      "Ask the design agent to give that text a Google font that covers it (for Chinese, Noto Sans SC or Noto Serif SC)",
    flattened:
      "could only be printed as a picture, so its text could not be selected or searched. " +
      "Ask the design agent to simplify the slide's visual effects",
  }[reason];
  return new PdfExportError(
    `Slide ${slideNumber} ${advice}, then export the PDF again. The PNG export is not affected.`,
    422
  );
}

/**
 * Combines one-page slide PDFs, printed natively by Chromium, into one
 * document: one page per slide, in the order given.
 *
 * Pages are copied with their content streams, fonts and images as they are,
 * so text stays text and vector graphics stay vectors; nothing is re-rendered
 * or rasterised. Each page is checked to be exactly one page at the slide's
 * size, then trimmed to that size from its top-left corner, where Chromium
 * draws the slide, removing the sliver its paper-size rounding adds. Only the
 * page box changes; the content itself is copied byte for byte, apart from
 * the masked shadows `rewriteMaskedShadows` re-expresses.
 *
 * Annotations are left behind. Chromium turns every link in the slide into a
 * clickable area, and the slide HTML comes from the design agent: the preview
 * and the PNG have nothing to click, so the PDF must not either.
 */
export async function mergeSlidePdfs(
  slidePdfs: Uint8Array[],
  aspectRatio: AspectRatio,
  options: { title?: string; maxBytes?: number } = {}
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? LINKEDIN_MAX_PDF_BYTES;

  if (slidePdfs.length === 0) {
    throw new PdfExportError("There are no slides to put in the PDF.", 400);
  }
  if (slidePdfs.length > LINKEDIN_MAX_PDF_PAGES) {
    throw new PdfExportError(
      `LinkedIn accepts at most ${LINKEDIN_MAX_PDF_PAGES} pages in a document, and this carousel has ${slidePdfs.length} slides.`,
      422
    );
  }

  const printedBytes = slidePdfs.reduce((total, bytes) => total + bytes.length, 0);
  if (printedBytes - slidePdfs.length * MAX_STRUCTURE_BYTES_PER_SLIDE > maxBytes) {
    throw tooLargeError(printedBytes - slidePdfs.length * MAX_STRUCTURE_BYTES_PER_SLIDE, maxBytes, true);
  }

  const expected = pdfPageSize(aspectRatio);

  // pdf-lib would otherwise stamp itself as the producer when saving.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  if (options.title) pdf.setTitle(options.title);
  pdf.setCreator("CreatorBrio");
  pdf.setProducer("CreatorBrio");
  const now = new Date();
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);

  for (const [index, bytes] of slidePdfs.entries()) {
    const source = await PDFDocument.load(bytes);
    if (source.getPageCount() !== 1) {
      throw unprintableSlideError(index + 1, "page-size");
    }
    // Removed before copying, so the copy never pulls in the link actions.
    source.getPage(0).node.delete(PDFName.of("Annots"));
    rewriteMaskedShadows(source, source.getPage(0));
    const [page] = await pdf.copyPages(source, [0]);
    const box = page.getMediaBox();
    const extraWidth = box.width - expected.width;
    const extraHeight = box.height - expected.height;
    if (
      extraWidth < -0.01 ||
      extraHeight < -0.01 ||
      extraWidth > MAX_PRINT_ROUNDING_PT ||
      extraHeight > MAX_PRINT_ROUNDING_PT
    ) {
      throw unprintableSlideError(index + 1, "page-size");
    }
    // PDF y runs upwards, so the slide sits at the top of Chromium's paper:
    // the page box keeps that top edge and leaves the sliver below it. The
    // box moves rather than the drawing, because a translation of the drawing
    // would not move a pattern or shading painted in page space.
    const top = box.y + box.height;
    page.setMediaBox(box.x, top - expected.height, expected.width, expected.height);
    page.setCropBox(box.x, top - expected.height, expected.width, expected.height);
    pdf.addPage(page);
    await yieldToEventLoop();
  }

  // A classic cross-reference table instead of compressed object streams, for
  // the widest PDF reader compatibility.
  const bytes = await pdf.save({ useObjectStreams: false });

  if (bytes.length > maxBytes) throw tooLargeError(bytes.length, maxBytes, false);

  return bytes;
}
