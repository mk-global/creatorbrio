/**
 * "Add to timeline" for one library media (#150): the one change set that
 * places it at the end of its Studio track.
 *
 * - The production must reference the media before a clip may use it, so
 *   the change set lists it first (`addMedia`, role by kind: `a-roll` for
 *   video, `image` for stills, `music` for audio) unless it already does.
 * - Video and audio clips span the whole media: `source.inUs` is 0 and the
 *   clip lasts the whole frames the media covers, rounded down, with
 *   `outUs` the exact source span of those frames, so the source range
 *   stays inside the media and agrees with the duration as admission
 *   requires (`durationMatchesSourceSpan`). Stills last three seconds.
 * - The clip starts where the last clip on that track ends.
 *
 * Pure: the clip id is an argument; the store and admission stay the judges.
 */
import { STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { LIMITS } from "@/lib/video/production/limits";
import { framesToSourceSpanUs, MICROSECONDS_PER_SECOND } from "@/lib/video/production/time";
import type { MediaKind, MediaRole, Production } from "@/types/production";
import { hasControlCharacter } from "./production-ids";
import type { MediaView, ProductionOp } from "./types";

/** How long a still lasts when it is added, in seconds. */
export const STILL_SECONDS = 3;

const PLACEMENT: Record<MediaKind, { role: MediaRole; trackId: string; what: string }> = {
  video: { role: "a-roll", trackId: STUDIO_TRACKS.footage, what: "footage" },
  image: { role: "image", trackId: STUDIO_TRACKS.images, what: "images" },
  audio: { role: "music", trackId: STUDIO_TRACKS.music, what: "music" },
};

export type Placement = { ok: true; summary: string; clipId: string; ops: ProductionOp[] } | { ok: false; reason: string };

/** The media's label in the production: its file name, within the document's label limit. */
export function mediaLabel(originalName: string): string {
  const cleaned = Array.from(originalName, (ch) => (hasControlCharacter(ch) ? " " : ch)).join("").trim();
  let label = "";
  for (const ch of Array.from(cleaned)) {
    if (label.length + ch.length > LIMITS.text.label) break;
    label += ch;
  }
  return label.trim() || "Untitled media";
}

/** Whole timeline frames a media of `durationUs` covers, rounded down. */
export function wholeFrames(durationUs: number, fps: number): number {
  return Math.floor((durationUs * fps) / MICROSECONDS_PER_SECOND);
}

/** Where the next clip on a track starts: the end of its last clip. */
export function trackEnd(production: Production, trackId: string): number {
  const track = production.timeline.tracks.find((t) => t.id === trackId);
  let end = 0;
  for (const clip of track?.clips ?? []) end = Math.max(end, clip.start + clip.duration);
  return end;
}

/** True when the production lists this media or a clip uses it. */
export function mediaInProduction(production: Production, mediaId: string): boolean {
  if (production.media.some((m) => m.mediaId === mediaId)) return true;
  return production.timeline.tracks.some((t) =>
    t.clips.some((c) => (c.kind === "still" ? c.mediaId === mediaId : c.kind !== "graphics" && c.source.mediaId === mediaId))
  );
}

/** The change set that adds `media` to the end of its Studio track, or why it cannot be added. */
export function placeMedia(production: Production, media: MediaView, clipId: string): Placement {
  const place = PLACEMENT[media.kind];
  if (!place) return { ok: false, reason: "This kind of media cannot be placed." };
  if (!production.timeline.tracks.some((t) => t.id === place.trackId)) {
    return { ok: false, reason: `This production has no ${place.what} track, so the Studio cannot place it.` };
  }
  const fps = production.format.fps;
  const start = trackEnd(production, place.trackId);
  const label = mediaLabel(media.originalName);

  let clip: Extract<ProductionOp, { op: "insertClip" }>["clip"];
  if (media.kind === "image") {
    clip = { kind: "still", id: clipId, start, duration: STILL_SECONDS * fps, mediaId: media.mediaId };
  } else {
    const durationUs = media.facts.durationUs;
    const duration = typeof durationUs === "number" ? wholeFrames(durationUs, fps) : 0;
    if (duration < 1) return { ok: false, reason: "This media is shorter than one frame, so it cannot be placed." };
    const source = { mediaId: media.mediaId, inUs: 0, outUs: framesToSourceSpanUs(duration, fps) };
    clip = media.kind === "video" ? { kind: "video", id: clipId, start, duration, source } : { kind: "audio", id: clipId, start, duration, source, gainDb: [] };
  }

  const ops: ProductionOp[] = [];
  if (!production.media.some((m) => m.mediaId === media.mediaId)) ops.push({ op: "addMedia", media: { mediaId: media.mediaId, role: place.role, label } });
  ops.push({ op: "insertClip", trackId: place.trackId, clip });
  return { ok: true, summary: `Add ${label.length > 60 ? `${label.slice(0, 59)}…` : label}`, clipId, ops };
}
