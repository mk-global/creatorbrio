/**
 * Operation appliers. Each one edits a private draft copy of the production;
 * the engine discards the draft if any operation fails or the result is not
 * admitted, so an applier may fail half-way without consequence.
 *
 * Appliers resolve their targets and refuse what cannot be done (a missing
 * scene, a split outside a clip, a locked scene). Whether the result is a
 * valid production is decided once, by `admitProduction()`, not here.
 */

import type {
  AudioClip,
  Clip,
  Keyframe,
  Production,
  Provenance,
  Rect,
  Scene,
  SceneStatus,
  ScriptLine,
  ScriptSection,
  StillClip,
  Track,
  VideoClip,
} from "@/types/production";
import { framesToSourceSpanUs } from "../time";
import type { Actor, ChangeIssueCode, ChangeSet, ProductionOp } from "./types";

export class OpFailure extends Error {
  constructor(
    readonly code: ChangeIssueCode,
    readonly path: string,
    message: string
  ) {
    super(message);
  }
}

const fail = (code: ChangeIssueCode, path: string, message: string): never => {
  throw new OpFailure(code, path, message);
};

/** Scene lifecycle (spec 04 §3). Editing a scene's plan returns it to `proposed`. */
export const SCENE_TRANSITIONS: Record<SceneStatus, readonly SceneStatus[]> = {
  proposed: ["approved", "changes_requested", "rejected"],
  changes_requested: ["proposed"],
  rejected: [],
  approved: ["producing"],
  producing: ["realized", "blocked"],
  blocked: ["producing"],
  realized: ["final", "changes_requested"],
  final: ["changes_requested", "locked"],
  locked: [],
};

export interface ApplyState {
  draft: Production;
  changeSet: ChangeSet;
  /** The revision the draft will have once admitted. */
  revision: number;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function stamp(state: ApplyState): Provenance {
  return { by: state.changeSet.by, changeSetId: state.changeSet.id };
}

const commenter = (by: Actor): "user" | "agent" => (by === "agent" ? "agent" : "user");

// ---------------------------------------------------------------------------
// Finders

function findClip(doc: Production, clipId: string, path: string) {
  for (const track of doc.timeline.tracks) {
    const index = (track.clips as Clip[]).findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, index, clip: (track.clips as Clip[])[index] };
  }
  return fail("not_found", path, "no clip with this id");
}

function findTrack(doc: Production, trackId: string, path: string): Track {
  return doc.timeline.tracks.find((t) => t.id === trackId) ?? fail("not_found", path, "no track with this id");
}

function storyboard(doc: Production, path: string) {
  return doc.storyboard ?? fail("not_found", path, "this production has no storyboard yet");
}

function findScene(doc: Production, sceneId: string, path: string): Scene {
  return storyboard(doc, path).scenes.find((s) => s.id === sceneId) ?? fail("not_found", path, "no scene with this id");
}

function script(doc: Production, path: string) {
  return doc.script ?? fail("not_found", path, "this production has no script yet");
}

function findLine(doc: Production, lineId: string, path: string): { section: ScriptSection; index: number; line: ScriptLine } {
  for (const section of script(doc, path).sections) {
    const index = section.lines.findIndex((l) => l.id === lineId);
    if (index >= 0) return { section, index, line: section.lines[index] };
  }
  return fail("not_found", path, "no script line with this id");
}

/** Index to insert after an item with `afterId`, or at the start for null. */
function insertionIndex<T extends { id: string }>(items: T[], afterId: string | null, path: string): number {
  if (afterId === null) return 0;
  const index = items.findIndex((i) => i.id === afterId);
  if (index < 0) fail("not_found", path, "no item with this id to insert after");
  return index + 1;
}

/** Keeps a track's clips in timeline order, so stored order is deterministic. */
function sortClips(track: Track): void {
  (track.clips as Clip[]).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}

function rebaseKeyframes<T>(frames: Keyframe<T>[] | undefined, offset: number, duration: number): Keyframe<T>[] | undefined {
  if (!frames) return undefined;
  return frames.filter((k) => k.frame - offset >= 0 && k.frame - offset <= duration).map((k) => ({ ...k, frame: k.frame - offset }));
}

