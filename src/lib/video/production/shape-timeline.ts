/**
 * Structural checks for the timeline: tracks, the four clip kinds, keyframes,
 * capability calls, transitions, provenance and markers.
 *
 * Frame ranges are checked against each clip's own duration here; checks that
 * need the production's frame rate or other sections (source spans, overlaps,
 * references) are in `invariants.ts`.
 */

import {
  AUDIO_TRACK_ROLES,
  EASINGS,
  GRAPHICS_LAYERS,
  TRACK_KINDS,
  VIDEO_TRACK_ROLES,
} from "@/types/production";
import { LIMITS } from "./limits";
import {
  array,
  at,
  bool,
  CAPABILITY_ID_PATTERN,
  has,
  id,
  int,
  isPlainObject,
  jsonValue,
  num,
  oneOf,
  pattern,
  sha256,
  shape,
  text,
  VERSION_PATTERN,
  type Issues,
  type Rec,
} from "./primitives";
import { MAX_SOURCE_US, MAX_SPEED, MIN_SPEED } from "./time";

const T = LIMITS.text;
const C = LIMITS.count;
const MAX_FRAME = Number.MAX_SAFE_INTEGER;

export function checkProvenance(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["by", "changeSetId"], ["reason"]);
  if (!o) return;
  oneOf(issues, o.by, at(path, "by"), ["user", "agent", "system"]);
  id(issues, o.changeSetId, at(path, "changeSetId"));
  if (has(o, "reason")) text(issues, o.reason, at(path, "reason"), T.reason);
}

export function checkCapabilityCall(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["id", "version", "params"]);
  if (!o) return;
  pattern(issues, o.id, at(path, "id"), CAPABILITY_ID_PATTERN, "a capability id such as captions.kinetic-pop");
  pattern(issues, o.version, at(path, "version"), VERSION_PATTERN, "a semantic version such as 1.0.0");
  jsonValue(issues, o.params, at(path, "params"));
}

export function checkTransition(issues: Issues, value: unknown, path: string, clipDuration?: number): void {
  const o = shape(issues, value, path, ["capability", "durationFrames"]);
  if (!o) return;
  checkCapabilityCall(issues, o.capability, at(path, "capability"));
  const max = typeof clipDuration === "number" && clipDuration >= 1 ? clipDuration : MAX_FRAME;
  int(issues, o.durationFrames, at(path, "durationFrames"), 1, max);
}

function checkRect(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["x", "y", "width", "height"]);
  if (!o) return;
  num(issues, o.x, at(path, "x"), -100_000, 100_000);
  num(issues, o.y, at(path, "y"), -100_000, 100_000);
  num(issues, o.width, at(path, "width"), 1e-6, 100_000);
  num(issues, o.height, at(path, "height"), 1e-6, 100_000);
}

/**
 * Keyframes are positioned in frames from the clip's start, within the clip
 * (0 … duration inclusive), in strictly increasing order.
 */
function checkKeyframes(
  issues: Issues,
  value: unknown,
  path: string,
  duration: number | null,
  checkValue: (v: unknown, p: string) => void
): void {
  const frames = array(issues, value, path, C.keyframes);
  if (!frames) return;
  let previous = -1;
  frames.forEach((k, i) => {
    const p = at(path, i);
    const o = shape(issues, k, p, ["frame", "value"], ["ease"]);
    if (!o) return;
    if (int(issues, o.frame, at(p, "frame"), 0, duration ?? MAX_FRAME)) {
      if ((o.frame as number) <= previous) issues.add(at(p, "frame"), "inconsistent", "keyframes must be in strictly increasing frame order");
      previous = o.frame as number;
    }
    checkValue(o.value, at(p, "value"));
    if (has(o, "ease")) oneOf(issues, o.ease, at(p, "ease"), EASINGS);
  });
}

function checkEffects(issues: Issues, value: unknown, path: string): void {
  array(issues, value, path, C.effects)?.forEach((e, i) => {
    const p = at(path, i);
    const o = shape(issues, e, p, ["id", "capability"]);
    if (!o) return;
    id(issues, o.id, at(p, "id"));
    checkCapabilityCall(issues, o.capability, at(p, "capability"));
  });
}

