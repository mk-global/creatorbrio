/**
 * PNG handling for the overlay stream (#144).
 *
 * The overlay frames reach FFmpeg as one `image2pipe` PNG stream, and FFmpeg
 * rebuilds its whole filter graph when the pixel format changes mid-stream,
 * which would reset the timeline's trims and pads. Chromium writes a fully
 * opaque screenshot as RGB (colour type 2) and any other as RGBA (colour
 * type 6), so every frame is brought to one shape before it is written:
 * 8-bit RGBA, not interlaced, canvas-sized, with only IHDR, IDAT and IEND
 * chunks, which is exactly what Chromium writes for a frame with
 * transparency. Anything else is refused rather than passed on.
 */
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOUR_RGB = 2;
const COLOUR_RGBA = 6;

export class PngShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngShapeError";
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGBA PNG from rows that are already PNG-filtered (each prefixed with its filter byte). */
function encodeRgba(width: number, height: number, filteredRows: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = COLOUR_RGBA;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(filteredRows, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A fully transparent RGBA PNG of the given size. */
export function transparentPng(width: number, height: number): Buffer {
  return encodeRgba(width, height, Buffer.alloc((width * 4 + 1) * height));
}

interface Parsed {
  width: number;
  height: number;
  colourType: number;
  idat: Buffer;
}

function parse(png: Buffer): Parsed {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) throw new PngShapeError("an overlay frame is not a PNG");
  let offset = 8;
  let header: Buffer | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset + 12 <= png.length && !ended) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new PngShapeError("an overlay frame is truncated");
    if (type === "IHDR") header = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") ended = true;
    else throw new PngShapeError(`an overlay frame has an unexpected ${type.replace(/[^A-Za-z]/g, "?")} chunk`);
    offset += 12 + length;
  }
  if (!header || header.length !== 13 || idat.length === 0 || !ended) throw new PngShapeError("an overlay frame is not a complete PNG");
  const [depth, colourType, compression, filter, interlace] = [header[8], header[9], header[10], header[11], header[12]];
  if (depth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0 || (colourType !== COLOUR_RGB && colourType !== COLOUR_RGBA)) {
    throw new PngShapeError(`an overlay frame has an unsupported PNG format (depth ${depth}, colour type ${colourType}, interlace ${interlace})`);
  }
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4), colourType, idat: Buffer.concat(idat) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses PNG row filtering, giving the raw pixel rows without filter bytes. */
function unfilter(data: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  if (data.length !== (stride + 1) * height) throw new PngShapeError("an overlay frame's pixel data has the wrong length");
  const out = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const type = data[p++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[p++];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      let value: number;
      if (type === 0) value = raw;
      else if (type === 1) value = raw + a;
      else if (type === 2) value = raw + b;
      else if (type === 3) value = raw + ((a + b) >> 1);
      else if (type === 4) value = raw + paeth(a, b, x >= bpp && y > 0 ? out[prev + x - bpp] : 0);
      else throw new PngShapeError(`an overlay frame uses unknown PNG filter ${type}`);
      out[row + x] = value & 0xff;
    }
  }
  return out;
}

/**
 * Checks a screenshot is a canvas-sized 8-bit PNG and returns it as RGBA:
 * an RGBA frame unchanged, an RGB one re-encoded with an opaque alpha
 * channel. Throws PngShapeError for anything else.
 */
export function toRgbaPng(png: Buffer, width: number, height: number): Buffer {
  const parsed = parse(png);
  if (parsed.width !== width || parsed.height !== height) {
    throw new PngShapeError(`an overlay frame is ${parsed.width}x${parsed.height}, not the canvas's ${width}x${height}`);
  }
  if (parsed.colourType === COLOUR_RGBA) return png;
  const rgb = unfilter(inflateSync(parsed.idat), width, height, 3);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  let i = 0;
  for (let y = 0; y < height; y++) {
    rows[o++] = 0;
    for (let x = 0; x < width; x++) {
      rows[o++] = rgb[i++];
      rows[o++] = rgb[i++];
      rows[o++] = rgb[i++];
      rows[o++] = 255;
    }
  }
  return encodeRgba(width, height, rows);
}