/** Clamps fades and transitions after a clip's length changes, so a trim never invents an invalid clip. */
function fitToDuration(clip: Clip): void {
  const d = clip.duration;
  const fit = (holder: { fadeInFrames?: number; fadeOutFrames?: number }) => {
    if (holder.fadeInFrames !== undefined) holder.fadeInFrames = Math.min(holder.fadeInFrames, d);
    if (holder.fadeOutFrames !== undefined) holder.fadeOutFrames = Math.min(holder.fadeOutFrames, d - (holder.fadeInFrames ?? 0));
  };
  if (clip.kind === "audio") fit(clip);
  if (clip.kind === "video" && clip.audio) fit(clip.audio);
  if (clip.kind !== "audio" && clip.transitionIn) clip.transitionIn.durationFrames = Math.min(clip.transitionIn.durationFrames, d);
}

function rebaseClipKeyframes(clip: Clip, offset: number): void {
  if (clip.kind === "video" || clip.kind === "still") {
    const framing = rebaseKeyframes<Rect>(clip.framing, offset, clip.duration);
    if (framing) clip.framing = framing;
  }
  if (clip.kind === "audio") clip.gainDb = rebaseKeyframes(clip.gainDb, offset, clip.duration) ?? [];
  if (clip.kind === "video" && clip.audio) clip.audio.gainDb = rebaseKeyframes(clip.audio.gainDb, offset, clip.duration) ?? [];
}

// ---------------------------------------------------------------------------
// Appliers

