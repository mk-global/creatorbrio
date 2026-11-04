/**
 * Strict checks on an untrusted change set before anything is applied.
 *
 * Each operation's own parameters (ids, enumerations, frame numbers) are
 * checked here against a fixed table, and unknown operations and fields are
 * refused. Whole entities an operation carries (a clip, a scene, a script
 * line) are checked in full by `admitProduction()` once applied; here they
 * only have to be objects and must not carry fields the engine owns.
 */

import { PRODUCTION_STAGES, SCENE_STATUSES } from "@/types/production";
import {
  array,
  at,
  bool,
  id,
  int,
  isPlainObject,
  Issues,
  jsonValue,
  oneOf,
  sha256,
  shape,
  text,
  timestamp,
  type Rec,
} from "../primitives";
import { LIMITS } from "../limits";
import type { ChangeIssue, ChangeIssueCode, ChangeSet, OpName } from "./types";

/** The most operations one change set may carry. */
export const MAX_OPS_PER_CHANGE_SET = 500;

type Check = (issues: Issues, value: unknown, path: string) => void;

const MAX = Number.MAX_SAFE_INTEGER;
const idC: Check = (i, v, p) => void id(i, v, p);
const idOrNull: Check = (i, v, p) => void (v === null || id(i, v, p));
const mediaIdC: Check = (i, v, p) => void sha256(i, v, p);
const mediaOrNull: Check = (i, v, p) => void (v === null || sha256(i, v, p));
const frameC: Check = (i, v, p) => void int(i, v, p, 0, MAX);
const boolC: Check = (i, v, p) => void bool(i, v, p);
const jsonC: Check = (i, v, p) => void jsonValue(i, v, p);
const textC = (max: number): Check => (i, v, p) => void text(i, v, p, max);
const enumC = (allowed: readonly string[]): Check => (i, v, p) => void oneOf(i, v, p, allowed);
const idList: Check = (i, v, p) => array(i, v, p, LIMITS.count.scenes)?.forEach((x, k) => id(i, x, at(p, k)));
const objectC: Check = (i, v, p) => {
  if (!isPlainObject(v)) i.add(p, "not_object", "expected an object");
};
const objectOrNull: Check = (i, v, p) => void (v === null || objectC(i, v, p));
const arrayC: Check = (i, v, p) => void array(i, v, p, LIMITS.count.keyframes);

/** An entity the operation creates: an object that must not carry the fields the engine sets. */
const entity = (serverOwned: readonly string[]): Check => (i, v, p) => {
  if (!isPlainObject(v)) return void i.add(p, "not_object", "expected an object");
  for (const key of serverOwned) {
    if (Object.prototype.hasOwnProperty.call(v, key)) i.add(at(p, key), "unknown_field", `"${key}" is set by the engine, not by an operation`);
  }
};

/** A patch: only the listed fields may appear. Their values are validated once applied. */
const patch = (allowed: readonly string[]): Check => (i, v, p) => void shape(i, v, p, [], allowed);

const BRIEF_PATCH_FIELDS = [
  "objective",
  "audience",
  "centralMessage",
  "desiredResponse",
  "brandContext",
  "callToAction",
  "constraints",
  "visualDecisions",
  "mustInclude",
  "mustAvoid",
  "tone",
  "targetDurationMs",
] as const;

export const SCENE_PATCH_FIELDS = [
  "title",
  "purpose",
  "scriptLineIds",
  "durationTargetMs",
  "visual",
  "audio",
  "captions",
  "transitionIn",
  "slots",
] as const;

const SCENE_OWNED = ["provenance", "status", "approvals", "comments", "realization"];

