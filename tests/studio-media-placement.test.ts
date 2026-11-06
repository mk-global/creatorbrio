/**
 * "Add to timeline" in the Studio's media bin (#150): one change set that
 * lists the media (only when the production does not yet) and places one
 * clip at the end of its Studio track, with a source range inside the media
 * and a whole-frame duration that agrees with it. Checked against the pure
 * engine and admission with a ledger, so "accepted" means what the store
 * would accept.
 */
import { describe, expect, it } from "vitest";

import { applyChangeSet } from "@/lib/video/production/changes";
import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { durationMatchesSourceSpan } from "@/lib/video/production/time";
import type { LedgerMedia } from "@/lib/video/production/invariants";
import { mediaInProduction, mediaLabel, placeMedia, STILL_SECONDS, trackEnd, wholeFrames } from "@/lib/video/studio/media-placement";
import type { MediaView, ProductionOp } from "@/lib/video/studio/types";
import type { FrameRate, Production } from "@/types/production";

const hex = (c: string) => c.repeat(64);

function media(kind: MediaView["kind"], mediaId: string, durationUs?: number, originalName = `${kind}.bin`): MediaView {
  return {
    mediaId,
    kind,
    originalName,
    sizeBytes: 1,
    importedAt: "2026-11-06T00:00:00.000Z",
    facts: { kind, container: "synthetic", ...(durationUs === undefined ? {} : { durationUs }) },
    provenance: { source: "local-file", rights: "user-supplied" },
    derived: { state: "queued", attempts: 0, files: [] },
  };
}

const VIDEO = media("video", hex("a"), 2_016_000, "footage.mov");
const AUDIO = media("audio", hex("b"), 5_000_000, "music.m4a");
const IMAGE = media("image", hex("c"), undefined, "still.png");

const ledger = (...list: MediaView[]) => new Map<string, LedgerMedia>(list.map((m) => [m.mediaId, { kind: m.kind, durationUs: m.facts.durationUs }]));

function fresh(fps: FrameRate = 30): Production {
  const p = newEditProduction({ id: "placement", name: "Placement", at: "2026-01-01T00:00:00.000Z" });
  return { ...p, format: { ...p.format, fps }, deliverables: p.deliverables.map((d) => ({ ...d, format: { ...d.format, fps } })) };
}

let n = 0;
function commit(production: Production, ops: ProductionOp[], ...known: MediaView[]): Production {
  const result = applyChangeSet(
    production,
    { id: `cs-${++n}`, baseRevision: production.revision, at: "2026-01-02T00:00:00.000Z", by: "user", summary: "Add", ops },
    { ledger: ledger(...known) }
  );
  if (result.status !== "applied") throw new Error(JSON.stringify(result));
  return result.production;
}

function place(production: Production, m: MediaView, clipId: string): { summary: string; ops: ProductionOp[] } {
  const placed = placeMedia(production, m, clipId);
  if (!placed.ok) throw new Error(placed.reason);
  expect(placed.clipId).toBe(clipId);
  return placed;
}

const clipsOn = (p: Production, trackId: string) => p.timeline.tracks.find((t) => t.id === trackId)!.clips;

