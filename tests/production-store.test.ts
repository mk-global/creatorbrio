import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { admitProduction } from "@/lib/video/production";
import type { ProductionHistory } from "@/lib/video/production/changes";
import { generationFile, nodeFs, ProductionStore, type LoadedProduction, type MutationResult, type StoreFs } from "@/lib/video/production/store";
import type { LedgerMedia } from "@/lib/video/production";
import { footageProduction, hybridProduction, MEDIA, scriptProduction } from "./helpers/production-fixtures";

const ID = "prod-footage";
const NOW = () => "2026-11-04T12:00:00.000Z";
let root: string;
let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 4, 12, 0, clock++)).toISOString();

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cb-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const open = (options: Partial<ConstructorParameters<typeof ProductionStore>[0]> = {}) => new ProductionStore({ root, now: NOW, ...options });

async function loaded(store: ProductionStore, id = ID): Promise<LoadedProduction> {
  const result = await store.load(id);
  if (result.status !== "ok") throw new Error(JSON.stringify(result));
  return result.state;
}

function ok(result: MutationResult) {
  if (result.status !== "applied") throw new Error(JSON.stringify(result, null, 1));
  return result;
}

const rename = (base: number, name: string, extra: Record<string, unknown> = {}) => ({
  id: `cs-${clock}`,
  baseRevision: base,
  at: at(),
  by: "user",
  summary: `Rename to ${name}`,
  ops: [{ op: "renameProduction", name }],
  ...extra,
});

/** A comparable view of a history: content, steps, labels and run. */
function view(h: ProductionHistory) {
  const step = (s: ProductionHistory["undo"][number]) => [s.label, s.changeSetIds, s.runId, s.before.revision, s.after.revision];
  return JSON.stringify({
    current: h.current,
    undo: h.undo.map(step),
    redo: h.redo.map(step),
    labels: Object.entries(h.labels).map(([k, v]) => [k, v.revision, v.production.name]),
    run: h.run && { runId: h.run.runId, scope: h.run.scope, base: h.run.base.revision, changeSetIds: h.run.changeSetIds },
  });
}

async function files(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      out.set(path.relative(dir, file), await readFile(file, "utf-8"));
    }
  }
  return out;
}

const journalFile = (g: number, id = ID) => path.join(root, id, "journal", generationFile(g));

// ---------------------------------------------------------------------------

describe("creating, loading and listing", () => {
  it("creates productions for every workflow and lists them", async () => {
    const store = open();
    for (const doc of [footageProduction(), scriptProduction(), hybridProduction()]) {
      expect(ok(await store.create(doc)).generation).toBe(1);
    }
    const listed = await store.list();
    expect(listed).toMatchObject({
      status: "ok",
      productions: [
        { productionId: "prod-footage", status: "ok", revision: 7, generation: 1, runId: null },
        { productionId: "prod-hybrid", status: "ok", revision: 9 },
        { productionId: "prod-script", status: "ok", revision: 3 },
      ],
    });
    const state = await loaded(open(), "prod-script");
    expect(state.history.current).toEqual(scriptProduction());
  });

  it("refuses an inadmissible document and a duplicate id, writing nothing", async () => {
    const store = open();
    const bad = await store.create({ ...footageProduction(), revision: -1 });
    expect(bad).toMatchObject({ status: "rejected", stage: "admission" });
    expect(await store.list()).toEqual({ status: "ok", productions: [] });
    ok(await store.create(footageProduction()));
    expect(await store.create(footageProduction())).toMatchObject({ status: "already_exists" });
    expect(await readdir(path.join(root, ID, "journal"))).toHaveLength(1);
  });

  it("reports unknown and malformed ids as typed failures", async () => {
    const store = open();
    expect(await store.load("prod-none")).toMatchObject({ status: "not_found" });
    expect(await store.load("../etc")).toMatchObject({ status: "invalid_request" });
    expect(await store.apply("../etc", {})).toMatchObject({ status: "invalid_request" });
  });

  it("lists an interrupted creation as incomplete, and can still create it", async () => {
    await mkdir(path.join(root, ID, "journal"), { recursive: true });
    expect((await open().list()) as unknown).toMatchObject({ productions: [{ productionId: ID, status: "incomplete" }] });
    ok(await open().create(footageProduction()));
  });
});