export function applyOp(state: ApplyState, op: ProductionOp, path: string): void {
  const doc = state.draft;
  switch (op.op) {
    case "renameProduction":
      doc.name = op.name;
      return;
    case "setStage":
      doc.stage = op.stage;
      return;
    case "updateBrief": {
      const brief = doc.brief as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(op.patch)) {
        if (value === null) delete brief[key];
        else brief[key] = copy(value);
      }
      doc.brief.updatedAt = state.changeSet.at;
      return;
    }
    case "addMedia":
      if (doc.media.some((m) => m.mediaId === op.media.mediaId)) fail("invalid_op", path, "this media is already listed");
      doc.media.push(copy(op.media));
      return;
    case "relabelMedia": {
      const media = doc.media.find((m) => m.mediaId === op.mediaId) ?? fail("not_found", path, "no media with this id");
      media.label = op.label;
      return;
    }
    case "removeMedia": {
      const index = doc.media.findIndex((m) => m.mediaId === op.mediaId);
      if (index < 0) fail("not_found", path, "no media with this id");
      doc.media.splice(index, 1);
      return;
    }
    case "setVoice":
      doc.voice = copy(op.voice);
      return;
    case "addSource":
      doc.research ??= { questions: [], sources: [], claims: [], status: "draft" };
      doc.research.sources.push(copy(op.source));
      return;
    case "upsertClaim": {
      const research = doc.research ?? fail("not_found", path, "this production has no research dossier yet");
      const index = research.claims.findIndex((c) => c.id === op.claim.id);
      if (index >= 0) research.claims[index] = copy(op.claim);
      else research.claims.push(copy(op.claim));
      return;
    }
    case "initScript":
      if (doc.script) fail("invalid_op", path, "this production already has a script");
      doc.script = { origin: op.origin, hookOptions: [], selectedHookId: null, sections: [], status: "draft" };
      return;
    case "setHookOptions": {
      const s = script(doc, path);
      s.hookOptions = copy(op.options);
      if (s.selectedHookId !== null && !s.hookOptions.some((h) => h.id === s.selectedHookId)) s.selectedHookId = null;
      return;
    }
    case "selectHook":
      script(doc, path).selectedHookId = op.hookId;
      return;
    case "addScriptSection": {
      const s = script(doc, path);
      s.sections.splice(insertionIndex(s.sections, op.afterSectionId, `${path}.afterSectionId`), 0, copy(op.section));
      return;
    }
    case "insertScriptLine": {
      const section = script(doc, path).sections.find((x) => x.id === op.sectionId) ?? fail("not_found", `${path}.sectionId`, "no script section with this id");
      section.lines.splice(insertionIndex(section.lines, op.afterLineId, `${path}.afterLineId`), 0, copy(op.line));
      return;
    }
    case "editScriptLine": {
      const { line } = findLine(doc, op.lineId, `${path}.lineId`);
      if (op.text !== undefined) line.text = op.text;
      if (op.claimIds !== undefined) line.claimIds = [...op.claimIds];
      if (op.delivery === null) delete line.delivery;
      else if (op.delivery !== undefined) line.delivery = copy(op.delivery);
      if (op.estimatedMs === null) delete line.estimatedMs;
      else if (op.estimatedMs !== undefined) line.estimatedMs = op.estimatedMs;
      return;
    }
    case "removeScriptLine": {
      const { section, index } = findLine(doc, op.lineId, `${path}.lineId`);
      section.lines.splice(index, 1);
      return;
    }
    case "setScriptStatus":
      script(doc, path).status = op.status;
      return;
    case "initStoryboard":
      if (doc.storyboard) fail("invalid_op", path, "this production already has a storyboard");
      doc.storyboard = { id: op.storyboardId, scenes: [], structure: null, status: "draft" };
      return;
    case "addScene": {
      const board = storyboard(doc, path);
      const scene: Scene = { ...copy(op.scene), status: "proposed", approvals: [], comments: [], provenance: stamp(state) };
      board.scenes.splice(insertionIndex(board.scenes, op.afterSceneId, `${path}.afterSceneId`), 0, scene);
      return;
    }
    case "editScene": {
      const scene = findScene(doc, op.sceneId, `${path}.sceneId`);
      if (scene.status === "locked" || scene.status === "rejected") fail("forbidden", `${path}.sceneId`, `a ${scene.status} scene cannot be edited`);
      const target = scene as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(op.patch)) {
        if (value === null) delete target[key];
        else target[key] = copy(value);
      }
      // Editing the plan withdraws any approval of it (spec 04 §3).
      scene.status = "proposed";
      scene.provenance = stamp(state);
      return;
    }
    case "removeScene": {
      const board = storyboard(doc, path);
      const index = board.scenes.findIndex((s) => s.id === op.sceneId);
      if (index < 0) fail("not_found", `${path}.sceneId`, "no scene with this id");
      if (board.scenes[index].status === "locked") fail("forbidden", `${path}.sceneId`, "a locked scene cannot be removed");
      board.scenes.splice(index, 1);
      return;
    }
    case "reorderScenes": {
      const board = storyboard(doc, path);
      const current = board.scenes.map((s) => s.id);
      if (op.sceneIds.length !== current.length || [...op.sceneIds].sort().join("\n") !== [...current].sort().join("\n")) {
        fail("invalid_op", `${path}.sceneIds`, "the new order must list every scene exactly once");
      }
      const byId = new Map(board.scenes.map((s) => [s.id, s]));
      board.scenes = op.sceneIds.map((id) => byId.get(id)!);
      return;
    }
    case "setSceneStatus": {
      const scene = findScene(doc, op.sceneId, `${path}.sceneId`);
      if (!SCENE_TRANSITIONS[scene.status].includes(op.status)) {
        fail("invalid_transition", `${path}.status`, `a ${scene.status} scene cannot become ${op.status}`);
      }
      scene.status = op.status;
      if (op.status === "approved" || op.status === "final") {
        scene.approvals.push({ by: "user", at: state.changeSet.at, revision: state.revision, scope: op.status === "approved" ? "plan" : "realization" });
      }
      return;
    }
    case "setSceneRealization": {
      const scene = findScene(doc, op.sceneId, `${path}.sceneId`);
      if (op.realization === null) delete scene.realization;
      else scene.realization = copy(op.realization);
      return;
    }
    case "selectSlotAsset": {
      const scene = findScene(doc, op.sceneId, `${path}.sceneId`);
      const slot = scene.slots.find((s) => s.id === op.slotId) ?? fail("not_found", `${path}.slotId`, "no slot with this id in the scene");
      slot.selectedAssetId = op.assetId;
      scene.provenance = stamp(state);
      return;
    }
    case "setStoryStructure":
      storyboard(doc, path).structure = copy(op.structure);
      return;
    case "addTrack": {
      if (op.index > doc.timeline.tracks.length) fail("invalid_op", `${path}.index`, "past the end of the track list");
      const track = copy(op.track);
      if (!Array.isArray(track.clips) || track.clips.length > 0) fail("invalid_op", `${path}.track.clips`, "add a track empty, then insert its clips");
      doc.timeline.tracks.splice(op.index, 0, track);
      return;
    }
    case "removeTrack": {
      const track = findTrack(doc, op.trackId, `${path}.trackId`);
      if (track.clips.length > 0) fail("invalid_op", `${path}.trackId`, "remove or move a track's clips before removing the track");
      doc.timeline.tracks.splice(doc.timeline.tracks.indexOf(track), 1);
      return;
    }
    case "insertClip": {
      const track = findTrack(doc, op.trackId, `${path}.trackId`);
      (track.clips as Clip[]).push({ ...copy(op.clip), provenance: stamp(state) } as Clip);
      sortClips(track);
      return;
    }
    case "removeClip": {
      const { track, index, clip } = findClip(doc, op.clipId, `${path}.clipId`);
      (track.clips as Clip[]).splice(index, 1);
      if (op.ripple) {
        const end = clip.start + clip.duration;
        for (const other of track.clips as Clip[]) if (other.start >= end) other.start -= clip.duration;
      }
      return;
    }
    case "moveClip": {
      const found = findClip(doc, op.clipId, `${path}.clipId`);
      const clip = found.clip;
      clip.start = op.start;
      clip.provenance = stamp(state);
      if (op.trackId !== undefined && op.trackId !== found.track.id) {
        const target = findTrack(doc, op.trackId, `${path}.trackId`);
        (found.track.clips as Clip[]).splice(found.index, 1);
        (target.clips as Clip[]).push(clip);
        sortClips(target);
      } else {
        sortClips(found.track);
      }
      return;
    }
    case "trimClip":
      trim(state, op, path);
      return;
    case "splitClip":
      split(state, op, path);
      return;
    case "setClipKeyframes": {
      const { clip } = findClip(doc, op.clipId, `${path}.clipId`);
      if (op.property === "framing") {
        if (clip.kind !== "video" && clip.kind !== "still") fail("invalid_op", `${path}.property`, "only video and still clips have framing");
        (clip as VideoClip | StillClip).framing = copy(op.keyframes as Keyframe<Rect>[]);
      } else if (clip.kind === "audio") {
        clip.gainDb = copy(op.keyframes as Keyframe<number>[]);
      } else if (clip.kind === "video") {
        clip.audio = { ...(clip.audio ?? {}), gainDb: copy(op.keyframes as Keyframe<number>[]) };
      } else {
        fail("invalid_op", `${path}.property`, "only audio and video clips have gain");
      }
      clip.provenance = stamp(state);
      return;
    }
    case "setClipFades": {
      const { clip } = findClip(doc, op.clipId, `${path}.clipId`);
      const holder: { fadeInFrames?: number; fadeOutFrames?: number } =
        clip.kind === "audio" ? clip : clip.kind === "video" ? (clip.audio ??= { gainDb: [] }) : fail("invalid_op", `${path}.clipId`, "only audio and video clips have fades");
      if (op.fadeInFrames === 0) delete holder.fadeInFrames;
      else holder.fadeInFrames = op.fadeInFrames;
      if (op.fadeOutFrames === 0) delete holder.fadeOutFrames;
      else holder.fadeOutFrames = op.fadeOutFrames;
      clip.provenance = stamp(state);
      return;
    }
    case "setClipTransition": {
      const { clip } = findClip(doc, op.clipId, `${path}.clipId`);
      if (clip.kind === "audio") fail("invalid_op", `${path}.clipId`, "audio clips use fades, not transitions");
      const visual = clip as Exclude<Clip, AudioClip>;
      if (op.transition === null) delete visual.transitionIn;
      else visual.transitionIn = copy(op.transition);
      clip.provenance = stamp(state);
      return;
    }
    case "setGraphicParams": {
      const { clip } = findClip(doc, op.clipId, `${path}.clipId`);
      if (clip.kind !== "graphics") fail("invalid_op", `${path}.clipId`, "only graphics clips have capability parameters");
      if (clip.kind === "graphics") clip.capability.params = copy(op.params);
      clip.provenance = stamp(state);
      return;
    }
    case "setClipScene": {
      const { clip } = findClip(doc, op.clipId, `${path}.clipId`);
      if (op.sceneId === null) delete clip.sceneId;
      else clip.sceneId = op.sceneId;
      clip.provenance = stamp(state);
      return;
    }
    case "addMarker":
      doc.timeline.markers.push({ ...copy(op.marker), by: commenter(state.changeSet.by) });
      return;
    case "removeMarker": {
      const index = doc.timeline.markers.findIndex((m) => m.id === op.markerId);
      if (index < 0) fail("not_found", `${path}.markerId`, "no marker with this id");
      doc.timeline.markers.splice(index, 1);
      return;
    }
    case "addComment": {
      const comment = { ...copy(op.comment), by: commenter(state.changeSet.by), at: state.changeSet.at, revision: state.revision };
      doc.review.comments.push(comment);
      const target = comment.target;
      if ((target.kind === "scene" || target.kind === "scene-element") && doc.storyboard) {
        doc.storyboard.scenes.find((s) => s.id === target.sceneId)?.comments.push(comment.id);
      }
      return;
    }
    case "resolveComment": {
      const comment = doc.review.comments.find((c) => c.id === op.commentId) ?? fail("not_found", `${path}.commentId`, "no comment with this id");
      if (comment.resolution) fail("invalid_op", `${path}.commentId`, "this comment is already resolved");
      comment.resolution = {
        by: commenter(state.changeSet.by),
        at: state.changeSet.at,
        changeSetId: state.changeSet.id,
        ...(op.note !== undefined ? { note: op.note } : {}),
      };
      return;
    }
  }
}

