import { describe, it, expect } from "vitest";

import { CAPABILITIES, type CapabilityId, type CapabilityStatus } from "@/lib/creative-capabilities";
import {
  BASELINE_DEFAULT_SLIDES,
  MAX_IMAGE_TASKS,
  explicitCountOverLimit,
  explicitSlideCounts,
  imagePrompt,
  mentionsCover,
  planSummary,
  validatePlan,
  type PlanContext,
} from "@/lib/director-plan";
import { MAX_PROMPT_CHARS } from "@/lib/image-service";
import { EMPTY_BRIEF_UPDATE } from "@/lib/creative-brief";

// ---------------------------------------------------------------------------
// Builders. Every test starts from a plan the validator accepts and breaks one
// rule, so a rejection can only come from that rule.

function capabilities(available: Partial<Record<CapabilityId, boolean>> = {}): CapabilityStatus[] {
  const defaults: Record<CapabilityId, boolean> = {
    "design-composition": true,
    "reference-placement": true,
    "reference-style": true,
    "image-generation": true,
    "asset-reuse": true,
    "image-editing": false,
  };
  return CAPABILITIES.map((c) => ({ ...c, available: available[c.id] ?? defaults[c.id] }));
}

function context(patch: Partial<PlanContext> = {}): PlanContext {
  return {
    message: "Make a carousel about why founders get complacent",
    currentSlideCount: 0,
    referenceIds: ["ref-1", "ref-2"],
    committedAssets: [
      { id: "asset-ok", intact: true },
      { id: "asset-bad", intact: false },
    ],
    capabilities: capabilities(),
    ...patch,
  };
}

const strategy = () => ({
  objective: "Make founders question whether they have grown complacent",
  audience: "Early-stage founders",
  intendedResponse: "Recognise the pattern in themselves and save the post",
  centralMessage: "Comfort is the quiet risk",
  contentType: "thought leadership",
  priorities: ["Name the pattern", "Show its cost"],
  creativeDirection: "Quiet, high-contrast, editorial.",
  treatmentStrategy: "Typography carries the argument; one image sets the mood on the cover.",
  reasoning: [{ decision: "One generated cover image", why: "The cover needs atmosphere the user has no photo for" }],
  successCriteria: ["The central message is readable on slide 1"],
  assumptions: ["The audience is founders, inferred from the topic"],
});

const brief = () => ({
  subject: "A lone founder at a desk late at night, city lights behind",
  composition: "Subject on the left third",
  framing: "Medium shot",
  lighting: "Low, cool, single desk lamp",
  textSafeArea: "Upper half kept calm and dark",
  avoid: "Stock-photo smiles",
});

const typographySlides = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => ({
    index: from + i,
    visualIntent: "The argument, set in type",
    treatment: "typography",
    assetRefs: [] as string[],
    styleReferenceIds: [] as string[],
  }));

/** A valid new 8-slide plan: one generated cover and seven typography slides. */
function plan() {
  return {
    status: "ready",
    strategy: strategy(),
    execution: {
      requestType: "new",
      slideCount: BASELINE_DEFAULT_SLIDES,
      slideCountBasis: "baseline-default",
      slides: [
        { index: 1, visualIntent: "Isolation and late-night pressure", treatment: "generated", assetRefs: ["a1"], styleReferenceIds: [] },
        ...typographySlides(BASELINE_DEFAULT_SLIDES - 1, 2),
      ],
      assets: [{ key: "a1", operation: "generate", required: true, targetSlides: [1], brief: brief(), aspectRatio: "4:5" }],
    },
    briefUpdate: { ...EMPTY_BRIEF_UPDATE, fields: { objective: { value: "Provoke reflection", source: "inferred" } } },
  };
}

type Plan = ReturnType<typeof plan>;
const withExecution = (patch: Partial<Plan["execution"]>): Plan => {
  const p = plan();
  return { ...p, execution: { ...p.execution, ...patch } };
};

function errorsOf(input: unknown, ctx = context()): string[] {
  const result = validatePlan(input, ctx);
  if (result.ok) throw new Error("expected the plan to be refused");
  return result.errors;
}

const accepted = (input: unknown, ctx = context()) => {
  const result = validatePlan(input, ctx);
  if (!result.ok) throw new Error(`expected the plan to be accepted:\n${result.errors.join("\n")}`);
  return result.plan;
};

// ---------------------------------------------------------------------------

