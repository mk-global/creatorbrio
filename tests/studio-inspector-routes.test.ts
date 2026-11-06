/**
 * The Inspector's and Export panel's edits against the real routes (#150),
 * as a paired browser sends them: each default graphic inserted at the
 * playhead compiles into the preview, a caption cue edit is one change set,
 * an invalid edit is refused at its field without changing the production,
 * and a revision that cannot be exported is refused with the compiler's
 * issues before anything is queued.
 */
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { StudioApi, StudioApiError } from "@/lib/video/studio/api";
import { addCue, updateCue } from "@/lib/video/studio/caption-cues";
import { draftFromParams, formIssues, paramsFromDraft, type CaptionsDraft } from "@/lib/video/studio/capability-forms";
import { insertGraphic } from "@/lib/video/studio/clip-placement";
import { ProductionSession } from "@/lib/video/studio/production-session";
import type { GraphicsClip } from "@/types/production";
import { restartApi } from "./helpers/api-contexts";
import { routeFetch } from "./helpers/studio-routes";

const run = promisify(execFile);
const PAIR_SCRIPT = path.resolve(__dirname, "../scripts/studio-pair.mjs");
const ID = "studio-inspector";

let workdir: string;
let dataDir: string;
let originalCwd: string;
let cookie: string | null = null;
let api: StudioApi;

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-studio-inspector-")));
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
  await api.createProduction(newEditProduction({ id: ID, name: "Inspector test", at: "2026-01-01T00:00:00.000Z" }));
});

async function ready(): Promise<ProductionSession> {
  const session = new ProductionSession(api, ID);
  await session.load();
  expect(session.getSnapshot().status).toBe("ready");
  return session;
}

function production(session: ProductionSession) {
  return session.getSnapshot().view!.production;
}

function clip(session: ProductionSession, id: string): GraphicsClip {
  for (const track of production(session).timeline.tracks) for (const c of track.clips) if (c.id === id) return c as GraphicsClip;
  throw new Error(`no clip ${id}`);
}

async function insert(session: ProductionSession, kind: Parameters<typeof insertGraphic>[1], playhead: number, id: string) {
  const placed = insertGraphic(production(session), kind, playhead, id);
  if (!placed.ok) throw new Error(placed.reason);
  expect(await session.apply(`Add ${kind}`, [placed.op])).toBe("applied");
  return placed;
}

describe("the Inspector against the real routes", () => {
  it("inserts each default graphic at the playhead, or after the clip in its way, and the preview compiles them", async () => {
    const session = await ready();
    const title = await insert(session, "title-card", 15, "title-1");
    const lower = await insert(session, "lower-third", 15, "lower-1");
    const captions = await insert(session, "captions", 15, "captions-1");
    expect([title.start, title.duration]).toEqual([15, 90]);
    // The titles track is taken from 15 to 105, so the lower third goes right after it.
    expect([lower.trackId, lower.start, lower.duration]).toEqual([STUDIO_TRACKS.titles, 105, 120]);
    expect([captions.trackId, captions.start, captions.duration]).toEqual([STUDIO_TRACKS.captions, 15, 120]);

    const { view, preview } = session.getSnapshot();
    expect(view!.revision).toBe(3);
    expect(preview!.preview.ok).toBe(true);
    if (!preview!.preview.ok) return;
    expect(preview!.preview.plan.graphics.map((g) => g.clipId).sort()).toEqual(["captions-1", "lower-1", "title-1"]);
    expect(preview!.preview.plan.captions).toEqual([{ clipId: "captions-1", startFrame: 15, endFrame: 135, text: "Your caption" }]);
    expect(preview!.preview.overlay.html).toContain("Your title");
  });

  it("commits a cue edit as one change set, and the preview shows the new cues", async () => {
    const session = await ready();
    await insert(session, "captions", 0, "cap");
    const stored = clip(session, "cap");
    let draft = draftFromParams("captions", stored.capability.params) as CaptionsDraft;
    draft = { ...draft, preset: "kinetic", cues: updateCue(draft.cues, 0, "end", "60") };
    draft = { ...draft, cues: addCue(draft.cues, stored.duration, 30)! };
    draft = { ...draft, cues: updateCue(draft.cues, 1, "text", "Second line") };
    expect(await session.apply("Edit captions", [{ op: "setGraphicParams", clipId: "cap", params: paramsFromDraft(draft) }])).toBe("applied");

    const { view, preview } = session.getSnapshot();
    expect(view!.revision).toBe(2);
    expect(view!.history.undo.map((s) => s.label)).toEqual(["Add captions", "Edit captions"]);
    expect(clip(session, "cap").capability.params).toMatchObject({ preset: "kinetic", cues: [{ start: 0, end: 60, text: "Your caption" }, { start: 60, end: 120, text: "Second line" }] });
    expect(preview!.preview.ok && preview!.preview.plan.captions.map((c) => [c.startFrame, c.endFrame, c.text])).toEqual([[0, 60, "Your caption"], [60, 120, "Second line"]]);
  });

  it("refuses an invalid edit at its field and leaves the production as it was", async () => {
    const session = await ready();
    await insert(session, "title-card", 0, "title");
    await insert(session, "captions", 0, "cap");
    const before = clip(session, "cap").capability.params;
    const draft = draftFromParams("captions", before) as CaptionsDraft;
    // The clip is 120 frames long; the second cue overlaps the first and the third ends after the clip.
    const bad: CaptionsDraft = { ...draft, cues: [{ start: "0", end: "60", text: "One" }, { start: "50", end: "90", text: "Two" }, { start: "90", end: "121", text: "Three" }] };
    expect(await session.apply("Edit captions", [{ op: "setGraphicParams", clipId: "cap", params: paramsFromDraft(bad) }])).toBe("refused");

    const { view, refusal } = session.getSnapshot();
    expect(view!.revision).toBe(2);
    expect(clip(session, "cap").capability.params).toEqual(before);
    expect(refusal).toMatchObject({ code: "rejected" });
    // Captions are the fifth track, bottom to top.
    expect(refusal!.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["timeline.tracks[4].clips[0].capability.params.cues[1].start", "timeline.tracks[4].clips[0].capability.params.cues[2].end"])
    );
    const sorted = formIssues(refusal!.issues, view!.production, "cap");
    expect(Object.keys(sorted.fields).sort()).toEqual(["cues[1].start", "cues[2].end"]);
    expect(sorted.fields["cues[2].end"]).toEqual(["expected a whole number from 1 to 120"]);
    expect(sorted.general).toEqual([]);

    // A title card's empty title is refused at the title field.
    expect(await session.apply("Edit title card", [{ op: "setGraphicParams", clipId: "title", params: { title: " ", subtitle: "", align: "center", scrim: true } }])).toBe("refused");
    const snapshot = session.getSnapshot();
    expect(formIssues(snapshot.refusal!.issues, snapshot.view!.production, "title").fields).toEqual({ title: ["expected 1 to 80 characters"] });
  });
});

describe("the Export panel's request against the real routes", () => {
  it("is refused with the compiler's issues when the revision cannot be exported, and nothing is queued", async () => {
    const error = await api.requestRender(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudioApiError);
    const e = error as StudioApiError;
    expect([e.status, e.code]).toEqual([422, "render_refused"]);
    expect(e.details).toMatchObject({ revision: 0, issues: [expect.objectContaining({ code: "empty_timeline", message: expect.any(String) })] });
    expect(await api.listRenders(ID)).toEqual([]);
  });
});
