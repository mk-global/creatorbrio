/**
 * The Inspector's forms for the first-party graphics capabilities (#150):
 * what a new title card, lower third or caption clip starts with, the draft a
 * person types into, the parameters a Save sends, and where a refusal's
 * issues belong in the form.
 *
 * The capability's own parser, run by the store at commit time, stays the
 * only judge of what is valid. A draft keeps exactly what the person typed
 * (frame numbers as text), and a Save sends it as typed, so a value the
 * capability refuses comes back as an issue at that field rather than being
 * corrected or dropped here. Limits are read from the capability modules, so
 * the form's hints never drift from what the parser enforces.
 */
import { CAPTION_LIMITS } from "@/lib/video/capabilities/captions";
import { DEFAULT_ACCENT } from "@/lib/video/capabilities/emit";
import { LOWER_THIRD_LIMITS } from "@/lib/video/capabilities/lower-third";
import { TITLE_CARD_LIMITS } from "@/lib/video/capabilities/title-card";
import { STUDIO_TRACKS } from "@/lib/video/production/new-production";
import type { JsonValue, Production } from "@/types/production";
import type { RefusalIssue } from "./types";

export { CAPTION_LIMITS, DEFAULT_ACCENT, LOWER_THIRD_LIMITS, TITLE_CARD_LIMITS };

/** The version of every first-party capability the Studio inserts. */
export const CAPABILITY_VERSION = "1.0.0";

export type GraphicKind = "title-card" | "lower-third" | "captions";

export interface GraphicKindInfo {
  kind: GraphicKind;
  label: string;
  capabilityId: string;
  /** The track a new clip of this kind goes on. */
  trackId: string;
  /** A new clip's length in seconds. */
  seconds: number;
  /** One line for the Add button. */
  hint: string;
}

export const GRAPHIC_KINDS: readonly GraphicKindInfo[] = [
  { kind: "title-card", label: "Title card", capabilityId: "graphics.title-card", trackId: STUDIO_TRACKS.titles, seconds: 3, hint: "A large title, centred or at the top" },
  { kind: "lower-third", label: "Lower third", capabilityId: "graphics.lower-third", trackId: STUDIO_TRACKS.titles, seconds: 4, hint: "A name and a second line, bottom left" },
  { kind: "captions", label: "Captions", capabilityId: "captions.timed", trackId: STUDIO_TRACKS.captions, seconds: 4, hint: "Timed caption cues you type" },
];

/** The Studio's form for a capability id and version, if it has one. */
export function graphicKindOf(capabilityId: string, version: string): GraphicKindInfo | null {
  if (version !== CAPABILITY_VERSION) return null;
  return GRAPHIC_KINDS.find((k) => k.capabilityId === capabilityId) ?? null;
}

export function graphicKindInfo(kind: GraphicKind): GraphicKindInfo {
  return GRAPHIC_KINDS.find((k) => k.kind === kind)!;
}

/** A new clip's length in whole frames at the production's rate. */
export function defaultDurationFrames(kind: GraphicKind, fps: number): number {
  return Math.max(1, Math.round(graphicKindInfo(kind).seconds * fps));
}

/** Parameters a new clip of `kind` and `durationFrames` starts with; each capability accepts them. */
export function defaultParams(kind: GraphicKind, durationFrames: number): JsonValue {
  switch (kind) {
    case "title-card":
      return { title: "Your title", subtitle: "", align: "center", scrim: true };
    case "lower-third":
      return { title: "Your name", subtitle: "Your role" };
    case "captions":
      return { preset: "sentence", position: "lower", cues: [{ start: 0, end: durationFrames, text: "Your caption" }] };
  }
}

// -- drafts -------------------------------------------------------------------

export interface TitleCardDraft {
  kind: "title-card";
  title: string;
  subtitle: string;
  align: "center" | "top";
  scrim: boolean;
}

export interface LowerThirdDraft {
  kind: "lower-third";
  title: string;
  subtitle: string;
  accent: string;
}

/** A cue as typed: frame numbers stay text until a Save sends them. */
export interface CueDraft {
  start: string;
  end: string;
  text: string;
}

export interface CaptionsDraft {
  kind: "captions";
  preset: "kinetic" | "sentence";
  position: "lower" | "center";
  accent: string;
  cues: CueDraft[];
}

export type GraphicDraft = TitleCardDraft | LowerThirdDraft | CaptionsDraft;

type Obj = { [key: string]: JsonValue };

function isObj(value: JsonValue): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: JsonValue | undefined, fallback: string): string | null {
  if (value === undefined) return fallback;
  return typeof value === "string" ? value : null;
}