describe("history survives close and reopen", () => {
  it("replays edits, undo, redo, labels and a kept run exactly after a restart", async () => {
    let store = open();
    ok(await store.create(hybridProduction()));
    const trace: string[] = [];
    const step = async (label: string, result: Promise<MutationResult>) => {
      ok(await result);
      const before = view((await loaded(store, "prod-hybrid")).history);
      store = open(); // a restart after every step
      expect(view((await loaded(store, "prod-hybrid")).history)).toBe(before);
      const state = await loaded(store, "prod-hybrid");
      trace.push(`${label}: generation ${state.generation}, revision ${state.history.current.revision}, undo ${state.history.undo.length}, redo ${state.history.redo.length}`);
    };
    await step("rename", store.apply("prod-hybrid", rename(9, "One")));
    await step("label", store.label("prod-hybrid", "v1-sent"));
    await step("rename", store.apply("prod-hybrid", rename(10, "Two")));
    await step("undo", store.undo("prod-hybrid", { changeSetId: "cs-undo", at: at() }));
    await step("redo", store.redo("prod-hybrid", { changeSetId: "cs-redo", at: at() }));
    await step("begin run", store.beginRun("prod-hybrid", { runId: "run-1", scope: ["scene-h1"] }));
    const agent = { ...rename(13, "x"), by: "agent", runId: "run-1", ops: [{ op: "trimClip", clipId: "hx-v1", edge: "out", toFrame: 50 }, { op: "trimClip", clipId: "hx-a1", edge: "out", toFrame: 50 }] };
    // A restarted store does not own the run, so the run's owner makes the change.
    const owner = open();
    ok(await owner.resolveInterruptedRun("prod-hybrid", { runId: "run-1", decision: "resume", changeSetId: "cs-resume", at: at() }));
    ok(await owner.apply("prod-hybrid", agent));
    ok(await owner.endRun("prod-hybrid", { runId: "run-1", decision: "keep", changeSetId: "cs-keep", at: at() }));
    await step("restore label", open().restoreLabel("prod-hybrid", "v1-sent", { changeSetId: "cs-restore", at: at() }));

    const final = await loaded(open(), "prod-hybrid");
    expect(final.history.current.name).toBe("One");
    expect(final.history.undo.map((s) => s.runId)).toEqual([null, null, "run-1", null]);
    expect(Object.keys(final.history.labels)).toEqual(["v1-sent"]);
    expect(trace).toEqual([
      "rename: generation 2, revision 10, undo 1, redo 0",
      "label: generation 3, revision 10, undo 1, redo 0",
      "rename: generation 4, revision 11, undo 2, redo 0",
      "undo: generation 5, revision 12, undo 1, redo 1",
      "redo: generation 6, revision 13, undo 2, redo 0",
      "begin run: generation 7, revision 13, undo 2, redo 0",
      "restore label: generation 11, revision 15, undo 4, redo 0",
    ]);
  });

  it("never changes a file once written: records and documents are immutable", async () => {
    const store = open({ gc: { interval: 1_000_000 } });
    ok(await store.create(footageProduction()));
    let seen = await files(root);
    for (let i = 0; i < 6; i++) {
      const base = (await loaded(store)).history.current.revision;
      ok(await (i % 3 === 2 ? store.undo(ID, { changeSetId: `cs-u${i}`, at: at() }) : store.apply(ID, rename(base, `Name ${i}`))));
      const now = await files(root);
      for (const [file, content] of seen) expect(now.get(file), file).toBe(content);
      seen = now;
    }
    expect([...seen.keys()].some((f) => f.startsWith(`${ID}/tmp/`))).toBe(false);
  });

  it("bounds disk use while keeping every state the history needs", async () => {
    const store = open({ gc: { interval: 4, journalRetain: 3, graceMs: 0 } });
    ok(await store.create(footageProduction()));
    for (let i = 0; i < 30; i++) ok(await store.apply(ID, rename(7 + i, `Name ${i}`)));
    const journal = await readdir(path.join(root, ID, "journal"));
    expect(journal.length).toBeLessThanOrEqual(3 + 4);
    const state = await loaded(open());
    expect(state.history.undo).toHaveLength(30);
    for (let i = 0; i < 30; i++) ok(await open().undo(ID, { changeSetId: `cs-undo-${i}`, at: at() }));
    expect((await loaded(open())).history.current.name).toBe(footageProduction().name);
  });
});

