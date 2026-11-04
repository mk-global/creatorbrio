/**
 * Production v2: the one versioned document a Video Studio production lives in.
 *
 * Specification: docs/research/video-studio/spec/07-data-models-and-interfaces.md
 * (§1 production document, §2 brief/research/script, §3 speech spine, §8 stages)
 * and spec/04-storyboard-and-review.md (§2 scene schema). The timeline keeps the
 * merged research's time model: integer frames on the timeline, integer
 * microseconds into source media.
 *
 * These types describe the persisted shape only. Every document read from disk
 * or received from a client is untrusted until `admitProduction()` in
 * `src/lib/video/production` has accepted it.
 */

import type { AssetRelationship, BriefItem, BriefValue } from "./creative-brief";

// ---------------------------------------------------------------------------
// Enumerations

export const PRODUCTION_SCHEMA_VERSION = 2 as const;

export const WORKFLOWS = ["footage", "script", "hybrid"] as const;
export type Workflow = (typeof WORKFLOWS)[number];

export const USAGE_INTENTS = ["personal", "commercial", "client"] as const;
export type UsageIntent = (typeof USAGE_INTENTS)[number];

export const PRODUCTION_STAGES = [
  "brief",
  "research",
  "script",
  "ingest",
  "selects",
  "storyboard",
  "production",
  "assembly",
  "review",
  "finishing",
  "delivered",
  "archived",
] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

export const FRAME_RATES = [24, 25, 30, 60] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export const PLATFORMS = [
  "instagram-reel",
  "tiktok",
  "youtube-short",
  "linkedin",
  "youtube",
  "custom",
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Canvas sizes a production can be built at (spec 07 §1). */
export const CANVAS_SIZES = [
  { width: 1080, height: 1920 },
  { width: 1080, height: 1350 },
  { width: 1080, height: 1080 },
  { width: 1920, height: 1080 },
] as const;

/**
 * What a registered media file is used as in this production. The role fixes
 * the media kind: video roles carry pictures (and usually sound), the others
 * are audio-only or still images.
 */
export const MEDIA_ROLES = ["a-roll", "b-roll", "narration", "music", "sfx", "image", "logo"] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];
export type MediaKind = "video" | "audio" | "image";

// ---------------------------------------------------------------------------
// Production

export interface OutputFormat {
  width: number;
  height: number;
  fps: FrameRate;
  /** Platform target, checked by QA; the timeline may exceed it while editing. */
  maxDurationMs: number;
  platform: Platform;
}

export interface Production {
  schemaVersion: typeof PRODUCTION_SCHEMA_VERSION;
  id: string;
  name: string;
  /** Fixed at creation, as with carousels. */
  brandId: string;
  styleProfileId: string | null;
  workflow: Workflow;
  usageIntent: UsageIntent;
  /** Incremented by every applied change set. */
  revision: number;
  stage: ProductionStage;
  format: OutputFormat;
  brief: ProductionBrief;
  research: ResearchDossier | null;
  script: Script | null;
  storyboard: Storyboard | null;
  /** The registered media this production uses, by content hash. */
  media: MediaRef[];
  timeline: Timeline;
  voice: VoiceSettings | null;
  review: ReviewState;
  deliverables: Deliverable[];
  createdAt: string;
  updatedAt: string;
}

export interface MediaRef {
  /** SHA-256 of the original's bytes, lower-case hex. */
  mediaId: string;
  role: MediaRole;
  label: string;
}

export interface Deliverable {
  id: string;
  label: string;
  format: OutputFormat;
}

// ---------------------------------------------------------------------------
// Brief

export const AUDIENCE_KNOWLEDGE = ["novice", "intermediate", "expert"] as const;

