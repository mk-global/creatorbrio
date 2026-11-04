/**
 * The Production API (WS1 #120): thin handlers over `ProductionStore`.
 *
 * Each handler checks, in order: the loopback Host and Origin (the same check
 * `src/proxy.ts` applies, repeated here as defence in depth), the production
 * id, the caller's credential and whether that authority may perform the
 * operation, then the body. It then makes exactly one store call. The store
 * and the change-set engine decide every change and every revision check; no
 * handler edits a production itself.
 *
 * Who may do what:
 *
 * | Operation                     | Human | Agent (run token)        |
 * |-------------------------------|-------|--------------------------|
 * | list, read                    | yes   | read its own production  |
 * | create                        | yes   | no                       |
 * | change set                    | yes   | yes, as its run          |
 * | undo, redo                    | yes   | no                       |
 * | label, restore label          | yes   | no                       |
 * | begin run                     | yes   | no                       |
 * | run decision (keep, discard, resume) | yes | no                  |
 * | recover                       | yes   | no                       |
 *
 * Callers without a credential get 401 for everything.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";

import { checkApiRequest } from "@/lib/request-guard";
import { ID_PATTERN } from "../primitives";
import { ProductionStore, type MutationResult } from "../store";
import { AuthorityRegistry, type Authority } from "./authority";
import { confirmedGeneration, errorResponse, failureResponse, HttpFailure, okResponse, productionView, readJsonObject, selectFields } from "./http";

export interface ApiContext {
  store: ProductionStore;
  authority: AuthorityRegistry;
  now: () => string;
  newId: (prefix: string) => string;
}

const contexts: Map<string, ApiContext> = ((globalThis as { __creatorbrioProductionApi?: Map<string, ApiContext> }).__creatorbrioProductionApi ??= new Map<string, ApiContext>());

/**
 * One context per data directory, kept on `globalThis` so development reloads
 * reuse the same store instance and the same run tokens: an agent run belongs
 * to the store instance that began it.
 */
export function apiContext(dataDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data")): ApiContext {
  let context = contexts.get(dataDir);
  if (!context) {
    context = {
      store: new ProductionStore({ root: path.join(/*turbopackIgnore: true*/ dataDir, "video") }),
      authority: new AuthorityRegistry(path.join(/*turbopackIgnore: true*/ dataDir, "video-studio.key")),
      now: () => new Date().toISOString(),
      newId: (prefix) => `${prefix}-${randomBytes(8).toString("hex")}`,
    };
    contexts.set(dataDir, context);
  }
  return context;
}

type Allowed = { human?: true; agent?: true };

interface Call {
  ctx: ApiContext;
  authority: Exclude<Authority, { kind: "anonymous" }>;
  productionId: string;
}

/** The common checks before any handler body runs. */
async function authorize(request: Request, productionId: string | null, allowed: Allowed): Promise<Call> {
  const guard = checkApiRequest(request);
  if (guard !== "allow") throw new HttpFailure(errorResponse(403, { code: "request_refused", message: "Request refused" }));
  if (productionId !== null && !ID_PATTERN.test(productionId)) {
    throw new HttpFailure(errorResponse(400, { code: "invalid_id", message: "production ids are short identifiers" }));
  }
  const ctx = apiContext();
  const resolved = await ctx.authority.resolve(request);
  if (!resolved.ok) throw new HttpFailure(errorResponse(401, { code: resolved.code, message: resolved.message }));
  const authority = resolved.authority;
  if (authority.kind === "anonymous") {
    throw new HttpFailure(errorResponse(401, { code: "authority_required", message: "send the human key or an agent run token" }));
  }
  if (authority.kind === "human" && !allowed.human) throw forbidden("people use the other endpoints for this");
  if (authority.kind === "agent") {
    if (!allowed.agent) throw forbidden("agents cannot perform this operation; a person must");
    if (productionId === null || authority.productionId !== productionId) throw forbidden("this run token is for another production");
  }
  return { ctx, authority, productionId: productionId ?? "" };
}

const forbidden = (message: string) => new HttpFailure(errorResponse(403, { code: "forbidden", message }));

async function run(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpFailure) return error.response;
    console.error("[video api] unexpected error", { name: (error as Error)?.name });
    return errorResponse(500, { code: "internal_error", message: "the request could not be completed" });
  }
}

function mutationResponse(result: MutationResult, status = 200, extra: Record<string, unknown> = {}): Response {
  if (result.status !== "applied") return failureResponse(result);
  return okResponse({ status: "applied", changeSetId: result.changeSetId, fromRevision: result.fromRevision, revision: result.revision, generation: result.generation, ...extra }, status);
}

const restoreArgs = (ctx: ApiContext) => ({ changeSetId: ctx.newId("cs"), at: ctx.now() });

// ---------------------------------------------------------------------------
// Collection

export function listProductions(request: Request): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, null, { human: true });
    const listed = await ctx.store.list();
    if (listed.status !== "ok") return failureResponse(listed);
    return okResponse({ productions: listed.productions });
  });
}

export function createProduction(request: Request): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, null, { human: true });
    const body = selectFields(await readJsonObject(request), ["production"]);
    const result = await ctx.store.create(body.production);
    if (result.status !== "applied") return failureResponse(result);
    return okResponse({ status: "created", productionId: result.production.id, revision: result.revision, generation: result.generation }, 201);
  });
}