describe("concurrent writers in one process", () => {
  it("accept exactly one of several change sets against the same revision", async () => {
    const store = open();
    ok(await store.create(footageProduction()));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.apply(ID, rename(7, `Writer ${i}`))));
    expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.status === "conflict" && r.reason === "stale_revision")).toHaveLength(7);
    expect(await readdir(path.join(root, ID, "journal"))).toHaveLength(2);
  });

  it("decide again on top of the winner when two stores race for the same generation", async () => {
    ok(await open().create(footageProduction()));
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    let reachedLink!: () => void;
    const atLink = new Promise<void>((r) => (reachedLink = r));
    let pauseOnce = true;
    const slowFs: StoreFs = {
      ...nodeFs,
      async link(existing, target) {
        if (pauseOnce && target.includes(`${path.sep}journal${path.sep}`)) {
          pauseOnce = false;
          reachedLink();
          await paused;
        }
        return nodeFs.link(existing, target);
      },
    };
    const slow = open({ fs: slowFs });
    const fast = open();
    // Both decide on revision 7; the slow store stops just before its commit point.
    const slowRename = slow.apply(ID, rename(7, "Slow"));
    await atLink;
    ok(await fast.apply(ID, rename(7, "Fast")));
    release();
    const result = await slowRename;
    // The slow store lost the link, reloaded, and the engine refused its now-stale change.
    expect(result).toMatchObject({ status: "conflict", reason: "stale_revision", expectedRevision: 7, actualRevision: 8 });
    expect((await loaded(open())).history.current.name).toBe("Fast");
  });

  it("retries a change that is still valid after another writer's unrelated commit", async () => {
    ok(await open().create(footageProduction()));
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    let reachedLink!: () => void;
    const atLink = new Promise<void>((r) => (reachedLink = r));
    let pauseOnce = true;
    const slow = open({
      fs: {
        ...nodeFs,
        async link(existing, target) {
          if (pauseOnce && target.includes(`${path.sep}journal${path.sep}`)) {
            pauseOnce = false;
            reachedLink();
            await paused;
          }
          return nodeFs.link(existing, target);
        },
      },
    });
    const pending = slow.apply(ID, rename(7, "Slow"));
    await atLink;
    ok(await open().label(ID, "before-slow"));
    release();
    expect(ok(await pending).generation).toBe(3);
    const state = await loaded(open());
    expect(state.history.current.name).toBe("Slow");
    expect(Object.keys(state.history.labels)).toEqual(["before-slow"]);
  });
});

