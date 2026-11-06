/**
 * `/api/video/productions/[id]/renders` through its real route modules
 * (#144), with a fake pipeline injected into the API context so every rule
 * runs without FFmpeg or Chromium: people only, the compile check before
 * queueing, duplicate requests, path-free views, file serving only after
 * success, Range and HEAD, cancel and retry. One gated test runs the real
 * pipeline end to end on synthetic media.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiContext } from "@/lib/video/production/api/handlers";
import { RenderFailure } from "@/lib/video/render/execute-types";
import { RenderJobs } from "@/lib/video/render/jobs";
import type { RenderPipeline } from "@/lib/video/render/render-record";
import type { GraphicsClip, Production } from "@/types/production";
import { FFMPEG_MISSING, makeMedia, registerFixtureMedia } from "./helpers/media-fixtures";
import { chromiumPath } from "./helpers/native-pdf";
import { footageProduction, MEDIA } from "./helpers/production-fixtures";
import { deferred, FAILING, fakePipeline, untilAborted } from "./helpers/render-fixtures";

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
let renders: Module, one: Module, cancel: Module, retry: Module, files: Module, productions: Module, media: Module, session: Module;
let api: typeof import("@/lib/video/production/api/handlers");

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-render-api-")));
  dataDir = path.join(workdir, "data");
  process.chdir(workdir);
  renders = (await import("@/app/api/video/productions/[id]/renders/route")) as unknown as Module;
  one = (await import("@/app/api/video/productions/[id]/renders/[renderId]/route")) as unknown as Module;
  cancel = (await import("@/app/api/video/productions/[id]/renders/[renderId]/cancel/route")) as unknown as Module;
  retry = (await import("@/app/api/video/productions/[id]/renders/[renderId]/retry/route")) as unknown as Module;
  files = (await import("@/app/api/video/productions/[id]/renders/[renderId]/files/[name]/route")) as unknown as Module;
  productions = (await import("@/app/api/video/productions/route")) as unknown as Module;
  media = (await import("@/app/api/video/media/route")) as unknown as Module;
  session = (await import("@/app/api/video/session/route")) as unknown as Module;
  api = await import("@/lib/video/production/api/handlers");
  humanKey = await api.apiContext().authority.humanKey();
});

afterAll(async () => {
  await restart();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

/** Stops every runner and waits for it, so nothing writes into a folder the next test removes. */
async function restart() {
  const contexts = (globalThis as { __creatorbrioProductionApi?: Map<string, ApiContext> }).__creatorbrioProductionApi;
  for (const ctx of contexts?.values() ?? []) {
    ctx.jobs.stop();
    ctx.renders.stop();
    await Promise.all([ctx.jobs.idle(), ctx.renders.idle()]);
  }
  contexts?.clear();
}

/** A fresh context whose render runner uses `pipeline`. */
function usePipeline(pipeline: RenderPipeline, backoffMs = 1): ApiContext {
  const ctx = api.apiContext();
  // The context's own runner has nothing to run yet: the data folder was just emptied.
  ctx.renders.stop();
  ctx.renders = new RenderJobs({ root: path.join(dataDir, "video-renders"), pipeline, backoff: () => backoffMs, log: () => undefined });
  void ctx.renders.start();
  return ctx;
}

beforeEach(async () => {
  await restart();
  for (const dir of ["video", "video-media", "video-auth", "video-renders"]) await rm(path.join(dataDir, dir), { recursive: true, force: true });
});

interface Req {
  method?: string;
  body?: unknown;
  human?: boolean;
  token?: string;
  cookie?: string;
  studioHeader?: boolean;
  fetchSite?: string;
  fetchDest?: string;
  origin?: string;
  host?: string;
  range?: string;
}

