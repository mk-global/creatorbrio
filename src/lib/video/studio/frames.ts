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

/**
 * A frame as SMPTE timecode, `HH:MM:SS:FF` (hours, minutes, seconds and the
 * frame within the second). Colons throughout, as video tools write it: a
 * dot before the frames would read as a decimal fraction of a second.
 */
export function formatTimecode(frame: number, fps: number): string {
  const whole = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  const rate = Math.max(1, Math.round(fps));
  const seconds = Math.floor(whole / rate);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}:${two(whole % rate)}`;
}
