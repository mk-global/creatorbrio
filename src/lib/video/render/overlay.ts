/**
 * The overlay document (#144, ADR decision 3): one script-free HTML document
 * that draws every caption and graphic of a render plan, timed by the CSS
 * variable `--t`. The export browser loads it from `OVERLAY_ORIGIN` with page
 * JavaScript off and seeks `document.getAnimations()`; the Studio preview
 * shows the same document in `<iframe sandbox="">` with `--t` set and every
 * animation paused (`previewOverlayAt`). The two targets differ only in where
 * the bundled fonts come from and in the preview's meta CSP.
 *
 * The document is built from capability output only, never from user markup.
 * Each capability's CSS and HTML is checked after emission (`assertSafeCss`,
 * `assertSafeHtml`) and a violation fails the render rather than shipping a
 * document the renderer was not designed to load.
 */
import { createHash } from "node:crypto";

import type { CapabilityCatalog, ClipFrame, Emitted } from "@/lib/video/capabilities/types";
import { safeZoneFor } from "@/lib/video/capabilities/safe-zone";
import type { FontAsset, OverlayDocument } from "./execute-types";
import { RenderFailure } from "./execute-types";
import { bundledFace, BUNDLED_FACES, OVERLAY_FONT_CSS, OVERLAY_FONT_FAMILY } from "./fonts";
import { PREVIEW_META, TIME_RULE } from "./overlay-time";
import type { GraphicPlacement, RenderPlan } from "./plan";

export { overlayTimeSeconds, PREVIEW_OVERLAY_CSP, previewOverlayAt } from "./overlay-time";

/** The synthetic origin the export browser loads the document from; nothing is ever fetched from the network. */
export const OVERLAY_ORIGIN = "https://overlay.creatorbrio.invalid";
export const OVERLAY_PATH = "/overlay.html";
/** The Content-Security-Policy header the export renderer sends with the document: inline styles and same-origin fonts only. */
export const EXPORT_OVERLAY_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'";

export interface OverlayOptions {
  catalog: CapabilityCatalog;
  /** Every bundled face (`bundledFonts()`), each once. */
  fonts: readonly FontAsset[];
  target: "export" | "preview";
}

const internal = (message: string) => new RenderFailure("permanent", "internal_error", message);

/**
 * Builds the overlay document for a plan. Throws `RenderFailure` with code
 * `internal_error` when a graphic names a capability the catalog does not
 * know or parameters it refuses (the compiler refuses both first), when a
 * capability emits CSS or markup outside the safe subset, or when `fonts` is
 * not exactly the bundled set.
 */
export function buildOverlay(plan: RenderPlan, options: OverlayOptions): OverlayDocument {
  const { width, height, fps } = plan.canvas;
  if (![width, height, fps].every((n) => Number.isSafeInteger(n) && n > 0)) throw internal("the plan's canvas is malformed");
  const canvas = { width, height };
  const safeZone = safeZoneFor(canvas);

  const clips = plan.graphics.map((g, index) => {
    if (!Number.isSafeInteger(g.startFrame) || g.startFrame < 0 || !Number.isSafeInteger(g.durationFrames) || g.durationFrames < 1) {
      throw internal(`graphic ${g.clipId} has a malformed time range`);
    }
    const { id, version, params } = g.capability;
    const def = options.catalog.get(id, version);
    if (!def) throw internal(`graphic ${g.clipId} uses a capability this catalog does not know`);
    const frame: ClipFrame = { durationFrames: g.durationFrames, fps, canvas };
    const parsed = def.parse(params, frame);
    if (!parsed.ok) throw internal(`graphic ${g.clipId} has parameters its capability refuses`);
    const prefix = `c${index}`;
    const emitted = def.emit(parsed.value, { ...frame, prefix, startFrame: g.startFrame, safeZone, fontFamily: OVERLAY_FONT_CSS });
    try {
      assertSafeCss(emitted.css, prefix);
      assertSafeHtml(emitted.html, prefix);
    } catch (error) {
      if (error instanceof UnsafeEmission) throw internal(`capability ${id}@${version} emitted unsafe ${error.part} for graphic ${g.clipId}`);
      throw error;
    }
    return emitted;
  });

  const html = assemble(canvas, fontFaces(options.fonts, options.target), clips, options.target);
  return { html, activeRanges: activeRanges(plan.graphics), sha256: createHash("sha256").update(html).digest("hex") };
}

function assemble(canvas: { width: number; height: number }, fonts: string[], clips: Emitted[], target: OverlayOptions["target"]): string {
  const css = [
    TIME_RULE,
    `html, body { margin: 0; padding: 0; width: ${canvas.width}px; height: ${canvas.height}px; overflow: hidden; background: transparent }`,
    `body { position: relative; font-family: ${OVERLAY_FONT_CSS} }`,
    ...fonts,
    ...clips.map((c) => c.css),
  ].join("\n");
  const meta = target === "preview" ? PREVIEW_META : "";
  return `<!doctype html>\n<html><head><meta charset="utf-8">${meta}<style>\n${css}\n</style></head><body>${clips.map((c) => c.html).join("")}</body></html>\n`;
}

