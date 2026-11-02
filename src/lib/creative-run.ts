import { randomUUID } from "node:crypto";
import type { BrandConfig } from "@/types/brand";
import type { Carousel, ReferenceImage } from "@/types/carousel";
import { MAX_SLIDES } from "@/types/carousel";
import type { StylePreset } from "@/types/style-preset";
import {
  AssetError,
  assetFilePath,
  attachAssets,
  beginCreativeRun,
  carouselAssetIntegrity,
  committedTaskAssets,
  endCreativeRun,
  prepareCarouselRun,
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
import { buildDesignMessage, type ResolvedImage } from "./creative-handoff";
import { explicitCountOverLimit, imagePrompt, validatePlan, type ReadyPlan } from "./director-plan";
import {
  GENERATION_TIMEOUT_MS,
  ImageGenerationError,
  generateImage,
  imageGenerationConfigured,
  type ImageAspectRatio,
} from "./image-service";
import { findSourceLinks, retrieveSources, type SourceUnavailableReason } from "./source-retrieval";
import { directorFailureMessage, planContextFor, runDirector, type DirectorRequest, type DirectorSource } from "./visual-director";

/**
 * The creative run: everything a chat message does before the Design Agent
 * starts. Linked pages are read, the Visual Director plans, the plan's images
 * are generated one at a time and attached all or nothing, and the result is
 * a task message for the Design Agent.
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
}

export type CreativeRunOutcome =
  | {
      kind: "design";
      runId: string;
      /** The user's message followed by the visual plan. */
      designMessage: string;
      plan: ReadyPlan;
      assets: Map<string, ResolvedImage | null>;
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
]);

function imageFailureText(err: unknown): string {
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
  const generate = plan.execution.assets.filter((a) => a.operation === "generate");
  if (!pendingKeys) {
    await setCreativeTasks(
      carouselId,
      runId,
      generate.map((a) => ({ key: a.key, required: a.required, aspectRatio: a.aspectRatio as ImageAspectRatio })),
      generate.length > 0 ? { plan, message: input.message } : undefined
    );
  }
  const pending = generate.filter((a) => (pendingKeys ? pendingKeys.includes(a.key) : true));
  const unavailable = new Set<string>();
  // Required images that failed on their own; the stage continues past them so
  // a retry only has to remake these, and the run blocks once the stage ends.
  const failedRequired: { slides: string; why: string }[] = [];

  if (pending.length > 0) {
    events.stage("preparing-images", `0 of ${pending.length}`);
    await setCreativeStage(carouselId, runId, "preparing-images");
    const deadline = Date.now() + IMAGE_STAGE_MS;
    const started = Date.now();
    for (const [i, asset] of pending.entries()) {
      if (signal.aborted) throw new Cancelled();
      const remaining = deadline - Date.now();
      const slides = `slide ${asset.targetSlides.join(", ")}`;
      if (remaining <= 0) {
        if (asset.required) throw new Blocked("image_stage_timed_out", `Preparing images took longer than 12 minutes, so the image for ${slides} was not made. Nothing was changed.`, true);
        await setTaskState(carouselId, runId, asset.key, "failed");
        unavailable.add(asset.key);
        continue;
      }
      events.stage("preparing-images", `${i + 1} of ${pending.length}`);
      await setTaskState(carouselId, runId, asset.key, "running");
      const taskStarted = Date.now();
      try {
        const image = await creativeRunDeps.generateImage(
          { prompt: imagePrompt(asset.brief!), aspectRatio: asset.aspectRatio! },
          { timeoutMs: Math.min(GENERATION_TIMEOUT_MS, remaining), signal }
        );
        if (signal.aborted) throw new Cancelled();
        await stageImage(carouselId, runId, asset.key, image);
        log("image staged", { carouselId, runId, key: asset.key, durationMs: Date.now() - taskStarted });
      } catch (err) {
        if (err instanceof Cancelled || signal.aborted) throw new Cancelled();
        // The service's refusal code, already bounded to a short lowercase
        // token by the image client, makes a refusal diagnosable; never text.
        const reason = err instanceof ImageGenerationError ? err.detail.reason : undefined;
        await setTaskState(carouselId, runId, asset.key, "failed", { failureReason: reason });
        const code = err instanceof ImageGenerationError || err instanceof AssetError ? err.code : "unexpected";
        const serviceWide = err instanceof ImageGenerationError && SERVICE_WIDE.has(err.code);
        // Capacity and set-up are expected outcomes; an unusable image or storage failure is not.
        log(
          "image failed",
          { carouselId, runId, key: asset.key, required: asset.required, code, ...(reason ? { reason } : {}), durationMs: Date.now() - taskStarted },
          serviceWide ? "warn" : "error"
        );
        if (err instanceof AssetError) throw new Blocked("storage_failed", `${err.message} Nothing was changed.`, true);
        const why = imageFailureText(err);
        if (serviceWide && asset.required) {
          throw new Blocked("image_failed", `The image for ${slides} could not be made. ${why} Nothing was changed.`, true);
        }
        if (asset.required) failedRequired.push({ slides, why });
        else unavailable.add(asset.key);
        // Later images would fail the same way, so the stage stops here.
        if (serviceWide) {
          for (const rest of pending.slice(i + 1)) {
            if (rest.required) {
              throw new Blocked("image_failed", `The image for slide ${rest.targetSlides.join(", ")} could not be made. ${why} Nothing was changed.`, true);
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
      throw new Blocked(
        "image_failed",
        `${failedRequired.length === 1 ? "The image" : `${failedRequired.length} images`} for ${which} could not be made. ${failedRequired[0].why} Nothing was changed; Retry remakes only the missing images.`,
        true
      );
    }
    log("image stage finished", { carouselId, runId, images: pending.length, unavailable: unavailable.size, durationMs: Date.now() - started });
  }

  if (signal.aborted) throw new Cancelled();
  if (generate.length > 0) {
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
  await setCreativeStage(carouselId, runId, "designing");
  return {
    kind: "design",
    runId,
    designMessage: buildDesignMessage(input.message, { plan, assets, references: input.references, sources: sourceUrls }),
    plan,
    assets,
  };
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
