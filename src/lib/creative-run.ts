import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { BrandConfig } from "@/types/brand";
import type { Carousel, ReferenceImage } from "@/types/carousel";
import { MAX_SLIDES } from "@/types/carousel";
import type { StylePreset } from "@/types/style-preset";
import {
  AssetError,
  assetFilePath,
  attachAssets,
  beginCreativeRun,
  beginDesign,
  carouselAssetIntegrity,
  committedTaskAssets,
  endCreativeRun,
  prepareCarouselRun,
  prepareContinuation,
  prepareRetry,
  setCreativeStage,
  setCreativeTasks,
  setTaskState,
  stageImage,
} from "./assets";
import { getCarousel, setCreativeBrief } from "./carousels";
import type { BlockedCode, ChatStage } from "./chat-stream";
import { mergeBrief } from "./creative-brief";
import { capabilityStatus } from "./creative-capabilities";
import { buildContinuationMessage, buildDesignMessage, type ResolvedImage } from "./creative-handoff";
import { explicitCountOverFormatLimit, explicitCountOverLimit, imagePrompt, validatePlan, type PlanAsset, type ReadyPlan } from "./director-plan";
import { FORMATS, formatOf, slideLimitOf, withArticle } from "./formats";
import {
  GENERATION_TIMEOUT_MS,
  ImageGenerationError,
  MAX_IMAGE_BYTES,
  editImage,
  generateImage,
  imageGenerationConfigured,
  prepareEditSource,
  type GeneratedImage,
  type ImageAspectRatio,
} from "./image-service";
import { findSourceLinks, retrieveSources, type SourceUnavailableReason } from "./source-retrieval";
import { directorFailureMessage, planContextFor, runDirector, type DirectorRequest, type DirectorSource } from "./visual-director";

/**
 * The creative run: everything a chat message does before the Design Agent
 * starts. Linked pages are read, the Visual Director plans, the plan's images
 * are generated or edited one at a time and attached all or nothing, and the
 * result is a task message for the Design Agent. An edit is never replaced by
 * a generated image: a failed edit stops the run with its reason.
 *
 * The chat route owns the carousel's run (`beginGeneration`) and the stream;
 * this module owns the creative run record through the asset module. Every
 * way out of `prepareCreativeRun` other than "design" has already ended the
 * creative run record; after design the route calls `finishCreativeRun`.
 * There is no automatic retry anywhere: a blocked run can only be retried by
 * the user, from its stored plan.
 */

/** Founder decision: the image stage's wall-clock limit. */
export const IMAGE_STAGE_MS = 12 * 60 * 1000;

export interface CreativeRunInput {
  carousel: Carousel;
  brand: BrandConfig;
  stylePreset: StylePreset | null;
  message: string;
  /** Confined reference images, with server-derived paths. */
  references: ReferenceImage[];
  /** Set for an explicit retry of a blocked run. */
  retryRunId: string | null;
  /** Set for an explicit Continue of an unfinished design (#127). */
  continueRunId?: string | null;
  /** Whether the Design Agent resumes the carousel's conversation, so a continuation need not repeat the original task. */
  resumingSession?: boolean;
}

export type CreativeRunOutcome =
  | {
      kind: "design";
      runId: string;
      /** The user's message followed by the visual plan. */
      designMessage: string;
      plan: ReadyPlan;
      assets: Map<string, ResolvedImage | null>;
      /** Whether this design continues an unfinished one instead of starting from a new plan. */
      continued: boolean;
    }
  | { kind: "blocked"; code: BlockedCode; message: string; retryRunId: string | null }
  | { kind: "cancelled" };

export interface CreativeRunEvents {
  stage(stage: ChatStage, detail?: string): void;
}

/**
 * The run's external dependencies. Tests replace them to script retrieval,
 * planning and image generation without a network, a model, the image
 * service or this machine's image setup; production uses these defaults.
 */
export const creativeRunDeps = {
  retrieveSources: (message: string) => retrieveSources(message),
  /** Whether image generation is set up on this machine, offered to the Director as a capability. */
  imageGenerationConfigured: () => imageGenerationConfigured(),
  runDirector: (request: DirectorRequest, options: { signal?: AbortSignal }) => runDirector(request, options),
  generateImage: (request: Parameters<typeof generateImage>[0], options: Parameters<typeof generateImage>[1]) =>
    generateImage(request, options),
  editImage: (request: Parameters<typeof editImage>[0], options: Parameters<typeof editImage>[1]) =>
    editImage(request, options),
};

