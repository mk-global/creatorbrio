/**
 * The durable shapes of a render (#144): the request snapshot, the job
 * record, the files a render publishes, the pipeline seam and how attempt
 * errors are classified. `RenderJobs` (jobs.ts) owns their lifecycle.
 */
import type { Production } from "@/types/production";
import { ToolError } from "../media/tools";
import type { ProcessOwner } from "../process-owner";
import { RenderFailure, type RenderFailureClass, type RenderProgress } from "./execute-types";
import type { RenderManifest } from "./manifest";
import { EXPORT_PROFILES, type ExportProfileId } from "./profile";
import type { VerificationReport } from "./verify";

export const RENDER_JOB_VERSION = 1;
export const RENDER_REQUEST_VERSION = 1;
export const MAX_RENDER_ATTEMPTS = 3;

/** The files a succeeded render serves, with their content types. */
export const RENDER_FILES = {
  "video.mp4": "video/mp4",
  "manifest.json": "application/json",
  "captions.srt": "application/x-subrip; charset=utf-8",
  "captions.vtt": "text/vtt; charset=utf-8",
} as const;
export type RenderFileName = keyof typeof RENDER_FILES;

/** What a pipeline must leave in its work folder; render jobs write manifest.json and verification.json. */
export const PIPELINE_FILES = ["video.mp4", "captions.srt", "captions.vtt"] as const;
/** Everything an attempt moves into the render folder. */
export const PUBLISHED_FILES = [...PIPELINE_FILES, "manifest.json", "verification.json"] as const;

export type RenderState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
const STATES = new Set<RenderState>(["queued", "running", "succeeded", "failed", "cancelled"]);

export interface RenderRequest {
  version: typeof RENDER_REQUEST_VERSION;
  renderId: string;
  productionId: string;
  revision: number;
  profileId: ExportProfileId;
  requestedAt: string;
  /** The admitted document at `revision`, exactly as it was compiled when the render was requested. */
  production: Production;
}

export interface RenderJobFailure {
  failureClass: RenderFailureClass;
  code: string;
  message: string;
}

export type HistoryEvent = "queued" | "started" | "succeeded" | "failed" | "cancelled" | "interrupted" | "retried";

export interface RenderJob {
  version: typeof RENDER_JOB_VERSION;
  renderId: string;
  productionId: string;
  revision: number;
  profileId: ExportProfileId;
  state: RenderState;
  /** Attempts since the render was requested or last retried by a person. */
  attempts: number;
  requestedAt: string;
  updatedAt: string;
  owner?: ProcessOwner & { instance: string };
  /** The running attempt's progress, written at most about once a second; kept on failure to show where it stopped. */
  progress?: RenderProgress;
  failure?: RenderJobFailure;
  /** The verification outcome of the last finished attempt: whether it passed and the ids of failed checks. */
  verification?: { ok: boolean; failedChecks: string[] };
  /** Served files and their sizes, once succeeded. */
  outputs?: { name: RenderFileName; bytes: number }[];
  history: { at: string; event: HistoryEvent; attempt?: number; code?: string }[];
}

export interface RenderPipelineInput {
  request: RenderRequest;
  /** An empty folder the pipeline fills with `PIPELINE_FILES`; render jobs remove it. */
  workDir: string;
  signal: AbortSignal;
  onProgress: (progress: RenderProgress) => void;
}

export interface RenderPipelineResult {
  manifest: RenderManifest;
  verification: VerificationReport;
}

/** Turns a request snapshot into the render's files; injected so tests run without FFmpeg or Chromium. */
export interface RenderPipeline {
  run(input: RenderPipelineInput): Promise<RenderPipelineResult>;
}

export interface RenderJobsOptions {
  /** The renders folder, `data/video-renders` for the app. */
  root: string;
  pipeline: RenderPipeline;
  /** Milliseconds since the epoch. */
  clock?: () => number;
  /** Milliseconds to wait before attempt n (n >= 2). */
  backoff?: (attempt: number) => number;
  progressIntervalMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type CancelResult = { ok: true; job: RenderJob; pending: boolean } | { ok: false; code: "not_found" | "not_cancellable"; job?: RenderJob };
export type RetryResult = { ok: true; job: RenderJob } | { ok: false; code: "not_found" | "not_retryable"; job?: RenderJob };

/** Classifies an error from a render attempt. Messages come from typed failures, which never contain paths. */
export function classifyRenderError(error: unknown): RenderJobFailure {
  if (error instanceof RenderFailure) return { failureClass: error.failureClass, code: error.code, message: error.message };
  if (error instanceof ToolError) {
    if (error.reason === "missing") return { failureClass: "configuration", code: "tool_missing", message: error.message };
    if (error.reason === "timeout") return { failureClass: "transient", code: "timeout", message: error.message };
    if (error.reason === "aborted") return { failureClass: "transient", code: "interrupted", message: error.message };
    return { failureClass: "permanent", code: "tool_failed", message: "FFmpeg could not finish the render" };
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC" || code === "EIO" || code === "EMFILE" || code === "ENFILE" || code === "EBUSY") {
    return { failureClass: "transient", code: "io_error", message: `the disk could not be written (${code})` };
  }
  return { failureClass: "permanent", code: "internal_error", message: "the render could not be completed" };
}


export function validJob(job: RenderJob, productionId: string, renderId: string): boolean {
  return (
    job?.version === RENDER_JOB_VERSION &&
    job.productionId === productionId &&
    job.renderId === renderId &&
    STATES.has(job.state) &&
    Object.prototype.hasOwnProperty.call(EXPORT_PROFILES, job.profileId) &&
    Array.isArray(job.history)
  );
}

/** Whether a parsed request.json belongs to this render and carries its snapshot. */
export function validRequest(request: RenderRequest, productionId: string, renderId: string): boolean {
  return (
    request?.version === RENDER_REQUEST_VERSION &&
    request.productionId === productionId &&
    request.renderId === renderId &&
    Object.prototype.hasOwnProperty.call(EXPORT_PROFILES, request.profileId) &&
    request.production?.id === productionId &&
    request.production.revision === request.revision
  );
}
