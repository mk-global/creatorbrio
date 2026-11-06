/**
 * Export profiles (#144): what a deliverable must be, independent of the
 * production being rendered. The compiler refuses a production the profile
 * cannot carry; the executor encodes with these settings; the verifier checks
 * the file against them.
 */
import type { FrameRate } from "@/types/production";

export interface ExportProfile {
  id: "instagram";
  /** Bumped whenever an encoding setting changes, and recorded in the manifest. */
  version: number;
  label: string;
  /** Canvas sizes this profile accepts, as `${width}x${height}`. */
  canvases: readonly string[];
  frameRates: readonly FrameRate[];
  video: {
    codec: "h264";
    encoder: "libx264";
    /** ffprobe's `profile` value the output must have. */
    profile: "High";
    pixelFormat: "yuv420p";
    preset: "medium";
    crf: number;
    /** VBV cap so a busy scene cannot exceed what the platform re-encodes well. */
    maxrateKbps: number;
    bufsizeKbps: number;
    /** Keyframe interval in seconds; the GOP is this times the frame rate. */
    keyframeSeconds: number;
    /** Encoder threads are fixed so two renders of one revision encode identically. */
    threads: number;
    /** BT.709 limited range, written as frame tags and stream tags. */
    color: { primaries: "bt709"; transfer: "bt709"; matrix: "bt709"; range: "tv" };
  };
  audio: {
    codec: "aac";
    /** ffprobe's `profile` value for AAC-LC. */
    profile: "LC";
    sampleRate: 48000;
    channels: 2;
    bitrateKbps: number;
  };
  loudness: {
    /** True-peak ceiling in dBTP. The integrated target is the production's `masterLufs`. */
    truePeakDb: number;
    /** How far the measured integrated loudness may be from the target, in LU. */
    toleranceLu: number;
    /** Below this integrated loudness the mix is treated as silence and not normalised. */
    silenceLufs: number;
  };
  container: { format: "mp4"; faststart: true };
}

export const INSTAGRAM_PROFILE: ExportProfile = {
  id: "instagram",
  version: 1,
  label: "Instagram (Reels and feed video)",
  canvases: ["1080x1920", "1080x1350", "1080x1080"],
  frameRates: [24, 25, 30, 60],
  video: {
    codec: "h264",
    encoder: "libx264",
    profile: "High",
    pixelFormat: "yuv420p",
    preset: "medium",
    crf: 18,
    maxrateKbps: 20_000,
    bufsizeKbps: 40_000,
    keyframeSeconds: 2,
    threads: 4,
    color: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
  },
  audio: { codec: "aac", profile: "LC", sampleRate: 48000, channels: 2, bitrateKbps: 192 },
  loudness: { truePeakDb: -1, toleranceLu: 1, silenceLufs: -70 },
  container: { format: "mp4", faststart: true },
};

export const EXPORT_PROFILES = { instagram: INSTAGRAM_PROFILE } as const;
export type ExportProfileId = keyof typeof EXPORT_PROFILES;
