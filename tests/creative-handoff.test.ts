import { describe, it, expect } from "vitest";

import { HANDOFF_END, HANDOFF_START, buildDesignMessage, buildHandoff, checkConformance, type ResolvedImage } from "@/lib/creative-handoff";
import { EMPTY_BRIEF_UPDATE } from "@/lib/creative-brief";
import type { ReadyPlan } from "@/lib/director-plan";
import type { ReferenceImage } from "@/types/carousel";

const photo: ReferenceImage = { id: "ref-photo", url: "/uploads/photo.png", absPath: "/srv/app/public/uploads/photo.png", name: "founder-photo.png", addedAt: "" };
const mood: ReferenceImage = { id: "ref-mood", url: "/uploads/mood.png", absPath: "/srv/app/public/uploads/mood.png", name: "moodboard.png", addedAt: "" };
const unused: ReferenceImage = { id: "ref-old", url: "/uploads/old.png", absPath: "/srv/app/public/uploads/old.png", name: "old.png", addedAt: "" };
const generated: ResolvedImage = { url: "/uploads/gen-1.png", absPath: "/srv/app/public/uploads/gen-1.png" };

function plan(patch: Partial<ReadyPlan["execution"]> = {}): ReadyPlan {
  return {
    status: "ready",
    strategy: {
      objective: "Invite founders to the meetup",
      audience: "Founders in Lisbon",
      intendedResponse: "Save the date",
      centralMessage: "Quiet confidence",
      contentType: "event promotion",
      priorities: ["The speaker is recognisable", "The date is readable"],
      creativeDirection: "Calm, editorial, night.",
      treatmentStrategy: "Photograph first.",
      reasoning: [{ decision: "One image", why: "Focus" }],
      successCriteria: ["The photograph dominates slide 1"],
      assumptions: ["No venue was given"],
    },
    execution: {
      requestType: "new",
      slideCount: 3,
      slideCountBasis: "user-explicit",
      slides: [
        { index: 1, visualIntent: "The speaker", treatment: "uploaded-placement", assetRefs: ["ref-photo"], styleReferenceIds: ["ref-mood"] },
        { index: 2, visualIntent: "Night city", treatment: "generated", assetRefs: ["a1"], styleReferenceIds: ["ref-mood"] },
        { index: 3, visualIntent: "Details", treatment: "typography", assetRefs: [], styleReferenceIds: [] },
      ],
      assets: [{ key: "a1", operation: "generate", required: true, targetSlides: [2] }],
      ...patch,
    },
    briefUpdate: EMPTY_BRIEF_UPDATE,
  };
}

const assets = new Map<string, ResolvedImage | null>([["a1", generated]]);
const refs = [photo, mood, unused];

