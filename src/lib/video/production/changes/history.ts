/**
 * In-memory history for one production: undo, redo, labelled versions and
 * agent runs that are kept or discarded as one unit (spec 04 §7; merged
 * research 05 §4).
 *
 * History is linear and revisions only grow. Undo, redo, restoring a label
 * and discarding a run each produce a new revision whose content is an
 * earlier state, admitted through the same `commit()` as every other change,
 * so a client holding an older revision always sees a conflict rather than
 * silently writing over a restore.
 *
 * Every function returns a new history and never modifies the one passed in;
 * stored productions are deep-frozen. Persistence and cross-process
 * concurrency are later WS1 work.
 */

import type { Production } from "@/types/production";
import { admitProduction } from "../admit";
import type { InvariantContext } from "../invariants";
import { id, Issues, timestamp } from "../primitives";
import { applyChangeSet, commit, type OpenRun } from "./engine";
import type { ChangeIssue, ChangeSetResult } from "./types";

/** How many undo steps are kept; older ones are dropped. */
export const MAX_HISTORY_STEPS = 100;

export interface HistoryStep {
  label: string;
  /** Change sets folded into this step (one, or all of a kept agent run). */
  changeSetIds: string[];
  runId: string | null;
  before: Production;
  after: Production;
}

export interface ActiveRun extends OpenRun {
  /** The production when the run began; discarding restores its content. */
  base: Production;
  changeSetIds: string[];
}

export interface ProductionHistory {
  readonly current: Production;
  readonly undo: readonly HistoryStep[];
  readonly redo: readonly HistoryStep[];
  readonly labels: Readonly<Record<string, { revision: number; production: Production }>>;
  readonly run: ActiveRun | null;
}

export type HistoryResult =
  | ChangeSetResult
  | { status: "rejected"; stage: "history"; issues: ChangeIssue[] };

