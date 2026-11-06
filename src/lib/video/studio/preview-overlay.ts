/**
 * When the Studio preview shows the graphics overlay and which frame it loads
 * (#150). The overlay document comes from the preview route and is shown
 * only through `previewOverlayAt()`; this module decides visibility and the
 * frame to seek it to.
 */

export interface FrameRange {
  startFrame: number;
  endFrame: number;
}

/** True when some graphic is visible on `frame`: the frame is in a range `[startFrame, endFrame)`. */
export function overlayVisible(ranges: readonly FrameRange[], frame: number): boolean {
  return ranges.some((r) => frame >= r.startFrame && frame < r.endFrame);
}

/**
 * The frame the overlay frame should hold at `frame`: that frame inside an
 * active range, otherwise the first frame of the next range, so the graphics
 * are already drawn when the playhead reaches them; null when no range is
 * ahead. Ranges are sorted and disjoint (the overlay contract).
 */
export function overlayFrameToLoad(ranges: readonly FrameRange[], frame: number): number | null {
  for (const r of ranges) {
    if (frame < r.startFrame) return r.startFrame;
    if (frame < r.endFrame) return frame;
  }
  return null;
}

/** How often the overlay is re-seeked while playing: 12 times a second. */
export const OVERLAY_RESEEK_MS = 83;
