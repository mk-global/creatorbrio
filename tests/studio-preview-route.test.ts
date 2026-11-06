/**
 * The Studio preview's decisions against the real preview route (#150), as a
 * paired browser reads it: the overlay is visible on exactly the frames where
 * the plan places a graphic, the frame it holds outside them is the next
 * graphic's first, and `previewOverlayAt` accepts the route's document and
 * sets its time. A refused graphic makes the preview list the issue with its
 * clip to select.
 */
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { overlayTimeSeconds, previewOverlayAt } from "@/lib/video/render/overlay-time";
import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { StudioApi } from "@/lib/video/studio/api";
import { overlayFrameToLoad, overlayVisible } from "@/lib/video/studio/preview-overlay";
import { previewElements } from "@/lib/video/studio/preview-plan";
import { describeIssues } from "@/lib/video/studio/preview-status";
import type { ProductionOp } from "@/lib/video/studio/types";
import { restartApi } from "./helpers/api-contexts";
import { routeFetch } from "./helpers/studio-routes";

const run = promisify(execFile);
const PAIR_SCRIPT = path.resolve(__dirname, "../scripts/studio-pair.mjs");
const ID = "studio-preview";

let workdir: string;
let dataDir: string;
let originalCwd: string;
let cookie: string | null = null;
let api: StudioApi;

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-studio-preview-")));
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
  await api.createProduction(newEditProduction({ id: ID, name: "Preview test", at: "2026-01-01T00:00:00.000Z" }));
});

const graphic = (trackId: string, id: string, start: number, duration: number, capability: { id: string; params: Record<string, unknown> }): ProductionOp => ({
  op: "insertClip",
  trackId,
  clip: { kind: "graphics", id, start, duration, layer: "front", capability: { id: capability.id, version: "1.0.0", params: capability.params as never } },
});

describe("the Studio preview against the preview route", () => {
  it("shows the overlay on exactly the frames the plan places graphics, and seeks the route's document", async () => {
    const applied = await api.change(ID, {
      baseRevision: 0,
      summary: "Add title and captions",
      ops: [
        graphic(STUDIO_TRACKS.titles, "title", 0, 30, { id: "graphics.title-card", params: { title: "Hello", align: "center", scrim: true } }),
        graphic(STUDIO_TRACKS.captions, "caps", 60, 45, {
          id: "captions.timed",
          params: { preset: "sentence", position: "lower", cues: [{ start: 0, end: 20, text: "First words" }, { start: 20, end: 45, text: "and more" }] },
        }),
      ],
    });
    const { preview } = await api.preview(ID);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.plan.revision).toBe(applied.revision);
    // Graphics only: no media elements.
    expect(previewElements(preview.plan)).toEqual([]);

    const { activeRanges } = preview.overlay;
    const graphicOn = (frame: number) => preview.plan.graphics.some((g) => frame >= g.startFrame && frame < g.startFrame + g.durationFrames);
    for (let frame = 0; frame < preview.plan.durationFrames; frame++) expect(overlayVisible(activeRanges, frame), `frame ${frame}`).toBe(graphicOn(frame));
    expect(overlayFrameToLoad(activeRanges, 40)).toBe(60);
    expect(overlayFrameToLoad(activeRanges, 70)).toBe(70);

    const doc = previewOverlayAt(preview.overlay, 70, preview.plan.canvas.fps);
    expect(doc).toContain(`--t:${overlayTimeSeconds(70, 30).toFixed(6)}s`);
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).not.toMatch(/<script/i);
  });

  it("lists a graphic the export cannot draw with its clip, in plain words", async () => {
    await api.change(ID, {
      baseRevision: 0,
      summary: "Add an unknown graphic",
      ops: [graphic(STUDIO_TRACKS.titles, "odd", 0, 30, { id: "graphics.not-a-capability", params: {} })],
    });
    const { preview } = await api.preview(ID);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    const block = describeIssues(preview.issues);
    expect(block.empty).toBe(false);
    expect(block.lines).toEqual([expect.objectContaining({ lead: "A graphic uses a style that is not available", clipId: "odd" })]);
  });

  it("calls a new production's empty timeline a start", async () => {
    const { preview } = await api.preview(ID);
    expect(!preview.ok && describeIssues(preview.issues).empty).toBe(true);
  });
});
