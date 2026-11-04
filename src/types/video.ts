/**
 * Video Studio Production v2 domain contract.
 *
 * This is an incremental, renderer-independent foundation for the complete
 * production document in docs/research/video-studio/spec/07-data-models-and-interfaces.md.
 * Never use these interfaces alone to trust incoming JSON: validate it first.
 */
export const VIDEO_SCHEMA_VERSION = 2 as const;
export type VideoWorkflow = "footage" | "script" | "hybrid";
export type VideoUsageIntent = "personal" | "commercial" | "client";
export type VideoStage =
  | "brief" | "research" | "script" | "ingest" | "selects"
  | "storyboard" | "production" | "assembly" | "review"
  | "finishing" | "delivered" | "archived";
export type VideoPlatform =
  | "instagram-reel" | "tiktok" | "youtube-short" | "linkedin"
  | "youtube" | "custom";
export type VideoFrameRate = 24 | 25 | 30 | 60;

export interface VideoOutputFormat {
  width: number;
  height: number;
  fps: VideoFrameRate;
  platform: VideoPlatform;
  maxDurationMs: number;
}

/** Original files are immutable and referenced by their SHA-256 media IDs. */
export interface VideoMediaRef {
  mediaId: string;
  role: "a-roll" | "b-roll" | "voice" | "music" | "sfx" | "image" | "illustration" | "logo";
  label: string;
  rightsRecordId?: string;
}

export interface VideoSourceRange {
  mediaId: string;
  /** Integer microseconds in the unmodified source, including VFR recordings. */
  inUs: number;
  outUs: number;
}

export interface VideoClipBase {
  id: string;
  /** Integer frame index on the canonical output timeline. */
  start: number;
  duration: number;
  sceneId?: string;
}

export interface VideoSourceClip extends VideoClipBase {
  kind: "video" | "audio";
  source: VideoSourceRange;
}

export interface VideoGraphicClip extends VideoClipBase {
  kind: "graphic";
  capabilityId: string;
  capabilityVersion: string;
  /** Pure JSON data; capability-specific schema is checked by its adapter. */
  params: Record<string, unknown>;
}

export type VideoClip = VideoSourceClip | VideoGraphicClip;
export interface VideoTrack {
  id: string;
  kind: "video" | "graphics" | "audio";
  clips: VideoClip[];
}

export interface VideoScene {
  id: string;
  title: string;
  /** Script/narration IDs or transcribed speech IDs, depending on workflow. */
  lineIds: string[];
  status: "proposed" | "approved" | "rejected" | "produced";
  /** A draft scene need not own clips until materialized. */
  realizationClipIds: string[];
}
export interface VideoStoryboard {
  id: string;
  status: "draft" | "in-review" | "approved" | "locked";
  scenes: VideoScene[];
}

export interface VideoScriptLine {
  id: string;
  speaker: "on-camera" | "narrator" | "character";
  text: string;
  characterId?: string;
}
export interface VideoScript {
  origin: "written" | "generated" | "transcribed";
  status: "draft" | "approved";
  lines: VideoScriptLine[];
}
export interface VideoSpeechWord {
  id: string;
  text: string;
  startUs: number;
  endUs: number;
}
export interface VideoSpeechSpine {
  kind: "recorded" | "narrated";
  sourceMediaId?: string;
  words: VideoSpeechWord[];
}

export interface VideoProduction {
  schemaVersion: typeof VIDEO_SCHEMA_VERSION;
  id: string;
  name: string;
  brandId: string;
  workflow: VideoWorkflow;
  usageIntent: VideoUsageIntent;
  revision: number;
  stage: VideoStage;
  format: VideoOutputFormat;
  media: VideoMediaRef[];
  script: VideoScript | null;
  storyboard: VideoStoryboard | null;
  /** Analysis records live beside immutable media, not inside the timeline. */
  speechSpine: VideoSpeechSpine | null;
  timeline: { tracks: VideoTrack[] };
  createdAt: string;
  updatedAt: string;
}
