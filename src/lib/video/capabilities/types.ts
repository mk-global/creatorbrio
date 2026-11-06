/**
 * Native graphics capabilities (#144): captions, lower thirds and title cards
 * that a graphics clip names through its `CapabilityCall`.
 *
 * A capability is code, not user markup. It validates its own parameters and
 * emits the CSS and HTML for one clip of the script-free overlay document
 * (ADR decision 3). The overlay document is the only thing the export browser
 * and the preview iframe ever load, so every capability must:
 *   - escape every user string it puts into HTML (`escapeHtml`),
 *   - put only values it validated against a strict pattern into CSS,
 *   - emit no `<script>`, `<link>`, `<meta>`, `<base>`, `<iframe>`, `<object>`,
 *     `<embed>`, `<img>`, `url(...)`, `@import` or `@font-face`,
 *   - time every animation from the shared `--t` variable, as
 *     `calc(<seconds>s - var(--t, 0s))` delays, so the export can seek with
 *     `document.getAnimations()` and the preview with the variable alone,
 *   - keep everything it draws inside the safe zone it is given.
 */
import type { JsonValue } from "@/types/production";

/** A problem with a capability call's parameters, with a JSON-pointer-like path inside `params`. */
export interface CapabilityIssue {
  path: string;
  message: string;
}

export type ParseResult<P> = { ok: true; value: P } | { ok: false; issues: CapabilityIssue[] };

/** What a capability knows about the clip it is validating or drawing. */
export interface ClipFrame {
  /** The clip's length in timeline frames. */
  durationFrames: number;
  fps: number;
  canvas: { width: number; height: number };
}

/** A rectangle in canvas pixels that platform UI does not cover. */
export interface SafeZone {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One caption cue in clip-relative frames, `[startFrame, endFrame)`. */
export interface ClipCaptionCue {
  startFrame: number;
  endFrame: number;
  text: string;
}

export interface EmitContext extends ClipFrame {
  /**
   * A class-name prefix unique to this clip in the document, matching
   * `^c[0-9]+$`, which the capability must use for every class and keyframe
   * name it defines so clips never collide.
   */
  prefix: string;
  /** The clip's first timeline frame; animation delays are absolute timeline seconds. */
  startFrame: number;
  safeZone: SafeZone;
  /** The CSS `font-family` value of the bundled font, already safe to emit. */
  fontFamily: string;
}

export interface Emitted {
  /** Rules for `<style>`; selectors and keyframes use only `prefix`. */
  css: string;
  /** Body markup, already escaped. */
  html: string;
}

export interface CapabilityDefinition<P = unknown> {
  /** Matches `CAPABILITY_ID_PATTERN`. */
  id: string;
  /** The exact semver version this definition implements. */
  version: string;
  kind: "captions" | "graphic";
  /** One sentence for agents and the Studio's picker. */
  describe: string;
  /** Validates `params` strictly: unknown fields, wrong types and out-of-range values are issues. */
  parse(params: JsonValue, clip: ClipFrame): ParseResult<P>;
  /** Caption capabilities: the cues the sidecar files carry. */
  captionCues?(params: P): ClipCaptionCue[];
  emit(params: P, context: EmitContext): Emitted;
}

/** The capabilities a process knows, looked up by id and exact version. */
export interface CapabilityCatalog {
  get(id: string, version: string): CapabilityDefinition | undefined;
  /** Every definition, for listing and for docs. */
  list(): readonly CapabilityDefinition[];
}
