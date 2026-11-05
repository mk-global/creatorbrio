import { creativeRunDeps } from "@/lib/creative-run";
import { EMPTY_BRIEF_UPDATE } from "@/lib/creative-brief";
import { BASELINE_DEFAULT_SLIDES, explicitPageCounts, explicitSlideCounts, mentionsCover, validatePlan } from "@/lib/director-plan";
import { planContextFor, type DirectorRequest, type DirectorResult } from "@/lib/visual-director";
import { MAX_SLIDES } from "@/types/carousel";

const USAGE = { costUsd: 0, durationMs: 1, turns: 1, deniedReads: 0 };

/** A valid, image-free plan for any request, following the slide-count precedence. */
export function typographyPlanFor(request: DirectorRequest) {
  const current = request.carousel.slides.length;
  // Like the real Director: a stated slide count, else a stated length in pages.
  const slideCounts = explicitSlideCounts(request.message);
  const explicit =
    slideCounts.length > 0 ? slideCounts : explicitPageCounts(request.message).filter((n) => n <= MAX_SLIDES);
  const [slideCount, slideCountBasis] =
    current > 0
      ? [current, "existing"]
      : explicit.length > 0
        ? [explicit[0], "user-explicit"]
        : mentionsCover(request.message)
          ? [1, "single-cover"]
          : [BASELINE_DEFAULT_SLIDES, "baseline-default"];
  return {
    status: "ready",
    strategy: {
      objective: "Synthetic objective",
      audience: "Synthetic audience",
      intendedResponse: "Synthetic response",
      centralMessage: "Synthetic message",
      contentType: "synthetic",
      priorities: [],
      creativeDirection: "Synthetic direction.",
      treatmentStrategy: "Typography only.",
      reasoning: [],
      successCriteria: [],
      assumptions: [],
    },
    execution: {
      requestType: current > 0 ? "revision" : "new",
      slideCount,
      slideCountBasis,
      slides: Array.from({ length: slideCount as number }, (_, i) => ({
        index: i + 1,
        visualIntent: "Type",
        treatment: "typography" as string,
        assetRefs: [] as string[],
        styleReferenceIds: [] as string[],
      })),
      assets: [] as Record<string, unknown>[],
    },
    briefUpdate: EMPTY_BRIEF_UPDATE,
  };
}

/** Replaces the Director for one test; returns the restore function. */
export function stubDirector(
  plan: (request: DirectorRequest) => unknown = typographyPlanFor
): { restore: () => void; requests: DirectorRequest[] } {
  const original = creativeRunDeps.runDirector;
  const requests: DirectorRequest[] = [];
  creativeRunDeps.runDirector = async (request): Promise<DirectorResult> => {
    requests.push(request);
    const validated = validatePlan(plan(request), planContextFor(request));
    if (!validated.ok) {
      return validated.unavailable
        ? { ok: false, code: "capability_unavailable", usage: USAGE, errors: validated.errors, unavailable: validated.unavailable }
        : { ok: false, code: "invalid_plan", usage: USAGE, errors: validated.errors };
    }
    return { ok: true, plan: validated.plan, usage: USAGE };
  };
  return { restore: () => (creativeRunDeps.runDirector = original), requests };
}
