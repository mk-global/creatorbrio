/**
 * The render executor (#144): turns a compiled plan and its export overlay
 * document into an encoded MP4 inside the caller's scratch folder.
 *
 *   1. Preflight: FFmpeg present (`tool_missing`), recent enough
 *      (`ffmpeg_too_old`), with libx264 and AAC (`encoder_missing`), with the
 *      VideoToolbox HDR conversion when an input is HLG or PQ
 *      (`hdr_conversion_unavailable`), and a Chromium (`browser_missing`), all
 *      configuration failures.
 *   2. In parallel: the overlay browsers start and load the document
 *      (`overlay-renderer.ts`), and the sound is mixed and normalised to the
 *      plan's loudness under the profile's true-peak ceiling
 *      (`audio-master.ts`).
 *   3. One FFmpeg run composites the footage from the originals, reads the
 *      overlay frames from stdin as the browsers capture them, and encodes
 *      `render.mp4` with the profile. It must write exactly `durationFrames`
 *      frames with none duplicated or dropped, or the render fails.
 *
 * Every deadline scales with the render's length. An abort (`signal`) or any
 * failure kills every browser and FFmpeg process, and the executor settles
 * only once they have exited. The first failure is the one reported: work
 * stopped because of it never replaces it, and an abort is always
 * `interrupted`. Failures are RenderFailures whose messages carry no paths.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import { hdrConversionAvailable } from "@/lib/video/media/proxy";
import { ffmpegHas, ffmpegRecentEnough, ffmpegRelease, ffmpegVersion, MIN_FFMPEG, runTool, toolPath, ToolError } from "@/lib/video/media/tools";
import { chromeExecutable, OVERLAY_CHROME_ARGS, PUPPETEER_VERSION } from "./chrome";
import { RenderFailure, type ExecuteOptions, type ExecuteResult, type RenderProgress } from "./execute-types";
import { masterAudio } from "./audio-master";
import type { AudioSourceFile } from "./ffmpeg-audio";
import { graphOptions, GraphError, runArgs, videoRun, type FfmpegRun, type VideoSourceFile } from "./ffmpeg-graph";
import { DEFAULT_FRAME_DEADLINE_MS, DEFAULT_LOAD_DEADLINE_MS } from "./overlay-browser";
import { OverlayRenderer } from "./overlay-renderer";

/** Per-render limits; the defaults suit production and tests may tighten them. */
export interface RenderLimits {
  /** How long one overlay frame may take to draw. */
  frameDeadlineMs: number;
  /** How long a browser may take to start and load the document and its fonts. */
  loadDeadlineMs: number;
}

/** The most overlay browsers one render may run. */
export const MAX_WORKERS = 16;

const VIDEO_FILE = "render.mp4";

class SinkClosed extends Error {
  constructor() {
    super("FFmpeg stopped reading the overlay frames");
    this.name = "SinkClosed";
  }
}

/** Tool time allowed for a run over `seconds` of output, at `perSecondMs` per second and at least `minimumMs`. */
function deadline(seconds: number, perSecondMs: number, minimumMs: number): number {
  return Math.max(minimumMs, Math.ceil(seconds * perSecondMs));
}

/** Maps any error to the failure it stands for. */
export function toRenderFailure(error: unknown): RenderFailure {
  if (error instanceof RenderFailure) return error;
  if (error instanceof GraphError) return new RenderFailure("permanent", "internal_error", error.message);
  if (error instanceof ToolError) {
    if (error.reason === "missing") return new RenderFailure("configuration", "tool_missing", error.message);
    if (error.reason === "timeout") return new RenderFailure("transient", "timeout", error.message);
    if (error.reason === "aborted") return new RenderFailure("transient", "interrupted", "the render was cancelled");
    return new RenderFailure("permanent", "tool_failed", `FFmpeg could not render this production (${error.message})`);
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EIO" || code === "EMFILE" || code === "ENFILE" || code === "EBUSY") {
    return new RenderFailure("transient", "io_error", `the disk could not be written (${code})`);
  }
  return new RenderFailure("permanent", "internal_error", "the render failed unexpectedly");
}

/** Keeps the first failure, and stops everything else when there is one. */
class FailureLatch {
  private readonly controller = new AbortController();
  first: RenderFailure | null = null;

