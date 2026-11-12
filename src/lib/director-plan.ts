import { MAX_SLIDES, type CarouselAsset } from "@/types/carousel";
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

/** Image tasks per request (docs/architecture/visual-director.md). */
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

/**
 * What an edit does. Only background replacement is performed; the other
 * kinds exist so the Director can name an unsupported request exactly, and
 * each refuses the plan with its own capability rather than being attempted
 * or turned into something else.
 */
export type EditKind = "replace-background" | "remove-object" | "relight" | "combine-images";
export const EDIT_KINDS: readonly EditKind[] = ["replace-background", "remove-object", "relight", "combine-images"];
const UNSUPPORTED_EDITS: Partial<Record<EditKind, CapabilityId>> = {
  "remove-object": "object-removal",
  relight: "relighting",
  "combine-images": "image-combination",
};

export interface PlanAsset {
  /** Plan-local key, `a` followed by one or two digits. */
  key: string;
  operation: "generate" | "edit" | "reuse";
  required: boolean;
  targetSlides: number[];
  brief?: ImageBrief;
  aspectRatio?: ImageAspectRatio;
  /** For `edit`: the kind of edit. */
  editKind?: EditKind;
  /** For `edit`: the new background only; the person is never described or changed. */
  instruction?: string;
  /** For `edit`: exactly one reference image or intact asset of this carousel. */
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
  /**
   * Committed assets: whether each file still matches its recorded hash, and
   * its recorded origin, so a slide that keeps an earlier edited image can
   * say so (#168).
   */
  committedAssets: readonly { id: string; intact: boolean; origin: CarouselAsset["origin"] }[];
  capabilities: readonly CapabilityStatus[];
  /**
   * The project's slide limit when its format sets one below MAX_SLIDES: one
   * for a Reel cover (#175). Absent means MAX_SLIDES, as for every carousel.
   */
  maxSlides?: number;
}

// ---------------------------------------------------------------------------
// Slide-count precedence (SPEC section 7.2).

const NUMBER_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
/** Whitespace within one line: a number on one line never counts a noun on the next. */
const INLINE_SPACE = "[^\\S\\r\\n\\v\\f\\u2028\\u2029]";
// Not the tail of a ratio, decimal, list, fraction or compound ("4:5", "2.5",
// "1,5", "3/10", "twenty-five"), and on the same line as its noun.
const countPattern = (noun: string) =>
  new RegExp(
    `(?<![:.,/-])\\b(\\d{1,2}|${NUMBER_WORDS.join("|")})(?:${INLINE_SPACE}*-${INLINE_SPACE}*|${INLINE_SPACE}+)${noun}s?\\b`,
    "gi"
  );
const SLIDE_COUNT_PATTERN = countPattern("slide");
const PAGE_COUNT_PATTERN = countPattern("page");

/**
 * Every count in a message that a number from 1 to 99, as digits or as an
 * English word up to twenty, gives to the noun on the same line, optionally
 * hyphenated ("5 slides", "five-slide"). A number after the noun ("slide 3",
 * "Page 01") is a label, not a count.
 */
function countsIn(message: string, pattern: RegExp): number[] {
  const counts = new Set<number>();
  for (const match of message.matchAll(pattern)) {
    const token = match[1].toLowerCase();
    const n = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS.indexOf(token) + 1;
    if (n >= 1 && n <= 99) counts.add(n);
  }
  return [...counts].sort((a, b) => a - b);
}

/** Every explicit slide count in a message ("5 slides", "five-slide"); each one binds a new request. */
export function explicitSlideCounts(message: string): number[] {
  return countsIn(message, SLIDE_COUNT_PATTERN);
}

/**
 * Every length a message states in pages ("10 pages", "a ten-page PDF").
 * A document carousel's pages are its slides, but a page count can also
 * describe a source ("my 40-page ebook"), so it never binds a plan: it only
 * lets the Director plan that many slides as "user-explicit" (#124).
 */
