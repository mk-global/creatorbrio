/**
 * `/api/video/media`: the media registry over HTTP (WS2 slice, #140).
 *
 * | Operation                                   | Human | Agent |
 * |---------------------------------------------|-------|-------|
 * | list, read one record and its job           | yes   | no    |
 * | import a local file by absolute path        | yes   | no    |
 * | retry a failed derived-files job            | yes   | no    |
 * | GET/HEAD a derived file (proxy, poster, peaks) | yes, also from a media element | no |
 *
 * Importing reads a file from this computer, so it is a person's action only,
 * and the submitted path is never logged or stored (the record keeps the file
 * name). Derived files are served only after their job succeeded, with HTTP
 * Range support for media elements; originals are never served here.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { DERIVED_FILES, ImportFailure, type DerivedFile, type ImportFailureCode, type MediaRecord } from "../../media/registry";
import type { MediaJob } from "../../media/jobs";
import { authorize, run } from "./handlers";
import { errorResponse, HttpFailure, okResponse, readJsonObject, selectFields } from "./http";

const MEDIA_ID = /^[0-9a-f]{64}$/;

const IMPORT_STATUS: Record<ImportFailureCode, number> = {
  invalid_path: 400,
  not_found: 404,
  not_a_file: 400,
  inside_data_directory: 400,
  too_large: 413,
  unsupported_media: 415,
  tool_missing: 503,
};

function mediaId(raw: string): string {
  if (!MEDIA_ID.test(raw)) throw new HttpFailure(errorResponse(400, { code: "invalid_id", message: "media ids are SHA-256 digests in lowercase hex" }));
  return raw;
}

const notFound = () => new HttpFailure(errorResponse(404, { code: "media_not_found", message: "no media with this id" }));

/** What a client sees of a job: its state, never owners or local details. */
function jobView(job: MediaJob | null) {
  if (!job) return { state: "queued" as const, attempts: 0, files: [] };
  return {
    state: job.state,
    attempts: job.attempts,
    updatedAt: job.updatedAt,
    files: job.state === "succeeded" ? (job.output?.files ?? []) : [],
    ...(job.output ? { color: job.output.color } : {}),
    ...(job.failure ? { failure: job.failure } : {}),
  };
}

function mediaView(record: MediaRecord, job: MediaJob | null) {
  return {
    mediaId: record.mediaId,
    kind: record.kind,
    originalName: record.originalName,
    sizeBytes: record.sizeBytes,
    importedAt: record.importedAt,
    facts: record.facts,
    provenance: record.provenance,
    derived: jobView(job),
  };
}

export function listMedia(request: Request): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, null, { human: true });
    const records = await ctx.media.list();
    const media = await Promise.all(records.map(async (r) => mediaView(r, await ctx.jobs.read(r.mediaId))));
    return okResponse({ media });
  });
}

export function importMedia(request: Request): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, null, { human: true });
    const { path: source } = selectFields(await readJsonObject(request), ["path"]);
    try {
      const { record, created } = await ctx.media.importPath(source);
      console.info("[video media] imported", { mediaId: record.mediaId, kind: record.kind, created, sizeBytes: record.sizeBytes });
      return okResponse({ status: created ? "created" : "existing", media: mediaView(record, await ctx.jobs.read(record.mediaId)) }, created ? 201 : 200);
    } catch (error) {
      if (!(error instanceof ImportFailure)) throw error;
      console.info("[video media] import refused", { code: error.code });
      return errorResponse(IMPORT_STATUS[error.code], { code: error.code, message: error.message });
    }
  });
}

export function getMedia(request: Request, rawId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, null, { human: true });
    const record = await ctx.media.get(mediaId(rawId));
    if (!record) throw notFound();
    return okResponse(mediaView(record, await ctx.jobs.read(record.mediaId)));
  });
}

export function retryDerived(request: Request, rawId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, null, { human: true });
    const result = await ctx.jobs.retry(mediaId(rawId));
    if (result.ok) return okResponse({ status: "queued", derived: jobView(result.job) }, 202);
    if (result.code === "not_found") throw notFound();
    return errorResponse(409, { code: "job_not_failed", message: "only a failed job can be retried", derived: jobView(result.job ?? null) });
  });
}

type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/** One `bytes=` range; anything else (several ranges, other units, bad syntax) is served whole. */
export function parseRange(header: string | null, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** GET or HEAD of one derived file, with Range support. */
export function readDerived(request: Request, rawId: string, rawName: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, null, { human: true, mediaRead: true });
    const id = mediaId(rawId);
    if (!Object.prototype.hasOwnProperty.call(DERIVED_FILES, rawName)) {
      throw new HttpFailure(errorResponse(404, { code: "file_not_found", message: "no such derived file" }));
    }
    const name = rawName as DerivedFile;
    if (!(await ctx.media.get(id))) throw notFound();
    const job = await ctx.jobs.read(id);
    if (!job || job.state !== "succeeded" || !job.output?.files.includes(name)) {
      return errorResponse(409, { code: "not_ready", message: "this file is not available; see the media's derived state", derived: jobView(job) });
    }
    const file = ctx.media.derivedPath(id, name);
    const size = await stat(file).then(
      (s) => s.size,
      () => null
    );
    if (size === null) return errorResponse(409, { code: "not_ready", message: "this file is not available; see the media's derived state", derived: jobView(job) });
    const headers: Record<string, string> = {
      "content-type": DERIVED_FILES[name],
      "accept-ranges": "bytes",
      // Never cached: the browser's cache is shared by every port of this host, so a cached
      // copy would let a page on another port, or a navigation, read it without this check.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    };
    const range = parseRange(request.headers.get("range"), size);
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    const head = request.method.toUpperCase() === "HEAD";
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const length = size === 0 ? 0 : end - start + 1;
    const body = head || length === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: { ...headers, "content-length": String(length), ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) },
    });
  });
}
