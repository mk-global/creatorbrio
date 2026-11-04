/**
 * Structural checks for the storyboard (spec 04 §2): scenes, visual and audio
 * plans, asset slots, approvals, realisation records and frames.
 *
 * References inside one scene (a layer naming one of the scene's slots) are
 * checked here; references to other sections (script lines, clips, comments,
 * media) are checked in `invariants.ts`.
 */

import {
  CAMERA_MOVES,
  SCENE_PURPOSES,
  SCENE_STATUSES,
  SLOT_KINDS,
  SOURCING_ROUTES,
  STORY_PATTERNS,
  SUBJECT_FRAMINGS,
  TEXT_ROLES,
  VISUAL_MODES,
  GRAPHICS_LAYERS,
} from "@/types/production";
import { LIMITS } from "./limits";
import {
  array,
  at,
  bool,
  has,
  id,
  int,
  isPlainObject,
  num,
  oneOf,
  sha256,
  shape,
  text,
  timestamp,
  type Issues,
  type Rec,
} from "./primitives";
import { checkNarrationDirection } from "./shape-narration";
import { checkCapabilityCall, checkProvenance, checkTransition } from "./shape-timeline";
import { MAX_PRODUCTION_DURATION_MS } from "./time";

const T = LIMITS.text;
const C = LIMITS.count;

export function checkStoryboard(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["id", "scenes", "structure", "status"]);
  if (!o) return;
  id(issues, o.id, at(path, "id"));
  array(issues, o.scenes, at(path, "scenes"), C.scenes)?.forEach((s, i) => checkScene(issues, s, at(at(path, "scenes"), i)));
  if (o.structure !== null) {
    const sp = at(path, "structure");
    const st = shape(issues, o.structure, sp, ["pattern", "hookSceneId", "targetDurationMs", "rationale"]);
    if (st) {
      oneOf(issues, st.pattern, at(sp, "pattern"), STORY_PATTERNS);
      id(issues, st.hookSceneId, at(sp, "hookSceneId"));
      int(issues, st.targetDurationMs, at(sp, "targetDurationMs"), 1, MAX_PRODUCTION_DURATION_MS);
      text(issues, st.rationale, at(sp, "rationale"), T.rationale);
    }
  }
  oneOf(issues, o.status, at(path, "status"), ["draft", "in-review", "approved", "locked"]);
}

const SCENE_REQUIRED = [
  "id",
  "title",
  "purpose",
  "scriptLineIds",
  "durationTargetMs",
  "visual",
  "audio",
  "captions",
  "slots",
  "status",
  "approvals",
  "comments",
  "frames",
  "provenance",
] as const;

function idList(issues: Issues, value: unknown, path: string, max: number): void {
  array(issues, value, path, max)?.forEach((v, i) => id(issues, v, at(path, i)));
}