/** Parameters of every operation: required and optional fields with their checks. */
const OPS: Record<OpName, { required: Record<string, Check>; optional?: Record<string, Check> }> = {
  renameProduction: { required: { name: textC(LIMITS.text.name) } },
  setStage: { required: { stage: enumC(PRODUCTION_STAGES) } },
  updateBrief: { required: { patch: patch(BRIEF_PATCH_FIELDS) } },
  addMedia: { required: { media: objectC } },
  relabelMedia: { required: { mediaId: mediaIdC, label: textC(LIMITS.text.label) } },
  removeMedia: { required: { mediaId: mediaIdC } },
  setVoice: { required: { voice: objectOrNull } },
  addSource: { required: { source: objectC } },
  upsertClaim: { required: { claim: objectC } },
  initScript: { required: { origin: enumC(["written", "generated", "transcribed"]) } },
  setHookOptions: { required: { options: arrayC } },
  selectHook: { required: { hookId: idOrNull } },
  addScriptSection: { required: { section: objectC, afterSectionId: idOrNull } },
  insertScriptLine: { required: { sectionId: idC, afterLineId: idOrNull, line: objectC } },
  editScriptLine: {
    required: { lineId: idC },
    optional: { text: textC(LIMITS.text.line), claimIds: idList, delivery: objectOrNull, estimatedMs: (i, v, p) => void (v === null || int(i, v, p, 1, MAX)) },
  },
  removeScriptLine: { required: { lineId: idC } },
  setScriptStatus: { required: { status: enumC(["draft", "approved"]) } },
  initStoryboard: { required: { storyboardId: idC } },
  addScene: { required: { scene: entity(SCENE_OWNED), afterSceneId: idOrNull } },
  editScene: { required: { sceneId: idC, patch: patch(SCENE_PATCH_FIELDS) } },
  removeScene: { required: { sceneId: idC } },
  reorderScenes: { required: { sceneIds: idList } },
  setSceneStatus: { required: { sceneId: idC, status: enumC(SCENE_STATUSES) } },
  setSceneRealization: { required: { sceneId: idC, realization: objectOrNull } },
  selectSlotAsset: { required: { sceneId: idC, slotId: idC, assetId: mediaOrNull } },
  setStoryStructure: { required: { structure: objectOrNull } },
  addTrack: { required: { track: objectC, index: frameC } },
  removeTrack: { required: { trackId: idC } },
  insertClip: { required: { trackId: idC, clip: entity(["provenance"]) } },
  removeClip: { required: { clipId: idC, ripple: boolC } },
  moveClip: { required: { clipId: idC, start: frameC }, optional: { trackId: idC } },
  trimClip: { required: { clipId: idC, edge: enumC(["in", "out"]), toFrame: frameC } },
  splitClip: { required: { clipId: idC, atFrame: frameC, newClipId: idC } },
  setClipKeyframes: { required: { clipId: idC, property: enumC(["framing", "gainDb"]), keyframes: arrayC } },
  setClipFades: { required: { clipId: idC, fadeInFrames: frameC, fadeOutFrames: frameC } },
  setClipTransition: { required: { clipId: idC, transition: objectOrNull } },
  setGraphicParams: { required: { clipId: idC, params: jsonC } },
  setClipScene: { required: { clipId: idC, sceneId: idOrNull } },
  addMarker: { required: { marker: entity(["by"]) } },
  removeMarker: { required: { markerId: idC } },
  addComment: { required: { comment: entity(["by", "at", "revision", "resolution"]) } },
  resolveComment: { required: { commentId: idC }, optional: { note: textC(LIMITS.text.note) } },
};

export const OP_NAMES = Object.keys(OPS) as OpName[];

const CODE_FOR: Record<string, ChangeIssueCode> = { limit_exceeded: "limit_exceeded" };

/** Converts validation issues found with the shared primitives into change-set issues. */
function convert(issues: Issues, opIndex: number | null, fallback: ChangeIssueCode): ChangeIssue[] {
  return issues.list.map((i) => ({ opIndex, path: i.path, code: CODE_FOR[i.code] ?? fallback, message: i.message }));
}

/**
 * Checks a change set's envelope and every operation's parameters. Returns the
 * typed change set, or every problem found.
 */
export function validateChangeSet(input: unknown): { ok: true; changeSet: ChangeSet } | { ok: false; issues: ChangeIssue[] } {
  const envelope = new Issues();
  const o = shape(envelope, input, "", ["id", "baseRevision", "at", "by", "summary", "ops"], ["runId", "scope"]);
  if (!o) return { ok: false, issues: convert(envelope, null, "invalid_change_set") };
  id(envelope, o.id, "id");
  int(envelope, o.baseRevision, "baseRevision", 0, MAX);
  timestamp(envelope, o.at, "at");
  oneOf(envelope, o.by, "by", ["user", "agent", "system"]);
  if (o.runId !== undefined) id(envelope, o.runId, "runId");
  text(envelope, o.summary, "summary", LIMITS.text.reason);
  if (o.scope !== undefined) {
    const s = shape(envelope, o.scope, "scope", ["sceneIds"]);
    if (s) idList(envelope, s.sceneIds, "scope.sceneIds");
  }
  const ops = array(envelope, o.ops, "ops", MAX_OPS_PER_CHANGE_SET);
  if (ops && ops.length === 0) envelope.add("ops", "invalid_value", "a change set needs at least one operation");
  const issues = convert(envelope, null, "invalid_change_set");

  ops?.forEach((op, index) => issues.push(...validateOp(op, index)));
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, changeSet: o as unknown as ChangeSet };
}

function validateOp(op: unknown, index: number): ChangeIssue[] {
  const path = at("ops", index);
  if (!isPlainObject(op) || typeof op.op !== "string" || !Object.prototype.hasOwnProperty.call(OPS, op.op)) {
    return [{ opIndex: index, path, code: "unknown_op", message: "not an operation this engine supports" }];
  }
  const spec = OPS[op.op as OpName];
  const issues = new Issues();
  const required = Object.keys(spec.required);
  const optional = Object.keys(spec.optional ?? {});
  shape(issues, op, path, ["op", ...required], optional);
  const rec = op as Rec;
  for (const [field, check] of Object.entries(spec.required)) {
    if (Object.prototype.hasOwnProperty.call(rec, field)) check(issues, rec[field], at(path, field));
  }
  for (const [field, check] of Object.entries(spec.optional ?? {})) {
    if (rec[field] !== undefined) check(issues, rec[field], at(path, field));
  }
  return convert(issues, index, "invalid_op");
}
