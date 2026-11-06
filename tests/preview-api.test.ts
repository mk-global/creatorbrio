/**
 * `GET /api/video/productions/[id]/preview` through its real route module
 * (#150): the current revision compiled exactly as a render request compiles
 * it, with a preview-target overlay the page can seek, the compiler's issues
 * as data when the revision cannot be exported, a typed error when the font
 * bundle is missing, and people only.
 */
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PREVIEW_META, previewOverlayAt } from "@/lib/video/render/overlay-time";
import type { GraphicsClip, Production } from "@/types/production";
import { restartApi } from "./helpers/api-contexts";
import { registerFixtureMedia } from "./helpers/media-fixtures";
import { footageProduction, MEDIA } from "./helpers/production-fixtures";

const run = promisify(execFile);
const ORIGIN = "http://127.0.0.1:3000";
const PAIR_SCRIPT = path.resolve(__dirname, "../scripts/studio-pair.mjs");
const PRODUCTION_ID = "prod-footage";

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Module = Record<string, Handler | undefined>;
let workdir: string;
let dataDir: string;
let originalCwd: string;
let humanKey: string;
let preview: Module, productions: Module, session: Module;
let api: typeof import("@/lib/video/production/api/handlers");

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-preview-api-")));
  dataDir = path.join(workdir, "data");
  process.chdir(workdir);
  preview = (await import("@/app/api/video/productions/[id]/preview/route")) as unknown as Module;
  productions = (await import("@/app/api/video/productions/route")) as unknown as Module;
  session = (await import("@/app/api/video/session/route")) as unknown as Module;
  api = await import("@/lib/video/production/api/handlers");
  humanKey = await api.apiContext().authority.humanKey();
});