/** Trims one edge of a clip to a timeline frame, moving its source point by the same span. */
function trim(state: ApplyState, op: Extract<ProductionOp, { op: "trimClip" }>, path: string): void {
  const { track, clip } = findClip(state.draft, op.clipId, `${path}.clipId`);
  const fps = state.draft.format.fps;
  const end = clip.start + clip.duration;
  const speed = clip.kind === "video" || clip.kind === "audio" ? clip.speed ?? 1 : 1;
  if (op.edge === "in") {
    if (op.toFrame >= end) fail("invalid_op", `${path}.toFrame`, "the new start must be before the clip's end");
    const delta = op.toFrame - clip.start;
    if (clip.kind === "video" || clip.kind === "audio") {
      const inUs = clip.source.inUs + framesToSourceSpanUs(delta, fps, speed);
      if (inUs < 0) fail("invalid_op", `${path}.toFrame`, "the trim reaches before the start of the source");
      clip.source.inUs = inUs;
    }
    clip.start = op.toFrame;
    clip.duration -= delta;
    rebaseClipKeyframes(clip, delta);
  } else {
    if (op.toFrame <= clip.start) fail("invalid_op", `${path}.toFrame`, "the new end must be after the clip's start");
    clip.duration = op.toFrame - clip.start;
    if (clip.kind === "video" || clip.kind === "audio") {
      clip.source.outUs = clip.source.inUs + framesToSourceSpanUs(clip.duration, fps, speed);
    }
    rebaseClipKeyframes(clip, 0);
  }
  fitToDuration(clip);
  clip.provenance = stamp(state);
  sortClips(track);
}

