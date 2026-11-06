/**
 * The Studio's pairing card, production picker and media bin against the
 * real routes (#150), as a paired browser reaches them: the server answers
 * the error codes the page words in plain language, a production made by the
 * picker is admitted, and "Add to timeline" for an imported video, sound and
 * still is one accepted change set each, even before their previews are
 * ready, which then compiles into a preview with the expected layers and
 * sounds.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { StudioApi, StudioApiError } from "@/lib/video/studio/api";
import { mediaInProduction, placeMedia } from "@/lib/video/studio/media-placement";
import { ProductionSession } from "@/lib/video/studio/production-session";
import { cryptoRandom, newClipId, newProductionId, usedIds } from "@/lib/video/studio/production-ids";
import { importErrorMessage, pairingErrorMessage } from "@/lib/video/studio/studio-messages";
import type { MediaView } from "@/lib/video/studio/types";
import { restartApi } from "./helpers/api-contexts";
import { FFMPEG_MISSING, makeMedia } from "./helpers/media-fixtures";
import { routeFetch } from "./helpers/studio-routes";

const run = promisify(execFile);
const PAIR_SCRIPT = path.resolve(__dirname, "../scripts/studio-pair.mjs");

let workdir: string;
let dataDir: string;
let originalCwd: string;
let cookie: string | null = null;
let api: StudioApi;

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-studio-bin-")));
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

async function printCode(): Promise<string> {
  const { stdout } = await run(process.execPath, [PAIR_SCRIPT, "--data-dir", dataDir, "--no-tty-check"]);
  return /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(stdout)![1];
}

/** The API as the page uses it; `pair` keeps the session cookie the server sets. */
function pageApi(): StudioApi {
  const fetchImpl = routeFetch(() => cookie);
  return new StudioApi(async (input, init) => {
    const res = await fetchImpl(input, init);
    const set = res.headers.get("set-cookie");
    if (set && input === "/api/video/session" && res.ok) cookie = set.split(";")[0];
    return res;
  });
}

async function refusal(promise: Promise<unknown>): Promise<StudioApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(StudioApiError);
  return error as StudioApiError;
}

beforeEach(async () => {
  await restartApi();
  for (const dir of ["video", "video-media", "video-auth", "video-renders"]) await rm(path.join(dataDir, dir), { recursive: true, force: true });
  cookie = null;
  api = pageApi();
});

