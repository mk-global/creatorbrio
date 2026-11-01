import { createHash } from "node:crypto";
import { mutateData, readDataSafe } from "./data";
import { getCarousel } from "./carousels";
import type { Carousel } from "@/types/carousel";

/**
 * The lifecycle of a carousel's creative runs: whether one is in progress, and
 * whether the last one was interrupted. This module is its only owner.
 *
 * A carousel has at most one active run. `/api/chat` begins it before doing
 * any work for the request and ends it exactly once, however the request
 * ends; a second request while one is active is refused. While a run is
 * active the carousel is "generating", which is held in process memory: a
 * server restart kills every subprocess, so nothing can stay generating
 * across one. Memory lives on `globalThis` because Next.js may bundle this
 * module separately for each route, and the chat and export routes must agree.
 *
 * Whether a run changed the carousel is decided by its slide fingerprint, a
 * hash of the slides' IDs and HTML in slide order, taken when the run begins
 * and compared when it ends. Notes, caption, hashtags, name, reference images
 * and uploads are not part of it, so changing them never makes a run count as
 * having changed the carousel.
 *
 * How the run ended is persisted in `data/generation-runs.json`, so it
 * survives a reload and a server restart:
 *
 * - A run that completes, or that changed no slide, leaves the carousel as it
 *   was before the run. So does a "blocked" run, which declined to start its
 *   work and never touches slides.
 * - A run that changed slides and then was stopped (the Stop button, a reload,
 *   a closed tab), failed or timed out marks the carousel "interrupted": its
 *   slides are kept, but export refuses it until the user either confirms the
 *   slides as they are or a later run completes.
 * - A run still recorded as running when none is active means the server
 *   stopped mid-run. It is settled the first time it is read: interrupted if
 *   the slides differ from its baseline, otherwise as if it had changed
 *   nothing. Records written before fingerprints existed have none and are
 *   treated as before, as interrupted.
 */

export type InterruptionReason = "stopped" | "failed" | "timed-out" | "server-stopped";

export interface Interruption {
  reason: InterruptionReason;
  endedAt: string;
}

/**
 * How a run ended. "not-started" means its work never began; "blocked" means
 * it decided not to do its work. Neither can have changed a slide.
 */
export type RunOutcome = "completed" | "not-started" | "blocked" | InterruptionReason;

type RunRecord =
  | {
      state: "running";
      startedAt: string;
      /** The slide fingerprint when the run began; absent in records from before fingerprints. */
      fingerprint?: string | null;
      /** The carousel's `updatedAt` when the run began, in records from before fingerprints. */
      baseline?: string | null;
      /** An interruption recorded before this run, restored if this run changes nothing. */
      previous: Interruption | null;
    }
  | ({ state: "interrupted" } & Interruption);

interface RunsFile {
  runs: Record<string, RunRecord>;
}

const RUNS_FILE = "generation-runs.json";
const emptyRuns = (): RunsFile => ({ runs: {} });

/**
 * A hash of a carousel's slides, their IDs and HTML in slide order, or null
 * for a carousel that does not exist. It changes when a slide is added,
 * removed, reordered or rewritten, and for nothing else.
 */
