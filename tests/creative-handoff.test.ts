import { describe, it, expect } from "vitest";

import { HANDOFF_END, HANDOFF_START, buildContinuationMessage, buildDesignMessage, buildHandoff, checkConformance, type ResolvedImage } from "@/lib/creative-handoff";
import { EMPTY_BRIEF_UPDATE } from "@/lib/creative-brief";
import type { ReadyPlan } from "@/lib/director-plan";
import type { ResolvedReferenceImage } from "@/types/carousel";

const photo: ResolvedReferenceImage = { id: "ref-photo", url: "/uploads/photo.png", absPath: "/srv/app/public/uploads/photo.png", name: "founder-photo.png", addedAt: "" };
const mood: ResolvedReferenceImage = { id: "ref-mood", url: "/uploads/mood.png", absPath: "/srv/app/public/uploads/mood.png", name: "moodboard.png", addedAt: "" };
const unused: ResolvedReferenceImage = { id: "ref-old", url: "/uploads/old.png", absPath: "/srv/app/public/uploads/old.png", name: "old.png", addedAt: "" };
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

  // Found in review: an optional image that was made is handed over with
  // "Place this image", so leaving it out is a difference from the plan.
  it("reports an optional image that was made but not placed, and passes one that was placed", () => {
    const optional = plan({ assets: [{ key: "a1", operation: "generate", required: false, targetSlides: [2], ifUnavailable: "Type" }] });
    const missing = checkConformance(optional, slides(html(photo.url), "", ""), assets, refs);
    expect(missing.deviations).toEqual([{ kind: "missing_placement", message: "Slide 2 does not show the planned image." }]);
    const placed = checkConformance(optional, slides(html(photo.url), html(generated.url), ""), assets, refs);
    expect(placed).toEqual({ deviations: [], notes: [] });
  });
});

describe("linked pages in the design message (#228)", () => {
  const page = (text: string, i: number) => ({ url: `https://example.com/${i}`, host: "example.com", title: `Page ${i}`, text, truncated: false });

  it("keeps the whole message within one command-line argument, cutting page text at a character boundary", async () => {
    const { MAX_DESIGN_MESSAGE_BYTES } = await import("@/lib/creative-handoff");
    const { MAX_CHAT_MESSAGE_LENGTH } = await import("@/lib/chat-stream");
    const longest = "日".repeat(MAX_CHAT_MESSAGE_LENGTH);
    const pages = [1, 2, 3].map((i) => page("語".repeat(20_000), i));
    const message = buildDesignMessage(longest, { plan: plan(), assets, references: refs, sources: pages.map((p) => p.url), pages });
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(MAX_DESIGN_MESSAGE_BYTES);
    expect(message.match(/\[truncated\]/g)).toHaveLength(3);
    expect(message).not.toContain("�");
    expect(message.startsWith(longest)).toBe(true);
  });

  it("leaves room for a Continue in a new conversation, so linked pages never make it overflow the argument", async () => {
    const { MAX_DESIGN_MESSAGE_BYTES } = await import("@/lib/creative-handoff");
    const { MAX_CHAT_MESSAGE_LENGTH } = await import("@/lib/chat-stream");
    // The plan at its limits: 20 slides, each visual intent 200 characters of a three-byte script.
    const slides = Array.from({ length: 20 }, (_, i) => ({ index: i + 1, visualIntent: "夜".repeat(200), treatment: "typography" as const, assetRefs: [], styleReferenceIds: [] }));
    const big = plan({ slideCount: 20, slides, assets: [] });
    const pages = [1, 2, 3].map((i) => page("語".repeat(20_000), i));
    const saved = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `0b9e2f4c-1d3a-4e5f-8a7b-${String(i).padStart(12, "0")}`, order: i, notes: "注".repeat(200) }));
    const continueAfter = (message: string, withPages: boolean, n: number) =>
      Buffer.byteLength(
        buildContinuationMessage({
          plan: big,
          slides: saved(n),
          originalTask: buildDesignMessage(message, { plan: big, assets: new Map(), references: [], sources: withPages ? pages.map((p) => p.url) : [], pages: withPages ? pages : undefined }),
          resumingSession: false,
        })
      );
    for (const n of [0, 10, 19]) {
      // A long request that fits: its Continue still fits once pages fill their budget.
      expect(continueAfter("日".repeat(10_000), true, n)).toBeLessThanOrEqual(MAX_DESIGN_MESSAGE_BYTES);
      // The longest request leaves pages no text, so they add only their delimiters.
      const longest = "日".repeat(MAX_CHAT_MESSAGE_LENGTH);
      expect(continueAfter(longest, true, n) - continueAfter(longest, false, n)).toBeLessThan(2048);
    }
  });

  it("leaves pages that fit unchanged", () => {
    const pages = [page("Short facts.", 1)];
    const message = buildDesignMessage("Make 3 slides", { plan: plan(), assets, references: refs, sources: [pages[0].url], pages });
    expect(message).toContain("Short facts.");
    expect(message).not.toContain("[truncated]");
  });
});