describe("damaged, unsupported and unreadable data is reported, never replaced", () => {
  async function threeGenerations() {
    const store = open();
    ok(await store.create(footageProduction()));
    ok(await store.apply(ID, rename(7, "One")));
    ok(await store.apply(ID, rename(8, "Two")));
    return files(root);
  }

  it("reports a torn newest record as corrupt, refuses writes, and changes no file", async () => {
    const before = await threeGenerations();
    const raw = await readFile(journalFile(3), "utf-8");
    await writeFile(journalFile(3), raw.slice(0, raw.length / 2));
    const damaged = await files(root);

    const store = open();
    expect(await store.load(ID)).toMatchObject({ status: "corrupt", generation: 3 });
    expect(await store.apply(ID, rename(8, "Over"))).toMatchObject({ status: "corrupt" });
    expect(await store.undo(ID, { changeSetId: "cs-u", at: at() })).toMatchObject({ status: "corrupt" });
    expect(await store.list()).toMatchObject({ productions: [{ productionId: ID, status: "corrupt" }] });
    expect(await files(root)).toEqual(damaged);
    expect(before.size).toBe(damaged.size);
  });

  it("recovers explicitly from an earlier generation, keeping the damaged record", async () => {
    await threeGenerations();
    const raw = await readFile(journalFile(3), "utf-8");
    await writeFile(journalFile(3), "{ not json");
    const store = open();
    expect(await store.recover(ID, { fromGeneration: 5 })).toMatchObject({ status: "invalid_request" });
    const recovered = ok(await store.recover(ID, { fromGeneration: 2 }));
    expect(recovered.generation).toBe(4);
    const state = await loaded(open());
    expect(state.history.current.name).toBe("One");
    expect(state.history.undo).toHaveLength(1);
    expect(await readFile(journalFile(3), "utf-8")).toBe("{ not json");
    const quarantine = await readdir(path.join(root, ID, "quarantine"));
    expect(quarantine.some((f) => f.startsWith(`journal-${generationFile(3)}`))).toBe(true);
    expect(raw.length).toBeGreaterThan(0);
    expect(await store.recover(ID, { fromGeneration: 2 })).toMatchObject({ status: "invalid_request" });
  });

  it("detects a document that no longer matches its hash, and recovers past it", async () => {
    await threeGenerations();
    const record = JSON.parse(await readFile(journalFile(3), "utf-8"));
    const doc = path.join(root, ID, "snapshots", `${record.current}.json`);
    await writeFile(doc, (await readFile(doc, "utf-8")).replace('"Two"', '"Tampered"'));
    expect(await open().load(ID)).toMatchObject({ status: "corrupt", message: "a document does not match its content hash" });
    ok(await open().recover(ID, { fromGeneration: 2 }));
    expect((await loaded(open())).history.current.name).toBe("One");
    // The damaged document was moved to quarantine, so a later identical state is written afresh.
    ok(await open().apply(ID, rename(8, "Two")));
    expect((await loaded(open())).history.current.name).toBe("Two");
  });

  it("refuses a record or document from a newer CreatorBrio, and will not recover over it", async () => {
    await threeGenerations();
    const record = JSON.parse(await readFile(journalFile(3), "utf-8"));
    await writeFile(journalFile(3), JSON.stringify({ ...record, formatVersion: 2 }));
    expect(await open().load(ID)).toMatchObject({ status: "unsupported_version", generation: 3 });
    expect(await open().recover(ID, { fromGeneration: 2 })).toMatchObject({ status: "unsupported_version" });
    expect(await open().apply(ID, rename(9, "x"))).toMatchObject({ status: "unsupported_version" });

    await writeFile(journalFile(3), JSON.stringify(record));
    const docFile = path.join(root, ID, "snapshots", `${record.current}.json`);
    const newer = JSON.stringify({ ...JSON.parse(await readFile(docFile, "utf-8")), schemaVersion: 3 });
    await rm(docFile);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(newer).digest("hex");
    await writeFile(path.join(root, ID, "snapshots", `${hash}.json`), newer);
    await writeFile(journalFile(3), JSON.stringify({ ...record, current: hash, undo: record.undo.map((s: { after: string }, i: number) => (i === record.undo.length - 1 ? { ...s, after: hash } : s)) }));
    expect(await open().load(ID)).toMatchObject({ status: "unsupported_version" });
  });

  it("reports structurally invalid records and documents that are not admissible", async () => {
    await threeGenerations();
    const record = JSON.parse(await readFile(journalFile(3), "utf-8"));
    await writeFile(journalFile(3), JSON.stringify({ ...record, injected: true }));
    expect(await open().load(ID)).toMatchObject({ status: "corrupt" });
    await writeFile(journalFile(3), JSON.stringify({ ...record, generation: 2 }));
    expect(await open().load(ID)).toMatchObject({ status: "corrupt", message: "the record does not belong at this path" });
    await writeFile(journalFile(3), JSON.stringify({ ...record, revision: 99 }));
    expect(await open().load(ID)).toMatchObject({ status: "corrupt", message: "the current document does not match its record" });
  });

  it("surfaces read and write failures as typed I/O errors and keeps the state", async () => {
    await threeGenerations();
    const denied = (operation: keyof StoreFs): StoreFs => ({
      ...nodeFs,
      [operation]: async () => {
        throw Object.assign(new Error(`EACCES: permission denied (${operation})`), { code: "EACCES" });
      },
    });
    expect(await open({ fs: denied("readFile") }).load(ID)).toMatchObject({ status: "io_error", operation: "read", code: "EACCES" });
    expect(await open({ fs: denied("writeNewFileDurable") }).apply(ID, rename(9, "x"))).toMatchObject({ status: "io_error", operation: "write", code: "EACCES" });
    expect(await open({ fs: denied("link") }).apply(ID, rename(9, "x"))).toMatchObject({ status: "io_error", code: "EACCES" });
    expect(await open({ fs: denied("readdir") }).list()).toMatchObject({ status: "io_error", code: "EACCES" });
    const state = await loaded(open());
    expect(state.generation).toBe(3);
    expect(state.history.current.name).toBe("Two");
  });
});

