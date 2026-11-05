/**
 * The typed edit vocabulary for Production v2 (spec 07 §6, spec 04 §6–7).
 *
 * Every change to a production, from the UI, an agent or a capability, is a
 * change set of these operations. There is no generic "set this path" escape
 * hatch: an operation names what it changes, and whole entities it adds
 * (clips, scenes, script lines, comments) are validated in full by
 * `admitProduction()` before any result is published.
 *
 * Fields the server owns are never taken from an operation: the document's
 * id, schema version, brand, workflow, creation time, revision and update
 * time, and the provenance of what an operation creates or edits.
 */

import type {
  AssetSlot,
  AudioPlan,
  Claim,
  Clip,
  Keyframe,
  LayerPlan,
  Marker,
  MediaRef,
  NarrationDirection,
  ProductionStage,
  Realization,
  ResearchSource,
  ReviewTarget,
  Scene,
  SceneStatus,
  ScriptLine,
  ScriptSection,
  StoryStructure,
  Track,
  TransitionRef,
  VoiceSettings,
  JsonValue,
  Rect,
  HookOption,
  Production,
} from "@/types/production";
import type { BriefItem, BriefValue } from "@/types/creative-brief";
import type { AdmissionIssue } from "../primitives";

export type Actor = "user" | "agent" | "system";

/** Brief fields an operation may change; `null` clears an optional value. */
export interface BriefPatch {
  objective?: BriefValue | null;
  audience?: BriefValue | null;
  centralMessage?: BriefValue | null;
  desiredResponse?: BriefValue | null;
  brandContext?: BriefValue | null;
  callToAction?: BriefValue | null;
  constraints?: BriefItem[];
  visualDecisions?: BriefItem[];
  mustInclude?: BriefItem[];
  mustAvoid?: BriefItem[];
  tone?: string[];
  targetDurationMs?: { min: number; max: number };
}

/** Scene fields an edit may change; status, approvals and realisation have their own operations. */
export interface ScenePatch {
  title?: string;
  purpose?: Scene["purpose"];
  scriptLineIds?: string[];
  durationTargetMs?: { min: number; max: number };
  visual?: { mode: Scene["visual"]["mode"]; description: string; layers: LayerPlan[]; camera?: Scene["visual"]["camera"]; framing?: Scene["visual"]["framing"] };
  audio?: AudioPlan;
  captions?: Scene["captions"];
  transitionIn?: TransitionRef | null;
  slots?: AssetSlot[];
}

/** A new scene: provenance, status, approvals, comments and realisation are set by the engine. */
export type NewScene = Omit<Scene, "provenance" | "status" | "approvals" | "comments" | "realization">;

/** A new clip: provenance is set by the engine. */
export type NewClip = Clip extends infer C ? (C extends Clip ? Omit<C, "provenance"> : never) : never;

export type ProductionOp =
  // production and brief
  | { op: "renameProduction"; name: string }
  | { op: "setStage"; stage: ProductionStage }
  | { op: "updateBrief"; patch: BriefPatch }
  | { op: "addMedia"; media: MediaRef }
  | { op: "relabelMedia"; mediaId: string; label: string }
  | { op: "removeMedia"; mediaId: string }
  | { op: "setVoice"; voice: VoiceSettings | null }
  // research
  | { op: "addSource"; source: ResearchSource }
  | { op: "upsertClaim"; claim: Claim }
  // script
  | { op: "initScript"; origin: "written" | "generated" | "transcribed" }
  | { op: "setHookOptions"; options: HookOption[] }
  | { op: "selectHook"; hookId: string | null }
  | { op: "addScriptSection"; section: ScriptSection; afterSectionId: string | null }
  | { op: "insertScriptLine"; sectionId: string; afterLineId: string | null; line: ScriptLine }
  | {
      op: "editScriptLine";
      lineId: string;
      text?: string;
      claimIds?: string[];
      delivery?: NarrationDirection | null;
      estimatedMs?: number | null;
    }
  | { op: "removeScriptLine"; lineId: string }
  | { op: "setScriptStatus"; status: "draft" | "approved" }
  // storyboard
  | { op: "initStoryboard"; storyboardId: string }
  | { op: "addScene"; scene: NewScene; afterSceneId: string | null }
  | { op: "editScene"; sceneId: string; patch: ScenePatch }
  | { op: "removeScene"; sceneId: string }
  | { op: "reorderScenes"; sceneIds: string[] }
  | { op: "setSceneStatus"; sceneId: string; status: SceneStatus }
  | { op: "setSceneRealization"; sceneId: string; realization: Realization | null }
  | { op: "selectSlotAsset"; sceneId: string; slotId: string; assetId: string | null }
  | { op: "setStoryStructure"; structure: StoryStructure | null }
  // timeline
  | { op: "addTrack"; track: Track; index: number }
  | { op: "removeTrack"; trackId: string }
  | { op: "insertClip"; trackId: string; clip: NewClip }
  | { op: "removeClip"; clipId: string; ripple: boolean }
  | { op: "moveClip"; clipId: string; start: number; trackId?: string }
  | { op: "trimClip"; clipId: string; edge: "in" | "out"; toFrame: number }
  | { op: "splitClip"; clipId: string; atFrame: number; newClipId: string }
  | { op: "setClipKeyframes"; clipId: string; property: "framing" | "gainDb"; keyframes: Keyframe<Rect>[] | Keyframe<number>[] }
  | { op: "setClipFades"; clipId: string; fadeInFrames: number; fadeOutFrames: number }
  | { op: "setClipTransition"; clipId: string; transition: TransitionRef | null }
  | { op: "setGraphicParams"; clipId: string; params: JsonValue }
  | { op: "setClipScene"; clipId: string; sceneId: string | null }
  | { op: "addMarker"; marker: Omit<Marker, "by"> }
  | { op: "removeMarker"; markerId: string }
  // review
  | { op: "addComment"; comment: { id: string; target: ReviewTarget; text: string; kind: "note" | "change-request" | "question" } }
  | { op: "resolveComment"; commentId: string; note?: string };

export type OpName = ProductionOp["op"];

export interface ChangeSet {
  /** Caller-chosen id, recorded as the provenance of everything this change set creates or edits. */
  id: string;
  /** The revision the change was made against; any other current revision is a conflict. */
  baseRevision: number;
  /** When the change was made (ISO 8601 UTC); becomes the production's `updatedAt`. */
  at: string;
  by: Actor;
  /** The agent run this change belongs to; required for agent changes. */
  runId?: string;
  summary: string;
  /** When present, nothing outside these scenes' footprint may change (spec 04 §7). */
  scope?: { sceneIds: string[] };
  ops: ProductionOp[];
}

export type ChangeIssueCode =
  | "invalid_change_set"
  | "unknown_op"
  | "invalid_op"
  | "not_found"
  | "forbidden"
  | "invalid_transition"
  | "out_of_scope"
  | "limit_exceeded";

export interface ChangeIssue {
  /** Index of the operation in the change set, or null for the change set itself. */
  opIndex: number | null;
  path: string;
  code: ChangeIssueCode;
  message: string;
}

export type ChangeSetResult =
  | {
      status: "applied";
      production: Production;
      changeSetId: string;
      fromRevision: number;
      revision: number;
    }
  | { status: "conflict"; reason: "stale_revision" | "run_in_progress" | "no_open_run"; expectedRevision: number; actualRevision: number; message: string }
  | { status: "rejected"; stage: "change_set" | "operations" | "scope" | "admission"; issues: Array<ChangeIssue | AdmissionIssue> };
