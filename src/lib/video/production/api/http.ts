/**
 * Request parsing and response mapping for the Production API.
 *
 * Bodies are JSON only, bounded in size, and selected field by field: a body
 * may carry only the fields its endpoint lists. A field the server owns
 * (actor, run, ids, times, approvals) is refused by name, so a forged actor
 * fails loudly instead of being silently ignored.
 *
 * Every failure has a stable `code` and HTTP status, listed in
 * `docs/architecture/video-production-api.md`. Responses never contain file
 * paths, run tokens or the human key.
 */

import type { HistoryResult } from "../changes";
import type { LoadedProduction, MutationResult, StoreFailure } from "../store";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Fields that only the server sets. A request naming any of them is refused. */
export const SERVER_OWNED_FIELDS = new Set([
  "by",
  "actor",
  "role",
  "userId",
  "user",
  "runId",
  "agentRunId",
  "id",
  "at",
  "approved",
  "approval",
  "approvals",
  "human",
  "isHuman",
  "authority",
  "override",
  "force",
  "revision",
  "generation",
]);

export interface ApiError {
  code: string;
  message: string;
  [detail: string]: unknown;
}

export function errorResponse(status: number, error: ApiError, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function okResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export class HttpFailure extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super("http failure");
    this.response = response;
  }
}

const fail = (status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
  new HttpFailure(errorResponse(status, { code, message, ...details }));

/** Reads a JSON object body: JSON content type, at most `MAX_BODY_BYTES`, read incrementally so an oversized body is never held whole. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw fail(415, "unsupported_media_type", "send the body as application/json");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw fail(413, "body_too_large", `the body may be at most ${MAX_BODY_BYTES} bytes`);

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw fail(413, "body_too_large", `the body may be at most ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw fail(400, "invalid_json", "the body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw fail(400, "invalid_body", "the body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * Keeps exactly the listed fields. Server-owned fields and unknown fields are
 * refused; missing required fields are refused.
 */
export function selectFields(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const allowed = new Set([...required, ...optional]);
  const serverOwned = Object.keys(body).filter((k) => !allowed.has(k) && SERVER_OWNED_FIELDS.has(k));
  if (serverOwned.length > 0) {
    throw fail(400, "server_owned_field", "the server sets these fields from the caller's credential and its own state", { fields: serverOwned });
  }
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length > 0) throw fail(400, "unknown_field", "these fields are not part of this request", { fields: unknown });
  const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(body, k));
  if (missing.length > 0) throw fail(400, "missing_field", "these fields are required", { fields: missing });
  const picked: Record<string, unknown> = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(body, key)) picked[key] = body[key];
  return picked;
}

/** A whole, non-negative generation the caller confirms it has seen; required by destructive commands. */
export function confirmedGeneration(fields: Record<string, unknown>): number {
  const value = fields.expectedGeneration;
  if (value === undefined) {
    throw fail(428, "confirmation_required", "confirm the generation you are acting on: send expectedGeneration from your latest read");
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw fail(400, "invalid_field", "expectedGeneration must be a positive whole number");
  return value;
}

// ---------------------------------------------------------------------------
// Mapping results

type Failure = Exclude<MutationResult, { status: "applied" }> | StoreFailure;

/** Maps every non-applied result of the engine or the store to its stable HTTP form. */
export function failureResponse(result: Failure | (HistoryResult & { status: "conflict" | "rejected" })): Response {
  switch (result.status) {
    case "conflict":
      return errorResponse(409, { code: result.reason, message: result.message, expectedRevision: result.expectedRevision, actualRevision: result.actualRevision });
    case "rejected":
      return errorResponse(422, { code: "rejected", message: "the change was refused; nothing was written", stage: result.stage, issues: result.issues });
    case "not_found":
      return errorResponse(404, { code: "not_found", message: result.message });
    case "already_exists":
      return errorResponse(409, { code: "already_exists", message: result.message });
    case "invalid_request":
      return errorResponse(400, { code: "invalid_request", message: result.message });
    case "generation_mismatch":
      return errorResponse(409, { code: "generation_mismatch", message: result.message, expectedGeneration: result.expectedGeneration, actualGeneration: result.actualGeneration });
    case "recovery_required":
      return errorResponse(423, { code: "recovery_required", message: result.message, runId: result.runId, ownerAlive: result.ownerAlive });
    case "contended":
      return errorResponse(503, { code: "contended", message: result.message }, { "retry-after": "1" });
    case "corrupt":
      // The generation lets a person confirm an explicit recovery; the file path stays on the server.
      return errorResponse(500, { code: "production_corrupt", message: result.message, generation: result.generation });
    case "unsupported_version":
      return errorResponse(409, { code: "unsupported_version", message: result.message, generation: result.generation });
    case "io_error":
      console.error("[video api] storage error", { operation: result.operation, code: result.code });
      return errorResponse(500, { code: "storage_error", message: "the production could not be read or written" });
  }
}

// ---------------------------------------------------------------------------
// Serialising state

/** What a caller sees of a production: the document, history as revisions, labels and the run. Never documents of every step, owner process details or paths. */
export function productionView(state: LoadedProduction) {
  const h = state.history;
  const step = (s: (typeof h.undo)[number]) => ({ label: s.label, changeSetIds: s.changeSetIds, runId: s.runId, fromRevision: s.before.revision, toRevision: s.after.revision });
  return {
    productionId: state.productionId,
    generation: state.generation,
    revision: h.current.revision,
    production: h.current,
    history: {
      undo: h.undo.map(step),
      redo: h.redo.map(step),
      labels: Object.entries(h.labels).map(([name, l]) => ({ name, revision: l.revision })),
    },
    run: state.run && {
      runId: state.run.runId,
      scope: h.run?.scope ?? null,
      startedAt: state.run.startedAt,
      changeSetIds: state.run.changeSetIds,
      interrupted: state.recoveryRequired,
      ownerAlive: state.run.ownerAlive,
    },
    recoveryRequired: state.recoveryRequired,
  };
}