function request(url: string, r: Req = {}): Request {
  const method = r.method ?? (r.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { host: r.host ?? "127.0.0.1:3000" };
  if (r.human) headers["x-creatorbrio-human-key"] = humanKey;
  if (r.token) headers.authorization = `Bearer ${r.token}`;
  if (r.cookie) headers.cookie = r.cookie;
  if (r.studioHeader) headers["x-creatorbrio-request"] = "studio";
  if (r.fetchSite) headers["sec-fetch-site"] = r.fetchSite;
  if (r.fetchDest) headers["sec-fetch-dest"] = r.fetchDest;
  if (r.range) headers.range = r.range;
  const origin = r.origin ?? (method === "GET" || method === "HEAD" ? undefined : ORIGIN);
  if (origin) headers.origin = origin;
  let body: string | undefined;
  if (r.body !== undefined) {
    body = JSON.stringify(r.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`${ORIGIN}${url}`, { method, headers, body });
}

async function send(handler: Handler | undefined, r: Req = {}, params: Record<string, string> = {}) {
  const res = await handler!(request("/api/video/productions/x/renders", r), { params: Promise.resolve(params) });
  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, buffer, body: type.includes("json") && buffer.length ? JSON.parse(buffer.toString("utf-8")) : null };
}

const graphic = (id: string, start: number, duration: number, capability: GraphicsClip["capability"], extra: Partial<GraphicsClip> = {}): GraphicsClip => ({
  kind: "graphics",
  id,
  start,
  duration,
  capability,
  layer: "front",
  provenance: { by: "user", changeSetId: "cs-1" },
  ...extra,
});

const TITLE = { id: "graphics.title-card", version: "1.0.0", params: { title: "Agents plan, then act", align: "center", scrim: true } };
const CAPTIONS = { id: "captions.timed", version: "1.0.0", params: { preset: "sentence", position: "lower", cues: [{ start: 0, end: 30, text: "Agents <b>loop</b>" }] } };

/** A production with a title card and captions only, which compiles against the fixture registry. */
function graphicsProduction(extra: Partial<GraphicsClip> = {}): Production {
  const base = footageProduction();
  return {
    ...base,
    storyboard: null,
    review: { comments: [] },
    media: [{ mediaId: MEDIA.aRoll, role: "a-roll", label: "Take 3" }],
    timeline: {
      tracks: [
        { id: "t-title", kind: "graphics", hidden: false, clips: [graphic("title", 0, 45, TITLE, extra)] },
        { id: "t-captions", kind: "graphics", hidden: false, clips: [graphic("cap", 0, 30, CAPTIONS)] },
      ],
      captions: { presetId: null, hidden: false },
      audio: { masterLufs: -14, ducking: { depthDb: 12, attackMs: 80, releaseMs: 300 } },
      markers: [],
    },
  };
}

async function createProduction(production: Production = graphicsProduction()): Promise<void> {
  await registerFixtureMedia(dataDir);
  const created = await send(productions.POST, { human: true, body: { production } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
}

const params = (renderId?: string, name?: string) => ({ id: PRODUCTION_ID, ...(renderId ? { renderId } : {}), ...(name ? { name } : {}) });

function requestRender() {
  return send(renders.POST, { human: true, body: {} }, params());
}

async function pairedCookie(): Promise<string> {
  const { stdout } = await run(process.execPath, [PAIR_SCRIPT, "--data-dir", dataDir, "--no-tty-check"]);
  const code = /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(stdout)![1];
  const res = await session.POST!(request("/api/video/session", { body: { code }, studioHeader: true, fetchSite: "same-origin" }));
  expect(res.status).toBe(201);
  return res.headers.get("set-cookie")!.split(";")[0];
}

// ---------------------------------------------------------------------------

describe("requesting a render", () => {
  it("queues the current revision, returns the same render while it is pending, and lists it without paths", async () => {
    const gate = deferred();
    const ctx = usePipeline(fakePipeline(() => gate.promise));
    await createProduction();
    const first = await requestRender();
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: "queued", render: { productionId: PRODUCTION_ID, revision: 7, profile: "instagram", files: [] } });
    const again = await requestRender();
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "existing", render: { renderId: first.body.render.renderId } });

    const listed = await send(renders.GET, { human: true }, params());
    expect(listed.status).toBe(200);
    expect(listed.body.renders.map((r: { renderId: string }) => r.renderId)).toEqual([first.body.render.renderId]);
    const read = await send(one.GET, { human: true }, params(first.body.render.renderId));
    expect(read.body).toMatchObject({ renderId: first.body.render.renderId, state: expect.stringMatching(/^(queued|running)$/) });
    for (const body of [first.body, again.body, listed.body, read.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(workdir);
      expect(text).not.toContain("owner");
      expect(text).not.toContain("pid");
    }
    gate.resolve();
    await ctx.renders.idle();
    expect((await send(one.GET, { human: true }, params(first.body.render.renderId))).body).toMatchObject({ state: "succeeded", files: ["video.mp4", "manifest.json", "captions.srt", "captions.vtt"] });
  });

  it("refuses a revision that cannot be exported with 422 and the compiler's issues, queueing nothing", async () => {
    usePipeline(fakePipeline());
    await createProduction(graphicsProduction({ layer: "behind-subject" }));
    const refused = await requestRender();
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "render_refused", revision: 7 });
    expect(refused.body.error.issues).toContainEqual(expect.objectContaining({ code: "unsupported_feature", clipId: "title", path: expect.stringContaining("/layer") }));
    expect((await send(renders.GET, { human: true }, params())).body.renders).toEqual([]);
  });

  it("validates the body and the production", async () => {
    usePipeline(fakePipeline());
    await createProduction();
    expect((await send(renders.POST, { human: true, body: { profile: "tiktok" } }, params())).body.error.code).toBe("invalid_field");
    expect((await send(renders.POST, { human: true, body: { profile: "instagram", quality: "draft" } }, params())).body.error.code).toBe("unknown_field");
    expect((await send(renders.POST, { human: true, body: { revision: 3 } }, params())).body.error.code).toBe("server_owned_field");
    expect((await send(renders.POST, { human: true, body: { profile: "instagram" } }, params())).status).toBe(202);
    expect((await send(renders.POST, { human: true, body: {} }, { id: "prod-missing" })).status).toBe(404);
    expect((await send(renders.POST, { human: true, body: {} }, { id: "../x" })).body.error.code).toBe("invalid_id");
    expect((await send(one.GET, { human: true }, params("../../etc"))).body.error.code).toBe("invalid_id");
    expect((await send(one.GET, { human: true }, params("render-none"))).body.error.code).toBe("render_not_found");
    // Only the listed methods exist, so Next.js answers others with 405.
    expect(Object.keys(renders).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(files).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["GET", "HEAD"]);
    expect(Object.keys(cancel).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["POST"]);
  });
});