class Blocked extends Error {
  constructor(
    readonly code: BlockedCode,
    message: string,
    /** Whether the stored plan can be retried. */
    readonly retryable = false
  ) {
    super(message);
  }
}
class Cancelled extends Error {}
class EditSourceError extends Error {
  readonly code = "edit_source_unavailable";
}

/**
 * The bytes of an edit's one source, resolved by the server from its ID: an
 * uploaded reference of this carousel (already confined, with a
 * server-derived path) or a committed asset whose bytes still match their
 * recorded hash. The hash is taken over the bytes that are then edited, so a
 * file changed after planning is refused, not edited.
 */
async function readEditSource(input: CreativeRunInput, sourceId: string): Promise<Buffer> {
  const reference = input.references.find((r) => r.id === sourceId);
  if (reference) return readBounded(reference.absPath);
  const carousel = await getCarousel(input.carousel.id);
  const asset = carousel?.assets?.find((a) => a.id === sourceId);
  if (!asset) throw new EditSourceError("The photo to edit is no longer part of this carousel.");
  const bytes = await readBounded(assetFilePath(asset.id));
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new EditSourceError("The image to edit has changed since it was made, so it was not used.");
  }
  return bytes;
}

async function readBounded(file: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    throw new EditSourceError("The photo to edit could not be read.");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new EditSourceError("The photo to edit could not be read.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Makes one plan image: generated from its brief, or the background of its source replaced. */
async function makeImage(
  input: CreativeRunInput,
  asset: PlanAsset,
  options: { timeoutMs: number; signal: AbortSignal }
): Promise<GeneratedImage> {
  if (asset.operation === "edit") {
    const source = await prepareEditSource(await readEditSource(input, asset.sourceIds![0]), asset.aspectRatio!);
    return creativeRunDeps.editImage(
      { operation: "replace_background", instruction: asset.instruction!, aspectRatio: asset.aspectRatio!, source },
      options
    );
  }
  return creativeRunDeps.generateImage({ prompt: imagePrompt(asset.brief!), aspectRatio: asset.aspectRatio! }, options);
}

const SOURCE_REASONS: Partial<Record<SourceUnavailableReason, string>> = {
  timed_out: "took too long to respond",
  stage_timed_out: "took too long to respond",
  http_status: "answered with an error",
  unsupported_content_type: "is not a readable web page",
  unsupported_encoding: "is not a readable web page",
  too_large: "is too large to read",
  too_little_text: "had too little readable text (it may need a login or JavaScript)",
  too_many_redirects: "redirected too many times",
  network_error: "could not be reached",
};

/** Failures that every later image in the stage would meet too. */
const SERVICE_WIDE = new Set([
  "image_service_unavailable",
  "image_service_not_configured",
  "image_service_busy",
  "image_generation_refused",
  "image_editing_unavailable",
]);

/** Edit failures that the same source would meet again, so a retry of the stored plan cannot help. */
const PERMANENT = new Set(["image_edit_no_subject", "image_edit_ambiguous_subject", "invalid_edit", "edit_source_unavailable"]);

function imageFailureText(err: unknown): string {
  if (err instanceof EditSourceError) return err.message;
  if (!(err instanceof ImageGenerationError)) return "The image could not be prepared.";
  const wait = err.detail.retryAfterSeconds;
  if (err.code === "image_service_busy") return `${err.message} Try again in about ${wait ?? 60} seconds.`;
  if (err.code === "image_generation_refused") return `${err.message} Try again later.`;
  return err.message;
}

function log(event: string, fields: Record<string, unknown>, level: "info" | "warn" | "error" = "info") {
  console[level](`[creative-run] ${event}`, fields);
}

/**
 * Runs everything before design. Never throws for an expected outcome:
 * blocked and cancelled runs are results, and nothing about the carousel's
 * slides has changed in either.
 */
export async function prepareCreativeRun(
  input: CreativeRunInput,
  events: CreativeRunEvents,
  signal: AbortSignal
): Promise<CreativeRunOutcome> {
  const carouselId = input.carousel.id;
  if (input.retryRunId) return retryRun(input, events, signal);
  if (input.continueRunId) return continueRun(input, events);

  // A Reel cover is one slide (#175): a request that states more is refused
  // here, before any call is made, in the same way as a request over 20.
  const limit = slideLimitOf(input.carousel);
  const overFormat = explicitCountOverFormatLimit(input.message, limit);
  if (overFormat !== null) {
    const name = withArticle(FORMATS[formatOf(input.carousel)].name);
    return {
      kind: "blocked",
      code: "too_many_slides",
      message: `You asked for ${overFormat} slides, and ${name.charAt(0).toLowerCase()}${name.slice(1)} has ${limit === 1 ? "one slide" : `at most ${limit}`}. Nothing was changed; describe the one image you want.`,
      retryRunId: null,
    };
  }

  const count = explicitCountOverLimit(input.message, input.carousel.slides.length);
  if (count !== null) {
    return {
      kind: "blocked",
      code: "too_many_slides",
      message: `You asked for ${count} slides, and a carousel can have at most ${MAX_SLIDES}. Nothing was changed; ask for ${MAX_SLIDES} or fewer.`,
      retryRunId: null,
    };
  }

  await prepareCarouselRun(carouselId);
  const runId = randomUUID();
  await beginCreativeRun(carouselId, runId);
  let plan: ReadyPlan | null = null;
  try {
    const sources = await readSources(input, events, carouselId, runId, signal);
    plan = await plan_(input, sources, events, carouselId, runId, signal);
    return await imagesThenHandoff(input, plan, sources.map((s) => s.url), events, runId, signal);
  } catch (err) {
    return endBeforeDesign(err, carouselId, runId, plan, input.message);
  }
}

async function retryRun(input: CreativeRunInput, events: CreativeRunEvents, signal: AbortSignal): Promise<CreativeRunOutcome> {
  const carouselId = input.carousel.id;
  const runId = input.retryRunId!;
  // The stored plan is checked against the carousel as it is now, exactly as
  // a fresh plan would be: its references, intact assets and capabilities.
  const assets = await carouselAssetIntegrity(input.carousel);
  const capabilities = await carouselCapabilities(input, assets);
  const context = (message: string) => planContextFor(directorRequest(input, message, [], assets, capabilities));
  let prepared;
  try {
    // The stored message is used, never the client's, so the stored plan is
    // always validated against the request it was made for.
    prepared = await prepareRetry(carouselId, runId, (plan, message) => validatePlan(plan, context(message)).ok);
  } catch (err) {
    if (err instanceof AssetError) return { kind: "blocked", code: "retry_refused", message: err.message, retryRunId: null };
    throw err;
  }
  const validated = validatePlan(prepared.plan, context(prepared.message));
  const plan = validated.ok && validated.plan.status === "ready" ? validated.plan : null;
  log("retry", { carouselId, runId, reused: prepared.reused.length, pending: prepared.pending.length });
  try {
    if (!plan) throw new Blocked("retry_refused", "This attempt can no longer be retried; send the request again.");
    return await imagesThenHandoff({ ...input, message: prepared.message }, plan, [], events, runId, signal, prepared.pending);
  } catch (err) {
    return endBeforeDesign(err, carouselId, runId, plan, prepared.message);
  }
}

/**
 * An explicit Continue of the carousel's unfinished design: no sources, no
 * planning and no images. The stored plan and the carousel as it is now
 * decide what is still missing, and the Design Agent is told to make only
 * that. Only the user starts one; nothing here retries on its own.
 */
async function continueRun(input: CreativeRunInput, events: CreativeRunEvents): Promise<CreativeRunOutcome> {
  const carouselId = input.carousel.id;
  const runId = input.continueRunId!;
  let stored;
  try {
    stored = await prepareContinuation(carouselId, runId, isStoredPlan);
  } catch (err) {
    if (err instanceof AssetError) {
      log("continue refused", { carouselId, runId, code: err.code }, "warn");
      return { kind: "blocked", code: "continue_refused", message: err.message, retryRunId: null };
    }
    throw err;
  }
  const plan = stored.plan as ReadyPlan;
  const assets = new Map<string, ResolvedImage | null>();
  for (const asset of plan.execution.assets) {
    const id = stored.assetIds[asset.key] ?? null;
    assets.set(asset.key, id ? { url: `/uploads/${id}.png`, absPath: assetFilePath(id) } : null);
  }
  const carousel = await getCarousel(carouselId);
  const slides = carousel?.slides ?? [];
  log("continue", {
    carouselId,
    runId,
    saved: slides.length,
    expected: plan.execution.slideCount,
    resumingSession: input.resumingSession === true,
  });
  events.stage("designing");
  return {
    kind: "design",
    runId,
    designMessage: buildContinuationMessage({
      plan,
      slides,
      originalTask: stored.designMessage,
      resumingSession: input.resumingSession === true,
    }),
    plan,
    assets,
    continued: true,
  };
}

/** A stored plan written by `beginDesign` from a validated ready plan; checked for the parts a continuation reads. */
function isStoredPlan(plan: unknown): boolean {
  const p = plan as Partial<ReadyPlan> | null;
  return (
    p?.status === "ready" &&
    typeof p.execution?.slideCount === "number" &&
    Array.isArray(p.execution.slides) &&
    Array.isArray(p.execution.assets)
  );
}

async function readSources(
  input: CreativeRunInput,
  events: CreativeRunEvents,
  carouselId: string,
  runId: string,
  signal: AbortSignal
): Promise<DirectorSource[]> {
  if (findSourceLinks(input.message).length === 0) return [];
  events.stage("reading-sources");
  await setCreativeStage(carouselId, runId, "reading-sources");
  const started = Date.now();
  // Retrieval is bounded by its own stage limit; a cancelled run stops waiting for it.
  const retrieval = await untilAborted(creativeRunDeps.retrieveSources(input.message), signal);
  if (retrieval.status === "too_many_sources") {
    throw new Blocked("too_many_sources", `Your message links ${retrieval.count} pages; at most 3 can be read per message. Nothing was changed.`);
  }
  if (retrieval.status === "none") return [];
  const sources: DirectorSource[] = [];
  for (const source of retrieval.sources) {
    if (!source.ok) {
      log("source unavailable", { carouselId, runId, host: source.host, reason: source.reason });
      throw new Blocked(
        "source_unavailable",
        `The page on ${source.host} ${SOURCE_REASONS[source.reason] ?? "is not a public web page that can be read"}. Nothing was changed; paste the text you want used into your message instead.`
      );
    }
    sources.push({ url: source.url, host: source.host, title: source.title, text: source.text, truncated: source.truncated });
  }
  log("sources read", {
    carouselId,
    runId,
    durationMs: Date.now() - started,
    sources: sources.map((s) => ({ host: s.host, chars: s.text.length, truncated: s.truncated })),
  });
  return sources;
}

function directorRequest(
  input: CreativeRunInput,
  message: string,
  sources: DirectorSource[],
  assets: DirectorRequest["assets"],
  capabilities: DirectorRequest["capabilities"] = []
): DirectorRequest {
  return {
    carousel: input.carousel,
    brand: input.brand,
    stylePreset: input.stylePreset,
    message,
    sources,
    references: input.references,
    assets,
    capabilities,
  };
}

function carouselCapabilities(input: CreativeRunInput, assets: DirectorRequest["assets"]) {
  return capabilityStatus(
    {
      referenceCount: input.references.length,
      intactAssetCount: assets.filter((a) => a.intact).length,
    },
    creativeRunDeps.imageGenerationConfigured
  );
}

async function plan_(
  input: CreativeRunInput,
  sources: DirectorSource[],
  events: CreativeRunEvents,
  carouselId: string,
  runId: string,
  signal: AbortSignal
): Promise<ReadyPlan> {
  events.stage("planning");
  await setCreativeStage(carouselId, runId, "planning");
  const assets = await carouselAssetIntegrity(input.carousel);
  const capabilities = await carouselCapabilities(input, assets);
  const result = await creativeRunDeps.runDirector(directorRequest(input, input.message, sources, assets, capabilities), { signal });
  log("planned", { carouselId, runId, outcome: result.ok ? result.plan.status : result.code, ...result.usage });
  if (!result.ok) {
    if (result.code === "cancelled") throw new Cancelled();
    throw new Blocked(
      result.code === "capability_unavailable" ? "capability_unavailable" : "plan_failed",
      directorFailureMessage(result.code, result.unavailable)
    );
  }
  if (result.plan.status === "source-required") throw new Blocked("source_required", result.plan.message);
  return result.plan;
}

async function imagesThenHandoff(
  input: CreativeRunInput,
  plan: ReadyPlan,
  sourceUrls: string[],
  events: CreativeRunEvents,
  runId: string,
  signal: AbortSignal,
  pendingKeys?: string[]
): Promise<CreativeRunOutcome> {
  const carouselId = input.carousel.id;
  // Every image the run makes, generated or edited: they share the stage, the
  // deadline, staging, the all-or-nothing attach and retry.
  const images = plan.execution.assets.filter((a) => a.operation === "generate" || a.operation === "edit");
  if (!pendingKeys) {
    await setCreativeTasks(
      carouselId,
      runId,
      images.map((a) => ({
        key: a.key,
        required: a.required,
        aspectRatio: a.aspectRatio as ImageAspectRatio,
        origin: a.operation === "edit" ? "edited" : "generated",
        sourceIds: a.operation === "edit" ? [...(a.sourceIds ?? [])] : [],
      })),
      images.length > 0 ? { plan, message: input.message } : undefined
    );
  }
  const pending = images.filter((a) => (pendingKeys ? pendingKeys.includes(a.key) : true));
  const unavailable = new Set<string>();
  // Required images that failed on their own; the stage continues past them so
  // a retry only has to remake these, and the run blocks once the stage ends.
  const failedRequired: { what: string; slides: string; why: string; permanent: boolean }[] = [];

  if (pending.length > 0) {
    events.stage("preparing-images", `0 of ${pending.length}`);
    await setCreativeStage(carouselId, runId, "preparing-images");
    const deadline = Date.now() + IMAGE_STAGE_MS;
    const started = Date.now();
    for (const [i, asset] of pending.entries()) {
      if (signal.aborted) throw new Cancelled();
      const remaining = deadline - Date.now();
      const slides = `slide ${asset.targetSlides.join(", ")}`;
      const what = asset.operation === "edit" ? "The edited photo" : "The image";
      if (remaining <= 0) {
        if (asset.required) throw new Blocked("image_stage_timed_out", `Preparing images took longer than 12 minutes, so ${what.toLowerCase()} for ${slides} was not made. Nothing was changed.`, true);
        await setTaskState(carouselId, runId, asset.key, "failed");
        unavailable.add(asset.key);
        continue;
      }
      events.stage("preparing-images", `${i + 1} of ${pending.length}`);
      await setTaskState(carouselId, runId, asset.key, "running");
      const taskStarted = Date.now();
      try {
        const image = await makeImage(input, asset, { timeoutMs: Math.min(GENERATION_TIMEOUT_MS, remaining), signal });
        if (signal.aborted) throw new Cancelled();
        await stageImage(carouselId, runId, asset.key, image);
        log("image staged", { carouselId, runId, key: asset.key, operation: asset.operation, durationMs: Date.now() - taskStarted });
      } catch (err) {
        if (err instanceof Cancelled || signal.aborted) throw new Cancelled();
        // The service's refusal code, already bounded to a short lowercase
        // token by the image client, makes a refusal diagnosable; never text.
        const reason = err instanceof ImageGenerationError ? err.detail.reason : undefined;
        await setTaskState(carouselId, runId, asset.key, "failed", { failureReason: reason });
        const code =
          err instanceof ImageGenerationError || err instanceof AssetError || err instanceof EditSourceError ? err.code : "unexpected";
        const serviceWide = err instanceof ImageGenerationError && SERVICE_WIDE.has(err.code);
        // A photo without one clear person is the user's to change, not a fault.
        const expected = serviceWide || PERMANENT.has(code);
        // Capacity and set-up are expected outcomes; an unusable image or storage failure is not.
        log(
          "image failed",
          { carouselId, runId, key: asset.key, operation: asset.operation, required: asset.required, code, ...(reason ? { reason } : {}), durationMs: Date.now() - taskStarted },
          expected ? "warn" : "error"
        );
        if (err instanceof AssetError) throw new Blocked("storage_failed", `${err.message} Nothing was changed.`, true);
        const why = imageFailureText(err);
        if (serviceWide && asset.required) {
          throw new Blocked("image_failed", `${what} for ${slides} could not be made. ${why} Nothing was changed.`, true);
        }
        if (asset.required) failedRequired.push({ what, slides, why, permanent: PERMANENT.has(code) });
        else unavailable.add(asset.key);
        // Later images would fail the same way, so the stage stops here.
        if (serviceWide) {
          for (const rest of pending.slice(i + 1)) {
            if (rest.required) {
              const restWhat = rest.operation === "edit" ? "The edited photo" : "The image";
              throw new Blocked("image_failed", `${restWhat} for slide ${rest.targetSlides.join(", ")} could not be made. ${why} Nothing was changed.`, true);
            }
            await setTaskState(carouselId, runId, rest.key, "failed");
            unavailable.add(rest.key);
          }
          break;
        }
      }
    }
    if (failedRequired.length > 0) {
      const which = failedRequired.map((f) => f.slides).join("; ");
      // Retrying cannot help when the same source would be refused again.
      const retryable = !failedRequired.some((f) => f.permanent);
      throw new Blocked(
        "image_failed",
        `${failedRequired.length === 1 ? failedRequired[0].what : `${failedRequired.length} images`} for ${which} could not be made. ${failedRequired[0].why} Nothing was changed${retryable ? "; Retry remakes only the missing images." : "."}`,
        retryable
      );
    }
    log("image stage finished", { carouselId, runId, images: pending.length, unavailable: unavailable.size, durationMs: Date.now() - started });
  }

  if (signal.aborted) throw new Cancelled();
  if (images.length > 0) {
    try {
      await attachAssets(carouselId, runId);
    } catch (err) {
      if (err instanceof AssetError) throw new Blocked("storage_failed", `The images could not be added to the carousel. ${err.message} Nothing was changed.`, true);
      throw err;
    }
  }

  const committed = await committedTaskAssets(carouselId, runId);
  const assets = new Map<string, ResolvedImage | null>();
  for (const asset of plan.execution.assets) {
    const id = asset.operation === "reuse" ? asset.assetId : committed.get(asset.key);
    assets.set(asset.key, id && !unavailable.has(asset.key) ? { url: `/uploads/${id}.png`, absPath: assetFilePath(id) } : null);
  }

  // The brief records the intent behind the carousel's content, so it changes
  // only when a run goes on to design. A run that ends before design changes
  // nothing, as its message says; a retry applies its stored plan's update here.
  const current = await getCarousel(carouselId);
  await setCreativeBrief(carouselId, mergeBrief(current?.creativeBrief, plan.briefUpdate, new Date().toISOString()));

  events.stage("designing");
  const designMessage = buildDesignMessage(input.message, { plan, assets, references: input.references, sources: sourceUrls });
  // Kept so that an unfinished design can be continued without planning again.
  const assetIds: Record<string, string | null> = {};
  for (const asset of plan.execution.assets) {
    const id = asset.operation === "reuse" ? asset.assetId : committed.get(asset.key);
    assetIds[asset.key] = id && !unavailable.has(asset.key) ? id : null;
  }
  await beginDesign(carouselId, runId, { plan, designMessage, assetIds });
  return { kind: "design", runId, designMessage, plan, assets, continued: false };
}

async function endBeforeDesign(
  err: unknown,
  carouselId: string,
  runId: string,
  plan: ReadyPlan | null,
  message: string
): Promise<CreativeRunOutcome> {
  if (err instanceof Cancelled) {
    await endCreativeRun(carouselId, runId, "stopped", { reason: "cancelled" });
    log("cancelled before design", { carouselId, runId });
    return { kind: "cancelled" };
  }
  if (err instanceof Blocked) {
    const retry = err.retryable && plan ? { plan, message } : null;
    await endCreativeRun(carouselId, runId, "blocked", { reason: err.code, retry });
    log("blocked", { carouselId, runId, code: err.code, retryable: !!retry });
    return { kind: "blocked", code: err.code, message: err.message, retryRunId: retry ? runId : null };
  }
  await endCreativeRun(carouselId, runId, "failed", { reason: "unexpected" }).catch(() => {});
  throw err;
}

/** Ends a creative run that reached design, recording any differences from the plan. */
export async function finishCreativeRun(
  carouselId: string,
  runId: string,
  outcome: "completed" | "stopped" | "failed" | "timed-out",
  deviations: string[] = []
): Promise<void> {
  await endCreativeRun(carouselId, runId, outcome, { deviations });
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}
