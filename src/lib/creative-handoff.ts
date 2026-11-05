import type { ReferenceImage, Slide } from "@/types/carousel";
import type { ReadyPlan, SlideCountBasis } from "./director-plan";

/**
 * The Design Agent handoff and the conformance check that follows design.
 *
 * The handoff is a fixed template appended to the user's message. It states
 * the plan's facts only: who decides what, the slide count and its basis,
 * each slide's treatment and images, each reference image's role, the
 * sources, and the Director's advisory notes. It adds no style, tone or
 * layout instruction of its own, and it never touches the Design Agent's
 * system prompt (SPEC 7.3).
 *
 * The conformance check compares the finished slides with the plan's binding
 * parts. A difference is reported and recorded, never corrected.
 */

/** A plan image resolved by the server: an attached or reused asset, or an uploaded reference. */
export interface ResolvedImage {
  /** Served URL, `/uploads/<id>.png`. */
  url: string;
  /** Server-derived absolute path the Design Agent may view with Read. */
  absPath: string;
}

export interface HandoffInput {
  plan: ReadyPlan;
  /** Plan asset key to its image, or null when an optional image could not be made. */
  assets: ReadonlyMap<string, ResolvedImage | null>;
  /** The carousel's confined reference images. */
  references: readonly ReferenceImage[];
  /** URLs of the linked pages the plan was made from. */
  sources: readonly string[];
}

export const HANDOFF_START = "--- Visual plan for this request ---";
export const HANDOFF_END = "--- End of visual plan ---";

const BASIS_TEXT: Record<SlideCountBasis, string> = {
  "user-explicit": "the number the user asked for",
  existing: "the carousel's current number of slides",
  "user-change": "the user asked to change the number of slides",
  "single-cover": "the user asked for a cover",
  "baseline-default": "your usual arc",
};

const AUTHORITY =
  "This plan comes from CreatorBrio's Visual Director. Fixed by the plan: the number of slides, which slides carry which images, and whether each uploaded reference image is placed on a slide or followed only as a style source. Everything else is your decision: the copy, layout, typography, colour within the brand, and how each image is cropped, positioned and combined with text. The Director's notes at the end are advisory.";

const quoted = (name: string) => JSON.stringify(name.slice(0, 100));

/** The task message for the Design Agent: the user's message, then the visual plan. */
export function buildDesignMessage(userMessage: string, input: HandoffInput): string {
  return `${userMessage}\n\n${buildHandoff(input)}`;
}

