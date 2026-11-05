/**
 * The seam between render jobs and the executor (#144). The executor turns a
 * compiled plan and its overlay document into an encoded MP4 in a scratch
 * folder; render jobs own the lifecycle, the verification, the manifest and
 * the publish.
 */
import type { MediaRecord } from "@/lib/video/media/registry";
import type { ExportProfile } from "./profile";
import type { RenderPlan } from "./plan";

/** The overlay document the compiler's graphics compile to, for one target. */
export interface OverlayDocument {
  /** A complete HTML document with no script, timed by `--t`. */
  html: string;
  /** Frames on which at least one graphic is visible, `[startFrame, endFrame)`, sorted and disjoint. Frames outside are fully transparent and need no capture. */
  activeRanges: { startFrame: number; endFrame: number }[];
  /** SHA-256 hex of `html`. */
  sha256: string;
}

/** A bundled font the overlay document may load, served from memory to the export browser. */
export interface FontAsset {
  /** The path the overlay document requests it at, e.g. `/fonts/inter-latin-800-normal.woff2`. */
  urlPath: string;
  family: string;
  weight: number;
  bytes: Buffer;
  sha256: string;
  /** Package and version, for the manifest. */
  source: string;
}

export type RenderStage = "overlay" | "video" | "audio" | "mux";

export interface RenderProgress {
  stage: RenderStage;
  /** Units done and total within the stage (frames for overlay and video). */
  done: number;
  total: number;
}

export interface ExecuteOptions {
  plan: RenderPlan;
  profile: ExportProfile;
  overlay: OverlayDocument;
  fonts: readonly FontAsset[];
  /** The original of every plan input, by media id. */
  media: ReadonlyMap<string, { record: MediaRecord; originalPath: string }>;
  /** An empty scratch folder the executor may fill; the caller removes it. */
  workDir: string;
  /** Overlay browsers to run in parallel (ADR default 4). */
  workers: number;
  signal: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}

export interface LoudnessResult {
  /** What the first pass measured on the mix before normalisation. */
  measured: { integratedLufs: number; truePeakDb: number; lra: number; thresholdLufs: number } | null;
  /** `linear` and `dynamic` are loudnorm's own report; `skipped-silence` means the mix is below the profile's silence floor; `no-audio` means the plan has no sound. */
  normalisation: "linear" | "dynamic" | "skipped-silence" | "no-audio";
}

export interface ExecuteResult {
  /** The encoded MP4 inside `workDir`. */
  videoFile: string;
  /** Overlay frames captured by the browsers; transparent frames outside `activeRanges` are not captured. */
  overlayFramesCaptured: number;
  /** SHA-256 over the captured overlay frames in order, for determinism checks. */
  overlayDigest: string;
  loudness: LoudnessResult;
  tools: { ffmpeg: string; chrome: string; puppeteer: string };
  /** SHA-256 hex of the joined Chromium raster flags used. */
  chromeArgsSha256: string;
  workers: number;
  timings: { overlayMs: number; videoMs: number; audioMs: number; totalMs: number };
}

export type RenderFailureClass = "transient" | "permanent" | "configuration";

/**
 * Codes: `timeout`, `interrupted`, `io_error` (transient); `tool_failed`,
 * `overlay_navigation`, `overlay_request_blocked`, `overlay_font_failed`,
 * `internal_error` (permanent); `tool_missing`, `ffmpeg_too_old`,
 * `encoder_missing`, `browser_missing`, `hdr_conversion_unavailable`
 * (configuration). Messages never contain paths.
 */
export class RenderFailure extends Error {
  constructor(
    readonly failureClass: RenderFailureClass,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RenderFailure";
  }
}