export interface HistoryOutcome {
  history: ProductionHistory;
  result: HistoryResult;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

const historyIssue = (path: string, message: string): HistoryResult => ({
  status: "rejected",
  stage: "history",
  issues: [{ opIndex: null, path, code: "invalid_op", message }],
});

/** Starts a history from a document, which must be admitted first. */
export function createHistory(input: unknown, context: InvariantContext = {}): { ok: true; history: ProductionHistory } | { ok: false; result: HistoryResult } {
  const admitted = admitProduction(input, context);
  if (!admitted.ok) return { ok: false, result: { status: "rejected", stage: "admission", issues: admitted.issues } };
  return { ok: true, history: { current: deepFreeze(admitted.production), undo: [], redo: [], labels: {}, run: null } };
}

function pushStep(steps: readonly HistoryStep[], step: HistoryStep): HistoryStep[] {
  return [...steps, step].slice(-MAX_HISTORY_STEPS);
}

/** Applies a change set through the funnel and records it. */
export function applyToHistory(history: ProductionHistory, changeSet: unknown, context: InvariantContext = {}): HistoryOutcome {
  const result = applyChangeSet(history.current, changeSet, { ...context, run: history.run });
  if (result.status !== "applied") return { history, result };
  const after = deepFreeze(result.production);
  const cs = changeSet as { id: string; summary: string };

  if (history.run) {
    return { history: { ...history, current: after, run: { ...history.run, changeSetIds: [...history.run.changeSetIds, cs.id] } }, result };
  }
  const step: HistoryStep = { label: cs.summary, changeSetIds: [cs.id], runId: null, before: history.current, after };
  return { history: { ...history, current: after, undo: pushStep(history.undo, step), redo: [] }, result };
}

/** Checks the id and time every restore takes, so restores are traceable and deterministic. */
function restoreArgs(args: { changeSetId: string; at: string }): HistoryResult | null {
  const issues = new Issues();
  id(issues, args.changeSetId, "changeSetId");
  timestamp(issues, args.at, "at");
  if (issues.empty) return null;
  return { status: "rejected", stage: "history", issues: issues.list.map((i) => ({ opIndex: null, path: i.path, code: "invalid_op", message: i.message })) };
}

/** Commits earlier content as the next revision. */
function restore(
  history: ProductionHistory,
  content: Production,
  args: { changeSetId: string; at: string },
  context: InvariantContext
): { ok: true; production: Production; result: HistoryResult } | { ok: false; result: HistoryResult } {
  const committed = commit(content, history.current, args.at, context);
  if (!committed.ok) return { ok: false, result: { status: "rejected", stage: "admission", issues: committed.issues } };
  const production = deepFreeze(committed.production);
  return {
    ok: true,
    production,
    result: { status: "applied", production, changeSetId: args.changeSetId, fromRevision: history.current.revision, revision: production.revision },
  };
}

function busy(history: ProductionHistory): HistoryResult | null {
  if (!history.run) return null;
  return {
    status: "conflict",
    reason: "run_in_progress",
    expectedRevision: history.current.revision,
    actualRevision: history.current.revision,
    message: "an agent run is in progress; keep or discard it first",
  };
}

export function undo(history: ProductionHistory, args: { changeSetId: string; at: string }, context: InvariantContext = {}): HistoryOutcome {
  const blocked = busy(history) ?? restoreArgs(args);
  if (blocked) return { history, result: blocked };
  const step = history.undo[history.undo.length - 1];
  if (!step) return { history, result: historyIssue("undo", "there is nothing to undo") };
  const restored = restore(history, step.before, args, context);
  if (!restored.ok) return { history, result: restored.result };
  return {
    history: { ...history, current: restored.production, undo: history.undo.slice(0, -1), redo: [...history.redo, step] },
    result: restored.result,
  };
}

export function redo(history: ProductionHistory, args: { changeSetId: string; at: string }, context: InvariantContext = {}): HistoryOutcome {
  const blocked = busy(history) ?? restoreArgs(args);
  if (blocked) return { history, result: blocked };
  const step = history.redo[history.redo.length - 1];
  if (!step) return { history, result: historyIssue("redo", "there is nothing to redo") };
  const restored = restore(history, step.after, args, context);
  if (!restored.ok) return { history, result: restored.result };
  return {
    history: { ...history, current: restored.production, undo: pushStep(history.undo, step), redo: history.redo.slice(0, -1) },
    result: restored.result,
  };
}

/** Names the current revision, e.g. "v1 sent to client". */
export function labelRevision(history: ProductionHistory, name: string): HistoryOutcome {
  const issues = new Issues();
  id(issues, name, "name");
  if (!issues.empty) return { history, result: historyIssue("name", "label names are short identifiers") };
  const labels = { ...history.labels, [name]: { revision: history.current.revision, production: history.current } };
  return {
    history: { ...history, labels },
    result: { status: "applied", production: history.current, changeSetId: name, fromRevision: history.current.revision, revision: history.current.revision },
  };
}

/** Restores a labelled version's content as the next revision; undoable like any change. */
export function restoreLabel(
  history: ProductionHistory,
  name: string,
  args: { changeSetId: string; at: string },
  context: InvariantContext = {}
): HistoryOutcome {
  const blocked = busy(history) ?? restoreArgs(args);
  if (blocked) return { history, result: blocked };
  // Own labels only: a name such as "constructor" must not resolve to an Object.prototype member.
  const label = Object.prototype.hasOwnProperty.call(history.labels, name) ? history.labels[name] : undefined;
  if (!label) return { history, result: historyIssue("name", "no version with this label") };
  const restored = restore(history, label.production, args, context);
  if (!restored.ok) return { history, result: restored.result };
  const step: HistoryStep = { label: `Restore ${name}`, changeSetIds: [args.changeSetId], runId: null, before: history.current, after: restored.production };
  return { history: { ...history, current: restored.production, undo: pushStep(history.undo, step), redo: [] }, result: restored.result };
}

/** Opens an agent run. While it is open, only its change sets are accepted. */
export function beginRun(history: ProductionHistory, run: { runId: string; scope?: string[] }): HistoryOutcome {
  const blocked = busy(history);
  if (blocked) return { history, result: blocked };
  const issues = new Issues();
  id(issues, run.runId, "runId");
  run.scope?.forEach((s, i) => id(issues, s, `scope[${i}]`));
  if (!issues.empty) return { history, result: historyIssue("runId", "run ids and scoped scene ids are short identifiers") };
  const active: ActiveRun = { runId: run.runId, scope: run.scope ? [...run.scope] : null, base: history.current, changeSetIds: [] };
  return {
    history: { ...history, run: active },
    result: { status: "applied", production: history.current, changeSetId: run.runId, fromRevision: history.current.revision, revision: history.current.revision },
  };
}

/**
 * Ends the open run. Keeping folds all of its change sets into one undo step.
 * Discarding restores the content from before the run as a new revision; a run
 * that changed nothing simply closes.
 */
export function endRun(
  history: ProductionHistory,
  args: { runId: string; decision: "keep" | "discard"; changeSetId: string; at: string },
  context: InvariantContext = {}
): HistoryOutcome {
  const run = history.run;
  if (!run || run.runId !== args.runId) return { history, result: historyIssue("runId", "no open run with this id") };
  const invalid = restoreArgs(args);
  if (invalid) return { history, result: invalid };
  const closed: ProductionHistory = { ...history, run: null };
  const unchanged = run.changeSetIds.length === 0;
  const noop: HistoryResult = { status: "applied", production: history.current, changeSetId: args.changeSetId, fromRevision: history.current.revision, revision: history.current.revision };

  if (args.decision === "keep") {
    if (unchanged) return { history: closed, result: noop };
    const step: HistoryStep = { label: `Agent run ${run.runId}`, changeSetIds: run.changeSetIds, runId: run.runId, before: run.base, after: history.current };
    return { history: { ...closed, undo: pushStep(history.undo, step), redo: [] }, result: noop };
  }

  if (unchanged) return { history: closed, result: noop };
  const restored = restore(closed, run.base, args, context);
  if (!restored.ok) return { history, result: restored.result };
  return { history: { ...closed, current: restored.production }, result: restored.result };
}