describe("authority", () => {
  it("refuses agents, anonymous callers and other origins everywhere", async () => {
    const ctx = usePipeline(fakePipeline());
    await createProduction();
    const { body } = await requestRender();
    await ctx.renders.idle();
    const id = body.render.renderId;
    const token = ctx.authority.mintRunToken(PRODUCTION_ID, "run-x");
    const calls: [Handler | undefined, Req, Record<string, string>][] = [
      [renders.GET, {}, params()],
      [renders.POST, { body: {} }, params()],
      [one.GET, {}, params(id)],
      [cancel.POST, { body: {} }, params(id)],
      [retry.POST, { body: {} }, params(id)],
      [files.GET, {}, params(id, "video.mp4")],
      [files.HEAD, { method: "HEAD" }, params(id, "manifest.json")],
    ];
    for (const [handler, r, p] of calls) {
      expect((await send(handler, { ...r, token }, p)).status).toBe(403);
      expect((await send(handler, r, p)).status).toBe(401);
    }
    expect((await send(renders.POST, { human: true, body: {}, origin: "https://evil.example" }, params())).body.error.code).toBe("request_refused");
    expect((await send(files.GET, { human: true, host: "evil.example" }, params(id, "video.mp4"))).body.error.code).toBe("request_refused");
  });

  it("lets this app's own <video> read the video without the Studio header, and nothing else", async () => {
    const ctx = usePipeline(fakePipeline());
    await createProduction();
    const { body } = await requestRender();
    await ctx.renders.idle();
    const id = body.render.renderId;
    const cookie = await pairedCookie();
    const element = (name: string, fetchDest: string) => send(files.GET, { cookie, fetchSite: "same-origin", fetchDest, range: "bytes=0-1" }, params(id, name));
    expect((await element("video.mp4", "video")).status).toBe(206);
    expect((await element("manifest.json", "video")).status).toBe(403);
    expect((await element("captions.vtt", "track")).status).toBe(403);
    expect((await send(files.GET, { cookie, fetchSite: "same-site", fetchDest: "video" }, params(id, "video.mp4"))).status).toBe(403);
    expect((await send(files.GET, { cookie, studioHeader: true, fetchSite: "same-origin" }, params(id, "manifest.json"))).status).toBe(200);
  });
});