describe("buildHandoff", () => {
  const text = buildHandoff({ plan: plan(), assets, references: refs, sources: ["https://example.com/event"] });

  it("is delimited, states the authority split, and follows the user's message", () => {
    expect(text.startsWith(HANDOFF_START)).toBe(true);
    expect(text.endsWith(HANDOFF_END)).toBe(true);
    expect(text).toMatch(/Fixed by the plan: the number of slides.*Everything else is your decision/);
    expect(buildDesignMessage("Make 3 slides for the meetup", { plan: plan(), assets, references: refs, sources: [] })).toMatch(
      new RegExp(`^Make 3 slides for the meetup\\n\\n${HANDOFF_START}`)
    );
  });

  it("states the count, each slide's treatment and images, and where to view them", () => {
    expect(text).toContain("Slides to produce: 3 (the number the user asked for).");
    expect(text).toContain('Slide 1: uploaded-placement. Visual intent: The speaker\n  Place the uploaded image "founder-photo.png": /uploads/photo.png (view it with Read at /srv/app/public/uploads/photo.png)');
    expect(text).toContain("Slide 2: generated. Visual intent: Night city\n  Place this image: /uploads/gen-1.png (view it with Read at /srv/app/public/uploads/gen-1.png)");
    expect(text).toContain('Follow the style of "moodboard.png" (/srv/app/public/uploads/mood.png) without placing it');
  });

  it("states every reference image's role, including unused ones", () => {
    expect(text).toContain('- "founder-photo.png" (/uploads/photo.png): placed as content on slide 1.');
    expect(text).toContain('- "moodboard.png" (/uploads/mood.png): a style source only, on slide 1, 2; do not place it on any slide.');
    expect(text).toContain('- "old.png" (/uploads/old.png): not used in this plan; do not place it on any slide.');
  });

  it("lists sources by URL and labels the Director's notes advisory", () => {
    expect(text).toContain("The plan was made from these linked pages:\n- https://example.com/event");
    expect(text).toContain("Director's notes (advisory):\n- Objective: Invite founders to the meetup");
    expect(text).toContain("- Success criteria: The photograph dominates slide 1");
    // Reasoning and assumptions are for evaluation, not instructions.
    expect(text).not.toContain("No venue was given");
  });

  it("tells the Design Agent what to do instead of an optional image that could not be made", () => {
    const optional = plan({ assets: [{ key: "a1", operation: "generate", required: false, targetSlides: [2], ifUnavailable: "A typographic night scene" }] });
    const out = buildHandoff({ plan: optional, assets: new Map([["a1", null]]), references: refs, sources: [] });
    expect(out).toContain("Slide 2: generated. Visual intent: Night city\n  Its image could not be made. Instead: A typographic night scene");
  });
});

describe("checkConformance", () => {
  const html = (...urls: string[]) => urls.map((u) => `<img src="${u}">`).join("");
  const slides = (...htmls: string[]) => htmls.map((h, order) => ({ html: h, order }));

  it("passes a design that follows the plan, with slides in any stored order", () => {
    const result = checkConformance(plan(), [...slides(html(photo.url), html(generated.url), "<p>x</p>")].reverse(), assets, refs);
    expect(result).toEqual({ deviations: [], notes: [] });
  });

  it("reports a wrong slide count", () => {
    const result = checkConformance(plan(), slides(html(photo.url), html(generated.url)), assets, refs);
    expect(result.deviations).toEqual([{ kind: "slide_count", message: "The plan called for 3 slides; the carousel has 2." }]);
  });

  it("reports only the count change for a user-requested change", () => {
    const result = checkConformance(plan({ slideCountBasis: "user-change" }), slides(html(photo.url), html(generated.url)), assets, refs);
    expect(result).toEqual({ deviations: [], notes: ["The carousel now has 2 slides."] });
  });

  it("reports a required image placed on the wrong slide, or not at all", () => {
    const misplaced = checkConformance(plan(), slides(html(photo.url, generated.url), "", ""), assets, refs);
    expect(misplaced.deviations).toEqual([{ kind: "missing_placement", message: "Slide 2 does not show the planned image." }]);
    const missingRef = checkConformance(plan(), slides("", html(generated.url), ""), assets, refs);
    expect(missingRef.deviations).toEqual([{ kind: "missing_placement", message: 'Slide 1 does not show the uploaded image "founder-photo.png".' }]);
  });

  it("reports a style-only reference that was placed, but not one that is also placed on purpose", () => {
    const result = checkConformance(plan(), slides(html(photo.url), html(generated.url, mood.url), ""), assets, refs);
    expect(result.deviations).toEqual([
      { kind: "style_reference_placed", message: 'The style reference "moodboard.png" appears on slide 2 although it was meant as a style source only.' },
    ]);
  });

  it("lists an optional image that could not be made, and does not require it", () => {
    const optional = plan({ assets: [{ key: "a1", operation: "generate", required: false, targetSlides: [2], ifUnavailable: "Type" }] });
    const result = checkConformance(optional, slides(html(photo.url), "", ""), new Map([["a1", null]]), refs);
    expect(result.deviations).toEqual([
      { kind: "optional_unavailable", message: "An optional image for slide 2 could not be made; the plan's alternative was used." },
    ]);
  });
});
