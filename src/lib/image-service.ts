import { open } from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

/**
 * Client for the optional local image service, a separate program that is not
 * part of this repository. Its public contract: `POST /generate` on a loopback
 * address with a bearer token, a JSON body of `prompt` and `aspectRatio`, and
 * PNG bytes in reply; and, from service 1.1.0, `POST /edit`, which replaces
 * the background behind the one person in a photograph and returns every
 * opaque pixel of that person unchanged. This module is the single place that
 * holds the token, so it never reaches the design agent, the browser or the
 * logs.
 *
 * Error messages are user-facing and state only what happened; the creative
 * run decides what follows (a required image stops the run before design).
 */

/** Aspect ratios the image service accepts, with the exact size it returns. */
export const IMAGE_DIMENSIONS = {
  "1:1": { width: 1024, height: 1024 },
  "4:5": { width: 1024, height: 1280 },
  "9:16": { width: 864, height: 1536 },
  "16:9": { width: 1536, height: 864 },
} as const;

export type ImageAspectRatio = keyof typeof IMAGE_DIMENSIONS;

export const MAX_PROMPT_CHARS = 2000;
/** Longer than the service's own 120-second generation limit. */
export const GENERATION_TIMEOUT_MS = 150_000;
/** A 1536x864 PNG from the service is a few MiB; anything past this is wrong. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** The service's own limit on a decoded source PNG for `/edit`. */
export const MAX_EDIT_SOURCE_BYTES = 8 * 1024 * 1024;
/** The only edit the service performs; anything else is refused before a request is made. */
export const EDIT_OPERATIONS = ["replace_background"] as const;
export type EditOperation = (typeof EDIT_OPERATIONS)[number];

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8791";
// The service allows newline and tab; carriage return is refused here too.
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
// Admission reasons are a fixed vocabulary in the service contract.
const REASON_PATTERN = /^[a-z_]{1,64}$/;

export class ImageGenerationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: { reason?: string; retryAfterSeconds?: number } = {}
  ) {
    super(message);
  }
}

export interface ImageRequest {
  prompt: string;
  aspectRatio: ImageAspectRatio;
}

export interface EditRequest {
  operation: EditOperation;
  /** What the new background should be; the service decides everything about the person. */
  instruction: string;
  aspectRatio: ImageAspectRatio;
  /** The source, already prepared with `prepareEditSource` for this aspect ratio. */
  source: Buffer;
}

/**
 * A validated image: fully decoded, re-encoded as PNG without metadata, at
 * the exact size the aspect ratio requires. Where it is written is the
 * caller's decision; the creative pipeline stages it privately before it is
 * attached to a carousel.
 */
export interface GeneratedImage {
  png: Buffer;
  width: number;
  height: number;
}

/** Validates an untrusted body into the two fields the service accepts. */
export function parseImageRequest(body: unknown): ImageRequest {
  const input =
    body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT_CHARS || CONTROL_CHARS.test(prompt)) {
    throw new ImageGenerationError(
      400,
      "invalid_prompt",
      `prompt must be 1 to ${MAX_PROMPT_CHARS} characters with no control characters other than newline and tab`
    );
  }
  const aspectRatio = input.aspectRatio;
  if (typeof aspectRatio !== "string" || !(aspectRatio in IMAGE_DIMENSIONS)) {
    throw new ImageGenerationError(
      400,
      "invalid_aspect_ratio",
      `aspectRatio must be one of ${Object.keys(IMAGE_DIMENSIONS).join(", ")}`
    );
  }
  return { prompt, aspectRatio: aspectRatio as ImageAspectRatio };
}

const NOT_CONFIGURED = "Image generation is not set up on this machine.";
const TIMED_OUT = "Generating the image took too long and was stopped.";
const EDIT_TIMED_OUT = "Editing the image took too long and was stopped.";

/** The service is reached on loopback only, or the token could leave the machine. */
function serviceUrl(): URL {
  const url = new URL(process.env.IMAGE_SERVICE_URL || DEFAULT_SERVICE_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new ImageGenerationError(503, "image_service_not_configured", NOT_CONFIGURED);
  }
  return url;
}

/**
 * Reads the token at request time from an owner-only file. A file other users
 * could read is refused rather than used. The path keeps the product's former
 * name until the founder migrates the provisioned token (#29).
 */
