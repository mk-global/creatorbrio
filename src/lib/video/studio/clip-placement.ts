/**
 * Placing a new graphics clip and describing a selected clip (#150).
 *
 * A new title card, lower third or caption clip goes at the playhead on its
 * track, or, when that spot is taken, at the first free position after it,
 * so inserting never overlaps a clip (the store would refuse it anyway). A
 * clip may start on the frame another one ends.
 */
import { STUDIO_TRACKS } from "@/lib/video/production/new-production";
import type { Clip, Production, Track } from "@/types/production";
import { CAPABILITY_VERSION, defaultDurationFrames, defaultParams, graphicKindInfo, graphicKindOf, type GraphicKind } from "./capability-forms";
import type { ProductionOp } from "./types";

/** The first start at or after `fromFrame` where `durationFrames` frames fit between the given clips. */
export function firstFreeStart(clips: readonly { start: number; duration: number }[], fromFrame: number, durationFrames: number): number {
  let start = Math.max(0, Math.floor(fromFrame));
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    const end = clip.start + clip.duration;
    if (end <= start) continue;
    if (clip.start >= start + durationFrames) break;
    start = end;
  }
  return start;
}

export type GraphicInsert =
  | { ok: true; clipId: string; trackId: string; start: number; duration: number; op: ProductionOp }
  | { ok: false; reason: string };

/** The one operation that inserts a new `kind` clip with id `clipId` at or after `playheadFrame`. */
export function insertGraphic(production: Production, kind: GraphicKind, playheadFrame: number, clipId: string): GraphicInsert {
  const info = graphicKindInfo(kind);
  const track = production.timeline.tracks.find((t) => t.id === info.trackId);
  if (!track || track.kind !== "graphics") return { ok: false, reason: `This production has no ${trackLabel(info.trackId).toLowerCase()} track.` };
  const duration = defaultDurationFrames(kind, production.format.fps);
  const start = firstFreeStart(track.clips, playheadFrame, duration);
  return {
    ok: true,
    clipId,
    trackId: track.id,
    start,
    duration,
    op: {
      op: "insertClip",
      trackId: track.id,
      clip: { kind: "graphics", id: clipId, start, duration, layer: "front", capability: { id: info.capabilityId, version: CAPABILITY_VERSION, params: defaultParams(kind, duration) } },
    },
  };
}

const TRACK_LABELS: Record<string, string> = {
  [STUDIO_TRACKS.footage]: "Footage",
  [STUDIO_TRACKS.images]: "Images",
  [STUDIO_TRACKS.music]: "Music",
  [STUDIO_TRACKS.titles]: "Titles",
  [STUDIO_TRACKS.captions]: "Captions",
};

/** A track's name for people: its Studio role, or its id for a track the Studio did not make. */
export function trackLabel(trackId: string): string {
  return TRACK_LABELS[trackId] ?? trackId;
}

export interface ClipFacts {
  clip: Clip;
  track: Track;
  /** The kind of clip in words, e.g. "Video", "Title card". */
  kindLabel: string;
  start: number;
  end: number;
  length: number;
  /** For video and audio clips: the source range in frames at the production's rate. */
  source: { mediaId: string; inFrame: number; outFrame: number } | null;
  /** For media clips: the media's label in the production, if it has one. */
  mediaLabel: string | null;
}

/** What the Inspector shows about clip `clipId`, or null when the production has no such clip. */
export function clipFacts(production: Production, clipId: string): ClipFacts | null {
  for (const track of production.timeline.tracks) {
    const clip = (track.clips as Clip[]).find((c) => c.id === clipId);
    if (!clip) continue;
    const fps = production.format.fps;
    const usToFrame = (us: number) => Math.round((us * fps) / 1_000_000);
    const source = clip.kind === "video" || clip.kind === "audio" ? { mediaId: clip.source.mediaId, inFrame: usToFrame(clip.source.inUs), outFrame: usToFrame(clip.source.outUs) } : null;
    const mediaId = clip.kind === "still" ? clip.mediaId : source?.mediaId;
    const mediaLabel = mediaId ? (production.media.find((m) => m.mediaId === mediaId)?.label ?? null) : null;
    return { clip, track, kindLabel: kindLabel(clip), start: clip.start, end: clip.start + clip.duration, length: clip.duration, source, mediaLabel };
  }
  return null;
}

function kindLabel(clip: Clip): string {
  switch (clip.kind) {
    case "video":
      return "Video";
    case "still":
      return "Still image";
    case "audio":
      return "Audio";
    case "graphics":
      return graphicKindOf(clip.capability.id, clip.capability.version)?.label ?? "Graphic";
  }
}
