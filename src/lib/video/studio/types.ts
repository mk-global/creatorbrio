/**
 * What the Studio page reads from the Video Studio API (#150), as the routes
 * answer it. Server types are imported for their shape only, so the browser
 * bundle stays free of server code and a change on the server side breaks
 * the page at typecheck rather than at run time.
 */
import type { ChangeIssue, ProductionOp } from "@/lib/video/production/changes/types";
import type { AdmissionIssue } from "@/lib/video/production/primitives";
import type { ProductionSummary } from "@/lib/video/production/store/store";
import type { MediaFacts } from "@/lib/video/media/facts";
import type { CompileIssue, RenderPlan } from "@/lib/video/render/plan";
import type { RenderProgress } from "@/lib/video/render/execute-types";
import type { RenderState } from "@/lib/video/render/render-record";
import type { MediaKind, Production } from "@/types/production";

export type { ProductionOp, ProductionSummary };

export interface SessionView {
  authenticated: boolean;
  expiresAt: string;
}

export interface HistoryStepView {
  label: string;
  changeSetIds: string[];
  runId: string | null;
  fromRevision: number;
  toRevision: number;
}

export interface ProductionView {
  productionId: string;
  generation: number;
  revision: number;
  production: Production;
  history: { undo: HistoryStepView[]; redo: HistoryStepView[]; labels: { name: string; revision: number }[] };
  run: { runId: string; interrupted: boolean } | null;
  recoveryRequired: boolean;
}

/** The answer to a change set, undo or redo that was applied. */
export interface AppliedView {
  status: "applied";
  changeSetId: string;
  fromRevision: number;
  revision: number;
  generation: number;
}

export type DerivedFileName = "proxy.mp4" | "proxy.m4a" | "proxy.png" | "poster.jpg" | "peaks.json";

export interface MediaView {
  mediaId: string;
  kind: MediaKind;
  originalName: string;
  sizeBytes: number;
  importedAt: string;
  facts: MediaFacts;
  provenance: { source: "local-file"; rights: "user-supplied" };
  derived: {
    state: "queued" | "running" | "succeeded" | "failed";
    attempts: number;
    updatedAt?: string;
    files: DerivedFileName[];
    failure?: { failureClass: string; code: string; message: string };
  };
}

export interface RenderView {
  renderId: string;
  productionId: string;
  revision: number;
  profile: string;
  state: RenderState;
  attempts: number;
  requestedAt: string;
  updatedAt: string;
  files: ("video.mp4" | "captions.srt" | "captions.vtt" | "manifest.json")[];
  progress?: RenderProgress & { at?: string };
  failure?: { failureClass: "transient" | "permanent" | "configuration"; code: string; message: string };
  verification?: { ok: boolean; failedChecks: string[] };
  cancelRequested?: true;
}

/** The preview of the current revision: the plan and its preview overlay, or why it cannot be exported. */
export interface PreviewView {
  productionId: string;
  revision: number;
  generation: number;
  preview: { ok: true; plan: RenderPlan; overlay: { html: string; activeRanges: { startFrame: number; endFrame: number }[] } } | { ok: false; issues: CompileIssue[] };
}

/** Why the engine or admission refused a change; `path` points into the production. */
export type RefusalIssue = ChangeIssue | AdmissionIssue;
