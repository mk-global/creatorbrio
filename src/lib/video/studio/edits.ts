/**
 * The Studio timeline's edit commands (#150), as pure functions of the stored
 * production. Each returns the one change set a gesture or key press commits
 * (`{ summary, ops }`), or `null` when the command would change nothing, so
 * the page never sends a no-op and never keeps its own timeline model.
 *
 * Everything here is in whole timeline frames. Pointer positions arrive in
 * seconds and are rounded with `secondsToFrame` before any op is built.
 *
 * The rules mirror the change engine and admission (`changes/apply.ts`,
 * `invariants.ts`) so the page asks only for edits the store accepts:
 *   - clips on one track never overlap (a clip may start on the frame the
 *     previous one ends);
 *   - a trim keeps at least one frame, never starts before frame 0, and never
 *     reaches before the start or past the end of a media clip's source (the
 *     source span uses the engine's own `framesToSourceSpanUs` rounding);
 *   - a split falls strictly inside the clip and the new clip gets an id no
 *     other entity of the document uses;
 *   - timed captions keep their cues clip-relative, so a trim or split of a
 *     caption clip also rebases its cues in the same change set (otherwise
 *     the capability would refuse cues past the clip's new length).
 * The server stays the judge: a refusal is shown by the workspace and the
 * timeline draws what the store holds.
 */
import { framesToSourceSpanUs } from "@/lib/video/production/time";
import type { Clip, FrameRate, JsonValue, Production, Track } from "@/types/production";
import { secondsToFrame } from "./frames";
import type { ProductionOp } from "./types";

export interface Edit {
  /** What the person did, shown in the history and in a refusal. */
  summary: string;
  ops: ProductionOp[];
}

export type Edge = "in" | "out";

/** The id rule every entity of a production follows. */
export const CLIP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const clipEnd = (clip: Clip): number => clip.start + clip.duration;

export interface Located {
  track: Track;
  clip: Clip;
}