describe("adding media to the timeline", () => {
  it("lists a video as a-roll and places it on the footage track over the whole media", () => {
    const { summary, ops } = place(fresh(), VIDEO, "c1");
    expect(summary).toBe("Add footage.mov");
    // 2.016 s at 30 fps is 60.48 frames: 60 whole frames, exactly 2 s of source.
    expect(ops).toEqual([
      { op: "addMedia", media: { mediaId: VIDEO.mediaId, role: "a-roll", label: "footage.mov" } },
      { op: "insertClip", trackId: STUDIO_TRACKS.footage, clip: { kind: "video", id: "c1", start: 0, duration: 60, source: { mediaId: VIDEO.mediaId, inUs: 0, outUs: 2_000_000 } } },
    ]);
    const after = commit(fresh(), ops, VIDEO);
    expect(clipsOn(after, STUDIO_TRACKS.footage)).toEqual([expect.objectContaining({ id: "c1", start: 0, duration: 60 })]);
  });

  it("lists audio as music with an empty gain envelope, and an image as a three-second still", () => {
    const audio = place(fresh(), AUDIO, "m1").ops;
    expect(audio[0]).toEqual({ op: "addMedia", media: { mediaId: AUDIO.mediaId, role: "music", label: "music.m4a" } });
    expect(audio[1]).toEqual({ op: "insertClip", trackId: STUDIO_TRACKS.music, clip: { kind: "audio", id: "m1", start: 0, duration: 150, source: { mediaId: AUDIO.mediaId, inUs: 0, outUs: 5_000_000 }, gainDb: [] } });
    const image = place(fresh(), IMAGE, "s1").ops;
    expect(image).toEqual([
      { op: "addMedia", media: { mediaId: IMAGE.mediaId, role: "image", label: "still.png" } },
      { op: "insertClip", trackId: STUDIO_TRACKS.images, clip: { kind: "still", id: "s1", start: 0, duration: STILL_SECONDS * 30, mediaId: IMAGE.mediaId } },
    ]);
    const after = commit(commit(fresh(), audio, AUDIO), image, AUDIO, IMAGE);
    expect(after.media.map((m) => m.role)).toEqual(["music", "image"]);
  });

  it("places the next clip where the track's last clip ends and does not list the media twice", () => {
    let p = commit(fresh(), place(fresh(), VIDEO, "c1").ops, VIDEO);
    expect(trackEnd(p, STUDIO_TRACKS.footage)).toBe(60);
    expect(mediaInProduction(p, VIDEO.mediaId)).toBe(true);
    expect(mediaInProduction(p, AUDIO.mediaId)).toBe(false);
    const second = place(p, VIDEO, "c2").ops;
    expect(second).toEqual([expect.objectContaining({ op: "insertClip", clip: expect.objectContaining({ id: "c2", start: 60 }) })]);
    p = commit(p, second, VIDEO);
    expect(clipsOn(p, STUDIO_TRACKS.footage).map((c) => [c.id, c.start])).toEqual([["c1", 0], ["c2", 60]]);
    // Other tracks start from their own end, not the timeline's.
    expect(place(p, IMAGE, "s1").ops[1]).toMatchObject({ clip: { start: 0 } });
  });

  it("keeps the source range inside the media and in agreement with the duration at every rate", () => {
    const rates: FrameRate[] = [24, 25, 30, 60];
    const durations = [1, 33_333, 33_334, 41_667, 999_999, 1_000_000, 2_002_000, 7_777_777, 59_999_999, 3_600_000_001];
    for (const fps of rates) {
      for (const durationUs of durations) {
        const m = media("video", hex("d"), durationUs);
        const placed = placeMedia(fresh(fps), m, "c1");
        const frames = wholeFrames(durationUs, fps);
        if (frames < 1) {
          expect(placed).toEqual({ ok: false, reason: expect.stringContaining("shorter than one frame") });
          continue;
        }
        if (!placed.ok) throw new Error(placed.reason);
        const clip = (placed.ops[1] as Extract<ProductionOp, { op: "insertClip" }>).clip as { duration: number; source: { inUs: number; outUs: number } };
        expect(clip.duration).toBe(frames);
        expect(clip.source.inUs).toBe(0);
        expect(clip.source.outUs).toBeLessThanOrEqual(durationUs);
        expect(durationMatchesSourceSpan(clip.duration, 0, clip.source.outUs, fps)).toBe(true);
      }
    }
  });

  it("refuses media without a length and productions without the Studio's tracks", () => {
    expect(placeMedia(fresh(), media("audio", hex("e")), "c1")).toEqual({ ok: false, reason: expect.stringContaining("shorter than one frame") });
    const bare = { ...fresh(), timeline: { ...fresh().timeline, tracks: fresh().timeline.tracks.filter((t) => t.id !== STUDIO_TRACKS.music) } };
    expect(placeMedia(bare, AUDIO, "c1")).toEqual({ ok: false, reason: expect.stringContaining("no music track") });
  });

  it("labels media by file name within the document's limit", () => {
    expect(mediaLabel("clip.mov")).toBe("clip.mov");
    expect(mediaLabel("  tab\there.mov ")).toBe("tab here.mov");
    expect(mediaLabel("\u0007")).toBe("Untitled media");
    expect(mediaLabel("x".repeat(255))).toHaveLength(200);
    // A pair of surrogates is never cut in half.
    expect(mediaLabel("x".repeat(199) + "\u{1F3AC}" + "y")).toBe("x".repeat(199));
    const long = place(fresh(), media("video", hex("f"), 1_000_000, `${"long name ".repeat(10)}.mov`), "c1");
    expect(long.summary.length).toBeLessThanOrEqual(64);
    expect(long.summary.endsWith("…")).toBe(true);
  });
});