function checkScene(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, SCENE_REQUIRED, ["transitionIn", "realization"]);
  if (!o) return;
  id(issues, o.id, at(path, "id"));
  text(issues, o.title, at(path, "title"), T.title);
  oneOf(issues, o.purpose, at(path, "purpose"), SCENE_PURPOSES);
  idList(issues, o.scriptLineIds, at(path, "scriptLineIds"), C.scriptLineIdsPerScene);

  const dp = at(path, "durationTargetMs");
  const d = shape(issues, o.durationTargetMs, dp, ["min", "max"]);
  if (d) {
    const ok =
      int(issues, d.min, at(dp, "min"), 1, MAX_PRODUCTION_DURATION_MS) &&
      int(issues, d.max, at(dp, "max"), 1, MAX_PRODUCTION_DURATION_MS);
    if (ok && (d.min as number) > (d.max as number)) issues.add(dp, "inconsistent", "min must not exceed max");
  }

  const slotIds = checkSlots(issues, o.slots, at(path, "slots"));
  checkVisual(issues, o.visual, at(path, "visual"), slotIds);
  checkAudioPlan(issues, o.audio, at(path, "audio"), slotIds);

  const cp = at(path, "captions");
  const captions = shape(issues, o.captions, cp, ["emphasisWordIds"], ["presetId", "hidden"]);
  if (captions) {
    if (has(captions, "presetId")) id(issues, captions.presetId, at(cp, "presetId"));
    idList(issues, captions.emphasisWordIds, at(cp, "emphasisWordIds"), C.wordIds);
    if (has(captions, "hidden")) bool(issues, captions.hidden, at(cp, "hidden"));
  }

  if (has(o, "transitionIn")) checkTransition(issues, o.transitionIn, at(path, "transitionIn"));
  oneOf(issues, o.status, at(path, "status"), SCENE_STATUSES);

  array(issues, o.approvals, at(path, "approvals"), C.approvals)?.forEach((a, i) => {
    const p = at(at(path, "approvals"), i);
    const ap = shape(issues, a, p, ["by", "at", "revision", "scope"]);
    if (!ap) return;
    oneOf(issues, ap.by, at(p, "by"), ["user"]);
    timestamp(issues, ap.at, at(p, "at"));
    int(issues, ap.revision, at(p, "revision"), 0, Number.MAX_SAFE_INTEGER);
    oneOf(issues, ap.scope, at(p, "scope"), ["plan", "realization"]);
  });

  idList(issues, o.comments, at(path, "comments"), C.commentsPerScene);

  if (has(o, "realization")) {
    const rp = at(path, "realization");
    const r = shape(issues, o.realization, rp, ["clipIds", "materializedAtRevision", "fingerprint", "diverged"]);
    if (r) {
      idList(issues, r.clipIds, at(rp, "clipIds"), C.realizationClips);
      int(issues, r.materializedAtRevision, at(rp, "materializedAtRevision"), 0, Number.MAX_SAFE_INTEGER);
      text(issues, r.fingerprint, at(rp, "fingerprint"), T.fingerprint);
      bool(issues, r.diverged, at(rp, "diverged"));
    }
  }

  array(issues, o.frames, at(path, "frames"), C.frames)?.forEach((f, i) => {
    const p = at(at(path, "frames"), i);
    const fr = shape(issues, f, p, ["id", "atMs", "assetId"]);
    if (!fr) return;
    id(issues, fr.id, at(p, "id"));
    int(issues, fr.atMs, at(p, "atMs"), 0, MAX_PRODUCTION_DURATION_MS);
    if (fr.assetId !== null) sha256(issues, fr.assetId, at(p, "assetId"));
  });

  checkProvenance(issues, o.provenance, at(path, "provenance"));
}

/** Checks the scene's slots and returns the ids they declare, for references within the scene. */
function checkSlots(issues: Issues, value: unknown, path: string): Set<string> {
  const ids = new Set<string>();
  array(issues, value, path, C.slots)?.forEach((s, i) => {
    const p = at(path, i);
    const slot = shape(issues, s, p, ["id", "need", "kind", "sourcing", "candidates", "selectedAssetId"]);
    if (!slot) return;
    if (id(issues, slot.id, at(p, "id"))) ids.add(slot.id as string);
    text(issues, slot.need, at(p, "need"), T.need);
    oneOf(issues, slot.kind, at(p, "kind"), SLOT_KINDS);
    const routes = array(issues, slot.sourcing, at(p, "sourcing"), C.sourcingRoutes);
    routes?.forEach((r, j) => oneOf(issues, r, at(at(p, "sourcing"), j), SOURCING_ROUTES));
    if (routes && routes.length === 0) issues.add(at(p, "sourcing"), "invalid_value", "a slot needs at least one sourcing route");
    array(issues, slot.candidates, at(p, "candidates"), C.candidates)?.forEach((c, j) => {
      const cp = at(at(p, "candidates"), j);
      const cand = shape(issues, c, cp, ["assetId", "score", "reason"]);
      if (!cand) return;
      sha256(issues, cand.assetId, at(cp, "assetId"));
      num(issues, cand.score, at(cp, "score"), 0, 1);
      text(issues, cand.reason, at(cp, "reason"), T.reason);
    });
    if (slot.selectedAssetId !== null) sha256(issues, slot.selectedAssetId, at(p, "selectedAssetId"));
  });
  return ids;
}

function slotRef(issues: Issues, value: unknown, path: string, slotIds: Set<string>): void {
  if (id(issues, value, path) && !slotIds.has(value)) {
    issues.add(path, "dangling_reference", "refers to a slot this scene does not declare");
  }
}

const LAYER_FIELDS: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
  "a-roll": { required: ["kind", "take"], optional: [] },
  media: { required: ["kind", "slotId", "fit"], optional: ["kenBurns"] },
  capability: { required: ["kind", "capability", "layer"], optional: [] },
  "scene-spec": { required: ["kind", "specId"], optional: [] },
  text: { required: ["kind", "role", "text"], optional: ["claimIds"] },
};