/** `@font-face` rules for the bundled faces: same-origin URLs for export, `data:` URLs of the bundled bytes for preview. */
function fontFaces(fonts: readonly FontAsset[], target: OverlayOptions["target"]): string[] {
  const seen = new Set<string>();
  const rules = fonts.map((font) => {
    const face = bundledFace(font.urlPath);
    if (!face || font.family !== OVERLAY_FONT_FAMILY || font.weight !== face.weight || seen.has(face.urlPath)) {
      throw internal("the overlay was given a font that is not one of the bundled faces");
    }
    seen.add(face.urlPath);
    const src = target === "export" ? face.urlPath : `data:font/woff2;base64,${font.bytes.toString("base64")}`;
    return `@font-face { font-family: ${OVERLAY_FONT_CSS}; font-style: normal; font-weight: ${face.weight}; font-display: block; src: url(${src}) format("woff2"); unicode-range: ${face.unicodeRange} }`;
  });
  if (seen.size !== BUNDLED_FACES.length) throw internal("the overlay needs every bundled font face");
  return rules;
}

/** The frames on which any graphic is visible, `[startFrame, endFrame)`, sorted, with overlapping and touching ranges merged. */
export function activeRanges(graphics: readonly Pick<GraphicPlacement, "startFrame" | "durationFrames">[]): OverlayDocument["activeRanges"] {
  const ranges = graphics
    .filter((g) => g.durationFrames > 0)
    .map((g) => ({ startFrame: g.startFrame, endFrame: g.startFrame + g.durationFrames }))
    .sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  const merged: OverlayDocument["activeRanges"] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, r.endFrame);
    else merged.push({ ...r });
  }
  return merged;
}

// -- post-emission checks ------------------------------------------------------

class UnsafeEmission extends Error {
  constructor(readonly part: "CSS" | "markup") {
    super(`unsafe ${part}`);
  }
}

/** Substrings no capability CSS may contain: loads, imports, fonts, markup, legacy script hooks, escapes, quotes and anything that could fight the preview's pause. */
const FORBIDDEN_CSS = ["url(", "@import", "@font-face", "@namespace", "</", "<", ">", "expression(", "javascript:", "\\", "'", '"', "!important", "animation-play-state"];

/**
 * Capability CSS: none of `FORBIDDEN_CSS` (the bundled family name is the one
 * quoted string allowed), and every top-level rule is either
 * `@keyframes <prefix>[-name]` or a list of single-class selectors
 * `.<prefix>[-name]`, so a capability can style only its own elements.
 */
export function assertSafeCss(css: string, prefix: string): void {
  const lower = css.split(OVERLAY_FONT_CSS).join("").toLowerCase();
  if (FORBIDDEN_CSS.some((token) => lower.includes(token))) throw new UnsafeEmission("CSS");
  const name = `${prefix}(?:-[a-z0-9]+)?`;
  const keyframes = new RegExp(`^@keyframes ${name}$`);
  const selector = new RegExp(`^\\.${name}$`);
  let depth = 0;
  let prelude = "";
  for (const ch of css) {
    if (ch === "{") {
      if (depth === 0) {
        const p = prelude.trim();
        if (!keyframes.test(p) && !p.split(",").every((s) => selector.test(s.trim()))) throw new UnsafeEmission("CSS");
      }
      depth++;
    } else if (ch === "}") {
      if (--depth < 0) throw new UnsafeEmission("CSS");
      if (depth === 0) prelude = "";
    } else if (depth === 0) {
      prelude += ch;
    }
  }
  if (depth !== 0 || prelude.trim() !== "") throw new UnsafeEmission("CSS");
}

/**
 * Capability markup: only balanced `<div>` and `<span>` elements whose only
 * attribute is `class` naming the capability's own classes, and text with no
 * raw `<` or `>` (user text is escaped). That excludes every tag that loads,
 * navigates or runs anything (`script`, `link`, `meta`, `base`, `iframe`,
 * `object`, `embed`, `img`, `svg`, `style`, `form`, `input`) and any
 * `http-equiv`, `style` or event attribute.
 */
export function assertSafeHtml(html: string, prefix: string): void {
  const cls = `${prefix}(?:-[a-z0-9]+)?`;
  const open = new RegExp(`^<(div|span) class="${cls}(?: ${cls})*">$`);
  const close = /^<\/(div|span)>$/;
  const stack: string[] = [];
  const text = html.replace(/<[^<>]*>/g, (tag) => {
    const o = open.exec(tag);
    if (o) {
      stack.push(o[1]);
      return "";
    }
    const c = close.exec(tag);
    if (!c || stack.pop() !== c[1]) throw new UnsafeEmission("markup");
    return "";
  });
  if (stack.length > 0 || text.includes("<") || text.includes(">")) throw new UnsafeEmission("markup");
}
