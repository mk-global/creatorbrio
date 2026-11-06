/**
 * Cover-fit placement of a picture on the canvas (#144), in upright display
 * pixels and integer arithmetic only, so the export's `scale` and `crop` and
 * the preview's element box (`layerBox` in `plan.ts`) use the same numbers.
 */
import type { VideoFacts } from "@/lib/video/media/facts";
import type { CoverPlacement } from "./plan";

export interface Size {
  width: number;
  height: number;
}

/**
 * The upright size a player shows: the coded size, with width and height
 * swapped for a quarter turn. Still images carry the same picture facts as
 * video (`facts.ts`), so this serves both.
 */
export function displaySize(picture: Pick<VideoFacts, "width" | "height" | "rotation">): Size {
  const quarterTurn = picture.rotation === 90 || picture.rotation === 270;
  return quarterTurn ? { width: picture.height, height: picture.width } : { width: picture.width, height: picture.height };
}

/**
 * Scales the picture by `s = max(W / dw, H / dh)` so it covers the canvas,
 * never rounding below the canvas on either side, and centres the canvas
 * window on it. Where the scaled picture is wider (or taller) than the canvas
 * by an odd number of pixels, the extra pixel is on the right (or bottom).
 */
export function coverPlacement(display: Size, canvas: Size): CoverPlacement {
  const s = Math.max(canvas.width / display.width, canvas.height / display.height);
  const scaledWidth = Math.max(canvas.width, Math.round(display.width * s));
  const scaledHeight = Math.max(canvas.height, Math.round(display.height * s));
  return {
    scaledWidth,
    scaledHeight,
    offsetX: Math.floor((scaledWidth - canvas.width) / 2),
    offsetY: Math.floor((scaledHeight - canvas.height) / 2),
  };
}
