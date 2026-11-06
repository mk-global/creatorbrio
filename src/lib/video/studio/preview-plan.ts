/**
 * What the Studio preview plays at a frame (#150), read from the compiled
 * render plan and nothing else, so the preview shows the picture and sound
 * the export will make.
 *
 * Each clip the plan reads gets one media element, keyed by its clip id:
 * - a picture layer is a `<video>` of the media's `proxy.mp4` (or an `<img>`
 *   of a still's `proxy.png`); when the plan also has that clip's sound, the
 *   same `<video>` plays it, so picture and sound share one element clock, and
 *   when it has none the element is muted;
 * - a sound with no picture layer (an audio clip, or a video clip on a hidden
 *   track) is an `<audio>` of the media's proxy: `proxy.m4a` for audio media,
 *   `proxy.mp4` for video media, which has no `proxy.m4a`.
 *
 * The workspace playhead is the master clock. `syncAction` says how to bring
 * one element to where the playhead says it should be, using the shared
 * `slaveCorrection` while playing and exact times otherwise.
 */
import { gainAt } from "@/lib/video/render/audio-envelope";
import type { AudioSource, GainPoint, RenderPlan, VideoLayer } from "@/lib/video/render/plan";
import { slaveCorrection } from "./playhead";
import type { DerivedFileName } from "./types";

export interface PreviewElement {
  clipId: string;
  mediaId: string;
  tag: "video" | "img" | "audio";
  /** The derived file the element loads. */
  file: Extract<DerivedFileName, "proxy.mp4" | "proxy.png" | "proxy.m4a">;
  startFrame: number;
  durationFrames: number;
  /** Source time at the clip's first frame; absent for stills. */
  sourceInUs?: number;
  /** The picture this element draws, if any. */
  layer: VideoLayer | null;
  /** The sound this element plays, if any; a `<video>` without one is muted. */
  sound: AudioSource | null;
}

/** One element per clip: picture layers bottom to top, then sound-only clips. */
export function previewElements(plan: Pick<RenderPlan, "video" | "audio" | "inputs">): PreviewElement[] {
  const sounds = new Map(plan.audio.map((s) => [s.clipId, s]));
  const kinds = new Map(plan.inputs.map((i) => [i.mediaId, i.kind]));
  const pictures = [...plan.video].sort((a, b) => a.trackIndex - b.trackIndex);
  const elements: PreviewElement[] = pictures.map((layer) => {
    const still = layer.kind === "still";
    return {
      clipId: layer.clipId,
      mediaId: layer.mediaId,
      tag: still ? "img" : "video",
      file: still ? "proxy.png" : "proxy.mp4",
      startFrame: layer.startFrame,
      durationFrames: layer.durationFrames,
      ...(still ? {} : { sourceInUs: layer.sourceInUs ?? 0 }),
      layer,
      sound: still ? null : (sounds.get(layer.clipId) ?? null),
    };
  });
  const drawn = new Set(pictures.map((l) => l.clipId));
  for (const sound of plan.audio) {
    if (drawn.has(sound.clipId)) continue;
    elements.push({
      clipId: sound.clipId,
      mediaId: sound.mediaId,
      tag: "audio",
      file: kinds.get(sound.mediaId) === "video" ? "proxy.mp4" : "proxy.m4a",
      startFrame: sound.startFrame,
      durationFrames: sound.durationFrames,
      sourceInUs: sound.sourceInUs,
      layer: null,
      sound,
    });
  }
  return elements;
}

/** True when `frame` is one of the clip's frames, `[startFrame, startFrame + durationFrames)`. */
export function activeAt(clip: { startFrame: number; durationFrames: number }, frame: number): boolean {
  return frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames;
}

/** Seconds of preload before a clip starts, so its element has data when the cut arrives. */
export const PRELOAD_SECONDS = 2;

/**
 * The elements to keep in the page at `frame`: the active ones, and those
 * starting within the preload window ahead, which wait paused at their first
 * frame. Every other element is left out of the page.
 */
export function mountedAt(elements: readonly PreviewElement[], frame: number, fps: number): PreviewElement[] {
  const ahead = Math.ceil(PRELOAD_SECONDS * fps);
  return elements.filter((e) => activeAt(e, frame) || (e.startFrame > frame && e.startFrame <= frame + ahead));
}

/**
 * The time in the element's own media that the playhead's `seconds` of
 * timeline time shows: `sourceInUs / 1e6 + (seconds - startFrame / fps)`.
 * Stills have no media time and answer 0.
 */
export function targetMediaSeconds(element: Pick<PreviewElement, "sourceInUs" | "startFrame">, seconds: number, fps: number): number {
  if (element.sourceInUs === undefined) return 0;
  return Math.max(0, element.sourceInUs / 1e6 + (seconds - element.startFrame / fps));
}

/**
 * Where an element should be at the playhead's frame and seconds: its
 * target media time while its clip is active, and otherwise its clip's first
 * source frame, where a preloaded element waits for the cut.
 */
