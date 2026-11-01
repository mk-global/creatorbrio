import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Carousel, ReferenceImage } from "@/types/carousel";

/**
 * Reference images are the only files whose paths the app hands to the design
 * agent, which opens them with its Read tool. Every such path is derived here,
 * by the server, from a URL in the one form the upload route produces for an
 * image: a random UUID with a `.png` extension directly under `/uploads/`.
 * A stored `absPath` is never trusted, because it was once taken from the
 * request that registered the reference.
 */
export const REFERENCE_URL_PATTERN =
  /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

/** The upload route's own limit; an upload larger than this cannot exist legitimately. */
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

export type ReferenceRejection =
  | "invalid_url"
  | "missing"
  | "not_regular_file"
  | "symlink"
  | "too_large"
  | "not_png";

export const REFERENCE_REJECTION_MESSAGES: Record<ReferenceRejection, string> = {
  invalid_url: "A reference image must be an uploaded image, given as its /uploads/<id>.png path.",
  missing: "That uploaded image does not exist.",
  not_regular_file: "That upload is not an image file.",
  symlink: "That upload is not an image file.",
  too_large: "That uploaded image is larger than the upload limit.",
  not_png: "That upload is not a readable PNG image.",
};

export type ConfinedUpload =
  | { ok: true; url: string; absPath: string }
  | { ok: false; reason: ReferenceRejection };

const uploadsDir = () => path.resolve(process.cwd(), "public", "uploads");

/**
 * Resolves an uploaded image URL to the absolute path of a regular PNG file
 * inside the real uploads directory, or says why it cannot be used.
 *
 * The file is opened without following a symbolic link and checked through
 * that open handle, so what is checked is what is read.
 */
export async function confineUploadedPng(url: unknown): Promise<ConfinedUpload> {
  if (typeof url !== "string" || !REFERENCE_URL_PATTERN.test(url)) {
    return { ok: false, reason: "invalid_url" };
  }

  let realUploads: string;
  try {
    realUploads = await realpath(uploadsDir());
  } catch {
    return { ok: false, reason: "missing" };
  }
  // The pattern admits no separator, dot segment or encoding, so the name is
  // a single path component and the path stays inside the real directory.
  const absPath = path.join(realUploads, path.basename(url));
  if (path.dirname(absPath) !== realUploads) {
    return { ok: false, reason: "invalid_url" };
  }

  let handle;
  try {
    // O_NONBLOCK keeps a FIFO planted under an upload's name from stalling the
    // open; the regular-file check below then refuses it.
    handle = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") return { ok: false, reason: "symlink" };
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "not_regular_file" };
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, reason: "not_regular_file" };
    if (stats.size > MAX_REFERENCE_BYTES) return { ok: false, reason: "too_large" };
    const bytes = await handle.readFile();
    try {
      // Decoding every pixel refuses a truncated or disguised file, not only a
      // wrong header.
      const image = sharp(bytes);
      const meta = await image.metadata();
      if (meta.format !== "png") return { ok: false, reason: "not_png" };
      await image.stats();
    } catch {
      return { ok: false, reason: "not_png" };
    }
  } finally {
    await handle.close();
  }

  return { ok: true, url, absPath };
}

const LOGGED_KEY = Symbol.for("creatorbrio.excluded-references");

/** Logs each excluded reference once per server process, by ID and reason only. */
function logExclusionOnce(carouselId: string, referenceId: string, reason: ReferenceRejection) {
  const store = globalThis as typeof globalThis & { [LOGGED_KEY]?: Set<string> };
  const logged = (store[LOGGED_KEY] ??= new Set<string>());
  const key = `${carouselId}:${referenceId}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.warn("[references] excluded a stored reference image", { carouselId, referenceId, reason });
}

/**
 * The carousel's reference images that still resolve to confined PNG uploads,
 * each with a path derived now. References that fail are left in storage,
 * never deleted, and are simply not offered to the agent.
 */
export async function resolveReferenceImages(carousel: Carousel): Promise<ReferenceImage[]> {
  const resolved: ReferenceImage[] = [];
  for (const ref of carousel.referenceImages ?? []) {
    const result = await confineUploadedPng(ref.url);
    if (result.ok) {
      resolved.push({ ...ref, absPath: result.absPath });
    } else {
      logExclusionOnce(carousel.id, ref.id, result.reason);
    }
  }
  return resolved;
}
