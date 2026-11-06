/**
 * EXIF Orientation for synthetic images, written byte by byte so tests need
 * no exiftool: an APP1 segment for JPEG and an eXIf chunk for PNG, each with
 * a TIFF header and one IFD0 entry, Orientation (0x0112, SHORT).
 */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** A TIFF structure holding only the Orientation tag, big-endian (Motorola) or little-endian (Intel). */
export function exifTiff(orientation: ExifOrientation, order: "MM" | "II" = "MM"): Buffer {
  const tiff = Buffer.alloc(26);
  const le = order === "II";
  const u16 = (value: number, at: number) => (le ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
  const u32 = (value: number, at: number) => (le ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
  tiff.write(order, 0, "latin1");
  u16(42, 2);
  u32(8, 4); // IFD0 right after the header
  u16(1, 8); // one entry
  u16(0x0112, 10); // Orientation
  u16(3, 12); // SHORT
  u32(1, 14); // one value
  u16(orientation, 18); // the value, left-justified in the four-byte field
  u32(0, 22); // no next IFD
  return tiff;
}

/** A JPEG with an EXIF APP1 segment inserted right after its SOI marker. */
export function jpegWithOrientation(jpeg: Buffer, orientation: ExifOrientation, order: "MM" | "II" = "MM"): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exifTiff(orientation, order)]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, body, jpeg.subarray(2)]);
}

/** PNG's CRC-32 (ISO 3309), written out because `zlib.crc32` needs Node 20.15 or newer. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A PNG with an eXIf chunk inserted right after its IHDR chunk. */
export function pngWithOrientation(png: Buffer, orientation: ExifOrientation): Buffer {
  const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4;
  if (png.subarray(12, 16).toString("latin1") !== "IHDR") throw new Error("not a PNG");
  const data = exifTiff(orientation);
  const type = Buffer.from("eXIf", "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, ihdrEnd), length, type, data, crc, png.subarray(ihdrEnd)]);
}