/** The Creative Brief of `src/types/creative-brief.ts`, extended for video. */
export interface ProductionBrief {
  objective?: BriefValue;
  audience?: BriefValue;
  centralMessage?: BriefValue;
  desiredResponse?: BriefValue;
  brandContext?: BriefValue;
  constraints: BriefItem[];
  visualDecisions: BriefItem[];
  assetRelationships: AssetRelationship[];
  platform: Platform;
  targetDurationMs: { min: number; max: number };
  tone: string[];
  callToAction?: BriefValue;
  mustInclude: BriefItem[];
  mustAvoid: BriefItem[];
  audienceKnowledge: (typeof AUDIENCE_KNOWLEDGE)[number];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Research

export const SOURCE_KINDS = ["url", "document", "user-note"] as const;
export const SOURCE_RELIABILITY = ["primary", "reputable-secondary", "unverified"] as const;
export const CLAIM_STATUSES = ["supported", "unsupported", "disputed", "user-asserted"] as const;

export interface ResearchDossier {
  questions: string[];
  sources: ResearchSource[];
  claims: Claim[];
  status: "draft" | "reviewed";
}

export interface ResearchSource {
  id: string;
  kind: (typeof SOURCE_KINDS)[number];
  url?: string;
  title: string;
  publisher?: string;
  retrievedAt: string;
  /** SHA-256 of the extracted-text side file. */
  blob: string;
  reliability: (typeof SOURCE_RELIABILITY)[number];
  retrievedBy: "user" | "source-retrieval";
}

export interface Claim {
  id: string;
  text: string;
  sourceIds: string[];
  status: (typeof CLAIM_STATUSES)[number];
  /** Health, finance or legal: needs care on screen. */
  sensitive: boolean;
}

// ---------------------------------------------------------------------------
// Script

export const SCRIPT_ORIGINS = ["written", "generated", "transcribed"] as const;
export const HOOK_TECHNIQUES = ["question", "bold-claim", "story", "contrast", "statistic", "demonstration"] as const;
export const SECTION_ROLES = ["hook", "context", "point", "example", "transition", "summary", "cta"] as const;
export const SPEAKERS = ["narrator", "on-camera", "character"] as const;

export interface Script {
  /** Footage productions transcribe; script productions write or generate. */
  origin: (typeof SCRIPT_ORIGINS)[number];
  hookOptions: HookOption[];
  selectedHookId: string | null;
  sections: ScriptSection[];
  status: "draft" | "approved";
}

export interface HookOption {
  id: string;
  text: string;
  technique: (typeof HOOK_TECHNIQUES)[number];
  rationale: string;
}

export interface ScriptSection {
  id: string;
  role: (typeof SECTION_ROLES)[number];
  lines: ScriptLine[];
}

export interface ScriptLine {
  id: string;
  speaker: (typeof SPEAKERS)[number];
  characterId?: string;
  text: string;
  claimIds: string[];
  delivery?: NarrationDirection;
  estimatedMs?: number;
  /** Footage only: where this line was actually spoken. */
  spoken?: SpokenAnchor;
}

export interface SpokenAnchor {
  mediaId: string;
  fromWordId: string;
  toWordId: string;
  takeGroupId?: string;
}

// ---------------------------------------------------------------------------
// Speech spine (extension types; no ASR or TTS runs in this slice)

/** Engine directions for one narrated line or scene (spec 07 §3). */
export interface NarrationDirection {
  /** Relative speaking rate, 0.8–1.25. */
  rate: number;
  pitchShift?: number;
  energy?: "calm" | "neutral" | "energetic";
  pausesMs?: Array<{ afterWordIndex: number; ms: number }>;
  emphasis?: number[];
  pronunciations?: Record<string, string>;
}

export interface VoiceSettings {
  voiceId: string;
  defaultDirection: NarrationDirection;
  lexiconId: string | null;
}

/**
 * Word-timed speech, from ASR of footage (workflow A) or from TTS timings or
 * forced alignment of narration (workflow B). Stored beside the media it
 * describes, keyed by content hash and tool version, not in the production.
 */
export interface Transcript {
  mediaId: string;
  engine: string;
  language: string;
  words: TranscriptWord[];
  utterances: Array<{ id: string; wordIds: string[] }>;
  takeGroups?: Array<{ id: string; utteranceIds: string[]; recommended: string; reason: string }>;
  corrections: Array<{ wordId: string; text: string }>;
}

export interface TranscriptWord {
  id: string;
  text: string;
  /** Microseconds into the media's audio. */
  startUs: number;
  endUs: number;
  confidence?: number;
  kind: "word" | "filler" | "breath";
}

/** One synthesised rendition of one or more script lines. */
export interface NarrationTake {
  id: string;
  scriptLineIds: string[];
  voiceId: string;
  direction: NarrationDirection;
  /** The narration WAV in the asset ledger. */
  assetId: string;
  transcriptId: string;
  status: "candidate" | "selected" | "rejected";
}

// ---------------------------------------------------------------------------
// Storyboard (spec 04 §2)

export const STORY_PATTERNS = [
  "hook-problem-solution-cta",
  "list",
  "story",
  "explainer",
  "myth-vs-fact",
  "before-after",
  "custom",
] as const;
export const SCENE_PURPOSES = ["hook", "context", "point", "example", "evidence", "transition", "summary", "cta"] as const;
export const SCENE_STATUSES = [
  "proposed",
  "approved",
  "changes_requested",
  "rejected",
  "producing",
  "blocked",
  "realized",
  "final",
  "locked",
] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];
export const VISUAL_MODES = [
  "a-roll",
  "a-roll-overlay",
  "b-roll",
  "animated-scene",
  "diagram",
  "illustration",
  "collage",
  "stock",
  "screen-recording",
  "title-card",
  "mixed",
] as const;
export const CAMERA_MOVES = ["static", "push-in", "pull-out", "pan", "punch-in"] as const;
export const SUBJECT_FRAMINGS = ["full", "subject-left", "subject-right", "subject-small"] as const;
export const SLOT_KINDS = ["video", "image", "audio", "music", "sfx", "illustration", "character"] as const;
export const SOURCING_ROUTES = ["user-library", "connector", "generate", "capture"] as const;
export const TEXT_ROLES = ["title", "key-point", "lower-third", "citation"] as const;

