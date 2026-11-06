/**
 * `/api/video/media` through its real route modules (#140): import by path
 * for people only, the ledger wired into production admission, Range reads
 * of derived files, and the narrow media-element rule for paired browsers,
 * with every refusal around it (another localhost port, cross-site, missing
 * fetch metadata, navigations, other routes, agents).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseRange } from "@/lib/video/production/api/media-handlers";
import { FFMPEG_MISSING, makeMedia, registerMedia } from "./helpers/media-fixtures";
import { footageProduction, MEDIA } from "./helpers/production-fixtures";

const run = promisify(execFile);
const ORIGIN = "http://127.0.0.1:3000";
const SCRIPT = path.resolve(__dirname, "../scripts/studio-pair.mjs");
const IMAGE_ID = "d".repeat(64);

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Module = Record<string, Handler>;
let workdir: string;
let dataDir: string;
let originalCwd: string;
let humanKey: string;
let media: Module, one: Module, retry: Module, files: Module, session: Module, productions: Module;

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-media-api-")));
  dataDir = path.join(workdir, "data");
  process.chdir(workdir);
  media = (await import("@/app/api/video/media/route")) as unknown as Module;
  one = (await import("@/app/api/video/media/[id]/route")) as unknown as Module;
  retry = (await import("@/app/api/video/media/[id]/proxy/route")) as unknown as Module;
  files = (await import("@/app/api/video/media/[id]/files/[name]/route")) as unknown as Module;
  session = (await import("@/app/api/video/session/route")) as unknown as Module;
  productions = (await import("@/app/api/video/productions/route")) as unknown as Module;
  const { apiContext } = await import("@/lib/video/production/api/handlers");
  humanKey = await apiContext().authority.humanKey();
});

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

function restart() {
  const contexts = (globalThis as { __creatorbrioProductionApi?: Map<string, { jobs: { stop(): void } }> }).__creatorbrioProductionApi;
  for (const ctx of contexts?.values() ?? []) ctx.jobs.stop();
  contexts?.clear();
}

beforeEach(async () => {
  restart();
  for (const dir of ["video", "video-media", "video-auth"]) await rm(path.join(dataDir, dir), { recursive: true, force: true });
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
  range?: string;
}

function request(url: string, r: Req = {}): Request {
  const method = r.method ?? (r.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
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

async function send(handler: Handler, url: string, r: Req = {}, params: Record<string, string> = {}) {
  const res = await handler(request(url, r), { params: Promise.resolve(params) });
  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, buffer, body: type.includes("json") && buffer.length ? JSON.parse(buffer.toString("utf-8")) : null };
}

/** An image whose derived PNG is ready, written directly so these tests need no FFmpeg. */
async function readyImage(bytes = "0123456789abcdefghij"): Promise<void> {
  await registerMedia(dataDir, [{ mediaId: IMAGE_ID, kind: "image" }]);
  const dir = path.join(dataDir, "video-media", "objects", IMAGE_ID);
  await writeFile(path.join(dir, "proxy.png"), bytes);
  await writeFile(
    path.join(dir, "job.json"),
    JSON.stringify({ version: 1, mediaId: IMAGE_ID, state: "succeeded", attempts: 1, updatedAt: "2026-11-06T00:00:00.000Z", output: { files: ["proxy.png"], color: "sdr" }, history: [] })
  );
}

const fileUrl = `/api/video/media/${IMAGE_ID}/files/proxy.png`;
const fileParams = { id: IMAGE_ID, name: "proxy.png" };

async function pairedCookie(): Promise<string> {
  const { stdout } = await run(process.execPath, [SCRIPT, "--data-dir", dataDir, "--no-tty-check"]);
  const code = /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(stdout)![1];
  const res = await session.POST(request("/api/video/session", { body: { code }, studioHeader: true, fetchSite: "same-origin" }));
  expect(res.status).toBe(201);
  return res.headers.get("set-cookie")!.split(";")[0];
}

// ---------------------------------------------------------------------------