async function readToken(): Promise<string> {
  const file = path.join(os.homedir(), ".config", "framewoven", "image-service.token");
  try {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      const owner = process.getuid?.();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (owner !== undefined && info.uid !== owner)) {
        throw new ImageGenerationError(503, "image_service_not_configured", NOT_CONFIGURED);
      }
      const token = (await handle.readFile("utf8")).trim();
      if (!TOKEN_PATTERN.test(token)) {
        throw new ImageGenerationError(503, "image_service_not_configured", NOT_CONFIGURED);
      }
      return token;
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err instanceof ImageGenerationError) throw err;
    throw new ImageGenerationError(503, "image_service_not_configured", NOT_CONFIGURED);
  }
}

/**
 * Whether image generation is set up for this account: a loopback service URL
 * and a valid owner-only token file. Makes no network call and never returns
 * the token, so it can describe the capability to a planner deterministically.
 * Whether the service is running is only known when a request is made.
 */
export async function imageGenerationConfigured(): Promise<boolean> {
  try {
    serviceUrl();
    await readToken();
    return true;
  } catch {
    return false;
  }
}

async function readCapped(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_IMAGE_BYTES) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function tooLarge() {
  return new ImageGenerationError(502, "image_generation_failed", "The image service returned an oversized response.");
}

function cancelled() {
  return new ImageGenerationError(499, "image_generation_cancelled", "Image generation was cancelled.");
}

function failed(message = "The image service did not return a usable image.") {
  return new ImageGenerationError(502, "image_generation_failed", message);
}

