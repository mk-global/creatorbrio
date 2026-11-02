import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AspectRatio, Carousel, CarouselAsset } from "@/types/carousel";

/**
 * Per-image evidence for the acceptance harness: the run's task states, each
 * attached file's hash, where each generated image landed, what the preview
 * serves, what the export wrote, and whether a retry reused staged images.
 * Everything here reads; nothing writes to the app's data. `root` is the
 * checkout the server runs from.
 */

export interface Verdict {
  pass: boolean;
  evidence: string;
}

/** Exported slide sizes, by the carousel's aspect ratio (Instagram sizes, not the image service's). */
export const EXPORT_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
};

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fileSha(file: string): Promise<string | null> {
  try {
    return sha256(await readFile(file));
  } catch {
    return null;
  }
}

async function inode(file: string): Promise<string | null> {
  try {
    return String((await stat(file, { bigint: true })).ino);
  } catch {
    return null;
  }
}

export const uploadFile = (root: string, assetId: string) => path.join(root, "public", "uploads", `${assetId}.png`);
export const stagingDir = (root: string, runId: string) => path.join(root, "data", "asset-staging", runId);
const short = (hash: string | null | undefined) => (hash ? hash.slice(0, 12) : "-");

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// ---------------------------------------------------------------------------
// Reading the run record (typed loosely by the harness, so narrowed here).

export interface RunTask {
  key: string;
  required: boolean;
  state: string;
  sha256?: string;
  assetId?: string;
}

export function runTasks(runRecord: Record<string, unknown> | null): RunTask[] {
  const tasks = Array.isArray(runRecord?.tasks) ? runRecord.tasks : [];
  return tasks.filter(isRecord).map((t) => ({
    key: str(t.key) ?? "?",
    required: t.required === true,
    state: str(t.state) ?? "?",
    ...(str(t.sha256) ? { sha256: str(t.sha256) } : {}),
    ...(str(t.assetId) ? { assetId: str(t.assetId) } : {}),
  }));
}

export interface PlannedAsset {
  key: string;
  operation: string;
  targetSlides: number[];
}

function storedPlan(runRecord: Record<string, unknown> | null): Record<string, unknown> | null {
  const retry = runRecord?.retry;
  return isRecord(retry) && isRecord(retry.plan) ? retry.plan : null;
}

/**
 * The image assignments of the run's stored plan. The plan is stored only
 * for plans with generated images, and only until the run ends, so this is
 * read while the run is designing; null when there is none.
 */
export function plannedAssets(runRecord: Record<string, unknown> | null): PlannedAsset[] | null {
  const execution = storedPlan(runRecord)?.execution;
  if (!isRecord(execution) || !Array.isArray(execution.assets)) return null;
  return execution.assets.filter(isRecord).map((a) => ({
    key: str(a.key) ?? "?",
    operation: str(a.operation) ?? "?",
    targetSlides: Array.isArray(a.targetSlides) ? a.targetSlides.filter((n): n is number => typeof n === "number") : [],
  }));
}

export interface PlanSummary {
  objective: string | null;
  audience: string | null;
  centralMessage: string | null;
  creativeDirection: string | null;
  requestType: string | null;
  slideCount: number | null;
  /** The visual decisions the plan adds to the Creative Brief. */
  visualDecisions: string[];
}

/** What the Director planned, for the founder's review; null when no plan was stored. */
export function planSummary(runRecord: Record<string, unknown> | null): PlanSummary | null {
  const plan = storedPlan(runRecord);
  if (!plan) return null;
  const strategy = isRecord(plan.strategy) ? plan.strategy : {};
  const execution = isRecord(plan.execution) ? plan.execution : {};
  const update = isRecord(plan.briefUpdate) ? plan.briefUpdate : {};
  const decisions = Array.isArray(update.addVisualDecisions) ? update.addVisualDecisions : [];
  return {
    objective: str(strategy.objective) ?? null,
    audience: str(strategy.audience) ?? null,
    centralMessage: str(strategy.centralMessage) ?? null,
    creativeDirection: str(strategy.creativeDirection) ?? null,
    requestType: str(execution.requestType) ?? null,
    slideCount: typeof execution.slideCount === "number" ? execution.slideCount : null,
    visualDecisions: decisions.filter(isRecord).map((d) => str(d.text)).filter((t): t is string => !!t),
  };
}