describe("crash at every write boundary", () => {
  /** A file system that dies at its `failAt`-th call: that call and every later one fail, as in a crash. */
  function crashingFs(failAt: number, torn: boolean) {
    let calls = 0;
    let dead = false;
    const fs = {} as StoreFs;
    for (const name of Object.keys(nodeFs) as (keyof StoreFs)[]) {
      (fs as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        if (!dead && calls++ === failAt) {
          dead = true;
          if (torn && name === "writeNewFileDurable") await writeFile(args[0] as string, (args[1] as string).slice(0, 10));
        }
        if (dead) throw Object.assign(new Error(`simulated crash in ${name}`), { code: "EIO" });
        return (nodeFs[name] as (...a: unknown[]) => Promise<unknown>)(...args);
      };
    }
    return { fs, crashed: () => dead };
  }

  /** The same change set every time, so every trial decides exactly the same transition. */
  const fixed = (base: number, name: string, extra: Record<string, unknown> = {}) => ({
    id: "cs-fixed",
    baseRevision: base,
    at: "2026-11-04T13:00:00.000Z",
    by: "user",
    summary: "Fixed rename",
    ops: [{ op: "renameProduction", name }],
    ...extra,
  });

  const scenarios: { name: string; prepare: (s: ProductionStore) => Promise<void>; act: (s: ProductionStore) => Promise<MutationResult> }[] = [
    { name: "create", prepare: async () => undefined, act: (s) => s.create(footageProduction()) },
    { name: "edit", prepare: async (s) => void ok(await s.create(footageProduction())), act: (s) => s.apply(ID, fixed(7, "After")) },
    {
      name: "undo",
      prepare: async (s) => {
        ok(await s.create(footageProduction()));
        ok(await s.apply(ID, fixed(7, "Edited")));
      },
      act: (s) => s.undo(ID, { changeSetId: "cs-undo", at: "2026-11-04T13:00:00.000Z" }),
    },
    { name: "label", prepare: async (s) => void ok(await s.create(footageProduction())), act: (s) => s.label(ID, "v1") },
    { name: "begin run", prepare: async (s) => void ok(await s.create(footageProduction())), act: (s) => s.beginRun(ID, { runId: "run-1" }) },
    {
      name: "discard run",
      prepare: async (s) => {
        ok(await s.create(footageProduction()));
        ok(await s.beginRun(ID, { runId: "run-1" }));
        ok(await s.apply(ID, fixed(7, "Agent", { by: "agent", runId: "run-1" })));
      },
      act: (s) => s.resolveInterruptedRun(ID, { runId: "run-1", decision: "discard", changeSetId: "cs-d", at: "2026-11-04T13:00:00.000Z" }),
    },
  ];

  for (const scenario of scenarios) {
    for (const torn of [false, true]) {
      it(`${scenario.name}${torn ? " (torn temporary write)" : ""}: reopening finds the old state or the new one, never a broken one`, async () => {
        const base = path.join(root, "base");
        const expected = path.join(root, "expected");
        await mkdir(base, { recursive: true });
        await scenario.prepare(new ProductionStore({ root: base, now: NOW }));
        await cp(base, expected, { recursive: true });
        ok(await scenario.act(new ProductionStore({ root: expected, now: NOW })));
        const view0 = async (r: string) => {
          const result = await new ProductionStore({ root: r, now: NOW }).load(ID);
          return result.status === "ok" ? view(result.state.history) : result.status;
        };
        const oldState = await view0(base);
        const newState = await view0(expected);
        expect(oldState).not.toBe(newState);

        let outcomes = { old: 0, new: 0 };
        for (let failAt = 0; ; failAt++) {
          const trial = path.join(root, `trial-${failAt}`);
          await cp(base, trial, { recursive: true });
          const crash = crashingFs(failAt, torn);
          await scenario.act(new ProductionStore({ root: trial, now: NOW, fs: crash.fs }));
          const after = await view0(trial);
          expect([oldState, newState], `crash at call ${failAt}`).toContain(after);
          outcomes = after === newState ? { ...outcomes, new: outcomes.new + 1 } : { ...outcomes, old: outcomes.old + 1 };
          // The store still works after the crash: stray temporary files never block it.
          if (after !== "not_found") {
            const state = await loaded(new ProductionStore({ root: trial, now: NOW }));
            expect(admitProduction(state.history.current).ok).toBe(true);
          }
          await rm(trial, { recursive: true, force: true });
          if (!crash.crashed()) break; // every call boundary has been tried
        }
        expect(outcomes.old).toBeGreaterThan(0);
        expect(outcomes.new).toBeGreaterThan(0);
      });
    }
  }
});