function oneOf<T extends string>(value: JsonValue | undefined, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * The form's starting draft for stored parameters, or null when they are not
 * a shape the form can show (the Inspector then shows them read-only).
 */
export function draftFromParams(kind: GraphicKind, params: JsonValue): GraphicDraft | null {
  if (!isObj(params)) return null;
  switch (kind) {
    case "title-card": {
      const title = str(params.title, "");
      const subtitle = str(params.subtitle, "");
      const align = oneOf(params.align, ["center", "top"] as const);
      const scrim = typeof params.scrim === "boolean" ? params.scrim : null;
      if (title === null || subtitle === null || align === null || scrim === null) return null;
      return { kind, title, subtitle, align, scrim };
    }
    case "lower-third": {
      const title = str(params.title, "");
      const subtitle = str(params.subtitle, "");
      const accent = str(params.accent, DEFAULT_ACCENT);
      if (title === null || subtitle === null || accent === null) return null;
      return { kind, title, subtitle, accent };
    }
    case "captions": {
      const preset = oneOf(params.preset, ["kinetic", "sentence"] as const);
      const position = oneOf(params.position, ["lower", "center"] as const);
      const accent = str(params.accent, DEFAULT_ACCENT);
      if (preset === null || position === null || accent === null || !Array.isArray(params.cues)) return null;
      const cues: CueDraft[] = [];
      for (const cue of params.cues) {
        if (!isObj(cue) || typeof cue.text !== "string") return null;
        cues.push({ start: frameText(cue.start), end: frameText(cue.end), text: cue.text });
      }
      return { kind, preset, position, accent, cues };
    }
  }
}

function frameText(value: JsonValue | undefined): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

/** A typed frame number as the number it names, or the text itself when it names none (the capability then refuses it at its field). */
export function frameValue(text: string): JsonValue {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : text;
}

/** The parameters a Save sends for `draft`. */
export function paramsFromDraft(draft: GraphicDraft): JsonValue {
  switch (draft.kind) {
    case "title-card":
      return { title: draft.title, subtitle: draft.subtitle, align: draft.align, scrim: draft.scrim };
    case "lower-third":
      return { title: draft.title, subtitle: draft.subtitle, accent: draft.accent };
    case "captions":
      return {
        preset: draft.preset,
        position: draft.position,
        accent: draft.accent,
        cues: draft.cues.map((cue) => ({ start: frameValue(cue.start), end: frameValue(cue.end), text: cue.text })),
      };
  }
}

/** True when `draft` would send something other than what `stored` already says. */
export function draftDiffers(kind: GraphicKind, draft: GraphicDraft, stored: JsonValue): boolean {
  const base = draftFromParams(kind, stored);
  return base === null || JSON.stringify(paramsFromDraft(draft)) !== JSON.stringify(paramsFromDraft(base));
}

// -- refusals -----------------------------------------------------------------

/** A field's key in a form: `title`, `cues[2].end`, or `cues` for the cue list as a whole. */
export function fieldKey(...parts: (string | number)[]): string {
  return parts.reduce<string>((key, part) => (typeof part === "number" ? `${key}[${part}]` : key ? `${key}.${part}` : part), "");
}

export interface FormIssues {
  /** Messages by field key. */
  fields: Record<string, string[]>;
  /** Messages that belong to no single field: the parameters as a whole, the operation, the change set. */
  general: string[];
}

/** Where a clip sits in the production, as admission issue paths name it. */
export function clipLocation(production: Production, clipId: string): { trackIndex: number; clipIndex: number } | null {
  for (const [trackIndex, track] of production.timeline.tracks.entries()) {
    const clipIndex = track.clips.findIndex((c) => c.id === clipId);
    if (clipIndex >= 0) return { trackIndex, clipIndex };
  }
  return null;
}

/**
 * Sorts a refused Save's issues into the form of clip `clipId`. Admission
 * names a capability problem at the clip's `capability.params` path followed
 * by the field (`timeline.tracks[4].clips[0].capability.params.cues[2].end`);
 * the field is that suffix. The clip's position is read from `production`,
 * the stored state the session shows after the refusal, which a parameter
 * edit never moves. Every other issue is general.
 */
export function formIssues(issues: readonly RefusalIssue[], production: Production, clipId: string): FormIssues {
  const result: FormIssues = { fields: {}, general: [] };
  const at = clipLocation(production, clipId);
  const base = at ? `timeline.tracks[${at.trackIndex}].clips[${at.clipIndex}].capability.params` : null;
  for (const issue of issues) {
    const suffix = base && issue.path.startsWith(base) ? issue.path.slice(base.length) : null;
    const key = suffix !== null && (suffix === "" || suffix.startsWith(".") || suffix.startsWith("[")) ? suffix.replace(/^\./, "") : null;
    if (key) (result.fields[key] ??= []).push(issue.message);
    else result.general.push(issue.message);
  }
  return result;
}