describe("reading derived files", () => {
  it("serves whole files, single byte ranges and HEAD, and answers 416 past the end", async () => {
    await readyImage();
    const whole = await send(files.GET, fileUrl, { human: true }, fileParams);
    expect(whole.status).toBe(200);
    expect(whole.buffer.toString()).toBe("0123456789abcdefghij");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-type")).toBe("image/png");
    expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
    // A browser cache is shared across this host's ports: a cached copy would skip every check.
    expect(whole.headers.get("cache-control")).toBe("no-store");

    const probe = await send(files.GET, fileUrl, { human: true, range: "bytes=0-1" }, fileParams);
    expect(probe.status).toBe(206);
    expect(probe.buffer.toString()).toBe("01");
    expect(probe.headers.get("content-range")).toBe("bytes 0-1/20");
    expect(probe.headers.get("content-length")).toBe("2");

    const tail = await send(files.GET, fileUrl, { human: true, range: "bytes=-5" }, fileParams);
    expect(tail.buffer.toString()).toBe("fghij");
    const open = await send(files.GET, fileUrl, { human: true, range: "bytes=15-" }, fileParams);
    expect(open.headers.get("content-range")).toBe("bytes 15-19/20");

    const head = await send(files.HEAD, fileUrl, { human: true, method: "HEAD" }, fileParams);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("20");
    expect(head.buffer.length).toBe(0);

    const past = await send(files.GET, fileUrl, { human: true, range: "bytes=20-" }, fileParams);
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */20");
  });

  it("parses only single byte ranges", () => {
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=5-2", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-99", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
  });

  it("refuses unknown names, unknown media, unready files and originals", async () => {
    await readyImage();
    expect((await send(files.GET, `/api/video/media/${IMAGE_ID}/files/original.png`, { human: true }, { id: IMAGE_ID, name: "original.png" })).status).toBe(404);
    expect((await send(files.GET, `/api/video/media/${IMAGE_ID}/files/..%2Frecord.json`, { human: true }, { id: IMAGE_ID, name: "../record.json" })).status).toBe(404);
    expect((await send(files.GET, "/x", { human: true }, { id: "0".repeat(64), name: "proxy.png" })).body.error.code).toBe("media_not_found");
    expect((await send(files.GET, "/x", { human: true }, { id: "../etc", name: "proxy.png" })).body.error.code).toBe("invalid_id");
    const notReady = await send(files.GET, "/x", { human: true }, { id: IMAGE_ID, name: "poster.jpg" });
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe("not_ready");
  });
});

describe("the media-element rule for paired browsers", () => {
  it("lets this app's own <video>/<img> read bytes without the Studio header, and nothing else", async () => {
    await readyImage();
    const cookie = await pairedCookie();
    const element = (fetchSite: string | undefined, fetchDest: string | undefined, extra: Req = {}) =>
      send(files.GET, fileUrl, { cookie, fetchSite, fetchDest, range: "bytes=0-1", ...extra }, fileParams);

    for (const dest of ["video", "audio", "image"]) expect((await element("same-origin", dest)).status).toBe(206);
    // A page on another localhost port is same-site: its Strict cookie is sent, so only same-origin may pass.
    expect((await element("same-site", "video")).status).toBe(403);
    expect((await element("cross-site", "video")).status).toBe(403);
    expect((await element(undefined, "video")).status).toBe(403);
    expect((await element("same-origin", undefined)).status).toBe(403);
    expect((await element("same-origin", "document")).status).toBe(403);
    expect((await element("same-origin", "empty")).status).toBe(403);
    // Script reads still use the Studio header, as everywhere else.
    expect((await element("same-origin", "empty", { studioHeader: true })).status).toBe(206);

    // The exception belongs to the byte routes only.
    const listed = await send(media.GET, "/api/video/media", { cookie, fetchSite: "same-origin", fetchDest: "video" });
    expect(listed.status).toBe(403);
    const record = await send(one.GET, "/x", { cookie, fetchSite: "same-origin", fetchDest: "image" }, { id: IMAGE_ID });
    expect(record.status).toBe(403);
    expect((await send(media.GET, "/api/video/media", { cookie, studioHeader: true, fetchSite: "same-origin" })).status).toBe(200);
  });

  it("never lets a media-element request change anything", async () => {
    const cookie = await pairedCookie();
    const imported = await send(media.POST, "/api/video/media", { cookie, fetchSite: "same-origin", fetchDest: "video", body: { path: "/etc/hosts" } });
    expect(imported.status).toBe(403);
  });
});