function checkVisual(issues: Issues, value: unknown, path: string, slotIds: Set<string>): void {
  const o = shape(issues, value, path, ["mode", "description", "layers"], ["camera", "framing"]);
  if (!o) return;
  oneOf(issues, o.mode, at(path, "mode"), VISUAL_MODES);
  text(issues, o.description, at(path, "description"), T.description);
  array(issues, o.layers, at(path, "layers"), C.layers)?.forEach((l, i) => {
    const p = at(at(path, "layers"), i);
    if (!isPlainObject(l)) {
      issues.add(p, "not_object", "expected an object");
      return;
    }
    if (!oneOf(issues, l.kind, at(p, "kind"), Object.keys(LAYER_FIELDS))) return;
    const fields = LAYER_FIELDS[l.kind as string];
    const layer = shape(issues, l, p, fields.required, fields.optional) as Rec;
    switch (layer.kind) {
      case "a-roll":
        oneOf(issues, layer.take, at(p, "take"), ["selected"]);
        break;
      case "media":
        slotRef(issues, layer.slotId, at(p, "slotId"), slotIds);
        oneOf(issues, layer.fit, at(p, "fit"), ["cover", "contain"]);
        if (has(layer, "kenBurns")) bool(issues, layer.kenBurns, at(p, "kenBurns"));
        break;
      case "capability":
        checkCapabilityCall(issues, layer.capability, at(p, "capability"));
        oneOf(issues, layer.layer, at(p, "layer"), GRAPHICS_LAYERS);
        break;
      case "scene-spec":
        id(issues, layer.specId, at(p, "specId"));
        break;
      case "text":
        oneOf(issues, layer.role, at(p, "role"), TEXT_ROLES);
        text(issues, layer.text, at(p, "text"), T.line);
        if (has(layer, "claimIds")) idList(issues, layer.claimIds, at(p, "claimIds"), C.claimIdsPerLine);
        break;
    }
  });
  if (has(o, "camera")) {
    const cp = at(path, "camera");
    const camera = shape(issues, o.camera, cp, ["move"], ["onWordIds"]);
    if (camera) {
      oneOf(issues, camera.move, at(cp, "move"), CAMERA_MOVES);
      if (has(camera, "onWordIds")) idList(issues, camera.onWordIds, at(cp, "onWordIds"), C.wordIds);
    }
  }
  if (has(o, "framing")) oneOf(issues, o.framing, at(path, "framing"), SUBJECT_FRAMINGS);
}

function checkAudioPlan(issues: Issues, value: unknown, path: string, slotIds: Set<string>): void {
  const o = shape(issues, value, path, ["sfx"], ["musicCue", "ambience", "voiceDirection"]);
  if (!o) return;
  if (has(o, "musicCue")) {
    const mp = at(path, "musicCue");
    const m = shape(issues, o.musicCue, mp, ["mood", "intensity"], ["trackSlotId"]);
    if (m) {
      text(issues, m.mood, at(mp, "mood"), T.short);
      oneOf(issues, m.intensity, at(mp, "intensity"), ["low", "medium", "high"]);
      if (has(m, "trackSlotId")) slotRef(issues, m.trackSlotId, at(mp, "trackSlotId"), slotIds);
    }
  }
  array(issues, o.sfx, at(path, "sfx"), C.sfxCues)?.forEach((s, i) => {
    const p = at(at(path, "sfx"), i);
    const cue = shape(issues, s, p, ["at", "intent"], ["slotId"]);
    if (!cue) return;
    const anchor = cue.at;
    if (anchor !== "scene-start") {
      const ap = at(p, "at");
      if (isPlainObject(anchor) && has(anchor, "wordId")) {
        const a = shape(issues, anchor, ap, ["wordId"]);
        if (a) id(issues, a.wordId, at(ap, "wordId"));
      } else if (isPlainObject(anchor) && has(anchor, "layerEvent")) {
        const a = shape(issues, anchor, ap, ["layerEvent"]);
        if (a) id(issues, a.layerEvent, at(ap, "layerEvent"));
      } else {
        issues.add(ap, "invalid_value", 'expected "scene-start", { wordId } or { layerEvent }');
      }
    }
    text(issues, cue.intent, at(p, "intent"), T.intent);
    if (has(cue, "slotId")) slotRef(issues, cue.slotId, at(p, "slotId"), slotIds);
  });
  if (has(o, "ambience")) {
    const ap = at(path, "ambience");
    const a = shape(issues, o.ambience, ap, ["intent"], ["slotId"]);
    if (a) {
      text(issues, a.intent, at(ap, "intent"), T.intent);
      if (has(a, "slotId")) slotRef(issues, a.slotId, at(ap, "slotId"), slotIds);
    }
  }
  if (has(o, "voiceDirection")) checkNarrationDirection(issues, o.voiceDirection, at(path, "voiceDirection"));
}