export interface Storyboard {
  id: string;
  scenes: Scene[];
  /** Absent until scenes exist to choose a hook from. */
  structure: StoryStructure | null;
  status: "draft" | "in-review" | "approved" | "locked";
}

export interface StoryStructure {
  pattern: (typeof STORY_PATTERNS)[number];
  hookSceneId: string;
  targetDurationMs: number;
  rationale: string;
}

export interface Scene {
  id: string;
  title: string;
  purpose: (typeof SCENE_PURPOSES)[number];
  scriptLineIds: string[];
  durationTargetMs: { min: number; max: number };
  visual: VisualPlan;
  audio: AudioPlan;
  captions: { presetId?: string; emphasisWordIds: string[]; hidden?: boolean };
  transitionIn?: TransitionRef;
  slots: AssetSlot[];
  status: SceneStatus;
  approvals: Approval[];
  /** Ids of review comments on this scene. */
  comments: string[];
  realization?: Realization;
  frames: StoryboardFrame[];
  provenance: Provenance;
}

export interface VisualPlan {
  mode: (typeof VISUAL_MODES)[number];
  description: string;
  layers: LayerPlan[];
  camera?: { move: (typeof CAMERA_MOVES)[number]; onWordIds?: string[] };
  framing?: (typeof SUBJECT_FRAMINGS)[number];
}

export type LayerPlan =
  | { kind: "a-roll"; take: "selected" }
  | { kind: "media"; slotId: string; fit: "cover" | "contain"; kenBurns?: boolean }
  | { kind: "capability"; capability: CapabilityCall; layer: GraphicsLayer }
  | { kind: "scene-spec"; specId: string }
  | { kind: "text"; role: (typeof TEXT_ROLES)[number]; text: string; claimIds?: string[] };

export interface AudioPlan {
  musicCue?: { mood: string; intensity: "low" | "medium" | "high"; trackSlotId?: string };
  sfx: Array<{ at: SfxAnchor; intent: string; slotId?: string }>;
  ambience?: { intent: string; slotId?: string };
  voiceDirection?: NarrationDirection;
}

export type SfxAnchor = "scene-start" | { wordId: string } | { layerEvent: string };

export interface AssetSlot {
  id: string;
  need: string;
  kind: (typeof SLOT_KINDS)[number];
  sourcing: Array<(typeof SOURCING_ROUTES)[number]>;
  candidates: Array<{ assetId: string; score: number; reason: string }>;
  /** Must be one of the production's media once chosen. */
  selectedAssetId: string | null;
}

export interface Approval {
  by: "user";
  at: string;
  revision: number;
  scope: "plan" | "realization";
}

export interface Realization {
  /** Timeline clips this scene owns; each carries the scene's id. */
  clipIds: string[];
  materializedAtRevision: number;
  fingerprint: string;
  diverged: boolean;
}

export interface StoryboardFrame {
  id: string;
  /** Milliseconds from the start of the scene. */
  atMs: number;
  /** The rendered still in the asset ledger, once rendered. */
  assetId: string | null;
}

// ---------------------------------------------------------------------------
// Timeline (the merged research's edit decision document)

