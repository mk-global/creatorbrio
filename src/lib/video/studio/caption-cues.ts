/**
 * Editing a caption clip's cue list in the Inspector's draft (#150). These
 * operations only change the draft; the capability decides at Save whether
 * the cues are valid (in order, not overlapping, inside the clip), so they
 * never reorder or correct what the person typed.
 */
import type { CueDraft } from "./capability-forms";

/** How long a new cue lasts, in seconds, when there is room. */
export const NEW_CUE_SECONDS = 2;
export const NEW_CUE_TEXT = "New caption";

function frameOf(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * Where a new cue fits in a clip of `durationFrames`: right after the last
 * cue when there is room there, otherwise in the first gap between cues (or
 * before the first one). Null when the clip has no free frame. Cues whose
 * frames are not whole numbers yet are ignored.
 */
export function newCueRange(cues: readonly CueDraft[], durationFrames: number, fps: number): { start: number; end: number } | null {
  const want = Math.max(1, Math.round(NEW_CUE_SECONDS * fps));
  const spans = cues
    .map((cue) => ({ start: frameOf(cue.start), end: frameOf(cue.end) }))
    .filter((s): s is { start: number; end: number } => s.start !== null && s.end !== null && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const lastEnd = spans.reduce((max, s) => Math.max(max, s.end), 0);
  if (lastEnd < durationFrames) return { start: lastEnd, end: Math.min(durationFrames, lastEnd + want) };
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) return { start: cursor, end: Math.min(span.start, cursor + want) };
    cursor = Math.max(cursor, span.end);
  }
  return null;
}

/**
 * The cues with a new one at the first free place, kept in order of start.
 * When every frame is taken, the last cue long enough is split in two at its
 * middle and the new cue takes the second half, so a clip whose one cue spans
 * it (as a new caption clip's does) can still get a second cue. Null when no
 * cue can be split either.
 */
export function addCue(cues: readonly CueDraft[], durationFrames: number, fps: number): CueDraft[] | null {
  const range = newCueRange(cues, durationFrames, fps);
  if (!range) return splitLastCue(cues);
  const cue: CueDraft = { start: String(range.start), end: String(range.end), text: NEW_CUE_TEXT };
  const index = cues.findIndex((c) => {
    const start = frameOf(c.start);
    return start !== null && start > range.start;
  });
  return index < 0 ? [...cues, cue] : [...cues.slice(0, index), cue, ...cues.slice(index)];
}

function splitLastCue(cues: readonly CueDraft[]): CueDraft[] | null {
  let best = -1;
  cues.forEach((cue, i) => {
    const start = frameOf(cue.start);
    const end = frameOf(cue.end);
    if (start === null || end === null || end - start < 2) return;
    if (best < 0 || start > frameOf(cues[best].start)!) best = i;
  });
  if (best < 0) return null;
  const start = frameOf(cues[best].start)!;
  const end = frameOf(cues[best].end)!;
  const middle = start + Math.floor((end - start) / 2);
  return [...cues.slice(0, best), { ...cues[best], end: String(middle) }, { start: String(middle), end: String(end), text: NEW_CUE_TEXT }, ...cues.slice(best + 1)];
}

export function removeCue(cues: readonly CueDraft[], index: number): CueDraft[] {
  return cues.filter((_, i) => i !== index);
}

export function updateCue(cues: readonly CueDraft[], index: number, field: keyof CueDraft, value: string): CueDraft[] {
  return cues.map((cue, i) => (i === index ? { ...cue, [field]: value } : cue));
}