describe("files", () => {
  it("serves nothing before success, then the files as downloads with Range and HEAD for the video", async () => {
    const gate = deferred();
    const ctx = usePipeline(fakePipeline(() => gate.promise));
    await createProduction();
    const { body } = await requestRender();
    const id = body.render.renderId;
    const early = await send(files.GET, { human: true }, params(id, "video.mp4"));
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("not_ready");
    gate.resolve();
    await ctx.renders.idle();

    const whole = await send(files.GET, { human: true }, params(id, "video.mp4"));
    expect(whole.status).toBe(200);
    expect(whole.buffer.toString()).toBe("0123456789abcdefghij");
    expect(Object.fromEntries(["content-type", "cache-control", "x-content-type-options", "content-security-policy", "accept-ranges", "content-disposition"].map((h) => [h, whole.headers.get(h)]))).toEqual({
      "content-type": "video/mp4",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "accept-ranges": "bytes",
      "content-disposition": `attachment; filename="${PRODUCTION_ID}-${id}-video.mp4"`,
    });
    const part = await send(files.GET, { human: true, range: "bytes=2-5" }, params(id, "video.mp4"));
    expect(part).toMatchObject({ status: 206 });
    expect(part.buffer.toString()).toBe("2345");
    expect(part.headers.get("content-range")).toBe("bytes 2-5/20");
    expect((await send(files.GET, { human: true, range: "bytes=20-" }, params(id, "video.mp4"))).status).toBe(416);
    const head = await send(files.HEAD, { human: true, method: "HEAD" }, params(id, "video.mp4"));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("20");
    expect(head.buffer.length).toBe(0);

    const manifest = await send(files.GET, { human: true, range: "bytes=0-1" }, params(id, "manifest.json"));
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("accept-ranges")).toBeNull();
    expect(manifest.body).toMatchObject({ schemaVersion: 1, renderId: id, productionId: PRODUCTION_ID });
    expect((await send(files.GET, { human: true }, params(id, "captions.srt"))).headers.get("content-type")).toBe("application/x-subrip; charset=utf-8");
    expect((await send(files.GET, { human: true }, params(id, "captions.vtt"))).buffer.toString()).toMatch(/^WEBVTT/);

    for (const name of ["verification.json", "request.json", "job.json", "../job.json", "original.mp4"]) {
      const res = await send(files.GET, { human: true }, params(id, name));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("file_not_found");
    }
    expect((await send(files.GET, { human: true }, params("render-none", "video.mp4"))).body.error.code).toBe("render_not_found");
  });

  it("never serves the files of a render that failed verification", async () => {
    const ctx = usePipeline(fakePipeline(undefined, FAILING));
    await createProduction();
    const { body } = await requestRender();
    await ctx.renders.idle();
    const read = await send(one.GET, { human: true }, params(body.render.renderId));
    expect(read.body).toMatchObject({ state: "failed", files: [], failure: { code: "verification_failed" }, verification: { ok: false, failedChecks: ["faststart"] } });
    for (const name of ["video.mp4", "manifest.json", "captions.srt", "captions.vtt"]) {
      expect((await send(files.GET, { human: true }, params(body.render.renderId, name))).body.error.code).toBe("not_ready");
    }
  });
});

