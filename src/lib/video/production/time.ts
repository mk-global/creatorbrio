/**
 * The production time model (spec 07; merged research 05 §3 "Time model").
 *
 * - Timeline positions are integer frames at the production's frame rate.
 * - Source positions are integer microseconds into the original media.
 *
 * Integers on both sides avoid the floating-point drift that splits and trims
 * would otherwise accumulate. Conversions round only at the boundary between
 * the two, and every helper here is pure.
 */

import { FRAME_RATES, type FrameRate } from "@/types/production";

export const MICROSECONDS_PER_SECOND = 1_000_000;
export const MILLISECONDS_PER_SECOND = 1_000;

/**
 * The longest production the document admits: four hours. Platform targets
 * (a 90-second Reel) are far shorter and are checked by QA, not here, because
 * a rough cut may run long while it is being edited.
 */
export const MAX_PRODUCTION_DURATION_MS = 4 * 60 * 60 * MILLISECONDS_PER_SECOND;

/** The longest source media the document can address: 24 hours. */
export const MAX_SOURCE_US = 24 * 60 * 60 * MICROSECONDS_PER_SECOND;

/** Slowest and fastest constant playback speed a clip may use. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export function isFrameRate(value: unknown): value is FrameRate {
  return typeof value === "number" && (FRAME_RATES as readonly number[]).includes(value);
}

/** The last frame boundary a timeline at this rate may reach. */
export function maxTimelineFrames(fps: FrameRate): number {
  return (MAX_PRODUCTION_DURATION_MS / MILLISECONDS_PER_SECOND) * fps;
}

/** Milliseconds from the start of the timeline to a frame boundary. */
export function framesToMs(frames: number, fps: FrameRate): number {
  return (frames * MILLISECONDS_PER_SECOND) / fps;
}

/** The frame boundary nearest to a time in milliseconds. */
export function msToFrames(ms: number, fps: FrameRate): number {
  return Math.round((ms * fps) / MILLISECONDS_PER_SECOND);
}

/**
 * The exact (possibly fractional) number of timeline frames a source span
 * occupies when played at `speed`.
 */
export function sourceSpanToExactFrames(inUs: number, outUs: number, fps: FrameRate, speed = 1): number {
  return ((outUs - inUs) * fps) / (MICROSECONDS_PER_SECOND * speed);
}

/** Timeline frames for a source span, rounded to the nearest whole frame. */
export function sourceSpanToFrames(inUs: number, outUs: number, fps: FrameRate, speed = 1): number {
  return Math.round(sourceSpanToExactFrames(inUs, outUs, fps, speed));
}

/** Source microseconds covered by a number of timeline frames at `speed`. */
export function framesToSourceSpanUs(frames: number, fps: FrameRate, speed = 1): number {
  return Math.round((frames * MICROSECONDS_PER_SECOND * speed) / fps);
}

/**
 * Whether a clip's frame count agrees with its source span.
 *
 * Source spans rarely divide into whole frames, so a clip's duration is the
 * nearest whole number of frames: within half a frame of the exact span. A
 * clip that claims to show more or less of its source than it covers is refused.
 */
export function durationMatchesSourceSpan(
  durationFrames: number,
  inUs: number,
  outUs: number,
  fps: FrameRate,
  speed = 1
): boolean {
  const exact = sourceSpanToExactFrames(inUs, outUs, fps, speed);
  return Math.abs(durationFrames - exact) <= 0.5 + 1e-9;
}
