/**
 * The render manifest (#144): what a finished render is and how it was made,
 * written as `manifest.json` beside the video so a deliverable can be traced
 * to the exact production revision, code versions, tools, fonts and overlay
 * document that produced it, and checked against its own hashes.
 *
 * It holds identifiers, versions, hashes and measurements only: never a file
 * path, a media file name or any text from the production.
 */
import type { ExecuteResult, FontAsset, LoudnessResult, OverlayDocument } from "./execute-types";
import type { RenderPlan } from "./plan";
import type { ExportProfile } from "./profile";
import type { VerificationReport } from "./verify";

export const MANIFEST_SCHEMA_VERSION = 1;

/** A published file of the render, by name, with its size and SHA-256. */
export interface RenderOutput {
  name: string;
  sha256: string;
  bytes: number;
}

export interface RenderManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  renderId: string;
  productionId: string;
  revision: number;
  profile: { id: ExportProfile["id"]; version: number };
  planVersion: number;
  compilerVersion: number;
  canvas: RenderPlan["canvas"];
  durationFrames: number;
  /** Every media the render read, by content hash. */
  inputs: { mediaId: string; kind: "video" | "audio" | "image" }[];
  fonts: { family: string; weight: number; sha256: string; source: string }[];
  overlay: {
    /** SHA-256 of the overlay document. */
    sha256: string;
    framesCaptured: number;
    /** SHA-256 over the captured overlay frames in order. */
    digest: string;
  };
  tools: { ffmpeg: string; chrome: string; puppeteer: string; node: string };
  /** SHA-256 of the Chromium raster flags, so a change of flags shows in the manifest. */
  chromeArgsSha256: string;
  workers: number;
  loudness: LoudnessResult & { targetLufs: number; truePeakCeilingDb: number };
  verification: VerificationReport;
  /** The video and caption sidecars; the manifest cannot carry its own hash. */
  outputs: RenderOutput[];
  timings: { overlayMs: number; videoMs: number; audioMs: number; executeMs: number; verifyMs: number };
  createdAt: string;
}

export interface ManifestInput {
  renderId: string;
  plan: RenderPlan;
  profile: ExportProfile;
  compilerVersion: number;
  fonts: readonly FontAsset[];
  overlay: OverlayDocument;
  execution: ExecuteResult;
  verification: VerificationReport;
  outputs: readonly RenderOutput[];
  verifyMs: number;
  createdAt: string;
  /** Defaults to this process's Node.js version. */
  node?: string;
}

/** Builds the manifest from the render's parts. Pure, apart from the Node.js version default. */
export function buildManifest(input: ManifestInput): RenderManifest {
  const { plan, profile, execution } = input;
  const fonts = input.fonts
    .map((f) => ({ family: f.family, weight: f.weight, sha256: f.sha256, source: f.source }))
    .sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || a.sha256.localeCompare(b.sha256));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    renderId: input.renderId,
    productionId: plan.productionId,
    revision: plan.revision,
    profile: { id: profile.id, version: profile.version },
    planVersion: plan.version,
    compilerVersion: input.compilerVersion,
    canvas: { ...plan.canvas },
    durationFrames: plan.durationFrames,
    inputs: plan.inputs.map((i) => ({ mediaId: i.mediaId, kind: i.kind })).sort((a, b) => a.mediaId.localeCompare(b.mediaId)),
    fonts,
    overlay: { sha256: input.overlay.sha256, framesCaptured: execution.overlayFramesCaptured, digest: execution.overlayDigest },
    tools: { ...execution.tools, node: input.node ?? process.versions.node },
    chromeArgsSha256: execution.chromeArgsSha256,
    workers: execution.workers,
    loudness: { targetLufs: plan.loudness.targetLufs, truePeakCeilingDb: profile.loudness.truePeakDb, ...execution.loudness },
    verification: input.verification,
    outputs: input.outputs.map((o) => ({ name: o.name, sha256: o.sha256, bytes: o.bytes })),
    timings: {
      overlayMs: execution.timings.overlayMs,
      videoMs: execution.timings.videoMs,
      audioMs: execution.timings.audioMs,
      executeMs: execution.timings.totalMs,
      verifyMs: input.verifyMs,
    },
    createdAt: input.createdAt,
  };
}
