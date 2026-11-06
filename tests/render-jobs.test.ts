/**
 * Render jobs (#144) with an injected pipeline, so every lifecycle rule runs
 * without FFmpeg or Chromium: atomic publish, retries by failure class,
 * verification failures kept but unserved, cancel and retry, restart
 * recovery, the cross-process lock, duplicate requests and the snapshot.
 */
import { hostname } from "node:os";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolError } from "@/lib/video/media/tools";
import { RenderFailure } from "@/lib/video/render/execute-types";
import { RenderJobs } from "@/lib/video/render/jobs";
import { classifyRenderError, type RenderJob, type RenderPipeline } from "@/lib/video/render/render-record";
import { footageProduction } from "./helpers/production-fixtures";
import { deferred, FAILING, fakePipeline, untilAborted } from "./helpers/render-fixtures";

const quiet = () => undefined;
let root: string;
const runners: RenderJobs[] = [];

beforeEach(async () => {
  root = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-render-jobs-"))), "video-renders");
});

afterEach(async () => {
  for (const r of runners.splice(0)) {
    r.stop();
    await r.idle();
  }
  await rm(path.dirname(root), { recursive: true, force: true });
});

function jobs(pipeline: RenderPipeline, options: Partial<ConstructorParameters<typeof RenderJobs>[0]> = {}): RenderJobs {
  const runner = new RenderJobs({ root, pipeline, backoff: () => 1, log: quiet, ...options });
  runners.push(runner);
  return runner;
}

async function finished(runner: RenderJobs, job: RenderJob): Promise<RenderJob> {
  await runner.idle();
  return (await runner.read(job.productionId, job.renderId))!;
}

const events = (job: RenderJob) => job.history.map((h) => h.event);

describe("a render that succeeds", () => {
  it("publishes every file at once, from the snapshot, and leaves no work behind", async () => {
    const pipeline = fakePipeline();
    const runner = jobs(pipeline);
    await runner.start();
    const production = footageProduction();
    const { created, job } = await runner.request(production, "instagram");
    expect(created).toBe(true);
    expect(job.renderId).toMatch(/^render-[0-9a-z]{9}-[0-9a-f]{8}$/);

    const done = await finished(runner, job);
    expect(done).toMatchObject({ state: "succeeded", attempts: 1, revision: production.revision, profileId: "instagram", verification: { ok: true, failedChecks: [] } });
    expect(done.outputs!.map((o) => o.name)).toEqual(["video.mp4", "manifest.json", "captions.srt", "captions.vtt"]);
    expect(done.outputs!.find((o) => o.name === "video.mp4")!.bytes).toBe(20);
    expect(events(done)).toEqual(["queued", "started", "succeeded"]);
    expect(done.owner).toBeUndefined();

    const dir = runner.renderDir(job.productionId, job.renderId);
    expect((await readdir(dir)).sort()).toEqual(["captions.srt", "captions.vtt", "job.json", "manifest.json", "request.json", "verification.json", "video.mp4"]);
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf-8"));
    expect(manifest).toMatchObject({ schemaVersion: 1, renderId: job.renderId, productionId: production.id, revision: production.revision });
    expect(JSON.stringify(manifest)).not.toContain(root);
    expect(pipeline.calls[0].request.production).toEqual(production);
    expect((await readdir(root)).sort()).toEqual([".staging", production.id]);
    expect(await readdir(path.join(root, ".staging"))).toEqual([]);
  });

  it("publishes nothing from an attempt that fails part way", async () => {
    const runner = jobs(
      fakePipeline(async ({ workDir }) => {
        await writeFile(path.join(workDir, "video.mp4"), "half");
        throw new RenderFailure("permanent", "tool_failed", "FFmpeg could not encode the video");
      })
    );
    await runner.start();
    const { job } = await runner.request(footageProduction(), "instagram");
    const done = await finished(runner, job);
    expect(done).toMatchObject({ state: "failed", attempts: 1, failure: { failureClass: "permanent", code: "tool_failed" } });
    expect((await readdir(runner.renderDir(job.productionId, job.renderId))).sort()).toEqual(["job.json", "request.json"]);
  });

  it("refuses a pipeline that left out a file", async () => {
    const complete = fakePipeline();
    const broken: RenderPipeline = {
      async run(input) {
        const result = await complete.run(input);
        await rm(path.join(input.workDir, "captions.vtt"));
        return result;
      },
    };
    const runner = jobs(broken);
    await runner.start();
    const { job } = await runner.request(footageProduction(), "instagram");
    expect((await finished(runner, job)).failure).toMatchObject({ failureClass: "permanent", code: "internal_error" });
    expect(await readdir(runner.renderDir(job.productionId, job.renderId))).not.toContain("video.mp4");
  });

  it("writes progress to the record while running, at most once per interval", async () => {
    let clock = 1_000_000;
    const seen = deferred();
    const release = deferred();
    const runner = jobs(
      fakePipeline(async ({ onProgress }) => {
        onProgress({ stage: "overlay", done: 1, total: 10 });
        onProgress({ stage: "overlay", done: 2, total: 10 });
        clock += 1500;
        onProgress({ stage: "video", done: 5, total: 30 });
        seen.resolve();
        await release.promise;
      }),
      { clock: () => clock, progressIntervalMs: 1000 }
    );
    await runner.start();
    const { job } = await runner.request(footageProduction(), "instagram");
    await seen.promise;
    await new Promise((r) => setTimeout(r, 50));
    const running = (await runner.read(job.productionId, job.renderId))!;
    expect(running.state).toBe("running");
    expect(running.progress).toEqual({ stage: "video", done: 5, total: 30 });
    release.resolve();
    expect((await finished(runner, job)).progress).toBeUndefined();
  });
});

