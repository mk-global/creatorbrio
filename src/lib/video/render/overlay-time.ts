/**
 * How a frame becomes a time in the overlay document (#144, #150): the parts
 * of the overlay contract that the Studio page runs in the browser as well as
 * the server. It has no Node imports, so the client bundle can use exactly
 * the function the parity tests prove, rather than a copy of it.
 */
import type { OverlayDocument } from "./execute-types";
import { RenderFailure } from "./execute-types";

/** The preview document's meta CSP: inline styles and `data:` fonts only. */
export const PREVIEW_OVERLAY_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:";

/** Overlays are sampled at frame centres, so a visibility boundary (on a frame edge) never coincides with a sample. */
export function overlayTimeSeconds(frame: number, fps: number): number {
  return (frame + 0.5) / fps;
}

/** The only `--t` declaration in a document; `previewOverlayAt` replaces it. */
export const TIME_RULE = ":root{--t:0s}";
/**
 * Where the time rule sits: first in the one `<style>`. User text can contain
 * the rule's characters, but never `<style` (it is escaped), so this anchor
 * occurs exactly once.
 */
const TIME_ANCHOR = `<style>\n${TIME_RULE}`;
export const PREVIEW_META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_OVERLAY_CSP}">`;

/**
 * The preview document showing `frame`: `--t` set to the frame's centre and
 * every animation paused, for an `<iframe sandbox="">` `srcdoc`. Rebuilt per
 * seek. Only a preview-target document can be shown this way, because only
 * it carries its fonts and its CSP inside.
 */
export function previewOverlayAt(doc: Pick<OverlayDocument, "html">, frame: number, fps: number): string {
  if (!doc.html.includes(PREVIEW_META)) throw new RenderFailure("permanent", "internal_error", "only a preview overlay document can be shown in the preview");
  const first = doc.html.indexOf(TIME_ANCHOR);
  if (first < 0 || doc.html.indexOf(TIME_ANCHOR, first + 1) >= 0) {
    throw new RenderFailure("permanent", "internal_error", "the overlay document's time rule is missing or repeated");
  }
  const t = overlayTimeSeconds(frame, fps).toFixed(6);
  const anchor = `<style>\n:root{--t:${t}s} *,*::before,*::after{animation-play-state:paused !important}`;
  return doc.html.slice(0, first) + anchor + doc.html.slice(first + TIME_ANCHOR.length);
}