describe("cancel and retry", () => {
  it("cancels a running render, refuses a second cancel, and retries it to success", async () => {
    const started = deferred();
    let call = 0;
    const ctx = usePipeline(
      fakePipeline(async ({ signal }) => {
        if (++call > 1) return;
        started.resolve();
        await untilAborted(signal);
      })
    );
    await createProduction();
    const { body } = await requestRender();
    const id = body.render.renderId;
    await started.promise;
    const cancelling = await send(cancel.POST, { human: true, body: {} }, params(id));
    expect(cancelling).toMatchObject({ status: 202, body: { status: "cancelling", render: { state: "running", cancelRequested: true } } });
    await ctx.renders.idle();
    expect((await send(one.GET, { human: true }, params(id))).body).toMatchObject({ state: "cancelled" });
    expect((await send(cancel.POST, { human: true, body: {} }, params(id))).body.error).toMatchObject({ code: "not_cancellable", render: { state: "cancelled" } });

    const retried = await send(retry.POST, { human: true, body: {} }, params(id));
    expect(retried).toMatchObject({ status: 202, body: { status: "queued", render: { state: "queued", attempts: 0 } } });
    await ctx.renders.idle();
    expect((await send(one.GET, { human: true }, params(id))).body).toMatchObject({ state: "succeeded" });
    expect((await send(retry.POST, { human: true, body: {} }, params(id))).body.error.code).toBe("not_retryable");
    expect((await send(retry.POST, { human: true, body: {} }, params("render-none"))).status).toBe(404);
    expect((await send(cancel.POST, { human: true, body: {} }, params("render-none"))).status).toBe(404);
  });

  it("cancels a queued render at once", async () => {
    const gate = deferred();
    const ctx = usePipeline(fakePipeline(() => gate.promise));
    await createProduction();
    await requestRender();
    // A second render of another revision waits behind the first.
    const later = await ctx.renders.request({ ...graphicsProduction(), revision: 8 }, "instagram");
    const cancelled = await send(cancel.POST, { human: true, body: {} }, params(later.job.renderId));
    expect(cancelled).toMatchObject({ status: 202, body: { status: "cancelled", render: { state: "cancelled" } } });
    gate.resolve();
    await ctx.renders.idle();
  });

  it("cancels a render waiting between attempts at once", async () => {
    const ctx = usePipeline(
      fakePipeline(async () => {
        throw new RenderFailure("transient", "timeout", "a frame did not finish in time");
      }),
      60_000
    );
    await createProduction();
    const { body } = await requestRender();
    const id = body.render.renderId;
    for (let i = 0; i < 100 && (await ctx.renders.read(PRODUCTION_ID, id))!.history.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await send(one.GET, { human: true }, params(id))).body).toMatchObject({ state: "queued", attempts: 1, failure: { code: "timeout" } });
    const cancelled = await send(cancel.POST, { human: true, body: {} }, params(id));
    expect(cancelled).toMatchObject({ status: 202, body: { status: "cancelled", render: { state: "cancelled" } } });
    expect(cancelled.body.render.cancelRequested).toBeUndefined();
    expect((await send(one.GET, { human: true }, params(id))).body).toMatchObject({ state: "cancelled", attempts: 1 });
    await ctx.renders.idle();
  });
});

