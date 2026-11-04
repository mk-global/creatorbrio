/**
 * The durable, file-backed production store (WS1 #118).
 *
 * Every state change is computed by the existing pure engine
 * (`applyToHistory`, `undo`, `redo`, `labelRevision`, `restoreLabel`,
 * `beginRun`, `endRun`; each admits its result through `admitProduction()`)
 * and then persisted as one immutable journal record. The store adds no
 * mutation logic of its own.
 *
 * Commit protocol, for the transition from generation G to G+1:
 *
 * 1. load record G (the highest) and its documents, admitting each;
 * 2. compute the next history with the engine; a conflict or rejection ends
 *    here and writes nothing;
 * 3. write each new document to `tmp/`, fsync, and hard-link it into
 *    `snapshots/<sha256>.json`;
 * 4. write record G+1 to `tmp/`, fsync it, then hard-link it to
 *    `journal/<G+1>.json`. That link is the commit point: it fails with
 *    EEXIST if any writer, in this process or another, committed G+1 first;
 * 5. fsync the journal directory.
 *
 * A writer that loses step 4 reloads and re-runs the engine, so the change
 * set's expected revision is checked against the state it is actually
 * committed on top of; a stale one comes back as the engine's
 * `stale_revision` conflict. No lock is needed for correctness, so there is
 * no stale lock to break. An in-process mutex per production only avoids
 * pointless retries between callers in one process.
 *
 * Readers only see whole records: a record exists under its final name only
 * after it was fully written and fsynced. A crash at any point before the
 * link leaves the previous generation current; after it, the new one.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { Mutex } from "async-mutex";

import type { Production } from "@/types/production";
import { admitProduction } from "../admit";
import {
  applyToHistory,
  beginRun,
  createHistory,
  endRun,
  labelRevision,
  redo,
  restoreLabel,
  undo,
  type HistoryOutcome,
  type HistoryResult,
  type HistoryStep,
  type ProductionHistory,
} from "../changes";
import { ID_PATTERN } from "../primitives";
import { errorCode, nodeFs, type StoreFs } from "./fs";
import {
  contentHash,
  decodeRecord,
  generationFile,
  parseGenerationFile,
  referencedHashes,
  STORE_FORMAT,
  STORE_FORMAT_VERSION,
  type EventKind,
  type JournalRecord,
  type RunOwner,
  type StoredStep,
} from "./format";

// ---------------------------------------------------------------------------
// Results

/** Why the store could not complete a request. User data is never replaced. */
export type StoreFailure =
  | { status: "not_found"; productionId: string; message: string }
  | { status: "already_exists"; productionId: string; message: string }
  | { status: "invalid_request"; productionId: string | null; message: string }
  | { status: "corrupt"; productionId: string; generation: number | null; file: string; message: string }
  | { status: "unsupported_version"; productionId: string; generation: number | null; file: string; message: string }
  | { status: "io_error"; productionId: string | null; operation: string; code: string | null; message: string }
  | { status: "recovery_required"; productionId: string; runId: string; ownerAlive: boolean | null; message: string }
  | { status: "contended"; productionId: string; attempts: number; message: string };

/** The engine's own result (applied, conflict or rejected) with the generation it was decided at. */
export type MutationResult = (HistoryResult & { generation: number }) | StoreFailure;

export interface RunStatus {
  runId: string;
  startedAt: string;
  changeSetIds: string[];
  /** Begun or resumed by this store instance: its change sets are accepted. */
  ownedHere: boolean;
  /** Whether the owning process still runs; null when it cannot be known (another host). */
  ownerAlive: boolean | null;
}

export interface LoadedProduction {
  productionId: string;
  generation: number;
  history: ProductionHistory;
  run: RunStatus | null;
  /** An open run this instance does not own: nothing changes until a person resolves it. */
  recoveryRequired: boolean;
}

export type LoadResult = { status: "ok"; state: LoadedProduction } | StoreFailure;

export type ProductionSummary =
  | { productionId: string; status: "ok"; name: string; revision: number; generation: number; updatedAt: string; runId: string | null }
  | { productionId: string; status: "corrupt" | "unsupported_version" | "incomplete"; message: string };