// ---------------------------------------------------------------------------
// One completed run's images.

/**
 * Every task is committed with a hash and an asset ID. An optional task that
 * failed is accepted, since the plan's alternative replaces it and the user is
 * told; a required one never is.
 */
export function checkTasks(tasks: RunTask[]): Verdict {
  const bad = tasks.filter((t) => !(t.state === "committed" && t.sha256 && t.assetId) && !(t.state === "failed" && !t.required));
  const states = tasks.map((t) => `${t.key}=${t.state}${t.required ? "" : " (optional)"}`).join(", ") || "no tasks";
  return { pass: tasks.length > 0 && bad.length === 0, evidence: states };
}

/** Each committed task's file in public/uploads hashes to the task's hash and to its asset record's. */
export async function checkFileHashes(root: string, tasks: RunTask[], assets: CarouselAsset[]): Promise<Verdict> {
  const committed = tasks.filter((t) => t.state === "committed" && t.assetId);
  const lines: string[] = [];
  let pass = committed.length > 0;
  for (const task of committed) {
    const onDisk = await fileSha(uploadFile(root, task.assetId!));
    const asset = assets.find((a) => a.id === task.assetId);
    const ok = !!onDisk && onDisk === task.sha256 && asset?.sha256 === task.sha256;
    if (!ok) pass = false;
    lines.push(`${task.key} ${ok ? "matches" : "MISMATCH"} (task ${short(task.sha256)}, file ${short(onDisk)}, record ${short(asset?.sha256)})`);
  }
  return { pass, evidence: lines.join("; ") || "no committed task" };
}

/** Each generated image appears on every slide its plan assigned it to (slides in their stored order). */
export function checkPlacement(planned: PlannedAsset[], tasks: RunTask[], slides: Carousel["slides"]): Verdict {
  const ordered = [...slides].sort((a, b) => a.order - b.order);
  const lines: string[] = [];
  let pass = true;
  for (const asset of planned.filter((a) => a.operation === "generate")) {
    const task = tasks.find((t) => t.key === asset.key);
    if (!task?.assetId) {
      lines.push(`${asset.key}: not committed`);
      if (task?.required !== false) pass = false;
      continue;
    }
    const url = `/uploads/${task.assetId}.png`;
    const missing = asset.targetSlides.filter((n) => !ordered[n - 1]?.html.includes(url));
    if (missing.length || asset.targetSlides.length === 0) pass = false;
    lines.push(`${asset.key} on slide ${asset.targetSlides.join(", ") || "none"}: ${missing.length ? `missing from slide ${missing.join(", ")}` : "placed"}`);
  }
  return { pass: pass && lines.length > 0, evidence: lines.join("; ") || "no generated image in the plan" };
}

/** The running server serves each asset URL as the same PNG bytes. */
export async function checkPreview(origin: string, assets: CarouselAsset[]): Promise<Verdict> {
  const lines: string[] = [];
  let pass = assets.length > 0;
  for (const asset of assets) {
    try {
      const res = await fetch(new URL(asset.url, origin), { signal: AbortSignal.timeout(30_000) });
      const body = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get("content-type") ?? "";
      const ok = res.status === 200 && type.startsWith("image/png") && sha256(body) === asset.sha256;
      if (!ok) pass = false;
      lines.push(`${asset.url}: ${res.status} ${type || "no type"}, ${sha256(body) === asset.sha256 ? "same bytes" : "DIFFERENT bytes"}`);
    } catch (err) {
      pass = false;
      lines.push(`${asset.url}: ${(err as Error).message}`);
    }
  }
  return { pass, evidence: lines.join("; ") || "no asset" };
}

/** Every exported file decodes as a PNG at the carousel's exact size. */
export async function checkExportFiles(files: string[], aspectRatio: AspectRatio): Promise<Verdict> {
  const want = EXPORT_SIZES[aspectRatio];
  const wrong: string[] = [];
  for (const file of files) {
    try {
      const meta = await sharp(file).metadata();
      if (meta.format !== "png" || meta.width !== want.width || meta.height !== want.height) {
        wrong.push(`${path.basename(file)} is ${meta.format} ${meta.width}x${meta.height}`);
      }
    } catch (err) {
      wrong.push(`${path.basename(file)} does not decode: ${(err as Error).message}`);
    }
  }
  return {
    pass: files.length > 0 && wrong.length === 0,
    evidence: wrong.length ? wrong.join("; ") : `${files.length} PNG(s) at ${want.width}x${want.height}`,
  };
}