export const TRACK_KINDS = ["video", "graphics", "audio"] as const;
export const VIDEO_TRACK_ROLES = ["a-roll", "b-roll", "overlay"] as const;
export const AUDIO_TRACK_ROLES = ["voice", "music", "sfx", "ambience"] as const;
export const GRAPHICS_LAYERS = ["front", "behind-subject"] as const;
export type GraphicsLayer = (typeof GRAPHICS_LAYERS)[number];

export interface Timeline {
  /** Ordered bottom to top. */
  tracks: Track[];
  captions: { presetId: string | null; hidden: boolean } | null;
  audio: { masterLufs: number; ducking: DuckingPolicy };
  markers: Marker[];
}

export interface DuckingPolicy {
  depthDb: number;
  attackMs: number;
  releaseMs: number;
}

export type Track =
  | { id: string; kind: "video"; role: (typeof VIDEO_TRACK_ROLES)[number]; hidden: boolean; clips: Array<VideoClip | StillClip> }
  | { id: string; kind: "graphics"; hidden: boolean; clips: GraphicsClip[] }
  | { id: string; kind: "audio"; role: (typeof AUDIO_TRACK_ROLES)[number]; muted: boolean; clips: AudioClip[] };

export interface ClipBase {
  id: string;
  /** Timeline frame at the production's frame rate. */
  start: number;
  /** Length in frames, at least 1. */
  duration: number;
  /** The storyboard scene that owns this clip, if any. */
  sceneId?: string;
  provenance: Provenance;
}

/** A range of a source file, in integer microseconds, `inUs < outUs`. */
export interface SourceRange {
  mediaId: string;
  inUs: number;
  outUs: number;
}

export interface VideoClip extends ClipBase {
  kind: "video";
  source: SourceRange;
  /** Constant playback speed; 1 is normal. */
  speed?: number;
  /** Crop in source pixels over the clip's frames. */
  framing?: Keyframe<Rect>[];
  effects?: EffectRef[];
  audio?: { gainDb: Keyframe<number>[]; fadeInFrames?: number; fadeOutFrames?: number };
  transitionIn?: TransitionRef;
}

export interface StillClip extends ClipBase {
  kind: "still";
  mediaId: string;
  framing?: Keyframe<Rect>[];
  effects?: EffectRef[];
  transitionIn?: TransitionRef;
}

export interface GraphicsClip extends ClipBase {
  kind: "graphics";
  capability: CapabilityCall;
  layer: GraphicsLayer;
  renderCacheKey?: string;
  transitionIn?: TransitionRef;
}

export interface AudioClip extends ClipBase {
  kind: "audio";
  source: SourceRange;
  speed?: number;
  gainDb: Keyframe<number>[];
  fadeInFrames?: number;
  fadeOutFrames?: number;
  processing?: { denoise?: number; eqPreset?: string; normalise?: boolean };
}

export type Clip = VideoClip | StillClip | GraphicsClip | AudioClip;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out", "hold"] as const;

/** A value at a frame relative to the clip's start (0 … duration). */
export interface Keyframe<T> {
  frame: number;
  value: T;
  ease?: (typeof EASINGS)[number];
}

/** A versioned capability with parameters as plain JSON (spec 07 §5). */
export interface CapabilityCall {
  id: string;
  version: string;
  params: JsonValue;
}

export interface EffectRef {
  id: string;
  capability: CapabilityCall;
}

export interface TransitionRef {
  capability: CapabilityCall;
  durationFrames: number;
}

export interface Provenance {
  by: "user" | "agent" | "system";
  changeSetId: string;
  reason?: string;
}

export interface Marker {
  id: string;
  fromFrame: number;
  toFrame: number;
  note: string;
  kind: "note" | "question";
  by: "user" | "agent";
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Review (spec 04 §7)

export type ReviewTarget =
  | { kind: "production" }
  | { kind: "script-line"; lineId: string }
  | { kind: "scene"; sceneId: string }
  | { kind: "scene-element"; sceneId: string; elementId: string }
  | { kind: "time-range"; fromFrame: number; toFrame: number }
  | { kind: "clip"; clipId: string }
  | { kind: "asset"; assetId: string };

export interface ReviewComment {
  id: string;
  target: ReviewTarget;
  text: string;
  kind: "note" | "change-request" | "question";
  by: "user" | "agent";
  at: string;
  revision: number;
  resolution?: { by: "user" | "agent"; at: string; changeSetId?: string; note?: string };
}

export interface ReviewState {
  comments: ReviewComment[];
}