describe("failures", () => {
  it("retries a transient failure and then succeeds", async () => {
    const runner = jobs(
      fakePipeline(async (_input, call) => {
        if (call === 1) throw new ToolError("timeout", "ffmpeg did not finish within 10 ms");
      })
    );
    await runner.start();
    const { job } = await runner.request(footageProduction(), "instagram");
    const done = await finished(runner, job);
    expect(done).toMatchObject({ state: "succeeded", attempts: 2 });
    expect(events(done)).toEqual(["queued", "started", "failed", "started", "succeeded"]);
    expect(done.history[2]).toMatchObject({ code: "timeout", attempt: 1 });
  });

  it("stops after the last transient attempt", async () => {
    const runner = jobs(
      fakePipeline(async () => {
        throw new RenderFailure("transient", "io_error", "the disk could not be written (EIO)");
      })
    );
    await runner.start();
    const { job } = await runner.request(footageProduction(), "instagram");
    expect(await finished(runner, job)).toMatchObject({ state: "failed", attempts: 3, failure: { failureClass: "transient", code: "io_error" } });
  });

  it("fails permanent and configuration problems at once", async () => {
    for (const [error, failureClass, code] of [
      [new RenderFailure("permanent", "overlay_navigation", "the overlay document tried to navigate"), "permanent", "overlay_navigation"],
      [new RenderFailure("configuration", "browser_missing", "Chromium is not installed"), "configuration", "browser_missing"],
      [new ToolError("missing", "ffmpeg is not installed"), "configuration", "tool_missing"],
    ] as const) {
      const runner = jobs(
        fakePipeline(async () => {
          throw error;
        })
      );
      await runner.start();
      const { job } = await runner.request({ ...footageProduction(), revision: 100 + runners.length }, "instagram");
      expect(await finished(runner, job)).toMatchObject({ state: "failed", attempts: 1, failure: { failureClass, code } });
    }
  });

  it("keeps the files of a render that failed verification, and fails it permanently", async () => {
    const runner = jobs(fakePipeline(undefined, FAILING));
    await runner.start();
    const { job } = await runner.request(footageProduction(), "instagram");
    const done = await finished(runner, job);
    expect(done).toMatchObject({
      state: "failed",
      attempts: 1,
      failure: { failureClass: "permanent", code: "verification_failed" },
      verification: { ok: false, failedChecks: ["faststart"] },
    });
    expect(done.outputs).toBeUndefined();
    const dir = runner.renderDir(job.productionId, job.renderId);
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["video.mp4", "verification.json", "manifest.json"]));
    expect(JSON.parse(await readFile(path.join(dir, "verification.json"), "utf-8"))).toEqual(FAILING);
  });

  it("fails a render whose snapshot is damaged as snapshot_invalid", async () => {
    const gate = deferred();
    const runner = jobs(fakePipeline(() => gate.promise));
    await runner.start();
    const first = await runner.request(footageProduction(), "instagram");
    const second = await runner.request({ ...footageProduction(), revision: 8 }, "instagram");
    await writeFile(path.join(runner.renderDir(second.job.productionId, second.job.renderId), "request.json"), "{");
    gate.resolve();
    await runner.idle();
    expect((await runner.read(first.job.productionId, first.job.renderId))!.state).toBe("succeeded");
    expect(await runner.read(second.job.productionId, second.job.renderId)).toMatchObject({ state: "failed", failure: { failureClass: "permanent", code: "snapshot_invalid" } });
  });

  it("classifies errors", () => {
    expect(classifyRenderError(new ToolError("aborted", "ffmpeg was cancelled"))).toMatchObject({ failureClass: "transient", code: "interrupted" });
    expect(classifyRenderError(new ToolError("failed", "ffmpeg exited with code 1", 1))).toMatchObject({ failureClass: "permanent", code: "tool_failed" });
    expect(classifyRenderError(Object.assign(new Error("full"), { code: "ENOSPC" }))).toMatchObject({ failureClass: "transient", code: "io_error" });
    expect(classifyRenderError(new Error("/secret/path broke"))).toEqual({ failureClass: "permanent", code: "internal_error", message: "the render could not be completed" });
  });
});

