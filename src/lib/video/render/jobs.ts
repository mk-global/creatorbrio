/**
 * Render jobs (#144): one durable record per requested export, kept under
 * `data/video-renders/<productionId>/<renderId>/`:
 *
 *   request.json      the snapshot taken when the render was requested: the
 *                     production's full admitted document at that revision
 *                     and the export profile; written once, never changed
 *   job.json          this record, replaced by atomic rename
 *   job.lock          held exclusively while a process runs the render
 *   work/             the running attempt's scratch folder
 *   video.mp4, manifest.json, captions.srt, captions.vtt, verification.json
 *                     the published render
 *
 *   queued ──▶ running ──▶ succeeded
 *     │           │  ▲
 *     │           │  └── transient failure, attempt < MAX_RENDER_ATTEMPTS (queued during the pause)
 *     │           ├────▶ failed (transient after the last attempt, permanent, configuration)
 *     └───────────┴────▶ cancelled (a person)
 *   failed, cancelled ──retry──▶ queued (attempts start again)
 *
 * - The render folder appears whole: request.json and job.json are written in
 *   `data/video-renders/.staging/<uuid>/` and renamed into place together.
 * - An attempt builds into `work/`. Only when the pipeline has produced every
 *   file are they renamed into the render folder, and job.json is then the
 *   commit point: files are served only while it says `succeeded`. A new
 *   attempt first removes whatever an earlier one left.
 * - A verification failure is permanent (`verification_failed`). Its files
 *   stay in the render folder for inspection, with verification.json, but the
 *   job is `failed`, so they are never served as a deliverable.
 * - One render runs at a time in a process, in a lane of its own, so preview
 *   jobs (`MediaJobs`) keep flowing during an export.
 * - `job.lock` keeps two processes from running the same render. It is made
 *   by writing the holder to a unique file and hard-linking it into place, so
 *   it is never seen half written; an unreadable lock counts as held until it
 *   is `LOCK_GRACE_MS` old. A lock whose holder has stopped is taken over by
 *   moving it aside, checking that it is still the lock that was judged
 *   stale, and linking a new one; a process removes only its own lock.
 * - A queued or running record is written only under `job.lock`: by the
 *   runner from its claim to its last write, and by a process that cancels
 *   it or queues an interrupted one again. (A person's retry writes a failed
 *   or cancelled record, which no runner touches.) The runner re-reads the
 *   record before each of its writes and stops, writing nothing, when the
 *   record is no longer its own.
 * - The owner (process id, host, process start time and instance) is on the
 *   record while the render runs and while it waits between attempts. An
 *   owner whose process id is alive but started at another time is gone.
 * - `start()` queues again a render left running by a stopped process
 *   (`interrupted`). That attempt counts: once it was the last one, the render
 *   fails as transient `interrupted` instead.
 * - Cancelling a queued render, or one waiting between attempts in this
 *   process, cancels it at once; cancelling a running one aborts its signal,
 *   which stops its browsers and FFmpeg, and the render becomes `cancelled`
 *   (not failed) when the pipeline returns. A render running or waiting in
 *   another live process cannot be cancelled from this one. A person may
 *   cancel a render whose owner is neither this process nor confirmed alive
 *   (it ran under another host name, for example), which also removes that
 *   owner's lock; this is the only lock a process removes without holding it.
 * - A job.json write that fails once the render has started (a full disk)
 *   fails the render as `io_error` on a best-effort basis; if that write
 *   fails too, the record says `running` with no runner, and a person can
 *   cancel it.
 * - Requesting a render while one is queued or running for the same document
 *   (by the snapshot's SHA-256) and profile returns that render instead. This
 *   is exact within a process; two processes racing may both create one,
 *   which is harmless (both render the same snapshot).
 *
 * Log events (`[video render] ...`) carry ids, attempts and codes only, never
 * paths or messages.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Mutex } from "async-mutex";

import type { Production } from "@/types/production";
import { currentProcess, ownerAlive, type ProcessOwner } from "../process-owner";
import { ID_PATTERN } from "../production/primitives";
import { RenderFailure, type RenderProgress } from "./execute-types";
import type { ExportProfileId } from "./profile";
import {
  classifyRenderError,
  MAX_RENDER_ATTEMPTS,
  PIPELINE_FILES,
  PUBLISHED_FILES,
  RENDER_FILES,
  RENDER_JOB_VERSION,
  RENDER_REQUEST_VERSION,
  validJob,
  validRequest,
  type CancelResult,
  type HistoryEvent,
  type RenderFileName,
  type RenderJob,
  type RenderJobFailure,
  type RenderJobsOptions,
  type RenderPipeline,
  type RenderRequest,
  type RenderState,
  type RetryResult,
} from "./render-record";
import type { VerificationReport } from "./verify";

const HISTORY_KEPT = 20;
const WORK_DIR = "work";
/** Not a valid id, so never mistaken for a production folder. */
const STAGING_DIR = ".staging";
const LOCK_FILE = "job.lock";
/** How long an unreadable job.lock counts as held, as if its creator were still writing it. */
export const LOCK_GRACE_MS = 30_000;

