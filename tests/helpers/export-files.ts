import { inflateRawSync, inflateSync } from "node:zlib";
import sharp from "sharp";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";

/** A solid-colour PNG with a distinct block in one corner, at an exact size. */
export async function syntheticSlidePng(
  width: number,
  height: number,
  background: { r: number; g: number; b: number },
  marker: { r: number; g: number; b: number } = { r: 255, g: 255, b: 255 }
): Promise<Buffer> {
  const block = await sharp({
    create: { width: 120, height: 80, channels: 3, background: marker },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background } })
    .composite([{ input: block, left: 40, top: 40 }])
    .png()
    .toBuffer();
}

/**
 * A PNG whose every pixel differs from its neighbours, standing in for text
 * edges, gradients and photographs. Deterministic for a given seed.
 */
export async function detailedSlidePng(
  width: number,
  height: number,
  seed: number
): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < pixels.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[i] = state & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** Decodes a PNG to tightly packed 8-bit RGB. */
export async function rgbPixels(png: Buffer): Promise<Buffer> {
  return sharp(png).removeAlpha().toColourspace("srgb").raw().toBuffer();
}

export interface PdfPageContents {
  /** MediaBox width and height, in points. */
  width: number;
  height: number;
  /** MediaBox lower-left corner, CropBox and /Rotate, which also decide what a reader shows. */
  mediaBoxOrigin: { x: number; y: number };
  cropBox: { x: number; y: number; width: number; height: number };
  rotation: number;
  /** The decoded page content stream, e.g. `q 810 0 0 1012.5 0 0 cm /Image-1 Do Q`. */
  operators: string;
  images: {
    width: number;
    height: number;
    colorSpace: string;
    bitsPerComponent: number;
    hasSoftMask: boolean;
    /** Decoded samples: 8-bit RGB, row-major, top row first. */
    pixels: Buffer;
  }[];
}

/**
 * Reads a PDF back with pdf-lib and returns each page's geometry, drawing
 * operators and the exact pixels of the images it draws.
 */
export async function readPdfPages(bytes: Uint8Array): Promise<PdfPageContents[]> {
  const doc = await PDFDocument.load(bytes);

  return doc.getPages().map((page) => {
    const { x, y, width, height } = page.getMediaBox();

    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref))
        : [contents];
    const operators = streams
      .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
      .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1"))
      .join("\n");

    const xObjects = page.node
      .Resources()
      ?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    const images = (xObjects?.entries() ?? []).map(([, ref]) => {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) {
        throw new Error("Page XObject is not a stream");
      }
      const dict = stream.dict;
      const num = (key: string) =>
        dict.lookup(PDFName.of(key), PDFNumber).asNumber();
      return {
        width: num("Width"),
        height: num("Height"),
        colorSpace: String(dict.lookup(PDFName.of("ColorSpace"))),
        bitsPerComponent: num("BitsPerComponent"),
        hasSoftMask: dict.has(PDFName.of("SMask")),
        pixels: inflateSync(Buffer.from(stream.contents)),
      };
    });

    return {
      width,
      height,
      mediaBoxOrigin: { x, y },
      cropBox: page.getCropBox(),
      rotation: page.getRotation().angle,
      operators,
      images,
    };
  });
}

/**
 * Lists a ZIP's entries in archive order by reading its central directory.
 * Enough for the stored and deflated entries archiver writes.
 */
export function readZipEntries(zip: Buffer): { name: string; data: Buffer }[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("Not a ZIP file: no end of central directory");
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  const entries: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Corrupt ZIP central directory");
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);

    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);

    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * The page size Chromium prints a slide at: CSS pixels at 72/96 pt, with the
 * paper rounded up to the next hundredth of an inch, as Chromium does (a 4:5
 * slide, 1012.5 pt tall, prints 1013.04 pt tall).
 */
export function chromiumPrintSize(width: number, height: number): [number, number] {
  const roundUp = (px: number) => (Math.ceil((px / 96) * 100 - 1e-9) / 100) * 72;
  return [roundUp(width), roundUp(height)];
}

/** `label` as the hex string pdf-lib writes for it in a `Tj` with a standard font. */
export function hexText(label: string): string {
  return `<${Buffer.from(label, "latin1").toString("hex").toUpperCase()}> Tj`;
}

/**
 * A one-page PDF shaped like Chromium's print of one slide: real text (the
 * label, top left), a vector rectangle and, optionally, an image, on a page of
 * the given size in points. Without a size it uses Chromium's rounded print
 * size for a slide of `slideWidth` x `slideHeight` pixels.
 */
export async function slidePdf(
  label: string,
  options: {
    slideWidth?: number;
    slideHeight?: number;
    size?: [number, number];
    pages?: number;
    png?: Buffer;
  } = {}
): Promise<Uint8Array> {
  const { StandardFonts, rgb } = await import("pdf-lib");
  const [width, height] =
    options.size ?? chromiumPrintSize(options.slideWidth ?? 1080, options.slideHeight ?? 1350);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < (options.pages ?? 1); p++) {
    const page = doc.addPage([width, height]);
    page.drawRectangle({ x: 40, y: 40, width: 200, height: 100, color: rgb(0.9, 0.3, 0.2) });
    page.drawText(label, { x: 40, y: height - 80, size: 36, font });
    if (options.png) {
      const image = await doc.embedPng(options.png);
      page.drawImage(image, { x: 300, y: 40, width: 200, height: 200 });
    }
  }
  return doc.save();
}
