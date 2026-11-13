import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { MAX_IMAGE_BYTES } from "./image-service";

/**
 * Serves files the app writes into `public/uploads/` while it runs: uploaded
 * images, generated images and uploaded fonts.
 *
 * A production server (`next start`) serves only the files that were in
 * `public/` when the app was built, so without this every image uploaded or
 * generated after that would be missing from the preview until a rebuild.
 * Files that existed at build time are still served by Next.js directly; this
 * handles the rest, and only in the exact shapes the app itself creates.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const SERVED: readonly { folder: string | null; name: RegExp; contentType: (name: string) => string }[] = [
  { folder: null, name: new RegExp(`^${UUID}\\.png$`), contentType: () => "image/png" },
  { folder: "fonts", name: new RegExp(`^${UUID}\\.(woff2|ttf)$`), contentType: (n) => (n.endsWith(".woff2") ? "font/woff2" : "font/ttf") },
];

/** Larger than any upload (10 MB) or generated image the app accepts. */
export const MAX_SERVED_UPLOAD_BYTES = MAX_IMAGE_BYTES;

/** The image type a file's own bytes say it is, by signature; null for anything else. */
export function imageTypeOf(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const starts = (signature: readonly number[], at = 0) => signature.every((byte, i) => bytes[at + i] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF, a four-byte size, then WEBP.
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export interface ServedUpload {
  bytes: Buffer;
  contentType: string;
}

/**
 * Reads one runtime-written upload by its path segments under `/uploads/`, or
 * returns null for anything that is not a regular file in one of the served
 * shapes inside the real uploads folder.
 */
export async function readUpload(segments: readonly string[]): Promise<ServedUpload | null> {
  const [folder, name] = segments.length === 1 ? [null, segments[0]] : segments.length === 2 ? segments : [undefined, undefined];
  if (name === undefined) return null;
  const rule = SERVED.find((r) => r.folder === folder && r.name.test(name));
  if (!rule) return null;

  let dir: string;
  try {
    const uploads = await realpath(path.resolve(process.cwd(), "public", "uploads"));
    dir = folder ? await realpath(path.join(uploads, folder)) : uploads;
    // A folder replaced by a link to somewhere else is refused.
    if (folder && dir !== path.join(uploads, folder)) return null;
  } catch {
    return null;
  }

  let handle;
  try {
    // O_NOFOLLOW refuses a link planted under an upload's name; O_NONBLOCK
    // keeps a FIFO from stalling the open, and the file check refuses it.
    handle = await open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_SERVED_UPLOAD_BYTES) return null;
    return { bytes: await handle.readFile(), contentType: rule.contentType(name) };
  } finally {
    await handle.close();
  }
}