describe("agent runs across a restart", () => {
  it("are never kept or discarded without an explicit decision", async () => {
    const first = open();
    ok(await first.create(footageProduction()));
    ok(await first.beginRun(ID, { runId: "run-1", scope: ["scene-point"] }));
    ok(await first.apply(ID, { ...rename(7, "x"), by: "agent", runId: "run-1", ops: [{ op: "trimClip", clipId: "clip-b1", edge: "out", toFrame: 95 }] }));

    // The owner keeps working in this process; another store instance sees the run but cannot act on it.
    const second = open();
    const state = await loaded(second);
    expect(state).toMatchObject({ recoveryRequired: true, run: { runId: "run-1", ownedHere: false, ownerAlive: true, changeSetIds: [expect.any(String)] } });
    for (const attempt of [
      second.apply(ID, rename(8, "Interloper")),
      second.undo(ID, { changeSetId: "cs-u", at: at() }),
      second.label(ID, "during-run"),
      second.endRun(ID, { runId: "run-1", decision: "keep", changeSetId: "cs-k", at: at() }),
      second.apply(ID, { ...rename(8, "x"), by: "agent", runId: "run-1" }),
    ]) {
      expect(await attempt).toMatchObject({ status: "recovery_required", runId: "run-1" });
    }
    expect((await loaded(open())).generation).toBe(3);

    // Its owner can still finish it, and nobody can resolve a run that is not interrupted for them.
    expect(await first.resolveInterruptedRun(ID, { runId: "run-1", decision: "keep", changeSetId: "cs-k", at: at() })).toMatchObject({ status: "invalid_request" });
    expect(await second.resolveInterruptedRun(ID, { runId: "run-9", decision: "keep", changeSetId: "cs-k", at: at() })).toMatchObject({ status: "rejected", stage: "history" });

    // A person keeps it from the second store: one undo step, and the agent's change stays.
    ok(await second.resolveInterruptedRun(ID, { runId: "run-1", decision: "keep", changeSetId: "cs-keep", at: at() }));
    const kept = await loaded(open());
    expect(kept.run).toBeNull();
    expect(kept.history.undo.map((s) => s.runId)).toEqual(["run-1"]);
    expect(kept.history.current.timeline.tracks[1].clips[0].duration).toBe(20);
    // The original owner's next change is refused by the engine, not silently applied.
    expect(await first.apply(ID, { ...rename(8, "x"), by: "agent", runId: "run-1" })).toMatchObject({ status: "conflict", reason: "no_open_run" });
  });

  it("can be resumed by a new owner and continued", async () => {
    const first = open();
    ok(await first.create(footageProduction()));
    ok(await first.beginRun(ID, { runId: "run-1" }));
    const second = open();
    ok(await second.resolveInterruptedRun(ID, { runId: "run-1", decision: "resume", changeSetId: "cs-r", at: at() }));
    expect((await loaded(second)).run).toMatchObject({ ownedHere: true });
    ok(await second.apply(ID, { ...rename(7, "Resumed"), by: "agent", runId: "run-1" }));
    expect(await first.apply(ID, { ...rename(8, "x"), by: "agent", runId: "run-1" })).toMatchObject({ status: "recovery_required" });
    ok(await second.endRun(ID, { runId: "run-1", decision: "discard", changeSetId: "cs-d", at: at() }));
    expect((await loaded(open())).history.current.name).toBe(footageProduction().name);
  });
});

