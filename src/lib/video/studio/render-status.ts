/**
 * What the Export panel says about a render and what a person may do with it
 * (#150), from the render as the Render API answers it. Pure, so every state
 * and its actions are unit-tested.
 */
import type { CompileIssue } from "@/lib/video/render/plan";
import type { RenderView } from "./types";

export type RenderFileName = RenderView["files"][number];

/** The files a succeeded render offers, in the order the panel lists them. */
export const RENDER_DOWNLOADS: readonly { name: RenderFileName; label: string }[] = [
  { name: "video.mp4", label: "MP4" },
  { name: "captions.srt", label: "SRT" },
  { name: "captions.vtt", label: "WebVTT" },
  { name: "manifest.json", label: "Manifest" },
];

/** How often the panel reads the renders again while one is queued or running. */
export const RENDER_POLL_MS = 1_000;

/** Newest first: by request time, then by id (the server's ids are time-ordered). */
export function sortRenders(renders: readonly RenderView[]): RenderView[] {
  return [...renders].sort((a, b) => (a.requestedAt === b.requestedAt ? b.renderId.localeCompare(a.renderId) : a.requestedAt < b.requestedAt ? 1 : -1));
}

export function isActive(render: RenderView): boolean {
  return render.state === "queued" || render.state === "running";
}

/** The panel reads the renders again while any of them is still queued or running. */
export function shouldPoll(renders: readonly RenderView[]): boolean {
  return renders.some(isActive);
}

/** A render list with `render` in place of the one with the same id, or added, newest first. */
export function withRender(renders: readonly RenderView[], render: RenderView): RenderView[] {
  return sortRenders([render, ...renders.filter((r) => r.renderId !== render.renderId)]);
}

const STAGES: Record<NonNullable<RenderView["progress"]>["stage"], string> = {
  overlay: "Drawing captions and graphics",
  video: "Encoding video",
  audio: "Mixing sound",
  mux: "Packaging the MP4",
};

export type RenderTone = "neutral" | "progress" | "success" | "danger";

export interface RenderStatus {
  label: string;
  tone: RenderTone;
  /** The stage in words while running (or where a failed attempt stopped). */
  stage: string | null;
  progress: { done: number; total: number; percent: number } | null;
  canCancel: boolean;
  canRetry: boolean;
  /** Downloads and playback; only a succeeded render that passed verification has files. */
  files: RenderFileName[];
  /** The render is of a revision older than the one now shown. */
  olderRevision: boolean;
  failure: string | null;
  verification: { ok: boolean; text: string } | null;
}

export function renderStatus(render: RenderView, currentRevision: number): RenderStatus {
  const cancelling = render.cancelRequested === true && isActive(render);
  const progress = render.progress && render.progress.total > 0
    ? { done: render.progress.done, total: render.progress.total, percent: Math.max(0, Math.min(100, Math.floor((render.progress.done / render.progress.total) * 100))) }
    : null;
  const showProgress = render.state === "running" || render.state === "failed" || render.state === "cancelled";
  return {
    label: cancelling ? "Cancelling" : LABELS[render.state],
    tone: render.state === "succeeded" ? "success" : render.state === "failed" ? "danger" : isActive(render) ? "progress" : "neutral",
    stage: showProgress && render.progress ? STAGES[render.progress.stage] : render.state === "queued" ? "Waiting to start" : null,
    progress: showProgress ? progress : null,
    canCancel: isActive(render) && !cancelling,
    canRetry: render.state === "failed" || render.state === "cancelled",
    files: render.state === "succeeded" ? RENDER_DOWNLOADS.map((d) => d.name).filter((name) => render.files.includes(name)) : [],
    olderRevision: render.revision < currentRevision,
    failure: render.state === "failed" && render.failure ? sentence(render.failure.message) : null,
    verification: render.verification
      ? render.verification.ok
        ? { ok: true, text: "Passed the Instagram Reel checks" }
        : { ok: false, text: `Failed checks: ${render.verification.failedChecks.join(", ") || "unnamed"}` }
      : null,
  };
}

const LABELS: Record<RenderView["state"], string> = {
  queued: "Queued",
  running: "Rendering",
  succeeded: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A message from the server as a sentence: capitalised, with a full stop. */
export function sentence(message: string): string {
  const text = message.trim();
  if (!text) return "";
  const first = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/** A compiler issue in plain words, with the clip it names when there is one. */
export function describeCompileIssue(issue: CompileIssue): { text: string; clipId: string | null } {
  return { text: sentence(issue.message), clipId: issue.clipId ?? null };
}

/** The header button's short status while a render is unfinished, e.g. "Rendering 42%". */
export function activeSummary(renders: readonly RenderView[]): string | null {
  const active = renders.find((r) => r.state === "running") ?? renders.find(isActive);
  if (!active) return null;
  if (active.state === "queued") return "Queued";
  const p = active.progress;
  return p && p.total > 0 ? `Rendering ${Math.floor((p.done / p.total) * 100)}%` : "Rendering";
}