describe("slide-count helpers", () => {
  it.each([
    ["Make 5 slides about pricing", [5]],
    ["a five-slide carousel", [5]],
    ["Ten slides, please", [10]],
    ["one slide", [1]],
    ["3 slides or maybe 4 slides", [3, 4]],
    ["Make a carousel about pricing", []],
    ["slide 3 is too busy", []],
    ["the 2025 slides deck", []],
  ])("finds the explicit counts in %j", (message, counts) => {
    expect(explicitSlideCounts(message)).toEqual(counts);
  });

  it("recognises a cover request", () => {
    expect(mentionsCover("Design a reel cover")).toBe(true);
    expect(mentionsCover("Two covers")).toBe(true);
    expect(mentionsCover("Discover pricing")).toBe(false);
  });

  it("ends a new request whose explicit count is over the maximum, but not a revision", () => {
    expect(explicitCountOverLimit("Make 25 slides", 0)).toBe(25);
    expect(explicitCountOverLimit("Make 12 slides", 0)).toBeNull();
    expect(explicitCountOverLimit("Make 25 slides", 4)).toBeNull();
  });
});

describe("imagePrompt", () => {
  it("composes every brief part, and omits avoid when there is none", () => {
    const prompt = imagePrompt(brief());
    expect(prompt).toContain("A lone founder");
    expect(prompt).toContain("Keep clear for text: Upper half kept calm and dark");
    expect(prompt).toContain("Avoid: Stock-photo smiles");
    expect(imagePrompt({ ...brief(), avoid: undefined })).not.toContain("Avoid:");
  });
});