export function findClip(production: Production, clipId: string): Located | null {
  for (const track of production.timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** A lane's clips in timeline order. */
export function laneClips(track: Track): Clip[] {
  return [...track.clips].sort((a, b) => a.start - b.start || a.duration - b.duration);
}

/** The clips just before and just after `clipId` on its lane. */
export function neighbours(track: Track, clipId: string): { prev: Clip | null; next: Clip | null } {
  const lane = laneClips(track);
  const i = lane.findIndex((c) => c.id === clipId);
  if (i < 0) return { prev: null, next: null };
  return { prev: lane[i - 1] ?? null, next: lane[i + 1] ?? null };
}

/** Whether `[start, start + duration)` overlaps any other clip on the lane. */
export function overlaps(track: Track, clipId: string, start: number, duration: number): boolean {
  return track.clips.some((c) => c.id !== clipId && c.start < start + duration && start < clipEnd(c));
}

/** The starts a clip can move to without leaving the free space around it: `[prev end, next start - duration]`. */
export function moveRange(track: Track, clipId: string): { min: number; max: number } | null {
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const { prev, next } = neighbours(track, clipId);
  return { min: prev ? clipEnd(prev) : 0, max: next ? next.start - clip.duration : Number.POSITIVE_INFINITY };
}

/** The free start on the lane nearest to `start` for a clip of its length; ties go to the earlier one. */
export function nearestFreeStart(track: Track, clipId: string, start: number): number | null {
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const others = laneClips(track).filter((c) => c.id !== clipId);
  let best: number | null = null;
  let cursor = 0;
  const consider = (from: number, to: number) => {
    // A gap [from, to) holds the clip when it starts in [from, to - duration].
    const last = to - clip.duration;
    if (last < from) return;
    const candidate = Math.min(Math.max(start, from), last);
    if (best === null || Math.abs(candidate - start) < Math.abs(best - start)) best = candidate;
  };
  for (const other of others) {
    consider(cursor, other.start);
    cursor = Math.max(cursor, clipEnd(other));
  }
  consider(cursor, Number.POSITIVE_INFINITY);
  return best;
}

// ---------------------------------------------------------------------------
// Source limits

const speedOf = (clip: Clip): number => (clip.kind === "video" || clip.kind === "audio" ? clip.speed ?? 1 : 1);

/**
 * How far a media clip's edges can reach in timeline frames before its source
 * runs out: the earliest start (the source's first microsecond) and, when the
 * media's length is known, the latest end. `null` means no limit.
 */
export function sourceLimits(clip: Clip, fps: FrameRate, mediaDurationUs?: number): { earliestStart: number | null; latestEnd: number | null } {
  if (clip.kind !== "video" && clip.kind !== "audio") return { earliestStart: null, latestEnd: null };
  const speed = speedOf(clip);
  const { inUs } = clip.source;
  // The engine moves the in point by `framesToSourceSpanUs(delta)`; find the largest step back it accepts.
  let back = Math.floor((inUs * fps) / (1_000_000 * speed)) + 1;
  while (back > 0 && inUs + framesToSourceSpanUs(-back, fps, speed) < 0) back--;
  let latestEnd: number | null = null;
  if (mediaDurationUs !== undefined && Number.isFinite(mediaDurationUs)) {
    // The engine sets the out point to `inUs + framesToSourceSpanUs(duration)`; it may not pass the media's end.
    let span = Math.floor(((mediaDurationUs - inUs) * fps) / (1_000_000 * speed)) + 1;
    while (span > 0 && inUs + framesToSourceSpanUs(span, fps, speed) > mediaDurationUs) span--;
    latestEnd = clip.start + span;
  }
  return { earliestStart: clip.start - back, latestEnd };
}

/** The frames an edge can be trimmed to: at least one frame long, inside the free space and the source. */
export function trimRange(production: Production, clipId: string, edge: Edge, mediaDurationUs?: number): { min: number; max: number } | null {
  const found = findClip(production, clipId);
  if (!found) return null;
  const { track, clip } = found;
  const { prev, next } = neighbours(track, clipId);
  const limits = sourceLimits(clip, production.format.fps, mediaDurationUs);
  const range =
    edge === "in"
      ? { min: Math.max(0, prev ? clipEnd(prev) : 0, limits.earliestStart ?? 0), max: clipEnd(clip) - 1 }
      : { min: clip.start + 1, max: Math.min(next ? next.start : Number.POSITIVE_INFINITY, limits.latestEnd ?? Number.POSITIVE_INFINITY) };
  return range.min <= range.max ? range : null;
}

// ---------------------------------------------------------------------------
// Caption cues

const CAPTIONS = "captions.timed";

interface Cue {
  start: number;
  end: number;
  text: string;
}

function captionCues(clip: Clip): { params: Record<string, JsonValue>; cues: Cue[] } | null {
  if (clip.kind !== "graphics" || clip.capability.id !== CAPTIONS) return null;
  const params = clip.capability.params;
  if (!params || typeof params !== "object" || Array.isArray(params) || !Array.isArray(params.cues)) return null;
  const cues: Cue[] = [];
  for (const cue of params.cues) {
    if (!cue || typeof cue !== "object" || Array.isArray(cue)) return null;
    if (typeof cue.start !== "number" || typeof cue.end !== "number" || typeof cue.text !== "string") return null;
    cues.push({ start: cue.start, end: cue.end, text: cue.text });
  }
  return { params, cues };
}

/**
 * The caption cues of a clip whose content now starts `offset` frames later
 * (negative: earlier) and lasts `duration` frames: shifted, clipped to the
 * clip and dropped when nothing of them is left. Cues keep their place in
 * timeline time. Returns the params to set, or null when nothing changes.
 */
export function rebaseCaptionParams(clip: Clip, offset: number, duration: number): JsonValue | null {
  const found = captionCues(clip);
  if (!found) return null;
  const cues = found.cues
    .map((c) => ({ start: Math.max(0, c.start - offset), end: Math.min(duration, c.end - offset), text: c.text }))
    .filter((c) => c.end > c.start);
  const same = cues.length === found.cues.length && cues.every((c, i) => c.start === found.cues[i].start && c.end === found.cues[i].end);
  if (same) return null;
  return { ...found.params, cues: cues.map((c) => ({ start: c.start, end: c.end, text: c.text })) };
}

// ---------------------------------------------------------------------------
// Commands

/** Moves a clip within its lane to `start`, clamped to the nearest free position. */
export function planMove(production: Production, clipId: string, start: number): Edit | null {
  const found = findClip(production, clipId);
  if (!found) return null;
  const to = nearestFreeStart(found.track, clipId, Math.max(0, Math.round(start)));
  if (to === null || to === found.clip.start) return null;
  return { summary: "Move clip", ops: [{ op: "moveClip", clipId, start: to }] };
}

/** A pointer drop: the dragged start in seconds, rounded to a frame. The length always comes from the store. */
export function planMoveGesture(production: Production, clipId: string, startSeconds: number): Edit | null {
  return planMove(production, clipId, secondsToFrame(startSeconds, production.format.fps));
}

/** Nudges a clip by whole frames, stopping at the timeline start and against its neighbours. */
export function planNudge(production: Production, clipId: string, deltaFrames: number): Edit | null {
  const found = findClip(production, clipId);
  if (!found || deltaFrames === 0) return null;
  const range = moveRange(found.track, clipId);
  if (!range) return null;
  const to = Math.min(Math.max(found.clip.start + Math.round(deltaFrames), range.min), range.max);
  if (to === found.clip.start) return null;
  return { summary: "Move clip", ops: [{ op: "moveClip", clipId, start: to }] };
}

/** Trims one edge to `toFrame`, clamped to what the lane and the source allow. */
export function planTrim(production: Production, clipId: string, edge: Edge, toFrame: number, mediaDurationUs?: number): Edit | null {
  const found = findClip(production, clipId);
  if (!found) return null;
  const range = trimRange(production, clipId, edge, mediaDurationUs);
  if (!range) return null;
  const { clip } = found;
  const to = Math.min(Math.max(Math.round(toFrame), range.min), range.max);
  const current = edge === "in" ? clip.start : clipEnd(clip);
  if (to === current) return null;
  const ops: ProductionOp[] = [{ op: "trimClip", clipId, edge, toFrame: to }];
  const params = edge === "in" ? rebaseCaptionParams(clip, to - clip.start, clipEnd(clip) - to) : rebaseCaptionParams(clip, 0, to - clip.start);
  if (params !== null) ops.push({ op: "setGraphicParams", clipId, params });
  return { summary: edge === "in" ? "Trim clip start" : "Trim clip end", ops };
}

/** A pointer trim: the widget's `dir` names the edge, and only that edge's position (in seconds) is used. */
export function planTrimGesture(
  production: Production,
  clipId: string,
  dir: "left" | "right",
  startSeconds: number,
  endSeconds: number,
  mediaDurationUs?: number
): Edit | null {
  const fps = production.format.fps;
  return dir === "left"
    ? planTrim(production, clipId, "in", secondsToFrame(startSeconds, fps), mediaDurationUs)
    : planTrim(production, clipId, "out", secondsToFrame(endSeconds, fps), mediaDurationUs);
}

/** Moves one edge by whole frames (negative: earlier). */
export function planTrimNudge(production: Production, clipId: string, edge: Edge, deltaFrames: number, mediaDurationUs?: number): Edit | null {
  const found = findClip(production, clipId);
  if (!found || deltaFrames === 0) return null;
  const current = edge === "in" ? found.clip.start : clipEnd(found.clip);
  return planTrim(production, clipId, edge, current + Math.round(deltaFrames), mediaDurationUs);
}

/** Every id the document's entities use; a new id must not be one of them (admission's `checkUniqueIds`). */
export function documentIds(production: Production): Set<string> {
  const ids = new Set<string>([production.id]);
  for (const d of production.deliverables) ids.add(d.id);
  for (const s of production.research?.sources ?? []) ids.add(s.id);
  for (const c of production.research?.claims ?? []) ids.add(c.id);
  for (const h of production.script?.hookOptions ?? []) ids.add(h.id);
  for (const s of production.script?.sections ?? []) {
    ids.add(s.id);
    for (const l of s.lines) ids.add(l.id);
  }
  if (production.storyboard) {
    ids.add(production.storyboard.id);
    for (const s of production.storyboard.scenes) {
      ids.add(s.id);
      for (const slot of s.slots) ids.add(slot.id);
      for (const f of s.frames) ids.add(f.id);
    }
  }
  for (const t of production.timeline.tracks) {
    ids.add(t.id);
    for (const c of t.clips) {
      ids.add(c.id);
      if (c.kind === "video" || c.kind === "still") for (const e of c.effects ?? []) ids.add(e.id);
    }
  }
  for (const m of production.timeline.markers) ids.add(m.id);
  for (const c of production.review.comments) ids.add(c.id);
  return ids;
}

/**
 * A fresh id for the right half of a split of `clipId`: the clip's id without
 * a trailing `-<n>`, plus the smallest `-<n>` (from 2) that no entity uses,
 * including the effect ids the split derives from it. Always matches
 * `CLIP_ID_PATTERN`.
 */
export function newClipId(production: Production, clipId: string): string {
  const taken = documentIds(production);
  const found = findClip(production, clipId);
  const effects = found && (found.clip.kind === "video" || found.clip.kind === "still") ? (found.clip.effects?.length ?? 0) : 0;
  const base = (clipId.replace(/-\d+$/, "") || "clip").slice(0, 52);
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (taken.has(id)) continue;
    if (Array.from({ length: effects }, (_, k) => `${id}-fx${k}`).some((e) => taken.has(e))) continue;
    return id;
  }
}

/** Splits a clip at `atFrame` (the playhead) when it falls strictly inside the clip. */
export function planSplit(production: Production, clipId: string, atFrame: number): Edit | null {
  const found = findClip(production, clipId);
  if (!found) return null;
  const { clip } = found;
  const at = Math.round(atFrame);
  if (at <= clip.start || at >= clipEnd(clip)) return null;
  const newClipId_ = newClipId(production, clipId);
  const ops: ProductionOp[] = [{ op: "splitClip", clipId, atFrame: at, newClipId: newClipId_ }];
  const left = rebaseCaptionParams(clip, 0, at - clip.start);
  const right = rebaseCaptionParams(clip, at - clip.start, clipEnd(clip) - at);
  if (left !== null) ops.push({ op: "setGraphicParams", clipId, params: left });
  if (right !== null) ops.push({ op: "setGraphicParams", clipId: newClipId_, params: right });
  return { summary: "Split clip", ops };
}

/** Deletes a clip and leaves its space empty (no ripple). */
export function planRemove(production: Production, clipId: string): Edit | null {
  if (!findClip(production, clipId)) return null;
  return { summary: "Delete clip", ops: [{ op: "removeClip", clipId, ripple: false }] };
}

/**
 * Swaps a clip with its neighbour before (`earlier`) or after (`later`) it on
 * the lane, in one change set. The pair keeps its overall span and the gap
 * between the two, so nothing else on the lane is touched; overlap is checked
 * on the final state only, so the two moves are one op list.
 */
export function planReorder(production: Production, clipId: string, direction: "earlier" | "later"): Edit | null {
  const found = findClip(production, clipId);
  if (!found) return null;
  const { prev, next } = neighbours(found.track, clipId);
  const [first, second] = direction === "earlier" ? [prev, found.clip] : [found.clip, next];
  if (!first || !second) return null;
  const gap = second.start - clipEnd(first);
  const secondTo = first.start;
  const firstTo = first.start + second.duration + gap;
  return {
    summary: direction === "earlier" ? "Move clip earlier" : "Move clip later",
    ops: [
      { op: "moveClip", clipId: second.id, start: secondTo },
      { op: "moveClip", clipId: first.id, start: firstTo },
    ],
  };
}
