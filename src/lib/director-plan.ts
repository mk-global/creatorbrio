import { MAX_SLIDES } from "@/types/carousel";
import { BRIEF_LIMITS, isBoundedText, unknownFieldViolation, validateBriefUpdate, type BriefUpdate } from "./creative-brief";
import { isAvailable, type CapabilityId, type CapabilityStatus } from "./creative-capabilities";
import { IMAGE_DIMENSIONS, MAX_PROMPT_CHARS, type ImageAspectRatio } from "./image-service";

/**
 * The Visual Director's plan and its server-side validator.
 *
 * A plan has two parts with different authority:
 *
 * - `strategy` is the Director's reasoning about the request: objective,
 *   audience, intended response, central message, priorities, direction,
 *   reasons, success criteria and the assumptions it made. It is advisory. Code
 *   never acts on it; it is bounded, passed to the Design Agent as guidance and
 *   kept for evaluation.
 * - `execution` is binding: the slide count and its basis, each slide's
 *   treatment and placements, each reference's role, and the image tasks. Code
 *   acts on it, so every identifier in it is checked against what the server
 *   knows about this carousel. No model-provided path, URL or file name is
 *   ever used.
 *
 * The validator is pure: everything it needs about the carousel and the
 * machine is passed in, so the same plan and context always give the same
 * verdict.
 */

export const PLAN_LIMITS = {
  sourceMessage: 300,
  shortText: 300,
  contentType: 60,
  listItem: 200,
  listItems: 6,
  priorities: 5,
  creativeDirection: 1000,
  treatmentStrategy: 600,
  reasoningDecision: 150,
  reasoningWhy: 300,
  visualIntent: 200,
  briefField: 500,
  instruction: 2000,
  ifUnavailable: 200,
} as const;

/** Founder decision D3: image tasks per request. */
export const MAX_IMAGE_TASKS = 5;

/** The restored Design Agent's own default arc length. */
export const BASELINE_DEFAULT_SLIDES = Math.min(8, MAX_SLIDES);

export type Treatment = "typography" | "css-visual" | "uploaded-placement" | "generated" | "edited";
export type SlideCountBasis = "user-explicit" | "single-cover" | "existing" | "user-change" | "baseline-default";

export interface ImageBrief {
  subject: string;
  composition: string;
  framing: string;
  lighting: string;
  /** Where the slide's text will sit, kept clear in the image. */
  textSafeArea: string;
  /** What the image must not look like, for example "stock-photo smiles". */
  avoid?: string;
}

export interface PlanAsset {
  /** Plan-local key, `a` followed by one or two digits. */
  key: string;
  operation: "generate" | "edit" | "reuse";
  required: boolean;
  targetSlides: number[];
  brief?: ImageBrief;
  aspectRatio?: ImageAspectRatio;
  instruction?: string;
  sourceIds?: string[];
  /** For `reuse`: a committed asset of this carousel. */
  assetId?: string;
  /** For an optional asset: what the slide does instead if it cannot be made. */
  ifUnavailable?: string;
}

export interface PlanSlide {
  /** 1-based. */
  index: number;
  visualIntent: string;
  treatment: Treatment;
  /** Plan asset keys, or reference image IDs placed as content. */
  assetRefs: string[];
  /** Reference image IDs followed as a style source on this slide. */
  styleReferenceIds: string[];
}

export interface PlanStrategy {
  objective: string;
  audience: string;
  intendedResponse: string;
  centralMessage: string;
  /** A descriptive label such as "educational" or "founder story"; guidance, never a route. */
  contentType: string;
  priorities: string[];
  creativeDirection: string;
  treatmentStrategy: string;
  reasoning: { decision: string; why: string }[];
  successCriteria: string[];
  /** What the Director inferred rather than read in the request. */
  assumptions: string[];
}

export interface ReadyPlan {
  status: "ready";
  strategy: PlanStrategy;
  execution: {
    requestType: "new" | "revision";
    slideCount: number;
    slideCountBasis: SlideCountBasis;
    slides: PlanSlide[];
    assets: PlanAsset[];
  };
  briefUpdate: BriefUpdate;
}

export interface SourceRequiredPlan {
  status: "source-required";
  message: string;
}

export type DirectorPlan = ReadyPlan | SourceRequiredPlan;

