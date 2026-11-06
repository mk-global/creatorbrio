/**
 * `graphics.title-card` 1.0.0 (#144): a large title and an optional line
 * under it, centred horizontally in the safe zone.
 *
 * Parameters: `title` 1 to 80 characters, `subtitle` optional 0 to 120
 * characters (empty means none), `align` "center" (middle of the safe zone)
 * or "top" (top of the safe zone), `scrim` true to set the text on a dark
 * translucent card inside the safe zone (false sets it on the footage with
 * the caption outline). Text rules as for captions.
 *
 * Motion: fades in while scaling from 92% over 12 frames, and fades out over
 * the clip's final 8 frames; a clip shorter than 20 frames scales both in
 * proportion (`inOut`).
 *
 * Layout: the title (weight 800) fits three lines at up to 96 px, the
 * subtitle (weight 400) three lines at up to 44 px, on a 1080 px canvas,
 * sized by `fitFontSize` and clipped beyond.
 */
import type { JsonValue } from "@/types/production";
import { animation, escapeHtml, fitFontSize, inOut, OUTLINED_TEXT, showKeyframes, showWindow, unit, zoneSize } from "./emit";
import { Reader, textLength } from "./params";
import type { CapabilityDefinition, EmitContext, Emitted, ParseResult } from "./types";

export const TITLE_CARD_LIMITS = { title: 80, subtitle: 120 } as const;
const IN_FRAMES = 12;
const OUT_FRAMES = 8;

export interface TitleCard {
  title: string;
  /** Empty when there is none. */
  subtitle: string;
  align: "center" | "top";
  scrim: boolean;
}

function parse(params: JsonValue): ParseResult<TitleCard> {
  const r = new Reader();
  const o = r.object(params, "", ["title", "align", "scrim"], ["subtitle"]);
  if (!o) return { ok: false, issues: r.issues };
  const title = "title" in o ? r.text(o.title, "/title", 1, TITLE_CARD_LIMITS.title) : null;
  const subtitle = "subtitle" in o ? r.text(o.subtitle, "/subtitle", 0, TITLE_CARD_LIMITS.subtitle) : "";
  const align = "align" in o ? r.oneOf(o.align, "/align", ["center", "top"] as const) : null;
  const scrim = "scrim" in o ? r.bool(o.scrim, "/scrim") : null;
  if (!r.ok || title === null || subtitle === null || align === null || scrim === null) return { ok: false, issues: r.issues };
  return { ok: true, value: { title, subtitle, align, scrim } };
}

function emit(params: TitleCard, ctx: EmitContext): Emitted {
  const { prefix: c, fps, startFrame, durationFrames } = ctx;
  const zone = zoneSize(ctx.safeZone);
  const pad = params.scrim ? unit(ctx.canvas, 40) : 0;
  const inner = zone.width - 2 * pad;
  const titlePx = fitFontSize(textLength(params.title), 3, inner, unit(ctx.canvas, 96));
  const titleLine = Math.ceil(titlePx * 1.1);
  const subPx = fitFontSize(Math.max(1, textLength(params.subtitle)), 3, inner, unit(ctx.canvas, 44));
  const subLine = Math.ceil(subPx * 1.25);
  const motion = inOut(durationFrames, IN_FRAMES, OUT_FRAMES);
  const moves = [
    motion.in > 0 ? animation(`${c}-in`, startFrame, motion.in, fps, "cubic-bezier(0.2, 0.8, 0.2, 1)", "both") : "",
    motion.out > 0 ? animation(`${c}-out`, startFrame + durationFrames - motion.out, motion.out, fps, "ease-in", "forwards") : "",
  ].filter((m) => m !== "");
  const card = params.scrim
    ? `background: rgba(0, 0, 0, 0.62); border-radius: ${unit(ctx.canvas, 24)}px; padding: ${pad}px; color: #ffffff`
    : OUTLINED_TEXT;

  const css = [
    showKeyframes(`${c}-show`),
    `@keyframes ${c}-in { from { opacity: 0; transform: scale(0.92) } to { opacity: 1; transform: scale(1) } }`,
    `@keyframes ${c}-out { from { opacity: 1 } to { opacity: 0 } }`,
    `.${c} { position: absolute; left: ${ctx.safeZone.left}px; top: ${ctx.safeZone.top}px; width: ${zone.width}px; height: ${zone.height}px; display: flex; flex-direction: column; align-items: center; justify-content: ${params.align === "top" ? "flex-start" : "center"}; visibility: hidden; animation: ${showWindow(`${c}-show`, startFrame, durationFrames, fps)} }`,
    `.${c}-c { box-sizing: border-box; max-width: 100%; max-height: 100%; overflow: hidden; text-align: center; font-family: ${ctx.fontFamily}; overflow-wrap: anywhere; ${card}${moves.length ? `; animation: ${moves.join(", ")}` : ""} }`,
    `.${c}-t { font-weight: 800; font-size: ${titlePx}px; line-height: ${titleLine}px; max-height: ${3 * titleLine}px; overflow: hidden }`,
    `.${c}-s { margin-top: ${unit(ctx.canvas, 16)}px; font-weight: 400; font-size: ${subPx}px; line-height: ${subLine}px; max-height: ${3 * subLine}px; overflow: hidden }`,
  ];
  const subtitle = params.subtitle ? `<div class="${c}-s">${escapeHtml(params.subtitle)}</div>` : "";
  const html = `<div class="${c}"><div class="${c}-c"><div class="${c}-t">${escapeHtml(params.title)}</div>${subtitle}</div></div>`;
  return { css: css.join("\n"), html };
}

export const TITLE_CARD: CapabilityDefinition<TitleCard> = {
  id: "graphics.title-card",
  version: "1.0.0",
  kind: "graphic",
  describe: "A large title with an optional second line, centred or at the top of the safe zone, optionally on a dark card.",
  parse,
  emit,
};