type LockHolder = ProcessOwner & { instance: string };
/** `ours` is a lock this instance already holds, for another step of the same render. */
type LockResult = "acquired" | "ours" | "held";

const isActive = (state: RenderState) => state === "queued" || state === "running";

const snapshotSha256 = (production: Production) => createHash("sha256").update(JSON.stringify(production), "utf-8").digest("hex");

function parseHolder(raw: string): LockHolder | null {
  try {
    const holder = JSON.parse(raw) as LockHolder;
    return typeof holder?.pid === "number" && typeof holder.host === "string" && typeof holder.instance === "string" ? holder : null;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
    if (signal.aborted) done();
  });
}

type Outcome = { ok: true; verification: VerificationReport; outputs: NonNullable<RenderJob["outputs"]> } | { ok: false; failure: RenderJobFailure };

export class RenderJobs {
  readonly instance = randomUUID();
  readonly root: string;
  private readonly pipeline: RenderPipeline;
  private readonly clock: () => number;
  private readonly backoff: (attempt: number) => number;
  private readonly progressIntervalMs: number;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;
  private readonly queue: { productionId: string; renderId: string }[] = [];
  /** The controller of the render this process is working on, by render id, from its claim to its last write. */
  private readonly active = new Map<string, AbortController>();
  /** Serialises every read-modify-write of a job record in this process. */
  private readonly transitions = new Mutex();
  private readonly requests = new Mutex();
  private draining: Promise<void> | null = null;
  private started: Promise<void> | null = null;
  private stopped = false;
  private lastIdMs = 0;

  constructor(options: RenderJobsOptions) {
    this.root = path.resolve(/*turbopackIgnore: true*/ options.root);
    this.pipeline = options.pipeline;
    this.clock = options.clock ?? Date.now;
    this.backoff = options.backoff ?? ((attempt) => 2000 * 2 ** (attempt - 2));
    this.progressIntervalMs = options.progressIntervalMs ?? 1000;
    this.log = options.log ?? ((event, fields) => console.info(`[video render] ${event}`, fields));
  }

  private iso(): string {
    return new Date(this.clock()).toISOString();
  }

  renderDir(productionId: string, renderId: string): string {
    if (!ID_PATTERN.test(productionId) || !ID_PATTERN.test(renderId)) throw new Error("not a render id");
    return path.join(/*turbopackIgnore: true*/ this.root, productionId, renderId);
  }

  filePath(productionId: string, renderId: string, name: RenderFileName): string {
    return path.join(/*turbopackIgnore: true*/ this.renderDir(productionId, renderId), name);
  }

  /** A render's record, or null when there is none or it is unreadable. */
  async read(productionId: string, renderId: string): Promise<RenderJob | null> {
    if (!ID_PATTERN.test(productionId) || !ID_PATTERN.test(renderId)) return null;
    try {
      const job = JSON.parse(await readFile(path.join(/*turbopackIgnore: true*/ this.renderDir(productionId, renderId), "job.json"), "utf-8")) as RenderJob;
      return validJob(job, productionId, renderId) ? job : null;
    } catch {
      return null;
    }
  }

  /** The snapshot a render was requested with, or null when it is missing or does not match the record. */
  async readRequest(productionId: string, renderId: string): Promise<RenderRequest | null> {
    try {
      const request = JSON.parse(await readFile(path.join(/*turbopackIgnore: true*/ this.renderDir(productionId, renderId), "request.json"), "utf-8")) as RenderRequest;
      return validRequest(request, productionId, renderId) ? request : null;
    } catch {
      return null;
    }
  }

