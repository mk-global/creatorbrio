/**
 * The Studio timeline's edit commands (#150): every gesture and key press
 * becomes one change set in whole frames that the store would accept, or
 * nothing at all. Synthetic productions only; the routes test proves the
 * server accepts what these build.
 */
import { describe, expect, it } from "vitest";

import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { framesToSourceSpanUs } from "@/lib/video/production/time";
import {
  CLIP_ID_PATTERN,
  documentIds,
  moveRange,
  nearestFreeStart,
  neighbours,
  newClipId,
  overlaps,
  planMove,
  planMoveGesture,
  planNudge,
  planRemove,
  planReorder,
  planSplit,
  planTrim,
  planTrimGesture,
  planTrimNudge,
  rebaseCaptionParams,
  sourceLimits,
  trimRange,
} from "@/lib/video/studio/edits";
import type { AudioClip, Clip, GraphicsClip, Production, StillClip, VideoClip } from "@/types/production";

const prov = { by: "user", changeSetId: "cs-0" } as const;
const MEDIA_V = "a".repeat(64);
const MEDIA_A = "c".repeat(64);
const MEDIA_I = "d".repeat(64);

const video = (id: string, start: number, duration: number, inUs = 0, extra: Partial<VideoClip> = {}): VideoClip => ({
  id,
  kind: "video",
  start,
  duration,
  source: { mediaId: MEDIA_V, inUs, outUs: inUs + framesToSourceSpanUs(duration, 30, extra.speed ?? 1) },
  provenance: prov,
  ...extra,
});
const audio = (id: string, start: number, duration: number, inUs = 0): AudioClip => ({
  id,
  kind: "audio",
  start,
  duration,
  source: { mediaId: MEDIA_A, inUs, outUs: inUs + framesToSourceSpanUs(duration, 30) },
  gainDb: [],
  provenance: prov,
});
const still = (id: string, start: number, duration: number): StillClip => ({ id, kind: "still", start, duration, mediaId: MEDIA_I, provenance: prov });
const title = (id: string, start: number, duration: number): GraphicsClip => ({
  id,
  kind: "graphics",
  start,
  duration,
  layer: "front",
  capability: { id: "graphics.title-card", version: "1.0.0", params: { title: "Hello", align: "center", scrim: true } },
  provenance: prov,
});
const captions = (id: string, start: number, duration: number, cues: { start: number; end: number; text: string }[]): GraphicsClip => ({
  id,
  kind: "graphics",
  start,
  duration,
  layer: "front",
  capability: { id: "captions.timed", version: "1.0.0", params: { preset: "sentence", position: "lower", cues } },
  provenance: prov,
});

/** A production with the given clips on the Studio tracks. */
function production(clips: { footage?: Clip[]; images?: Clip[]; music?: Clip[]; titles?: Clip[]; captions?: Clip[] }): Production {
  const p = newEditProduction({ id: "p1", name: "Edits", at: "2026-01-01T00:00:00.000Z" });
  for (const track of p.timeline.tracks) {
    const key = (Object.keys(STUDIO_TRACKS) as (keyof typeof STUDIO_TRACKS)[]).find((k) => STUDIO_TRACKS[k] === track.id)!;
    (track.clips as Clip[]) = clips[key] ?? [];
  }
  return p;
}

const footage = (p: Production) => p.timeline.tracks.find((t) => t.id === STUDIO_TRACKS.footage)!;

