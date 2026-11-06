/**
 * The overlay renderer (#144, ADR decision 3): draws the frames of one
 * script-free overlay document with hardened Chromium browsers
 * (`OverlayBrowser`, one per worker) and hands them over in frame order as
 * RGBA PNGs.
 *
 * - Only frames inside `activeRanges` are captured; every other frame is one
 *   cached transparent PNG. The captured frames are split into fixed chunks
 *   of `CHUNK_FRAMES`, dealt round-robin to the workers, and reassembled in
 *   order through a window of `workers + 1` chunks, so memory stays bounded
 *   however long the render is.
 * - Each chunk starts on a freshly loaded document. Chromium keeps a moving
 *   layer's raster from earlier frames, so a frame with animated text
 *   depended on which frames the same page drew before it (measured: 6 of
 *   16 frames of a sliding lower third differed between 1 and 4 workers).
 *   With fixed chunks every frame has the same history at any worker count,
 *   and the frames are identical.
 * - The digest is SHA-256 over the captured screenshots' own PNG bytes, in
 *   frame order; the transparent frames are not part of it.
 * - On an abort or any failure every browser is killed, and `close()` waits
 *   for each to exit (SIGKILL when a clean close does not finish quickly).
 */
import { createHash } from "node:crypto";

import { RenderFailure, type FontAsset, type OverlayDocument } from "./execute-types";
import { browserFailure, DEFAULT_FRAME_DEADLINE_MS, DEFAULT_LOAD_DEADLINE_MS, interrupted, OverlayBrowser, servedFiles, type BrowserSettings } from "./overlay-browser";
import { toRgbaPng, transparentPng } from "./overlay-png";

/** Captured frames per chunk, each drawn on a freshly loaded document. Independent of the worker count by design. */
export const CHUNK_FRAMES = 15;

export interface OverlayRendererOptions {
  executablePath: string;
  overlay: OverlayDocument;
  fonts: readonly FontAsset[];
  canvas: { width: number; height: number };
  fps: number;
  durationFrames: number;
  /** Browsers to run; fewer are launched when there are fewer frames to capture. */
  workers: number;
  /** A folder for the browsers' profiles, inside the render's scratch folder. */
  profileDir: string;
  signal: AbortSignal;
  frameDeadlineMs?: number;
  loadDeadlineMs?: number;
}

export interface OverlayStreamResult {
  framesCaptured: number;
  /** SHA-256 over the screenshots' PNG bytes, in frame order. */
  digest: string;
}

/** The frames to capture, from sorted, disjoint `[startFrame, endFrame)` ranges inside the render. */
function framesToCapture(ranges: OverlayDocument["activeRanges"], durationFrames: number): number[] {
  const frames: number[] = [];
  let previousEnd = 0;
  for (const range of ranges) {
    const { startFrame, endFrame } = range;
    if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || startFrame < previousEnd || endFrame <= startFrame || endFrame > durationFrames) {
      throw new RenderFailure("permanent", "internal_error", "the overlay document's active ranges are not sorted, disjoint frame ranges inside the render");
    }
    for (let frame = startFrame; frame < endFrame; frame++) frames.push(frame);
    previousEnd = endFrame;
  }
  return frames;
}

export class OverlayRenderer {
  private failure: unknown = null;
  private closed = false;
  private readonly onAbort = () => this.fail(interrupted());

  private constructor(
    private readonly browsers: OverlayBrowser[],
    private readonly frames: number[],
    private readonly transparent: Buffer,
    private readonly options: OverlayRendererOptions
  ) {
    options.signal.addEventListener("abort", this.onAbort);
  }

  /** Launches the workers' browsers and loads the document in each. Throws RenderFailure. */
  static async open(options: OverlayRendererOptions): Promise<OverlayRenderer> {
    if (options.signal.aborted) throw interrupted();
    const { width, height } = options.canvas;
    if (!Number.isSafeInteger(options.workers) || options.workers < 1) throw new RenderFailure("permanent", "internal_error", "the overlay renderer needs at least one worker");
    const frames = framesToCapture(options.overlay.activeRanges, options.durationFrames);
    const settings: BrowserSettings = {
      signal: options.signal,
      executablePath: options.executablePath,
      profileDir: options.profileDir,
      canvas: options.canvas,
      fps: options.fps,
      frameDeadlineMs: options.frameDeadlineMs ?? DEFAULT_FRAME_DEADLINE_MS,
      loadDeadlineMs: options.loadDeadlineMs ?? DEFAULT_LOAD_DEADLINE_MS,
      served: servedFiles(options.overlay, options.fonts),
    };
    // The document is always loaded and checked in at least one browser, even with nothing to capture.
    const count = Math.max(1, Math.min(options.workers, Math.ceil(frames.length / CHUNK_FRAMES)));
    const launches = await Promise.allSettled(Array.from({ length: count }, (_, index) => OverlayBrowser.launch(index, settings)));
    const browsers = launches.flatMap((launch) => (launch.status === "fulfilled" ? [launch.value] : []));
    const failed = launches.find((launch): launch is PromiseRejectedResult => launch.status === "rejected");
    if (failed || options.signal.aborted) {
      await Promise.all(browsers.map((browser) => browser.close()));
      throw options.signal.aborted ? interrupted() : browserFailure(failed!.reason);
    }
    return new OverlayRenderer(browsers, frames, transparentPng(width, height), options);
  }

