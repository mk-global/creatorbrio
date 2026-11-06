/**
 * Frame arithmetic the Studio page shares (#150). The timeline is in whole
 * frames at the production's rate; pointer gestures and the playhead give
 * seconds, which are rounded to frames before anything is sent to the store.
 */
import type { Production } from "@/types/production";

/** The end of the last clip on any track, in frames: the length the compiler gives the render. */
export function timelineEndFrame(production: Production): number {
  let end = 0;
  for (const track of production.timeline.tracks) for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration);
  return end;
}

/** Seconds to the nearest whole frame, never negative. */
export function secondsToFrame(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.round(seconds * fps));
}

/** A frame as `m:ss.ff` (minutes, seconds and the frame within the second). */
export function formatTimecode(frame: number, fps: number): string {
  const whole = Math.max(0, Math.floor(frame));
  const seconds = Math.floor(whole / fps);
  const ff = whole % fps;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
}
