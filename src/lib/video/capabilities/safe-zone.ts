/**
 * Safe zones (#144): the part of the canvas that Instagram's own interface
 * does not cover, where every caption and graphic is placed by construction.
 *
 * These are creator conventions, not a published Meta specification: Meta
 * does not publish exact interface geometry, and it changes with app
 * versions. The numbers follow the common Reels guidance:
 *   - 1080x1920 (Reels and Stories): keep text out of the top 14% (account
 *     name, camera and audio controls) and the bottom 35% (caption, audio
 *     credit, comment field), 60 px from the left edge and 120 px from the
 *     right edge (the like, comment, share and audio buttons).
 *   - 1080x1350 and 1080x1080 (feed): 60 px from each side and the top, and
 *     120 px from the bottom.
 *   - Any other 9:16 canvas: the Reels rule in proportion to its size. Any
 *     other canvas: the feed rule scaled by its shorter side over 1080 (a
 *     1920x1080 canvas therefore keeps 60 px sides and top and 120 px bottom).
 */
import { unit } from "./emit";
import type { SafeZone } from "./types";

export interface Canvas {
  width: number;
  height: number;
}

/** The safe zone as edge coordinates in canvas pixels: `left <= x < right`, `top <= y < bottom`. */
export function safeZoneFor(canvas: Canvas): SafeZone {
  const { width, height } = canvas;
  if (width * 16 === height * 9) {
    return {
      left: Math.round((60 * width) / 1080),
      top: Math.round(height * 0.14),
      right: width - Math.round((120 * width) / 1080),
      bottom: height - Math.round(height * 0.35),
    };
  }
  const side = unit(canvas, 60);
  return { left: side, top: side, right: width - side, bottom: height - unit(canvas, 120) };
}

/**
 * Caption box metrics, shared by the captions capability and the graphics
 * that must stay clear of captions. Sizes are for a canvas whose shorter side
 * is 1080 px and scale with it (`unit`).
 */
export const CAPTION_LAYOUT = {
  /** Captions never take more than this many lines. */
  lines: 3,
  lineHeight: 1.2,
  /** Largest kinetic caption text (weight 800). */
  kineticMaxPx: 76,
  /** Largest sentence caption text (weight 700). */
  sentenceMaxPx: 60,
  /** Space between the box edge and the text, which also keeps the outline inside the box. */
  padX: 24,
  padY: 14,
} as const;

/**
 * The band at the bottom of the safe zone that lower captions may fill: the
 * full safe width, and the height of three lines of the largest caption text
 * plus padding. Graphics placed "above the captions" end at its top.
 */
export function captionBand(canvas: Canvas, zone: SafeZone = safeZoneFor(canvas)): SafeZone {
  const height =
    Math.ceil(CAPTION_LAYOUT.lines * CAPTION_LAYOUT.lineHeight * unit(canvas, CAPTION_LAYOUT.kineticMaxPx)) + 2 * unit(canvas, CAPTION_LAYOUT.padY);
  return { left: zone.left, top: zone.bottom - height, right: zone.right, bottom: zone.bottom };
}
