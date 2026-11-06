/**
 * The Studio page's production session (#150) against the real routes, as a
 * paired browser reaches them: every edit is one change set against the
 * revision last read, a refused edit leaves the stored state shown, a stale
 * edit is refused and the newer state shown, undo and redo are confirmed
 * against the generation, and one command runs at a time.
 */
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { StudioApi, StudioApiError } from "@/lib/video/studio/api";
import { ProductionSession } from "@/lib/video/studio/production-session";
import type { ProductionOp } from "@/lib/video/studio/types";
import { restartApi } from "./helpers/api-contexts";
import { routeFetch } from "./helpers/studio-routes";

const run = promisify(execFile);
const PAIR_SCRIPT = path.resolve(__dirname, "../scripts/studio-pair.mjs");
const ID = "studio-session";

let workdir: string;
let dataDir: string;
let originalCwd: string;
let cookie: string | null = null;
let api: StudioApi;

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-studio-session-")));
  dataDir = path.join(workdir, "data");
  process.chdir(workdir);
  // The preview's overlay reads the bundled font from node_modules.
  await symlink(path.join(originalCwd, "node_modules"), path.join(workdir, "node_modules"));
});

afterAll(async () => {
  await restartApi();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

beforeEach(async () => {
  await restartApi();
  for (const dir of ["video", "video-media", "video-auth", "video-renders"]) await rm(path.join(dataDir, dir), { recursive: true, force: true });
  cookie = null;
  const fetchImpl = routeFetch(() => cookie);
  api = new StudioApi(fetchImpl);
  const { stdout } = await run(process.execPath, [PAIR_SCRIPT, "--data-dir", dataDir, "--no-tty-check"]);
  const code = /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(stdout)![1];
  const res = await fetchImpl("/api/video/session", { method: "POST", headers: { "x-creatorbrio-request": "studio", "content-type": "application/json" }, body: JSON.stringify({ code }) });
  expect(res.status).toBe(201);
  cookie = res.headers.get("set-cookie")!.split(";")[0];
  await api.createProduction(newEditProduction({ id: ID, name: "Session test", at: "2026-01-01T00:00:00.000Z" /* before the server stamps any change */ }));
});

const title = (id: string, start: number, duration: number, text: string): ProductionOp => ({
  op: "insertClip",
  trackId: STUDIO_TRACKS.titles,
  clip: { kind: "graphics", id, start, duration, layer: "front", capability: { id: "graphics.title-card", version: "1.0.0", params: { title: text, align: "center", scrim: true } } },
});

async function ready(): Promise<ProductionSession> {
  const session = new ProductionSession(api, ID);
  await session.load();
  expect(session.getSnapshot().status).toBe("ready");
  return session;
}

const titleClips = (session: ProductionSession) =>
  session.getSnapshot().view!.production.timeline.tracks.find((t) => t.id === STUDIO_TRACKS.titles)!.clips.map((c) => [c.id, c.start, c.duration]);

describe("the Studio's production session", () => {
  it("loads the stored production with its compiled preview", async () => {
    const session = await ready();
    const { view, preview, busy, refusal } = session.getSnapshot();
    expect(view).toMatchObject({ productionId: ID, revision: 0 });
    expect(preview).toMatchObject({ revision: 0, preview: { ok: false } });
    expect(busy).toBe(false);
    expect(refusal).toBeNull();
  });

  it("commits an edit as one change set and shows the stored result and its preview", async () => {
    const session = await ready();
    let notified = 0;
    session.subscribe(() => notified++);
    expect(await session.apply("Add title", [title("t1", 0, 30, "Hello"), title("t2", 30, 30, "World")])).toBe("applied");
    const { view, preview } = session.getSnapshot();
    expect(view!.revision).toBe(1);
    expect(view!.history.undo.map((s) => s.label)).toEqual(["Add title"]);
    expect(titleClips(session)).toEqual([["t1", 0, 30], ["t2", 30, 30]]);
    expect(preview!.preview.ok && preview!.preview.plan.graphics.map((g) => g.clipId)).toEqual(["t1", "t2"]);
    expect(notified).toBeGreaterThan(0);
  });

  it("reorders two clips in one change set, so one undo restores both", async () => {
    const session = await ready();
    await session.apply("Add title", [title("t1", 0, 30, "Hello"), title("t2", 30, 30, "World")]);
    expect(await session.apply("Reorder", [{ op: "moveClip", clipId: "t1", start: 30 }, { op: "moveClip", clipId: "t2", start: 0 }])).toBe("applied");
    expect(titleClips(session)).toEqual([["t2", 0, 30], ["t1", 30, 30]]);
    expect(await session.undo()).toBe("applied");
    expect(titleClips(session)).toEqual([["t1", 0, 30], ["t2", 30, 30]]);
    expect(await session.redo()).toBe("applied");
    expect(titleClips(session)).toEqual([["t2", 0, 30], ["t1", 30, 30]]);
  });

  it("shows a refused edit with its issues and keeps showing the stored state", async () => {
    const session = await ready();
    await session.apply("Add title", [title("t1", 0, 30, "Hello"), title("t2", 30, 30, "World")]);
    expect(await session.apply("Move clip", [{ op: "moveClip", clipId: "t2", start: 10 }])).toBe("refused");
    const { view, refusal } = session.getSnapshot();
    expect(view!.revision).toBe(1);
    expect(titleClips(session)).toEqual([["t1", 0, 30], ["t2", 30, 30]]);
    expect(refusal).toMatchObject({ summary: "Move clip", code: "rejected" });
    expect(refusal!.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "overlap" })]));
    // Invalid capability parameters are refused at their field.
    expect(await session.apply("Edit title", [{ op: "setGraphicParams", clipId: "t1", params: { title: "", align: "center", scrim: true } }])).toBe("refused");
    expect(session.getSnapshot().refusal!.issues.map((i) => i.path)).toEqual(expect.arrayContaining([expect.stringContaining("capability.params.title")]));
    // The next applied command clears the refusal.
    expect(await session.apply("Edit title", [{ op: "setGraphicParams", clipId: "t1", params: { title: "Hi", align: "center", scrim: true } }])).toBe("applied");
    expect(session.getSnapshot().refusal).toBeNull();
  });

  it("refuses an edit made on a revision another writer has moved past, and shows the newer state", async () => {
    const session = await ready();
    await api.change(ID, { baseRevision: 0, summary: "Elsewhere", ops: [title("t9", 0, 30, "Elsewhere")] });
    expect(await session.apply("Add title", [title("t1", 60, 30, "Late")])).toBe("refused");
    const { view, refusal } = session.getSnapshot();
    expect(refusal).toMatchObject({ code: "stale_revision" });
    expect(view!.revision).toBe(1);
    expect(titleClips(session)).toEqual([["t9", 0, 30]]);
  });

  it("refuses an undo confirmed on an older generation, and shows the newer state", async () => {
    const session = await ready();
    await session.apply("Add title", [title("t1", 0, 30, "Hello")]);
    await api.change(ID, { baseRevision: 1, summary: "Elsewhere", ops: [title("t9", 30, 30, "Elsewhere")] });
    expect(await session.undo()).toBe("refused");
    expect(session.getSnapshot().refusal).toMatchObject({ code: "generation_mismatch" });
    expect(titleClips(session)).toEqual([["t1", 0, 30], ["t9", 30, 30]]);
    // Confirmed on the state now shown, it applies.
    expect(await session.undo()).toBe("applied");
    expect(titleClips(session)).toEqual([["t1", 0, 30]]);
  });

  it("runs one command at a time", async () => {
    const session = await ready();
    const first = session.apply("Add title", [title("t1", 0, 30, "Hello")]);
    expect(session.getSnapshot().busy).toBe(true);
    expect(await session.apply("Add title", [title("t2", 30, 30, "World")])).toBe("busy");
    expect(await first).toBe("applied");
    expect(session.getSnapshot().busy).toBe(false);
    expect(titleClips(session)).toEqual([["t1", 0, 30]]);
  });

  it("reports a server it cannot reach as a failure, not a refusal", async () => {
    const session = await ready();
    const offline = new ProductionSession(new StudioApi(async () => Promise.reject(new TypeError("fetch failed"))), ID);
    await offline.load();
    expect(offline.getSnapshot()).toMatchObject({ status: "error", error: expect.any(StudioApiError) });
    expect(offline.getSnapshot().error!.code).toBe("network_error");
    expect(await session.apply("Add title", [title("t1", 0, 30, "Hello")])).toBe("applied");
  });
});