describe("confirmed commands (expectedGeneration)", () => {
  it("apply only on the generation the caller saw, also when another writer commits in between", async () => {
    const store = open();
    ok(await store.create(footageProduction()));
    ok(await store.apply(ID, rename(7, "Edited")));
    expect(await store.undo(ID, { changeSetId: "cs-u1", at: at() }, { expectedGeneration: 1 })).toMatchObject({
      status: "generation_mismatch",
      expectedGeneration: 1,
      actualGeneration: 2,
    });

    // The confirmed undo reads generation 2, then another store commits generation 3 before its link.
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    let reachedLink!: () => void;
    const atLink = new Promise<void>((r) => (reachedLink = r));
    let pauseOnce = true;
    const slow = open({
      fs: {
        ...nodeFs,
        async link(existing, target) {
          if (pauseOnce && target.includes(`${path.sep}journal${path.sep}`)) {
            pauseOnce = false;
            reachedLink();
            await paused;
          }
          return nodeFs.link(existing, target);
        },
      },
    });
    const pending = slow.undo(ID, { changeSetId: "cs-u2", at: at() }, { expectedGeneration: 2 });
    await atLink;
    ok(await open().label(ID, "meanwhile"));
    release();
    expect(await pending).toMatchObject({ status: "generation_mismatch", expectedGeneration: 2, actualGeneration: 3 });
    expect((await loaded(open())).history.current.name).toBe("Edited");

    expect(await store.recover(ID, { fromGeneration: 1 }, { expectedGeneration: 2 })).toMatchObject({ status: "generation_mismatch", actualGeneration: 3 });
    ok(await store.undo(ID, { changeSetId: "cs-u3", at: at() }, { expectedGeneration: 3 }));
  });
});

// ---------------------------------------------------------------------------

