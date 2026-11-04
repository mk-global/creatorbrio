import { describe, it, expect } from "vitest";

import { admitProduction } from "@/lib/video/production";
import {
  applyToHistory,
  beginRun,
  createHistory,
  endRun,
  labelRevision,
  MAX_HISTORY_STEPS,
  redo,
  restoreLabel,
  undo,
  type HistoryOutcome,
  type ProductionHistory,
} from "@/lib/video/production/changes";
import type { Production } from "@/types/production";
import { footageProduction, hybridProduction, scriptProduction } from "./helpers/production-fixtures";

let clock = 0;
/** A distinct, increasing timestamp for each step, so every revision is traceable. */
const tick = () => new Date(Date.UTC(2026, 10, 4, 12, 0, clock++)).toISOString();

/** Content without the revision counter and update time, which every transition advances. */
const content = (p: Production) => JSON.stringify({ ...p, revision: undefined, updatedAt: undefined });

function start(doc: Production = footageProduction()): ProductionHistory {
  const created = createHistory(doc);
  if (!created.ok) throw new Error(JSON.stringify(created.result));
  return created.history;
}

function ok(outcome: HistoryOutcome): ProductionHistory {
  if (outcome.result.status !== "applied") throw new Error(JSON.stringify(outcome.result, null, 1));
  expect(admitProduction(outcome.history.current).ok).toBe(true);
  return outcome.history;
}

let n = 0;
function change(h: ProductionHistory, ops: unknown[], extra: Record<string, unknown> = {}) {
  return applyToHistory(h, { id: `cs-${n++}`, baseRevision: h.current.revision, at: tick(), by: "user", summary: "edit", ops, ...extra });
}
const rename = (h: ProductionHistory, name: string) => change(h, [{ op: "renameProduction", name }]);
const restoreArgs = () => ({ changeSetId: `cs-${n++}`, at: tick() });

// ---------------------------------------------------------------------------

describe("history starts from an admitted production", () => {
  it("refuses an invalid document", () => {
    const created = createHistory({ ...footageProduction(), revision: -1 });
    expect(created.ok).toBe(false);
  });

  it("stores frozen productions that callers cannot change", () => {
    const h = start();
    expect(Object.isFrozen(h.current)).toBe(true);
    expect(Object.isFrozen(h.current.timeline.tracks[0].clips[0])).toBe(true);
  });
});

describe("undo and redo restore complete documents", () => {
  it("replays a sequence forwards and backwards exactly, with revisions that only grow", () => {
    let h = start(hybridProduction());
    const states = [content(h.current)];
    const revisions = [h.current.revision];
    h = ok(rename(h, "One"));
    states.push(content(h.current));
    h = ok(change(h, [{ op: "trimClip", clipId: "hx-click", edge: "out", toFrame: 72 }]));
    states.push(content(h.current));
    h = ok(change(h, [{ op: "addMarker", marker: { id: "mk-1", fromFrame: 0, toFrame: 3, note: "Start", kind: "note" } }]));
    states.push(content(h.current));
    revisions.push(h.current.revision);

    for (let i = states.length - 2; i >= 0; i--) {
      h = ok(undo(h, restoreArgs()));
      expect(content(h.current)).toBe(states[i]);
      revisions.push(h.current.revision);
    }
    for (let i = 1; i < states.length; i++) {
      h = ok(redo(h, restoreArgs()));
      expect(content(h.current)).toBe(states[i]);
      revisions.push(h.current.revision);
    }
    for (let i = 1; i < revisions.length; i++) expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
  });

  it("makes an older client conflict after an undo", () => {
    let h = ok(rename(start(), "One"));
    const stale = h.current.revision;
    h = ok(undo(h, restoreArgs()));
    const outcome = applyToHistory(h, { id: "cs-old", baseRevision: stale, at: tick(), by: "user", summary: "late", ops: [{ op: "renameProduction", name: "Late" }] });
    expect(outcome.result).toMatchObject({ status: "conflict", reason: "stale_revision" });
    expect(outcome.history).toBe(h);
  });

  it("clears redo when a new change is made", () => {
    let h = ok(rename(start(), "One"));
    h = ok(undo(h, restoreArgs()));
    expect(h.redo).toHaveLength(1);
    h = ok(rename(h, "Two"));
    expect(h.redo).toHaveLength(0);
    expect(redo(h, restoreArgs()).result).toMatchObject({ status: "rejected", stage: "history" });
  });

  it("refuses to undo with nothing to undo, or with malformed arguments", () => {
    const h = start();
    expect(undo(h, restoreArgs()).result).toMatchObject({ status: "rejected", stage: "history" });
    const h2 = ok(rename(h, "One"));
    expect(undo(h2, { changeSetId: "../x", at: tick() }).result).toMatchObject({ status: "rejected", stage: "history" });
    expect(undo(h2, { changeSetId: "cs-x", at: "later" }).result).toMatchObject({ status: "rejected", stage: "history" });
  });

  it("leaves history untouched when a change is rejected", () => {
    const h = ok(rename(start(), "One"));
    const outcome = change(h, [{ op: "removeMarker", markerId: "ghost" }]);
    expect(outcome.result.status).toBe("rejected");
    expect(outcome.history).toBe(h);
  });

  it("never modifies an earlier history value", () => {
    const h0 = start();
    const before = JSON.stringify(h0);
    ok(rename(h0, "One"));
    expect(JSON.stringify(h0)).toBe(before);
  });

  it("keeps a bounded number of undo steps", () => {
    let h = start();
    for (let i = 0; i < MAX_HISTORY_STEPS + 5; i++) h = ok(rename(h, `Name ${i}`));
    expect(h.undo).toHaveLength(MAX_HISTORY_STEPS);
  });
});