describe("validatePlan: plans the spec names as valid", () => {
  it("accepts the baseline plan and returns the slides in order", () => {
    const p = withExecution({ slides: [...plan().execution.slides].reverse() });
    const out = accepted(p);
    if (out.status !== "ready") throw new Error("expected ready");
    expect(out.execution.slides.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("accepts a typography-only plan with no images at all", () => {
    accepted(withExecution({ slides: typographySlides(BASELINE_DEFAULT_SLIDES), assets: [] }));
  });

  it("accepts a reel cover with one generated image", () => {
    accepted(
      withExecution({
        slideCount: 1,
        slideCountBasis: "single-cover",
        slides: [{ index: 1, visualIntent: "Night", treatment: "generated", assetRefs: ["a1"], styleReferenceIds: [] }],
        assets: [{ key: "a1", operation: "generate", required: true, targetSlides: [1], brief: brief(), aspectRatio: "9:16" }],
      }),
      context({ message: "Design a reel cover about complacency" })
    );
  });

  it("accepts five generated images on five explicit slides", () => {
    const keys = ["a1", "a2", "a3", "a4", "a5"];
    accepted(
      withExecution({
        slideCount: 5,
        slideCountBasis: "user-explicit",
        slides: keys.map((k, i) => ({ index: i + 1, visualIntent: "Scene", treatment: "generated", assetRefs: [k], styleReferenceIds: [] })),
        assets: keys.map((k, i) => ({ key: k, operation: "generate", required: true, targetSlides: [i + 1], brief: brief(), aspectRatio: "4:5" })),
      }),
      context({ message: "Make 5 slides, each with a photo" })
    );
  });

  it("accepts one image shared by several slides", () => {
    accepted(
      withExecution({
        slides: [
          { index: 1, visualIntent: "Night", treatment: "generated", assetRefs: ["a1"], styleReferenceIds: [] },
          { index: 2, visualIntent: "Night, echoed", treatment: "generated", assetRefs: ["a1"], styleReferenceIds: [] },
          ...typographySlides(6, 3),
        ],
        assets: [{ key: "a1", operation: "generate", required: true, targetSlides: [1, 2], brief: brief(), aspectRatio: "4:5" }],
      })
    );
  });

  it("accepts a placed reference and a style reference on different slides", () => {
    accepted(
      withExecution({
        slides: [
          { index: 1, visualIntent: "The founder", treatment: "uploaded-placement", assetRefs: ["ref-1"], styleReferenceIds: ["ref-2"] },
          ...typographySlides(7, 2).map((s) => ({ ...s, styleReferenceIds: ["ref-2"] })),
        ],
        assets: [],
      })
    );
  });

  it("accepts reusing an intact asset on a revision that keeps the count", () => {
    accepted(
      withExecution({
        requestType: "revision",
        slideCount: 3,
        slideCountBasis: "existing",
        slides: [
          { index: 1, visualIntent: "Night", treatment: "generated", assetRefs: ["a1"], styleReferenceIds: [] },
          ...typographySlides(2, 2),
        ],
        assets: [{ key: "a1", operation: "reuse", required: true, targetSlides: [1], assetId: "asset-ok" }] as never,
      }),
      context({ currentSlideCount: 3, message: "Make it more dramatic" })
    );
  });

  it("accepts an optional image with an alternative", () => {
    const p = plan();
    p.execution.assets[0] = { ...p.execution.assets[0], required: false, ifUnavailable: "A bold typographic cover instead" } as never;
    accepted(p);
  });

  it("accepts a source-required answer", () => {
    expect(accepted({ status: "source-required", message: "Paste the post's text or share a public link." })).toEqual({
      status: "source-required",
      message: "Paste the post's text or share a public link.",
    });
  });
});

describe("validatePlan: slide-count precedence", () => {
  const counts = (slideCount: number, slideCountBasis: string, requestType = "new") => {
    const slides = typographySlides(slideCount);
    return withExecution({ requestType, slideCount, slideCountBasis, slides, assets: [] });
  };

  it("a stated count wins over every other basis on a new request", () => {
    const ctx = context({ message: "Make 4 slides about a cover redesign" });
    accepted(counts(4, "user-explicit"), ctx);
    expect(errorsOf(counts(1, "single-cover"), ctx).join()).toMatch(/must be user-explicit/);
    expect(errorsOf(counts(8, "baseline-default"), ctx).join()).toMatch(/must be user-explicit/);
    expect(errorsOf(counts(6, "user-explicit"), ctx).join()).toMatch(/must equal the count the message states/);
  });

  it("a revision keeps its count unless the user changes it", () => {
    const ctx = context({ currentSlideCount: 6, message: "Make it warmer" });
    accepted(counts(6, "existing", "revision"), ctx);
    accepted(counts(7, "user-change", "revision"), ctx);
    expect(errorsOf(counts(5, "existing", "revision"), ctx).join()).toMatch(/current count/);
    expect(errorsOf(counts(8, "baseline-default", "revision"), ctx).join()).toMatch(/only to a new request/);
    expect(errorsOf(counts(6, "existing", "new"), ctx).join()).toMatch(/must be "revision"/);
  });

  it("a revision may mention a count without it being treated as a new request's count", () => {
    accepted(counts(5, "user-change", "revision"), context({ currentSlideCount: 6, message: "Cut it to 5 slides" }));
  });

  it("a single cover needs a cover request and exactly one slide", () => {
    accepted(counts(1, "single-cover"), context({ message: "Design a reel cover" }));
    expect(errorsOf(counts(1, "single-cover")).join()).toMatch(/asks for a cover/);
    expect(errorsOf(counts(2, "single-cover"), context({ message: "Design a reel cover" })).join()).toMatch(/one slide/);
  });

  it("the baseline default is the Design Agent's own arc, and only for a new request", () => {
    accepted(counts(BASELINE_DEFAULT_SLIDES, "baseline-default"));
    expect(errorsOf(counts(6, "baseline-default")).join()).toMatch(new RegExp(`${BASELINE_DEFAULT_SLIDES} slides`));
    expect(errorsOf(counts(6, "existing")).join()).toMatch(/only to a revision/);
    expect(errorsOf(counts(6, "user-change")).join()).toMatch(/only to a revision/);
    expect(errorsOf(counts(6, "user-explicit")).join()).toMatch(/states a count/);
  });

  it.each([0, 21, 2.5, "8"])("refuses the slide count %j", (slideCount) => {
    expect(errorsOf(withExecution({ slideCount: slideCount as number })).join()).toMatch(/execution.slideCount/);
  });

  it("refuses an unknown basis", () => {
    expect(errorsOf(withExecution({ slideCountBasis: "director-choice" })).join()).toMatch(/not a known basis/);
  });
});

describe("validatePlan: conflicting or untrusted execution", () => {
  const firstSlide = (patch: object) => {
    const p = plan();
    p.execution.slides[0] = { ...p.execution.slides[0], ...patch };
    return p;
  };
  const firstAsset = (patch: object) => {
    const p = plan();
    p.execution.assets[0] = { ...p.execution.assets[0], ...patch } as never;
    return p;
  };

  it.each([
    ["an unknown top-level field", { ...plan(), message: "stray" }, /unknown field "message"/],
    ["an unknown execution field", withExecution({ outputPath: "/etc/passwd" } as never), /unknown field "outputPath"/],
    ["an unknown asset field", firstAsset({ url: "https://example.com/x.png" }), /unknown field "url"/],
    ["a path in place of an asset key", firstAsset({ key: "../../a1" }), /plan key/],
    ["a duplicated asset key", withExecution({ assets: [plan().execution.assets[0], plan().execution.assets[0]] }), /used twice/],
    ["a duplicated slide index", firstSlide({ index: 2 }), /used twice/],
    ["a slide outside the count", firstSlide({ index: 9 }), /must be from 1 to 8/],
    ["an unknown treatment", firstSlide({ treatment: "video" }), /not a known treatment/],
    ["a placement of an unknown image", firstSlide({ assetRefs: ["a1", "ref-of-another-carousel"] }), /not a plan asset or a reference/],
    ["a style reference that is not a reference", firstSlide({ styleReferenceIds: ["asset-ok"] }), /not a reference of this carousel/],
    ["one reference both placed and followed as style", firstSlide({ treatment: "uploaded-placement", assetRefs: ["ref-1"], styleReferenceIds: ["ref-1"] }), /placed and followed/],
    ["a generated slide without a plan asset", firstSlide({ assetRefs: [] }), /generated needs a plan asset/],
    ["a typography slide that places an image", firstSlide({ treatment: "typography" }), /typography places no images/],
    ["an uploaded placement without a reference", firstSlide({ treatment: "uploaded-placement" }), /needs a reference/],
    ["an asset that targets no slide", firstAsset({ targetSlides: [] }), /at least one slide/],
    ["an asset whose target slide does not place it", firstAsset({ targetSlides: [1, 2] }), /slide 2 does not place it/],
    ["an asset that targets a missing slide", firstAsset({ targetSlides: [1, 12] }), /slide 12 is not in the plan/],
    ["a slide that places an asset not targeting it", (() => { const p = firstAsset({ targetSlides: [2] }); p.execution.slides[1] = { ...p.execution.slides[1], treatment: "generated", assetRefs: ["a1"] }; return p; })(), /a1 does not target this slide/],
    ["a generate without a brief", firstAsset({ brief: undefined }), /brief: must be an object/],
    ["a generate with an unsupported ratio", firstAsset({ aspectRatio: "3:2" }), /aspectRatio/],
    ["a generate with an asset id", firstAsset({ assetId: "asset-ok" }), /does not belong to generate/],
    ["a brief with an unknown field", firstAsset({ brief: { ...brief(), seed: 42 } }), /unknown field "seed"/],
    ["a brief whose composed prompt is too long", firstAsset({ brief: { ...brief(), subject: "x".repeat(500), composition: "x".repeat(500), framing: "x".repeat(500), lighting: "x".repeat(500), textSafeArea: "x".repeat(100) } }), new RegExp(`exceeds ${MAX_PROMPT_CHARS}`)],
    ["a required asset with an alternative", firstAsset({ ifUnavailable: "Typography" }), /only an optional asset/],
    ["an optional asset without an alternative", firstAsset({ required: false }), /must say what the slide does without it/],
    ["a reuse of another carousel's asset", firstAsset({ operation: "reuse", brief: undefined, aspectRatio: undefined, assetId: "asset-elsewhere" }), /not an asset of this carousel/],
    ["a reuse of an asset whose file changed", firstAsset({ operation: "reuse", brief: undefined, aspectRatio: undefined, assetId: "asset-bad" }), /no longer matches/],
    ["an unknown operation", firstAsset({ operation: "upscale" }), /must be generate, edit or reuse/],
    ["a brief update for another carousel's image", { ...plan(), briefUpdate: { ...EMPTY_BRIEF_UPDATE, assetRelationships: [{ id: "ref-of-another-carousel", role: "Cover", source: "explicit" }] } }, /not a reference image or asset of this carousel/],
    ["an over-long strategy field", { ...plan(), strategy: { ...strategy(), objective: "x".repeat(301) } }, /strategy.objective/],
    ["too much reasoning", { ...plan(), strategy: { ...strategy(), reasoning: Array.from({ length: 7 }, () => ({ decision: "d", why: "w" })) } }, /strategy.reasoning/],
  ])("refuses %s", (_name, input, pattern) => {
    expect(errorsOf(input).join("\n")).toMatch(pattern);
  });

  it("refuses more images than the per-request cap", () => {
    const keys = ["a1", "a2", "a3", "a4", "a5", "a6"];
    const p = withExecution({
      slides: [
        ...keys.map((k, i) => ({ index: i + 1, visualIntent: "Scene", treatment: "generated", assetRefs: [k], styleReferenceIds: [] })),
        ...typographySlides(2, 7),
      ],
      assets: keys.map((k, i) => ({ key: k, operation: "generate", required: true, targetSlides: [i + 1], brief: brief(), aspectRatio: "4:5" })),
    });
    expect(errorsOf(p).join()).toMatch(new RegExp(`at most ${MAX_IMAGE_TASKS} images`));
  });

  it("refuses more images than slides", () => {
    const p = withExecution({
      slideCount: 1,
      slideCountBasis: "single-cover",
      slides: [{ index: 1, visualIntent: "Night", treatment: "generated", assetRefs: ["a1", "a2"], styleReferenceIds: [] }],
      assets: ["a1", "a2"].map((k) => ({ key: k, operation: "generate", required: true, targetSlides: [1], brief: brief(), aspectRatio: "9:16" })),
    });
    expect(errorsOf(p, context({ message: "Design a cover" })).join()).toMatch(/more images than there are slides/);
  });

  it("refuses a status it does not know, or a non-object", () => {
    expect(errorsOf({ ...plan(), status: "done" })).toEqual(['plan.status: must be "ready" or "source-required"']);
    expect(errorsOf("ready")).toEqual(["plan: must be an object"]);
    expect(errorsOf({ status: "source-required", message: "x", strategy: strategy() }).join()).toMatch(/unknown field "strategy"/);
  });
});

describe("validatePlan: a plan that needs a missing capability", () => {
  const editPlan = (patch: object = {}) =>
    withExecution({
      slideCount: 1,
      slideCountBasis: "single-cover",
      slides: [{ index: 1, visualIntent: "The founder, new background", treatment: "edited", assetRefs: ["a1"], styleReferenceIds: [] }],
      assets: [
        {
          key: "a1",
          operation: "edit",
          required: true,
          targetSlides: [1],
          instruction: "Replace the office background with a night skyline",
          sourceIds: ["ref-1"],
          aspectRatio: "9:16",
          ...patch,
        } as never,
      ],
    });
  const coverCtx = context({ message: "Use my photo for a reel cover but put me in front of a night skyline" });

  it("refuses a well-formed edit and names editing as the missing capability", () => {
    const result = validatePlan(editPlan(), coverCtx);
    expect(result).toMatchObject({ ok: false, unavailable: ["image-editing"] });
  });

  it("refuses a well-formed generate where generation is not set up, naming generation", () => {
    const result = validatePlan(plan(), context({ capabilities: capabilities({ "image-generation": false }) }));
    expect(result).toMatchObject({ ok: false, unavailable: ["image-generation"] });
  });

  it("reports a plan that is also malformed as malformed, not as a missing capability", () => {
    const result = validatePlan(editPlan({ sourceIds: ["ref-of-another-carousel"] }), coverCtx);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("unavailable");
  });

  it("checks an edit's shape even while editing is unavailable", () => {
    expect(errorsOf(editPlan({ instruction: undefined }), coverCtx).join()).toMatch(/instruction/);
    expect(errorsOf(editPlan({ sourceIds: [] }), coverCtx).join()).toMatch(/sourceIds/);
    expect(errorsOf(editPlan({ aspectRatio: undefined }), coverCtx).join()).toMatch(/aspectRatio/);
    expect(errorsOf(editPlan({ brief: brief() }), coverCtx).join()).toMatch(/does not belong to edit/);
  });

  it("requires an edited slide to place an edit task", () => {
    const p = editPlan();
    p.execution.assets[0] = { ...(p.execution.assets[0] as object), operation: "generate", instruction: undefined, sourceIds: undefined, brief: brief() } as never;
    expect(errorsOf(p, coverCtx).join()).toMatch(/edited needs an edit task/);
  });

  it("would accept the same edit once editing exists", () => {
    accepted(editPlan(), { ...coverCtx, capabilities: capabilities({ "image-editing": true }) });
  });
});

describe("planSummary", () => {
  it("summarises with counts only, never plan text", () => {
    const summary = planSummary(accepted(plan()));
    expect(summary).toEqual({
      status: "ready",
      requestType: "new",
      slideCount: 8,
      slideCountBasis: "baseline-default",
      generate: 1,
      reuse: 0,
      required: 1,
      treatments: { generated: 1, typography: 7 },
    });
    expect(JSON.stringify(summary)).not.toMatch(/founder|complacent|Comfort/i);
  });
});
