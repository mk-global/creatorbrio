/**
 * `captions.timed` 1.0.0 (#144): captions typed by hand (or by an agent) as
 * cues of text in clip-relative frames. There is no speech recognition yet,
 * so cue timing is whatever the cues say; a transcript-derived caption layer
 * can replace this when speech recognition lands.
 *
 * Parameters:
 *   preset    "kinetic": words appear one by one, evenly spaced across the
 *             cue, the current word in the accent colour with a short pop;
 *             "sentence": the whole cue fades in over 4 frames (or the cue's
 *             length when shorter).
 *   position  "lower": the box sits at the bottom of the safe zone (the
 *             caption band); "center": the box is centred in the safe zone.
 *   accent    optional `#rrggbb`, default `#ffd23f` (warm yellow).
 *   cues      at most 500 cues `{ start, end, text }`: `start` a whole frame
 *             from 0, `end` a whole frame after `start` and at most the
 *             clip's length, `text` 1 to 120 characters (code points) once
 *             trimmed, without control characters, tabs or line breaks.
 *             Cues are sorted by `start` and do not overlap (a cue may start
 *             on the frame the previous one ends). At most 1,500 words in all.
 *
 * Layout: white bold text with a dark outline, centred, at most three lines,
 * in a box spanning the safe width. The font size is the largest that fits
 * the clip's longest cue in three lines at the box's inner width with an
 * average advance of 0.6 em (`fitFontSize`), capped at 76 px (kinetic, weight
 * 800) or 60 px (sentence, weight 700) on a 1080 px canvas. A 120-character
 * cue on a 1080x1920 canvas (safe width 900 px, inner width 852 px) gets
 * 35 px. Text wider than the estimate is clipped at three lines by the box.
 */
import type { JsonValue } from "@/types/production";
import { animation, DEFAULT_ACCENT, escapeHtml, fitFontSize, OUTLINED_TEXT, showKeyframes, showWindow, unit, zoneSize } from "./emit";
import { pointer, Reader, textLength } from "./params";
import { CAPTION_LAYOUT, captionBand } from "./safe-zone";
import type { CapabilityDefinition, ClipCaptionCue, ClipFrame, EmitContext, Emitted, ParseResult } from "./types";

export const CAPTION_LIMITS = { cues: 500, text: 120, words: 1_500 } as const;
/** Frames over which a sentence cue fades in. */
const SENTENCE_FADE_FRAMES = 4;
/** Seconds a kinetic word takes to pop in, rounded to whole frames (at least one). */
const POP_SECONDS = 0.2;

export interface TimedCaptions {
  preset: "kinetic" | "sentence";
  position: "lower" | "center";
  accent: string;
  cues: ClipCaptionCue[];
}

