/**
 * Where the Studio preview draws (#150). The canvas is fitted into the panel
 * with letterboxing, and every picture element is placed by the render
 * module's `layerBox()` multiplied by that one scale, so the preview lays out
 * footage exactly as the parity tests prove the export does. Nothing here
 * computes a box any other way.
 */
import { layerBox, type CoverPlacement, type LayerBox } from "@/lib/video/render/plan";

export interface Size {
  width: number;
  height: number;
}

/** The canvas fitted inside the panel: its scale and its box in panel pixels. */
export interface CanvasFit {
  scale: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The largest scale at which the whole canvas fits the panel, centred, with
 * the rest letterboxed. Fractional pixels are kept: rounding would leave a
 * hairline between the canvas edge and a picture that covers it.
 */
export function fitCanvas(panel: Size, canvas: Size): CanvasFit {
  if (!(panel.width > 0 && panel.height > 0 && canvas.width > 0 && canvas.height > 0)) return { scale: 0, left: 0, top: 0, width: 0, height: 0 };
  const scale = Math.min(panel.width / canvas.width, panel.height / canvas.height);
  const width = canvas.width * scale;
  const height = canvas.height * scale;
  return { scale, left: (panel.width - width) / 2, top: (panel.height - height) / 2, width, height };
}

/** A layer's element box in preview pixels: `layerBox(placement)` times the canvas scale. */
export function scaledLayerBox(placement: CoverPlacement, scale: number): LayerBox {
  const box = layerBox(placement);
  return { left: box.left * scale, top: box.top * scale, width: box.width * scale, height: box.height * scale };
}