describe("lane geometry", () => {
  const p = production({ footage: [video("c", 100, 30), video("a", 0, 30), video("b", 40, 20)] });

  it("orders neighbours by start, not by storage order", () => {
    expect(neighbours(footage(p), "b")).toMatchObject({ prev: { id: "a" }, next: { id: "c" } });
    expect(neighbours(footage(p), "a")).toMatchObject({ prev: null, next: { id: "b" } });
    expect(neighbours(footage(p), "missing")).toEqual({ prev: null, next: null });
  });

  it("treats touching clips as not overlapping, as the store does", () => {
    expect(overlaps(footage(p), "b", 30, 20)).toBe(false);
    expect(overlaps(footage(p), "b", 29, 20)).toBe(true);
    expect(overlaps(footage(p), "b", 81, 20)).toBe(true);
    expect(overlaps(footage(p), "b", 80, 20)).toBe(false);
  });

  it("keeps a move inside the free space around the clip", () => {
    expect(moveRange(footage(p), "b")).toEqual({ min: 30, max: 80 });
    expect(moveRange(footage(p), "a")).toEqual({ min: 0, max: 10 });
    expect(moveRange(footage(p), "c")).toEqual({ min: 60, max: Number.POSITIVE_INFINITY });
  });

  it("finds the nearest free start for a drop, in any gap", () => {
    expect(nearestFreeStart(footage(p), "b", 50)).toBe(50);
    expect(nearestFreeStart(footage(p), "b", 25)).toBe(30);
    expect(nearestFreeStart(footage(p), "b", 95)).toBe(80);
    // Past the last clip a 20-frame clip fits from 130 on.
    expect(nearestFreeStart(footage(p), "b", 120)).toBe(130);
    // A clip that fits in no gap before "c" lands after it.
    const q = production({ footage: [video("a", 0, 30), video("b", 40, 20), video("x", 200, 50)] });
    expect(nearestFreeStart(footage(q), "x", 35)).toBe(60);
  });
});

describe("moves", () => {
  const p = production({ footage: [video("a", 0, 30), video("b", 40, 20), video("c", 100, 30)] });

  it("rounds a pointer drop to the nearest whole frame before building the op", () => {
    expect(planMoveGesture(p, "b", 1.651)).toEqual({ summary: "Move clip", ops: [{ op: "moveClip", clipId: "b", start: 50 }] });
    expect(planMoveGesture(p, "b", 1.649)).toEqual({ summary: "Move clip", ops: [{ op: "moveClip", clipId: "b", start: 49 }] });
  });

  it("clamps a drop that would overlap a neighbour to the free position next to it", () => {
    expect(planMove(p, "b", 25)!.ops).toEqual([{ op: "moveClip", clipId: "b", start: 30 }]);
    expect(planMove(p, "b", 95)!.ops).toEqual([{ op: "moveClip", clipId: "b", start: 80 }]);
  });

  it("never moves before the timeline start", () => {
    expect(planMoveGesture(p, "a", -3)).toBeNull();
    expect(planMove(production({ footage: [video("a", 10, 30)] }), "a", -5)!.ops).toEqual([{ op: "moveClip", clipId: "a", start: 0 }]);
  });

  it("sends nothing for a drop that rounds back to where the clip was", () => {
    expect(planMoveGesture(p, "b", 40.4 / 30)).toBeNull();
    expect(planMove(p, "missing", 10)).toBeNull();
  });

  it("nudges by frames and seconds, stopping at the start and against neighbours", () => {
    expect(planNudge(p, "b", 1)!.ops).toEqual([{ op: "moveClip", clipId: "b", start: 41 }]);
    expect(planNudge(p, "b", -30)!.ops).toEqual([{ op: "moveClip", clipId: "b", start: 30 }]);
    expect(planNudge(p, "b", 30)!.ops).toEqual([{ op: "moveClip", clipId: "b", start: 70 }]);
    expect(planNudge(p, "b", 300)!.ops).toEqual([{ op: "moveClip", clipId: "b", start: 80 }]);
    // Already at the timeline start, or flush against a neighbour: nothing to send.
    expect(planNudge(p, "a", -1)).toBeNull();
    const flush = production({ footage: [video("a", 0, 30), video("b", 30, 20)] });
    expect(planNudge(flush, "b", -1)).toBeNull();
    expect(planNudge(flush, "a", 1)).toBeNull();
    expect(planNudge(p, "b", 0)).toBeNull();
  });

  it("moves the last clip on a lane freely to the right", () => {
    expect(planNudge(p, "c", 3000)!.ops).toEqual([{ op: "moveClip", clipId: "c", start: 3100 }]);
  });
});

