import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { format } from "node:util";
import sharp from "sharp";

import type { CarouselAsset, Slide } from "@/types/carousel";
import { admissionWaitMs, health, imageServiceUrl, observeBusy, waitForAdmission } from "../eval/acceptance/image-service";
import { logEntries } from "../eval/acceptance/app";
import {
  checkExportFiles,
  checkFileHashes,
  checkPlacement,
  checkPreview,
  checkTasks,
  plannedAssets,
  planSummary,
  sha256,
  snapshotStaged,
  verifyReuse,
  type RunTask,
} from "../eval/acceptance/verify";

// The acceptance harness's own helpers, which run without the real image
// service or a CreatorBrio server: a fake health endpoint on a loopback port
// this test opens, and synthetic files in a temporary folder.

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server | null = null;
let requests: { method?: string; url?: string; authorization?: string }[] = [];

async function fake(handler: Handler): Promise<string> {
  requests = [];
  server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-harness-"));
});

async function closeServer() {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server!.close(resolve));
  server = null;
}

afterEach(async () => {
  await closeServer();
  await rm(workdir, { recursive: true, force: true });
});

describe("acceptance harness: image service health", () => {
  it("reads busy, canGenerate and the reason with a GET of /health, sending no credentials", async () => {
    const url = await fake((_req, res) => json(res, 200, { status: "ok", busy: false, canGenerate: true, reason: "ok" }));
    const sample = await health(url);
    expect(sample).toMatchObject({ reachable: true, busy: false, canGenerate: true, reason: "ok" });
    expect(Date.parse(sample.at)).not.toBeNaN();
    expect(requests).toEqual([{ method: "GET", url: "/health", authorization: undefined }]);
  });

  it("keeps a reason only when it is a short code, never free text", async () => {
    const url = await fake((_req, res) => json(res, 503, { busy: false, canGenerate: false, reason: "Free memory is 3.1 GiB at /Users/someone" }));
    expect(await health(url)).toMatchObject({ reachable: true, canGenerate: false, reason: null });
  });

  it("reads an unreadable answer as not able to generate", async () => {
    const url = await fake((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json");
    });
    expect(await health(url)).toMatchObject({ reachable: true, canGenerate: false, busy: false, reason: null });
  });

  it("reports an unreachable or silent service without throwing, within its time limit", async () => {
    const silent = await fake(() => {
      // Never answers.
    });
    const started = Date.now();
    expect(await health(silent, 100)).toMatchObject({ reachable: false, canGenerate: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    await closeServer();

    // A port that was just closed: nothing listens there.
    const closed = await fake(() => {});
    await closeServer();
    expect(await health(closed)).toMatchObject({ reachable: false, canGenerate: false });
  });

  it("refuses an image service address that is not this machine", () => {
    expect(imageServiceUrl({})).toBe("http://127.0.0.1:8791");
    expect(imageServiceUrl({ EVAL_IMAGE_SERVICE_URL: "http://localhost:9000/x" })).toBe("http://localhost:9000");
    expect(() => imageServiceUrl({ EVAL_IMAGE_SERVICE_URL: "http://192.0.2.10:8791" })).toThrow(/loopback/);
    expect(() => imageServiceUrl({ EVAL_IMAGE_SERVICE_URL: "https://127.0.0.1:8791" })).toThrow(/loopback/);
  });

  it("waits 10 minutes for admission by default, or EVAL_ADMISSION_WAIT_MS", () => {
    expect(admissionWaitMs({})).toBe(600_000);
    expect(admissionWaitMs({ EVAL_ADMISSION_WAIT_MS: "90000" })).toBe(90_000);
    expect(admissionWaitMs({ EVAL_ADMISSION_WAIT_MS: "soon" })).toBe(600_000);
  });
});

describe("acceptance harness: waiting for admission", () => {
  it("returns as soon as the service admits work, with every distinct reason seen", async () => {
    let calls = 0;
    const url = await fake((_req, res) => {
      calls++;
      if (calls === 1) return json(res, 200, { busy: false, canGenerate: false, reason: "example_reason" });
      if (calls === 2) return json(res, 200, { busy: true, canGenerate: true, reason: "another_example_code" });
      json(res, 200, { busy: false, canGenerate: true, reason: "ok" });
    });
    const result = await waitForAdmission({ baseUrl: url, timeoutMs: 5_000, intervalMs: 10 });
    expect(result.admitted).toBe(true);
    expect(result.samples).toHaveLength(3);
    expect(result.last).toMatchObject({ canGenerate: true, busy: false });
    expect(result.reasons).toEqual(["example_reason", "another_example_code", "ok"]);
    expect(requests.every((r) => r.method === "GET" && r.url === "/health")).toBe(true);
  });

  it("gives up at its bound when the service never admits work", async () => {
    let calls = 0;
    const url = await fake((_req, res) => {
      calls++;
      json(res, 200, { busy: false, canGenerate: false, reason: calls % 2 ? "example_reason" : "another_example_code" });
    });
    const started = Date.now();
    const result = await waitForAdmission({ baseUrl: url, timeoutMs: 150, intervalMs: 20 });
    const elapsed = Date.now() - started;
    expect(result.admitted).toBe(false);
    expect(result.samples.length).toBeGreaterThan(1);
    expect(result.reasons).toEqual(["example_reason", "another_example_code"]);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("observes how long the service stays busy after a cancellation, and stops once it is free", async () => {
    let calls = 0;
    const url = await fake((_req, res) => {
      calls++;
      json(res, 200, { busy: calls <= 3, canGenerate: calls > 3, reason: "ok" });
    });
    const seen = await observeBusy({ baseUrl: url, durationMs: 5_000, intervalMs: 10 });
    expect(seen).toMatchObject({ busySeen: true, settled: true });
    expect(seen.samples).toHaveLength(4);
    expect(seen.busyForMs).toBeGreaterThanOrEqual(0);

    const idle = await observeBusy({ baseUrl: url, durationMs: 60, intervalMs: 10 });
    expect(idle).toMatchObject({ busySeen: false, busyForMs: null, settled: true });
  });
});

describe("acceptance harness: server log", () => {
  it("reads the refusal reason from an \"image failed\" entry as the server prints it", async () => {
    const log = path.join(workdir, "server.log");
    const fields = { carouselId: "c-1", runId: "r-1", key: "a1", required: true, code: "image_generation_refused", reason: "example_reason", durationMs: 12 };
    await writeFile(log, `noise\n${format("[creative-run] image failed", fields)}\n${format("[creative-run] image failed", { ...fields, carouselId: "other" })}\n`);
    const entries = await logEntries(log, "c-1");
    expect(entries).toEqual([{ tag: "[creative-run] image failed", fields }]);
  });
});

// ---------------------------------------------------------------------------

const png = (width: number, height: number, seed = 1) =>
  sharp({ create: { width, height, channels: 3, background: { r: seed * 30, g: 90, b: 140 } } }).png().toBuffer();

function asset(id: string, sha: string): CarouselAsset {
  return { id, url: `/uploads/${id}.png`, origin: "generated", sourceIds: [], width: 1024, height: 1280, sha256: sha, runId: "r", createdAt: "" };
}

describe("acceptance harness: per-image checks", () => {
  it("requires every task committed with a hash and asset, accepting only an optional failure", () => {
    const committed: RunTask = { key: "a1", required: true, state: "committed", sha256: "x", assetId: "id" };
    expect(checkTasks([committed, { key: "a2", required: false, state: "failed" }]).pass).toBe(true);
    expect(checkTasks([committed, { key: "a2", required: true, state: "failed" }]).pass).toBe(false);
    expect(checkTasks([{ ...committed, sha256: undefined }]).pass).toBe(false);
    expect(checkTasks([]).pass).toBe(false);
  });

  it("checks each attached file against the task's and the asset record's hash", async () => {
    const id = randomUUID();
    const bytes = await png(8, 10);
    await mkdir(path.join(workdir, "public", "uploads"), { recursive: true });
    await writeFile(path.join(workdir, "public", "uploads", `${id}.png`), bytes);
    const tasks: RunTask[] = [{ key: "a1", required: true, state: "committed", sha256: sha256(bytes), assetId: id }];
    expect((await checkFileHashes(workdir, tasks, [asset(id, sha256(bytes))])).pass).toBe(true);
    expect((await checkFileHashes(workdir, tasks, [asset(id, "0".repeat(64))])).pass).toBe(false);
    await writeFile(path.join(workdir, "public", "uploads", `${id}.png`), await png(8, 10, 5));
    expect((await checkFileHashes(workdir, tasks, [asset(id, sha256(bytes))])).pass).toBe(false);
  });

  it("finds each generated image on every slide its plan assigned, in slide order", () => {
    const slides: Slide[] = [
      { id: "s2", html: '<img src="/uploads/B.png">', previousVersions: [], order: 1, notes: "" },
      { id: "s1", html: '<img src="/uploads/A.png">', previousVersions: [], order: 0, notes: "" },
      { id: "s3", html: '<img src="/uploads/A.png">', previousVersions: [], order: 2, notes: "" },
    ];
    const tasks: RunTask[] = [
      { key: "a1", required: true, state: "committed", assetId: "A" },
      { key: "a2", required: true, state: "committed", assetId: "B" },
    ];
    const plan = [
      { key: "a1", operation: "generate", targetSlides: [1, 3] },
      { key: "a2", operation: "generate", targetSlides: [2] },
      { key: "a3", operation: "reuse", targetSlides: [1] },
    ];
    expect(checkPlacement(plan, tasks, slides).pass).toBe(true);
    const moved = checkPlacement([{ key: "a2", operation: "generate", targetSlides: [3] }], tasks, slides);
    expect(moved).toMatchObject({ pass: false, evidence: expect.stringContaining("missing from slide 3") });
  });

  it("reads the stored plan's assignments and summary, and nothing when no plan was stored", () => {
    const run = {
      runId: "r",
      retry: {
        message: "m",
        plan: {
          strategy: { objective: "Teach", audience: "Founders", centralMessage: "Start early", creativeDirection: "Quiet" },
          execution: { requestType: "new", slideCount: 2, assets: [{ key: "a1", operation: "generate", targetSlides: [2], required: true }] },
          briefUpdate: { addVisualDecisions: [{ text: "Night palette", source: "inferred" }] },
        },
      },
    };
    expect(plannedAssets(run)).toEqual([{ key: "a1", operation: "generate", targetSlides: [2] }]);
    expect(planSummary(run)).toEqual({
      objective: "Teach",
      audience: "Founders",
      centralMessage: "Start early",
      creativeDirection: "Quiet",
      requestType: "new",
      slideCount: 2,
      visualDecisions: ["Night palette"],
    });
    expect(plannedAssets({ runId: "r", retry: null })).toBeNull();
    expect(planSummary(null)).toBeNull();
  });

  it("checks that the preview serves each image as the same PNG bytes", async () => {
    const bytes = await png(8, 10);
    let type = "image/png";
    const origin = await fake((_req, res) => {
      res.writeHead(200, { "Content-Type": type });
      res.end(bytes);
    });
    const id = randomUUID();
    expect((await checkPreview(origin, [asset(id, sha256(bytes))])).pass).toBe(true);
    expect(requests[0]).toMatchObject({ method: "GET", url: `/uploads/${id}.png` });
    expect((await checkPreview(origin, [asset(id, "0".repeat(64))])).pass).toBe(false);
    type = "text/html";
    expect((await checkPreview(origin, [asset(id, sha256(bytes))])).pass).toBe(false);
  });

  it("accepts exported files only as PNGs at the carousel's exact size", async () => {
    const good = path.join(workdir, "slide-1.png");
    const square = path.join(workdir, "slide-2.png");
    const jpeg = path.join(workdir, "slide-3.png");
    await writeFile(good, await png(1080, 1350));
    await writeFile(square, await png(1080, 1080));
    await writeFile(jpeg, await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#000" } }).jpeg().toBuffer());
    expect((await checkExportFiles([good], "4:5")).pass).toBe(true);
    expect((await checkExportFiles([good, square], "4:5")).pass).toBe(false);
    expect((await checkExportFiles([jpeg], "4:5")).pass).toBe(false);
    expect((await checkExportFiles([square], "1:1")).pass).toBe(true);
    expect((await checkExportFiles([], "1:1")).pass).toBe(false);
  });
});

describe("acceptance harness: reuse after a retry", () => {
  const runId = randomUUID();
  const staged = (key: string) => path.join(workdir, "data", "asset-staging", runId, `${key}.png`);
  const upload = (id: string) => path.join(workdir, "public", "uploads", `${id}.png`);

  /** A blocked run with a1 staged and a2 failed, then a retry that made a2 and attached both. */
  async function partialRunThenRetry(attachA1: "link" | "copy" | "remake") {
    await mkdir(path.dirname(staged("a1")), { recursive: true });
    await mkdir(path.dirname(upload("x")), { recursive: true });
    const a1 = await png(8, 10, 1);
    await writeFile(staged("a1"), a1);
    const before = {
      runId,
      tasks: [
        { key: "a1", required: true, state: "staged", sha256: sha256(a1) },
        { key: "a2", required: true, state: "failed" },
      ],
    };
    const snapshot = await snapshotStaged(workdir, before);

    const [id1, id2] = [randomUUID(), randomUUID()];
    if (attachA1 === "link") await link(staged("a1"), upload(id1));
    else await writeFile(upload(id1), attachA1 === "copy" ? a1 : await png(8, 10, 7));
    await unlink(staged("a1"));
    const a2 = await png(8, 10, 2);
    await writeFile(upload(id2), a2);
    const a1Sha = attachA1 === "remake" ? sha256(await png(8, 10, 7)) : sha256(a1);
    const after = {
      runId,
      tasks: [
        { key: "a1", required: true, state: "committed", sha256: a1Sha, assetId: id1 },
        { key: "a2", required: true, state: "committed", sha256: sha256(a2), assetId: id2 },
      ],
    };
    return { snapshot, after, assets: [asset(id1, a1Sha), asset(id2, sha256(a2))] };
  }

  const byName = (checks: { name: string; verdict: { pass: boolean; evidence: string } }[]) =>
    Object.fromEntries(checks.map((c) => [c.name, c.verdict]));

  it("records each staged task's hash and its file's hash and inode, changing nothing", async () => {
    const { snapshot } = await partialRunThenRetry("link");
    expect(snapshot).toMatchObject({ runId, stagingDirExists: true, items: [{ key: "a1", inode: expect.any(String) }] });
    expect(snapshot.items[0].fileSha256).toBe(snapshot.items[0].sha256);
  });

  it("proves reuse by the same hash and the same file when the staged image was hard-linked", async () => {
    const { snapshot, after, assets } = await partialRunThenRetry("link");
    const checks = byName(
      await verifyReuse(workdir, snapshot, { runRecord: after, assets, stagedAfterRetry: ["a2"], retryLine: { reused: 1, pending: 1 } })
    );
    expect(checks["retry reused every staged image"].pass).toBe(true);
    expect(checks["no staged image made again"].pass).toBe(true);
    expect(checks["staged images attached unchanged"]).toMatchObject({ pass: true, evidence: expect.stringContaining("a1: committed, hash same, same file") });
  });

  // The app attaches by hard link, so a copy with the same bytes means the reuse path regressed.
  it("fails the same bytes under a different file, and a remade image", async () => {
    const copied = await partialRunThenRetry("copy");
    const copy = byName(
      await verifyReuse(workdir, copied.snapshot, { runRecord: copied.after, assets: copied.assets, stagedAfterRetry: ["a2"], retryLine: { reused: 1, pending: 1 } })
    );
    expect(copy["staged images attached unchanged"]).toMatchObject({ pass: false, evidence: expect.stringContaining("a1: committed, hash same, not the same file") });

    await rm(workdir, { recursive: true, force: true });
    await mkdir(workdir, { recursive: true });
    const remade = await partialRunThenRetry("remake");
    const remake = byName(
      await verifyReuse(workdir, remade.snapshot, { runRecord: remade.after, assets: remade.assets, stagedAfterRetry: ["a1", "a2"], retryLine: { reused: 0, pending: 2 } })
    );
    expect(remake["retry reused every staged image"].pass).toBe(false);
    expect(remake["no staged image made again"]).toMatchObject({ pass: false, evidence: "made again: a1" });
    expect(remake["staged images attached unchanged"].pass).toBe(false);
  });
});
