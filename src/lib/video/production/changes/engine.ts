/**
 * The one mutation funnel for Production v2 (spec 07 §6; WS1 #78, #114).
 *
 * `applyChangeSet()` takes the current production and an untrusted change set
 * and returns either the next production or why not. It is pure and atomic:
 *
 * 1. the change set is checked strictly (`validate.ts`);
 * 2. its base revision must equal the production's revision;
 * 3. agent changes must belong to the open agent run, and actor rules apply;
 * 4. every operation is applied, in order, to a private copy;
 * 5. the engine stamps the server-owned fields (revision, update time);
 * 6. the guards check locked, approved and out-of-scope scenes (`scope.ts`);
 * 7. the whole result is admitted with `admitProduction()`.
 *
 * Any failure discards the copy: the caller's production is never modified,
 * and nothing is published that was not admitted. `commit()` is the shared
 * last step, also used by history restores, so every state transition passes
 * through admission.
 */

import type { Production } from "@/types/production";
import { admitProduction } from "../admit";
import type { InvariantContext } from "../invariants";
import type { AdmissionIssue } from "../primitives";
import { applyOp, OpFailure, type ApplyState } from "./apply";
import { checkProtectedScenes, checkScope } from "./scope";
import type { Actor, ChangeIssue, ChangeSet, ChangeSetResult, ProductionOp } from "./types";
import { validateChangeSet } from "./validate";

/** An agent run in progress: only its own change sets may be applied until it ends. */
export interface OpenRun {
  runId: string;
  scope: string[] | null;
}

export interface ApplyOptions extends InvariantContext {
  run?: OpenRun | null;
}

/** Statuses only a person may set (spec 04 §3: approval is the creator's). */
const PERSON_ONLY_STATUSES = new Set(["approved", "final", "locked", "rejected", "changes_requested"]);
/** Operations an agent may not perform: approvals, stage gates, removing media, recording realisation. */
const NOT_FOR_AGENTS = new Set<ProductionOp["op"]>(["setStage", "removeMedia", "setSceneRealization"]);

function actorIssues(ops: ProductionOp[], by: Actor): ChangeIssue[] {
  const issues: ChangeIssue[] = [];
  ops.forEach((op, i) => {
    const path = `ops[${i}]`;
    if (by === "agent" && NOT_FOR_AGENTS.has(op.op)) {
      issues.push({ opIndex: i, path, code: "forbidden", message: `${op.op} is reserved for the person editing or the system` });
    }
    if (by !== "user" && op.op === "setSceneStatus" && PERSON_ONLY_STATUSES.has(op.status)) {
      issues.push({ opIndex: i, path: `${path}.status`, code: "forbidden", message: `only a person can mark a scene ${op.status}` });
    }
    if (by !== "user" && op.op === "setScriptStatus" && op.status === "approved") {
      issues.push({ opIndex: i, path: `${path}.status`, code: "forbidden", message: "only a person can approve the script" });
    }
  });
  return issues;
}

/**
 * Stamps the server-owned fields on a candidate and admits it. The only way a
 * new production state is produced.
 */
export function commit(
  candidate: Production,
  from: Production,
  at: string,
  context: InvariantContext
): { ok: true; production: Production } | { ok: false; issues: AdmissionIssue[] } {
  const next = { ...candidate, revision: from.revision + 1, updatedAt: at };
  const admitted = admitProduction(next, context);
  return admitted.ok ? { ok: true, production: admitted.production } : { ok: false, issues: admitted.issues };
}

export function applyChangeSet(production: Production, input: unknown, options: ApplyOptions = {}): ChangeSetResult {
  const valid = validateChangeSet(input);
  if (!valid.ok) return { status: "rejected", stage: "change_set", issues: valid.issues };
  const cs: ChangeSet = valid.changeSet;

  const conflict = (reason: "stale_revision" | "run_in_progress" | "no_open_run", message: string): ChangeSetResult => ({
    status: "conflict",
    reason,
    expectedRevision: cs.baseRevision,
    actualRevision: production.revision,
    message,
  });
  if (cs.baseRevision !== production.revision) {
    return conflict("stale_revision", `the change was made against revision ${cs.baseRevision}, but the production is at revision ${production.revision}`);
  }
  const run = options.run ?? null;
  if (run && cs.runId !== run.runId) return conflict("run_in_progress", "an agent run is in progress; only its own changes are accepted until it ends");
  if (!run && cs.runId !== undefined) return conflict("no_open_run", "this change names an agent run that is not open");
  if (cs.by === "agent" && cs.runId === undefined) {
    return { status: "rejected", stage: "change_set", issues: [{ opIndex: null, path: "runId", code: "forbidden", message: "agent changes must belong to an agent run" }] };
  }

  const actor = actorIssues(cs.ops, cs.by);
  if (actor.length > 0) return { status: "rejected", stage: "operations", issues: actor };

  let scope: Set<string> | null = cs.scope ? new Set(cs.scope.sceneIds) : null;
  if (run?.scope) {
    const runScope = new Set(run.scope);
    if (scope && [...scope].some((id) => !runScope.has(id))) {
      return { status: "rejected", stage: "scope", issues: [{ opIndex: null, path: "scope", code: "out_of_scope", message: "a change may narrow its run's scope, not widen it" }] };
    }
    scope ??= runScope;
  }

  const state: ApplyState = { draft: JSON.parse(JSON.stringify(production)) as Production, changeSet: cs, revision: production.revision + 1 };
  for (let i = 0; i < cs.ops.length; i++) {
    try {
      applyOp(state, cs.ops[i], `ops[${i}]`);
    } catch (error) {
      if (!(error instanceof OpFailure)) throw error;
      return { status: "rejected", stage: "operations", issues: [{ opIndex: i, path: error.path, code: error.code, message: error.message }] };
    }
  }

  const guard = [...checkProtectedScenes(production, state.draft, cs.by, scope), ...(scope ? checkScope(production, state.draft, scope) : [])];
  if (guard.length > 0) return { status: "rejected", stage: "scope", issues: guard };

  const committed = commit(state.draft, production, cs.at, options);
  if (!committed.ok) return { status: "rejected", stage: "admission", issues: committed.issues };
  return { status: "applied", production: committed.production, changeSetId: cs.id, fromRevision: production.revision, revision: committed.production.revision };
}