export function elementTarget(element: PreviewElement, frame: number, seconds: number, fps: number): number {
  if (activeAt(element, frame)) return targetMediaSeconds(element, seconds, fps);
  return (element.sourceInUs ?? 0) / 1e6;
}

/** True when the clip is not on the playhead yet but its first frame comes within `leadSeconds` of `seconds`. */
export function startsWithin(element: Pick<PreviewElement, "startFrame">, seconds: number, fps: number, leadSeconds: number): boolean {
  const until = element.startFrame / fps - seconds;
  return until > 0 && until <= leadSeconds;
}

/**
 * The element volume for a sound at `seconds` of timeline time: its gain
 * envelope (`gainAt`, in absolute timeline microseconds) clamped to the
 * 0..1 a media element accepts. A gain above 1 (a boost) is played at 1.
 */
export function volumeAt(envelope: readonly GainPoint[], seconds: number): number {
  const gain = gainAt(envelope, Math.round(seconds * 1e6));
  if (!Number.isFinite(gain)) return 0;
  return Math.min(1, Math.max(0, gain));
}

/** True when some point of the envelope boosts above unity, which a media element cannot play. */
export function boostsAboveUnity(envelope: readonly GainPoint[]): boolean {
  return envelope.some((p) => p.gain > 1);
}

/** What one correction tick does to one element. */
export interface SyncAction {
  /** Set `currentTime` to this, or leave it. */
  seekTo: number | null;
  rate: number;
  /** Call `play()` (the element is paused and should play). */
  play: boolean;
  /** Call `pause()` (the element plays and should not). */
  pause: boolean;
}

/** A paused element further than this from its target is seeked to it. */
export const PAUSED_TOLERANCE_S = 0.001;

export interface SyncInput {
  /** The element's `currentTime`. */
  elementSeconds: number;
  /** Where it should be (`elementTarget`). */
  targetSeconds: number;
  /** The clip is on the playhead's frame. */
  active: boolean;
  /** The playhead is playing. */
  playing: boolean;
  /** The element is itself paused. */
  elementPaused: boolean;
  /** The element's playback rate now, so a correction under way is held rather than flipped. */
  elementRate: number;
  /** Not active yet, but the playhead reaches the clip's first frame within the start lead. */
  startsSoon: boolean;
  /** How long a paused element takes to start playing once asked (`nextStartLead`). */
  startLeadSeconds: number;
  /** The element was started less than `START_SETTLE_MS` ago: its drift is measured, not yet corrected by rate. */
  settling: boolean;
}

/**
 * How to bring one element to the playhead:
 * - active while the playhead is paused, or not active and not about to be:
 *   paused, at exactly the target (a waiting clip's first source frame);
 * - about to become active while playing: started from its first source
 *   frame one start lead early, so it is already running at the cut (it is
 *   hidden and silent until then: its gain envelope is 0 before its start);
 * - active while playing but paused (playing began, or the playhead jumped
 *   into the clip): started one start lead ahead of the target, since a
 *   media element's clock stands still until it actually starts;
 * - active and playing: held by the shared `slaveCorrection`, a gentle rate
 *   change for small drift and a seek for large; while an element is still
 *   settling after its start, only the seek, so the drift at the end of the
 *   settling time measures the start itself (`nextStartLead`).
 */
export function syncAction(input: SyncInput): SyncAction {
  const { elementSeconds, targetSeconds, active, playing, elementPaused, elementRate, startsSoon, startLeadSeconds, settling } = input;
  const off = (target: number) => (Math.abs(elementSeconds - target) > PAUSED_TOLERANCE_S ? target : null);
  if (playing && !active && startsSoon) {
    if (!elementPaused) return { seekTo: null, rate: 1, play: false, pause: false };
    return { seekTo: off(targetSeconds), rate: 1, play: true, pause: false };
  }
  if (!active || !playing) return { seekTo: off(targetSeconds), rate: 1, play: false, pause: !elementPaused };
  if (elementPaused) return { seekTo: off(targetSeconds + startLeadSeconds), rate: 1, play: true, pause: false };
  const correction = slaveCorrection(elementSeconds, targetSeconds, elementRate);
  return { seekTo: correction.seekTo, rate: settling && correction.seekTo === null ? 1 : correction.rate, play: false, pause: false };
}

/** How long after `play()` an element's start is left to settle before its drift is measured and corrected by rate. */
export const START_SETTLE_MS = 300;

/** The start lead an element begins with, before any start has been measured. */
export const INITIAL_START_LEAD_S = 0.08;
/** The start lead never exceeds this: a slower start is a stall, which correction handles. */
export const MAX_START_LEAD_S = 0.2;

/**
 * The start lead learned from one start: `drift` is the element's time minus
 * its target once the start has settled (`START_SETTLE_MS`). Behind (negative)
 * means it started later than the lead allowed for, so the lead grows; ahead
 * means it shrinks. Half the error is taken each time, so one odd start does
 * not swing it.
 */
export function nextStartLead(lead: number, drift: number): number {
  if (!Number.isFinite(drift)) return lead;
  return Math.min(MAX_START_LEAD_S, Math.max(0, lead - drift / 2));
}