async function serviceError(response: Response, kind: "generate" | "edit"): Promise<ImageGenerationError> {
  let code = "";
  let reason: string | undefined;
  try {
    const body = JSON.parse((await readCapped(response)).toString("utf8"));
    code = typeof body?.error === "string" ? body.error : "";
    if (typeof body?.message === "string" && REASON_PATTERN.test(body.message)) reason = body.message;
  } catch {
    // An unreadable error body is reported by its status alone.
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;

  if (response.status === 503 && code === "busy") {
    return new ImageGenerationError(503, "image_service_busy",
      "The image service is generating another image.", { retryAfterSeconds });
  }
  if (response.status === 503 && code === "admission_refused") {
    return new ImageGenerationError(503, "image_generation_refused",
      "The image service declined to start because the machine is busy with other AI work.",
      { reason, retryAfterSeconds });
  }
  if (response.status === 401) {
    return new ImageGenerationError(503, "image_service_not_configured", NOT_CONFIGURED);
  }
  if (kind === "edit") return editError(response.status, code);
  if (response.status === 504) {
    return new ImageGenerationError(504, "image_generation_timeout",
      TIMED_OUT);
  }
  return failed();
}

/**
 * The service's editing refusals, each with what the user can do about it.
 * A photo without one clear person is the user's to change; a service that
 * predates editing (404) or has it turned off cannot edit any image.
 */
function editError(status: number, code: string): ImageGenerationError {
  if (status === 422 && code === "subject_not_found") {
    return new ImageGenerationError(422, "image_edit_no_subject",
      "No person could be found clearly enough in the photo to keep them exactly as they are. Use a photo where one person is clearly visible.");
  }
  if (status === 422 && code === "subject_ambiguous") {
    return new ImageGenerationError(422, "image_edit_ambiguous_subject",
      "The photo shows more than one person of similar size, so it is not clear whose background to replace. Use a photo with one main person.");
  }
  if (status === 404 || (status === 503 && code === "editing_unavailable")) {
    return new ImageGenerationError(503, "image_editing_unavailable", "Editing photos is not set up on the image service.");
  }
  if (status === 504) return new ImageGenerationError(504, "image_edit_timeout", EDIT_TIMED_OUT);
  if (status === 500 && code === "edit_misaligned") {
    return new ImageGenerationError(502, "image_edit_failed",
      "The edit moved the person, so it was discarded to keep them exactly as photographed.");
  }
  return new ImageGenerationError(502, "image_edit_failed", "The image service could not edit the photo.");
}

/**
 * Asks the image service for one image and returns it once validated.
 * Never returns bytes that did not pass every check; writes nothing.
 */
export async function generateImage(
  request: ImageRequest,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<GeneratedImage> {
  return requestImage("generate", { prompt: request.prompt, aspectRatio: request.aspectRatio }, request.aspectRatio, options);
}

/**
 * Asks the image service to replace the background of a prepared source and
 * returns the result once validated, under the same checks as a generated
 * image. Never falls back to generation: every refusal is an error.
 */
export async function editImage(
  request: EditRequest,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<GeneratedImage> {
  const instruction = request.instruction.trim();
  if (!(EDIT_OPERATIONS as readonly string[]).includes(request.operation)) {
    throw new ImageGenerationError(400, "invalid_edit", "That kind of edit is not supported.");
  }
  if (!instruction || instruction.length > MAX_PROMPT_CHARS || CONTROL_CHARS.test(instruction)) {
    throw new ImageGenerationError(400, "invalid_edit", "The edit instruction is not usable.");
  }
  const expected = IMAGE_DIMENSIONS[request.aspectRatio];
  if (request.source.length > MAX_EDIT_SOURCE_BYTES || !(await isPngOfSize(request.source, expected))) {
    throw new ImageGenerationError(400, "invalid_edit", "The photo could not be prepared for editing.");
  }
  return requestImage(
    "edit",
    { operation: request.operation, instruction, aspectRatio: request.aspectRatio, image: request.source.toString("base64") },
    request.aspectRatio,
    options
  );
}

/**
 * Prepares a stored image as an edit source for an aspect ratio: upright,
 * sRGB, opaque, and cropped to the preset's exact size around its most
 * salient region (normally the person), never stretched. The service does
 * not resize, because a frame of another shape makes its model re-render and
 * distort the person.
 */
export async function prepareEditSource(bytes: Buffer, aspectRatio: ImageAspectRatio): Promise<Buffer> {
  const { width, height } = IMAGE_DIMENSIONS[aspectRatio];
  try {
    return await sharp(bytes)
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize(width, height, { fit: "cover", position: sharp.strategy.attention })
      .toColorspace("srgb")
      .png()
      .toBuffer();
  } catch {
    throw new ImageGenerationError(400, "invalid_edit", "The photo could not be prepared for editing.");
  }
}

async function isPngOfSize(bytes: Buffer, expected: { width: number; height: number }): Promise<boolean> {
  try {
    const meta = await sharp(bytes).metadata();
    return meta.format === "png" && meta.width === expected.width && meta.height === expected.height;
  } catch {
    return false;
  }
}

async function requestImage(
  kind: "generate" | "edit",
  body: Record<string, string>,
  aspectRatio: ImageAspectRatio,
  { timeoutMs = GENERATION_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal }
): Promise<GeneratedImage> {
  const timedOut = () =>
    kind === "edit"
      ? new ImageGenerationError(504, "image_edit_timeout", EDIT_TIMED_OUT)
      : new ImageGenerationError(504, "image_generation_timeout", TIMED_OUT);
  if (signal?.aborted) throw cancelled();
  const url = new URL(`/${kind}`, serviceUrl());
  const token = await readToken();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    if (signal?.aborted) throw cancelled();
    if ((err as Error)?.name === "TimeoutError") throw timedOut();
    throw new ImageGenerationError(503, "image_service_unavailable",
      "The local image service is not running.");
  }

  if (response.status !== 200) throw await serviceError(response, kind);
  if (!(response.headers.get("content-type") ?? "").startsWith("image/png")) {
    await response.body?.cancel();
    throw failed();
  }

  let bytes: Buffer;
  try {
    bytes = await readCapped(response);
  } catch (err) {
    if (signal?.aborted) throw cancelled();
    if (err instanceof ImageGenerationError) throw err;
    if ((err as Error)?.name === "TimeoutError") throw timedOut();
    throw failed();
  }

  // Re-encoding decodes every pixel, so a truncated or corrupt file is refused
  // here rather than in the preview or the export. PNG is lossless, so this only
  // drops embedded metadata, as the upload route does; the size is unchanged.
  const expected = IMAGE_DIMENSIONS[aspectRatio];
  let png: Buffer;
  try {
    // sharp's default refuses any decoding warning, the strictest setting.
    const decoded = sharp(bytes);
    const meta = await decoded.metadata();
    if (meta.format !== "png" || meta.width !== expected.width || meta.height !== expected.height) {
      throw failed("The image service returned an image of the wrong size.");
    }
    png = await decoded.png().toBuffer();
  } catch (err) {
    if (err instanceof ImageGenerationError) throw err;
    throw failed();
  }

  return { png, width: expected.width, height: expected.height };
}
