/**
 * The Studio timeline's edit commands (#150) against the real routes, as a
 * paired browser reaches them: every op list the builders produce is
 * accepted by the server, lands the clip where the builder computed, and one
 * undo reverts the whole gesture. Media is registered in the real registry
 * with known lengths (no FFmpeg needed), so trims at the source's end are
 * judged by the real ledger.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { framesToSourceSpanUs } from "@/lib/video/production/time";
import { StudioApi } from "@/lib/video/studio/api";
import { findClip, planMoveGesture, planNudge, planRemove, planReorder, planSplit, planTrim, planTrimGesture, planTrimNudge, type Edit } from "@/lib/video/studio/edits";
import { ProductionSession } from "@/lib/video/studio/production-session";
import type { ProductionOp } from "@/lib/video/studio/types";
import type { Production } from "@/types/production";
import { restartApi } from "./helpers/api-contexts";
import { registerMedia } from "./helpers/media-fixtures";
import { MEDIA } from "./helpers/production-fixtures";
import { routeFetch } from "./helpers/studio-routes";

const run = promisify(execFile);
const PAIR_SCRIPT = path.resolve(__dirname, "../scripts/studio-pair.mjs");
const ID = "studio-edits";
const FOOTAGE_US = 4_000_000;
const MUSIC_US = 10_000_000;

let workdir: string;
let dataDir: string;
let originalCwd: string;
let cookie: string | null = null;
let api: StudioApi;

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-studio-edits-")));
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

const span = (frames: number) => framesToSourceSpanUs(frames, 30);

const PICTURE = {
  codec: "h264",
  width: 1080,
  height: 1920,
  rotation: 0,
  frameRate: { num: 30, den: 1 },
  variableFrameRate: false,
  pixelFormat: "yuv420p",
  bitDepth: 8,
  color: { primaries: null, transfer: null, matrix: null, range: null },
  dynamicRange: "sdr",
};
const SOUND = { codec: "aac", sampleRate: 48_000, channels: 2 };

/** Registers media with the streams the compiler needs (a picture, a sound), as a finished import would record them. */
async function registerWithStreams(media: { mediaId: string; kind: "video" | "audio" | "image"; durationUs?: number }[]): Promise<void> {
  await registerMedia(dataDir, media);
  for (const m of media) {
    const file = path.join(dataDir, "video-media", "objects", m.mediaId, "record.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    record.facts = { ...record.facts, ...(m.kind === "audio" ? {} : { video: PICTURE }), ...(m.kind === "image" ? {} : { audio: SOUND }) };
    await writeFile(file, JSON.stringify(record));
  }
}

/** Footage (two clips), an image, music, a title and captions: one clip or more on every Studio lane. */
const SETUP: ProductionOp[] = [
  { op: "addMedia", media: { mediaId: MEDIA.aRoll, role: "a-roll", label: "footage.mov" } },
  { op: "addMedia", media: { mediaId: MEDIA.music, role: "music", label: "music.m4a" } },
  { op: "addMedia", media: { mediaId: MEDIA.logo, role: "image", label: "still.png" } },
  { op: "insertClip", trackId: STUDIO_TRACKS.footage, clip: { kind: "video", id: "v1", start: 0, duration: 60, source: { mediaId: MEDIA.aRoll, inUs: 0, outUs: span(60) } } },
  { op: "insertClip", trackId: STUDIO_TRACKS.footage, clip: { kind: "video", id: "v2", start: 60, duration: 30, source: { mediaId: MEDIA.aRoll, inUs: span(60), outUs: span(90) } } },
  { op: "insertClip", trackId: STUDIO_TRACKS.images, clip: { kind: "still", id: "s1", start: 30, duration: 45, mediaId: MEDIA.logo } },
  { op: "insertClip", trackId: STUDIO_TRACKS.music, clip: { kind: "audio", id: "m1", start: 0, duration: 90, source: { mediaId: MEDIA.music, inUs: 0, outUs: span(90) }, gainDb: [] } },
  {
    op: "insertClip",
    trackId: STUDIO_TRACKS.titles,
    clip: { kind: "graphics", id: "t1", start: 0, duration: 45, layer: "front", capability: { id: "graphics.title-card", version: "1.0.0", params: { title: "Hello", align: "center", scrim: true } } },
  },
  {
    op: "insertClip",
    trackId: STUDIO_TRACKS.captions,
    clip: {
      kind: "graphics",
      id: "c1",
      start: 0,
      duration: 90,
      layer: "front",
      capability: {
        id: "captions.timed",
        version: "1.0.0",
        params: { preset: "sentence", position: "lower", cues: [{ start: 0, end: 30, text: "First line" }, { start: 30, end: 60, text: "Second line" }, { start: 60, end: 90, text: "Third line" }] },
      },
    },
  },
];

beforeEach(async () => {
  await restartApi();
  for (const dir of ["video", "video-media", "video-auth", "video-renders"]) await rm(path.join(dataDir, dir), { recursive: true, force: true });
  await registerWithStreams([
    { mediaId: MEDIA.aRoll, kind: "video", durationUs: FOOTAGE_US },
    { mediaId: MEDIA.music, kind: "audio", durationUs: MUSIC_US },
    { mediaId: MEDIA.logo, kind: "image" },
  ]);
  cookie = null;
  const fetchImpl = routeFetch(() => cookie);
  api = new StudioApi(fetchImpl);
  const { stdout } = await run(process.execPath, [PAIR_SCRIPT, "--data-dir", dataDir, "--no-tty-check"]);
  const code = /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(stdout)![1];
  const res = await fetchImpl("/api/video/session", { method: "POST", headers: { "x-creatorbrio-request": "studio", "content-type": "application/json" }, body: JSON.stringify({ code }) });
  expect(res.status).toBe(201);
  cookie = res.headers.get("set-cookie")!.split(";")[0];
  await api.createProduction(newEditProduction({ id: ID, name: "Edits test", at: "2026-01-01T00:00:00.000Z" }));
  await api.change(ID, { baseRevision: 0, summary: "Set up", ops: SETUP });
});

async function ready(): Promise<ProductionSession> {
  const session = new ProductionSession(api, ID);
  await session.load();
  expect(session.getSnapshot().status).toBe("ready");
  return session;
}

const stored = (session: ProductionSession): Production => session.getSnapshot().view!.production;
const span_ = (session: ProductionSession, id: string) => {
  const found = findClip(stored(session), id);
  return found ? [found.clip.start, found.clip.duration] : null;
};
const lane = (session: ProductionSession, trackId: string) =>
  stored(session)
    .timeline.tracks.find((t) => t.id === trackId)!
    .clips.map((c) => [c.id, c.start, c.duration]);

/** Applies an edit, checks the server took it in one revision and the preview still compiles, then undoes it in one step. */
async function applyThenUndo(session: ProductionSession, edit: Edit | null, check: (session: ProductionSession) => void): Promise<void> {
  expect(edit).not.toBeNull();
  const before = stored(session);
  const revision = session.getSnapshot().view!.revision;
  expect(await session.apply(edit!.summary, edit!.ops)).toBe("applied");
  const { view, preview, refusal } = session.getSnapshot();
  expect(refusal).toBeNull();
  expect(view!.revision).toBe(revision + 1);
  expect(view!.history.undo.at(-1)!.label).toBe(edit!.summary);
  expect(preview!.preview.ok).toBe(true);
  check(session);
  expect(await session.undo()).toBe("applied");
  expect(stored(session).timeline).toEqual(before.timeline);
}

describe("the Studio timeline's edits against the real routes", () => {
  it("compiles the set-up production with a clip on every lane", async () => {
    const session = await ready();
    expect(session.getSnapshot().preview!.preview.ok).toBe(true);
    expect(stored(session).timeline.tracks.every((t) => t.clips.length > 0)).toBe(true);
  });

  it("moves a clip by pointer to a whole frame, and one undo puts it back", async () => {
    const session = await ready();
    await applyThenUndo(session, planMoveGesture(stored(session), "s1", 2.517), (s) => expect(span_(s, "s1")).toEqual([76, 45]));
  });

  it("clamps an overlapping drop flush against the neighbour, which the server accepts", async () => {
    const session = await ready();
    expect(await session.apply("Move clip", planNudge(stored(session), "v2", 60)!.ops)).toBe("applied");
    // Dropped at 50 the clip would overlap v1, which ends at 60: it lands flush at 60.
    await applyThenUndo(session, planMoveGesture(stored(session), "v2", 50 / 30), (s) => expect(lane(s, STUDIO_TRACKS.footage)).toEqual([["v1", 0, 60], ["v2", 60, 30]]));
  });

  it("nudges by a frame and a second from the keyboard", async () => {
    const session = await ready();
    await applyThenUndo(session, planNudge(stored(session), "t1", 1), (s) => expect(span_(s, "t1")).toEqual([1, 45]));
    await applyThenUndo(session, planNudge(stored(session), "v2", 30), (s) => expect(span_(s, "v2")).toEqual([90, 30]));
  });

  it("trims both edges of footage by pointer, rebasing its source", async () => {
    const session = await ready();
    await applyThenUndo(session, planTrimGesture(stored(session), "v1", "left", 0.49, 2), (s) => {
      expect(span_(s, "v1")).toEqual([15, 45]);
      const clip = findClip(stored(s), "v1")!.clip;
      expect(clip.kind === "video" && clip.source).toEqual({ mediaId: MEDIA.aRoll, inUs: span(15), outUs: span(60) });
    });
    await applyThenUndo(session, planTrimGesture(stored(session), "v2", "right", 2, 3.6), (s) => expect(span_(s, "v2")).toEqual([60, 48]));
  });

  it("trims footage up to the end of its media, and the server agrees that is the limit", async () => {
    const session = await ready();
    const edit = planTrim(stored(session), "v2", "out", 1_000, FOOTAGE_US);
    await applyThenUndo(session, edit, (s) => expect(span_(s, "v2")).toEqual([60, 60]));
    // One frame further is refused by the ledger, which is why the builder stops there.
    expect(await session.apply("Trim clip end", [{ op: "trimClip", clipId: "v2", edge: "out", toFrame: 121 }])).toBe("refused");
    expect(session.getSnapshot().refusal!.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "out_of_range" })]));
    expect(span_(session, "v2")).toEqual([60, 30]);
  });

  it("trims music and a still from the keyboard", async () => {
    const session = await ready();
    await applyThenUndo(session, planTrimNudge(stored(session), "m1", "out", -30, MUSIC_US), (s) => expect(span_(s, "m1")).toEqual([0, 60]));
    await applyThenUndo(session, planTrimNudge(stored(session), "s1", "in", -1), (s) => expect(span_(s, "s1")).toEqual([29, 46]));
  });

  it("trims a caption clip and rebases its cues in the same change set", async () => {
    const session = await ready();
    await applyThenUndo(session, planTrim(stored(session), "c1", "out", 45), (s) => {
      const clip = findClip(stored(s), "c1")!.clip;
      expect(clip.kind === "graphics" && clip.capability.params).toMatchObject({ cues: [{ start: 0, end: 30 }, { start: 30, end: 45, text: "Second line" }] });
    });
    await applyThenUndo(session, planTrim(stored(session), "c1", "in", 40), (s) => {
      const clip = findClip(stored(s), "c1")!.clip;
      expect(clip.kind === "graphics" && clip.capability.params).toMatchObject({ cues: [{ start: 0, end: 20, text: "Second line" }, { start: 20, end: 50, text: "Third line" }] });
    });
  });

  it("splits footage, music and captions at the playhead, and one undo joins them again", async () => {
    const session = await ready();
    await applyThenUndo(session, planSplit(stored(session), "v1", 20), (s) => {
      expect(lane(s, STUDIO_TRACKS.footage)).toEqual([["v1", 0, 20], ["v1-2", 20, 40], ["v2", 60, 30]]);
    });
    await applyThenUndo(session, planSplit(stored(session), "m1", 45), (s) => expect(lane(s, STUDIO_TRACKS.music)).toEqual([["m1", 0, 45], ["m1-2", 45, 45]]));
    await applyThenUndo(session, planSplit(stored(session), "c1", 45), (s) => {
      expect(lane(s, STUDIO_TRACKS.captions)).toEqual([["c1", 0, 45], ["c1-2", 45, 45]]);
      const right = findClip(stored(s), "c1-2")!.clip;
      expect(right.kind === "graphics" && right.capability.params).toMatchObject({ cues: [{ start: 0, end: 15, text: "Second line" }, { start: 15, end: 45, text: "Third line" }] });
    });
  });

  it("splits a clip that was split before with an id that is still free", async () => {
    const session = await ready();
    expect(await session.apply("Split clip", planSplit(stored(session), "v1", 30)!.ops)).toBe("applied");
    const again = planSplit(stored(session), "v1", 10)!;
    expect(again.ops[0]).toMatchObject({ newClipId: "v1-3" });
    await applyThenUndo(session, again, (s) => expect(lane(s, STUDIO_TRACKS.footage).map((c) => c[0])).toEqual(["v1", "v1-3", "v1-2", "v2"]));
  });

  it("deletes a clip without closing the gap", async () => {
    const session = await ready();
    await applyThenUndo(session, planRemove(stored(session), "v1"), (s) => expect(lane(s, STUDIO_TRACKS.footage)).toEqual([["v2", 60, 30]]));
  });

  it("reorders two clips in one change set, so one undo restores both", async () => {
    const session = await ready();
    await applyThenUndo(session, planReorder(stored(session), "v1", "later"), (s) => expect(lane(s, STUDIO_TRACKS.footage)).toEqual([["v2", 0, 30], ["v1", 30, 60]]));
    await applyThenUndo(session, planReorder(stored(session), "v2", "earlier"), (s) => expect(lane(s, STUDIO_TRACKS.footage)).toEqual([["v2", 0, 30], ["v1", 30, 60]]));
  });

  it("refuses an overlapping move the builders would never send, and keeps the stored state", async () => {
    const session = await ready();
    expect(await session.apply("Move clip", [{ op: "moveClip", clipId: "v2", start: 30 }])).toBe("refused");
    expect(session.getSnapshot().refusal!.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "overlap" })]));
    expect(lane(session, STUDIO_TRACKS.footage)).toEqual([["v1", 0, 60], ["v2", 60, 30]]);
  });
});