// ---------------------------------------------------------------------------
// One production

export function getProduction(request: Request, productionId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true, agent: true });
    const loaded = await ctx.store.load(productionId);
    if (loaded.status !== "ok") return failureResponse(loaded);
    return okResponse(productionView(loaded.state));
  });
}

/** A typed change set. The server sets its id, time, actor and run; the engine checks `baseRevision` at commit. */
export function submitChanges(request: Request, productionId: string): Promise<Response> {
  return run(async () => {
    const { ctx, authority } = await authorize(request, productionId, { human: true, agent: true });
    const fields = selectFields(await readJsonObject(request), ["baseRevision", "summary", "ops"], ["scope"]);
    const actor = authority.kind === "agent" ? { by: "agent", runId: authority.runId } : { by: "user" };
    const changeSet = { ...fields, ...actor, id: ctx.newId("cs"), at: ctx.now() };
    return mutationResponse(await ctx.store.apply(productionId, changeSet));
  });
}

export function undoOrRedo(request: Request, productionId: string, direction: "undo" | "redo"): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const expectedGeneration = confirmedGeneration(selectFields(await readJsonObject(request), [], ["expectedGeneration"]));
    const store = ctx.store;
    const result = direction === "undo" ? await store.undo(productionId, restoreArgs(ctx), { expectedGeneration }) : await store.redo(productionId, restoreArgs(ctx), { expectedGeneration });
    return mutationResponse(result);
  });
}

export function addLabel(request: Request, productionId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const fields = selectFields(await readJsonObject(request), ["name"], ["expectedGeneration"]);
    if (typeof fields.name !== "string") throw new HttpFailure(errorResponse(400, { code: "invalid_field", message: "name must be a string" }));
    const pre = fields.expectedGeneration === undefined ? {} : { expectedGeneration: confirmedGeneration(fields) };
    return mutationResponse(await ctx.store.label(productionId, fields.name, pre));
  });
}

export function restoreLabel(request: Request, productionId: string, name: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const expectedGeneration = confirmedGeneration(selectFields(await readJsonObject(request), [], ["expectedGeneration"]));
    return mutationResponse(await ctx.store.restoreLabel(productionId, name, restoreArgs(ctx), { expectedGeneration }));
  });
}

/** Opens an agent run with a server-issued run id and returns its token once. */
export function beginAgentRun(request: Request, productionId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const fields = selectFields(await readJsonObject(request), [], ["scope"]);
    if (fields.scope !== undefined && !(Array.isArray(fields.scope) && fields.scope.every((s) => typeof s === "string"))) {
      throw new HttpFailure(errorResponse(400, { code: "invalid_field", message: "scope must be a list of scene ids" }));
    }
    const runId = ctx.newId("run");
    const result = await ctx.store.beginRun(productionId, { runId, scope: fields.scope as string[] | undefined });
    if (result.status !== "applied") return failureResponse(result);
    const token = ctx.authority.mintRunToken(productionId, runId);
    return okResponse({ status: "started", runId, token, generation: result.generation }, 201);
  });
}

/**
 * A person's decision about a run: keep or discard it (its own run, or one
 * left open by a stopped process), or resume an interrupted one, which issues
 * a new token. Every decision must confirm the generation it was made on.
 */
export function decideRun(request: Request, productionId: string, runId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const fields = selectFields(await readJsonObject(request), ["decision"], ["expectedGeneration"]);
    const decision = fields.decision;
    if (decision !== "keep" && decision !== "discard" && decision !== "resume") {
      throw new HttpFailure(errorResponse(400, { code: "invalid_field", message: "decision must be keep, discard or resume" }));
    }
    const expectedGeneration = confirmedGeneration(fields);

    const loaded = await ctx.store.load(productionId);
    if (loaded.status !== "ok") return failureResponse(loaded);
    const open = loaded.state.run;
    if (!open || open.runId !== runId) return errorResponse(404, { code: "run_not_found", message: "no open run with this id" });

    const args = { runId, changeSetId: ctx.newId("cs"), at: ctx.now() };
    let result: MutationResult;
    if (open.ownedHere) {
      if (decision === "resume") return errorResponse(409, { code: "run_not_interrupted", message: "this run is not interrupted; only keep or discard apply" });
      result = await ctx.store.endRun(productionId, { ...args, decision }, { expectedGeneration });
    } else {
      result = await ctx.store.resolveInterruptedRun(productionId, { ...args, decision }, { expectedGeneration });
    }
    if (result.status !== "applied") return failureResponse(result);
    ctx.authority.revokeRun(productionId, runId);
    const token = decision === "resume" ? ctx.authority.mintRunToken(productionId, runId) : undefined;
    return mutationResponse(result, 200, { decision, ...(token ? { token } : {}) });
  });
}

/** Explicit recovery from an earlier generation; confirmed against the damaged newest generation. */
export function recoverProduction(request: Request, productionId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const fields = selectFields(await readJsonObject(request), ["fromGeneration"], ["expectedGeneration"]);
    const expectedGeneration = confirmedGeneration(fields);
    const from = fields.fromGeneration;
    if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 1) {
      throw new HttpFailure(errorResponse(400, { code: "invalid_field", message: "fromGeneration must be a positive whole number" }));
    }
    return mutationResponse(await ctx.store.recover(productionId, { fromGeneration: from }, { expectedGeneration }));
  });
}
