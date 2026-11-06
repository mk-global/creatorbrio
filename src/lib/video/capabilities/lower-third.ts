/**
 * `graphics.lower-third` 1.0.0 (#144): a name and an optional line under it
 * on a dark panel with an accent bar, at the bottom left of the safe zone and
 * above the caption band, so it never sits under lower captions.
 *
 * Parameters: `title` 1 to 60 characters, `subtitle` optional 0 to 80
 * characters (empty means none), `accent` optional `#rrggbb`, default
 * `#ffd23f`. Text rules as for captions: trimmed, code points, no control
 * characters, tabs or line breaks.
 *
 * Motion: the panel slides in from the left over 10 frames and out to the
 * left over the clip's final 8 frames, inside a clipping frame, so nothing is
 * drawn outside its resting place. A clip shorter than 18 frames scales both
 * in proportion (`inOut`).
 *
 * Layout: the panel is at most 90% of the safe width. The title (weight 700)
 * fits two lines at up to 54 px, the subtitle (weight 400) two lines at up to
 * 36 px, on a 1080 px canvas, sized by `fitFontSize` and clipped beyond.
 */
import type { JsonValue } from "@/types/production";
import { animation, DEFAULT_ACCENT, escapeHtml, fitFontSize, inOut, showKeyframes, showWindow, unit, zoneSize } from "./emit";
import { Reader, textLength } from "./params";
import { captionBand } from "./safe-zone";
import type { CapabilityDefinition, EmitContext, Emitted, ParseResult } from "./types";

export const LOWER_THIRD_LIMITS = { title: 60, subtitle: 80 } as const;
const IN_FRAMES = 10;
const OUT_FRAMES = 8;

export interface LowerThird {
  title: string;
  /** Empty when there is none. */
  subtitle: string;
  accent: string;
}

function parse(params: JsonValue): ParseResult<LowerThird> {
  const r = new Reader();
  const o = r.object(params, "", ["title"], ["subtitle", "accent"]);
  if (!o) return { ok: false, issues: r.issues };
  const title = "title" in o ? r.text(o.title, "/title", 1, LOWER_THIRD_LIMITS.title) : null;
  const subtitle = "subtitle" in o ? r.text(o.subtitle, "/subtitle", 0, LOWER_THIRD_LIMITS.subtitle) : "";
  const accent = "accent" in o ? r.color(o.accent, "/accent") : DEFAULT_ACCENT;
  if (!r.ok || title === null || subtitle === null || accent === null) return { ok: false, issues: r.issues };
  return { ok: true, value: { title, subtitle, accent } };
}

function emit(params: LowerThird, ctx: EmitContext): Emitted {
  const { prefix: c, fps, startFrame, durationFrames } = ctx;
  const zone = zoneSize(ctx.safeZone);
  const band = captionBand(ctx.canvas, ctx.safeZone);
  const gap = unit(ctx.canvas, 24);
  const bar = unit(ctx.canvas, 12);
  const padX = unit(ctx.canvas, 28);
  const padY = unit(ctx.canvas, 18);
  const width = Math.floor(zone.width * 0.9);
  const inner = width - bar - 2 * padX;
  const titlePx = fitFontSize(textLength(params.title), 2, inner, unit(ctx.canvas, 54));
  const titleLine = Math.ceil(titlePx * 1.15);
  const subPx = fitFontSize(Math.max(1, textLength(params.subtitle)), 2, inner, unit(ctx.canvas, 36));
  const subLine = Math.ceil(subPx * 1.25);
  const motion = inOut(durationFrames, IN_FRAMES, OUT_FRAMES);
  const moves = [
    motion.in > 0 ? animation(`${c}-in`, startFrame, motion.in, fps, "cubic-bezier(0.2, 0.8, 0.2, 1)", "both") : "",
    motion.out > 0 ? animation(`${c}-out`, startFrame + durationFrames - motion.out, motion.out, fps, "cubic-bezier(0.4, 0, 1, 1)", "forwards") : "",
  ].filter((m) => m !== "");

  const css = [
    showKeyframes(`${c}-show`),
    `@keyframes ${c}-in { from { transform: translateX(-100%); opacity: 0 } to { transform: translateX(0); opacity: 1 } }`,
    `@keyframes ${c}-out { from { transform: translateX(0); opacity: 1 } to { transform: translateX(-100%); opacity: 0 } }`,
    `.${c} { position: absolute; left: ${ctx.safeZone.left}px; bottom: ${ctx.canvas.height - (band.top - gap)}px; max-width: ${width}px; overflow: hidden; visibility: hidden; animation: ${showWindow(`${c}-show`, startFrame, durationFrames, fps)} }`,
    `.${c}-p { display: flex; background: rgba(12, 12, 16, 0.82); border-radius: ${unit(ctx.canvas, 10)}px; overflow: hidden${moves.length ? `; animation: ${moves.join(", ")}` : ""} }`,
    `.${c}-b { flex: 0 0 ${bar}px; background: ${params.accent} }`,
    `.${c}-x { padding: ${padY}px ${padX}px; min-width: 0; font-family: ${ctx.fontFamily}; color: #ffffff; overflow-wrap: anywhere }`,
    `.${c}-t { font-weight: 700; font-size: ${titlePx}px; line-height: ${titleLine}px; max-height: ${2 * titleLine}px; overflow: hidden }`,
    `.${c}-s { margin-top: ${unit(ctx.canvas, 4)}px; font-weight: 400; font-size: ${subPx}px; line-height: ${subLine}px; max-height: ${2 * subLine}px; overflow: hidden; color: rgba(255, 255, 255, 0.86) }`,
  ];
  const subtitle = params.subtitle ? `<div class="${c}-s">${escapeHtml(params.subtitle)}</div>` : "";
  const html = `<div class="${c}"><div class="${c}-p"><div class="${c}-b"></div><div class="${c}-x"><div class="${c}-t">${escapeHtml(params.title)}</div>${subtitle}</div></div></div>`;
  return { css: css.join("\n"), html };
}

export const LOWER_THIRD: CapabilityDefinition<LowerThird> = {
  id: "graphics.lower-third",
  version: "1.0.0",
  kind: "graphic",
  describe: "A name and an optional second line on a panel that slides in at the bottom left, above the captions.",
  parse,
  emit,
};