  constructor(outer: AbortSignal) {
    const onAbort = () => this.fail(new RenderFailure("transient", "interrupted", "the render was cancelled"));
    if (outer.aborted) onAbort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  fail(error: unknown): void {
    if (!this.first) this.first = toRenderFailure(error);
    this.controller.abort();
  }

  /** Throws the recorded failure, if any. */
  check(): void {
    if (this.first) throw this.first;
  }
}

function preflight(options: ExecuteOptions): string {
  const { plan } = options;
  if (!toolPath("ffmpeg")) throw new RenderFailure("configuration", "tool_missing", "FFmpeg is not installed");
  if (!ffmpegRecentEnough()) throw new RenderFailure("configuration", "ffmpeg_too_old", `rendering needs FFmpeg ${MIN_FFMPEG.major}.${MIN_FFMPEG.minor} or newer`);
  for (const encoder of [options.profile.video.encoder, options.profile.audio.codec]) {
    if (!ffmpegHas("encoders", encoder)) throw new RenderFailure("configuration", "encoder_missing", `this FFmpeg has no ${encoder} encoder`);
  }
  if (plan.inputs.some((input) => input.kind === "video" && input.dynamicRange !== "sdr") && !hdrConversionAvailable()) {
    throw new RenderFailure("configuration", "hdr_conversion_unavailable", "HDR footage needs FFmpeg with VideoToolbox (scale_vt) to render on this computer");
  }
  const chrome = chromeExecutable();
  if (!chrome) throw new RenderFailure("configuration", "browser_missing", "no Chromium is installed for the overlay renderer (npx puppeteer browsers install chrome)");
  return chrome;
}

function checkOptions(options: ExecuteOptions): void {
  const { plan, profile } = options;
  const internal = (message: string) => new RenderFailure("permanent", "internal_error", message);
  if (plan.profile !== profile.id) throw internal("the plan was compiled for another export profile");
  if (!Number.isSafeInteger(plan.durationFrames) || plan.durationFrames < 1) throw internal("the plan has no frames");
  if (!Number.isSafeInteger(options.workers) || options.workers < 1 || options.workers > MAX_WORKERS) throw internal(`workers must be between 1 and ${MAX_WORKERS}`);
  if (!path.isAbsolute(options.workDir)) throw internal("the scratch folder must be an absolute path");
}

/** The originals the runs read, by media id. */
function sourceFiles(options: ExecuteOptions): { audio: Map<string, AudioSourceFile>; video: Map<string, VideoSourceFile> } {
  const audio = new Map<string, AudioSourceFile>();
  const video = new Map<string, VideoSourceFile>();
  for (const input of options.plan.inputs) {
    const media = options.media.get(input.mediaId);
    if (!media || !path.isAbsolute(media.originalPath)) throw new RenderFailure("permanent", "internal_error", "a media the plan reads has no original");
    video.set(input.mediaId, { path: media.originalPath, input });
    const channels = media.record.facts.audio?.channels;
    if (channels !== undefined) audio.set(input.mediaId, { path: media.originalPath, channels });
  }
  for (const source of options.plan.audio) {
    if (!audio.has(source.mediaId)) throw new RenderFailure("permanent", "internal_error", "the plan asks for sound from a media without an audio stream");
  }
  return { audio, video };
}

/** Parses FFmpeg's `-progress` key=value stream. */
class ProgressReader {
  private carry = "";
  frame = 0;
  duplicated = 0;
  dropped = 0;

  constructor(private readonly onFrame: (frame: number) => void) {}