function parse(params: JsonValue, clip: ClipFrame): ParseResult<TimedCaptions> {
  const r = new Reader();
  const o = r.object(params, "", ["preset", "position", "cues"], ["accent"]);
  if (!o) return { ok: false, issues: r.issues };
  const preset = "preset" in o ? r.oneOf(o.preset, "/preset", ["kinetic", "sentence"] as const) : null;
  const position = "position" in o ? r.oneOf(o.position, "/position", ["lower", "center"] as const) : null;
  const accent = "accent" in o ? r.color(o.accent, "/accent") : DEFAULT_ACCENT;
  const cues: ClipCaptionCue[] = [];
  const list = "cues" in o ? r.array(o.cues, "/cues", CAPTION_LIMITS.cues) : null;
  let words = 0;
  let previousEnd = 0;
  list?.forEach((item, i) => {
    const p = pointer("/cues", i);
    const cue = r.object(item, p, ["start", "end", "text"]);
    if (!cue) return;
    const start = "start" in cue ? r.int(cue.start, pointer(p, "start"), 0, clip.durationFrames - 1) : null;
    const end = "end" in cue ? r.int(cue.end, pointer(p, "end"), 1, clip.durationFrames) : null;
    const text = "text" in cue ? r.text(cue.text, pointer(p, "text"), 1, CAPTION_LIMITS.text) : null;
    if (start === null || end === null || text === null) return;
    if (end <= start) return r.add(pointer(p, "end"), "a cue must end after it starts");
    if (start < previousEnd) return r.add(pointer(p, "start"), "cues must be in order and may not overlap");
    previousEnd = end;
    words += wordsOf(text).length;
    cues.push({ startFrame: start, endFrame: end, text });
  });
  if (words > CAPTION_LIMITS.words) r.add("/cues", `at most ${CAPTION_LIMITS.words} words in all are allowed`);
  if (!r.ok || preset === null || position === null || accent === null) return { ok: false, issues: r.issues };
  return { ok: true, value: { preset, position, accent, cues } };
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function emit(params: TimedCaptions, ctx: EmitContext): Emitted {
  const { prefix: c, fps, startFrame } = ctx;
  const zone = zoneSize(ctx.safeZone);
  const kinetic = params.preset === "kinetic";
  const padX = unit(ctx.canvas, CAPTION_LAYOUT.padX);
  const padY = unit(ctx.canvas, CAPTION_LAYOUT.padY);
  const longest = params.cues.reduce((max, cue) => Math.max(max, textLength(cue.text)), 1);
  const maxPx = unit(ctx.canvas, kinetic ? CAPTION_LAYOUT.kineticMaxPx : CAPTION_LAYOUT.sentenceMaxPx);
  const size = fitFontSize(longest, CAPTION_LAYOUT.lines, zone.width - 2 * padX, maxPx);
  const lineHeight = Math.ceil(size * CAPTION_LAYOUT.lineHeight);
  const boxHeight = CAPTION_LAYOUT.lines * lineHeight + 2 * padY;
  const band = captionBand(ctx.canvas, ctx.safeZone);
  // Lower captions sit on the band's bottom edge; centred ones in the middle of the safe zone.
  const box =
    params.position === "lower"
      ? `top: ${band.bottom - boxHeight}px; height: ${boxHeight}px; justify-content: flex-end`
      : `top: ${ctx.safeZone.top + Math.floor((zone.height - boxHeight) / 2)}px; height: ${boxHeight}px; justify-content: center`;

  const css: string[] = [
    showKeyframes(`${c}-show`),
    `.${c} { position: absolute; left: 0; top: 0; width: ${ctx.canvas.width}px; height: ${ctx.canvas.height}px; visibility: hidden; animation: ${showWindow(`${c}-show`, startFrame, ctx.durationFrames, fps)} }`,
    `.${c}-q { position: absolute; left: ${ctx.safeZone.left}px; width: ${zone.width}px; ${box}; box-sizing: border-box; padding: ${padY}px ${padX}px; display: flex; flex-direction: column; align-items: center; visibility: hidden }`,
    `.${c}-l { max-height: ${CAPTION_LAYOUT.lines * lineHeight}px; overflow: hidden; width: 100%; text-align: center; font-family: ${ctx.fontFamily}; font-weight: ${kinetic ? 800 : 700}; font-size: ${size}px; line-height: ${lineHeight}px; overflow-wrap: anywhere; ${OUTLINED_TEXT} }`,
  ];
  if (kinetic) {
    css.push(
      `@keyframes ${c}-pop { 0% { opacity: 0; transform: scale(0.6) } 60% { opacity: 1; transform: scale(1.08) } 100% { opacity: 1; transform: scale(1) } }`,
      `@keyframes ${c}-lit { from { color: ${params.accent} } to { color: ${params.accent} } }`,
      `.${c}-w { display: inline-block }`
    );
  } else {
    css.push(`@keyframes ${c}-fade { from { opacity: 0 } to { opacity: 1 } }`);
  }

  const pop = Math.max(1, Math.round(fps * POP_SECONDS));
  const html: string[] = [`<div class="${c}">`];
  params.cues.forEach((cue, i) => {
    const at = startFrame + cue.startFrame;
    const length = cue.endFrame - cue.startFrame;
    const window = showWindow(`${c}-show`, at, length, fps);
    const q = `${c}-q${i}`;
    if (!kinetic) {
      css.push(`.${q} { animation: ${window}, ${animation(`${c}-fade`, at, Math.min(SENTENCE_FADE_FRAMES, length), fps, "ease-out", "both")} }`);
      html.push(`<div class="${c}-q ${q}"><div class="${c}-l">${escapeHtml(cue.text)}</div></div>`);
      return;
    }
    css.push(`.${q} { animation: ${window} }`);
    const words = wordsOf(cue.text);
    // Word k appears on frame floor(k * length / n) of the cue and is the current word until the next one appears.
    const reveal = words.map((_, k) => at + Math.floor((k * length) / words.length));
    const spans = words.map((word, k) => {
      const w = `${q}w${k}`;
      const current = (k + 1 < words.length ? reveal[k + 1] : at + length) - reveal[k];
      const lit = current > 0 ? `, ${animation(`${c}-lit`, reveal[k], current, fps, "linear", "none")}` : "";
      css.push(`.${w} { animation: ${animation(`${c}-pop`, reveal[k], Math.min(pop, length), fps, "cubic-bezier(0.2, 1.4, 0.4, 1)", "both")}${lit} }`);
      return `<span class="${c}-w ${w}">${escapeHtml(word)}</span>`;
    });
    html.push(`<div class="${c}-q ${q}"><div class="${c}-l">${spans.join(" ")}</div></div>`);
  });
  html.push("</div>");
  return { css: css.join("\n"), html: html.join("") };
}

export const TIMED_CAPTIONS: CapabilityDefinition<TimedCaptions> = {
  id: "captions.timed",
  version: "1.0.0",
  kind: "captions",
  describe: "Captions from timed cues of text, word by word (kinetic) or a sentence at a time, inside the safe zone.",
  parse,
  captionCues: (params) => params.cues.map((cue) => ({ ...cue })),
  emit,
};