/** What the server knows when it validates a plan. */
export interface PlanContext {
  message: string;
  /** Slides the carousel has now; zero means a new request. */
  currentSlideCount: number;
  referenceIds: readonly string[];
  /** Committed assets and whether each file still matches its recorded hash. */
  committedAssets: readonly { id: string; intact: boolean }[];
  capabilities: readonly CapabilityStatus[];
}

// ---------------------------------------------------------------------------
// Slide-count precedence (SPEC section 7.2).

const NUMBER_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const COUNT_PATTERN = new RegExp(`\\b(\\d{1,2}|${NUMBER_WORDS.join("|")})(?:\\s*-\\s*|\\s+)slides?\\b`, "gi");

/**
 * Every explicit slide count in a message: a number from 1 to 99, as digits
 * or as an English word up to twenty, followed by "slide" or "slides",
 * optionally hyphenated ("5 slides", "five-slide").
 */
export function explicitSlideCounts(message: string): number[] {
  const counts = new Set<number>();
  for (const match of message.matchAll(COUNT_PATTERN)) {
    const token = match[1].toLowerCase();
    const n = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS.indexOf(token) + 1;
    if (n >= 1 && n <= 99) counts.add(n);
  }
  return [...counts].sort((a, b) => a - b);
}

/** Whether the message asks for a cover, the only case a single slide is inferred. */
export function mentionsCover(message: string): boolean {
  return /\bcovers?\b/i.test(message);
}

