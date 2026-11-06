/**
 * Render pipelines for tests that exercise render jobs and the render API
 * without FFmpeg or Chromium: `fakePipeline` writes small stand-in files and
 * returns a manifest and verification report built from the request.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { RenderManifest } from "@/lib/video/render/manifest";
import type { RenderPipeline, RenderPipelineInput } from "@/lib/video/render/render-record";
import type { VerificationReport } from "@/lib/video/render/verify";

export const PASSING: VerificationReport = {
  ok: true,
  checks: [
    { id: "video_codec", status: "passed", expected: "h264", actual: "h264" },
    { id: "integrated_loudness", status: "skipped", expected: -14, actual: null, reason: "the production has no sound" },
  ],
};

export const FAILING: VerificationReport = {
  ok: false,
  checks: [
    { id: "video_codec", status: "passed", expected: "h264", actual: "h264" },
    { id: "faststart", status: "failed", expected: "moov before mdat", actual: "ftyp,mdat,moov" },
  ],
};

export function fakeManifest(input: RenderPipelineInput, verification: VerificationReport): RenderManifest {
  const { request } = input;
  const format = request.production.format;
  return {
    schemaVersion: 1,
    renderId: request.renderId,
    productionId: request.productionId,
    revision: request.revision,
    profile: { id: request.profileId, version: 1 },
    planVersion: 1,
    compilerVersion: 1,
    canvas: { width: format.width, height: format.height, fps: format.fps },
    durationFrames: 30,
    inputs: [],
    fonts: [],
    overlay: { sha256: "0".repeat(64), framesCaptured: 0, digest: "0".repeat(64) },
    tools: { ffmpeg: "test", chrome: "test", puppeteer: "test", node: process.versions.node },
    chromeArgsSha256: "0".repeat(64),
    workers: 1,
    loudness: { targetLufs: -14, truePeakCeilingDb: -1, measured: null, normalisation: "no-audio" },
    verification,
    outputs: [],
    timings: { overlayMs: 0, videoMs: 0, audioMs: 0, executeMs: 0, verifyMs: 0 },
    createdAt: "2026-11-06T00:00:00.000Z",
  };
}

/** Writes the three pipeline files; `video.mp4` holds `bytes` so Range reads can be checked. */
export async function writeOutputs(workDir: string, bytes = "0123456789abcdefghij"): Promise<void> {
  await writeFile(path.join(workDir, "video.mp4"), bytes);
  await writeFile(path.join(workDir, "captions.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHello\n\n");
  await writeFile(path.join(workDir, "captions.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n");
}

export interface FakePipeline extends RenderPipeline {
  calls: RenderPipelineInput[];
}

/**
 * A pipeline that runs `step` (when given) and then writes its outputs and
 * returns `verification`. `step` may throw to fail the attempt or wait on the
 * signal to model a long render.
 */
export function fakePipeline(step?: (input: RenderPipelineInput, call: number) => Promise<void>, verification: VerificationReport = PASSING): FakePipeline {
  const calls: RenderPipelineInput[] = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      await step?.(input, calls.length);
      await writeOutputs(input.workDir);
      return { manifest: fakeManifest(input, verification), verification };
    },
  };
}

/** Resolves when the signal aborts, then throws the way the real executor does. */
export function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error("render was cancelled"), { name: "AbortError" }));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