  get chromeVersion(): string {
    return this.browsers[0].version;
  }

  /** The browsers' process ids, for diagnostics and tests. */
  get pids(): number[] {
    return this.browsers.map((browser) => browser.pid);
  }

  private fail(error: unknown): void {
    if (this.failure === null) this.failure = error;
    for (const browser of this.browsers) browser.kill(error instanceof RenderFailure ? error : undefined);
    this.wake();
  }

  private wakeWaiters: (() => void)[] = [];

  private wake(): void {
    const waiters = this.wakeWaiters;
    this.wakeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private changed(): Promise<void> {
    return new Promise((resolve) => this.wakeWaiters.push(resolve));
  }

  /**
   * Writes every frame of the render, in order, through `write`: a captured
   * RGBA PNG inside the active ranges, the transparent PNG elsewhere. A
   * rejection from `write` stops the stream and is rethrown unchanged; every
   * other failure is a RenderFailure.
   */
  async stream(write: (png: Buffer) => Promise<void>, onCaptured?: (done: number, total: number) => void): Promise<OverlayStreamResult> {
    if (this.closed) throw new RenderFailure("permanent", "internal_error", "the overlay renderer is closed");
    const { width, height } = this.options.canvas;
    const total = this.frames.length;
    const workers = this.browsers.length;
    const chunks = Math.ceil(total / CHUNK_FRAMES);
    const ready = new Map<number, { raw: Buffer; png: Buffer }>();
    let written = 0;

    const worker = async (index: number) => {
      const browser = this.browsers[index];
      for (let chunk = index; chunk < chunks; chunk += workers) {
        // At most `workers + 1` chunks are drawn or waiting ahead of the writer.
        while (chunk > Math.floor(written / CHUNK_FRAMES) + workers && this.failure === null) await this.changed();
        if (this.failure !== null) return;
        await browser.prepare();
        for (let k = chunk * CHUNK_FRAMES; k < Math.min(total, (chunk + 1) * CHUNK_FRAMES); k++) {
          if (this.failure !== null) return;
          const raw = await browser.capture(this.frames[k]);
          ready.set(k, { raw, png: toRgbaPng(raw, width, height) });
          this.wake();
        }
      }
    };

    const writer = async (): Promise<string> => {
      const digest = createHash("sha256");
      for (let frame = 0; frame < this.options.durationFrames; frame++) {
        if (this.failure !== null) break;
        if (written < total && this.frames[written] === frame) {
          while (!ready.has(written) && this.failure === null) await this.changed();
          const entry = ready.get(written);
          if (!entry) break;
          ready.delete(written);
          digest.update(entry.raw);
          written++;
          this.wake();
          await write(entry.png);
          onCaptured?.(written, total);
        } else {
          await write(this.transparent);
        }
      }
      return digest.digest("hex");
    };

    const workerRuns = this.browsers.map((_, index) =>
      worker(index).catch((error) => this.fail(this.browsers[index].explain(error)))
    );
    const digest = await writer().catch((error) => {
      this.fail(error);
      return "";
    });
    await Promise.all(workerRuns);
    if (this.failure === null) {
      try {
        for (const browser of this.browsers) browser.check();
      } catch (error) {
        this.fail(error);
      }
    }
    if (this.failure !== null) throw this.failure;
    return { framesCaptured: total, digest };
  }

  /** Stops every browser and waits for each to exit. Safe to call more than once. */
  async close(): Promise<void> {
    this.closed = true;
    this.options.signal.removeEventListener("abort", this.onAbort);
    await Promise.all(this.browsers.map((browser) => browser.close()));
    this.wake();
  }
}