describe("source limits", () => {
  it("lets the in edge reach the source's first microsecond, by the engine's rounding", () => {
    const clip = video("a", 100, 30, 1_000_000);
    expect(sourceLimits(clip, 30)).toEqual({ earliestStart: 70, latestEnd: null });
    // 0.51 s in: 15 frames back reach 0.01 s, 16 would reach before the start.
    expect(sourceLimits(video("a", 100, 30, 510_000), 30).earliestStart).toBe(85);
    // At speed 2 each frame covers twice the source.
    expect(sourceLimits(video("a", 100, 30, 1_000_000, { speed: 2 }), 30).earliestStart).toBe(85);
  });

  it("lets the out edge reach the media's end when its length is known", () => {
    const clip = video("a", 100, 30, 1_000_000);
    expect(sourceLimits(clip, 30, 3_000_000).latestEnd).toBe(160);
    // A length that does not divide into frames stops at the last whole frame inside it.
    expect(sourceLimits(clip, 30, 3_020_000).latestEnd).toBe(160);
    expect(sourceLimits(clip, 30, 3_034_000).latestEnd).toBe(161);
    const l = sourceLimits(clip, 30, 3_034_000).latestEnd! - 100;
    expect(1_000_000 + framesToSourceSpanUs(l, 30)).toBeLessThanOrEqual(3_034_000);
  });

  it("puts no source limit on stills and graphics", () => {
    expect(sourceLimits(still("s", 0, 30), 30, 1)).toEqual({ earliestStart: null, latestEnd: null });
    expect(sourceLimits(title("t", 0, 30), 30)).toEqual({ earliestStart: null, latestEnd: null });
  });
});

describe("trims", () => {
  const p = production({ footage: [video("a", 0, 30), video("b", 60, 30, 500_000), video("c", 120, 30)], titles: [title("t", 10, 30)] });

  it("rounds a pointer trim and uses only the dragged edge", () => {
    expect(planTrimGesture(p, "b", "left", 2.49, 3.0001)).toEqual({ summary: "Trim clip start", ops: [{ op: "trimClip", clipId: "b", edge: "in", toFrame: 75 }] });
    expect(planTrimGesture(p, "b", "right", 2.0, 3.49)).toEqual({ summary: "Trim clip end", ops: [{ op: "trimClip", clipId: "b", edge: "out", toFrame: 105 }] });
  });

  it("never makes a clip shorter than one frame", () => {
    expect(planTrim(p, "b", "in", 200)!.ops).toEqual([{ op: "trimClip", clipId: "b", edge: "in", toFrame: 89 }]);
    expect(planTrim(p, "b", "out", 0)!.ops).toEqual([{ op: "trimClip", clipId: "b", edge: "out", toFrame: 61 }]);
    const one = production({ titles: [title("t", 10, 1)] });
    expect(planTrimNudge(one, "t", "in", 1)).toBeNull();
    expect(planTrimNudge(one, "t", "out", -1)).toBeNull();
  });

  it("stops at the neighbours and the timeline start", () => {
    expect(planTrim(p, "b", "in", 10)!.ops[0]).toMatchObject({ toFrame: 45 }); // the source runs out at 0.5 s before
    expect(planTrim(p, "a", "out", 100)!.ops[0]).toMatchObject({ toFrame: 60 });
    expect(planTrim(p, "t", "in", -40)!.ops[0]).toMatchObject({ toFrame: 0 });
    expect(planTrimNudge(p, "a", "in", -1)).toBeNull(); // already at frame 0 and at its source start
  });

  it("stops at the source's start and, when known, its end", () => {
    const q = production({ footage: [video("v", 100, 30, 1_000_000)] });
    expect(trimRange(q, "v", "in")).toEqual({ min: 70, max: 129 });
    expect(trimRange(q, "v", "out", 2_000_000)).toEqual({ min: 101, max: 130 });
    expect(trimRange(q, "v", "out")).toEqual({ min: 101, max: Number.POSITIVE_INFINITY });
    expect(planTrim(q, "v", "in", 0)!.ops[0]).toMatchObject({ toFrame: 70 });
    expect(planTrim(q, "v", "out", 500, 3_000_000)!.ops[0]).toMatchObject({ toFrame: 160 });
    expect(planTrim(q, "v", "out", 500, 2_000_000)).toBeNull(); // already at the media's end
    expect(planTrimNudge(q, "v", "out", 1, 2_000_000)).toBeNull(); // already at the media's end
    expect(planTrimNudge(q, "v", "out", 30)!.ops[0]).toMatchObject({ toFrame: 160 }); // length unknown: the server judges
  });

  it("extends a still or graphic freely to the right", () => {
    const q = production({ images: [still("s", 0, 30)] });
    expect(planTrimNudge(q, "s", "out", 30)!.ops[0]).toMatchObject({ toFrame: 60 });
  });

  it("sends nothing for a trim that rounds back to the same edge or names an unknown clip", () => {
    expect(planTrimGesture(p, "b", "left", 2.01, 3)).toBeNull();
    expect(planTrim(p, "missing", "in", 3)).toBeNull();
    expect(planTrimNudge(p, "b", "in", 0)).toBeNull();
  });

  it("works on audio clips by the same source rules", () => {
    const q = production({ music: [audio("m", 0, 90, 0)] });
    expect(planTrimNudge(q, "m", "in", -1)).toBeNull();
    expect(planTrimNudge(q, "m", "out", 30, 3_000_000)).toBeNull();
    expect(planTrimNudge(q, "m", "out", -30)!.ops[0]).toMatchObject({ edge: "out", toFrame: 60 });
  });
});