  /** A production's renders, newest first. */
  async list(productionId: string): Promise<RenderJob[]> {
    if (!ID_PATTERN.test(productionId)) return [];
    const jobs: RenderJob[] = [];
    for (const renderId of await idFolders(path.join(/*turbopackIgnore: true*/ this.root, productionId))) {
      const job = await this.read(productionId, renderId);
      if (job) jobs.push(job);
    }
    return jobs.sort((a, b) => b.renderId.localeCompare(a.renderId));
  }

  /** Whether a person's cancel of this process's running render is waiting for the pipeline to stop. */
  cancelPending(renderId: string): boolean {
    return this.active.get(renderId)?.signal.aborted === true;
  }

  /**
   * Snapshots an admitted production and queues its render, or returns the
   * render already queued or running for the same revision and profile.
   */
  request(production: Production, profileId: ExportProfileId): Promise<{ created: boolean; job: RenderJob }> {
    return this.requests.runExclusive(async () => {
      const hash = snapshotSha256(production);
      const existing = (await this.list(production.id)).find((j) => j.profileId === profileId && j.snapshotSha256 === hash && this.inProgress(j));
      if (existing) return { created: false, job: existing };
      const renderId = this.newRenderId();
      const at = this.iso();
      const request: RenderRequest = { version: RENDER_REQUEST_VERSION, renderId, productionId: production.id, revision: production.revision, profileId, requestedAt: at, production };
      const job: RenderJob = {
        version: RENDER_JOB_VERSION,
        renderId,
        productionId: production.id,
        revision: production.revision,
        profileId,
        snapshotSha256: hash,
        state: "queued",
        attempts: 0,
        requestedAt: at,
        updatedAt: at,
        history: [{ at, event: "queued" }],
      };
      const staging = path.join(/*turbopackIgnore: true*/ this.root, STAGING_DIR, randomUUID());
      await mkdir(staging, { recursive: true });
      try {
        await writeFile(path.join(/*turbopackIgnore: true*/ staging, "request.json"), JSON.stringify(request) + "\n", { mode: 0o644 });
        await writeFile(path.join(/*turbopackIgnore: true*/ staging, "job.json"), JSON.stringify(job, null, 2) + "\n", { mode: 0o644 });
        await mkdir(path.join(/*turbopackIgnore: true*/ this.root, production.id), { recursive: true });
        await rename(staging, this.renderDir(production.id, renderId));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      this.log("render_requested", { productionId: production.id, renderId, revision: production.revision, profile: profileId });
      this.push(production.id, renderId);
      return { created: true, job };
    });
  }

  /**
   * Queues every render left queued, and every render left running by a
   * process that has stopped, oldest first. Safe to call more than once.
   */
  start(): Promise<void> {
    this.started ??= (async () => {
      const found: RenderJob[] = [];
      for (const productionId of await idFolders(this.root)) {
        for (const renderId of await idFolders(path.join(/*turbopackIgnore: true*/ this.root, productionId))) {
          const job = await this.read(productionId, renderId);
          if (job) found.push(job);
          else this.log("render_unreadable", { productionId, renderId });
        }
      }
      found.sort((a, b) => a.renderId.localeCompare(b.renderId));
      for (const job of found) {
        if (job.state === "queued") {
          this.push(job.productionId, job.renderId);
        } else if (job.state === "running" && !this.ownerRunning(job)) {
          const dir = this.renderDir(job.productionId, job.renderId);
          if ((await this.lock(dir)) !== "acquired") continue;
          let next: RenderState | null;
          try {
            next = await this.transitions.runExclusive(async () => {
              const current = await this.read(job.productionId, job.renderId);
              if (!current || current.state !== "running" || this.ownerRunning(current)) return null;
              delete current.owner;
              this.event(current, "interrupted", { attempt: current.attempts });
              if (current.attempts >= MAX_RENDER_ATTEMPTS) {
                current.state = "failed";
                current.failure = { failureClass: "transient", code: "interrupted", message: "the server stopped during the render's last attempt" };
                this.event(current, "failed", { attempt: current.attempts, code: "interrupted" });
              } else {
                current.state = "queued";
              }
              await this.write(current);
              return current.state;
            });
          } finally {
            await this.unlock(dir);
          }
          if (!next) continue;
          const ids = { productionId: job.productionId, renderId: job.renderId, attempt: job.attempts };
          this.log("render_interrupted", ids);
          if (next === "failed") this.log("render_failed", { ...ids, failureClass: "transient", code: "interrupted" });
          else this.push(job.productionId, job.renderId);
        }
      }
    })();
    return this.started;
  }

  /**
   * A person cancels a render. A queued render, one waiting between attempts
   * in this process, and one whose owner is neither this process nor
   * confirmed alive are cancelled at once; a render running here is asked to
   * stop (`pending`). Anything else is refused.
   */
  cancel(productionId: string, renderId: string): Promise<CancelResult> {
    return this.transitions.runExclusive(async (): Promise<CancelResult> => {
      const job = await this.read(productionId, renderId);
      if (!job) return { ok: false, code: "not_found" };
      const controller = this.active.get(renderId);
      if (controller && isActive(job.state) && job.owner?.instance === this.instance) {
        if (job.state === "running") {
          controller.abort();
          return { ok: true, job, pending: true };
        }
        // Waiting between attempts: settled now, then the runner wakes and finds it cancelled.
        this.active.delete(renderId);
        const result = await this.cancelNow(job);
        controller.abort();
        return result;
      }
      if (!isActive(job.state) || this.ownerConfirmedAlive(job)) return { ok: false, code: "not_cancellable", job };
      // Under the render's lock, so a runner in another process cannot claim it meanwhile.
      const dir = this.renderDir(productionId, renderId);
      const held = await this.lock(dir, job.owner?.instance);
      if (held === "held") return { ok: false, code: "not_cancellable", job };
      try {
        const current = held === "acquired" ? await this.read(productionId, renderId) : job;
        if (!current || !isActive(current.state)) return { ok: false, code: "not_cancellable", job: current ?? job };
        return await this.cancelNow(current);
      } finally {
        if (held === "acquired") await this.unlock(dir);
      }
    });
  }

  private async cancelNow(job: RenderJob): Promise<CancelResult> {
    job.state = "cancelled";
    delete job.owner;
    await this.write(this.event(job, "cancelled", job.attempts > 0 ? { attempt: job.attempts } : {}));
    this.log("render_cancelled", { productionId: job.productionId, renderId: job.renderId, attempt: job.attempts });
    return { ok: true, job, pending: false };
  }

  /** A person asks for a failed or cancelled render to run again from its snapshot. */
  retry(productionId: string, renderId: string): Promise<RetryResult> {
    return this.transitions.runExclusive(async (): Promise<RetryResult> => {
      const job = await this.read(productionId, renderId);
      if (!job) return { ok: false, code: "not_found" };
      if (job.state !== "failed" && job.state !== "cancelled") return { ok: false, code: "not_retryable", job };
      job.state = "queued";
      job.attempts = 0;
      for (const field of ["owner", "failure", "verification", "outputs", "progress"] as const) delete job[field];
      await this.write(this.event(job, "retried"));
      this.log("render_retried", { productionId, renderId });
      this.push(productionId, renderId);
      return { ok: true, job };
    });
  }

  /** Resolves when nothing is queued or running in this process. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Stops the running render; it stays `running` on disk and the next start queues it again. */
  stop(): void {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
  }

  private newRenderId(): string {
    const ms = Math.max(this.clock(), this.lastIdMs + 1);
    this.lastIdMs = ms;
    return `render-${ms.toString(36).padStart(9, "0")}-${randomBytes(4).toString("hex")}`;
  }

  private event(job: RenderJob, event: HistoryEvent, extra: { attempt?: number; code?: string } = {}): RenderJob {
    job.updatedAt = this.iso();
    job.history.push({ at: job.updatedAt, event, ...extra });
    return job;
  }

  private async write(job: RenderJob): Promise<void> {
    job.history = job.history.slice(-HISTORY_KEPT);
    const file = path.join(/*turbopackIgnore: true*/ this.renderDir(job.productionId, job.renderId), "job.json");
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(job, null, 2) + "\n", { mode: 0o644 });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /**
   * Whether the render's owner may still be running it: this instance while
   * it works on the render, or another process not known to have stopped. An
   * owner with this process's id and another instance is an earlier runner.
   */
  private ownerRunning(job: RenderJob): boolean {
    if (!job.owner) return false;
    if (job.owner.instance === this.instance) return this.active.has(job.renderId);
    return job.owner.pid !== process.pid && ownerAlive(job.owner) !== false;
  }

  /** Whether the render's owner is known to be running it; only then is a person's cancel refused. */
  private ownerConfirmedAlive(job: RenderJob): boolean {
    if (!job.owner) return false;
    if (job.owner.instance === this.instance) return this.active.has(job.renderId);
    return job.owner.pid !== process.pid && ownerAlive(job.owner) === true;
  }

  /** Queued, or running with an owner that may still be running it. */
  private inProgress(job: RenderJob): boolean {
    return job.state === "queued" || (job.state === "running" && this.ownerRunning(job));
  }

  /** Whether the record on disk is still this instance's running attempt. */
  private async stillRunningHere(job: RenderJob): Promise<boolean> {
    const disk = await this.read(job.productionId, job.renderId);
    return disk?.state === "running" && disk.owner?.instance === this.instance;
  }

  private push(productionId: string, renderId: string): void {
    if (this.stopped || this.queue.some((q) => q.renderId === renderId)) return;
    this.queue.push({ productionId, renderId });
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
      try {
        await this.runJob(next.productionId, next.renderId);
      } catch (error) {
        this.log("render_error", { productionId: next.productionId, renderId: next.renderId, name: (error as Error)?.name, code: (error as NodeJS.ErrnoException)?.code });
      }
      if (this.stopped) return;
    }
  }

