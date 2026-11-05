/**
 * Derived-files jobs (WS5 #82 slice, #140): one durable job per media, kept in
 * `objects/<mediaId>/job.json` beside the original.
 *
 *   queued ──▶ running ──▶ succeeded
 *                 │  ▲
 *                 │  └── transient failure, attempt < MAX_ATTEMPTS (after a pause)
 *                 └────▶ failed (transient after the last attempt, permanent, configuration)
 *
 * - One job runs at a time in a process, and a `job.lock` file created
 *   exclusively keeps two processes from running the same media at once. A
 *   lock whose process has stopped is taken over.
 * - A job found `running` without a live owner was interrupted (the server
 *   stopped); `start()` queues it again. Nothing is ever half-published: the
 *   outputs are built in a scratch folder and renamed into place only when all
 *   of them exist.
 * - `retry()` is the operator's recovery for a failed job; it is refused while
 *   a job is queued or running and once it has succeeded.
 * - `job.json` keeps the last attempts' outcomes for investigation, and is
 *   always replaced by an atomic rename.
 */
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { currentProcess, ownerAlive, type ProcessOwner } from "../process-owner";
import { buildDerived, ProxyFailure, type DerivedOutput, type FailureClass } from "./proxy";
import type { DerivedFile, MediaRecord, MediaRegistry } from "./registry";
import { ToolError } from "./tools";

export const JOB_VERSION = 1;
export const MAX_ATTEMPTS = 3;
const HISTORY_KEPT = 20;

export type JobState = "queued" | "running" | "succeeded" | "failed";

export interface JobFailure {
  failureClass: FailureClass;
  code: string;
  message: string;
}

export interface MediaJob {
  version: typeof JOB_VERSION;
  mediaId: string;
  state: JobState;
  /** Attempts since the job was last queued by an import or a person. */
  attempts: number;
  updatedAt: string;
  owner?: ProcessOwner & { instance: string };
  failure?: JobFailure;
  output?: DerivedOutput;
  history: { at: string; event: "queued" | "started" | "succeeded" | "failed" | "interrupted" | "retried"; code?: string }[];
}

export type Builder = (record: MediaRecord, original: string, dir: string, signal: AbortSignal) => Promise<DerivedOutput>;

export interface JobOptions {
  now?: () => string;
  builder?: Builder;
  /** Milliseconds to wait before attempt n (n ≥ 2). */
  backoff?: (attempt: number) => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type RetryResult = { ok: true; job: MediaJob } | { ok: false; code: "not_found" | "not_failed"; job?: MediaJob };

const STATES = new Set<JobState>(["queued", "running", "succeeded", "failed"]);

/** Classifies an error from building derived files. */
export function classify(error: unknown): JobFailure {
  if (error instanceof ProxyFailure) return { failureClass: error.failureClass, code: error.code, message: error.message };
  if (error instanceof ToolError) {
    if (error.reason === "missing") return { failureClass: "configuration", code: "tool_missing", message: error.message };
    if (error.reason === "timeout") return { failureClass: "transient", code: "timeout", message: error.message };
    if (error.reason === "aborted") return { failureClass: "transient", code: "interrupted", message: error.message };
    return { failureClass: "permanent", code: "tool_failed", message: "FFmpeg could not make a preview of this file" };
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC" || code === "EIO" || code === "EMFILE" || code === "ENFILE" || code === "EBUSY") {
    return { failureClass: "transient", code: "io_error", message: `the disk could not be written (${code})` };
  }
  return { failureClass: "permanent", code: "internal_error", message: "the preview could not be made" };
}

export class MediaJobs {
  readonly instance = randomUUID();
  private readonly registry: MediaRegistry;
  private readonly now: () => string;
  private readonly builder: Builder;
  private readonly backoff: (attempt: number) => number;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;
  private readonly queue: string[] = [];
  private draining: Promise<void> | null = null;
  private started: Promise<void> | null = null;
  private readonly controller = new AbortController();