export function slideFingerprint(carousel: Pick<Carousel, "slides"> | null): string | null {
  if (!carousel) return null;
  const ordered = [...carousel.slides]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((slide) => [slide.id, slide.html]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

async function currentFingerprint(carouselId: string): Promise<string | null> {
  return slideFingerprint(await getCarousel(carouselId));
}

/** The active run per carousel, in memory. */
interface ActiveRun {
  /** Resolves once the run's start, with its baseline, is saved. */
  started: Promise<void>;
}

// Keeps the product's former name: a running server that reloads this module
// must find the same registry, or it would lose generations in progress.
const REGISTRY_KEY = Symbol.for("framewoven.generation-status");

function registry(): Map<string, ActiveRun> {
  const store = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: Map<string, ActiveRun>;
  };
  store[REGISTRY_KEY] ??= new Map();
  return store[REGISTRY_KEY];
}

/**
 * How a Claude CLI run ended, from what the chat route observed. A clean exit
 * whose final result reported an error (for example the budget ran out) did
 * not finish its work either.
 */
export function classifyRunExit(exit: {
  cancelled: boolean;
  timedOut: boolean;
  code: number | null;
  resultIsError: boolean;
}): RunOutcome {
  if (exit.timedOut) return "timed-out";
  if (exit.cancelled) return "stopped";
  if (exit.code !== 0 || exit.resultIsError) return "failed";
  return "completed";
}

/** What an interrupted record says, or null for any other record. */
function recordedInterruption(record: RunRecord | undefined): Interruption | null {
  return record?.state === "interrupted" ? { reason: record.reason, endedAt: record.endedAt } : null;
}

/**
 * What a run recorded as running, but no longer active, leaves behind: the
 * server stopped mid-run. It interrupted the carousel only if the slides now
 * differ from its baseline; a record without a fingerprint predates them and
 * counts as interrupted, as it always did.
 */
function abandonedRunResult(
  record: Extract<RunRecord, { state: "running" }>,
  fingerprint: string | null
): Interruption | null {
  const changed = record.fingerprint === undefined || record.fingerprint !== fingerprint;
  return changed ? { reason: "server-stopped", endedAt: record.startedAt } : record.previous;
}

/** One active run: wait for its start to be saved, then end it once. */
export interface GenerationRun {
  /** Resolves once the run's start and baseline are saved; do the work after it. */
  ready: Promise<void>;
  /**
   * Ends the run with its outcome. The carousel counts as generating until
   * the returned promise resolves, by which time the outcome is saved. Ending
   * again has no effect.
   */
  end(outcome: RunOutcome): Promise<void>;
}

/**
 * Begins a run for `carouselId`, or returns null, changing nothing, if one is
 * already active. The check and the reservation happen together, so two
 * requests can never both begin a run for the same carousel.
 */
export function beginGeneration(carouselId: string): GenerationRun | null {
  const runs = registry();
  if (runs.has(carouselId)) return null;

  const started = (async () => {
    const fingerprint = await currentFingerprint(carouselId);
    await mutateData(RUNS_FILE, emptyRuns, (data) => {
      const record = data.runs[carouselId];
      // No run was active, so a "running" record is one the server never
      // finished; it is settled now, against this run's own baseline.
      const previous =
        record?.state === "running" ? abandonedRunResult(record, fingerprint) : recordedInterruption(record);
      data.runs[carouselId] = {
        state: "running",
        startedAt: new Date().toISOString(),
        fingerprint,
        previous,
      };
    });
  })().catch((err) => {
    console.error("[generation] could not record the start of a run", { carouselId, err });
  });
  const active: ActiveRun = { started };
  runs.set(carouselId, active);

  let ended: Promise<void> | null = null;
  return {
    ready: started,
    end(outcome) {
      ended ??= (async () => {
        await started;
        await settle(carouselId, outcome).catch((err) => {
          console.error("[generation] could not record how a run ended", { carouselId, outcome, err });
        });
        if (runs.get(carouselId) === active) runs.delete(carouselId);
      })();
      return ended;
    },
  };
}

/** Saves how the active run for a carousel ended. */
async function settle(carouselId: string, outcome: RunOutcome): Promise<void> {
  const current = await getCarousel(carouselId).catch(() => null);
  const fingerprint = slideFingerprint(current);
  await mutateData(RUNS_FILE, emptyRuns, (data) => {
    const record = data.runs[carouselId];
    const running = record?.state === "running" ? record : null;
    const changed = !running
      ? true
      : running.fingerprint !== undefined
        ? running.fingerprint !== fingerprint
        : // A run begun by code from before fingerprints, settled by this code.
          (current?.updatedAt ?? null) !== (running.baseline ?? null);
    const previous = running ? running.previous : recordedInterruption(record);

    let next: Interruption | null;
    if (!changed || outcome === "not-started" || outcome === "blocked") next = previous;
    else if (outcome === "completed") next = null;
    else next = { reason: outcome, endedAt: new Date().toISOString() };

    if (next) data.runs[carouselId] = { state: "interrupted", ...next };
    else delete data.runs[carouselId];
  });
}

/**
 * Settles a run recorded as running whose server stopped, so its verdict is
 * fixed at the slides as they were found, not as they are later edited.
 */
async function recoverAbandonedRun(carouselId: string): Promise<void> {
  const fingerprint = await currentFingerprint(carouselId);
  await mutateData(RUNS_FILE, emptyRuns, (data) => {
    const record = data.runs[carouselId];
    // A run may have begun meanwhile; it owns the record now.
    if (record?.state !== "running" || isGenerating(carouselId)) return;
    const result = abandonedRunResult(record, fingerprint);
    if (result) data.runs[carouselId] = { state: "interrupted", ...result };
    else delete data.runs[carouselId];
  });
}

/** True while a run for this carousel has not ended. */
export function isGenerating(carouselId: string): boolean {
  return registry().has(carouselId);
}

/**
 * How the carousel's last generation was interrupted, or null if it was not.
 * A generating carousel reports null; its run has not ended yet.
 */
export async function getInterruption(carouselId: string): Promise<Interruption | null> {
  if (isGenerating(carouselId)) return null;
  let data = await readDataSafe<RunsFile>(RUNS_FILE, emptyRuns());
  if (data.runs[carouselId]?.state === "running") {
    await recoverAbandonedRun(carouselId);
    if (isGenerating(carouselId)) return null;
    data = await readDataSafe<RunsFile>(RUNS_FILE, emptyRuns());
  }
  return recordedInterruption(data.runs[carouselId]);
}

/**
 * The user's confirmation that an interrupted carousel's slides are what they
 * want. Returns false, changing nothing, while a run is live.
 */
export async function acceptInterruptedSlides(carouselId: string): Promise<boolean> {
  if (isGenerating(carouselId)) return false;
  await mutateData(RUNS_FILE, emptyRuns, (data) => {
    delete data.runs[carouselId];
  });
  return true;
}

/** What the chat route answers when the carousel already has an active run. */
export const GENERATION_ALREADY_RUNNING_ERROR =
  "A generation is already running for this carousel. Wait for it to finish, or stop it, then send your message again.";

/** What the export route answers while a run is still writing slides. */
export const GENERATION_IN_PROGRESS_ERROR =
  "Slides are still being generated. Export will be available as soon as generation finishes.";

const INTERRUPTION_CAUSE: Record<InterruptionReason, string> = {
  stopped: "was stopped",
  failed: "failed",
  "timed-out": "timed out",
  "server-stopped": "was cut off when the server stopped",
};

/** What the export route answers for an interrupted carousel. */
export function interruptedExportError(reason: InterruptionReason): string {
  return (
    `The last generation ${INTERRUPTION_CAUSE[reason]} before it finished, so these slides may be incomplete. ` +
    "Ask the AI to continue, or confirm in the editor that you want to use the slides as they are."
  );
}
