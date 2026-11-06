/**
 * What the Studio timeline draws (#150), derived from the stored production
 * on every render: the lanes in display order with their labels, each clip's
 * kind, label and accessible name, and the ruler's zoom steps. Pure, so the
 * names a screen reader hears and the order a keyboard visits are tested.
 */
import { STUDIO_TRACKS } from "@/lib/video/production/new-production";
import type { Clip, Production, Track } from "@/types/production";
import { formatTimecode } from "./frames";
import { clipEnd, laneClips } from "./edits";
import type { MediaView } from "./types";

/** How a clip is drawn and named: one colour per kind. */
export type ClipTone = "video" | "image" | "audio" | "title" | "captions" | "graphic";

const STUDIO_LABELS: Record<string, string> = {
  [STUDIO_TRACKS.footage]: "Footage",
  [STUDIO_TRACKS.images]: "Images",
  [STUDIO_TRACKS.music]: "Music",
  [STUDIO_TRACKS.titles]: "Titles",
  [STUDIO_TRACKS.captions]: "Captions",
};

const ROLE_LABELS: Record<string, string> = {
  "a-roll": "Footage",
  "b-roll": "B-roll",
  overlay: "Overlay",
  voice: "Voice",
  music: "Music",
  sfx: "Sound effects",
  ambience: "Ambience",
};

/** A lane's name: the Studio track's role, or the track's own role for tracks made elsewhere. */
export function trackLabel(track: Track): string {
  return STUDIO_LABELS[track.id] ?? (track.kind === "graphics" ? "Graphics" : ROLE_LABELS[track.role] ?? track.role);
}

/**
 * Lanes top to bottom as an editor reads a stack: picture and graphics tracks
 * with the frontmost on top (the document lists tracks bottom to top), then
 * sound tracks in document order.
 */
export function displayTracks(production: Production): Track[] {
  const tracks = production.timeline.tracks;
  const picture = tracks.filter((t) => t.kind !== "audio").reverse();
  const sound = tracks.filter((t) => t.kind === "audio");
  return [...picture, ...sound];
}

export function clipTone(clip: Clip): ClipTone {
  if (clip.kind === "video") return "video";
  if (clip.kind === "still") return "image";
  if (clip.kind === "audio") return "audio";
  if (clip.capability.id === "captions.timed") return "captions";
  if (clip.capability.id === "graphics.title-card" || clip.capability.id === "graphics.lower-third") return "title";
  return "graphic";
}

export function clipKindName(clip: Clip): string {
  if (clip.kind === "video") return "Video";
  if (clip.kind === "still") return "Image";
  if (clip.kind === "audio") return "Audio";
  switch (clip.capability.id) {
    case "captions.timed":
      return "Captions";
    case "graphics.title-card":
      return "Title card";
    case "graphics.lower-third":
      return "Lower third";
    default:
      return "Graphic";
  }
}

function param(params: unknown, key: string): unknown {
  return params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>)[key] : undefined;
}

/** The text drawn on a clip: the media's label or file name, a title, or the first caption. */
export function clipLabel(clip: Clip, production: Production, media: readonly MediaView[]): string {
  if (clip.kind !== "graphics") {
    const mediaId = clip.kind === "still" ? clip.mediaId : clip.source.mediaId;
    const ref = production.media.find((m) => m.mediaId === mediaId);
    if (ref?.label.trim()) return ref.label.trim();
    return media.find((m) => m.mediaId === mediaId)?.originalName ?? "Missing media";
  }
  const params = clip.capability.params;
  if (clip.capability.id === "captions.timed") {
    const cues = param(params, "cues");
    const first = Array.isArray(cues) ? param(cues[0], "text") : undefined;
    return typeof first === "string" && first.trim() ? first.trim() : "No captions yet";
  }
  const title = param(params, "title");
  if (typeof title === "string" && title.trim()) return title.trim();
  return clip.capability.id;
}

/** The accessible name of a clip's control: kind, label, start and end timecode, and lane. */
export function clipAccessibleName(clip: Clip, label: string, lane: string, fps: number): string {
  return `${clipKindName(clip)}: ${label}, ${formatTimecode(clip.start, fps)} to ${formatTimecode(clipEnd(clip), fps)}, ${lane} track`;
}

export interface LaneClipView {
  clip: Clip;
  tone: ClipTone;
  label: string;
  name: string;
}

export interface LaneView {
  track: Track;
  label: string;
  /** Clips in timeline order, which is also their keyboard order. */
  clips: LaneClipView[];
}

export function laneViews(production: Production, media: readonly MediaView[]): LaneView[] {
  const fps = production.format.fps;
  return displayTracks(production).map((track) => {
    const label = trackLabel(track);
    return {
      track,
      label,
      clips: laneClips(track).map((clip) => {
        const text = clipLabel(clip, production, media);
        return { clip, tone: clipTone(clip), label: text, name: clipAccessibleName(clip, text, label, fps) };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Zoom

/** Pixels per second of each zoom step, from the widest view to the closest. */
export const ZOOM_STEPS = [8, 16, 32, 64, 128, 256] as const;
export const DEFAULT_ZOOM = 2;

/** Seconds between labelled ruler ticks: the shortest that leaves at least 72 px between labels. */
const TICK_SECONDS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300] as const;

export interface RulerScale {
  /** Seconds per labelled tick (the widget's `scale`). */
  scale: number;
  /** Pixels per labelled tick (the widget's `scaleWidth`). */
  scaleWidth: number;
  /** Unlabelled subdivisions per tick. */
  split: number;
}

export function rulerScale(pixelsPerSecond: number): RulerScale {
  const scale = TICK_SECONDS.find((s) => s * pixelsPerSecond >= 72) ?? TICK_SECONDS[TICK_SECONDS.length - 1];
  const split = scale === 0.5 || scale === 5 || scale === 15 ? 5 : scale === 1 || scale === 10 ? 10 : scale === 2 ? 4 : 6;
  return { scale, scaleWidth: scale * pixelsPerSecond, split };
}

/** A ruler label: `m:ss`, or `m:ss.f` (tenths) between whole seconds. */
export function rulerLabel(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const whole = Math.floor(tenths / 10);
  const tail = tenths % 10 ? `.${tenths % 10}` : "";
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}${tail}`;
}

/** The closest zoom step that shows the whole production in `widthPx`; the default for an empty one. */
export function fitZoomIndex(durationSeconds: number, widthPx: number): number {
  if (!(durationSeconds > 0) || !(widthPx > 0)) return DEFAULT_ZOOM;
  let best = 0;
  ZOOM_STEPS.forEach((pps, i) => {
    if (durationSeconds * pps <= widthPx) best = i;
  });
  return best;
}