// ---------------------------------------------------------------------------
// Reuse of staged images by a retry.

export interface StagedItem {
  key: string;
  /** The hash the run record holds for the task. */
  sha256: string | null;
  /** The staged file's own hash and inode, or null when it is missing. */
  fileSha256: string | null;
  inode: string | null;
}

export interface StagedSnapshot {
  runId: string;
  stagingDirExists: boolean;
  items: StagedItem[];
}

/** Records each staged task's hash, and its staged file's hash and inode, without changing anything. */
export async function snapshotStaged(root: string, runRecord: Record<string, unknown> | null): Promise<StagedSnapshot> {
  const runId = str(runRecord?.runId) ?? "";
  const dir = runId ? stagingDir(root, runId) : "";
  const items: StagedItem[] = [];
  for (const task of runTasks(runRecord).filter((t) => t.state === "staged")) {
    const file = path.join(dir, `${task.key}.png`);
    items.push({ key: task.key, sha256: task.sha256 ?? null, fileSha256: await fileSha(file), inode: await inode(file) });
  }
  let stagingDirExists = false;
  if (dir) stagingDirExists = await stat(dir).then((s) => s.isDirectory(), () => false);
  return { runId, stagingDirExists, items };
}

export interface ReuseEvidence {
  /** The run record after the retry. */
  runRecord: Record<string, unknown> | null;
  /** The carousel's assets after the retry. */
  assets: CarouselAsset[];
  /** The keys of every "image staged" log entry written after the retry was sent. */
  stagedAfterRetry: string[];
  /** The retry log line's counts. */
  retryLine: { reused: number | null; pending: number | null } | null;
}

/**
 * Proves a retry reused each staged image rather than making it again: no
 * new image for its key, committed with the snapshot's hash, and attached as
 * the same file. The app attaches a staged image by hard link, so the same
 * bytes under another inode mean it was copied or made again, and fail.
 */
export async function verifyReuse(root: string, snapshot: StagedSnapshot, after: ReuseEvidence): Promise<{ name: string; verdict: Verdict }[]> {
  const stagedKeys = snapshot.items.map((i) => i.key);
  const tasks = runTasks(after.runRecord);
  const checks: { name: string; verdict: Verdict }[] = [];

  const reused = after.retryLine?.reused ?? null;
  const pending = after.retryLine?.pending ?? null;
  checks.push({
    name: "retry reused every staged image",
    verdict: {
      pass: reused === stagedKeys.length && pending !== null && reused + pending === tasks.length,
      evidence: `staged before retry ${stagedKeys.length} of ${tasks.length}; retry log reused ${reused ?? "?"}, pending ${pending ?? "?"}`,
    },
  });

  const remade = after.stagedAfterRetry.filter((k) => stagedKeys.includes(k));
  checks.push({
    name: "no staged image made again",
    verdict: {
      pass: remade.length === 0,
      evidence: remade.length ? `made again: ${remade.join(", ")}` : `images made on retry: ${after.stagedAfterRetry.join(", ") || "none"}`,
    },
  });

  const lines: string[] = [];
  let pass = snapshot.items.length > 0;
  for (const item of snapshot.items) {
    const task = tasks.find((t) => t.key === item.key);
    const asset = after.assets.find((a) => a.id === task?.assetId);
    const file = task?.assetId ? uploadFile(root, task.assetId) : null;
    const [fileSha256, fileInode] = file ? [await fileSha(file), await inode(file)] : [null, null];
    const committed = task?.state === "committed" && !!task.assetId;
    const sameHash = !!item.sha256 && asset?.sha256 === item.sha256 && fileSha256 === item.sha256;
    const sameFile = !!item.inode && fileInode === item.inode;
    if (!committed || !sameHash || !sameFile) pass = false;
    lines.push(
      `${item.key}: ${committed ? "committed" : `state ${task?.state ?? "missing"}`}, hash ${sameHash ? "same" : `DIFFERENT (${short(item.sha256)} vs ${short(asset?.sha256)})`}, ${sameFile ? "same file" : "not the same file"}`
    );
  }
  checks.push({
    name: "staged images attached unchanged",
    verdict: { pass, evidence: lines.join("; ") || "nothing was staged" },
  });
  return checks;
}