  /**
   * Takes the render's cross-process lock. A lock whose holder has stopped,
   * an unreadable one older than `LOCK_GRACE_MS`, and (for a person's cancel)
   * one held by `breakHolder` when that holder is not confirmed alive are
   * taken over; any other is `held`.
   */
  private async lock(dir: string, breakHolder?: string): Promise<LockResult> {
    const file = path.join(/*turbopackIgnore: true*/ dir, LOCK_FILE);
    const identity = JSON.stringify({ ...currentProcess(), instance: this.instance });
    for (let attempt = 0; attempt < 3; attempt++) {
      // Written whole first, then linked into place: the lock never exists half written.
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, identity, { mode: 0o644 });
        await link(tmp, file);
        return "acquired";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await rm(tmp, { force: true });
      }
      const raw = await readFile(file, "utf-8").catch(() => null);
      if (raw === null) continue;
      const holder = parseHolder(raw);
      if (holder?.instance === this.instance) return "ours";
      if (holder) {
        const alive = ownerAlive(holder);
        if (alive !== false && !(breakHolder !== undefined && holder.instance === breakHolder && alive !== true)) return "held";
      } else {
        const info = await stat(file).catch(() => null);
        if (info && Date.now() - info.mtimeMs < LOCK_GRACE_MS) return "held";
      }
      if (!(await removeLockIf(file, raw))) return "held";
    }
    return "held";
  }

  /** Removes the render's lock if this instance holds it. */
  private async unlock(dir: string): Promise<void> {
    const file = path.join(/*turbopackIgnore: true*/ dir, LOCK_FILE);
    const holder = parseHolder(await readFile(file, "utf-8").catch(() => ""));
    if (holder?.instance === this.instance) await rm(file, { force: true });
  }

  private async runJob(productionId: string, renderId: string): Promise<void> {
    const dir = this.renderDir(productionId, renderId);
    if ((await this.lock(dir)) !== "acquired") return;
    const controller = new AbortController();
    const ids = { productionId, renderId };
    const claim: { job?: RenderJob } = {};
    try {
      // Claimed and started in one step, so nothing can cancel it in between unseen.
      const claimed = await this.transitions.runExclusive(async () => {
        const current = await this.read(productionId, renderId);
        if (this.stopped || !current || current.state !== "queued") return false;
        claim.job = current;
        this.active.set(renderId, controller);
        await this.begin(current);
        return true;
      });
      const job = claim.job;
      if (!claimed || !job) return;
      for (;;) {
        // Progress is written when the stage changes and otherwise at most once
        // per interval, in order, never after the attempt ends, and only while
        // the record is still this attempt's.
        let writes = Promise.resolve();
        let live = true;
        let lastWrite = 0;
        let lastStage: RenderProgress["stage"] | null = null;
        const onProgress = (progress: RenderProgress) => {
          if (!live) return;
          job.progress = { stage: progress.stage, done: progress.done, total: progress.total };
          const now = this.clock();
          if (progress.stage === lastStage && now - lastWrite < this.progressIntervalMs) return;
          lastStage = progress.stage;
          lastWrite = now;
          const snapshot: RenderJob = { ...job, updatedAt: new Date(now).toISOString(), history: [...job.history] };
          writes = writes
            .then(() =>
              this.transitions.runExclusive(async () => {
                if (await this.stillRunningHere(job)) return this.write(snapshot);
                // A person cancelled it from another process: stop working on it.
                controller.abort();
              })
            )
            .catch((error) => this.log("render_error", { ...ids, name: (error as Error)?.name, code: (error as NodeJS.ErrnoException)?.code }));
        };
        const outcome = await this.attempt(job, dir, controller.signal, onProgress);
        live = false;
        await writes;
        // Decided under the same lock as cancel(), so a cancel either lands
        // before this decision (and wins) or sees the settled state.
        const next = await this.transitions.runExclusive(() => this.settle(job, outcome, controller.signal, dir));
        if (next !== "retry") return;
        await sleep(this.backoff(job.attempts + 1), controller.signal);
        const resumed = await this.transitions.runExclusive(async () => {
          if (this.stopped) return false;
          // Cancelled while waiting, here (which also woke the sleep) or elsewhere: nothing more to write.
          const current = await this.read(productionId, renderId);
          if (current?.state !== "queued" || current.owner?.instance !== this.instance) return false;
          await this.begin(job);
          return true;
        });
        if (!resumed) return;
      }
    } catch (error) {
      const job = claim.job;
      if (job && !this.stopped) await this.transitions.runExclusive(() => this.failAfterError(job, error)).catch(() => undefined);
      throw error;
    } finally {
      this.active.delete(renderId);
      await this.unlock(dir);
    }
  }

  /** Starts the render's next attempt on disk; the caller holds `transitions`. */
  private async begin(job: RenderJob): Promise<void> {
    job.state = "running";
    job.attempts += 1;
    job.owner = { ...currentProcess(), instance: this.instance };
    for (const field of ["failure", "verification", "progress"] as const) delete job[field];
    await this.write(this.event(job, "started", { attempt: job.attempts }));
    this.log("render_started", { productionId: job.productionId, renderId: job.renderId, attempt: job.attempts });
  }

  /**
   * After a job.json write failed during the render, records it as failed
   * from what is on disk, on a best-effort basis, unless the record has moved
   * on without this runner. The caller holds `transitions`.
   */
  private async failAfterError(job: RenderJob, error: unknown): Promise<void> {
    const disk = await this.read(job.productionId, job.renderId);
    if (!disk || !isActive(disk.state) || (disk.owner && disk.owner.instance !== this.instance)) return;
    const failure = classifyRenderError(error);
    disk.state = "failed";
    disk.failure = failure;
    delete disk.owner;
    await this.write(this.event(disk, "failed", { attempt: disk.attempts, code: failure.code }));
    this.active.delete(job.renderId);
    this.log("render_failed", { productionId: job.productionId, renderId: job.renderId, attempt: disk.attempts, failureClass: failure.failureClass, code: failure.code });
  }

  /**
   * Records an attempt's outcome; the caller holds `transitions`. Returns
   * "retry" when the render waits for another attempt, "done" otherwise. A
   * stopping server writes nothing, so the render stays `running` on disk, and
   * so does a runner whose record was cancelled by another process.
   */
  private async settle(job: RenderJob, outcome: Outcome, signal: AbortSignal, dir: string): Promise<"done" | "retry"> {
    if (this.stopped) return "done";
    const ids = { productionId: job.productionId, renderId: job.renderId, attempt: job.attempts };
    if (!(await this.stillRunningHere(job))) {
      const disk = await this.read(job.productionId, job.renderId);
      if (disk?.state === "cancelled") {
        await clearOutputs(dir);
        this.log("render_cancelled", ids);
      }
      this.active.delete(job.renderId);
      return "done";
    }
    if (signal.aborted) {
      await clearOutputs(dir);
      await this.cancelled(job);
      return "done";
    }
    if (outcome.ok) {
      const failedChecks = outcome.verification.checks.filter((c) => c.status === "failed").map((c) => c.id);
      job.verification = { ok: failedChecks.length === 0, failedChecks };
      if (failedChecks.length === 0) {
        job.state = "succeeded";
        job.outputs = outcome.outputs;
        delete job.owner;
        delete job.progress;
        await this.write(this.event(job, "succeeded", { attempt: job.attempts }));
        this.active.delete(job.renderId);
        this.log("render_succeeded", ids);
        return "done";
      }
      outcome = { ok: false, failure: { failureClass: "permanent", code: "verification_failed", message: `the exported file failed these checks: ${failedChecks.join(", ")}` } };
    }
    const failure = outcome.failure;
    job.failure = failure;
    if (failure.failureClass === "transient" && job.attempts < MAX_RENDER_ATTEMPTS) {
      // Waiting for the next attempt: the owner stays, so other processes see the render as taken.
      job.state = "queued";
      await this.write(this.event(job, "failed", { attempt: job.attempts, code: failure.code }));
      this.log("render_retrying", { ...ids, code: failure.code });
      return "retry";
    }
    job.state = "failed";
    delete job.owner;
    await this.write(this.event(job, "failed", { attempt: job.attempts, code: failure.code }));
    this.active.delete(job.renderId);
    this.log("render_failed", { ...ids, failureClass: failure.failureClass, code: failure.code });
    return "done";
  }

  private async cancelled(job: RenderJob): Promise<void> {
    job.state = "cancelled";
    delete job.owner;
    await this.write(this.event(job, "cancelled", { attempt: job.attempts }));
    this.active.delete(job.renderId);
    this.log("render_cancelled", { productionId: job.productionId, renderId: job.renderId, attempt: job.attempts });
  }

  /** One attempt: clear what an earlier attempt left, run the pipeline in `work/`, then publish every file by rename. */
  private async attempt(job: RenderJob, dir: string, signal: AbortSignal, onProgress: (progress: RenderProgress) => void): Promise<Outcome> {
    const work = path.join(/*turbopackIgnore: true*/ dir, WORK_DIR);
    try {
      await rm(work, { recursive: true, force: true });
      await clearOutputs(dir);
      await mkdir(work);
      const request = await this.readRequest(job.productionId, job.renderId);
      if (!request) throw new RenderFailure("permanent", "snapshot_invalid", "the render's snapshot of the production is missing or damaged");
      const result = await this.pipeline.run({ request, workDir: work, signal, onProgress });
      if (signal.aborted) return { ok: false, failure: { failureClass: "transient", code: "interrupted", message: "the render was stopped" } };
      for (const name of PIPELINE_FILES) {
        const info = await stat(path.join(/*turbopackIgnore: true*/ work, name)).catch(() => null);
        if (!info?.isFile()) throw new RenderFailure("permanent", "internal_error", `the render did not produce ${name}`);
      }
      await writeFile(path.join(/*turbopackIgnore: true*/ work, "manifest.json"), JSON.stringify(result.manifest, null, 2) + "\n", { mode: 0o644 });
      await writeFile(path.join(/*turbopackIgnore: true*/ work, "verification.json"), JSON.stringify(result.verification, null, 2) + "\n", { mode: 0o644 });
      for (const name of PUBLISHED_FILES) await rename(path.join(/*turbopackIgnore: true*/ work, name), path.join(/*turbopackIgnore: true*/ dir, name));
      const outputs: NonNullable<RenderJob["outputs"]> = [];
      for (const name of Object.keys(RENDER_FILES) as RenderFileName[]) outputs.push({ name, bytes: (await stat(path.join(/*turbopackIgnore: true*/ dir, name))).size });
      return { ok: true, verification: result.verification, outputs };
    } catch (error) {
      return { ok: false, failure: classifyRenderError(error) };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

/**
 * Removes a lock judged stale, but only if it is still the lock that was read
 * (`raw`): it is moved aside first, and put back when another process had
 * replaced it meanwhile. Returns whether the stale lock is gone.
 */
async function removeLockIf(file: string, raw: string): Promise<boolean> {
  const aside = `${file}.${randomUUID()}.stale`;
  try {
    await rename(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const moved = await readFile(aside, "utf-8").catch(() => null);
  if (moved !== raw) {
    await link(aside, file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  await rm(aside, { force: true });
  return moved === raw;
}

async function clearOutputs(dir: string): Promise<void> {
  for (const name of PUBLISHED_FILES) await rm(path.join(/*turbopackIgnore: true*/ dir, name), { force: true });
}

/** Sub-folders whose names are valid ids; none when the folder does not exist. */
async function idFolders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((e) => e.isDirectory() && ID_PATTERN.test(e.name)).map((e) => e.name);
}