  push(chunk: Buffer): void {
    const lines = (this.carry + chunk.toString("utf-8")).split("\n");
    this.carry = lines.pop() ?? "";
    for (const line of lines) {
      const [key, value] = line.trim().split("=", 2);
      const n = Number(value);
      if (!Number.isSafeInteger(n)) continue;
      if (key === "frame" && n !== this.frame) {
        this.frame = n;
        this.onFrame(n);
      } else if (key === "dup_frames") this.duplicated = n;
      else if (key === "drop_frames") this.dropped = n;
    }
  }
}

/**
 * Renders the plan into `<workDir>/render.mp4`. Throws RenderFailure; see the
 * module comment for the codes. `limits` is for tests and operators.
 */
export async function executeRender(options: ExecuteOptions, limits: Partial<RenderLimits> = {}): Promise<ExecuteResult> {
  const startedAt = performance.now();
  checkOptions(options);
  if (options.signal.aborted) throw new RenderFailure("transient", "interrupted", "the render was cancelled");
  const chrome = preflight(options);
  const files = sourceFiles(options);
  const { plan, profile, workDir } = options;
  const fps = plan.canvas.fps;
  const seconds = plan.durationFrames / fps;
  const version = ffmpegVersion();
  const at = (name: string) => path.join(/*turbopackIgnore: true*/ workDir, name);
  const report = (progress: RenderProgress) => {
    try {
      options.onProgress?.(progress);
    } catch {
      // A progress listener's own error must not stop or crash the render.
    }
  };

  const latch = new FailureLatch(options.signal);
  /** The options that pass a run's graph, written to a file first when it is too long for the command line. */
  const graphFor = async (name: string, ffmpeg: FfmpegRun) => {
    const graph = graphOptions(ffmpeg.graph, at(`${name}.graph`), version);
    if (graph.script !== null) await writeFile(at(`${name}.graph`), graph.script, { mode: 0o600 });
    return graph.options;
  };

  let overlay: OverlayRenderer | null = null;
  let overlayMs = 0;
  let audioMs = 0;
  let videoMs = 0;
  try {
    await mkdir(at("chrome"), { recursive: true });
    const overlayStarted = performance.now();
    const opening = OverlayRenderer.open({
      executablePath: chrome,
      overlay: options.overlay,
      fonts: options.fonts,
      canvas: { width: plan.canvas.width, height: plan.canvas.height },
      fps,
      durationFrames: plan.durationFrames,
      workers: options.workers,
      profileDir: at("chrome"),
      signal: latch.signal,
      frameDeadlineMs: limits.frameDeadlineMs ?? DEFAULT_FRAME_DEADLINE_MS,
      loadDeadlineMs: limits.loadDeadlineMs ?? DEFAULT_LOAD_DEADLINE_MS,
    }).then((renderer) => {
      overlay = renderer;
      // Opened after the render was already stopped: close it with the rest.
      if (latch.first) void renderer.close();
      return renderer;
    });

    const sound = (async () => {
      const audioStarted = performance.now();
      const mastered = await masterAudio({
        plan,
        profile,
        files: files.audio,
        at,
        graphFor,
        signal: latch.signal,
        onPass: (done, total) => report({ stage: "audio", done, total }),
      });
      audioMs = performance.now() - audioStarted;
      return mastered;
    })();

    // Failures are latched as they happen, so the first in time is the one reported, and both
    // branches are awaited so neither leaves a process running.
    opening.catch((error) => latch.fail(error));
    sound.catch((error) => latch.fail(error));
    const [opened, sounded] = await Promise.allSettled([opening, sound]);
    latch.check();
    if (opened.status !== "fulfilled" || sounded.status !== "fulfilled") throw new RenderFailure("permanent", "internal_error", "a render stage failed without a reason");
    const renderer = opened.value;
    const audio = sounded.value;

    const videoStarted = performance.now();
    const output = at(VIDEO_FILE);
    const total = plan.durationFrames;
    const encoding = videoRun(plan, profile, files.video, audio.file, output);
    const graph = await graphFor("video", encoding);
    let stdin: Writable | null = null;
    let reachedEnd = false;
    const progress = new ProgressReader((frame) => {
      report({ stage: "video", done: Math.min(frame, total), total });
      if (frame >= total && !reachedEnd) {
        reachedEnd = true;
        report({ stage: "mux", done: 0, total: 1 });
      }
    });
    const encode = runTool("ffmpeg", runArgs(encoding, graph), {
      timeoutMs: deadline(seconds, 30_000, 300_000),
      signal: latch.signal,
      maxStdout: 64 * 1024 * 1024,
      onStdout: (chunk) => progress.push(chunk),
      stdin: (input) => {
        stdin = input;
      },
    });
    const write = (png: Buffer) =>
      new Promise<void>((resolve, reject) => {
        const input = stdin as Writable | null;
        if (!input || input.destroyed || input.writableEnded) return reject(new SinkClosed());
        input.write(png, (error) => (error ? reject(new SinkClosed()) : resolve()));
      });
    const feed = renderer
      .stream(write, (done, captured) => report({ stage: "overlay", done, total: captured }))
      .then((result) => {
        overlayMs = performance.now() - overlayStarted;
        (stdin as Writable | null)?.end();
        return result;
      });
    const [fed] = await Promise.all([
      feed.catch((error) => {
        // FFmpeg exiting is reported by its own outcome, not by the write it broke.
        if (!(error instanceof SinkClosed)) latch.fail(error);
        return null;
      }),
      encode.catch((error) => {
        latch.fail(error);
        return null;
      }),
    ]);
    latch.check();
    if (!fed) throw new RenderFailure("permanent", "internal_error", "FFmpeg finished before every overlay frame was written");
    if (progress.frame !== total || progress.duplicated !== 0 || progress.dropped !== 0) {
      throw new RenderFailure(
        "permanent",
        "internal_error",
        `the encoder wrote ${progress.frame} frames (${progress.duplicated} duplicated, ${progress.dropped} dropped) where the plan has ${total}`
      );
    }
    report({ stage: "mux", done: 1, total: 1 });
    videoMs = performance.now() - videoStarted;

    return {
      videoFile: output,
      overlayFramesCaptured: fed.framesCaptured,
      overlayDigest: fed.digest,
      loudness: audio.loudness,
      tools: { ffmpeg: ffmpegRelease() ?? "unknown", chrome: renderer.chromeVersion, puppeteer: PUPPETEER_VERSION },
      chromeArgsSha256: createHash("sha256").update(OVERLAY_CHROME_ARGS.join("\n")).digest("hex"),
      // The configured count: fewer browsers start when there are fewer chunks to draw, and the frames do not depend on either.
      workers: options.workers,
      timings: { overlayMs: Math.round(overlayMs), videoMs: Math.round(videoMs), audioMs: Math.round(audioMs), totalMs: Math.round(performance.now() - startedAt) },
    };
  } catch (error) {
    latch.fail(error);
    throw latch.first!;
  } finally {
    await (overlay as OverlayRenderer | null)?.close();
  }
}