  constructor(registry: MediaRegistry, options: JobOptions = {}) {
    this.registry = registry;
    this.now = options.now ?? (() => new Date().toISOString());
    this.builder = options.builder ?? buildDerived;
    this.backoff = options.backoff ?? ((attempt) => 2000 * 2 ** (attempt - 2));
    this.log = options.log ?? ((event, fields) => console.info(`[video media] ${event}`, fields));
  }

  private jobFile(mediaId: string): string {
    return path.join(/*turbopackIgnore: true*/ this.registry.objectDir(mediaId), "job.json");
  }

  private lockFile(mediaId: string): string {
    return path.join(/*turbopackIgnore: true*/ this.registry.objectDir(mediaId), "job.lock");
  }

  async read(mediaId: string): Promise<MediaJob | null> {
    try {
      const job = JSON.parse(await readFile(this.jobFile(mediaId), "utf-8")) as MediaJob;
      if (job.version !== JOB_VERSION || job.mediaId !== mediaId || !STATES.has(job.state) || !Array.isArray(job.history)) return null;
      return job;
    } catch {
      return null;
    }
  }

  private async write(job: MediaJob): Promise<void> {
    job.history = job.history.slice(-HISTORY_KEPT);
    const file = this.jobFile(job.mediaId);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(job, null, 2) + "\n", { mode: 0o644 });
    await rename(tmp, file);
  }

  /**
   * Queues every media whose job is missing, queued or interrupted. Safe to
   * call more than once; later calls wait for the first.
   */
  start(): Promise<void> {
    this.started ??= (async () => {
      for (const record of await this.registry.list()) {
        const job = await this.read(record.mediaId);
        if (!job) {
          await this.queueNew(record.mediaId);
        } else if (job.state === "queued") {
          this.push(record.mediaId);
        } else if (job.state === "running" && !this.ownerRunning(job)) {
          job.state = "queued";
          job.updatedAt = this.now();
          delete job.owner;
          job.history.push({ at: job.updatedAt, event: "interrupted" });
          await this.write(job);
          this.log("job_interrupted", { mediaId: record.mediaId });
          this.push(record.mediaId);
        }
      }
    })();
    return this.started;
  }

  /** Queues a newly imported media. */
  async enqueue(mediaId: string): Promise<void> {
    const job = await this.read(mediaId);
    if (job && job.state !== "queued") return;
    if (!job) await this.queueNew(mediaId);
    else this.push(mediaId);
  }

  /** A person asks for a failed job to run again. */
  async retry(mediaId: string): Promise<RetryResult> {
    if (!(await this.registry.get(mediaId))) return { ok: false, code: "not_found" };
    const job = await this.read(mediaId);
    if (job && job.state !== "failed") return { ok: false, code: "not_failed", job };
    const next: MediaJob = job ?? this.fresh(mediaId);
    next.state = "queued";
    next.attempts = 0;
    next.updatedAt = this.now();
    delete next.failure;
    delete next.owner;
    next.history.push({ at: next.updatedAt, event: "retried" });
    await this.write(next);
    this.log("job_retried", { mediaId });
    this.push(mediaId);
    return { ok: true, job: next };
  }

  /** Resolves when nothing is queued or running in this process. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Stops the running job; it stays `running` on disk and the next start queues it again. */
  stop(): void {
    this.controller.abort();
  }

  private fresh(mediaId: string): MediaJob {
    return { version: JOB_VERSION, mediaId, state: "queued", attempts: 0, updatedAt: this.now(), history: [] };
  }

  private async queueNew(mediaId: string): Promise<void> {
    const job = this.fresh(mediaId);
    job.history.push({ at: job.updatedAt, event: "queued" });
    await this.write(job);
    this.push(mediaId);
  }