afterAll(async () => {
  await restartApi();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

beforeEach(async () => {
  await restartApi();
  for (const dir of ["video", "video-media", "video-auth", "video-renders"]) await rm(path.join(dataDir, dir), { recursive: true, force: true });
});

/** The bundled font is read from the app's node_modules, which this test's working folder lacks until linked. */
async function linkNodeModules(): Promise<void> {
  await symlink(path.join(originalCwd, "node_modules"), path.join(workdir, "node_modules")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

interface Req {
  human?: boolean;
  token?: string;
  cookie?: string;
  studioHeader?: boolean;
  fetchSite?: string;
  host?: string;
  body?: unknown;
}

function request(url: string, r: Req = {}): Request {
  const headers: Record<string, string> = { host: r.host ?? "127.0.0.1:3000" };
  if (r.human) headers["x-creatorbrio-human-key"] = humanKey;
  if (r.token) headers.authorization = `Bearer ${r.token}`;
  if (r.cookie) headers.cookie = r.cookie;
  if (r.studioHeader) headers["x-creatorbrio-request"] = "studio";
  if (r.fetchSite) headers["sec-fetch-site"] = r.fetchSite;
  if (r.body === undefined) return new Request(`${ORIGIN}${url}`, { headers });
  headers.origin = ORIGIN;
  headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${url}`, { method: "POST", headers, body: JSON.stringify(r.body) });
}

async function getPreview(r: Req) {
  const res = await preview.GET!(request(`/api/video/productions/${PRODUCTION_ID}/preview`, r), { params: Promise.resolve({ id: PRODUCTION_ID }) });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

const graphic = (id: string, start: number, duration: number, capability: GraphicsClip["capability"]): GraphicsClip => ({
  kind: "graphics",
  id,
  start,
  duration,
  capability,
  layer: "front",
  provenance: { by: "user", changeSetId: "cs-1" },
});

const FOOTAGE: Production["timeline"]["tracks"][number] = {
  id: "t-a",
  kind: "video",
  role: "a-roll",
  hidden: false,
  clips: [{ kind: "video", id: "a1", start: 0, duration: 45, source: { mediaId: MEDIA.aRoll, inUs: 0, outUs: 1_500_000 }, provenance: { by: "user", changeSetId: "cs-1" } }],
};

const TITLE = { id: "graphics.title-card", version: "1.0.0", params: { title: "Agents plan, then act", align: "center", scrim: true } };
const CAPTIONS = { id: "captions.timed", version: "1.0.0", params: { preset: "sentence", position: "lower", cues: [{ start: 0, end: 30, text: "Agents <b>loop</b>" }] } };

/**
 * A title card over captions, which compiles against the fixture registry;
 * with `footage`, also a clip of fixture media that has no picture facts, which
 * the compiler refuses.
 */
function production(footage = false): Production {
  const base = footageProduction();
  return {
    ...base,
    storyboard: null,
    review: { comments: [] },
    media: [{ mediaId: MEDIA.aRoll, role: "a-roll", label: "Take 3" }],
    timeline: {
      tracks: [
        ...(footage ? [FOOTAGE] : []),
        { id: "t-title", kind: "graphics", hidden: false, clips: [graphic("title", 0, 45, TITLE)] },
        { id: "t-captions", kind: "graphics", hidden: false, clips: [graphic("cap", 0, 30, CAPTIONS)] },
      ],
      captions: { presetId: null, hidden: false },
      audio: { masterLufs: -14, ducking: { depthDb: 12, attackMs: 80, releaseMs: 300 } },
      markers: [],
    },
  };
}

async function create(doc: Production = production()): Promise<void> {
  await registerFixtureMedia(dataDir);
  const res = await productions.POST!(request("/api/video/productions", { human: true, body: { production: doc } }));
  expect(res.status, await res.clone().text()).toBe(201);
}

async function pairedCookie(): Promise<string> {
  const { stdout } = await run(process.execPath, [PAIR_SCRIPT, "--data-dir", dataDir, "--no-tty-check"]);
  const code = /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(stdout)![1];
  const res = await session.POST!(new Request(`${ORIGIN}/api/video/session`, {
    method: "POST",
    headers: { host: "127.0.0.1:3000", origin: ORIGIN, "x-creatorbrio-request": "studio", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }));
  expect(res.status).toBe(201);
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("the preview of a production", () => {
  // First in the file: a successful font load is kept for the life of the process, so the
  // missing-bundle answer can only be seen before any other test loads the fonts.
  it("answers 503 with the font code when the font bundle cannot be read, and recovers once it can", async () => {
    await unlink(path.join(workdir, "node_modules")).catch(() => undefined);
    await create();
    const missing = await getPreview({ human: true });
    expect(missing.status).toBe(503);
    expect(missing.body.error.code).toBe("font_bundle_missing");
    expect(missing.text).not.toContain(workdir);
    await linkNodeModules();
    expect((await getPreview({ human: true })).status).toBe(200);
  });

  it("is the current revision's plan with a preview overlay the page can seek, without paths", async () => {
    await linkNodeModules();
    await create();
    const cookie = await pairedCookie();
    const { status, body, text } = await getPreview({ cookie, studioHeader: true, fetchSite: "same-origin" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ productionId: PRODUCTION_ID, revision: 7, preview: { ok: true } });
    expect(Number.isSafeInteger(body.generation)).toBe(true);
    const { plan, overlay } = body.preview;
    expect(plan.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(plan.video).toEqual([]);
    expect(plan.graphics.map((g: { clipId: string }) => g.clipId)).toEqual(["title", "cap"]);
    expect(overlay.activeRanges).toEqual([{ startFrame: 0, endFrame: 45 }]);
    expect(overlay.html).toContain(PREVIEW_META);
    // The caption's markup characters are text, and the page can show any frame.
    expect(overlay.html).not.toContain("<b>loop</b>");
    expect(previewOverlayAt(overlay, 15, 30)).toContain(":root{--t:0.516667s}");
    expect(text).not.toContain(workdir);
    expect(text).not.toContain(dataDir);
  });

  it("carries the compiler's issues, naming the clip, when the revision cannot be exported", async () => {
    await create(production(true));
    const { status, body } = await getPreview({ human: true });
    expect(status).toBe(200);
    expect(body.preview.ok).toBe(false);
    expect(body.preview.plan).toBeUndefined();
    expect(body.preview.issues).toEqual([expect.objectContaining({ code: "media_kind_mismatch", clipId: "a1", path: "/timeline/tracks/0/clips/0/source/mediaId" })]);
  });

  it("is for people only", async () => {
    await create();
    const token = api.apiContext().authority.mintRunToken(PRODUCTION_ID, "run-x");
    expect((await getPreview({ token })).status).toBe(403);
    expect((await getPreview({})).status).toBe(401);
    const cookie = await pairedCookie();
    expect((await getPreview({ cookie, fetchSite: "same-origin" })).body.error.code).toBe("session_request_refused");
    expect((await getPreview({ cookie, studioHeader: true, fetchSite: "same-site" })).body.error.code).toBe("session_request_refused");
    expect((await getPreview({ human: true, host: "evil.example" })).body.error.code).toBe("request_refused");
  });
});