describe("authority", () => {
  it("refuses callers without a credential and agents, everywhere", async () => {
    await readyImage();
    expect((await send(media.GET, "/api/video/media")).status).toBe(401);
    expect((await send(files.GET, fileUrl, {}, fileParams)).status).toBe(401);
    const { apiContext } = await import("@/lib/video/production/api/handlers");
    const token = apiContext().authority.mintRunToken("prod-footage", "run-x");
    for (const res of [
      await send(media.GET, "/api/video/media", { token }),
      await send(media.POST, "/api/video/media", { token, body: { path: "/etc/hosts" } }),
      await send(files.GET, fileUrl, { token }, fileParams),
      await send(retry.POST, "/x", { token }, { id: IMAGE_ID }),
    ]) {
      expect(res.status).toBe(403);
    }
  });

  it("refuses imports with stable codes and never echoes the path", async () => {
    const secretDir = path.join(workdir, "private-folder");
    await mkdir(secretDir, { recursive: true });
    const cases: [unknown, number, string][] = [
      ["relative/clip.mp4", 400, "invalid_path"],
      [path.join(secretDir, "missing.mp4"), 404, "not_found"],
      [secretDir, 400, "not_a_file"],
    ];
    for (const [p, status, code] of cases) {
      const res = await send(media.POST, "/api/video/media", { human: true, body: { path: p } });
      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(res.buffer.toString()).not.toContain("private-folder");
    }
    expect((await send(media.POST, "/api/video/media", { human: true, body: { path: "/a", by: "agent" } })).status).toBe(400);
  });

  it("retries only failed jobs", async () => {
    await readyImage();
    const res = await send(retry.POST, "/x", { human: true }, { id: IMAGE_ID });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("job_not_failed");
    expect((await send(retry.POST, "/x", { human: true }, { id: "0".repeat(64) })).status).toBe(404);
  });
});

describe("the registry is the production ledger", () => {
  it("refuses a production whose media are not registered and accepts it once they are", async () => {
    const refused = await send(productions.POST, "/api/video/productions", { human: true, body: { production: footageProduction() } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.issues).toContainEqual(expect.objectContaining({ path: "media[0].mediaId", code: "dangling_reference" }));

    await registerMedia(dataDir, [
      { mediaId: MEDIA.aRoll, kind: "video" },
      { mediaId: MEDIA.bRoll, kind: "video" },
      { mediaId: MEDIA.music, kind: "audio" },
      { mediaId: MEDIA.logo, kind: "image" },
    ]);
    const created = await send(productions.POST, "/api/video/productions", { human: true, body: { production: footageProduction() } });
    expect(created.status).toBe(201);
  });
});

describe.skipIf(FFMPEG_MISSING)(`import through the API${FFMPEG_MISSING ? ` (skipped: ${FFMPEG_MISSING})` : ""}`, () => {
  it("imports a file, makes its preview in the background and streams it to a paired <video>", async () => {
    const file = await makeMedia(path.join(workdir, "footage"), "video");
    const res = await send(media.POST, "/api/video/media", { human: true, body: { path: file } });
    expect(res.status).toBe(201);
    const id = res.body.media.mediaId as string;
    expect(res.body.media).toMatchObject({ kind: "video", originalName: "clip.mp4" });
    expect(JSON.stringify(res.body)).not.toContain(workdir);

    const again = await send(media.POST, "/api/video/media", { human: true, body: { path: file } });
    expect(again).toMatchObject({ status: 200, body: { status: "existing" } });

    const { apiContext } = await import("@/lib/video/production/api/handlers");
    await apiContext().jobs.idle();
    const record = await send(one.GET, "/x", { human: true }, { id });
    expect(record.body.derived).toMatchObject({ state: "succeeded", files: ["proxy.mp4", "poster.jpg", "peaks.json"] });

    const cookie = await pairedCookie();
    const played = await send(files.GET, "/x", { cookie, fetchSite: "same-origin", fetchDest: "video", range: "bytes=0-1" }, { id, name: "proxy.mp4" });
    expect(played.status).toBe(206);
    expect(played.headers.get("content-type")).toBe("video/mp4");
    expect(played.headers.get("content-range")).toMatch(/^bytes 0-1\/\d+$/);
  });
});