  private ownerRunning(job: MediaJob): boolean {
    if (!job.owner) return false;
    if (job.owner.instance === this.instance) return true;
    return job.owner.pid !== process.pid && ownerAlive(job.owner) !== false;
  }

  private push(mediaId: string): void {
    if (this.controller.signal.aborted || this.queue.includes(mediaId)) return;
    this.queue.push(mediaId);
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    for (let mediaId = this.queue.shift(); mediaId !== undefined; mediaId = this.queue.shift()) {
      try {
        await this.runJob(mediaId);
      } catch (error) {
        this.log("job_error", { mediaId, name: (error as Error)?.name, code: (error as NodeJS.ErrnoException)?.code });
      }
      if (this.controller.signal.aborted) return;
    }
  }

  /** Takes the cross-process lock, or returns false when a live process holds it. */
  private async lock(mediaId: string): Promise<boolean> {
    const file = this.lockFile(mediaId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, "wx", 0o644);
        await handle.writeFile(JSON.stringify({ ...currentProcess(), instance: this.instance }));
        await handle.close();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = await readFile(file, "utf-8").then((t) => JSON.parse(t) as ProcessOwner & { instance: string }, () => null);
        if (holder && (holder.instance === this.instance || ownerAlive(holder) !== false)) return false;
        await rm(file, { force: true });
      }
    }
    return false;
  }

  private async runJob(mediaId: string): Promise<void> {
    const record = await this.registry.get(mediaId);
    const queued = await this.read(mediaId);
    if (!record || !queued || queued.state !== "queued") return;
    if (!(await this.lock(mediaId))) return;
    try {
      let job = queued;
      for (;;) {
        job = { ...job, state: "running", attempts: job.attempts + 1, updatedAt: this.now(), owner: { ...currentProcess(), instance: this.instance } };
        delete job.failure;
        job.history.push({ at: job.updatedAt, event: "started" });
        await this.write(job);
        this.log("job_started", { mediaId, attempt: job.attempts });

        const outcome = await this.attempt(record);
        if (this.controller.signal.aborted) return;
        job = { ...job, updatedAt: this.now() };
        delete job.owner;
        if (outcome.ok) {
          job.state = "succeeded";
          job.output = outcome.output;
          job.history.push({ at: job.updatedAt, event: "succeeded" });
          await this.write(job);
          this.log("job_succeeded", { mediaId, attempt: job.attempts, files: outcome.output.files });
          return;
        }
        const failure = outcome.failure;
        if (failure.failureClass === "transient" && job.attempts < MAX_ATTEMPTS) {
          job.state = "queued";
          job.failure = failure;
          job.history.push({ at: job.updatedAt, event: "failed", code: failure.code });
          await this.write(job);
          this.log("job_retrying", { mediaId, attempt: job.attempts, code: failure.code });
          await new Promise((resolve) => setTimeout(resolve, this.backoff(job.attempts + 1)));
          if (this.controller.signal.aborted) return;
          continue;
        }
        job.state = "failed";
        job.failure = failure;
        job.history.push({ at: job.updatedAt, event: "failed", code: failure.code });
        await this.write(job);
        this.log("job_failed", { mediaId, attempt: job.attempts, failureClass: failure.failureClass, code: failure.code });
        return;
      }
    } finally {
      await rm(this.lockFile(mediaId), { force: true });
    }
  }

  /** One attempt: build into scratch, then publish every output by rename. */
  private async attempt(record: MediaRecord): Promise<{ ok: true; output: DerivedOutput } | { ok: false; failure: JobFailure }> {
    const scratch = await this.registry.scratch();
    try {
      const output = await this.builder(record, this.registry.originalPath(record), scratch, this.controller.signal);
      for (const file of output.files) await rename(path.join(/*turbopackIgnore: true*/ scratch, file), this.registry.derivedPath(record.mediaId, file as DerivedFile));
      return { ok: true, output };
    } catch (error) {
      return { ok: false, failure: classify(error) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