describe("caption cues follow a trim or split", () => {
  const cues = [
    { start: 0, end: 10, text: "One" },
    { start: 10, end: 25, text: "Two" },
    { start: 30, end: 40, text: "Three" },
  ];
  const p = production({ captions: [captions("cap", 30, 40, cues)] });

  it("drops and clips cues past a shortened end", () => {
    const edit = planTrim(p, "cap", "out", 50)!;
    expect(edit.ops[0]).toEqual({ op: "trimClip", clipId: "cap", edge: "out", toFrame: 50 });
    expect(edit.ops[1]).toEqual({
      op: "setGraphicParams",
      clipId: "cap",
      params: { preset: "sentence", position: "lower", cues: [{ start: 0, end: 10, text: "One" }, { start: 10, end: 20, text: "Two" }] },
    });
  });

  it("keeps cues at their timeline time when the start moves", () => {
    const later = planTrim(p, "cap", "in", 45)!;
    expect(later.ops[1]).toMatchObject({ params: { cues: [{ start: 0, end: 10, text: "Two" }, { start: 15, end: 25, text: "Three" }] } });
    const earlier = planTrim(p, "cap", "in", 20)!;
    expect(earlier.ops[1]).toMatchObject({ params: { cues: [{ start: 10, end: 20, text: "One" }, { start: 20, end: 35, text: "Two" }, { start: 40, end: 50, text: "Three" }] } });
  });

  it("leaves the cues alone when the end only grows", () => {
    expect(planTrim(p, "cap", "out", 90)!.ops).toHaveLength(1);
  });

  it("gives each half of a split its own cues, a straddling cue in both", () => {
    const edit = planSplit(p, "cap", 45)!;
    expect(edit.ops[0]).toEqual({ op: "splitClip", clipId: "cap", atFrame: 45, newClipId: "cap-2" });
    expect(edit.ops[1]).toMatchObject({ clipId: "cap", params: { cues: [{ start: 0, end: 10 }, { start: 10, end: 15, text: "Two" }] } });
    expect(edit.ops[2]).toMatchObject({ clipId: "cap-2", params: { cues: [{ start: 0, end: 10, text: "Two" }, { start: 15, end: 25, text: "Three" }] } });
  });

  it("ignores other capabilities and malformed cue lists", () => {
    expect(rebaseCaptionParams(title("t", 0, 30), 5, 10)).toBeNull();
    const bad = captions("cap", 0, 30, []);
    (bad.capability.params as { cues: unknown }).cues = [{ start: "x" }];
    expect(rebaseCaptionParams(bad, 5, 10)).toBeNull();
  });
});