/** An explicit count above the maximum, which ends a new request before planning. */
export function explicitCountOverLimit(message: string, currentSlideCount: number): number | null {
  if (currentSlideCount > 0) return null;
  const over = explicitSlideCounts(message).filter((n) => n > MAX_SLIDES);
  return over.length > 0 ? over[over.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Image prompts.

/** The single prompt sent to the image service for a generate task. */
export function imagePrompt(brief: ImageBrief): string {
  return [
    brief.subject,
    `Composition: ${brief.composition}`,
    `Framing: ${brief.framing}`,
    `Lighting: ${brief.lighting}`,
    `Keep clear for text: ${brief.textSafeArea}`,
    ...(brief.avoid ? [`Avoid: ${brief.avoid}`] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validation.

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const ASSET_KEY = /^a[0-9]{1,2}$/;
const TREATMENTS: readonly Treatment[] = ["typography", "css-visual", "uploaded-placement", "generated", "edited"];
const BASES: readonly SlideCountBasis[] = ["user-explicit", "single-cover", "existing", "user-change", "baseline-default"];

/**
 * Collects violations. They are written to the server log, so a violation
 * never quotes a value the model chose unless that value has already been
 * validated as an identifier, a number or one of a fixed set.
 */
class Errors {
  readonly list: string[] = [];
  /** Capabilities the plan needs that this machine does not have. */
  readonly unavailable = new Set<CapabilityId>();
  add(path: string, problem: string) {
    this.list.push(`${path}: ${problem}`);
  }
  needs(capability: CapabilityId, path: string, problem: string) {
    this.unavailable.add(capability);
    this.add(path, problem);
  }
  keys(value: Rec, allowed: readonly string[], path: string) {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.add(path, unknownFieldViolation(key));
  }
  text(value: unknown, max: number, path: string): string {
    if (!isBoundedText(value, max)) this.add(path, `must be 1 to ${max} characters without control characters`);
    return typeof value === "string" ? value : "";
  }
  list_(value: unknown, maxItems: number, maxChars: number, path: string): string[] {
    if (!Array.isArray(value) || value.length > maxItems) {
      this.add(path, `must be a list of at most ${maxItems}`);
      return [];
    }
    return value.map((item, i) => this.text(item, maxChars, `${path}[${i}]`));
  }
}

function validateStrategy(input: unknown, e: Errors): PlanStrategy {
  const s = isRecord(input) ? input : {};
  if (!isRecord(input)) e.add("strategy", "must be an object");
  e.keys(s, [
    "objective", "audience", "intendedResponse", "centralMessage", "contentType", "priorities",
    "creativeDirection", "treatmentStrategy", "reasoning", "successCriteria", "assumptions",
  ], "strategy");
  const reasoning = Array.isArray(s.reasoning) && s.reasoning.length <= PLAN_LIMITS.listItems ? s.reasoning : null;
  if (!reasoning) e.add("strategy.reasoning", `must be a list of at most ${PLAN_LIMITS.listItems}`);
  return {
    objective: e.text(s.objective, PLAN_LIMITS.shortText, "strategy.objective"),
    audience: e.text(s.audience, PLAN_LIMITS.shortText, "strategy.audience"),
    intendedResponse: e.text(s.intendedResponse, PLAN_LIMITS.shortText, "strategy.intendedResponse"),
    centralMessage: e.text(s.centralMessage, PLAN_LIMITS.shortText, "strategy.centralMessage"),
    contentType: e.text(s.contentType, PLAN_LIMITS.contentType, "strategy.contentType"),
    priorities: e.list_(s.priorities, PLAN_LIMITS.priorities, PLAN_LIMITS.listItem, "strategy.priorities"),
    creativeDirection: e.text(s.creativeDirection, PLAN_LIMITS.creativeDirection, "strategy.creativeDirection"),
    treatmentStrategy: e.text(s.treatmentStrategy, PLAN_LIMITS.treatmentStrategy, "strategy.treatmentStrategy"),
    reasoning: (reasoning ?? []).map((r, i) => {
      const item = isRecord(r) ? r : {};
      e.keys(item, ["decision", "why"], `strategy.reasoning[${i}]`);
      return {
        decision: e.text(item.decision, PLAN_LIMITS.reasoningDecision, `strategy.reasoning[${i}].decision`),
        why: e.text(item.why, PLAN_LIMITS.reasoningWhy, `strategy.reasoning[${i}].why`),
      };
    }),
    successCriteria: e.list_(s.successCriteria, PLAN_LIMITS.listItems, PLAN_LIMITS.listItem, "strategy.successCriteria"),
    assumptions: e.list_(s.assumptions, PLAN_LIMITS.listItems, PLAN_LIMITS.listItem, "strategy.assumptions"),
  };
}

function validateSlideCount(
  plan: { requestType: unknown; slideCount: unknown; slideCountBasis: unknown },
  context: PlanContext,
  e: Errors
): void {
  const isNew = context.currentSlideCount === 0;
  const { slideCount, slideCountBasis: basis } = plan;
  if (plan.requestType !== (isNew ? "new" : "revision")) {
    e.add("execution.requestType", `must be "${isNew ? "new" : "revision"}" for this carousel`);
  }
  if (typeof slideCount !== "number" || !Number.isInteger(slideCount) || slideCount < 1 || slideCount > MAX_SLIDES) {
    e.add("execution.slideCount", `must be a whole number from 1 to ${MAX_SLIDES}`);
    return;
  }
  if (!BASES.includes(basis as SlideCountBasis)) {
    e.add("execution.slideCountBasis", "is not a known basis");
    return;
  }
  const explicit = explicitSlideCounts(context.message);
  if (isNew && explicit.length > 0) {
    if (basis !== "user-explicit") e.add("execution.slideCountBasis", "must be user-explicit when the message states a count");
    else if (!explicit.includes(slideCount)) e.add("execution.slideCount", "must equal the count the message states");
    return;
  }
  switch (basis) {
    case "user-explicit":
      e.add("execution.slideCountBasis", "user-explicit needs a new request that states a count");
      break;
    case "existing":
      if (isNew) e.add("execution.slideCountBasis", "existing applies only to a revision");
      else if (slideCount !== context.currentSlideCount) e.add("execution.slideCount", "must equal the carousel's current count");
      break;
    case "user-change":
      if (isNew) e.add("execution.slideCountBasis", "user-change applies only to a revision");
      break;
    case "single-cover":
      if (slideCount !== 1) e.add("execution.slideCount", "single-cover means one slide");
      if (!mentionsCover(context.message)) e.add("execution.slideCountBasis", "single-cover needs a message that asks for a cover");
      break;
    case "baseline-default":
      if (!isNew) e.add("execution.slideCountBasis", "baseline-default applies only to a new request");
      else if (slideCount !== BASELINE_DEFAULT_SLIDES) {
        e.add("execution.slideCount", `baseline-default means ${BASELINE_DEFAULT_SLIDES} slides`);
      }
      break;
  }
}

function validateBrief(input: unknown, path: string, e: Errors): ImageBrief | undefined {
  if (!isRecord(input)) {
    e.add(path, "must be an object");
    return undefined;
  }
  e.keys(input, ["subject", "composition", "framing", "lighting", "textSafeArea", "avoid"], path);
  const brief: ImageBrief = {
    subject: e.text(input.subject, PLAN_LIMITS.briefField, `${path}.subject`),
    composition: e.text(input.composition, PLAN_LIMITS.briefField, `${path}.composition`),
    framing: e.text(input.framing, PLAN_LIMITS.briefField, `${path}.framing`),
    lighting: e.text(input.lighting, PLAN_LIMITS.briefField, `${path}.lighting`),
    textSafeArea: e.text(input.textSafeArea, PLAN_LIMITS.briefField, `${path}.textSafeArea`),
    ...(input.avoid !== undefined ? { avoid: e.text(input.avoid, PLAN_LIMITS.briefField, `${path}.avoid`) } : {}),
  };
  if (imagePrompt(brief).length > MAX_PROMPT_CHARS) e.add(path, `the composed image prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  return brief;
}

function validateAssets(input: unknown, context: PlanContext, e: Errors): PlanAsset[] {
  if (!Array.isArray(input)) {
    e.add("execution.assets", "must be a list");
    return [];
  }
  const intact = new Set(context.committedAssets.filter((a) => a.intact).map((a) => a.id));
  const known = new Set(context.committedAssets.map((a) => a.id));
  const references = new Set(context.referenceIds);
  const keys = new Set<string>();
  return input.map((raw, i) => {
    const path = `execution.assets[${i}]`;
    const a = isRecord(raw) ? raw : {};
    if (!isRecord(raw)) e.add(path, "must be an object");
    e.keys(a, [
      "key", "operation", "required", "targetSlides", "brief", "aspectRatio", "instruction", "sourceIds", "assetId",
      "ifUnavailable",
    ], path);
    const key = typeof a.key === "string" ? a.key : "";
    if (!ASSET_KEY.test(key)) e.add(`${path}.key`, "must be a plan key such as a1");
    else if (keys.has(key)) e.add(`${path}.key`, "is used twice");
    keys.add(key);
    if (typeof a.required !== "boolean") e.add(`${path}.required`, "must be true or false");
    const targetSlides = Array.isArray(a.targetSlides) && a.targetSlides.every((n) => Number.isInteger(n))
      ? (a.targetSlides as number[])
      : (e.add(`${path}.targetSlides`, "must be a list of slide indices"), []);
    if (targetSlides.length === 0) e.add(`${path}.targetSlides`, "must name at least one slide");

    const asset: PlanAsset = {
      key,
      operation: a.operation as PlanAsset["operation"],
      required: a.required === true,
      targetSlides,
    };
    if (a.ifUnavailable !== undefined) {
      asset.ifUnavailable = e.text(a.ifUnavailable, PLAN_LIMITS.ifUnavailable, `${path}.ifUnavailable`);
      if (asset.required) e.add(`${path}.ifUnavailable`, "only an optional asset has an alternative");
    } else if (a.required === false) {
      e.add(`${path}.ifUnavailable`, "an optional asset must say what the slide does without it");
    }

    switch (a.operation) {
      case "generate":
        if (!isAvailable(context.capabilities, "image-generation")) {
          e.needs("image-generation", `${path}.operation`, "image generation is not available on this machine");
        }
        asset.brief = validateBrief(a.brief, `${path}.brief`, e);
        if (!(typeof a.aspectRatio === "string" && a.aspectRatio in IMAGE_DIMENSIONS)) {
          e.add(`${path}.aspectRatio`, "must be 1:1, 4:5, 9:16 or 16:9");
        } else asset.aspectRatio = a.aspectRatio as ImageAspectRatio;
        for (const f of ["instruction", "sourceIds", "assetId"]) if (a[f] !== undefined) e.add(`${path}.${f}`, "does not belong to generate");
        break;
      case "edit": {
        if (!isAvailable(context.capabilities, "image-editing")) {
          e.needs("image-editing", `${path}.operation`, "editing uploaded images is not available yet");
        }
        asset.instruction = e.text(a.instruction, PLAN_LIMITS.instruction, `${path}.instruction`);
        const editable = new Set([...references, ...intact]);
        if (!Array.isArray(a.sourceIds) || a.sourceIds.length === 0 || a.sourceIds.some((id) => !editable.has(id as string))) {
          e.add(`${path}.sourceIds`, "must name the reference images or intact assets of this carousel to edit");
        } else asset.sourceIds = a.sourceIds as string[];
        if (!(typeof a.aspectRatio === "string" && a.aspectRatio in IMAGE_DIMENSIONS)) {
          e.add(`${path}.aspectRatio`, "must be 1:1, 4:5, 9:16 or 16:9");
        } else asset.aspectRatio = a.aspectRatio as ImageAspectRatio;
        for (const f of ["brief", "assetId"]) if (a[f] !== undefined) e.add(`${path}.${f}`, "does not belong to edit");
        break;
      }
      case "reuse":
        if (typeof a.assetId !== "string" || !known.has(a.assetId)) e.add(`${path}.assetId`, "is not an asset of this carousel");
        else if (!intact.has(a.assetId)) e.add(`${path}.assetId`, "no longer matches its recorded file");
        else asset.assetId = a.assetId;
        for (const f of ["brief", "aspectRatio", "instruction", "sourceIds"]) if (a[f] !== undefined) e.add(`${path}.${f}`, "does not belong to reuse");
        break;
      default:
        e.add(`${path}.operation`, "must be generate, edit or reuse");
    }
    return asset;
  });
}

function validateSlides(
  input: unknown,
  slideCount: number,
  assets: PlanAsset[],
  context: PlanContext,
  e: Errors
): PlanSlide[] {
  if (!Array.isArray(input)) {
    e.add("execution.slides", "must be a list");
    return [];
  }
  const references = new Set(context.referenceIds);
  const byKey = new Map(assets.map((a) => [a.key, a]));
  const seen = new Set<number>();
  const slides = input.map((raw, i) => {
    const path = `execution.slides[${i}]`;
    const s = isRecord(raw) ? raw : {};
    if (!isRecord(raw)) e.add(path, "must be an object");
    e.keys(s, ["index", "visualIntent", "treatment", "assetRefs", "styleReferenceIds"], path);
    const index = s.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > slideCount) {
      e.add(`${path}.index`, `must be from 1 to ${slideCount}`);
    } else if (seen.has(index)) e.add(`${path}.index`, "is used twice");
    else seen.add(index);
    const treatment = s.treatment as Treatment;
    if (!TREATMENTS.includes(treatment)) e.add(`${path}.treatment`, "is not a known treatment");
    const assetRefs = Array.isArray(s.assetRefs ?? []) ? ((s.assetRefs ?? []) as unknown[]).map(String) : [];
    const styleReferenceIds = Array.isArray(s.styleReferenceIds ?? []) ? ((s.styleReferenceIds ?? []) as unknown[]).map(String) : [];

    for (const ref of assetRefs) {
      const asset = byKey.get(ref);
      if (asset) {
        if (!asset.targetSlides.includes(index as number)) e.add(`${path}.assetRefs`, "places a plan asset that does not target this slide");
      } else if (!references.has(ref)) e.add(`${path}.assetRefs`, "names something that is not a plan asset or a reference of this carousel");
    }
    for (const id of styleReferenceIds) {
      if (!references.has(id)) e.add(`${path}.styleReferenceIds`, "names an image that is not a reference of this carousel");
      if (assetRefs.includes(id)) e.add(`${path}.styleReferenceIds`, "a reference cannot be placed and followed as style on one slide");
    }
    const placedRefs = assetRefs.filter((r) => references.has(r));
    const placedAssets = assetRefs.filter((r) => byKey.has(r));
    if (treatment === "uploaded-placement" && placedRefs.length === 0) {
      e.add(`${path}.treatment`, "uploaded-placement needs a reference in assetRefs");
    }
    if (treatment === "generated" && placedAssets.length === 0) e.add(`${path}.treatment`, "generated needs a plan asset in assetRefs");
    if (treatment === "edited" && !placedAssets.some((k) => byKey.get(k)?.operation === "edit")) {
      e.add(`${path}.treatment`, "edited needs an edit task in assetRefs");
    }
    if ((treatment === "typography" || treatment === "css-visual") && assetRefs.length > 0) {
      e.add(`${path}.treatment`, `${treatment} places no images`);
    }
    return {
      index: index as number,
      visualIntent: e.text(s.visualIntent, PLAN_LIMITS.visualIntent, `${path}.visualIntent`),
      treatment,
      assetRefs,
      styleReferenceIds,
    };
  });

  // Every asset is placed exactly on the slides it targets.
  assets.forEach((asset, i) => {
    for (const target of asset.targetSlides) {
      const slide = slides.find((s) => s.index === target);
      if (!slide) e.add(`execution.assets[${i}].targetSlides`, `slide ${target} is not in the plan`);
      else if (!slide.assetRefs.includes(asset.key)) e.add(`execution.assets[${i}].targetSlides`, `slide ${target} does not place it`);
    }
  });
  return slides;
}

export type PlanValidation =
  | { ok: true; plan: DirectorPlan }
  /**
   * `unavailable` is set whenever the plan needs a capability this machine
   * does not have (editing, or generation where it is not set up). Such a plan
   * is refused like any other, but the user is told which capability is
   * missing instead of being asked to rephrase: no repair of its other fields
   * could make it runnable. Every violation, including any others, is kept in
   * `errors` for the server log.
   */
  | { ok: false; errors: string[]; unavailable?: CapabilityId[] };

/**
 * Validates an untrusted plan against the carousel. Returns the typed plan,
 * or every rule it breaks. There is no partial acceptance and no repair.
 */
export function validatePlan(input: unknown, context: PlanContext): PlanValidation {
  const e = new Errors();
  if (!isRecord(input)) return { ok: false, errors: ["plan: must be an object"] };

  if (input.status === "source-required") {
    e.keys(input, ["status", "message"], "plan");
    const message = e.text(input.message, PLAN_LIMITS.sourceMessage, "plan.message");
    return e.list.length > 0 ? { ok: false, errors: e.list } : { ok: true, plan: { status: "source-required", message } };
  }
  if (input.status !== "ready") return { ok: false, errors: ['plan.status: must be "ready" or "source-required"'] };

  e.keys(input, ["status", "strategy", "execution", "briefUpdate"], "plan");
  const strategy = validateStrategy(input.strategy, e);
  const x = isRecord(input.execution) ? input.execution : {};
  if (!isRecord(input.execution)) e.add("execution", "must be an object");
  e.keys(x, ["requestType", "slideCount", "slideCountBasis", "slides", "assets"], "execution");
  validateSlideCount({ requestType: x.requestType, slideCount: x.slideCount, slideCountBasis: x.slideCountBasis }, context, e);
  const slideCount = typeof x.slideCount === "number" ? x.slideCount : 0;

  const assets = validateAssets(x.assets ?? [], context, e);
  const slides = validateSlides(x.slides, slideCount, assets, context, e);

  const imageTasks = assets.filter((a) => a.operation === "generate" || a.operation === "edit").length;
  if (imageTasks > MAX_IMAGE_TASKS) e.add("execution.assets", `at most ${MAX_IMAGE_TASKS} images can be made per request`);
  if (imageTasks > slideCount) e.add("execution.assets", "cannot make more images than there are slides");

  const knownIds = new Set([...context.referenceIds, ...context.committedAssets.map((a) => a.id)]);
  const brief = validateBriefUpdate(input.briefUpdate ?? {}, knownIds);
  if (!brief.ok) for (const err of brief.errors) e.list.push(err);

  if (e.list.length > 0) {
    return e.unavailable.size > 0
      ? { ok: false, errors: e.list, unavailable: [...e.unavailable] }
      : { ok: false, errors: e.list };
  }
  return {
    ok: true,
    plan: {
      status: "ready",
      strategy,
      execution: {
        requestType: x.requestType as "new" | "revision",
        slideCount,
        slideCountBasis: x.slideCountBasis as SlideCountBasis,
        slides: [...slides].sort((a, b) => a.index - b.index),
        assets,
      },
      briefUpdate: brief.ok ? brief.update : (undefined as never),
    },
  };
}

/** Compact, content-free counts for logs. */
export function planSummary(plan: DirectorPlan): Record<string, unknown> {
  if (plan.status === "source-required") return { status: plan.status };
  const assets = plan.execution.assets;
  return {
    status: plan.status,
    requestType: plan.execution.requestType,
    slideCount: plan.execution.slideCount,
    slideCountBasis: plan.execution.slideCountBasis,
    generate: assets.filter((a) => a.operation === "generate").length,
    reuse: assets.filter((a) => a.operation === "reuse").length,
    required: assets.filter((a) => a.required).length,
    treatments: Object.fromEntries(
      [...new Set(plan.execution.slides.map((s) => s.treatment))].map((t) => [
        t,
        plan.execution.slides.filter((s) => s.treatment === t).length,
      ])
    ),
  };
}

export { BRIEF_LIMITS };
