/**
 * Render downloads from the Studio page (#150), through the real routes as a
 * paired browser reaches them: `StudioApi.renderFile` returns the exact bytes
 * of each of a succeeded render's four files, and the same request without
 * the Studio header is still refused, so downloading through the API needed
 * no wider session rule. A link or navigation cannot carry the header, which
 * is why the page downloads this way.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiContext } from "@/lib/video/production/api/handlers";
import { newEditProduction } from "@/lib/video/production/new-production";
import { RenderJobs } from "@/lib/video/render/jobs";
import { renderFileUrl, StudioApi, StudioApiError } from "@/lib/video/studio/api";
import { insertGraphic } from "@/lib/video/studio/clip-placement";
import { ProductionSession } from "@/lib/video/studio/production-session";
import { RENDER_DOWNLOADS } from "@/lib/video/studio/render-status";
import { restartApi } from "./helpers/api-contexts";
import { fakePipeline } from "./helpers/render-fixtures";
import { routeFetch } from "./helpers/studio-routes";

const run = promisify(execFile);
const PAIR_SCRIPT = path.resolve(__dirname, "../scripts/studio-pair.mjs");
const ID = "studio-downloads";

let workdir: string;
let dataDir: string;
let originalCwd: string;
let cookie: string | null = null;
let fetchImpl: ReturnType<typeof routeFetch>;
let api: StudioApi;

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-studio-downloads-")));
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
  fetchImpl = routeFetch(() => cookie);
  api = new StudioApi(fetchImpl);
  const { stdout } = await run(process.execPath, [PAIR_SCRIPT, "--data-dir", dataDir, "--no-tty-check"]);
  const code = /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(stdout)![1];
  const res = await fetchImpl("/api/video/session", { method: "POST", headers: { "x-creatorbrio-request": "studio", "content-type": "application/json" }, body: JSON.stringify({ code }) });
  expect(res.status).toBe(201);
  cookie = res.headers.get("set-cookie")!.split(";")[0];
  await api.createProduction(newEditProduction({ id: ID, name: "Downloads test", at: "2026-01-01T00:00:00.000Z" }));
});

/** The routes' context with a render runner that uses a fake pipeline, so no FFmpeg or Chrome is needed. */
async function useFakePipeline(): Promise<ApiContext> {
  const { apiContext } = await import("@/lib/video/production/api/handlers");
  const ctx = apiContext();
  ctx.renders.stop();
  ctx.renders = new RenderJobs({ root: path.join(dataDir, "video-renders"), pipeline: fakePipeline(), backoff: () => 1, log: () => undefined });
  void ctx.renders.start();
  return ctx;
}

async function succeededRender(ctx: ApiContext): Promise<string> {
  const session = new ProductionSession(api, ID);
  await session.load();
  const placed = insertGraphic(session.getSnapshot().view!.production, "title-card", 0, "title");
  if (!placed.ok) throw new Error(placed.reason);
  expect(await session.apply("Add title card", [placed.op])).toBe("applied");
  const { render } = await api.requestRender(ID);
  await ctx.renders.idle();
  expect(await api.render(ID, render.renderId)).toMatchObject({ state: "succeeded", verification: { ok: true } });
  return render.renderId;
}

describe("render downloads through the Studio API", () => {
  it("returns the exact bytes of each of a succeeded render's four files", async () => {
    const ctx = await useFakePipeline();
    const renderId = await succeededRender(ctx);
    expect(RENDER_DOWNLOADS.map((d) => d.name)).toEqual(["video.mp4", "captions.srt", "captions.vtt", "manifest.json"]);
    for (const { name } of RENDER_DOWNLOADS) {
      const blob = await api.renderFile(ID, renderId, name);
      const onDisk = await readFile(ctx.renders.filePath(ID, renderId, name));
      expect(onDisk.length).toBeGreaterThan(0);
      expect(Buffer.from(await blob.arrayBuffer()).equals(onDisk)).toBe(true);
    }
  });

  it("refuses the same request without the Studio header, even as a navigation", async () => {
    const ctx = await useFakePipeline();
    const renderId = await succeededRender(ctx);
    for (const { name } of RENDER_DOWNLOADS) {
      const url = renderFileUrl(ID, renderId, name);
      // What a plain link or a script without the header sends: the cookie, same-origin, no Studio header.
      for (const headers of <Record<string, string>[]>[{}, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "empty" }]) {
        const res = await fetchImpl(url, { method: "GET", headers });
        expect(res.status).toBe(403);
        expect((await res.json()).error.code).toBe("session_request_refused");
      }
    }
  });

  it("reports a file that is not ready as the server's refusal", async () => {
    const ctx = await useFakePipeline();
    const renderId = await succeededRender(ctx);
    const error = await api.renderFile(ID, `${renderId}x`, "video.mp4").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudioApiError);
    expect((error as StudioApiError).status).toBe(404);
  });
});