describe("splits", () => {
  it("splits strictly inside the clip at the playhead with a fresh id", () => {
    const p = production({ footage: [video("a", 0, 60)] });
    expect(planSplit(p, "a", 20)).toEqual({ summary: "Split clip", ops: [{ op: "splitClip", clipId: "a", atFrame: 20, newClipId: "a-2" }] });
    expect(planSplit(p, "a", 0)).toBeNull();
    expect(planSplit(p, "a", 60)).toBeNull();
    expect(planSplit(p, "a", 75)).toBeNull();
    expect(planSplit(p, "missing", 20)).toBeNull();
  });

  it("never reuses an id any entity of the document has", () => {
    const p = production({ footage: [video("clip-2", 0, 60), video("clip-3", 60, 30)], titles: [title("clip-4", 0, 30)] });
    expect(newClipId(p, "clip-2")).toBe("clip-5");
    p.timeline.markers.push({ id: "clip-5", fromFrame: 0, toFrame: 1, label: "m", by: "user" } as never);
    expect(documentIds(p).has("clip-5")).toBe(true);
    expect(newClipId(p, "clip-2")).toBe("clip-6");
    // Effect ids derived by the split must be free too.
    const fx = production({ footage: [video("v", 0, 60, 0, { effects: [{ id: "e", capability: { id: "fx.blur", version: "1.0.0", params: {} } }] })] });
    fx.timeline.markers.push({ id: "v-2-fx0", fromFrame: 0, toFrame: 1, label: "m", by: "user" } as never);
    expect(newClipId(fx, "v")).toBe("v-3");
  });

  it("makes ids that match the document's id rule, even from long ids", () => {
    const long = "x".repeat(64);
    const p = production({ footage: [video(long, 0, 60)] });
    const id = newClipId(p, long);
    expect(id).toMatch(CLIP_ID_PATTERN);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(newClipId(production({ footage: [video("9", 0, 60)] }), "9")).toMatch(CLIP_ID_PATTERN);
  });
});

describe("delete and reorder", () => {
  it("deletes without closing the gap", () => {
    const p = production({ footage: [video("a", 0, 30)] });
    expect(planRemove(p, "a")).toEqual({ summary: "Delete clip", ops: [{ op: "removeClip", clipId: "a", ripple: false }] });
    expect(planRemove(p, "missing")).toBeNull();
  });

  it("swaps a clip with its later neighbour, keeping the pair's span and the gap", () => {
    const p = production({ footage: [video("a", 10, 30), video("b", 50, 20), video("c", 70, 10)] });
    const edit = planReorder(p, "a", "later")!;
    expect(edit).toEqual({
      summary: "Move clip later",
      ops: [
        { op: "moveClip", clipId: "b", start: 10 },
        { op: "moveClip", clipId: "a", start: 40 },
      ],
    });
    // The final state has no overlap and nothing else moved.
    const after = { b: [10, 30], a: [40, 70], c: [70, 80] };
    expect(after.a[1]).toBeLessThanOrEqual(after.c[0]);
  });

  it("swaps a clip with its earlier neighbour", () => {
    const p = production({ footage: [video("a", 0, 30), video("b", 30, 20)] });
    expect(planReorder(p, "b", "earlier")!.ops).toEqual([
      { op: "moveClip", clipId: "b", start: 0 },
      { op: "moveClip", clipId: "a", start: 20 },
    ]);
  });

  it("has nothing to swap with at either end of the lane", () => {
    const p = production({ footage: [video("a", 0, 30), video("b", 30, 20)] });
    expect(planReorder(p, "a", "earlier")).toBeNull();
    expect(planReorder(p, "b", "later")).toBeNull();
    expect(planReorder(p, "missing", "later")).toBeNull();
  });
});