export function buildHandoff({ plan, assets, references, sources }: HandoffInput): string {
  const { execution: x, strategy: s } = plan;
  const byKey = new Map(x.assets.map((a) => [a.key, a]));
  const refById = new Map(references.map((r) => [r.id, r]));
  const lines: string[] = [HANDOFF_START, AUTHORITY, ""];

  lines.push(`Slides to produce: ${x.slideCount} (${BASIS_TEXT[x.slideCountBasis]}).`, "");

  for (const slide of x.slides) {
    lines.push(`Slide ${slide.index}: ${slide.treatment}. Visual intent: ${slide.visualIntent}`);
    for (const ref of slide.assetRefs) {
      const asset = byKey.get(ref);
      if (asset) {
        const image = assets.get(ref);
        if (image) {
          lines.push(`  Place this image: ${image.url} (view it with Read at ${image.absPath})`);
          const source = asset.operation === "edit" ? refById.get(asset.sourceIds?.[0] ?? "") : undefined;
          if (asset.operation === "edit") {
            lines.push(
              `  It is ${source ? `the uploaded image ${quoted(source.name)}` : "an earlier image"} with its background replaced and the person unchanged; it replaces that image on this slide, so do not also place the original.`
            );
          }
        }
        else lines.push(`  Its image could not be made. Instead: ${asset.ifUnavailable ?? "design the slide without it"}`);
        continue;
      }
      const reference = refById.get(ref);
      if (reference) {
        lines.push(`  Place the uploaded image ${quoted(reference.name)}: ${reference.url} (view it with Read at ${reference.absPath})`);
      }
    }
    for (const id of slide.styleReferenceIds) {
      const reference = refById.get(id);
      if (reference) lines.push(`  Follow the style of ${quoted(reference.name)} (${reference.absPath}) without placing it`);
    }
  }

  if (references.length > 0) {
    lines.push("", "Uploaded reference images:");
    const editedOn = (id: string) =>
      x.assets.filter((a) => a.operation === "edit" && a.sourceIds?.[0] === id).flatMap((a) => a.targetSlides);
    for (const r of references) {
      const placedOn = x.slides.filter((sl) => sl.assetRefs.includes(r.id)).map((sl) => sl.index);
      const styleOn = x.slides.filter((sl) => sl.styleReferenceIds.includes(r.id)).map((sl) => sl.index);
      const role =
        placedOn.length > 0
          ? `placed as content on slide ${placedOn.join(", ")}${styleOn.length > 0 ? `; a style source on slide ${styleOn.join(", ")}` : ""}`
          : styleOn.length > 0
            ? `a style source only, on slide ${styleOn.join(", ")}; do not place it on any slide`
            : editedOn(r.id).length > 0
              ? `edited, with its background replaced, for slide ${editedOn(r.id).join(", ")}; place only the edited image, never this original`
              : "not used in this plan; do not place it on any slide";
      lines.push(`- ${quoted(r.name)} (${r.url}): ${role}.`);
    }
  }

  if (sources.length > 0) {
    lines.push("", "The plan was made from these linked pages:", ...sources.map((u) => `- ${u}`));
  }

  lines.push(
    "",
    "Director's notes (advisory):",
    `- Objective: ${s.objective}`,
    `- Audience: ${s.audience}`,
    `- Intended response: ${s.intendedResponse}`,
    `- Central message: ${s.centralMessage}`,
    ...(s.priorities.length > 0 ? [`- Priorities: ${s.priorities.join("; ")}`] : []),
    `- Creative direction: ${s.creativeDirection}`,
    ...(s.successCriteria.length > 0 ? [`- Success criteria: ${s.successCriteria.join("; ")}`] : []),
    HANDOFF_END
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Continuation (#127).

export const CONTINUATION_START = "--- Continuing an unfinished design ---";
export const CONTINUATION_END = "--- End of continuation ---";
export const ORIGINAL_TASK_START = "--- The original request, for reference ---";
export const ORIGINAL_TASK_END = "--- End of the original request ---";

export interface ContinuationInput {
  plan: ReadyPlan;
  /** The carousel's slides as they are now. */
  slides: readonly Pick<Slide, "id" | "order" | "notes">[];
  /** The exact task the interrupted run was given: the user's message and the visual plan. */
  originalTask: string;
  /**
   * Whether the Design Agent resumes the interrupted run's own conversation,
   * which already holds the original task. A new conversation is given it in full.
   */
  resumingSession: boolean;
}

/** A slide's note, shortened, on one line: the agent's own description of it. */
const noteOf = (notes: string | undefined) => {
  const line = (notes ?? "").replace(/\s+/g, " ").trim();
  return line ? ` - ${line.length > 80 ? `${line.slice(0, 79)}…` : line}` : "";
};

/**
 * The task message for an explicit Continue: what is saved, what is still
 * missing according to the stored plan, and how to finish without redoing or
 * duplicating work. Built from the carousel as it is now, never from what the
 * interrupted run reported. Pure; the Design Agent's system prompt is unchanged.
 */
export function buildContinuationMessage({ plan, slides, originalTask, resumingSession }: ContinuationInput): string {
  const x = plan.execution;
  const ordered = [...slides].sort((a, b) => a.order - b.order);
  const saved = ordered.length;
  const lines: string[] = [
    CONTINUATION_START,
    "The design for this carousel was interrupted before it finished. Continue it from where it stopped; do not start over.",
    "",
  ];
  if (saved === 0) {
    lines.push(`No slides are saved yet. The plan calls for ${x.slideCount}.`);
  } else {
    lines.push(`Saved so far: ${saved} slide${saved === 1 ? "" : "s"}, in this order (the plan calls for ${x.slideCount}):`);
    for (const [i, slide] of ordered.entries()) lines.push(`- Slide ${i + 1} (ID: ${slide.id})${noteOf(slide.notes)}`);
    lines.push(
      "",
      "Keep the saved slides as they are: do not delete, recreate, reorder or rewrite them, and do not create them again. Read their HTML with GET on the carousel first, so the new slides match their design: the same fonts, colours, margins and layout system."
    );
  }
  lines.push("");
  if (saved < x.slideCount) {
    const missing = x.slides.filter((sl) => sl.index > saved);
    lines.push(
      `Still to make: slide${x.slideCount - saved === 1 ? "" : "s"} ${saved + 1 === x.slideCount ? saved + 1 : `${saved + 1} to ${x.slideCount}`} of the plan.`,
      ...missing.map((sl) => `- Slide ${sl.index}: ${sl.treatment}. Visual intent: ${sl.visualIntent}`),
      `Create only these, one at a time and in order, with POST to this carousel's slides endpoint, so they follow the saved slides. Before each POST, check that the carousel still has fewer than ${x.slideCount} slides, so no slide is created twice. Stop when it has ${x.slideCount}.`
    );
  } else {
    lines.push(
      `The carousel already has all ${x.slideCount} slides the plan calls for. Finish only what the original request still needs, changing as little as possible: do not add, delete, recreate or reorder slides, and leave every finished slide as it is.`
    );
  }
  if (resumingSession) {
    lines.push("", "The original request and its visual plan are earlier in this conversation; follow them for everything else.", CONTINUATION_END);
    return lines.join("\n");
  }
  lines.push(
    "",
    "This is a new conversation, so the original request and its visual plan follow, for reference only. Follow them for the copy, design and images of the slides still to make; the saved slides above are already done.",
    CONTINUATION_END,
    "",
    ORIGINAL_TASK_START,
    originalTask,
    ORIGINAL_TASK_END
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Conformance.

export type DeviationKind = "slide_count" | "missing_placement" | "style_reference_placed" | "optional_unavailable";

export interface Deviation {
  kind: DeviationKind;
  /** User-facing, one sentence. */
  message: string;
}

export interface ConformanceResult {
  deviations: Deviation[];
  /** Facts reported without comparison, for example a user-requested count change. */
  notes: string[];
}

/**
 * Compares the finished slides with the plan's binding parts. Pure: the
 * slides are given in the carousel's order.
 */
export function checkConformance(
  plan: ReadyPlan,
  slides: readonly Pick<Slide, "html" | "order">[],
  assets: ReadonlyMap<string, ResolvedImage | null>,
  references: readonly ReferenceImage[]
): ConformanceResult {
  const ordered = [...slides].sort((a, b) => a.order - b.order);
  const x = plan.execution;
  const deviations: Deviation[] = [];
  const notes: string[] = [];

  if (x.slideCountBasis === "user-change") {
    notes.push(`The carousel now has ${ordered.length} slide${ordered.length === 1 ? "" : "s"}.`);
  } else if (ordered.length !== x.slideCount) {
    deviations.push({
      kind: "slide_count",
      message: `The plan called for ${x.slideCount} slide${x.slideCount === 1 ? "" : "s"}; the carousel has ${ordered.length}.`,
    });
  }

  const byKey = new Map(x.assets.map((a) => [a.key, a]));
  const refById = new Map(references.map((r) => [r.id, r]));
  const htmlOf = (index: number) => ordered[index - 1]?.html ?? "";

  for (const slide of x.slides) {
    for (const ref of slide.assetRefs) {
      const asset = byKey.get(ref);
      const url = asset ? assets.get(ref)?.url : refById.get(ref)?.url;
      // An optional image that could not be made is listed below; every image
      // that was made was handed over to be placed, required or not.
      if (asset && !assets.get(ref)) continue;
      if (url && !htmlOf(slide.index).includes(url)) {
        const what = asset ? "the planned image" : `the uploaded image ${quoted(refById.get(ref)!.name)}`;
        deviations.push({ kind: "missing_placement", message: `Slide ${slide.index} does not show ${what}.` });
      }
    }
  }

  const placedRefs = new Set(x.slides.flatMap((sl) => sl.assetRefs));
  const styleOnly = new Set(x.slides.flatMap((sl) => sl.styleReferenceIds).filter((id) => !placedRefs.has(id)));
  for (const id of styleOnly) {
    const reference = refById.get(id);
    if (!reference) continue;
    const on = ordered.map((sl, i) => (sl.html.includes(reference.url) ? i + 1 : 0)).filter(Boolean);
    if (on.length > 0) {
      deviations.push({
        kind: "style_reference_placed",
        message: `The style reference ${quoted(reference.name)} appears on slide ${on.join(", ")} although it was meant as a style source only.`,
      });
    }
  }

  for (const asset of x.assets) {
    if (!asset.required && assets.get(asset.key) === null) {
      deviations.push({
        kind: "optional_unavailable",
        message: `An optional image for slide ${asset.targetSlides.join(", ")} could not be made; the plan's alternative was used.`,
      });
    }
  }
  return { deviations, notes };
}
