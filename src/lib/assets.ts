import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Carousel, CarouselAsset } from "@/types/carousel";
import { appendCarouselAssets, carouselAssets, getCarousel, removeCarouselAssets } from "./carousels";
import {
  mutateCreativeRuns,
  readCreativeRuns,
  type AssetTask,
  type CreativeRunRecord,
  type CreativeStage,
  type RunOutcome,
} from "./generation-status";
import { IMAGE_DIMENSIONS, type GeneratedImage, type ImageAspectRatio } from "./image-service";

/**
 * Generated assets: private staging, crash-consistent attachment to a
 * carousel, recovery, orphan cleanup, retry integrity and expiry.
 *
 * An asset's life spans three places that cannot be written together: its
 * staged file under `data/asset-staging/<runId>/`, which the web server never
 * serves; its final file under `public/uploads/`; and two JSON files, the run
 * record (owned by `generation-status.ts`) and the carousel (owned by
 * `carousels.ts`). Every step is ordered so that a crash at any point leaves
 * a state recovery can finish or undo:
 *
 * - staging writes a temporary file, flushes it and renames it before the run
 *   record claims it, so no record claims a partial file;
 * - attaching records its intent, with pre-generated asset IDs, before any file
 *   moves; moves by hard link then unlink, so a file is always whole under at
 *   least one name; appends carousel records idempotently; then records the
 *   commit and removes the staging directory.
 *
 * Nothing here deletes a reference image, an upload it did not create, or
 * another run's asset. Uploads no carousel references are left alone, as
 * deleting a carousel leaves its uploads today.
 */

/** A blocked run's staged results and stored plan are kept this long for an explicit retry. */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Plan-local task keys: never a path, so safe as a file name. */
const TASK_KEY = /^a[0-9]{1,2}$/;
const TEMP_SUFFIX = ".tmp";

const stagingRoot = () => path.resolve(process.cwd(), "data", "asset-staging");
const uploadsDir = () => path.resolve(process.cwd(), "public", "uploads");
const runDir = (runId: string) => path.join(stagingRoot(), runId);
const stagedPath = (runId: string, key: string) => path.join(runDir(runId), `${key}.png`);
const uploadPath = (assetId: string) => path.join(uploadsDir(), `${assetId}.png`);

export type AssetErrorCode =
  | "storage_misconfigured"
  | "storage_failed"
  | "commit_failed"
  | "tasks_unfinished"
  | "run_not_found"
  | "retry_expired"
  | "retry_not_allowed"
  | "plan_invalid";

/** A typed failure of the asset lifecycle. The message is safe to show a user. */
export class AssetError extends Error {
  constructor(readonly code: AssetErrorCode, message: string) {
    super(message);
    this.name = "AssetError";
  }
}

// ---------------------------------------------------------------------------
// Test seam: fault injection after each protocol step.

/**
 * The steps after which a fault can be injected. A "fail" makes the next
 * operation fail, as a storage error would; a "crash" stops the process model
 * on the spot, skipping every in-request roll-back, as a kill would.
 */
export type AssetStep =
  | "stage:written"
  | "stage:renamed"
  | "stage:recorded"
  | "attach:intent"
  | "attach:linked"
  | "attach:unlinked"
  | "attach:records"
  | "attach:committed"
  | "attach:cleaned"
  | "rollback:records"
  | "rollback:file"
  | "recover:linked"
  | "recover:records"
  | "recover:committed";

type FaultHook = (step: AssetStep) => "fail" | "crash" | void;

/** Thrown by the seam to model a process that died mid-step. */
export class SimulatedCrash extends Error {
  constructor(readonly step: AssetStep) {
    super(`simulated crash after ${step}`);
  }
}

const PROCESS_KEY = Symbol.for("creatorbrio.assets.process");