function checkSourceRange(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["mediaId", "inUs", "outUs"]);
  if (!o) return;
  sha256(issues, o.mediaId, at(path, "mediaId"));
  const ok = int(issues, o.inUs, at(path, "inUs"), 0, MAX_SOURCE_US) && int(issues, o.outUs, at(path, "outUs"), 0, MAX_SOURCE_US);
  if (ok && (o.outUs as number) <= (o.inUs as number)) {
    issues.add(path, "out_of_range", "a source range must end after it starts (outUs > inUs)");
  }
}

const gainValue = (issues: Issues) => (v: unknown, p: string) => num(issues, v, p, -96, 24);
const rectValue = (issues: Issues) => (v: unknown, p: string) => checkRect(issues, v, p);

const CLIP_BASE = ["kind", "id", "start", "duration", "provenance"] as const;
const CLIP_FIELDS = {
  video: { required: [...CLIP_BASE, "source"], optional: ["sceneId", "speed", "framing", "effects", "audio", "transitionIn"] },
  still: { required: [...CLIP_BASE, "mediaId"], optional: ["sceneId", "framing", "effects", "transitionIn"] },
  graphics: { required: [...CLIP_BASE, "capability", "layer"], optional: ["sceneId", "renderCacheKey", "transitionIn"] },
  audio: {
    required: [...CLIP_BASE, "source", "gainDb"],
    optional: ["sceneId", "speed", "fadeInFrames", "fadeOutFrames", "processing"],
  },
} as const;

/** Which clip kinds each track kind holds. */
const TRACK_CLIP_KINDS: Record<(typeof TRACK_KINDS)[number], readonly (keyof typeof CLIP_FIELDS)[]> = {
  video: ["video", "still"],
  graphics: ["graphics"],
  audio: ["audio"],
};

function checkClip(issues: Issues, value: unknown, path: string, trackKind: (typeof TRACK_KINDS)[number]): void {
  if (!isPlainObject(value)) {
    issues.add(path, "not_object", "expected an object");
    return;
  }
  const allowed = TRACK_CLIP_KINDS[trackKind];
  if (!oneOf(issues, value.kind, at(path, "kind"), allowed)) return;
  const kind = value.kind as keyof typeof CLIP_FIELDS;
  const o = shape(issues, value, path, CLIP_FIELDS[kind].required, CLIP_FIELDS[kind].optional) as Rec;

  id(issues, o.id, at(path, "id"));
  int(issues, o.start, at(path, "start"), 0, MAX_FRAME);
  const duration = int(issues, o.duration, at(path, "duration"), 1, MAX_FRAME) ? (o.duration as number) : null;
  if (has(o, "sceneId")) id(issues, o.sceneId, at(path, "sceneId"));
  checkProvenance(issues, o.provenance, at(path, "provenance"));
  if (has(o, "transitionIn")) checkTransition(issues, o.transitionIn, at(path, "transitionIn"), duration ?? undefined);

  const fade = (field: string) => {
    if (has(o, field)) int(issues, o[field], at(path, field), 0, duration ?? MAX_FRAME);
  };

  switch (kind) {
    case "video": {
      checkSourceRange(issues, o.source, at(path, "source"));
      if (has(o, "speed")) num(issues, o.speed, at(path, "speed"), MIN_SPEED, MAX_SPEED);
      if (has(o, "framing")) checkKeyframes(issues, o.framing, at(path, "framing"), duration, rectValue(issues));
      if (has(o, "effects")) checkEffects(issues, o.effects, at(path, "effects"));
      if (has(o, "audio")) {
        const ap = at(path, "audio");
        const a = shape(issues, o.audio, ap, ["gainDb"], ["fadeInFrames", "fadeOutFrames"]);
        if (a) {
          checkKeyframes(issues, a.gainDb, at(ap, "gainDb"), duration, gainValue(issues));
          for (const f of ["fadeInFrames", "fadeOutFrames"]) {
            if (has(a, f)) int(issues, a[f], at(ap, f), 0, duration ?? MAX_FRAME);
          }
        }
      }
      break;
    }
    case "still": {
      sha256(issues, o.mediaId, at(path, "mediaId"));
      if (has(o, "framing")) checkKeyframes(issues, o.framing, at(path, "framing"), duration, rectValue(issues));
      if (has(o, "effects")) checkEffects(issues, o.effects, at(path, "effects"));
      break;
    }
    case "graphics": {
      checkCapabilityCall(issues, o.capability, at(path, "capability"));
      oneOf(issues, o.layer, at(path, "layer"), GRAPHICS_LAYERS);
      if (has(o, "renderCacheKey")) sha256(issues, o.renderCacheKey, at(path, "renderCacheKey"));
      break;
    }
    case "audio": {
      checkSourceRange(issues, o.source, at(path, "source"));
      if (has(o, "speed")) num(issues, o.speed, at(path, "speed"), MIN_SPEED, MAX_SPEED);
      checkKeyframes(issues, o.gainDb, at(path, "gainDb"), duration, gainValue(issues));
      fade("fadeInFrames");
      fade("fadeOutFrames");
      if (has(o, "processing")) {
        const pp = at(path, "processing");
        const pr = shape(issues, o.processing, pp, [], ["denoise", "eqPreset", "normalise"]);
        if (pr) {
          if (has(pr, "denoise")) num(issues, pr.denoise, at(pp, "denoise"), 0, 1);
          if (has(pr, "eqPreset")) id(issues, pr.eqPreset, at(pp, "eqPreset"));
          if (has(pr, "normalise")) bool(issues, pr.normalise, at(pp, "normalise"));
        }
      }
      break;
    }
  }
}

