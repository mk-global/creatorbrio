/**
 * Shared emission helpers for native capabilities (#144): escaping, timing
 * and type sizing, so every capability writes time, text and sizes the same way.
 *
 * Timing. Every animation and every visibility window is a CSS animation
 * whose delay is `calc(<absolute timeline seconds>s - var(--t, 0s))`. The
 * export browser seeks each animation's `currentTime` to the timeline time;
 * the preview sets `--t` and pauses every animation. Seconds are printed with
 * exactly six decimals, so one plan always gives the same bytes. A clip is
 * visible exactly on frames `[startFrame, startFrame + durationFrames)` when
 * sampled at frame centres (`overlayTimeSeconds`): the window opens at
 * `startFrame / fps` and closes at `(startFrame + durationFrames) / fps`, each
 * half a frame from the nearest sample, so rounding to six decimals can never
 * move a boundary across one.
 */
import type { SafeZone } from "./types";

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Frames as CSS seconds with six decimals, e.g. `1.000000s`. */
export function seconds(frames: number, fps: number): string {
  return `${(frames / fps).toFixed(6)}s`;
}

/** The delay of an animation that starts at an absolute timeline frame. */
export function delayAt(frame: number, fps: number): string {
  return `calc(${seconds(frame, fps)} - var(--t, 0s))`;
}

/**
 * One `animation` list item: `<name> <duration> <timing> <delay> 1 normal <fill>`.
 * `fill` is `none` for windows (the element shows its base style outside),
 * `both` for entrances (hidden before, held after) and `forwards` for exits
 * (no effect before they start, so an earlier entrance still applies).
 */
export function animation(
  name: string,
  startFrame: number,
  durationFrames: number,
  fps: number,
  timing: string,
  fill: "none" | "both" | "forwards"
): string {
  return `${name} ${seconds(durationFrames, fps)} ${timing} ${delayAt(startFrame, fps)} 1 normal ${fill}`;
}

/** Keyframes that hold `visibility: visible`, for visibility windows. */
export function showKeyframes(name: string): string {
  return `@keyframes ${name} { from { visibility: visible } to { visibility: visible } }`;
}

/** A visibility window over `[startFrame, startFrame + durationFrames)`, using `showKeyframes(name)`. */
export function showWindow(name: string, startFrame: number, durationFrames: number, fps: number): string {
  return animation(name, startFrame, durationFrames, fps, "linear", "none");
}

/**
 * Entrance and exit lengths for a clip: `inFrames` and `outFrames` when the
 * clip holds both, otherwise both scaled down in proportion (rounded down), so
 * a short clip still enters and leaves without the two overlapping.
 */
export function inOut(durationFrames: number, inFrames: number, outFrames: number): { in: number; out: number } {
  if (durationFrames >= inFrames + outFrames) return { in: inFrames, out: outFrames };
  const total = inFrames + outFrames;
  return { in: Math.floor((durationFrames * inFrames) / total), out: Math.floor((durationFrames * outFrames) / total) };
}

/**
 * Type sizing. The average advance of Inter at weights 700-800 over ordinary
 * mixed-case text with spaces is about 0.55 em; 0.6 em leaves a margin. Text
 * of `chars` characters is sized so it fits in `lines` lines of `width`
 * pixels at that advance, and never above `maxPx`. Text that is wider than
 * the estimate (long runs of capitals or wide glyphs) is clipped at `lines`
 * lines by its box rather than leaving it.
 */
export const GLYPH_ADVANCE_EM = 0.6;

export function fitFontSize(chars: number, lines: number, width: number, maxPx: number): number {
  const perLine = Math.max(1, Math.ceil(chars / lines));
  return Math.max(1, Math.min(maxPx, Math.floor(width / (perLine * GLYPH_ADVANCE_EM))));
}

/** Pixels in units of the canvas's shorter side over 1080, so a 1080-wide design scales to any canvas. */
export function unit(canvas: { width: number; height: number }, px1080: number): number {
  return Math.round((px1080 * Math.min(canvas.width, canvas.height)) / 1080);
}

/** The width and height of a safe zone. */
export function zoneSize(zone: SafeZone): { width: number; height: number } {
  return { width: zone.right - zone.left, height: zone.bottom - zone.top };
}

/** The accent colour when a capability call gives none: a warm yellow. */
export const DEFAULT_ACCENT = "#ffd23f";

/** White text with a dark outline and soft shadow, legible over any footage. */
export const OUTLINED_TEXT =
  "color: #ffffff; text-shadow: 0 0 0.05em #000000, 0 0.04em 0.02em #000000, 0 0 0.18em rgba(0, 0, 0, 0.85)";
