/**
 * The media registry, its facts and its derived-files jobs (#140), with real
 * synthetic media made by FFmpeg in a temporary data directory: byte-identical
 * read-only originals, deduplication, refused inputs, the ledger, proxies that
 * are upright SDR H.264, and jobs that run once, recover after a restart,
 * classify failures and can be retried.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseProbe } from "@/lib/video/media/facts";
import { classify, MediaJobs, type Builder, type MediaJob } from "@/lib/video/media/jobs";
import { fitSize, peaksPerSecond, ProxyFailure } from "@/lib/video/media/proxy";
import { ImportFailure, MediaRegistry } from "@/lib/video/media/registry";
import { ToolError } from "@/lib/video/media/tools";
import { FFMPEG_MISSING, HDR_MISSING, keyframeTimes, makeMedia, probeVideo } from "./helpers/media-fixtures";

let work: string;
let dataDir: string;
let sources: string;

beforeEach(async () => {
  work = await realpath(await mkdtemp(path.join(tmpdir(), "cb-media-")));
  dataDir = path.join(work, "data");
  sources = path.join(work, "footage");
  await mkdir(dataDir, { recursive: true });
  await mkdir(sources, { recursive: true });
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const sha256 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
const quiet = () => undefined;

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ImportFailure);
  return (error as ImportFailure).code;
}

// ---------------------------------------------------------------------------

describe("probe parsing", () => {
  const probe = (streams: unknown[], format: Record<string, unknown> = { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.000000" }) =>
    parseProbe(JSON.stringify({ format, streams }));
  const video = (extra: Record<string, unknown> = {}) => ({ codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, r_frame_rate: "30/1", avg_frame_rate: "30/1", ...extra });

  it("reads rotation from the display matrix as the clockwise turn a player applies", () => {
    expect(probe([video({ side_data_list: [{ rotation: 90 }] })]).video!.rotation).toBe(270);
    expect(probe([video({ side_data_list: [{ rotation: -90 }] })]).video!.rotation).toBe(90);
    expect(probe([video()]).video!.rotation).toBe(0);
  });

  it("flags HLG and PQ transfer as HDR and records variable frame rate", () => {
    expect(probe([video({ color_transfer: "arib-std-b67" })]).video!.dynamicRange).toBe("hlg");
    expect(probe([video({ color_transfer: "smpte2084" })]).video!.dynamicRange).toBe("pq");
    expect(probe([video({ avg_frame_rate: "2400/100" })]).video!.variableFrameRate).toBe(true);
  });

  it("treats cover art as decoration and a lone picture as an image", () => {
    const facts = probe([{ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 }, video({ codec_name: "mjpeg", disposition: { attached_pic: 1 } })]);
    expect(facts.kind).toBe("audio");
    expect(probe([video({ codec_name: "png" })], { format_name: "png_pipe" }).kind).toBe("image");
  });

  it("refuses anything that is not clearly media, and absurd values", () => {
    expect(() => parseProbe("not json")).toThrow();
    expect(() => probe([])).toThrow();
    expect(() => probe([video({ width: 100000 })])).toThrow();
    expect(() => probe([video()], { format_name: "mov", duration: String(7 * 3600) })).toThrow();
    expect(() => probe([video()], { format_name: "mov" })).toThrow(); // video without a duration
  });

  it("sizes previews upright inside a box of the same orientation", () => {
    expect(fitSize(3840, 2160, 0, { w: 540, h: 960 })).toEqual({ w: 960, h: 540 });
    expect(fitSize(3840, 2160, 90, { w: 540, h: 960 })).toEqual({ w: 540, h: 960 });
    expect(fitSize(320, 240, 0, { w: 540, h: 960 })).toEqual({ w: 320, h: 240 });
    expect(peaksPerSecond(60_000_000)).toBe(100);
    expect(peaksPerSecond(6 * 3600 * 1_000_000)).toBe(4);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(FFMPEG_MISSING)(`importing files${FFMPEG_MISSING ? ` (skipped: ${FFMPEG_MISSING})` : ""}`, () => {
  it("keeps a byte-identical, read-only original named by its SHA-256, with its facts and provenance", async () => {
    const file = await makeMedia(sources, "video");
    const registry = new MediaRegistry({ dataDir, now: () => "2026-11-06T00:00:00.000Z" });
    const { record, created } = await registry.importPath(file);
    expect(created).toBe(true);
    expect(record.mediaId).toBe(await sha256(file));
    const stored = registry.originalPath(record);
    expect(await sha256(stored)).toBe(record.mediaId);
    expect((await stat(stored)).mode & 0o222).toBe(0);
    expect(record).toMatchObject({ kind: "video", originalName: "clip.mp4", extension: ".mp4", provenance: { source: "local-file", rights: "user-supplied" } });
    expect(record.facts.video).toMatchObject({ codec: "h264", width: 1280, height: 720, rotation: 0, dynamicRange: "sdr" });
    expect(record.facts.audio).toMatchObject({ codec: "aac", sampleRate: 48000 });
    expect(record.facts.durationUs).toBeGreaterThan(1_900_000);
    expect(JSON.stringify(record)).not.toContain(sources);
  });

  it("returns the existing media for identical bytes, without a second copy", async () => {
    const file = await makeMedia(sources, "audio");
    const copy = path.join(sources, "copy-of-tone.m4a");
    await writeFile(copy, await readFile(file));
    const registry = new MediaRegistry({ dataDir });
    const first = await registry.importPath(file);
    const again = await new MediaRegistry({ dataDir }).importPath(copy);
    expect(again).toMatchObject({ created: false, record: { mediaId: first.record.mediaId, originalName: "tone.m4a" } });
    expect(await readdir(path.join(dataDir, "video-media", "objects"))).toEqual([first.record.mediaId]);
    expect(await readdir(path.join(dataDir, "video-media", "tmp"))).toEqual([]);
  });

  it("publishes once when the same bytes are imported concurrently", async () => {
    const file = await makeMedia(sources, "image");
    const results = await Promise.all([1, 2, 3].map(() => new MediaRegistry({ dataDir }).importPath(file)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.record.mediaId)).size).toBe(1);
  });

  it("refuses folders, links, files in the data folder, relative paths, oversized and missing files", async () => {
    const registry = new MediaRegistry({ dataDir, maxImportBytes: 1024 });
    const file = await makeMedia(sources, "video");
    const link = path.join(sources, "link.mp4");
    await symlink(file, link);
    const inside = path.join(dataDir, "uploads", "clip.mp4");
    await mkdir(path.dirname(inside), { recursive: true });
    await writeFile(inside, await readFile(file));

    expect(await refusal(registry.importPath(sources))).toBe("not_a_file");
    expect(await refusal(registry.importPath(link))).toBe("not_a_file");
    expect(await refusal(new MediaRegistry({ dataDir }).importPath(inside))).toBe("inside_data_directory");
    expect(await refusal(registry.importPath("footage/clip.mp4"))).toBe("invalid_path");
    expect(await refusal(registry.importPath(42))).toBe("invalid_path");
    expect(await refusal(registry.importPath(path.join(sources, "missing.mp4")))).toBe("not_found");
    expect(await refusal(registry.importPath(file))).toBe("too_large");
    expect(await readdir(dataDir)).toEqual(["uploads"]);
  });

  it("refuses a file that is not media without copying it", async () => {
    const text = path.join(sources, "notes.mp4");
    await writeFile(text, "these are not frames\n".repeat(100));
    const registry = new MediaRegistry({ dataDir });
    expect(await refusal(registry.importPath(text))).toBe("unsupported_media");
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("is the asset ledger: kinds and durations of what was imported", async () => {
    const registry = new MediaRegistry({ dataDir });
    const video = (await registry.importPath(await makeMedia(sources, "video"))).record;
    const image = (await registry.importPath(await makeMedia(sources, "image"))).record;
    const ledger = await new MediaRegistry({ dataDir }).ledger();
    expect(ledger.get(video.mediaId)).toEqual({ kind: "video", durationUs: video.facts.durationUs });
    expect(ledger.get(image.mediaId)).toEqual({ kind: "image" });
    expect(ledger.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------

async function jobOf(jobs: MediaJobs, mediaId: string): Promise<MediaJob> {
  const job = await jobs.read(mediaId);
  if (!job) throw new Error("no job");
  return job;
}

describe.skipIf(FFMPEG_MISSING)(`derived files${FFMPEG_MISSING ? ` (skipped: ${FFMPEG_MISSING})` : ""}`, () => {
  async function importAndBuild(kind: Parameters<typeof makeMedia>[1]) {
    const registry = new MediaRegistry({ dataDir });
    const jobs = new MediaJobs(registry, { log: quiet });
    registry.onPublished = (r) => void jobs.enqueue(r.mediaId);
    const { record } = await registry.importPath(await makeMedia(sources, kind));
    await jobs.enqueue(record.mediaId);
    await jobs.idle();
    return { registry, jobs, record, job: await jobOf(jobs, record.mediaId) };
  }

  it("makes an H.264 SDR proxy with short GOPs, a poster and peaks for a video, leaving the original unchanged", async () => {
    const { registry, record, job } = await importAndBuild("video");
    expect(job).toMatchObject({ state: "succeeded", attempts: 1, output: { files: ["proxy.mp4", "poster.jpg", "peaks.json"], color: "sdr" } });
    const proxy = await probeVideo(registry.derivedPath(record.mediaId, "proxy.mp4"));
    expect(proxy).toMatchObject({ codec_name: "h264", width: 960, height: 540, pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" });
    const poster = await probeVideo(registry.derivedPath(record.mediaId, "poster.jpg"));
    expect(poster).toMatchObject({ width: 960, height: 540 });
    const peaks = JSON.parse(await readFile(registry.derivedPath(record.mediaId, "peaks.json"), "utf-8"));
    expect(peaks.peaksPerSecond).toBe(100);
    expect(peaks.peaks.length).toBeGreaterThanOrEqual(199);
    // FFmpeg's test tone plays at one eighth of full scale: about 32 of 255.
    expect(Math.max(...peaks.peaks)).toBeGreaterThan(25);
    expect(Math.max(...peaks.peaks)).toBeLessThan(60);
    // A keyframe every 15 frames (half a second at 30 fps) for scrubbing.
    expect(await keyframeTimes(registry.derivedPath(record.mediaId, "proxy.mp4"))).toEqual([0, 0.5, 1, 1.5]);
    expect(await sha256(registry.originalPath(record))).toBe(record.mediaId);
    expect(await readdir(path.join(dataDir, "video-media", "tmp"))).toEqual([]);
  });

  it("turns phone-style rotated video upright and drops the rotation flag", async () => {
    const { registry, record, job } = await importAndBuild("video-portrait");
    expect(record.facts.video!.rotation).toBe(270);
    expect(job.state).toBe("succeeded");
    const proxy = await probeVideo(registry.derivedPath(record.mediaId, "proxy.mp4"));
    expect(proxy).toMatchObject({ width: 540, height: 960 });
    expect(proxy.side_data_list?.some((d) => d.rotation)).toBeFalsy();
  });

  it("makes an AAC proxy and peaks for audio, and a transparent PNG for an image", async () => {
    const audio = await importAndBuild("audio");
    expect(audio.job.output!.files).toEqual(["proxy.m4a", "peaks.json"]);
    const image = await importAndBuild("image");
    expect(image.job.output!.files).toEqual(["proxy.png"]);
    expect(await probeVideo(image.registry.derivedPath(image.record.mediaId, "proxy.png"))).toMatchObject({ width: 400, height: 200, pix_fmt: "rgba" });
  });

  it.skipIf(HDR_MISSING)(`converts rotated HLG video to an upright BT.709 SDR proxy on VideoToolbox${HDR_MISSING ? ` (skipped: ${HDR_MISSING})` : ""}`, async () => {
    const { registry, record, job } = await importAndBuild("hdr-portrait");
    expect(record.facts.video).toMatchObject({ dynamicRange: "hlg", rotation: 270 });
    expect(job).toMatchObject({ state: "succeeded", output: { color: "hdr-converted" } });
    const proxy = await probeVideo(registry.derivedPath(record.mediaId, "proxy.mp4"));
    expect(proxy).toMatchObject({ codec_name: "h264", width: 540, height: 960, color_transfer: "bt709", color_primaries: "bt709" });
    expect(proxy.side_data_list?.some((d) => d.rotation)).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------

describe("job lifecycle", () => {
  /** A registry with one registered image record, without FFmpeg. */
  async function oneMedia() {
    const registry = new MediaRegistry({ dataDir });
    const mediaId = "e".repeat(64);
    const dir = registry.objectDir(mediaId);
    await mkdir(dir, { recursive: true });
    const record = {
      version: 1,
      mediaId,
      kind: "image",
      originalName: "logo.png",
      extension: ".png",
      sizeBytes: 4,
      importedAt: "2026-11-06T00:00:00.000Z",
      facts: { kind: "image", container: "png_pipe" },
      provenance: { source: "local-file", rights: "user-supplied" },
    };
    await writeFile(path.join(dir, "record.json"), JSON.stringify(record));
    await writeFile(path.join(dir, "original.png"), "png!");
    return { registry, mediaId };
  }

  const succeedWith: Builder = async (_record, _original, dir) => {
    await writeFile(path.join(dir, "proxy.png"), "preview");
    return { files: ["proxy.png"], color: "sdr" };
  };

  it("queues media found without a job and runs one job at a time", async () => {
    const { registry, mediaId } = await oneMedia();
    const second = "f".repeat(64);
    await mkdir(registry.objectDir(second), { recursive: true });
    await writeFile(path.join(registry.objectDir(second), "record.json"), (await readFile(path.join(registry.objectDir(mediaId), "record.json"), "utf-8")).replaceAll("e".repeat(64), second));
    let running = 0;
    let most = 0;
    const builder: Builder = async (...args) => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return succeedWith(...args);
    };
    const jobs = new MediaJobs(registry, { builder, log: quiet });
    await jobs.start();
    await jobs.enqueue(mediaId);
    await jobs.idle();
    expect(most).toBe(1);
    expect((await jobOf(jobs, mediaId)).state).toBe("succeeded");
    expect((await jobOf(jobs, second)).state).toBe("succeeded");
    expect(await readFile(registry.derivedPath(mediaId, "proxy.png"), "utf-8")).toBe("preview");
  });

  it("retries a transient failure and then succeeds", async () => {
    const { registry, mediaId } = await oneMedia();
    let calls = 0;
    const builder: Builder = async (...args) => {
      if (++calls === 1) throw new ToolError("timeout", "ffmpeg did not finish");
      return succeedWith(...args);
    };
    const jobs = new MediaJobs(registry, { builder, backoff: () => 1, log: quiet });
    await jobs.start();
    await jobs.idle();
    const job = await jobOf(jobs, mediaId);
    expect(job).toMatchObject({ state: "succeeded", attempts: 2 });
    expect(job.history.map((h) => h.event)).toEqual(["queued", "started", "failed", "started", "succeeded"]);
  });

  it("stops after the last transient attempt, fails a permanent error at once, and lets a person retry", async () => {
    const { registry, mediaId } = await oneMedia();
    let mode: "timeout" | "broken" | "fine" = "timeout";
    const builder: Builder = async (...args) => {
      if (mode === "timeout") throw new ToolError("timeout", "slow");
      if (mode === "broken") throw new ToolError("failed", "exit 1", 1);
      return succeedWith(...args);
    };
    const jobs = new MediaJobs(registry, { builder, backoff: () => 1, log: quiet });
    await jobs.start();
    await jobs.idle();
    expect(await jobOf(jobs, mediaId)).toMatchObject({ state: "failed", attempts: 3, failure: { failureClass: "transient", code: "timeout" } });
    expect(await registry.get(mediaId)).not.toBeNull();

    mode = "broken";
    expect((await jobs.retry(mediaId)).ok).toBe(true);
    await jobs.idle();
    expect(await jobOf(jobs, mediaId)).toMatchObject({ state: "failed", attempts: 1, failure: { failureClass: "permanent", code: "tool_failed" } });

    mode = "fine";
    expect((await jobs.retry(mediaId)).ok).toBe(true);
    await jobs.idle();
    expect((await jobOf(jobs, mediaId)).state).toBe("succeeded");
    expect(await jobs.retry(mediaId)).toMatchObject({ ok: false, code: "not_failed" });
    expect(await jobs.retry("0".repeat(64))).toMatchObject({ ok: false, code: "not_found" });
  });

  it("classifies configuration and disk problems", () => {
    expect(classify(new ToolError("missing", "no ffmpeg")).failureClass).toBe("configuration");
    expect(classify(new ProxyFailure("configuration", "hdr_conversion_unavailable", "x")).code).toBe("hdr_conversion_unavailable");
    expect(classify(Object.assign(new Error("full"), { code: "ENOSPC" })).failureClass).toBe("transient");
    expect(classify(new Error("other")).failureClass).toBe("permanent");
  });

  it("re-queues a job a stopped process left running, and leaves one a live process holds", async () => {
    const { registry, mediaId } = await oneMedia();
    const interrupted: MediaJob = {
      version: 1,
      mediaId,
      state: "running",
      attempts: 1,
      updatedAt: "2026-11-06T00:00:00.000Z",
      owner: { pid: 2 ** 22 + 12345, host: (await import("node:os")).hostname(), instance: "gone" },
      history: [{ at: "2026-11-06T00:00:00.000Z", event: "started" }],
    };
    const jobFile = path.join(registry.objectDir(mediaId), "job.json");
    await writeFile(jobFile, JSON.stringify(interrupted));
    // The stopped process's lock is still there too.
    await writeFile(path.join(registry.objectDir(mediaId), "job.lock"), JSON.stringify(interrupted.owner));
    const jobs = new MediaJobs(registry, { builder: succeedWith, log: quiet });
    await jobs.start();
    await jobs.idle();
    const job = await jobOf(jobs, mediaId);
    expect(job.state).toBe("succeeded");
    expect(job.history.map((h) => h.event)).toEqual(["started", "interrupted", "started", "succeeded"]);
    expect(await readdir(registry.objectDir(mediaId))).not.toContain("job.lock");

    // A live process (this test's parent) holding the lock is respected.
    const held = { ...interrupted, owner: { ...interrupted.owner!, pid: process.ppid, instance: "other" } };
    await writeFile(jobFile, JSON.stringify({ ...held, state: "queued" }));
    await writeFile(path.join(registry.objectDir(mediaId), "job.lock"), JSON.stringify(held.owner));
    let built = false;
    const other = new MediaJobs(registry, {
      builder: async (...args) => {
        built = true;
        return succeedWith(...args);
      },
      log: quiet,
    });
    await other.start();
    await other.idle();
    expect(built).toBe(false);
    expect((await jobOf(other, mediaId)).state).toBe("queued");
  });

  it("never publishes part of a failed attempt", async () => {
    const { registry, mediaId } = await oneMedia();
    const builder: Builder = async (_r, _o, dir) => {
      await writeFile(path.join(dir, "proxy.png"), "half");
      throw new ToolError("failed", "exit 1", 1);
    };
    const jobs = new MediaJobs(registry, { builder, log: quiet });
    await jobs.start();
    await jobs.idle();
    expect(await readdir(registry.objectDir(mediaId))).not.toContain("proxy.png");
    expect(await readdir(path.join(dataDir, "video-media", "tmp"))).toEqual([]);
  });
});
