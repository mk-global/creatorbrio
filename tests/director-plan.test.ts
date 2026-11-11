import { describe, it, expect } from "vitest";

import { CAPABILITIES, type CapabilityId, type CapabilityStatus } from "@/lib/creative-capabilities";
import {
  BASELINE_DEFAULT_SLIDES,
  MAX_IMAGE_TASKS,
  explicitCountOverLimit,
  explicitPageCounts,
  explicitSlideCounts,
  imagePrompt,
  mentionsCover,
  planSummary,
  validatePlan,
  type PlanContext,
} from "@/lib/director-plan";
import { MAX_PROMPT_CHARS } from "@/lib/image-service";
import { EMPTY_BRIEF_UPDATE } from "@/lib/creative-brief";
import { TEN_PAGE_BRIEF } from "./fixtures/ten-page-brief";
import { SIMPLE_REVISION_MESSAGE, simpleRevisionPlan } from "./fixtures/simple-revision-plan";

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
    "object-removal": false,
    relighting: false,
    "image-combination": false,
  };
  return CAPABILITIES.map((c) => ({ ...c, available: available[c.id] ?? defaults[c.id] }));
}

function context(patch: Partial<PlanContext> = {}): PlanContext {
  return {
    message: "Make a carousel about why founders get complacent",
    currentSlideCount: 0,
    referenceIds: ["ref-1", "ref-2"],
    committedAssets: [
      { id: "asset-ok", intact: true, origin: "generated" },
      { id: "asset-bad", intact: false, origin: "generated" },
      { id: "asset-edited", intact: true, origin: "edited" },
      { id: "asset-edited-bad", intact: false, origin: "edited" },
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

  it.each([
    ["Exactly 10 pages, 4:5 portrait", [10]],
    ["a ten-page document", [10]],
    ["a 10-page LinkedIn PDF carousel", [10]],
    ["Create all ten pages", [10]],
    ["one page", [1]],
    ["4 pages or maybe 6 pages", [4, 6]],
    ["Page 01: Cover", []],
    ["page marker 03 / 10 bottom right", []],
    ["see page 7, then pages 8 and 9", []],
    ["the 2025 pages archive", []],
    ["Make 10 slides", []],
  ])("finds the page counts in %j", (message, counts) => {
    expect(explicitPageCounts(message)).toEqual(counts);
  });

  it.each([
    ["Format: LinkedIn PDF, 4:5\nPages: 10\nTopic: hiring", [], []],
    ["Use 4:5\nPage 01: Cover\nPage 02: Next", [], []],
    ["Topic 3\nSlides: 10", [], []],
    ["Make 4:5 slides about hiring", [], []],
    ["4:5 pages, exactly 10 pages", [10], []],
    ["twenty-five pages", [], []],
    ["twenty-five slides", [], []],
    ["2.5 pages", [], []],
    ["1,5 slides", [], []],
    ["page 3/10 pages", [], []],
    ["ten\npages, then 6 slides", [], [6]],
  ])("does not read a number from another line, a ratio, a decimal or a compound as a count: %j", (message, pages, slides) => {
    expect(explicitPageCounts(message)).toEqual(pages);
    expect(explicitSlideCounts(message)).toEqual(slides);
  });

  it("finds the ten-page brief's length in pages and no slide count", () => {
    expect(explicitPageCounts(TEN_PAGE_BRIEF)).toEqual([10]);
    expect(explicitSlideCounts(TEN_PAGE_BRIEF)).toEqual([]);
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

describe("validatePlan: a length stated in pages (#124)", () => {
  const counts = (slideCount: number, slideCountBasis: string, requestType = "new") =>
    withExecution({ requestType, slideCount, slideCountBasis, slides: typographySlides(slideCount), assets: [] });

  it("accepts the ten-page brief planned as ten user-explicit slides, the plan refused in the founder's run", () => {
    // Refused on main with: execution.slideCountBasis: user-explicit needs a new request that states a count
    const result = validatePlan(counts(10, "user-explicit"), context({ message: TEN_PAGE_BRIEF }));
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it.each([
    "Design a 10-page LinkedIn PDF carousel about hiring",
    "Make a ten-page document about hiring",
    "Exactly 10 pages about hiring, 4:5",
    "A 10-page PDF carousel on hiring",
    "Ten pages on hiring, please",
  ])("accepts ten user-explicit slides for %j", (message) => {
    accepted(counts(10, "user-explicit"), context({ message }));
  });

  it("keeps a slide count mandatory, and ahead of a page count", () => {
    accepted(counts(10, "user-explicit"), context({ message: "Make 10 slides about hiring" }));
    expect(errorsOf(counts(8, "baseline-default"), context({ message: "Make 10 slides about hiring" })).join()).toMatch(
      /must be user-explicit/
    );
    const both = context({ message: "Summarise my 12-page report in 5 slides" });
    accepted(counts(5, "user-explicit"), both);
    expect(errorsOf(counts(12, "user-explicit"), both).join()).toMatch(/must equal the count the message states/);
  });

  it("lets a page count that describes a source document leave the slide count alone", () => {
    const ebook = context({ message: "Turn my 40-page ebook into a carousel" });
    accepted(counts(BASELINE_DEFAULT_SLIDES, "baseline-default"), ebook);
    accepted(counts(1, "single-cover"), context({ message: "Design a cover for my 12-page report" }));
    expect(explicitCountOverLimit("Turn my 40-page ebook into a carousel", 0)).toBeNull();
  });

  it("still refuses a user-explicit count the message never states", () => {
    expect(errorsOf(counts(8, "user-explicit"), context({ message: TEN_PAGE_BRIEF })).join()).toMatch(
      /execution.slideCount: must equal the count the message states/
    );
    expect(errorsOf(counts(3, "user-explicit"), context({ message: "Page 03 is too busy; see page 7" })).join()).toMatch(
      /user-explicit needs a new request that states a count/
    );
  });

  it("treats a page count in a revision like a slide count in one: a change, never a new request's count", () => {
    const ctx = context({ currentSlideCount: 6, message: "Make it 10 pages" });
    accepted(counts(10, "user-change", "revision"), ctx);
    accepted(counts(6, "existing", "revision"), ctx);
    expect(errorsOf(counts(10, "user-explicit", "revision"), ctx).join()).toMatch(/states a count/);
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
    ["a slide that places an asset not targeting it", (() => { const p = firstAsset({ targetSlides: [2] }); p.execution.slides[1] = { ...p.execution.slides[1], treatment: "generated", assetRefs: ["a1"] }; return p; })(), /slides\[0\]\.assetRefs: places a plan asset that does not target this slide/],
    ["a generate without a brief", firstAsset({ brief: undefined }), /brief: must be an object/],
    ["a generate with an unsupported ratio", firstAsset({ aspectRatio: "3:2" }), /aspectRatio/],
    ["a generate with an asset id", firstAsset({ assetId: "asset-ok" }), /does not belong to generate/],
    ["a brief with an unknown field", firstAsset({ brief: { ...brief(), seed: 42 } }), /unknown field "seed"/],
    [
      "a slide placing an asset with an invalid key, without quoting the key",
      (() => {
        const p = plan();
        p.execution.assets[0] = { ...p.execution.assets[0], key: "my talk about Lisbon", targetSlides: [2] } as never;
        p.execution.slides[0] = { ...p.execution.slides[0], assetRefs: ["my talk about Lisbon"] };
        return p;
      })(),
      /^(?![\s\S]*Lisbon)[\s\S]*places a plan asset that does not target this slide/,
    ],
    ["an unknown field whose name is not an identifier, without quoting it", withExecution({ "my talk about Lisbon": 1 } as never), /^execution: unknown field$/m],
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
          editKind: "replace-background",
          required: true,
          targetSlides: [1],
          instruction: "A night skyline seen from a high floor, soft and out of focus",
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

  // The shape the real Director returned for "Replace the background of my
  // photo ..." in the scored evaluation: the edit also carried a generation
  // brief and a fallback despite being required. The user must still be told
  // editing is unavailable, not that planning failed.
  it("names the missing capability even when the plan is also malformed, keeping every violation", () => {
    const result = validatePlan(editPlan({ brief: brief(), ifUnavailable: "Place the original photo" }), coverCtx);
    expect(result).toMatchObject({ ok: false, unavailable: ["image-editing"] });
    const errors = result.ok ? [] : result.errors.join("\n");
    expect(errors).toMatch(/image editing is not available on this machine/);
    expect(errors).toMatch(/brief: does not belong to edit/);
    expect(errors).toMatch(/ifUnavailable: only an optional asset has an alternative/);
  });

  it("reports a malformed plan that needs no missing capability as malformed", () => {
    const result = validatePlan(
      editPlan({ sourceIds: ["ref-of-another-carousel"] }),
      { ...coverCtx, capabilities: capabilities({ "image-editing": true }) }
    );
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

describe("validatePlan: edits", () => {
  const editing = (patch: Partial<PlanContext> = {}) =>
    context({
      message: "Use my photo for a reel cover but put me in front of a night skyline",
      capabilities: capabilities({ "image-editing": true }),
      ...patch,
    });
  const editPlan = (patch: object = {}) =>
    withExecution({
      slideCount: 1,
      slideCountBasis: "single-cover",
      slides: [{ index: 1, visualIntent: "The founder, new background", treatment: "edited", assetRefs: ["a1"], styleReferenceIds: [] }],
      assets: [
        {
          key: "a1",
          operation: "edit",
          editKind: "replace-background",
          required: true,
          targetSlides: [1],
          instruction: "A night skyline seen from a high floor, soft and out of focus",
          sourceIds: ["ref-1"],
          aspectRatio: "9:16",
          ...patch,
        } as never,
      ],
    });

  it("accepts a background replacement of an upload or of an intact earlier asset, keeping one source", () => {
    const fromUpload = accepted(editPlan(), editing());
    if (fromUpload.status !== "ready") throw new Error("unreachable");
    expect(fromUpload.execution.assets[0]).toMatchObject({ operation: "edit", editKind: "replace-background", sourceIds: ["ref-1"] });
    accepted(editPlan({ sourceIds: ["asset-ok"] }), editing());
  });

  it.each([
    ["remove-object", "object-removal"],
    ["relight", "relighting"],
    ["combine-images", "image-combination"],
  ])("refuses a %s edit as the unavailable %s capability, never as something else", (editKind, capability) => {
    const result = validatePlan(editPlan({ editKind }), editing());
    expect(result).toMatchObject({ ok: false, unavailable: [capability] });
    expect(result.ok ? "" : result.errors.join("\n")).toMatch(new RegExp(`${editKind} is not offered`));
  });

  it("names the unsupported edit, not the machine, when editing is also not set up", () => {
    const result = validatePlan(editPlan({ editKind: "relight" }), editing({ capabilities: capabilities() }));
    expect(result).toMatchObject({ ok: false, unavailable: ["relighting"] });
  });

  it.each([
    ["no edit kind", { editKind: undefined }, /editKind: must be one of/],
    ["an unknown edit kind", { editKind: "upscale" }, /editKind: must be one of/],
    ["an optional edit", { required: false, ifUnavailable: "Place the original" }, /an edit is always required/],
    ["two sources", { sourceIds: ["ref-1", "ref-2"] }, /exactly one reference image or intact asset/],
    ["a source that is not of this carousel", { sourceIds: ["ref-elsewhere"] }, /exactly one reference image or intact asset/],
    ["an asset whose file changed", { sourceIds: ["asset-bad"] }, /exactly one reference image or intact asset/],
    ["an instruction over the limit", { instruction: "x".repeat(MAX_PROMPT_CHARS + 1) }, /instruction: must be 1 to/],
    ["an assetId", { assetId: "asset-ok" }, /assetId: does not belong to edit/],
  ])("refuses %s", (_name, patch, problem) => {
    const result = validatePlan(editPlan(patch), editing());
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("unavailable");
    expect(result.ok ? "" : result.errors.join("\n")).toMatch(problem);
  });

  it("refuses an edit kind on a generate or reuse task", () => {
    const p = plan();
    (p.execution.assets[0] as Record<string, unknown>).editKind = "replace-background";
    expect(errorsOf(p).join()).toMatch(/editKind: does not belong to generate/);
  });

  it("counts edits towards the image limit", () => {
    const slides = Array.from({ length: 6 }, (_, i) => ({
      index: i + 1, visualIntent: "The founder", treatment: "edited", assetRefs: [`a${i + 1}`], styleReferenceIds: [] as string[],
    }));
    const assets = slides.map((s) => ({
      key: `a${s.index}`, operation: "edit", editKind: "replace-background", required: true, targetSlides: [s.index],
      instruction: "A plain studio wall", sourceIds: ["ref-1"], aspectRatio: "4:5",
    }));
    const p = withExecution({ slideCount: 6, slideCountBasis: "user-explicit", slides, assets: assets as never });
    const errors = errorsOf(p, editing({ message: "Make 6 slides of me on new backgrounds" })).join();
    expect(errors).toMatch(new RegExp(`at most ${MAX_IMAGE_TASKS} images`));
  });
});

describe("validatePlan: a revision that keeps an earlier edited image (#168)", () => {
  const revision = () => context({ message: SIMPLE_REVISION_MESSAGE, currentSlideCount: 1 });
  const EDITED_RULE = /treatment: edited needs an edit task or a reuse of an earlier edited image/;

  it("accepts the Director's plan for a one-word colour change on a cover that shows an edited portrait", () => {
    const p = accepted(simpleRevisionPlan("asset-edited"), revision());
    if (p.status !== "ready") throw new Error("unreachable");
    expect(p.execution).toMatchObject({
      requestType: "revision",
      slideCount: 1,
      slideCountBasis: "existing",
      slides: [{ index: 1, treatment: "edited", assetRefs: ["a1"] }],
      assets: [{ key: "a1", operation: "reuse", assetId: "asset-edited", required: true }],
    });
    expect(planSummary(p)).toMatchObject({ generate: 0, edit: 0, reuse: 1 });
  });

  it("still accepts a kept edited image labelled generated, so stored plans stay valid", () => {
    const p = simpleRevisionPlan("asset-edited");
    p.execution.slides[0].treatment = "generated";
    accepted(p, revision());
  });

  it.each([
    ["reuses a generated image", "asset-ok", null],
    ["reuses an edited image whose file changed", "asset-edited-bad", /no longer matches its recorded file/],
    ["reuses an image this carousel does not have", "asset-elsewhere", /is not an asset of this carousel/],
  ])("refuses an edited slide that %s", (_name, assetId, reuseProblem) => {
    const errors = errorsOf(simpleRevisionPlan(assetId), revision()).join("\n");
    expect(errors).toMatch(EDITED_RULE);
    if (reuseProblem) expect(errors).toMatch(reuseProblem);
  });

  it.each([
    ["places nothing", [] as string[]],
    ["places only the original upload", ["ref-1"]],
  ])("refuses an edited slide that %s", (_name, assetRefs) => {
    const p = simpleRevisionPlan("asset-edited");
    p.execution.slides[0].assetRefs = assetRefs;
    p.execution.assets = [];
    p.briefUpdate.assetRelationships = [];
    expect(errorsOf(p, revision()).join("\n")).toMatch(EDITED_RULE);
  });

  it("keeps refusing a revision planned as a new carousel or with another count", () => {
    const asNew = simpleRevisionPlan("asset-edited");
    asNew.execution.requestType = "new";
    expect(errorsOf(asNew, revision()).join()).toMatch(/requestType: must be "revision"/);
    const twoSlides = simpleRevisionPlan("asset-edited");
    twoSlides.execution.slideCount = 2;
    expect(errorsOf(twoSlides, revision()).join()).toMatch(/slideCount: must equal the carousel's current count/);
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
      edit: 0,
      reuse: 0,
      required: 1,
      treatments: { generated: 1, typography: 7 },
    });
    expect(JSON.stringify(summary)).not.toMatch(/founder|complacent|Comfort/i);
  });
});