const TRACK_FIELDS = {
  video: ["id", "kind", "role", "hidden", "clips"],
  graphics: ["id", "kind", "hidden", "clips"],
  audio: ["id", "kind", "role", "muted", "clips"],
} as const;

function checkTrack(issues: Issues, value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    issues.add(path, "not_object", "expected an object");
    return;
  }
  if (!oneOf(issues, value.kind, at(path, "kind"), TRACK_KINDS)) return;
  const kind = value.kind as (typeof TRACK_KINDS)[number];
  const o = shape(issues, value, path, TRACK_FIELDS[kind]) as Rec;
  id(issues, o.id, at(path, "id"));
  if (kind === "video") oneOf(issues, o.role, at(path, "role"), VIDEO_TRACK_ROLES);
  if (kind === "audio") oneOf(issues, o.role, at(path, "role"), AUDIO_TRACK_ROLES);
  if (kind === "audio") bool(issues, o.muted, at(path, "muted"));
  else bool(issues, o.hidden, at(path, "hidden"));
  array(issues, o.clips, at(path, "clips"), C.clipsPerTrack)?.forEach((c, i) =>
    checkClip(issues, c, at(at(path, "clips"), i), kind)
  );
}

export function checkTimeline(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["tracks", "captions", "audio", "markers"]);
  if (!o) return;
  array(issues, o.tracks, at(path, "tracks"), C.tracks)?.forEach((t, i) => checkTrack(issues, t, at(at(path, "tracks"), i)));

  if (o.captions !== null) {
    const cp = at(path, "captions");
    const captions = shape(issues, o.captions, cp, ["presetId", "hidden"]);
    if (captions) {
      if (captions.presetId !== null) id(issues, captions.presetId, at(cp, "presetId"));
      bool(issues, captions.hidden, at(cp, "hidden"));
    }
  }

  const ap = at(path, "audio");
  const audio = shape(issues, o.audio, ap, ["masterLufs", "ducking"]);
  if (audio) {
    num(issues, audio.masterLufs, at(ap, "masterLufs"), -40, -5);
    const dp = at(ap, "ducking");
    const d = shape(issues, audio.ducking, dp, ["depthDb", "attackMs", "releaseMs"]);
    if (d) {
      num(issues, d.depthDb, at(dp, "depthDb"), 0, 40);
      int(issues, d.attackMs, at(dp, "attackMs"), 0, 5_000);
      int(issues, d.releaseMs, at(dp, "releaseMs"), 0, 10_000);
    }
  }

  array(issues, o.markers, at(path, "markers"), C.markers)?.forEach((m, i) => {
    const p = at(at(path, "markers"), i);
    const marker = shape(issues, m, p, ["id", "fromFrame", "toFrame", "note", "kind", "by"]);
    if (!marker) return;
    id(issues, marker.id, at(p, "id"));
    const ok =
      int(issues, marker.fromFrame, at(p, "fromFrame"), 0, MAX_FRAME) &&
      int(issues, marker.toFrame, at(p, "toFrame"), 0, MAX_FRAME);
    if (ok && (marker.toFrame as number) < (marker.fromFrame as number)) {
      issues.add(p, "out_of_range", "a marker must not end before it starts");
    }
    text(issues, marker.note, at(p, "note"), T.note);
    oneOf(issues, marker.kind, at(p, "kind"), ["note", "question"]);
    oneOf(issues, marker.by, at(p, "by"), ["user", "agent"]);
  });
}