describe("admission against the asset ledger", () => {
  const HOUR = 3_600_000_000;
  function fullLedger(): Map<string, LedgerMedia> {
    return new Map<string, LedgerMedia>([
      [MEDIA.aRoll, { kind: "video", durationUs: HOUR }],
      [MEDIA.bRoll, { kind: "video", durationUs: HOUR }],
      [MEDIA.music, { kind: "audio", durationUs: HOUR }],
      [MEDIA.logo, { kind: "image" }],
      [MEDIA.narration, { kind: "audio", durationUs: HOUR }],
      [MEDIA.illustration, { kind: "image" }],
      [MEDIA.sfx, { kind: "audio", durationUs: HOUR }],
    ]);
  }
  const codes = (result: MutationResult) => (result.status === "rejected" ? result.issues.map((i) => i.code) : [result.status]);

  it("creates a production whose media are all registered", async () => {
    const ledger = fullLedger();
    expect(ok(await open({ ledger: async () => ledger }).create(footageProduction())).generation).toBe(1);
  });

  it("refuses unregistered media, a kind the ledger contradicts and a source range past the media's end", async () => {
    const missing = fullLedger();
    missing.delete(MEDIA.music);
    expect(codes(await open({ ledger: async () => missing }).create(footageProduction()))).toContain("dangling_reference");

    const wrongKind = fullLedger();
    wrongKind.set(MEDIA.logo, { kind: "audio", durationUs: HOUR });
    expect(codes(await open({ ledger: async () => wrongKind }).create(footageProduction()))).toContain("inconsistent");

    // clip-v2 uses the a-roll from 2.5 s to 4 s.
    const short = fullLedger();
    short.set(MEDIA.aRoll, { kind: "video", durationUs: 3_000_000 });
    const refused = await open({ ledger: async () => short }).create(footageProduction());
    expect(refused.status).toBe("rejected");
    expect(await readdir(root)).toEqual([]);
  });

  it("admits changes, undo and redo against the ledger as it is at that moment", async () => {
    let ledger = fullLedger();
    const store = open({ ledger: async () => ledger });
    const base = ok(await store.create(footageProduction())).revision;
    ok(await store.apply(ID, rename(base, "Renamed")));
    ok(await store.apply(ID, { ...rename(base + 1, "Renamed"), ops: [{ op: "addMedia", media: { mediaId: MEDIA.sfx, role: "sfx", label: "Whoosh" } }], summary: "Add a sound" }));

    // The sound is no longer registered: nothing that keeps it can be committed.
    ledger = fullLedger();
    ledger.delete(MEDIA.sfx);
    expect(codes(await store.apply(ID, rename(base + 2, "Again")))).toContain("dangling_reference");
    // Undo restores a state without the sound, which the ledger admits.
    ok(await store.undo(ID, { changeSetId: "cs-undo", at: at() }));
    // Redo would bring the unregistered sound back.
    expect(codes(await store.redo(ID, { changeSetId: "cs-redo", at: at() }))).toContain("dangling_reference");

    // A shorter a-roll makes even the undo target inadmissible.
    ledger = fullLedger();
    ledger.set(MEDIA.aRoll, { kind: "video", durationUs: 3_000_000 });
    const undone = await store.undo(ID, { changeSetId: "cs-undo-2", at: at() });
    expect(undone.status).toBe("rejected");
    expect((await loaded(store)).history.current.name).toBe("Renamed");
  });

  it("reports a ledger that cannot be read as an I/O failure and writes nothing", async () => {
    const ledger = fullLedger();
    let broken = false;
    const store = open({
      ledger: async () => {
        if (broken) throw Object.assign(new Error("registry unreadable"), { code: "EIO" });
        return ledger;
      },
    });
    const base = ok(await store.create(footageProduction())).revision;
    broken = true;
    const result = await store.apply(ID, rename(base, "Renamed"));
    expect(result).toMatchObject({ status: "io_error", operation: "ledger", code: "EIO" });
    expect(await store.create({ ...footageProduction(), id: "prod-other" })).toMatchObject({ status: "io_error", operation: "ledger" });
    expect((await loaded(store)).generation).toBe(1);
  });
});
