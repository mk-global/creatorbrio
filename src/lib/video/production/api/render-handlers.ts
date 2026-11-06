/**
 * `/api/video/productions/[id]/renders`: render jobs over HTTP (#144).
 *
 * | Operation                                              | Person | Agent |
 * |--------------------------------------------------------|--------|-------|
 * | list a production's renders, read one                  | yes    | no    |
 * | request a render of the current revision               | yes    | no    |
 * | cancel a queued or running render, retry a failed or cancelled one | yes | no |
 * | GET/HEAD a succeeded render's file                     | yes; `video.mp4` also from a media element | no |
 *
 * A request compiles the current revision first and refuses it with 422
 * `render_refused` and the compiler's issues when it cannot be exported, so
 * the person learns at once; nothing is queued then. Otherwise the exact
 * document that compiled is snapshotted and queued (202), or the render
 * already queued or running for that revision and profile is returned (200,
 * `existing`). Files are served only once the render succeeded and passed
 * verification; a render that failed verification keeps its files on disk
 * for inspection but never serves them. Views never contain paths or owners.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { DEFAULT_CATALOG } from "../../capabilities/catalog";
import { compile } from "../../render/compile";
import { EXPORT_PROFILES, type ExportProfileId } from "../../render/profile";
import { RENDER_FILES, type RenderFileName, type RenderJob } from "../../render/render-record";
import { ID_PATTERN } from "../primitives";
import { authorize, run } from "./handlers";
import { errorResponse, failureResponse, HttpFailure, okResponse, readJsonObject, selectFields } from "./http";
import { parseRange } from "./media-handlers";

const DEFAULT_PROFILE: ExportProfileId = "instagram";

/** What a client sees of a render: its state and outcome, never owners or local details. */
export function renderView(job: RenderJob, cancelRequested = false) {
  return {
    renderId: job.renderId,
    productionId: job.productionId,
    revision: job.revision,
    profile: job.profileId,
    state: job.state,
    attempts: job.attempts,
    requestedAt: job.requestedAt,
    updatedAt: job.updatedAt,
    files: job.state === "succeeded" ? (job.outputs ?? []).map((o) => o.name) : [],
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.failure ? { failure: job.failure } : {}),
    ...(job.verification ? { verification: job.verification } : {}),
    ...(cancelRequested ? { cancelRequested: true } : {}),
  };
}

function renderId(raw: string): string {
  if (!ID_PATTERN.test(raw)) throw new HttpFailure(errorResponse(400, { code: "invalid_id", message: "render ids are short identifiers" }));
  return raw;
}

const notFound = () => new HttpFailure(errorResponse(404, { code: "render_not_found", message: "this production has no render with this id" }));

export function listRenders(request: Request, productionId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const renders = await ctx.renders.list(productionId);
    return okResponse({ renders: renders.map((job) => renderView(job, ctx.renders.cancelPending(job.renderId))) });
  });
}

export function requestRender(request: Request, productionId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const fields = selectFields(await readJsonObject(request), [], ["profile"]);
    const profileId = fields.profile ?? DEFAULT_PROFILE;
    if (typeof profileId !== "string" || !Object.prototype.hasOwnProperty.call(EXPORT_PROFILES, profileId)) {
      throw new HttpFailure(errorResponse(400, { code: "invalid_field", message: `profile must be one of: ${Object.keys(EXPORT_PROFILES).join(", ")}` }));
    }
    const profile = EXPORT_PROFILES[profileId as ExportProfileId];

    const loaded = await ctx.store.load(productionId);
    if (loaded.status !== "ok") return failureResponse(loaded);
    const production = loaded.state.history.current;
    // The same inputs the render pipeline compiles the snapshot against.
    const media = new Map((await ctx.media.list()).map((record) => [record.mediaId, record]));
    const compiled = compile(production, media, { profile, catalog: DEFAULT_CATALOG });
    if (!compiled.ok) {
      console.info("[video render] render_refused", { productionId, revision: production.revision, codes: [...new Set(compiled.issues.map((i) => i.code))] });
      return errorResponse(422, {
        code: "render_refused",
        message: "this revision cannot be exported; nothing was queued",
        revision: production.revision,
        issues: compiled.issues,
      });
    }
    const { created, job } = await ctx.renders.request(production, profile.id);
    return okResponse({ status: created ? "queued" : "existing", render: renderView(job, ctx.renders.cancelPending(job.renderId)) }, created ? 202 : 200);
  });
}

export function getRender(request: Request, productionId: string, rawRenderId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const job = await ctx.renders.read(productionId, renderId(rawRenderId));
    if (!job) throw notFound();
    return okResponse(renderView(job, ctx.renders.cancelPending(job.renderId)));
  });
}

/** Cancels a queued render at once (`cancelled`), or asks a running one to stop (`cancelling`, then `cancelled`). */
export function cancelRender(request: Request, productionId: string, rawRenderId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const result = await ctx.renders.cancel(productionId, renderId(rawRenderId));
    if (result.ok) return okResponse({ status: result.pending ? "cancelling" : "cancelled", render: renderView(result.job, result.pending) }, 202);
    if (result.code === "not_found") throw notFound();
    return errorResponse(409, {
      code: "not_cancellable",
      message: "only a queued render, or one running in this server, can be cancelled",
      render: result.job ? renderView(result.job) : null,
    });
  });
}

/** Queues a failed or cancelled render again from its snapshot, with its attempts reset. */
export function retryRender(request: Request, productionId: string, rawRenderId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const result = await ctx.renders.retry(productionId, renderId(rawRenderId));
    if (result.ok) return okResponse({ status: "queued", render: renderView(result.job) }, 202);
    if (result.code === "not_found") throw notFound();
    return errorResponse(409, { code: "not_retryable", message: "only a failed or cancelled render can be retried", render: result.job ? renderView(result.job) : null });
  });
}

/** GET or HEAD of one file of a succeeded render, as a download; `video.mp4` with Range support. */
export function readRenderFile(request: Request, productionId: string, rawRenderId: string, rawName: string): Promise<Response> {
  return run(async () => {
    // Only the video is ever loaded by a media element, so only it takes the media-element rule.
    const { ctx } = await authorize(request, productionId, { human: true, mediaRead: rawName === "video.mp4" });
    const id = renderId(rawRenderId);
    if (!Object.prototype.hasOwnProperty.call(RENDER_FILES, rawName)) {
      throw new HttpFailure(errorResponse(404, { code: "file_not_found", message: `renders have these files: ${Object.keys(RENDER_FILES).join(", ")}` }));
    }
    const name = rawName as RenderFileName;
    const job = await ctx.renders.read(productionId, id);
    if (!job) throw notFound();
    const notReady = () => errorResponse(409, { code: "not_ready", message: "this file is served once the render has succeeded; see the render's state", render: renderView(job) });
    if (job.state !== "succeeded" || !job.outputs?.some((o) => o.name === name)) return notReady();
    const file = ctx.renders.filePath(productionId, id, name);
    const size = await stat(file).then(
      (s) => s.size,
      () => null
    );
    if (size === null) return notReady();

    const ranged = name === "video.mp4";
    const headers: Record<string, string> = {
      "content-type": RENDER_FILES[name],
      // Never cached: the browser's cache is shared by every port of this host (see readDerived).
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // Both ids match ID_PATTERN, so the name is plain ASCII with nothing to escape.
      "content-disposition": `attachment; filename="${productionId}-${id}-${name}"`,
      ...(ranged ? { "accept-ranges": "bytes" } : {}),
    };
    const range = ranged ? parseRange(request.headers.get("range"), size) : null;
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