describe("cancel and retry", () => {
  it("cancels a queued render at once, and it never runs", async () => {
    const gate = deferred();
    const pipeline = fakePipeline(() => gate.promise);
    const runner = jobs(pipeline);
    await runner.start();
    const first = await runner.request(footageProduction(), "instagram");
    const second = await runner.request({ ...footageProduction(), revision: 8 }, "instagram");
    const cancelled = await runner.cancel(second.job.productionId, second.job.renderId);
    expect(cancelled).toMatchObject({ ok: true, pending: false, job: { state: "cancelled" } });
    gate.resolve();
    await runner.idle();
    expect(pipeline.calls.map((c) => c.request.renderId)).toEqual([first.job.renderId]);
    expect(await runner.read(second.job.productionId, second.job.renderId)).toMatchObject({ state: "cancelled" });
  });

  it("cancels a running render through its signal, and it ends cancelled rather than failed", async () => {
    const started = deferred();
    let observed = false;
    const runner = jobs(
      fakePipeline(async ({ signal }) => {
        started.resolve();
        await untilAborted(signal).catch((error) => {
          observed = true;
          throw error;
        });
      })
    );
    await runner.start();
    const { job } = await runner.request(footageProduction(), "instagram");
    await started.promise;
    const result = await runner.cancel(job.productionId, job.renderId);
    expect(result).toMatchObject({ ok: true, pending: true });
    expect(runner.cancelPending(job.renderId)).toBe(true);
    const done = await finished(runner, job);
    expect(observed).toBe(true);
    expect(done).toMatchObject({ state: "cancelled", attempts: 1 });
    expect(done.failure).toBeUndefined();
    expect(events(done)).toEqual(["queued", "started", "cancelled"]);
    expect((await readdir(runner.renderDir(job.productionId, job.renderId))).sort()).toEqual(["job.json", "request.json"]);
  });

  it("cancels a render waiting between attempts", async () => {
    const runner = jobs(
      fakePipeline(async () => {
        throw new RenderFailure("transient", "timeout", "a frame did not finish in time");
      }),
      { backoff: () => 60_000 }
    );
    await runner.start();
    const { job } = await runner.request(footageProduction(), "instagram");
    for (let i = 0; i < 50 && (await runner.read(job.productionId, job.renderId))!.history.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await runner.cancel(job.productionId, job.renderId)).toMatchObject({ ok: true, pending: true });
    expect(await finished(runner, job)).toMatchObject({ state: "cancelled", attempts: 1 });
  });

  it("retries failed and cancelled renders from the start, and refuses everything else", async () => {
    let mode: "broken" | "fine" = "broken";
    const gate = deferred();
    const runner = jobs(
      fakePipeline(async (_input, call) => {
        if (call === 1) await gate.promise;
        if (mode === "broken") throw new RenderFailure("permanent", "tool_failed", "FFmpeg could not encode the video");
      })
    );
    await runner.start();
    const failing = await runner.request(footageProduction(), "instagram");
    const queued = await runner.request({ ...footageProduction(), revision: 8 }, "instagram");
    await runner.cancel(queued.job.productionId, queued.job.renderId);
    gate.resolve();
    await runner.idle();
    expect(await runner.read(failing.job.productionId, failing.job.renderId)).toMatchObject({ state: "failed", attempts: 1 });

    mode = "fine";
    for (const { job } of [failing, queued]) {
      const retried = await runner.retry(job.productionId, job.renderId);
      expect(retried).toMatchObject({ ok: true, job: { state: "queued", attempts: 0 } });
      if (retried.ok) expect(retried.job.failure).toBeUndefined();
    }
    await runner.idle();
    for (const { job } of [failing, queued]) {
      const done = (await runner.read(job.productionId, job.renderId))!;
      expect(done).toMatchObject({ state: "succeeded", attempts: 1 });
      expect(events(done)).toContain("retried");
    }
    expect(await runner.retry(failing.job.productionId, failing.job.renderId)).toMatchObject({ ok: false, code: "not_retryable" });
    expect(await runner.cancel(failing.job.productionId, failing.job.renderId)).toMatchObject({ ok: false, code: "not_cancellable" });
    expect(await runner.retry("prod-footage", "render-missing")).toEqual({ ok: false, code: "not_found" });
    expect(await runner.cancel("prod-footage", "../escape")).toEqual({ ok: false, code: "not_found" });
  });
});