describe("pairing from the Studio page", () => {
  it("pairs with the code as the card sends it, grouped, and answers the codes the card explains", async () => {
    const printed = await printCode();
    const wrong = await refusal(api.pair("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ"));
    expect(wrong).toMatchObject({ status: 401, code: "invalid_pairing_code" });
    expect(pairingErrorMessage(wrong)).toContain("npm run studio:pair");

    await expect(api.pair(printed.toLowerCase())).resolves.toMatchObject({ status: "paired" });
    expect(cookie).toMatch(/^cb_studio_session=/);
    await expect(api.session()).resolves.toMatchObject({ authenticated: true });
    // Used once, it is refused like any wrong code.
    expect(await refusal(api.pair(printed))).toMatchObject({ code: "invalid_pairing_code" });
  });

  it("answers rate_limited after repeated wrong codes", async () => {
    let last: StudioApiError | null = null;
    for (let i = 0; i < 6; i++) last = await refusal(api.pair("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ"));
    expect(last).toMatchObject({ status: 429, code: "rate_limited" });
    expect(pairingErrorMessage(last!)).toMatch(/Wait (a minute|\d+ seconds)/);
  });

  it("answers request_refused to a pairing that does not come from this app's page", async () => {
    const { POST } = await import("@/app/api/video/session/route");
    const res = await POST(
      new Request("http://127.0.0.1:3000/api/video/session", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", origin: "http://evil.example", "x-creatorbrio-request": "studio", "content-type": "application/json" },
        body: JSON.stringify({ code: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ" }),
      })
    );
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("request_refused");
    expect(pairingErrorMessage({ code: body.error.code, message: body.error.message, details: {} })).toContain("own address");
  });
});

describe("with a paired browser", () => {
  beforeEach(async () => {
    await api.pair(await printCode());
  });

  it("creates the picker's new production and lists it", async () => {
    const id = newProductionId(Date.now(), cryptoRandom);
    await expect(api.createProduction(newEditProduction({ id, name: "Launch teaser", at: new Date().toISOString() }))).resolves.toMatchObject({ status: "created", productionId: id, revision: 0 });
    expect(await api.listProductions()).toEqual([expect.objectContaining({ productionId: id, status: "ok", name: "Launch teaser", revision: 0 })]);
    expect(await refusal(api.createProduction(newEditProduction({ id, name: "Again", at: new Date().toISOString() })))).toMatchObject({ code: "already_exists" });
  });

  it("answers the import codes the media bin explains, before any file is read", async () => {
    await mkdir(path.join(dataDir, "video-media"), { recursive: true });
    const inside = path.join(dataDir, "inside.mov");
    await writeFile(inside, "not media");
    const cases: [string, string][] = [
      ["relative/clip.mov", "invalid_path"],
      [path.join(workdir, "missing.mov"), "not_found"],
      [workdir, "not_a_file"],
      [inside, "inside_data_directory"],
    ];
    for (const [given, code] of cases) {
      const error = await refusal(api.importMedia(given));
      expect(error.code).toBe(code);
      expect(importErrorMessage(error)).not.toContain("was not imported");
      expect(error.message).not.toContain(workdir);
    }
    expect(await api.listMedia()).toEqual([]);
  });
});

describe.skipIf(FFMPEG_MISSING)(`adding imported media to the timeline${FFMPEG_MISSING ? ` (skipped: ${FFMPEG_MISSING})` : ""}`, () => {
  const ID = "studio-bin";

  beforeEach(async () => {
    await api.pair(await printCode());
    await api.createProduction(newEditProduction({ id: ID, name: "Bin test", at: "2026-01-01T00:00:00.000Z" }));
  });

  async function jobsIdle(): Promise<void> {
    const { apiContext } = await import("@/lib/video/production/api/handlers");
    await apiContext().jobs.idle();
  }

  async function add(session: ProductionSession, media: MediaView): Promise<string> {
    const production = session.getSnapshot().view!.production;
    const placement = placeMedia(production, media, newClipId(usedIds(production), Date.now(), cryptoRandom));
    if (!placement.ok) throw new Error(placement.reason);
    expect(await session.apply(placement.summary, placement.ops)).toBe("applied");
    return placement.clipId;
  }

  it("places a video, a sound and a still in one change set each, and the preview compiles them", async () => {
    const dir = path.join(workdir, "media");
    await mkdir(dir, { recursive: true });
    const [videoFile, audioFile, imageFile, textFile] = await Promise.all([
      makeMedia(dir, "video", "footage.mp4"),
      makeMedia(dir, "audio", "music.m4a"),
      makeMedia(dir, "image", "still.png"),
      writeFile(path.join(dir, "notes.txt"), "plain text").then(() => path.join(dir, "notes.txt")),
    ]);
    const unsupported = await refusal(api.importMedia(textFile));
    expect(unsupported.code).toBe("unsupported_media");
    expect(importErrorMessage(unsupported)).toContain("not a video, sound or still image");

    const video = (await api.importMedia(videoFile)).media;
    const audio = (await api.importMedia(audioFile)).media;
    const image = (await api.importMedia(imageFile)).media;
    expect(await api.importMedia(videoFile)).toMatchObject({ status: "existing", media: { mediaId: video.mediaId } });

    const session = new ProductionSession(api, ID);
    await session.load();
    // Placed straight away, before their previews are made: admission needs only the library record.
    const clips = [await add(session, video), await add(session, audio), await add(session, image)];
    const { view } = session.getSnapshot();
    expect(view!.revision).toBe(3);
    expect(view!.history.undo.map((s) => s.label)).toEqual(["Add footage.mp4", "Add music.m4a", "Add still.png"]);
    for (const m of [video, audio, image]) expect(mediaInProduction(view!.production, m.mediaId)).toBe(true);

    // The same video again goes after the first, without listing it twice.
    const again = await add(session, video);
    const footage = session.getSnapshot().view!.production.timeline.tracks.find((t) => t.id === STUDIO_TRACKS.footage)!.clips;
    expect(footage.map((c) => [c.id, c.start])).toEqual([
      [clips[0], 0],
      [again, footage[0].duration],
    ]);
    expect(session.getSnapshot().view!.production.media).toHaveLength(3);

    await jobsIdle();
    const library = await api.listMedia();
    expect(library.map((m) => [m.originalName, m.derived.state])).toEqual(expect.arrayContaining([["footage.mp4", "succeeded"], ["music.m4a", "succeeded"], ["still.png", "succeeded"]]));

    const preview = await api.preview(ID);
    if (!preview.preview.ok) throw new Error(JSON.stringify(preview.preview.issues));
    const { plan } = preview.preview;
    expect(plan.video.map((l) => [l.clipId, l.kind, l.trackId])).toEqual(
      expect.arrayContaining([
        [clips[0], "video", STUDIO_TRACKS.footage],
        [again, "video", STUDIO_TRACKS.footage],
        [clips[2], "still", STUDIO_TRACKS.images],
      ])
    );
    expect(plan.video).toHaveLength(3);
    expect(plan.audio.map((a) => [a.clipId, a.role]).sort()).toEqual(
      [
        [clips[0], "voice"],
        [again, "voice"],
        [clips[1], "music"],
      ].sort()
    );
    // Undo takes back the whole last placement.
    expect(await session.undo()).toBe("applied");
    expect(session.getSnapshot().view!.production.timeline.tracks.find((t) => t.id === STUDIO_TRACKS.footage)!.clips.map((c) => c.id)).toEqual([clips[0]]);
  });
});