export function explicitPageCounts(message: string): number[] {
  return countsIn(message, PAGE_COUNT_PATTERN);
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

/**
 * A count the message states that a format's lower limit cannot hold, for a
 * new request or a revision alike: a Reel cover is one slide however it is
 * asked for (#175). Null when the format has no lower limit or none is over it.
 */
export function explicitCountOverFormatLimit(message: string, maxSlides: number): number | null {
  if (maxSlides >= MAX_SLIDES) return null;
  const over = explicitSlideCounts(message).filter((n) => n > maxSlides);
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
export const TREATMENTS: readonly Treatment[] = ["typography", "css-visual", "uploaded-placement", "generated", "edited"];
export const SLIDE_COUNT_BASES: readonly SlideCountBasis[] = [
  "user-explicit", "single-cover", "existing", "user-change", "baseline-default",
];
export const ASSET_OPERATIONS: readonly PlanAsset["operation"][] = ["generate", "edit", "reuse"];

/**
 * The fields the validator accepts on each object of a plan. The Director's
 * structured-output schema must declare exactly these, or the model either
 * cannot emit a field the validator needs or emits one it refuses; a test
 * holds the two together.
 */
export const PLAN_FIELDS = {
  sourceRequired: ["status", "message"],
  ready: ["status", "strategy", "execution", "briefUpdate"],
  strategy: [
    "objective", "audience", "intendedResponse", "centralMessage", "contentType", "priorities",
    "creativeDirection", "treatmentStrategy", "reasoning", "successCriteria", "assumptions",
  ],
  reasoning: ["decision", "why"],
  execution: ["requestType", "slideCount", "slideCountBasis", "slides", "assets"],
  slide: ["index", "visualIntent", "treatment", "assetRefs", "styleReferenceIds"],
  asset: [
    "key", "operation", "required", "targetSlides", "brief", "aspectRatio", "editKind", "instruction", "sourceIds",
    "assetId", "ifUnavailable",
  ],
  brief: ["subject", "composition", "framing", "lighting", "textSafeArea", "avoid"],
} as const satisfies Record<string, readonly string[]>;

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
  e.keys(s, PLAN_FIELDS.strategy, "strategy");
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
      e.keys(item, PLAN_FIELDS.reasoning, `strategy.reasoning[${i}]`);
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
  const limit = context.maxSlides ?? MAX_SLIDES;
  if (slideCount > limit) {
    e.add("execution.slideCount", `must be at most ${limit} for this project's format`);
    return;
  }
  if (!SLIDE_COUNT_BASES.includes(basis as SlideCountBasis)) {
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
    case "user-explicit": {
      const pages = isNew ? explicitPageCounts(context.message) : [];
      if (pages.length === 0) e.add("execution.slideCountBasis", "user-explicit needs a new request that states a count");
      else if (!pages.includes(slideCount)) e.add("execution.slideCount", "must equal the count the message states");
      break;
    }
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
  e.keys(input, PLAN_FIELDS.brief, path);
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
    e.keys(a, PLAN_FIELDS.asset, path);
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
        for (const f of ["editKind", "instruction", "sourceIds", "assetId"]) if (a[f] !== undefined) e.add(`${path}.${f}`, "does not belong to generate");
        break;
      case "edit": {
        const kind = a.editKind as EditKind;
        if (!EDIT_KINDS.includes(kind)) e.add(`${path}.editKind`, `must be one of ${EDIT_KINDS.join(", ")}`);
        else {
          asset.editKind = kind;
          const unsupported = UNSUPPORTED_EDITS[kind];
          if (unsupported) e.needs(unsupported, `${path}.editKind`, `${kind} is not offered`);
          else if (!isAvailable(context.capabilities, "image-editing")) {
            e.needs("image-editing", `${path}.operation`, "image editing is not available on this machine");
          }
        }
        // An edit is never optional: a failed edit must stop the request with its
        // reason, not fall through to an alternative the user did not ask for.
        if (a.required !== true) e.add(`${path}.required`, "an edit is always required");
        asset.instruction = e.text(a.instruction, PLAN_LIMITS.instruction, `${path}.instruction`);
        const editable = new Set([...references, ...intact]);
        if (!Array.isArray(a.sourceIds) || a.sourceIds.length !== 1 || !editable.has(a.sourceIds[0] as string)) {
          e.add(`${path}.sourceIds`, "must name exactly one reference image or intact asset of this carousel");
        } else asset.sourceIds = [a.sourceIds[0] as string];
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
        for (const f of ["brief", "aspectRatio", "editKind", "instruction", "sourceIds"]) if (a[f] !== undefined) e.add(`${path}.${f}`, "does not belong to reuse");
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
  const editedAssets = new Set(context.committedAssets.filter((a) => a.intact && a.origin === "edited").map((a) => a.id));
  // An edited slide shows a photo with its background replaced: one edited in
  // this request, or one edited earlier and kept as it is (#168).
  const showsEditedImage = (key: string) => {
    const asset = byKey.get(key);
    return asset?.operation === "edit" || (asset?.operation === "reuse" && editedAssets.has(asset.assetId ?? ""));
  };
  const seen = new Set<number>();
  const slides = input.map((raw, i) => {
    const path = `execution.slides[${i}]`;
    const s = isRecord(raw) ? raw : {};
    if (!isRecord(raw)) e.add(path, "must be an object");
    e.keys(s, PLAN_FIELDS.slide, path);
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
    if (treatment === "edited" && !placedAssets.some(showsEditedImage)) {
      e.add(`${path}.treatment`, "edited needs an edit task or a reuse of an earlier edited image in assetRefs");
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
    e.keys(input, PLAN_FIELDS.sourceRequired, "plan");
    const message = e.text(input.message, PLAN_LIMITS.sourceMessage, "plan.message");
    return e.list.length > 0 ? { ok: false, errors: e.list } : { ok: true, plan: { status: "source-required", message } };
  }
  if (input.status !== "ready") return { ok: false, errors: ['plan.status: must be "ready" or "source-required"'] };

  e.keys(input, PLAN_FIELDS.ready, "plan");
  const strategy = validateStrategy(input.strategy, e);
  const x = isRecord(input.execution) ? input.execution : {};
  if (!isRecord(input.execution)) e.add("execution", "must be an object");
  e.keys(x, PLAN_FIELDS.execution, "execution");
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
    edit: assets.filter((a) => a.operation === "edit").length,
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