describe("labelled versions", () => {
  it("restores a labelled version as a new, undoable revision", () => {
    let h = start(scriptProduction());
    h = ok(labelRevision(h, "v1-sent"));
    const labelled = content(h.current);
    h = ok(rename(h, "Draft two"));
    h = ok(restoreLabel(h, "v1-sent", restoreArgs()));
    expect(content(h.current)).toBe(labelled);
    h = ok(undo(h, restoreArgs()));
    expect(h.current.name).toBe("Draft two");
    expect(restoreLabel(h, "missing", restoreArgs()).result).toMatchObject({ status: "rejected", stage: "history" });
  });
});

describe("an agent run is kept or discarded as one unit", () => {
  const agent = (h: ProductionHistory, ops: unknown[]) =>
    applyToHistory(h, { id: `cs-${n++}`, baseRevision: h.current.revision, at: tick(), by: "agent", runId: "run-1", summary: "agent edit", ops });

  it("keeps a run as one undo step", () => {
    let h = ok(rename(start(hybridProduction()), "Before the run"));
    const beforeRun = content(h.current);
    h = ok(beginRun(h, { runId: "run-1" }));
    h = ok(agent(h, [{ op: "trimClip", clipId: "hx-click", edge: "out", toFrame: 72 }]));
    h = ok(agent(h, [{ op: "addMarker", marker: { id: "mk-a", fromFrame: 0, toFrame: 3, note: "Agent note", kind: "note" } }]));
    h = ok(endRun(h, { runId: "run-1", decision: "keep", ...restoreArgs() }));
    expect(h.run).toBeNull();
    expect(h.undo[h.undo.length - 1]).toMatchObject({ runId: "run-1" });
    expect(h.undo[h.undo.length - 1].changeSetIds).toHaveLength(2);
    h = ok(undo(h, restoreArgs()));
    expect(content(h.current)).toBe(beforeRun);
    expect(h.current.name).toBe("Before the run");
  });

  it("discards a run, restoring the content from before it as a new revision", () => {
    let h = start(hybridProduction());
    const beforeRun = content(h.current);
    const undoDepth = h.undo.length;
    h = ok(beginRun(h, { runId: "run-1", scope: ["scene-h1"] }));
    h = ok(agent(h, [{ op: "trimClip", clipId: "hx-v1", edge: "out", toFrame: 50 }, { op: "trimClip", clipId: "hx-a1", edge: "out", toFrame: 50 }]));
    const revisionDuringRun = h.current.revision;
    h = ok(endRun(h, { runId: "run-1", decision: "discard", ...restoreArgs() }));
    expect(content(h.current)).toBe(beforeRun);
    expect(h.current.revision).toBe(revisionDuringRun + 1);
    expect(h.undo).toHaveLength(undoDepth);
  });

  it("accepts only the run's own changes while it is open", () => {
    let h = ok(rename(start(), "One"));
    h = ok(beginRun(h, { runId: "run-1" }));
    expect(rename(h, "Interloper").result).toMatchObject({ status: "conflict", reason: "run_in_progress" });
    expect(undo(h, restoreArgs()).result).toMatchObject({ status: "conflict", reason: "run_in_progress" });
    expect(beginRun(h, { runId: "run-2" }).result).toMatchObject({ status: "conflict", reason: "run_in_progress" });
    expect(endRun(h, { runId: "run-2", decision: "keep", ...restoreArgs() }).result).toMatchObject({ status: "rejected", stage: "history" });
  });

  it("enforces the run's scope on its changes", () => {
    let h = ok(beginRun(start(), { runId: "run-1", scope: ["scene-point"] }));
    expect(agent(h, [{ op: "renameProduction", name: "x" }]).result).toMatchObject({ status: "rejected", stage: "scope" });
    h = ok(agent(h, [{ op: "trimClip", clipId: "clip-b1", edge: "out", toFrame: 95 }]));
    expect(h.current.timeline.tracks[1].clips[0].duration).toBe(20);
  });

  it("closes a run that changed nothing without a new revision", () => {
    let h = start();
    const revision = h.current.revision;
    h = ok(beginRun(h, { runId: "run-1" }));
    h = ok(endRun(h, { runId: "run-1", decision: "discard", ...restoreArgs() }));
    expect(h.current.revision).toBe(revision);
    expect(h.run).toBeNull();
  });
});

describe("property: random undo, redo and edits match a simple model", () => {
  it("always shows the state the model predicts, and every revision is admitted and higher than the last", () => {
    let seed = 0x41d0;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (const build of [footageProduction, scriptProduction, hybridProduction]) {
      let h = start(build());
      // The model: a list of states and a cursor; edits drop everything after the cursor.
      let states = [content(h.current)];
      let cursor = 0;
      for (let step = 0; step < 60; step++) {
        const before = h.current.revision;
        const roll = random();
        if (roll < 0.45) {
          h = ok(rename(h, `Name ${step}`));
          states = [...states.slice(0, cursor + 1), content(h.current)];
          cursor++;
        } else if (roll < 0.75) {
          const outcome = undo(h, restoreArgs());
          if (cursor === 0) {
            expect(outcome.history).toBe(h);
            continue;
          }
          h = ok(outcome);
          cursor--;
        } else {
          const outcome = redo(h, restoreArgs());
          if (cursor === states.length - 1) {
            expect(outcome.history).toBe(h);
            continue;
          }
          h = ok(outcome);
          cursor++;
        }
        expect(content(h.current)).toBe(states[cursor]);
        expect(h.current.revision).toBe(before + 1);
      }
    }
  });
});