// ---------------------------------------------------------------------------

const CHROMIUM_MISSING = chromiumPath() ? null : "Chromium is not installed for Puppeteer";
const E2E_MISSING = FFMPEG_MISSING ?? CHROMIUM_MISSING;

describe.skipIf(E2E_MISSING)(`the real pipeline through the API${E2E_MISSING ? ` (skipped: ${E2E_MISSING})` : ""}`, () => {
  it("exports a tiny production with footage, captions, a lower third and a title, and the verifier passes it", { timeout: 240_000 }, async () => {
    // The bundled font is read from the app's node_modules, which this test's working folder lacks.
    await symlink(path.join(originalCwd, "node_modules"), path.join(workdir, "node_modules")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const ctx = api.apiContext();
    const clip = await makeMedia(path.join(workdir, "footage"), "video");
    const imported = await send(media.POST, { human: true, body: { path: clip } });
    expect(imported.status).toBe(201);
    const mediaId = imported.body.media.mediaId as string;
    await ctx.jobs.idle();

    const base = graphicsProduction();
    const production: Production = {
      ...base,
      script: null,
      media: [{ mediaId, role: "a-roll", label: "Clip" }],
      timeline: {
        ...base.timeline,
        tracks: [
          { id: "t-aroll", kind: "video", role: "a-roll", hidden: false, clips: [{ kind: "video", id: "a1", start: 0, duration: 45, source: { mediaId, inUs: 250_000, outUs: 1_750_000 }, provenance: { by: "user", changeSetId: "cs-1" } }] },
          { id: "t-title", kind: "graphics", hidden: false, clips: [graphic("title", 0, 20, TITLE)] },
          { id: "t-lower", kind: "graphics", hidden: false, clips: [graphic("lt", 15, 30, { id: "graphics.lower-third", version: "1.0.0", params: { title: "Ada Lovelace", subtitle: "Founder" } })] },
          { id: "t-captions", kind: "graphics", hidden: false, clips: [graphic("cap", 0, 45, { ...CAPTIONS, params: { ...CAPTIONS.params, preset: "kinetic", cues: [{ start: 0, end: 20, text: "Agents plan" }, { start: 20, end: 45, text: "then act" }] } })] },
        ],
      },
    };
    const created = await send(productions.POST, { human: true, body: { production } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const requested = await requestRender();
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    await ctx.renders.idle();
    const id = requested.body.render.renderId;
    const done = await send(one.GET, { human: true }, params(id));
    expect(done.body, JSON.stringify(done.body)).toMatchObject({ state: "succeeded", verification: { ok: true, failedChecks: [] } });

    const manifest = (await send(files.GET, { human: true }, params(id, "manifest.json"))).body;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      productionId: PRODUCTION_ID,
      revision: 7,
      profile: { id: "instagram", version: 1 },
      planVersion: 1,
      compilerVersion: 1,
      canvas: { width: 1080, height: 1920, fps: 30 },
      durationFrames: 45,
      inputs: [{ mediaId, kind: "video" }],
      workers: 4,
      loudness: { targetLufs: -14, normalisation: expect.stringMatching(/^(linear|dynamic)$/) },
      verification: { ok: true },
    });
    // The clip's test tone is normalised, so loudness was measured, not skipped.
    expect(manifest.verification.checks.filter((c: { status: string }) => c.status !== "passed")).toEqual([]);
    expect(manifest.fonts.length).toBeGreaterThan(0);
    expect(JSON.stringify(manifest)).not.toContain(workdir);
    const video = await readFile(ctx.renders.filePath(PRODUCTION_ID, id, "video.mp4"));
    expect(manifest.outputs).toContainEqual(expect.objectContaining({ name: "video.mp4", bytes: video.length }));
    expect((await send(files.GET, { human: true }, params(id, "captions.srt"))).buffer.toString()).toContain("Agents plan");
  });
});
