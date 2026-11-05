/**
 * The render plan (#144): everything the executor needs to produce a
 * deliverable, compiled from one admitted production revision. It is the one
 * description of picture, sound and graphics that both the export and the
 * Studio preview follow (ADR decision 3), so nothing here may depend on where
 * it is played.
 *
 * Units: timeline positions are integer frames at `canvas.fps`; source
 * positions are integer microseconds; gain envelope times are integer
 * microseconds of timeline time; sizes are integer pixels.
 */
import type { CapabilityCall, FrameRate } from "@/types/production";
import type { ExportProfileId } from "./profile";

export const PLAN_VERSION = 1;

export interface RenderPlan {
  version: typeof PLAN_VERSION;
  productionId: string;
  revision: number;
  profile: ExportProfileId;
  canvas: { width: number; height: number; fps: FrameRate };
  /** The output length: the end of the last clip on any track. */
  durationFrames: number;
  /** Picture layers, bottom to top. Where none covers a frame the output is black. */
  video: VideoLayer[];
  /** Every sound in the mix, in no particular order. */
  audio: AudioSource[];
  /** Front graphics in drawing order, bottom to top. */
  graphics: GraphicPlacement[];
  /** Caption cues in absolute frames, ordered by start, for the SRT and WebVTT sidecars. */
  captions: CaptionCue[];
  /** Every media the plan reads, once each. */
  inputs: PlanInput[];
  /** Loudness target from `Timeline.audio.masterLufs`. */
  loudness: { targetLufs: number };
}

export interface PlanInput {
  mediaId: string;
  kind: "video" | "audio" | "image";
  /** Upright display size (coded size with rotation applied); absent for audio. */
  display?: { width: number; height: number };
  /** Clockwise rotation from the media record. */
  rotation: 0 | 90 | 180 | 270;
  /** HLG and PQ video is converted to BT.709 before compositing (G2). */
  dynamicRange: "sdr" | "hlg" | "pq";
  hasAudio: boolean;
  /** From the media record, so the executor can pad past the end of a source. */
  durationUs?: number;
}

/**
 * Cover-fit placement, computed once by the compiler: scale the upright source
 * to `scaledWidth` x `scaledHeight`, then show the canvas-sized window whose
 * top-left corner is at (`offsetX`, `offsetY`) of the scaled picture. The
 * export expresses it as `scale` then `crop`; the preview sizes and offsets a
 * `<video>` or `<img>` element by the same numbers (`layerBox`).
 */
export interface CoverPlacement {
  scaledWidth: number;
  scaledHeight: number;
  offsetX: number;
  offsetY: number;
}

export interface VideoLayer {
  clipId: string;
  trackId: string;
  /** The track's index in `Timeline.tracks`; layers on higher tracks draw on top. */
  trackIndex: number;
  kind: "video" | "still";
  mediaId: string;
  startFrame: number;
  durationFrames: number;
  /** Video layers: the source time shown at the clip's first frame. Frame k shows `sourceInUs + round(k * 1e6 / fps)`. */
  sourceInUs?: number;
  placement: CoverPlacement;
}

/** One point of a piecewise-linear gain envelope; gain is linear amplitude (1 = unchanged). */
export interface GainPoint {
  atUs: number;
  gain: number;
}

export interface AudioSource {
  /** The clip this sound comes from: an audio clip, or a video clip's own sound. */
  clipId: string;
  trackId: string;
  /** `voice` for voice tracks and a-roll video sound; ducking lowers `music`, `sfx` and `ambience` under voice. */
  role: "voice" | "music" | "sfx" | "ambience" | "b-roll";
  mediaId: string;
  startFrame: number;
  durationFrames: number;
  sourceInUs: number;
  /**
   * The clip's whole gain automation in timeline time: gain keyframes, fades
   * and ducking multiplied together, sampled densely enough that linear
   * interpolation between points is within 0.1 dB of the exact curve. The
   * first point is at the clip's start and the last at its end; outside the
   * clip the source is silent.
   */
  envelope: GainPoint[];
}

export interface GraphicPlacement {
  clipId: string;
  trackId: string;
  trackIndex: number;
  capability: CapabilityCall;
  startFrame: number;
  durationFrames: number;
}

export interface CaptionCue {
  clipId: string;
  startFrame: number;
  endFrame: number;
  text: string;
}

/** Why a production cannot be compiled; each names where in the document the problem is. */
export type CompileIssueCode =
  | "empty_timeline"
  | "profile_mismatch"
  | "duration_exceeds_profile"
  | "unsupported_feature"
  | "capability_unavailable"
  | "invalid_capability_params"
  | "media_not_registered"
  | "media_kind_mismatch"
  | "no_audio_stream";

export interface CompileIssue {
  code: CompileIssueCode;
  /** JSON-pointer-like path into the production, e.g. `/timeline/tracks/1/clips/0/speed`. */
  path: string;
  message: string;
  clipId?: string;
}

export type CompileResult = { ok: true; plan: RenderPlan } | { ok: false; issues: CompileIssue[] };

/** Canvas-pixel box of a layer's element in the preview, from its cover placement. */
export interface LayerBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The preview layout contract: where a layer's `<video>` or `<img>` sits on the canvas. */
export function layerBox(placement: CoverPlacement): LayerBox {
  return { left: -placement.offsetX, top: -placement.offsetY, width: placement.scaledWidth, height: placement.scaledHeight };
}