interface ProcessState {
  /** Runs started in this process and not yet ended; never swept or recovered. */
  live: Set<string>;
  recovered: Promise<void> | null;
  sameFilesystem: Promise<void> | null;
  fault: FaultHook | null;
}

function processState(): ProcessState {
  const store = globalThis as typeof globalThis & { [PROCESS_KEY]?: ProcessState };
  store[PROCESS_KEY] ??= { live: new Set(), recovered: null, sameFilesystem: null, fault: null };
  return store[PROCESS_KEY];
}

function fault(step: AssetStep): void {
  const result = processState().fault?.(step);
  if (result === "crash") throw new SimulatedCrash(step);
  if (result === "fail") throw new Error(`injected failure after ${step}`);
}

/** Tests only: installs a fault hook, or removes it with null. */
export function setAssetFaultHookForTests(hook: FaultHook | null): void {
  processState().fault = hook;
}

/** Tests only: forgets everything held in memory, as a server restart does. */
export function simulateRestartForTests(): void {
  const state = processState();
  state.live.clear();
  state.recovered = null;
  state.sameFilesystem = null;
}

// ---------------------------------------------------------------------------
// Helpers.

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The file's SHA-256, or null when it does not exist. */
async function fileSha(file: string): Promise<string | null> {
  try {
    return sha256(await readFile(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function requireIds(runId: string, keys: string[]): void {
  if (!RUN_ID.test(runId)) throw new AssetError("run_not_found", "Invalid run.");
  for (const key of keys) {
    if (!TASK_KEY.test(key)) throw new AssetError("plan_invalid", "Invalid asset key.");
  }
}

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
  console[level](`[assets] ${event}`, fields);
}

/**
 * The image stage moves files with hard links, which are atomic only within
 * one filesystem. Checked once per process; a mismatch refuses the stage as a
 * configuration error rather than risking a partial move.
 */
export function ensureSameFilesystem(): Promise<void> {
  const state = processState();
  state.sameFilesystem ??= (async () => {
    await mkdir(stagingRoot(), { recursive: true });
    await mkdir(uploadsDir(), { recursive: true });
    const [staging, uploads] = await Promise.all([stat(stagingRoot()), stat(uploadsDir())]);
    if (staging.dev !== uploads.dev) {
      log("error", "staging and uploads are on different filesystems", {});
      throw new AssetError(
        "storage_misconfigured",
        "Generated images cannot be prepared because the data and uploads folders are on different disks."
      );
    }
  })();
  // A failed check is not cached, so fixing the configuration needs no restart.
  const check = state.sameFilesystem;
  check.catch(() => {
    if (processState().sameFilesystem === check) processState().sameFilesystem = null;
  });
  return check;
}

// ---------------------------------------------------------------------------
// Run records.

/** Whether a run is live in this process. */
export function isCreativeRunLive(runId: string): boolean {
  return processState().live.has(runId);
}

/**
 * Records a new creative run for a carousel, replacing its previous record,
 * whose staging the next sweep removes. The caller holds the carousel's
 * single active-run slot (`beginGeneration`).
 */
export async function beginCreativeRun(
  carouselId: string,
  runId: string,
  tasks: { key: string; required: boolean; aspectRatio: ImageAspectRatio }[] = []
): Promise<void> {
  requireIds(runId, tasks.map((t) => t.key));
  processState().live.add(runId);
  await mutateCreativeRuns((records) => {
    records[carouselId] = {
      runId,
      stage: "planning",
      startedAt: new Date().toISOString(),
      ended: null,
      tasks: tasks.map((t) => ({ ...t, state: "pending" })),
      attach: null,
      retry: null,
    };
  });
}

/** Changes this run's record, or does nothing when the carousel's record belongs to another run. */
async function updateRun(
  carouselId: string,
  runId: string,
  change: (record: CreativeRunRecord) => void
): Promise<boolean> {
  return mutateCreativeRuns((records) => {
    const record = records[carouselId];
    if (record?.runId !== runId) return false;
    change(record);
    return true;
  });
}

function taskOf(record: CreativeRunRecord, key: string): AssetTask {
  const task = record.tasks.find((t) => t.key === key);
  if (!task) throw new AssetError("plan_invalid", "Unknown asset task.");
  return task;
}

/**
 * Sets the run's tasks, for a run whose plan is known only after it began.
 * With `retry`, the validated plan and the user's message are kept from now
 * on, so a run cut off by a restart before design can still be retried.
 */
export async function setCreativeTasks(
  carouselId: string,
  runId: string,
  tasks: { key: string; required: boolean; aspectRatio: ImageAspectRatio }[],
  retry?: { plan: unknown; message: string }
): Promise<void> {
  requireIds(runId, tasks.map((t) => t.key));
  await updateRun(carouselId, runId, (record) => {
    record.tasks = tasks.map((t) => ({ ...t, state: "pending" }));
    if (retry) record.retry = retry;
  });
}

export async function setCreativeStage(carouselId: string, runId: string, stage: CreativeStage): Promise<void> {
  await updateRun(carouselId, runId, (record) => {
    record.stage = stage;
  });
}

export async function setTaskState(
  carouselId: string,
  runId: string,
  key: string,
  state: "pending" | "running" | "failed" | "abandoned"
): Promise<void> {
  await updateRun(carouselId, runId, (record) => {
    const task = taskOf(record, key);
    task.state = state;
    if (state !== "pending") return;
    delete task.sha256;
    delete task.width;
    delete task.height;
  });
}

/**
 * Ends a run. A blocked run keeps its plan and the user's message for an
 * explicit retry; every other outcome keeps neither, and its staging is
 * removed (the sweep removes it later if this cannot).
 */
export async function endCreativeRun(
  carouselId: string,
  runId: string,
  outcome: RunOutcome,
  /** `retry`: the data a blocked run keeps; omitted keeps what was stored, null keeps nothing. */
  options: { reason?: string; retry?: { plan: unknown; message: string } | null; deviations?: string[] } = {}
): Promise<void> {
  await updateRun(carouselId, runId, (record) => {
    record.ended = { outcome, at: new Date().toISOString(), ...(options.reason ? { reason: options.reason } : {}) };
    if (options.deviations && options.deviations.length > 0) record.deviations = options.deviations;
    record.retry = outcome === "blocked" ? (options.retry === undefined ? record.retry : options.retry) : null;
    for (const task of record.tasks) if (task.state === "running") task.state = "abandoned";
  });
  processState().live.delete(runId);
  if (outcome !== "blocked") await rm(runDir(runId), { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Staging.

/**
 * Writes a validated image to the run's private staging directory and records
 * the task as staged with its SHA-256. The file is complete under its final
 * staging name before the record claims it.
 */
export async function stageImage(
  carouselId: string,
  runId: string,
  key: string,
  image: GeneratedImage
): Promise<{ sha256: string }> {
  requireIds(runId, [key]);
  await ensureSameFilesystem();
  const dir = runDir(runId);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${key}.${randomUUID()}${TEMP_SUFFIX}`);
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(image.png);
    await handle.sync();
  } finally {
    await handle.close();
  }
  fault("stage:written");
  await rename(temp, stagedPath(runId, key));
  fault("stage:renamed");
  const digest = sha256(image.png);
  const recorded = await updateRun(carouselId, runId, (record) => {
    const task = taskOf(record, key);
    task.state = "staged";
    task.sha256 = digest;
    task.width = image.width;
    task.height = image.height;
  });
  if (!recorded) throw new AssetError("run_not_found", "This run is no longer current.");
  fault("stage:recorded");
  return { sha256: digest };
}

// ---------------------------------------------------------------------------
// Attach.

type AttachItem = { taskKey: string; assetId: string; sha256: string };

/** Moves one staged file to its uploads name, by link then unlink. */
async function moveIntoUploads(runId: string, item: AttachItem): Promise<void> {
  const staged = stagedPath(runId, item.taskKey);
  const final = uploadPath(item.assetId);
  try {
    await link(staged, final);
  } catch (err) {
    // Already linked by an earlier attempt: fine only if it is the same content.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST" || (await fileSha(final)) !== item.sha256) throw err;
  }
  fault("attach:linked");
  await unlink(staged).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
  fault("attach:unlinked");
}

function assetRecord(runId: string, task: AssetTask, item: AttachItem, createdAt: string): CarouselAsset {
  return {
    id: item.assetId,
    url: `/uploads/${item.assetId}.png`,
    origin: "generated",
    sourceIds: [],
    width: task.width ?? 0,
    height: task.height ?? 0,
    sha256: item.sha256,
    runId,
    createdAt,
  };
}

/**
 * Attaches every staged result of the run to its carousel, all or nothing.
 * Refuses, moving nothing, while any required task has not succeeded.
 * Returns the asset records it added; results committed by an earlier
 * attempt of the same run stay as they are.
 *
 * If a move or the carousel write fails, every file already moved returns to
 * staging and every appended record is removed; if that roll-back fails too,
 * the recorded intent lets recovery finish the job.
 */
export async function attachAssets(carouselId: string, runId: string): Promise<CarouselAsset[]> {
  requireIds(runId, []);
  await ensureSameFilesystem();

  // 1. Intent: asset IDs are chosen and saved before any file moves.
  const intent = await mutateCreativeRuns((records) => {
    const record = records[carouselId];
    if (record?.runId !== runId) throw new AssetError("run_not_found", "This run is no longer current.");
    if (record.tasks.some((t) => t.required && t.state !== "staged" && t.state !== "committed")) {
      throw new AssetError("tasks_unfinished", "Not every required image is ready.");
    }
    const items = record.tasks
      .filter((t) => t.state === "staged")
      .map((t) => ({ taskKey: t.key, assetId: randomUUID(), sha256: t.sha256 ?? "" }));
    record.attach = { state: "intent", items };
    return { items, tasks: record.tasks.map((t) => ({ ...t })) };
  });
  fault("attach:intent");

  const createdAt = new Date().toISOString();
  const records = intent.items.map((item) =>
    assetRecord(runId, intent.tasks.find((t) => t.key === item.taskKey)!, item, createdAt)
  );

  // 2 and 3. Move, then append the records.
  try {
    for (const item of intent.items) await moveIntoUploads(runId, item);
    if (!(await appendCarouselAssets(carouselId, records))) {
      throw new AssetError("run_not_found", "The carousel no longer exists.");
    }
    fault("attach:records");
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err;
    log("error", "attach failed; rolling back", { carouselId, runId, step: "move-or-records" });
    try {
      await rollBack(carouselId, runId, intent.items);
    } catch (rollbackErr) {
      if (rollbackErr instanceof SimulatedCrash) throw rollbackErr;
      log("error", "attach roll-back failed; recovery will finish it", { carouselId, runId });
    }
    throw new AssetError("storage_failed", "Generated images could not be saved. Nothing was added to the carousel.");
  }

  // 4. Commit.
  try {
    await commit(carouselId, runId, intent.items);
    fault("attach:committed");
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err;
    log("error", "attach commit could not be recorded; recovery will finish it", { carouselId, runId });
    throw new AssetError("commit_failed", "Generated images were saved, but the run could not record it.");
  }

  // 5. Clean. Harmless if it fails: the sweep removes the directory.
  try {
    await rm(runDir(runId), { recursive: true, force: true });
    fault("attach:cleaned");
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err;
  }
  log("info", "assets attached", { carouselId, runId, count: records.length });
  return records;
}

async function commit(carouselId: string, runId: string, items: AttachItem[]): Promise<void> {
  await updateRun(carouselId, runId, (record) => {
    for (const item of items) {
      const task = record.tasks.find((t) => t.key === item.taskKey);
      if (task) {
        task.state = "committed";
        task.assetId = item.assetId;
      }
    }
    record.attach = { state: "committed", items };
  });
}

/**
 * Undoes an uncommitted attach: removes its records from every carousel, and
 * returns each of its files to staging, touching an uploads file only when its
 * name is one of this attach's asset IDs and its content matches.
 */
async function rollBack(carouselId: string, runId: string, items: AttachItem[]): Promise<void> {
  // Files first: if the carousel file cannot be written, the files are still
  // back in staging, and recovery removes any record left behind.
  await mkdir(runDir(runId), { recursive: true });
  for (const item of items) {
    const final = uploadPath(item.assetId);
    if ((await fileSha(final)) !== item.sha256) continue;
    const staged = stagedPath(runId, item.taskKey);
    if ((await fileSha(staged)) !== item.sha256) {
      await unlink(staged).catch(() => {});
      await link(final, staged);
    }
    await unlink(final);
    fault("rollback:file");
  }
  await removeCarouselAssets(items.map((i) => i.assetId));
  fault("rollback:records");
  await updateRun(carouselId, runId, (record) => {
    record.attach = null;
  });
}

// ---------------------------------------------------------------------------
// Recovery and sweep.

/**
 * Finishes or undoes whatever a run that is no longer live left behind. Safe
 * to repeat: every step checks what is already done.
 */
async function recoverRecord(carouselId: string): Promise<void> {
  const record = (await readCreativeRuns())[carouselId];
  if (!record || isCreativeRunLive(record.runId)) return;
  const { runId } = record;

  if (record.attach?.state === "intent") {
    const items = record.attach.items;
    const states = await Promise.all(
      items.map(async (item) => {
        const atUpload = await fileSha(uploadPath(item.assetId));
        return {
          item,
          uploaded: atUpload === item.sha256,
          // Another file under this asset's name is never replaced.
          blocked: atUpload !== null && atUpload !== item.sha256,
          staged: (await fileSha(stagedPath(runId, item.taskKey))) === item.sha256,
        };
      })
    );
    if (states.every((s) => s.uploaded || (s.staged && !s.blocked))) {
      // Every file is whole somewhere: roll forward.
      for (const s of states) {
        if (!s.uploaded) await link(stagedPath(runId, s.item.taskKey), uploadPath(s.item.assetId));
        fault("recover:linked");
        await unlink(stagedPath(runId, s.item.taskKey)).catch(() => {});
      }
      const createdAt = new Date().toISOString();
      await appendCarouselAssets(
        carouselId,
        items.map((item) => assetRecord(runId, taskOf(record, item.taskKey), item, createdAt))
      );
      fault("recover:records");
      await commit(carouselId, runId, items);
      fault("recover:committed");
      await rm(runDir(runId), { recursive: true, force: true }).catch(() => {});
      log("warn", "recovered an interrupted attach by completing it", { carouselId, runId, count: items.length });
    } else {
      await rollBack(carouselId, runId, items);
      const lost = new Set(states.filter((s) => !s.uploaded && (!s.staged || s.blocked)).map((s) => s.item.taskKey));
      await updateRun(carouselId, runId, (r) => {
        for (const task of r.tasks) if (lost.has(task.key)) task.state = "failed";
      });
      log("error", "rolled back an interrupted attach with missing files", { carouselId, runId, lost: lost.size });
    }
  }

  await updateRun(carouselId, runId, (r) => {
    for (const task of r.tasks) if (task.state === "running") task.state = "abandoned";
    if (r.ended) return;
    // A run cut off in its design stage is settled by the slide fingerprint
    // (generation-status); before design it never touched slides.
    r.ended =
      r.stage === "designing"
        ? { outcome: "server-stopped", at: new Date().toISOString() }
        : { outcome: "blocked", at: new Date().toISOString(), reason: "restart-before-design" };
    // Only a blocked run can be retried; nothing else keeps the user's message.
    if (r.stage === "designing") r.retry = null;
  });
}

/**
 * Recovers every run left behind by an earlier process, then sweeps. Runs once
 * per process, before the first creative run starts or the first retry is
 * validated; concurrent callers share the same work.
 */
export function ensureAssetsRecovered(): Promise<void> {
  const state = processState();
  state.recovered ??= (async () => {
    for (const carouselId of Object.keys(await readCreativeRuns())) await recoverRecord(carouselId);
    await sweepStaging();
  })();
  // A recovery that did not finish is attempted again by the next caller.
  const recovery = state.recovered;
  recovery.catch((err) => {
    if (processState().recovered === recovery) processState().recovered = null;
    if (!(err instanceof SimulatedCrash)) log("error", "asset recovery failed", { message: (err as Error)?.message });
  });
  return recovery;
}

/**
 * Prepares a carousel for a new run or a retry: recovers its last run if an
 * earlier attempt in this process left it unfinished, then sweeps.
 */
export async function prepareCarouselRun(carouselId: string): Promise<void> {
  await ensureAssetsRecovered();
  await recoverRecord(carouselId);
  await sweepStaging();
}

function expired(record: CreativeRunRecord, now: number): boolean {
  return record.ended?.outcome === "blocked" && now - Date.parse(record.ended.at) > RETRY_WINDOW_MS;
}

/**
 * Removes staging nothing can use: temporary files, directories of runs that
 * have no record or ended other than blocked, expired runs, and staged files
 * whose task no longer claims them with a matching hash. Purges an expired
 * run's plan and message. Skips live runs; never touches `public/uploads/`.
 */
export async function sweepStaging(now = Date.now()): Promise<void> {
  const records = await readCreativeRuns();
  const byRun = new Map(Object.entries(records).map(([carouselId, r]) => [r.runId, { carouselId, record: r }]));

  // Purge an expired run's stored plan and message, even if it has no files.
  for (const [carouselId, record] of Object.entries(records)) {
    if (!expired(record, now) || !record.retry || isCreativeRunLive(record.runId)) continue;
    await updateRun(carouselId, record.runId, (r) => {
      r.retry = null;
      r.purgedAt = new Date(now).toISOString();
    });
    log("info", "expired a blocked run's retry data", { carouselId, runId: record.runId });
  }

  let entries: string[];
  try {
    entries = await readdir(stagingRoot());
  } catch {
    return;
  }
  for (const name of entries) {
    const owner = byRun.get(name);
    // Live runs are never touched; an unsettled one is left to recovery.
    if (owner && (isCreativeRunLive(name) || !owner.record.ended)) continue;
    const keep =
      owner && RUN_ID.test(name) && owner.record.ended?.outcome === "blocked" && !expired(owner.record, now);
    const dir = path.join(stagingRoot(), name);
    if (!keep) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    const claimed = new Map(
      owner.record.tasks.filter((t) => t.state === "staged").map((t) => [`${t.key}.png`, t.sha256])
    );
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      const expected = claimed.get(file);
      if (expected && (await fileSha(path.join(dir, file))) === expected) continue;
      await rm(path.join(dir, file), { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Retry.

export interface PreparedRetry {
  plan: unknown;
  message: string;
  /** Task keys whose results are reused. */
  reused: string[];
  /** Task keys that run again. */
  pending: string[];
}

async function decodesAs(file: string, aspectRatio: string): Promise<boolean> {
  const expected = IMAGE_DIMENSIONS[aspectRatio as ImageAspectRatio];
  if (!expected) return false;
  try {
    const meta = await sharp(file).metadata();
    return meta.format === "png" && meta.width === expected.width && meta.height === expected.height;
  } catch {
    return false;
  }
}

/**
 * Validates an explicit retry of a carousel's most recent run and reopens it.
 * The run must have ended blocked within the retry window, and its stored plan
 * must still validate against the carousel (`revalidate`). A task's result is
 * reused only when its file is intact; every other task runs again, and a
 * mismatched staged file is deleted first. The caller holds the carousel's
 * active-run slot, so two retries cannot run at once.
 */
export async function prepareRetry(
  carouselId: string,
  runId: string,
  revalidate: (plan: unknown, message: string) => boolean,
  now = Date.now()
): Promise<PreparedRetry> {
  requireIds(runId, []);
  await prepareCarouselRun(carouselId);
  const record = (await readCreativeRuns())[carouselId];
  if (!record || record.runId !== runId || record.ended?.outcome !== "blocked") {
    throw new AssetError("retry_not_allowed", "Only the most recent blocked attempt can be retried.");
  }
  if (expired(record, now) || !record.retry) {
    throw new AssetError("retry_expired", "This attempt has expired; send the request again.");
  }
  if (!revalidate(record.retry.plan, record.retry.message)) {
    throw new AssetError("plan_invalid", "The carousel changed since this attempt; send the request again.");
  }

  const carousel = await getCarousel(carouselId);
  const committed = new Map(carousel ? carouselAssets(carousel).map((a) => [a.id, a]) : []);
  const reused: string[] = [];
  const pending: string[] = [];
  for (const task of record.tasks) {
    let ok = false;
    if (task.state === "staged") {
      const file = stagedPath(runId, task.key);
      ok = (await fileSha(file)) === task.sha256 && (await decodesAs(file, task.aspectRatio));
      if (!ok) await rm(file, { force: true });
    } else if (task.state === "committed" && task.assetId) {
      const asset = committed.get(task.assetId);
      ok = !!asset && (await fileSha(uploadPath(asset.id))) === asset.sha256;
    }
    (ok ? reused : pending).push(task.key);
  }

  processState().live.add(runId);
  await updateRun(carouselId, runId, (r) => {
    for (const task of r.tasks) {
      if (!pending.includes(task.key)) continue;
      task.state = "pending";
      delete task.sha256;
      delete task.assetId;
    }
    // Tasks that run again are attached by a new attach.
    if (pending.length > 0) r.attach = null;
    r.ended = null;
  });
  return { plan: record.retry.plan, message: record.retry.message, reused, pending };
}

/** Where a run's staging lives; exported for tests that must prove it is not served. */
export function stagingDirectoryFor(runId: string): string {
  requireIds(runId, []);
  return runDir(runId);
}

// ---------------------------------------------------------------------------
// Integrity of committed assets.

/**
 * Each committed asset of a carousel with whether its file still matches its
 * recorded hash. Only intact assets may be offered for reuse or placed.
 */
export async function carouselAssetIntegrity(
  carousel: Pick<Carousel, "assets">
): Promise<{ asset: CarouselAsset; intact: boolean }[]> {
  const result: { asset: CarouselAsset; intact: boolean }[] = [];
  for (const asset of carouselAssets(carousel)) {
    const intact = RUN_ID.test(asset.id) && (await fileSha(uploadPath(asset.id))) === asset.sha256;
    result.push({ asset, intact });
  }
  return result;
}

/** The asset ID each committed task of a run produced, by task key. */
export async function committedTaskAssets(carouselId: string, runId: string): Promise<Map<string, string>> {
  const record = (await readCreativeRuns())[carouselId];
  if (record?.runId !== runId) return new Map();
  return new Map(record.tasks.filter((t) => t.state === "committed" && t.assetId).map((t) => [t.key, t.assetId!]));
}

/** The absolute path of a committed asset's file, derived from its ID. */
export function assetFilePath(assetId: string): string {
  if (!RUN_ID.test(assetId)) throw new AssetError("plan_invalid", "Not an asset ID.");
  return uploadPath(assetId);
}