describe("restarts and processes", () => {
  async function runningRecord(runner: RenderJobs, owner: RenderJob["owner"]): Promise<RenderJob> {
    // A stopped runner records the request without running it.
    const parked = jobs({ run: () => new Promise(() => undefined) });
    parked.stop();
    const { job } = await parked.request(footageProduction(), "instagram");
    const running: RenderJob = { ...job, state: "running", attempts: 1, owner, history: [...job.history, { at: job.updatedAt, event: "started", attempt: 1 }] };
    await writeFile(path.join(runner.renderDir(job.productionId, job.renderId), "job.json"), JSON.stringify(running));
    return running;
  }

  it("queues again a render a stopped process left running, taking over its lock", async () => {
    const runner = jobs(fakePipeline());
    const owner = { pid: 2 ** 22 + 12345, host: hostname(), instance: "gone" };
    const job = await runningRecord(runner, owner);
    await writeFile(path.join(runner.renderDir(job.productionId, job.renderId), "job.lock"), JSON.stringify(owner));
    await runner.start();
    const done = await finished(runner, job);
    expect(done.state).toBe("succeeded");
    expect(events(done)).toEqual(["queued", "started", "interrupted", "started", "succeeded"]);
    expect(await readdir(runner.renderDir(job.productionId, job.renderId))).not.toContain("job.lock");
  });

  it("leaves a render a stopping server was running as running, and the next start finishes it", async () => {
    const started = deferred();
    const first = jobs(
      fakePipeline(async ({ signal }) => {
        started.resolve();
        await untilAborted(signal);
      })
    );
    await first.start();
    const { job } = await first.request(footageProduction(), "instagram");
    await started.promise;
    first.stop();
    await first.idle();
    expect((await first.read(job.productionId, job.renderId))!.state).toBe("running");

    const second = jobs(fakePipeline());
    await second.start();
    const done = await finished(second, job);
    expect(done).toMatchObject({ state: "succeeded" });
    expect(events(done)).toContain("interrupted");
  });

  it("does not run a render whose lock a live process holds", async () => {
    let ran = false;
    const runner = jobs(
      fakePipeline(async () => {
        ran = true;
      })
    );
    const parked = jobs({ run: () => new Promise(() => undefined) });
    parked.stop();
    const { job } = await parked.request(footageProduction(), "instagram");
    // This test's parent process is alive and holds the lock.
    await writeFile(path.join(runner.renderDir(job.productionId, job.renderId), "job.lock"), JSON.stringify({ pid: process.ppid, host: hostname(), instance: "other" }));
    await runner.start();
    await runner.idle();
    expect(ran).toBe(false);
    expect((await runner.read(job.productionId, job.renderId))!.state).toBe("queued");
  });
});

describe("requests", () => {
  it("returns the queued or running render for the same revision and profile instead of a new one", async () => {
    const gate = deferred();
    const runner = jobs(fakePipeline(() => gate.promise));
    await runner.start();
    const production = footageProduction();
    const first = await runner.request(production, "instagram");
    const again = await runner.request(production, "instagram");
    expect(again).toEqual({ created: false, job: expect.objectContaining({ renderId: first.job.renderId }) });
    const later = await runner.request({ ...production, revision: production.revision + 1 }, "instagram");
    expect(later.created).toBe(true);
    expect(later.job.renderId > first.job.renderId).toBe(true);
    gate.resolve();
    await runner.idle();
    // Once finished, the same revision renders again on request.
    expect((await runner.request(production, "instagram")).created).toBe(true);
    await runner.idle();
    const ids = (await runner.list(production.id)).map((j) => j.renderId);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("renders the snapshot taken at request time, whatever happens to the production afterwards", async () => {
    const gate = deferred();
    const pipeline = fakePipeline(() => gate.promise);
    const runner = jobs(pipeline);
    await runner.start();
    const production = footageProduction();
    const { job } = await runner.request(production, "instagram");
    production.name = "Edited while rendering";
    production.timeline.tracks.splice(0);
    gate.resolve();
    await runner.idle();
    const snapshot = pipeline.calls[0].request.production;
    expect(snapshot.name).toBe(footageProduction().name);
    expect(snapshot.timeline).toEqual(footageProduction().timeline);
    expect((await runner.readRequest(job.productionId, job.renderId))!.production).toEqual(footageProduction());
  });

  it("lists nothing for unknown or invalid production ids", async () => {
    const runner = jobs(fakePipeline());
    expect(await runner.list("prod-none")).toEqual([]);
    expect(await runner.list("../etc")).toEqual([]);
    expect(await runner.read("prod-none", "../../x")).toBeNull();
  });
});