export type ListResult = { status: "ok"; productions: ProductionSummary[] } | StoreFailure;

export interface StoreOptions {
  /** Defaults to `data/video` under the working directory (spec 07 §1). */
  root?: string;
  fs?: StoreFs;
  /** Times for store metadata (run start, record time); engine times come from callers. */
  now?: () => string;
  /** Commit attempts before reporting `contended`. */
  maxCommitAttempts?: number;
  gc?: Partial<GcOptions>;
}

export interface GcOptions {
  /** Collect every this many generations. */
  interval: number;
  /** Journal records kept, newest first; older ones are deleted. */
  journalRetain: number;
  /** Unreferenced documents and temporary files younger than this are kept. */
  graceMs: number;
}

const DEFAULT_GC: GcOptions = { interval: 16, journalRetain: 64, graceMs: 10 * 60_000 };

type RestoreArgs = { changeSetId: string; at: string };

class Abort extends Error {
  readonly failure: StoreFailure;
  constructor(failure: StoreFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

function ownerAlive(owner: RunOwner): boolean | null {
  if (owner.host !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

interface Loaded {
  generation: number;
  record: JournalRecord;
  history: ProductionHistory;
}

// ---------------------------------------------------------------------------

export class ProductionStore {
  readonly root: string;
  /** Identifies this store instance as the owner of the agent runs it begins. */
  readonly instanceId = randomUUID();
  private readonly fs: StoreFs;
  private readonly now: () => string;
  private readonly maxAttempts: number;
  private readonly gc: GcOptions;
  private readonly locks = new Map<string, Mutex>();
  /** Admitted documents by hash. Safe to share: they are immutable and named by content. */
  private readonly documents = new Map<string, Production>();
  private readonly hashes = new WeakMap<Production, { hash: string; json: string }>();

  constructor(options: StoreOptions = {}) {
    this.root = path.resolve(options.root ?? path.join(process.cwd(), "data", "video"));
    this.fs = options.fs ?? nodeFs;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxAttempts = options.maxCommitAttempts ?? 8;
    this.gc = { ...DEFAULT_GC, ...options.gc };
  }

  // -- paths ---------------------------------------------------------------

  private dir(productionId: string, ...parts: string[]): string {
    return path.join(this.root, productionId, ...parts);
  }

  private lock(productionId: string): Mutex {
    let mutex = this.locks.get(productionId);
    if (!mutex) this.locks.set(productionId, (mutex = new Mutex()));
    return mutex;
  }

  // -- public API ------------------------------------------------------------

  /** Admits a new production and stores it as generation 1. */
  async create(input: unknown): Promise<MutationResult> {
    const created = createHistory(input);
    if (!created.ok) return { ...created.result, generation: 0 };
    const history = created.history;
    const productionId = history.current.id;
    return this.guard(productionId, () =>
      this.lock(productionId).runExclusive(async () => {
        for (const sub of ["journal", "snapshots", "tmp"]) await this.io(productionId, "mkdir", () => this.fs.mkdirp(this.dir(productionId, sub)));
        await this.io(productionId, "sync", () => this.fs.syncDir(this.root));
        await this.io(productionId, "sync", () => this.fs.syncDir(this.dir(productionId)));
        const record = this.encode(productionId, history, 1, "create", productionId, null);
        const committed = await this.commit(productionId, record.record, record.documents);
        if (!committed) throw new Abort({ status: "already_exists", productionId, message: "a production with this id already exists" });
        const p = history.current;
        return { status: "applied", production: p, changeSetId: productionId, fromRevision: p.revision, revision: p.revision, generation: 1 };
      })
    );
  }

  async load(productionId: string): Promise<LoadResult> {
    return this.guard(productionId, async () => {
      const loaded = await this.readCurrent(productionId);
      return { status: "ok", state: this.describe(productionId, loaded) };
    });
  }

  /** Lists productions; one unreadable production is reported, not fatal. */
  async list(): Promise<ListResult> {
    let entries: string[];
    try {
      entries = await this.fs.readdir(this.root);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { status: "ok", productions: [] };
      return { status: "io_error", productionId: null, operation: "readdir", code: errorCode(error), message: String(error) };
    }
    const productions: ProductionSummary[] = [];
    for (const productionId of entries.filter((e) => ID_PATTERN.test(e)).sort()) {
      try {
        const generations = await this.generations(productionId);
        if (generations.length === 0) {
          productions.push({ productionId, status: "incomplete", message: "creation did not finish; no state was committed" });
          continue;
        }
        const generation = generations[generations.length - 1];
        const record = await this.readRecord(productionId, generation);
        productions.push({
          productionId,
          status: "ok",
          name: record.name,
          revision: record.revision,
          generation,
          updatedAt: record.at,
          runId: record.run?.runId ?? null,
        });
      } catch (error) {
        if (error instanceof Abort && (error.failure.status === "corrupt" || error.failure.status === "unsupported_version")) {
          productions.push({ productionId, status: error.failure.status, message: error.failure.message });
        } else if (error instanceof Abort && error.failure.status === "not_found") {
          continue; // not a production directory
        } else {
          return error instanceof Abort ? error.failure : this.ioFailure(productionId, "list", error).failure;
        }
      }
    }
    return { status: "ok", productions };
  }

  apply(productionId: string, changeSet: unknown): Promise<MutationResult> {
    const csId = typeof (changeSet as { id?: unknown })?.id === "string" ? (changeSet as { id: string }).id : "change";
    return this.mutate(productionId, "change", csId, (h) => applyToHistory(h, changeSet));
  }

  undo(productionId: string, args: RestoreArgs): Promise<MutationResult> {
    return this.mutate(productionId, "undo", args.changeSetId, (h) => undo(h, args));
  }

  redo(productionId: string, args: RestoreArgs): Promise<MutationResult> {
    return this.mutate(productionId, "redo", args.changeSetId, (h) => redo(h, args));
  }

  label(productionId: string, name: string): Promise<MutationResult> {
    return this.mutate(productionId, "label", name, (h) => labelRevision(h, name));
  }

  restoreLabel(productionId: string, name: string, args: RestoreArgs): Promise<MutationResult> {
    return this.mutate(productionId, "restore_label", args.changeSetId, (h) => restoreLabel(h, name, args));
  }

  /** Opens an agent run owned by this store instance. */
  beginRun(productionId: string, run: { runId: string; scope?: string[] }): Promise<MutationResult> {
    return this.mutate(productionId, "begin_run", run.runId, (h) => beginRun(h, run), { takeRun: true });
  }

  endRun(productionId: string, args: { runId: string; decision: "keep" | "discard"; changeSetId: string; at: string }): Promise<MutationResult> {
    return this.mutate(productionId, "end_run", args.runId, (h) => endRun(h, args));
  }

  /**
   * A person's explicit decision about a run this instance does not own, for
   * example one left open by a process that stopped. The run is never kept,
   * discarded or continued automatically: `resume` makes this instance its
   * owner, and `keep` or `discard` end it exactly as `endRun` does.
   */
  resolveInterruptedRun(
    productionId: string,
    args: { runId: string; decision: "keep" | "discard" | "resume"; changeSetId: string; at: string }
  ): Promise<MutationResult> {
    const notThisRun = (h: ProductionHistory): HistoryOutcome | null =>
      h.run?.runId === args.runId
        ? null
        : { history: h, result: { status: "rejected", stage: "history", issues: [{ opIndex: null, path: "runId", code: "invalid_op", message: "no open run with this id" }] } };
    if (args.decision === "resume") {
      return this.mutate(productionId, "resume_run", args.runId, (h) => notThisRun(h) ?? { history: { ...h }, result: noChange(h, args.changeSetId) }, {
        foreignRunAllowed: true,
        takeRun: true,
      });
    }
    const decision = args.decision;
    return this.mutate(productionId, "end_run", args.runId, (h) => notThisRun(h) ?? endRun(h, { ...args, decision }), { foreignRunAllowed: true });
  }

  /**
   * Explicit recovery when the newest record, or a document it names, cannot
   * be read. The state of an earlier, intact generation is committed as a new
   * generation; the damaged files are copied to `quarantine/` and kept. It is
   * refused when the newest record is readable or from a newer CreatorBrio.
   */
  async recover(productionId: string, args: { fromGeneration: number }): Promise<MutationResult> {
    return this.guard(productionId, () =>
      this.lock(productionId).runExclusive(async () => {
        const generations = await this.generations(productionId);
        if (generations.length === 0) throw new Abort({ status: "not_found", productionId, message: "no production with this id" });
        const latest = generations[generations.length - 1];
        try {
          await this.readCurrent(productionId);
          throw new Abort({ status: "invalid_request", productionId, message: "the current state is readable; there is nothing to recover" });
        } catch (error) {
          if (!(error instanceof Abort) || error.failure.status !== "corrupt") throw error;
        }
        if (!generations.includes(args.fromGeneration) || args.fromGeneration >= latest) {
          throw new Abort({ status: "invalid_request", productionId, message: "recover from an earlier generation that still exists" });
        }
        const source = await this.readRecord(productionId, args.fromGeneration);
        const history = await this.materialize(productionId, source);
        await this.quarantine(productionId, latest);
        const record: JournalRecord = { ...source, generation: latest + 1, at: this.now(), event: { kind: "recover", id: `g${args.fromGeneration}` } };
        if (!(await this.commit(productionId, record, new Map()))) {
          throw new Abort({ status: "contended", productionId, attempts: 1, message: "another writer changed the production during recovery" });
        }
        const p = history.current;
        return { status: "applied", production: p, changeSetId: record.event.id, fromRevision: p.revision, revision: p.revision, generation: record.generation };
      })
    );
  }

  // -- reading ---------------------------------------------------------------

  private async generations(productionId: string): Promise<number[]> {
    let names: string[];
    try {
      names = await this.fs.readdir(this.dir(productionId, "journal"));
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") throw new Abort({ status: "not_found", productionId, message: "no production with this id" });
      throw error;
    }
    return names
      .map(parseGenerationFile)
      .filter((g): g is number => g !== null)
      .sort((a, b) => a - b);
  }

  private async readRecord(productionId: string, generation: number): Promise<JournalRecord> {
    const file = this.dir(productionId, "journal", generationFile(generation));
    const raw = await this.io(productionId, "read", () => this.fs.readFile(file));
    const decoded = decodeRecord(raw.toString("utf-8"));
    if (!decoded.ok) throw new Abort({ status: decoded.kind, productionId, generation, file, message: decoded.message });
    if (decoded.record.productionId !== productionId || decoded.record.generation !== generation) {
      throw new Abort({ status: "corrupt", productionId, generation, file, message: "the record does not belong at this path" });
    }
    return decoded.record;
  }

  private async document(productionId: string, hash: string, generation: number): Promise<Production> {
    const cached = this.documents.get(hash);
    if (cached) return cached;
    const file = this.dir(productionId, "snapshots", `${hash}.json`);
    let raw: string;
    try {
      raw = (await this.fs.readFile(file)).toString("utf-8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Abort({ status: "corrupt", productionId, generation, file, message: "a document the record names is missing" });
      throw error;
    }
    if (contentHash(raw) !== hash) throw new Abort({ status: "corrupt", productionId, generation, file, message: "a document does not match its content hash" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Abort({ status: "corrupt", productionId, generation, file, message: "a document is not valid JSON" });
    }
    const admitted = admitProduction(parsed);
    if (!admitted.ok) {
      const tooNew = admitted.issues.some((i) => i.code === "schema_version_too_new");
      const first = admitted.issues[0];
      throw new Abort({
        status: tooNew ? "unsupported_version" : "corrupt",
        productionId,
        generation,
        file,
        message: tooNew ? "a document's schema version is newer than this CreatorBrio supports" : `a document is not an admissible production: ${first.path}: ${first.message}`,
      });
    }
    const production = deepFreeze(admitted.production);
    if (admitted.migratedFrom === null) this.hashes.set(production, { hash, json: raw });
    if (this.documents.size > 4_096) this.documents.clear();
    this.documents.set(hash, production);
    return production;
  }

  /** Rebuilds the engine's history from a record, admitting every document. */
  private async materialize(productionId: string, record: JournalRecord): Promise<ProductionHistory> {
    const doc = (hash: string) => this.document(productionId, hash, record.generation);
    const step = async (s: StoredStep): Promise<HistoryStep> => ({ ...s, changeSetIds: [...s.changeSetIds], before: await doc(s.before), after: await doc(s.after) });
    const current = await doc(record.current);
    if (current.id !== productionId || current.revision !== record.revision) {
      throw new Abort({ status: "corrupt", productionId, generation: record.generation, file: generationFile(record.generation), message: "the current document does not match its record" });
    }
    const labels: Record<string, { revision: number; production: Production }> = {};
    for (const l of record.labels) labels[l.name] = { revision: l.revision, production: await doc(l.production) };
    const undoSteps: HistoryStep[] = [];
    for (const s of record.undo) undoSteps.push(await step(s));
    const redoSteps: HistoryStep[] = [];
    for (const s of record.redo) redoSteps.push(await step(s));
    const run = record.run && { runId: record.run.runId, scope: record.run.scope && [...record.run.scope], base: await doc(record.run.base), changeSetIds: [...record.run.changeSetIds] };
    return { current, undo: undoSteps, redo: redoSteps, labels, run };
  }

  private async readCurrent(productionId: string): Promise<Loaded> {
    const generations = await this.generations(productionId);
    if (generations.length === 0) throw new Abort({ status: "not_found", productionId, message: "no production with this id" });
    const generation = generations[generations.length - 1];
    const record = await this.readRecord(productionId, generation);
    return { generation, record, history: await this.materialize(productionId, record) };
  }

  private describe(productionId: string, loaded: Loaded): LoadedProduction {
    const run = loaded.record.run;
    const ownedHere = run?.owner.instance === this.instanceId;
    const status: RunStatus | null = run && {
      runId: run.runId,
      startedAt: run.startedAt,
      changeSetIds: [...run.changeSetIds],
      ownedHere,
      ownerAlive: ownedHere ? true : ownerAlive(run.owner),
    };
    return { productionId, generation: loaded.generation, history: loaded.history, run: status, recoveryRequired: !!run && !ownedHere };
  }

  // -- writing ---------------------------------------------------------------

  private async mutate(
    productionId: string,
    kind: EventKind,
    eventId: string,
    step: (history: ProductionHistory) => HistoryOutcome,
    options: { foreignRunAllowed?: boolean; takeRun?: boolean } = {}
  ): Promise<MutationResult> {
    if (!ID_PATTERN.test(productionId)) return { status: "invalid_request", productionId: null, message: "production ids are short identifiers" };
    return this.guard(productionId, () =>
      this.lock(productionId).runExclusive(async () => {
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
          const loaded = await this.readCurrent(productionId);
          const state = this.describe(productionId, loaded);
          if (state.recoveryRequired && !options.foreignRunAllowed) {
            const run = state.run!;
            return {
              status: "recovery_required",
              productionId,
              runId: run.runId,
              ownerAlive: run.ownerAlive,
              message:
                run.ownerAlive === true
                  ? "another process owns an open agent run on this production"
                  : "an agent run was left open by a process that stopped; a person must keep, discard or resume it",
            };
          }
          if (options.foreignRunAllowed && !state.recoveryRequired) {
            return { status: "invalid_request", productionId, message: "there is no interrupted run to resolve; use the run's own owner" };
          }

          const outcome = step(loaded.history);
          if (outcome.result.status !== "applied" || outcome.history === loaded.history) {
            return { ...outcome.result, generation: loaded.generation };
          }
          const keepOwner = !options.takeRun && loaded.record.run?.runId === outcome.history.run?.runId ? loaded.record.run : null;
          const { record, documents } = this.encode(productionId, outcome.history, loaded.generation + 1, kind, eventId, keepOwner, loaded.record);
          if (await this.commit(productionId, record, documents)) {
            return { ...outcome.result, generation: record.generation };
          }
          // Another writer committed this generation first: decide again on top of its state.
        }
        return { status: "contended", productionId, attempts: this.maxAttempts, message: "other writers kept committing first; retry" };
      })
    );
  }

  private hashOf(production: Production): { hash: string; json: string } {
    let entry = this.hashes.get(production);
    if (!entry) {
      const json = JSON.stringify(production);
      entry = { hash: contentHash(json), json };
      this.hashes.set(production, entry);
    }
    return entry;
  }

  /** Converts a history to its record, collecting the documents the previous record did not already name. */
  private encode(
    productionId: string,
    history: ProductionHistory,
    generation: number,
    kind: EventKind,
    eventId: string,
    keepRun: JournalRecord["run"],
    previous?: JournalRecord
  ): { record: JournalRecord; documents: Map<string, string> } {
    const documents = new Map<string, string>();
    const ref = (p: Production) => {
      const { hash, json } = this.hashOf(p);
      documents.set(hash, json);
      return hash;
    };
    const step = (s: HistoryStep): StoredStep => ({ label: s.label, changeSetIds: [...s.changeSetIds], runId: s.runId, before: ref(s.before), after: ref(s.after) });
    const run = history.run;
    const record: JournalRecord = {
      format: STORE_FORMAT,
      formatVersion: STORE_FORMAT_VERSION,
      productionId,
      generation,
      at: this.now(),
      event: { kind, id: ID_PATTERN.test(eventId) ? eventId : kind.replace(/_/g, "-") },
      name: history.current.name,
      revision: history.current.revision,
      current: ref(history.current),
      undo: history.undo.map(step),
      redo: history.redo.map(step),
      labels: Object.entries(history.labels).map(([name, l]) => ({ name, revision: l.revision, production: ref(l.production) })),
      run: run && {
        runId: run.runId,
        scope: run.scope && [...run.scope],
        base: ref(run.base),
        changeSetIds: [...run.changeSetIds],
        owner: keepRun?.owner ?? { instance: this.instanceId, pid: process.pid, host: hostname() },
        startedAt: keepRun?.startedAt ?? this.now(),
      },
    };
    if (previous) for (const hash of referencedHashes(previous)) documents.delete(hash);
    return { record, documents };
  }

  /** Steps 3 to 5 of the protocol. Returns false when another writer committed this generation first. */
  private async commit(productionId: string, record: JournalRecord, documents: Map<string, string>): Promise<boolean> {
    const fs = this.fs;
    for (const [hash, json] of documents) await this.putDocument(productionId, hash, json);
    if (documents.size > 0) await this.io(productionId, "sync", () => fs.syncDir(this.dir(productionId, "snapshots")));

    const tmp = this.dir(productionId, "tmp", `${randomUUID()}.json`);
    const target = this.dir(productionId, "journal", generationFile(record.generation));
    await this.io(productionId, "write", () => fs.writeNewFileDurable(tmp, JSON.stringify(record)));
    try {
      await fs.link(tmp, target);
    } catch (error) {
      await fs.unlink(tmp).catch(() => undefined);
      if (errorCode(error) === "EEXIST") return false;
      throw this.ioFailure(productionId, "link", error);
    }
    await this.io(productionId, "sync", () => fs.syncDir(this.dir(productionId, "journal")));
    await fs.unlink(tmp).catch(() => undefined);
    if (record.generation % this.gc.interval === 0) await this.collect(productionId).catch(() => undefined);
    return true;
  }

  /** Stores a document under its content hash. An existing file is kept and its time refreshed, so collection skips it. */
  private async putDocument(productionId: string, hash: string, json: string): Promise<void> {
    const fs = this.fs;
    const target = this.dir(productionId, "snapshots", `${hash}.json`);
    try {
      await fs.touch(target);
      return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw this.ioFailure(productionId, "touch", error);
    }
    const tmp = this.dir(productionId, "tmp", `${randomUUID()}.json`);
    await this.io(productionId, "write", () => fs.writeNewFileDurable(tmp, json));
    try {
      await fs.link(tmp, target);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        await fs.unlink(tmp).catch(() => undefined);
        throw this.ioFailure(productionId, "link", error);
      }
      await this.io(productionId, "touch", () => fs.touch(target));
    }
    await fs.unlink(tmp).catch(() => undefined);
  }

  /** Copies the newest record and any damaged document it names to `quarantine/`, removing the damaged documents. */
  private async quarantine(productionId: string, generation: number): Promise<void> {
    const fs = this.fs;
    const dir = this.dir(productionId, "quarantine");
    await this.io(productionId, "mkdir", () => fs.mkdirp(dir));
    const recordFile = this.dir(productionId, "journal", generationFile(generation));
    const raw = await this.io(productionId, "read", () => fs.readFile(recordFile));
    await this.io(productionId, "write", () => fs.writeNewFileDurable(path.join(dir, `journal-${generationFile(generation)}.${randomUUID()}`), raw.toString("utf-8")));
    const decoded = decodeRecord(raw.toString("utf-8"));
    if (!decoded.ok) return;
    for (const hash of new Set(referencedHashes(decoded.record))) {
      const file = this.dir(productionId, "snapshots", `${hash}.json`);
      let data: Buffer;
      try {
        data = await fs.readFile(file);
      } catch {
        continue;
      }
      if (contentHash(data.toString("utf-8")) === hash) continue;
      await this.io(productionId, "write", () => fs.writeNewFileDurable(path.join(dir, `snapshot-${hash}.${randomUUID()}`), data.toString("utf-8")));
      this.documents.delete(hash);
      await this.io(productionId, "unlink", () => fs.unlink(file));
    }
    await this.io(productionId, "sync", () => fs.syncDir(dir));
  }

  /**
   * Bounds disk use: deletes journal records outside the retention window, and
   * documents and temporary files no retained record names that are older
   * than the grace period. If any retained record cannot be read, documents
   * are left alone.
   */
  private async collect(productionId: string): Promise<void> {
    const fs = this.fs;
    const generations = await this.generations(productionId);
    const keep = generations.slice(-this.gc.journalRetain);
    for (const g of generations.slice(0, -this.gc.journalRetain)) await fs.unlink(this.dir(productionId, "journal", generationFile(g))).catch(() => undefined);

    const cutoff = Date.now() - this.gc.graceMs;
    const old = async (file: string) => (await fs.mtimeMs(file).catch(() => Infinity)) < cutoff;
    for (const name of await fs.readdir(this.dir(productionId, "tmp"))) {
      const file = this.dir(productionId, "tmp", name);
      if (await old(file)) await fs.unlink(file).catch(() => undefined);
    }

    const referenced = new Set<string>();
    for (const g of keep) {
      const record = await this.readRecord(productionId, g).catch(() => null);
      if (!record) return;
      for (const hash of referencedHashes(record)) referenced.add(hash);
    }
    for (const name of await fs.readdir(this.dir(productionId, "snapshots"))) {
      const hash = name.replace(/\.json$/, "");
      const file = this.dir(productionId, "snapshots", name);
      if (!referenced.has(hash) && (await old(file))) await fs.unlink(file).catch(() => undefined);
    }
  }

  // -- error plumbing ----------------------------------------------------------

  private ioFailure(productionId: string | null, operation: string, error: unknown): Abort {
    return new Abort({ status: "io_error", productionId, operation, code: errorCode(error), message: error instanceof Error ? error.message : String(error) });
  }

  private async io<T>(productionId: string, operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Abort) throw error;
      throw this.ioFailure(productionId, operation, error);
    }
  }

  private async guard<T>(productionId: string, run: () => Promise<T>): Promise<T | StoreFailure> {
    if (!ID_PATTERN.test(productionId)) return { status: "invalid_request", productionId: null, message: "production ids are short identifiers" };
    try {
      return await run();
    } catch (error) {
      if (error instanceof Abort) return error.failure;
      return this.ioFailure(productionId, "unknown", error).failure;
    }
  }
}

function noChange(h: ProductionHistory, changeSetId: string): HistoryResult {
  return { status: "applied", production: h.current, changeSetId, fromRevision: h.current.revision, revision: h.current.revision };
}
