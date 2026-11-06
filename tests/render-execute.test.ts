/**
 * The render executor end to end (#144), with real FFmpeg and Chromium on
 * synthetic media and hand-written plans and overlay documents: conformance
 * of the MP4, A/V sync after trimming and reordering, the overlay's BT.709
 * colour, determinism, the overlay browser's refusals and deadlines, the
 * sandbox, cancellation, padding of short sources, HDR input and loudness.
 * Every test checks that no Chrome or FFmpeg process it started is left.
 *
 * Skipped where FFmpeg or Chromium is missing (CI has neither, #142); the
 * pure pieces are covered by render-ffmpeg-graph.test.ts.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probeFile } from "@/lib/video/media/facts";
import type { MediaRecord } from "@/lib/video/media/registry";
import { toolPath } from "@/lib/video/media/tools";
import { chromeExecutable, OVERLAY_CHROME_ARGS } from "@/lib/video/render/chrome";
import { executeRender, type RenderLimits } from "@/lib/video/render/execute";
import { RenderFailure, type ExecuteOptions, type FontAsset, type OverlayDocument, type RenderProgress } from "@/lib/video/render/execute-types";
import { bundledFonts, OVERLAY_FONT_FAMILY } from "@/lib/video/render/fonts";
import { OverlayRenderer } from "@/lib/video/render/overlay-renderer";
import { coverPlacement, displaySize } from "@/lib/video/render/placement";
import type { AudioSource, PlanInput, RenderPlan, VideoLayer } from "@/lib/video/render/plan";
import { INSTAGRAM_PROFILE } from "@/lib/video/render/profile";
import { FFMPEG_MISSING, HDR_MISSING, makeMedia } from "./helpers/media-fixtures";

const run = promisify(execFile);
const CHROME_MISSING = chromeExecutable() ? null : "no Chromium is installed for Puppeteer (npx puppeteer browsers install chrome)";
const MISSING = FFMPEG_MISSING ?? CHROME_MISSING;

const W = 360;
const H = 640;
const FPS = 30;
const canvas = { width: W, height: H, fps: 30 as const };

let root: string;
let fonts: FontAsset[];
const media = new Map<string, { record: MediaRecord; originalPath: string }>();

async function ffmpeg(args: string[]): Promise<string> {
  const { stdout, stderr } = await run(toolPath("ffmpeg")!, ["-nostdin", "-hide_banner", ...args], { maxBuffer: 1 << 28, timeout: 120_000 });
  return stdout + stderr;
}

/** testsrc2 with a full-frame white flash on the first frame of every source second and a one-frame 1 kHz beep at the same instant (G1's fixture, smaller). */
async function flashClip(file: string, seconds: number): Promise<void> {
  await ffmpeg([
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}:d=${seconds}`,
    "-f", "lavfi", "-i", `color=white:s=${W}x${H}:r=${FPS}:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=f=1000:sample_rate=48000:d=${seconds}`,
    "-filter_complex",
    "[0:v][1:v]overlay=enable='lt(mod(n,30),1)',scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[v];[2:a]volume=enable='gte(mod(t,1),1/30)':volume=0[a]",
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "30", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", file,
  ]);
}

async function register(id: string, file: string, kind: MediaRecord["kind"]): Promise<void> {
  const facts = await probeFile(file);
  const record: MediaRecord = {
    version: 1,
    mediaId: id,
    kind,
    originalName: path.basename(file),
    extension: path.extname(file),
    sizeBytes: 1,
    importedAt: "2026-11-06T00:00:00.000Z",
    facts,
    provenance: { source: "local-file", rights: "user-supplied" },
  };
  media.set(id, { record, originalPath: file });
}

function planInput(id: string): PlanInput {
  const { record } = media.get(id)!;
  const video = record.facts.video;
  return {
    mediaId: id,
    kind: record.kind,
    ...(video ? { display: displaySize(video) } : {}),
    rotation: video?.rotation ?? 0,
    dynamicRange: video?.dynamicRange ?? "sdr",
    hasAudio: Boolean(record.facts.audio),
    ...(record.facts.durationUs === undefined ? {} : { durationUs: record.facts.durationUs }),
  };
}

function layer(id: string, startFrame: number, durationFrames: number, sourceInUs: number, trackIndex = 0): VideoLayer {
  const display = displaySize(media.get(id)!.record.facts.video!);
  return {
    clipId: `v-${id}-${startFrame}`,
    trackId: `track-${trackIndex}`,
    trackIndex,
    kind: media.get(id)!.record.kind === "image" ? "still" : "video",
    mediaId: id,
    startFrame,
    durationFrames,
    ...(media.get(id)!.record.kind === "image" ? {} : { sourceInUs }),
    placement: coverPlacement(display, { width: W, height: H }),
  };
}

function sound(id: string, startFrame: number, durationFrames: number, sourceInUs: number, role: AudioSource["role"], gain = 1, fadeUs = 0): AudioSource {
  const startUs = Math.round((startFrame * 1e6) / FPS);
  const endUs = Math.round(((startFrame + durationFrames) * 1e6) / FPS);
  const envelope = fadeUs > 0
    ? [{ atUs: startUs, gain: 0 }, { atUs: startUs + fadeUs, gain }, { atUs: endUs - fadeUs, gain }, { atUs: endUs, gain: 0 }]
    : [{ atUs: startUs, gain }, { atUs: endUs, gain }];
  return { clipId: `a-${id}-${startFrame}`, trackId: `audio-${role}`, role, mediaId: id, startFrame, durationFrames, sourceInUs, envelope };
}

function plan(durationFrames: number, video: VideoLayer[], audio: AudioSource[], size = { width: W, height: H }): RenderPlan {
  const ids = [...new Set([...video.map((l) => l.mediaId), ...audio.map((a) => a.mediaId)])];
  return {
    version: 1,
    productionId: "prod-test",
    revision: 1,
    profile: "instagram",
    canvas: { ...canvas, ...size },
    durationFrames,
    video,
    audio,
    graphics: [],
    captions: [],
    inputs: ids.map(planInput),
    loudness: { targetLufs: -14 },
  };
}

function overlayDoc(body: string, css: string, activeRanges: OverlayDocument["activeRanges"], size = { width: W, height: H }): OverlayDocument {
  const faces = fonts.map((f) => `@font-face{font-family:"${f.family}";src:url(${f.urlPath}) format("woff2");font-weight:${f.weight};font-display:block}`).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${faces}
@keyframes show{from{visibility:visible}to{visibility:visible}}
html,body{margin:0;width:${size.width}px;height:${size.height}px;background:transparent;overflow:hidden;font-family:"${OVERLAY_FONT_FAMILY}"}
.clip{position:absolute;visibility:hidden}
${css}</style></head><body>${body}</body></html>`;
  return { html, activeRanges, sha256: createHash("sha256").update(html).digest("hex") };
}

/** A lower third with text, visible over frames [30, 150) and sliding in over its first half second. */
const lowerThird = () =>
  overlayDoc(
    `<div class="clip lower">Lower third</div>`,
    `@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(0)}}
.lower{left:0;top:480px;width:260px;height:60px;padding-left:16px;background:#1e40af;color:#fff;font:800 28px/60px "${OVERLAY_FONT_FAMILY}";
animation:show 4s linear calc(1s - var(--t, 0s)) none, slide .5s ease-out calc(1s - var(--t, 0s)) both}`,
    [{ startFrame: 30, endFrame: 150 }]
  );

async function scratch(name: string): Promise<string> {
  const dir = path.join(root, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function options(workDir: string, renderPlan: RenderPlan, overlay: OverlayDocument, over: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return { plan: renderPlan, profile: INSTAGRAM_PROFILE, overlay, fonts, media, workDir, workers: 4, signal: new AbortController().signal, ...over };
}

/** Processes whose command line names the folder: every browser and FFmpeg of a render does. */
function processesUsing(dir: string): string[] {
  return execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf-8" })
    .split("\n")
    .filter((line) => line.includes(dir) && !line.includes(" ps "));
}

async function refusal(work: Promise<unknown>): Promise<RenderFailure> {
  const error = await work.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(RenderFailure);
  return error as RenderFailure;
}

async function probe(file: string) {
  const { stdout } = await run(toolPath("ffprobe")!, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-print_format", "json", file], { maxBuffer: 1 << 26 });
  return JSON.parse(stdout) as { streams: Record<string, string | number>[]; format: Record<string, string> };
}

/** Top-level MP4 box types in file order. */
async function topLevelBoxes(file: string): Promise<string[]> {
  const bytes = await readFile(file);
  const boxes: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    if (size < 8) break;
    boxes.push(type);
    offset += size;
  }
  return boxes;
}

const framemd5 = (file: string) => ffmpeg(["-v", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"]);

/** Rendered RGB of one pixel of frame `frame`, decoded as BT.709 limited range. */
async function pixel(file: string, frame: number, x: number, y: number): Promise<number[]> {
  const { stdout } = await run(
    toolPath("ffmpeg")!,
    ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${frame}),scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24,crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 20 }
  );
  return [...(stdout as Buffer)];
}

/** Flash and beep offsets, measured as scripts/gates/g1/measure-av.mjs does. */
async function avOffsets(file: string): Promise<{ flashes: number[]; offsets: number[] }> {
  const vlog = await ffmpeg(["-nostats", "-i", file, "-vf", "crop=30:20:2:15,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-an", "-f", "null", "-"]);
  const ys = [...vlog.matchAll(/frame:(\d+)\s+pts:\S+\s+pts_time:([\d.]+)\s*\nlavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => ({ t: Number(m[2]), y: Number(m[3]) }));
  const flashes = ys.filter((f, i) => f.y > 200 && !(i > 0 && ys[i - 1].y > 200)).map((f) => f.t);
  const alog = await ffmpeg(["-nostats", "-i", file, "-vn", "-af", "highpass=f=700,highpass=f=700,highpass=f=700,silencedetect=n=-40dB:d=0.004", "-f", "null", "-"]);
  const onsets = [...alog.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const firstStart = /silence_start: ([\d.]+)/.exec(alog);
  if (firstStart && Number(firstStart[1]) < 0.1 && !(onsets[0] < Number(firstStart[1]))) onsets.unshift(0);
  const offsets = flashes.map((t) => onsets.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), Infinity) - t);
  return { flashes, offsets };
}

async function loudness(file: string): Promise<{ integrated: number; truePeak: number }> {
  const log = await ffmpeg(["-nostats", "-i", file, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const summary = log.slice(log.lastIndexOf("Summary:"));
  return { integrated: Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)![1]), truePeak: Number(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/.exec(summary)![1]) };
}

describe.skipIf(MISSING)(`render executor (needs FFmpeg and Chromium${MISSING ? `: ${MISSING}` : ""})`, () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "cb-render-")));
    fonts = await bundledFonts();
    const footage = path.join(root, "footage");
    await mkdir(footage, { recursive: true });
    await flashClip(path.join(footage, "flash.mp4"), 10);
    await ffmpeg([
      "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:sample_rate=48000:d=12", "-f", "lavfi", "-i", "sine=f=330:sample_rate=48000:d=12",
      "-filter_complex", "[0:a][1:a]amix=inputs=2,volume=0.3[a]", "-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-ac", "2", path.join(footage, "music.m4a"),
    ]);
    await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}:d=1`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", path.join(footage, "short.mp4")]);
    await register("flash", path.join(footage, "flash.mp4"), "video");
    await register("music", path.join(footage, "music.m4a"), "audio");
    await register("short", path.join(footage, "short.mp4"), "video");
  }, 120_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** Clip A shows source 6-9 s, then clip B source 1-4 s; their sound, music under both, and a lower third. */
  const cutPlan = () =>
    plan(
      180,
      [layer("flash", 0, 90, 6_000_000), layer("flash", 90, 90, 1_000_000)],
      [sound("flash", 0, 90, 6_000_000, "voice"), sound("flash", 90, 90, 1_000_000, "voice"), sound("music", 0, 180, 500_000, "music", 0.5, 250_000)]
    );

  let first: { file: string; digest: string; captured: number } | null = null;

  it("renders trimmed, reordered clips with music and a graphic into a conforming MP4", async () => {
    const workDir = await scratch("cut");
    const progress: RenderProgress[] = [];
    const result = await executeRender(options(workDir, cutPlan(), lowerThird(), { onProgress: (p) => progress.push(p) }));
    expect(processesUsing(workDir)).toEqual([]);
    expect(result.videoFile).toBe(path.join(workDir, "render.mp4"));
    expect(result.overlayFramesCaptured).toBe(120);
    expect(result.overlayDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.workers).toBe(4);
    expect(result.loudness.normalisation).toMatch(/^(linear|dynamic)$/);
    expect(result.tools.ffmpeg).toMatch(/\S/);
    expect(result.tools.chrome).toMatch(/Chrome\/\d+/);
    expect(result.tools.puppeteer).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.chromeArgsSha256).toBe(createHash("sha256").update(OVERLAY_CHROME_ARGS.join("\n")).digest("hex"));
    for (const stage of ["overlay", "audio", "video", "mux"]) expect(progress.some((p) => p.stage === stage)).toBe(true);
    expect(progress.filter((p) => p.stage === "video").at(-1)).toEqual({ stage: "video", done: 180, total: 180 });

    const info = await probe(result.videoFile);
    const v = info.streams.find((s) => s.codec_type === "video")!;
    const a = info.streams.find((s) => s.codec_type === "audio")!;
    expect(v).toMatchObject({ codec_name: "h264", profile: "High", pix_fmt: "yuv420p", width: W, height: H, r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: "180" });
    expect(v).toMatchObject({ color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" });
    expect(a).toMatchObject({ codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2 });
    expect(Number(v.duration)).toBeCloseTo(6, 3);
    expect(Math.abs(Number(a.duration) - 6)).toBeLessThan(0.022);
    expect(info.format.tags ?? {}).not.toHaveProperty("encoder");
    const boxes = await topLevelBoxes(result.videoFile);
    expect(boxes.indexOf("moov")).toBeGreaterThan(-1);
    expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));
    // The graphic is drawn at its frames and not outside them: its blue box is at (100, 500) from frame 45.
    const [r, g, b] = await pixel(result.videoFile, 100, 100, 500);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(60);
    expect(g).toBeLessThan(90);
    expect(await pixel(result.videoFile, 160, 100, 500)).not.toEqual([r, g, b]);
    first = { file: result.videoFile, digest: result.overlayDigest, captured: result.overlayFramesCaptured };
  }, 120_000);

  it("keeps picture and sound within one frame after trimming and reordering", async () => {
    expect(first).not.toBeNull();
    const { flashes, offsets } = await avOffsets(first!.file);
    expect(flashes.map((t) => Math.round(t * FPS))).toEqual([0, 30, 60, 90, 120, 150]);
    for (const offset of offsets) expect(Math.abs(offset)).toBeLessThan(1 / FPS);
  }, 60_000);

  it("normalises the mix to the target loudness with the true peak under the ceiling after AAC", async () => {
    expect(first).not.toBeNull();
    const measured = await loudness(first!.file);
    expect(Math.abs(measured.integrated - -14)).toBeLessThanOrEqual(INSTAGRAM_PROFILE.loudness.toleranceLu);
    expect(measured.truePeak).toBeLessThanOrEqual(INSTAGRAM_PROFILE.loudness.truePeakDb);
  }, 60_000);

  it("renders one plan to identical decoded frames and overlay frames at any worker count", async () => {
    expect(first).not.toBeNull();
    const workDir = await scratch("again");
    const second = await executeRender(options(workDir, cutPlan(), lowerThird(), { workers: 2 }));
    expect(second.overlayDigest).toBe(first!.digest);
    expect(await framemd5(second.videoFile)).toBe(await framemd5(first!.file));
    const sameBytes = Buffer.compare(await readFile(second.videoFile), await readFile(first!.file)) === 0;
    console.info(`[render test] two renders of one plan: MP4 bytes ${sameBytes ? "identical" : "differ"}`);
    expect(sameBytes).toBe(true);
  }, 120_000);

  it("converts a full-frame #FF0000 overlay to BT.709 so it decodes as red", async () => {
    const workDir = await scratch("red");
    const doc = overlayDoc(`<div class="red"></div>`, `.red{position:absolute;inset:0;background:#FF0000}`, [{ startFrame: 0, endFrame: 15 }]);
    const result = await executeRender(options(workDir, plan(15, [], []), doc, { workers: 2 }));
    expect(result.loudness).toEqual({ measured: null, normalisation: "no-audio" });
    const [r, g, b] = await pixel(result.videoFile, 7, W / 2, H / 2);
    expect(r).toBeGreaterThanOrEqual(250);
    expect(g).toBeLessThanOrEqual(4);
    expect(b).toBeLessThanOrEqual(4);
    const info = await probe(result.videoFile);
    expect(info.streams.find((s) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac", channels: 2 });
  }, 60_000);

  it("pads a source shorter than its clip to the exact frame count", async () => {
    const workDir = await scratch("short");
    const result = await executeRender(options(workDir, plan(60, [layer("short", 0, 60, 500_000)], []), overlayDoc("", "", [])));
    const info = await probe(result.videoFile);
    expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ nb_read_frames: "60" });
    expect(result.overlayFramesCaptured).toBe(0);
    // The configured count is reported even though one browser was enough to check the document.
    expect(result.workers).toBe(4);
  }, 60_000);

  describe.skipIf(HDR_MISSING)(`HDR input${HDR_MISSING ? ` (${HDR_MISSING})` : ""}`, () => {
    it("converts an HLG original to upright BT.709 before compositing", async () => {
      const file = await makeMedia(path.join(root, "hdr"), "hdr-portrait");
      await register("hdr", file, "video");
      const workDir = await scratch("hdr");
      const result = await executeRender(options(workDir, plan(30, [layer("hdr", 0, 30, 0)], []), overlayDoc("", "", [])));
      const info = await probe(result.videoFile);
      expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ nb_read_frames: "30", width: W, height: H, color_transfer: "bt709", pix_fmt: "yuv420p" });
      expect(processesUsing(workDir)).toEqual([]);
    }, 120_000);
  });

  describe("hostile overlay documents", () => {
    const tiny = () => plan(10, [], []);

    it("fails a document that asks for an image on its own origin", async () => {
      const workDir = await scratch("img");
      const doc = overlayDoc(`<img src="/x.png" width="10" height="10">`, "", [{ startFrame: 0, endFrame: 10 }]);
      const failure = await refusal(executeRender(options(workDir, tiny(), doc)));
      expect(failure).toMatchObject({ failureClass: "permanent", code: "overlay_request_blocked" });
      expect(failure.message).toContain("image");
      expect(failure.message).not.toContain("x.png");
      expect(processesUsing(workDir)).toEqual([]);
    }, 60_000);

    it("fails a document that refreshes itself", async () => {
      const workDir = await scratch("refresh");
      const doc = overlayDoc(`<meta http-equiv="refresh" content="0">`, "", [{ startFrame: 0, endFrame: 10 }]);
      const failure = await refusal(executeRender(options(workDir, tiny(), doc)));
      expect(failure).toMatchObject({ failureClass: "permanent", code: "overlay_navigation" });
      expect(processesUsing(workDir)).toEqual([]);
    }, 60_000);

    it("fails a frame that misses its deadline and leaves no browser running", async () => {
      const workDir = await scratch("heavy");
      const size = { width: 1080, height: 1920 };
      const heavy = overlayDoc(
        `<div class="h"></div>`.repeat(200),
        `.h{position:absolute;inset:0;filter:blur(80px) drop-shadow(0 0 60px red);background:radial-gradient(red,blue);mix-blend-mode:difference}`,
        [{ startFrame: 0, endFrame: 10 }],
        size
      );
      const limits: Partial<RenderLimits> = { frameDeadlineMs: 300 };
      const failure = await refusal(executeRender(options(workDir, plan(10, [], [], size), heavy, { workers: 1 }), limits));
      expect(failure).toMatchObject({ failureClass: "transient", code: "timeout" });
      expect(processesUsing(workDir)).toEqual([]);
    }, 60_000);

    it("fails a document whose font cannot load", async () => {
      const workDir = await scratch("font");
      const doc = overlayDoc(`<div style="font-family:Missing">x</div>`, `@font-face{font-family:Missing;src:url(/fonts/missing.woff2)}`, [{ startFrame: 0, endFrame: 10 }]);
      const failure = await refusal(executeRender(options(workDir, tiny(), doc)));
      // The request for an unserved font is refused, which is the stronger finding.
      expect(failure.code).toMatch(/^overlay_(request_blocked|font_failed)$/);
      expect(processesUsing(workDir)).toEqual([]);
    }, 60_000);
  });

  it("launches every overlay browser with its sandbox on and the pinned flags", async () => {
    const profileDir = await scratch("sandbox");
    const renderer = await OverlayRenderer.open({
      executablePath: chromeExecutable()!,
      overlay: lowerThird(),
      fonts,
      canvas: { width: W, height: H },
      fps: FPS,
      durationFrames: 180,
      workers: 2,
      profileDir,
      signal: new AbortController().signal,
    });
    try {
      expect(renderer.pids).toHaveLength(2);
      for (const pid of renderer.pids) {
        const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf-8" });
        expect(command).not.toContain("--no-sandbox");
        expect(command).not.toContain("--disable-setuid-sandbox");
        for (const flag of OVERLAY_CHROME_ARGS) expect(command).toContain(flag);
        expect(command).toContain("--remote-debugging-pipe");
      }
      // Renderer children run inside the OS sandbox.
      const children = processesUsing(profileDir).filter((line) => line.includes("--type=renderer"));
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) expect(child).not.toContain("--no-sandbox");
    } finally {
      await renderer.close();
    }
    expect(processesUsing(profileDir)).toEqual([]);
  }, 60_000);

  it("stops every browser and FFmpeg when the render is cancelled", async () => {
    const workDir = await scratch("abort");
    const controller = new AbortController();
    const long = plan(300, [layer("flash", 0, 300, 0)], [sound("flash", 0, 300, 0, "voice")]);
    const doc = overlayDoc(
      `<div class="clip box"></div>`,
      `.box{left:20px;top:200px;width:200px;height:200px;background:#0a0;animation:show 10s linear calc(0s - var(--t, 0s)) none}`,
      [{ startFrame: 0, endFrame: 300 }]
    );
    let sawVideo = false;
    const work = executeRender(
      options(workDir, long, doc, {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.stage === "overlay" && p.done >= 20 && !controller.signal.aborted) {
            sawVideo = processesUsing(workDir).some((line) => line.includes("render.mp4"));
            controller.abort();
          }
        },
      })
    );
    const failure = await refusal(work);
    expect(failure).toMatchObject({ failureClass: "transient", code: "interrupted" });
    expect(sawVideo).toBe(true);
    expect(processesUsing(workDir)).toEqual([]);
  }, 120_000);
});