/** Splits a clip at a timeline frame into two clips that together cover the same source. */
function split(state: ApplyState, op: Extract<ProductionOp, { op: "splitClip" }>, path: string): void {
  const { track, clip } = findClip(state.draft, op.clipId, `${path}.clipId`);
  const end = clip.start + clip.duration;
  if (op.atFrame <= clip.start || op.atFrame >= end) fail("invalid_op", `${path}.atFrame`, "the split must fall strictly inside the clip");
  const left = clip;
  const right = copy(clip) as Clip;
  const leftDuration = op.atFrame - clip.start;

  right.id = op.newClipId;
  right.start = op.atFrame;
  right.duration = end - op.atFrame;
  left.duration = leftDuration;

  if ((left.kind === "video" || left.kind === "audio") && (right.kind === "video" || right.kind === "audio")) {
    const splitUs = left.source.inUs + framesToSourceSpanUs(leftDuration, state.draft.format.fps, left.speed ?? 1);
    left.source.outUs = splitUs;
    right.source.inUs = splitUs;
  }
  // The left part keeps the entrance, the right part the exit.
  if (right.kind !== "audio") delete right.transitionIn;
  if (left.kind === "audio") delete left.fadeOutFrames;
  if (right.kind === "audio") delete right.fadeInFrames;
  if (left.kind === "video" && left.audio) delete left.audio.fadeOutFrames;
  if (right.kind === "video" && right.audio) delete right.audio.fadeInFrames;
  if ((right.kind === "video" || right.kind === "still") && right.effects) {
    right.effects = right.effects.map((e, k) => ({ ...e, id: `${op.newClipId}-fx${k}` }));
  }

  rebaseClipKeyframes(left, 0);
  rebaseClipKeyframes(right, leftDuration);
  fitToDuration(left);
  fitToDuration(right);
  left.provenance = stamp(state);
  right.provenance = stamp(state);
  (track.clips as Clip[]).push(right);
  sortClips(track);
}
