/**
 * The store's cross-process guarantee, tested with real OS processes rather
 * than promises in one process: competing writers never lose an update, a
 * stale change set loses in every process but one, a process killed mid-write
 * leaves a readable production, and a run left open by a stopped process
 * waits for a person's decision.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { admitProduction } from "@/lib/video/production";
import { decodeRecord, ProductionStore } from "@/lib/video/production/store";
import { readFile } from "node:fs/promises";
import { footageProduction } from "./helpers/production-fixtures";

const HELPERS = path.resolve(__dirname, "helpers/ts-child");
const ID = "prod-footage";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cb-store-proc-"));
  const created = await new ProductionStore({ root }).create(footageProduction());
  expect(created.status).toBe("applied");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Child {
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; lines: Record<string, unknown>[]; stderr: string }>;
  kill: () => void;
  firstLine: Promise<void>;
}

function worker(job: Record<string, unknown>): Child {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--experimental-transform-types", "--import", path.join(HELPERS, "register.mjs"), path.join(HELPERS, "store-worker.mts"), JSON.stringify({ root, productionId: ID, ...job })],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  let markFirst: () => void;
  const firstLine = new Promise<void>((resolve) => (markFirst = resolve));
  child.stdout.on("data", (d) => {
    stdout += d;
    if (stdout.includes("\n")) markFirst();
  });
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; lines: Record<string, unknown>[]; stderr: string }>((resolve) =>
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        stderr,
        lines: stdout
          .split("\n")
          .filter((l) => l.trim().startsWith("{"))
          .flatMap((l) => {
            try {
              return [JSON.parse(l)];
            } catch {
              return []; // a line cut off by SIGKILL
            }
          }),
      })
    )
  );
  return { done, kill: () => child.kill("SIGKILL"), firstLine };
}

async function journal(): Promise<number[]> {
  const names = await readdir(path.join(root, ID, "journal"));
  return names.map((n) => Number(n.slice(0, 12))).sort((a, b) => a - b);
}

/**
 * Every retained record decodes, generations are contiguous (collection only
 * removes the oldest), and the newest state loads and is admitted.
 */
async function expectConsistent() {
  const generations = await journal();
  expect(generations).toEqual(Array.from({ length: generations.length }, (_, i) => generations[0] + i));
  for (const g of generations) {
    const raw = await readFile(path.join(root, ID, "journal", `${String(g).padStart(12, "0")}.json`), "utf-8");
    expect(decodeRecord(raw).ok).toBe(true);
  }
  const loaded = await new ProductionStore({ root }).load(ID);
  if (loaded.status !== "ok") throw new Error(JSON.stringify(loaded));
  expect(admitProduction(loaded.state.history.current).ok).toBe(true);
  return loaded.state;
}

describe("several processes writing one production", () => {
  it("never lose an update: every applied change is one revision, and none is overwritten", async () => {
    const startAt = Date.now() + 1_500;
    const children = Array.from({ length: 6 }, (_, w) => worker({ mode: "race", worker: w, rounds: 12, startAt }));
    const results = await Promise.all(children.map((c) => c.done));
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    const outcomes = results.flatMap((r) => r.lines);
    expect(outcomes).toHaveLength(6 * 12);

    const applied = outcomes.filter((o) => o.status === "applied");
    for (const o of outcomes.filter((o) => o.status !== "applied")) {
      expect(["conflict", "contended"]).toContain(o.status);
      if (o.status === "conflict") expect(o.reason).toBe("stale_revision");
    }
    // Each applied change produced its own revision: no two writers both "won" the same one.
    const revisions = applied.map((o) => o.revision as number);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(applied.length).toBeGreaterThan(6);

    const state = await expectConsistent();
    expect(state.history.current.revision).toBe(7 + applied.length);
    expect(state.generation).toBe(1 + applied.length);
    expect(state.history.undo).toHaveLength(Math.min(applied.length, 100));
  }, 60_000);

  it("accept exactly one of several change sets made against the same revision", async () => {
    const startAt = Date.now() + 1_500;
    const results = await Promise.all(Array.from({ length: 5 }, (_, w) => worker({ mode: "same-base", worker: w, baseRevision: 7, startAt }).done));
    const outcomes = results.map((r) => r.lines[0]);
    expect(outcomes.filter((o) => o.status === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "conflict" && o.reason === "stale_revision")).toHaveLength(4);
    const state = await expectConsistent();
    expect(state.history.current.revision).toBe(8);
  }, 60_000);
});

describe("a process killed while writing", () => {
  it("leaves the last committed state readable, every time", async () => {
    for (let round = 0; round < 5; round++) {
      const child = worker({ mode: "edit-forever", worker: round });
      await child.firstLine;
      await new Promise((r) => setTimeout(r, 150 + round * 97));
      child.kill();
      const result = await child.done;
      expect(result.signal).toBe("SIGKILL");
      const state = await expectConsistent();
      // The revision on disk is exactly the number of committed generations past creation.
      expect(state.history.current.revision).toBe(7 + state.generation - 1);
    }
    expect((await journal()).length).toBeGreaterThan(5);
  }, 60_000);
});

describe("an agent run left open by a process that stopped", () => {
  it("is reported, blocks changes, and is never kept or discarded without a decision", async () => {
    const before = await new ProductionStore({ root }).load(ID);
    if (before.status !== "ok") throw new Error("load");
    const result = await worker({ mode: "open-run-and-exit", worker: 1 }).done;
    expect(result.lines[0]).toEqual({ begun: "applied", change: "applied" });

    const store = new ProductionStore({ root });
    const loaded = await store.load(ID);
    if (loaded.status !== "ok") throw new Error("load");
    expect(loaded.state.recoveryRequired).toBe(true);
    expect(loaded.state.run).toMatchObject({ runId: "run-crashed", ownedHere: false, ownerAlive: false, changeSetIds: ["cs-agent"] });
    // The agent's edit is visible but not kept: it is still inside the open run.
    expect(loaded.state.history.current.name).toBe("Agent rename");

    const blocked = await store.apply(ID, { id: "cs-user", baseRevision: 8, at: "2026-11-04T13:00:00.000Z", by: "user", summary: "x", ops: [{ op: "renameProduction", name: "User" }] });
    expect(blocked).toMatchObject({ status: "recovery_required", runId: "run-crashed", ownerAlive: false });

    const discarded = await store.resolveInterruptedRun(ID, { runId: "run-crashed", decision: "discard", changeSetId: "cs-discard", at: "2026-11-04T13:00:00.000Z" });
    expect(discarded.status).toBe("applied");
    const after = await new ProductionStore({ root }).load(ID);
    if (after.status !== "ok") throw new Error("load");
    expect(after.state.run).toBeNull();
    expect(after.state.history.current.name).toBe(before.state.history.current.name);
  }, 60_000);
});
