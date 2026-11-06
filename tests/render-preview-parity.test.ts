/**
 * Preview and export parity for footage placement (#144, ADR decision 3:
 * "No footage transform ships without [a parity] test").
 *
 * The export cuts footage from the original: FFmpeg turns it upright, scales
 * it to the compiler's cover placement and crops the canvas window
 * (`ffmpeg-graph.ts`). The Studio preview shows the media's proxy (upright,
 * no rotation flag, at most 540x960) or image proxy in an element sized and
 * offset by `layerBox(placement)` inside an overflow-hidden canvas-sized box,
 * its content filling the element exactly. Both must put the same source
 * features on the same canvas pixels.
 *
 * Each source is a mid-grey picture with small saturated markers at known,
 * asymmetric positions, some of them cropped away by cover-fit. Each case
 * registers real media (real ffprobe facts, real derived files), compiles a
 * real production, renders it with the executor, decodes a mid-clip frame of
 * the MP4, screenshots the preview layout of the proxy in the overlay
 * browser's Chromium, and compares where every marker lands in both with an
 * analytic prediction from the placement.
 *
 * Skipped where FFmpeg or Chromium is missing (CI has neither, #142).
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CATALOG } from "@/lib/video/capabilities/catalog";
import { MediaJobs } from "@/lib/video/media/jobs";
import { MediaRegistry, type MediaRecord } from "@/lib/video/media/registry";
import { toolPath } from "@/lib/video/media/tools";
import { admitProduction } from "@/lib/video/production";
import { chromeExecutable, OVERLAY_CHROME_ARGS } from "@/lib/video/render/chrome";
import { compile } from "@/lib/video/render/compile";
import { executeRender } from "@/lib/video/render/execute";
import type { ExecuteOptions, FontAsset } from "@/lib/video/render/execute-types";
import { bundledFonts } from "@/lib/video/render/fonts";
import { buildOverlay } from "@/lib/video/render/overlay";
import { layerBox, type CoverPlacement, type RenderPlan, type VideoLayer } from "@/lib/video/render/plan";
import { INSTAGRAM_PROFILE } from "@/lib/video/render/profile";
import type { MediaRole, Production, StillClip, VideoClip } from "@/types/production";
import { FFMPEG_MISSING } from "./helpers/media-fixtures";
import { footageProduction } from "./helpers/production-fixtures";

const run = promisify(execFile);
const CHROME_MISSING = chromeExecutable() ? null : "no Chromium is installed for Puppeteer (npx puppeteer browsers install chrome)";
const MISSING = FFMPEG_MISSING ?? CHROME_MISSING;

const FPS = 30;
const CLIP_FRAMES = 30;
/** The frame sampled in each clip: its middle. */
const MID = 15;

/**
 * How far, in canvas pixels, a marker's centroid may be from the other side's
 * and from the prediction, for video. The export scales the full-size
 * original with Lanczos; the preview stretches a proxy that FFmpeg first
 * downscaled (bicubic, sides rounded to even) by up to 3.6 times with
 * Chromium's own filter. Each resample moves a symmetric marker's centroid by
 * a fraction of a proxy pixel, and chroma subsampling and colour thresholds
 * move its edges by under a pixel. A placement error, by contrast, moves every
 * marker by whole pixels: a 4 px offset, a mirror or a half turn all fail it.
 */
const VIDEO_BOUND_PX = 2;
/**
 * The bound for a still both sides scale up, from the same pixels (its image
 * proxy is the original at the same size): only the two upscalers (Lanczos,
 * Chromium's filter) and the export's chroma subsampling differ, so they
 * agree to under a pixel (about half a pixel measured).
 */
const STILL_SCALED_BOUND_PX = 1;
/**
 * The bound for a still shown at scale 1: the export does not resample it,
 * and the preview only squeezes its image proxy (whose width `fitSize` rounds
 * from 1371 up to an even 1372) back into the 1371 px element, so they agree
 * to hundredths of a pixel. Tight enough to pin the cover rule's choice of
 * putting an odd extra pixel on the right (`offsetX = floor(...)`): the other
 * choice is a whole pixel away and fails it.
 */
const STILL_UNSCALED_BOUND_PX = 0.5;

// ---------------------------------------------------------------------------
// Source patterns

const COLOURS = ["red", "green", "blue", "yellow", "magenta", "cyan", "white"] as const;
type Colour = (typeof COLOURS)[number];
const RGB: Record<Colour, [number, number, number]> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  magenta: [255, 0, 255],
  cyan: [0, 255, 255],
  white: [255, 255, 255],
};
const GREY = 128;

/** A square marker, its top-left corner and side in upright source pixels. */
interface Marker {
  colour: Colour;
  x: number;
  y: number;
  size: number;
}

/** An upright picture: what a player shows, rotation applied. */
interface Design {
  width: number;
  height: number;
  markers: Marker[];
}

const square = (size: number) => (colour: Colour, x: number, y: number): Marker => ({ colour, x, y, size });

/**
 * 1920x1080 on 1080x1920: scaled 3413x1920, offsetX 1166, so only source x in
 * about [656, 1263] is shown. Cyan is cropped on the left, white on the right.
 */
const m64 = square(64);
const LANDSCAPE: Design = {
  width: 1920,
  height: 1080,
  markers: [m64("red", 680, 96), m64("green", 1120, 280), m64("blue", 800, 880), m64("yellow", 1000, 600), m64("magenta", 720, 440), m64("cyan", 240, 520), m64("white", 1500, 160)],
};

/**
 * Upright 1080x1920 on 1080x1350: scale 1, offsetY 285, so upright y in
 * [285, 1635) is shown. Cyan is cropped at the top, white at the bottom.
 */
const PORTRAIT: Design = {
  width: 1080,
  height: 1920,
  markers: [m64("red", 120, 340), m64("green", 840, 520), m64("blue", 280, 1480), m64("yellow", 900, 1240), m64("magenta", 520, 900), m64("cyan", 600, 96), m64("white", 200, 1760)],
};

/**
 * 1000x700 on 1080x1080: scaled 1543x1080, an odd overhang of 463, offsetX
 * 231, so source x in about [150, 850] is shown.
 */
const m48 = square(48);
const STILL_SCALED: Design = {
  width: 1000,
  height: 700,
  markers: [m48("red", 176, 64), m48("green", 720, 160), m48("blue", 256, 576), m48("yellow", 560, 416), m48("magenta", 400, 256), m48("cyan", 40, 300), m48("white", 900, 480)],
};

/**
 * 1371x1080 on 1080x1080: scale 1, an odd overhang of 291, offsetX 145, so
 * source x in [145, 1225) is shown. Marker x positions are odd so that, with
 * offset 145, they start on even canvas columns, aligned to the export's
 * 4:2:0 chroma, and the measurement has no chroma bias.
 */
const STILL_UNSCALED: Design = {
  width: 1371,
  height: 1080,
  markers: [m48("red", 201, 80), m48("green", 1101, 200), m48("blue", 331, 900), m48("yellow", 801, 620), m48("magenta", 561, 380), m48("cyan", 41, 500), m48("white", 1271, 700)],
};

// ---------------------------------------------------------------------------
// Tools

let root: string;
let sources: string;
let registry: MediaRegistry;
let jobs: MediaJobs;
let fonts: FontAsset[];

async function ffmpeg(args: string[]): Promise<void> {
  await run(toolPath("ffmpeg")!, ["-nostdin", "-hide_banner", "-v", "error", "-y", ...args], { maxBuffer: 1 << 26, timeout: 120_000 });
}

/** Decodes one picture to full-range RGB with BT.709 for limited-range YUV input, and returns its bytes. */
async function decodeRgb(input: string, width: number, height: number, select = ""): Promise<Buffer> {
  const { stdout } = await run(
    toolPath("ffmpeg")!,
    [
      "-nostdin", "-hide_banner", "-v", "error",
      "-i", input,
      "-frames:v", "1",
      "-vf", `${select}scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 1 << 26, timeout: 60_000 }
  );
  expect(stdout.length, "decoded picture size").toBe(width * height * 3);
  return stdout;
}

/** Writes a design as an RGB PNG, exactly: grey with solid markers, no resampling. */
async function designPng(design: Design, file: string): Promise<string> {
  const raw = Buffer.alloc(design.width * design.height * 3, GREY);
  for (const m of design.markers) {
    for (let y = m.y; y < m.y + m.size; y++) {
      for (let x = m.x; x < m.x + m.size; x++) raw.set(RGB[m.colour], (y * design.width + x) * 3);
    }
  }
  const rawFile = `${file}.rgb`;
  await writeFile(rawFile, raw);
  await ffmpeg(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${design.width}x${design.height}`, "-i", rawFile, "-frames:v", "1", "-update", "1", file]);
  await rm(rawFile);
  return file;
}

/**
 * A two-second, video-only SDR clip of the design. For a clockwise rotation
 * R the frames are stored turned R counter-clockwise and tagged with a
 * display matrix, so a player shows the design upright, as a phone stores
 * portrait video. `-display_rotation` takes the counter-clockwise turn.
 */
async function designVideo(design: Design, name: string, rotation: 0 | 90 | 270): Promise<string> {
  const png = await designPng(design, path.join(sources, `${name}.png`));
  const coded = path.join(sources, `${name}-coded.mp4`);
  const store = rotation === 90 ? "transpose=cclock," : rotation === 270 ? "transpose=clock," : "";
  await ffmpeg([
    "-loop", "1", "-framerate", String(FPS), "-t", "2", "-i", png,
    "-vf", `${store}scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-g", String(FPS),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    coded,
  ]);
  if (rotation === 0) return coded;
  const file = path.join(sources, `${name}.mp4`);
  await ffmpeg(["-display_rotation", String(360 - rotation), "-i", coded, "-c", "copy", file]);
  return file;
}

/** Imports a file through the registry and builds its derived files. */
async function importMedia(file: string): Promise<MediaRecord> {
  const { record } = await registry.importPath(file);
  await jobs.enqueue(record.mediaId);
  await jobs.idle();
  const job = await jobs.read(record.mediaId);
  expect(job, `derived files of ${path.basename(file)}`).toMatchObject({ state: "succeeded" });
  return record;
}

const PROVENANCE = { by: "user" as const, changeSetId: "cs-parity" };

/** A production of one picture track, built from the footage fixture so it passes admission. */
function production(canvas: { width: number; height: number }, media: { record: MediaRecord; role: MediaRole }[], trackRole: "a-roll" | "b-roll"): Production {
  const base = footageProduction();
  const format = { width: canvas.width, height: canvas.height, fps: FPS as 30, maxDurationMs: 90_000, platform: "instagram-reel" as const };
  const clips: (VideoClip | StillClip)[] = media.map(({ record }, i) =>
    record.kind === "image"
      ? { kind: "still", id: `clip-${i}`, start: i * CLIP_FRAMES, duration: CLIP_FRAMES, mediaId: record.mediaId, provenance: PROVENANCE }
      : { kind: "video", id: `clip-${i}`, start: i * CLIP_FRAMES, duration: CLIP_FRAMES, source: { mediaId: record.mediaId, inUs: 0, outUs: 1_000_000 }, provenance: PROVENANCE }
  );
  return {
    ...base,
    script: null,
    storyboard: null,
    review: { comments: [] },
    format,
    deliverables: [{ id: "deliv-parity", label: "Instagram", format }],
    media: media.map(({ record, role }, i) => ({ mediaId: record.mediaId, role, label: `Source ${i}` })),
    timeline: {
      tracks: [{ id: "track-picture", kind: "video", role: trackRole, hidden: false, clips }],
      captions: { presetId: null, hidden: false },
      audio: base.timeline.audio,
      markers: [],
    },
  };
}

/** Admits and compiles a production against the registry, then renders it with the real executor. Returns the plan and the MP4. */
async function exportProduction(doc: Production, name: string): Promise<{ plan: RenderPlan; video: string }> {
  const admitted = admitProduction(doc, { ledger: await registry.ledger() });
  if (!admitted.ok) throw new Error(`the parity production is not admitted: ${JSON.stringify(admitted.issues)}`);
  const records = new Map((await registry.list()).map((r) => [r.mediaId, r]));
  const compiled = compile(admitted.production, records, { profile: INSTAGRAM_PROFILE, catalog: DEFAULT_CATALOG });
  if (!compiled.ok) throw new Error(`the parity production does not compile: ${JSON.stringify(compiled.issues)}`);
  const plan = compiled.plan;
  const overlay = buildOverlay(plan, { catalog: DEFAULT_CATALOG, fonts, target: "export" });
  const media: ExecuteOptions["media"] = new Map(plan.inputs.map((input) => [input.mediaId, { record: records.get(input.mediaId)!, originalPath: registry.originalPath(records.get(input.mediaId)!) }]));
  const workDir = path.join(root, `export-${name}`);
  await mkdir(workDir);
  const result = await executeRender({ plan, profile: INSTAGRAM_PROFILE, overlay, fonts, media, workDir, workers: 1, signal: new AbortController().signal });
  return { plan, video: result.videoFile };
}

/** The layer on screen at a frame. */
function layerAt(plan: RenderPlan, frame: number): VideoLayer {
  const layer = plan.video.find((l) => frame >= l.startFrame && frame < l.startFrame + l.durationFrames);
  if (!layer) throw new Error(`no layer at frame ${frame}`);
  return layer;
}

/** The export's frame, as RGB. */
function exportFrame(video: string, plan: RenderPlan, frame: number): Promise<Buffer> {
  return decodeRgb(video, plan.canvas.width, plan.canvas.height, `trim=start_frame=${frame},`);
}

/** The preview's picture for a layer at a frame: the proxy frame at the same source time, or the image proxy, as a PNG. */
async function proxyPicture(layer: VideoLayer, frame: number, name: string): Promise<Buffer> {
  if (layer.kind === "still") return readFile(registry.derivedPath(layer.mediaId, "proxy.png"));
  const atUs = layer.sourceInUs! + Math.round(((frame - layer.startFrame) * 1_000_000) / FPS);
  const out = path.join(root, `proxy-${name}.png`);
  await ffmpeg([
    "-ss", (atUs / 1_000_000).toFixed(6), "-i", registry.derivedPath(layer.mediaId, "proxy.mp4"), "-frames:v", "1",
    "-vf", "scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24", "-update", "1", out,
  ]);
  return readFile(out);
}

/**
 * The preview layout: a canvas-sized, overflow-hidden box holding the proxy
 * in an element at `layerBox(placement)`, its content filling the element.
 * Screenshot in Chromium with the overlay browser's flags, decoded to RGB
 * with the same FFmpeg path as the export.
 */
async function previewFrame(browser: Awaited<ReturnType<typeof puppeteer.launch>>, plan: RenderPlan, layer: VideoLayer, picture: Buffer, name: string): Promise<Buffer> {
  const { width, height } = plan.canvas;
  const box = layerBox(layer.placement);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;overflow:hidden;background:#000}
.canvas{position:relative;overflow:hidden;width:${width}px;height:${height}px}
.layer{position:absolute;display:block;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;object-fit:fill}
</style></head><body><div class="canvas"><img class="layer" alt="" src="data:image/png;base64,${picture.toString("base64")}"></div></body></html>`;
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.$eval("img", (img) => (img as HTMLImageElement).decode());
    const shot = path.join(root, `preview-${name}.png`);
    await writeFile(shot, await page.screenshot({ type: "png" }));
    return decodeRgb(shot, width, height);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Measurement

interface Spot {
  x: number;
  y: number;
  count: number;
}

const HIGH = 170;
const LOW = 90;
/** Fewer pixels than this of one colour is compression fringe, not a marker. */
const MIN_PIXELS = 200;

/** Centroid (pixel centres) and size of every marker colour visible in an RGB picture, classified by channel pattern. */
function measure(rgb: Buffer, width: number, height: number): Map<Colour, Spot> {
  const sums = new Map<Colour, { x: number; y: number; count: number }>();
  const byPattern = new Map<string, Colour>(COLOURS.map((c) => [RGB[c].map((v) => (v > 0 ? "1" : "0")).join(""), c]));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      let pattern = "";
      for (let ch = 0; ch < 3; ch++) {
        const v = rgb[i + ch];
        if (v > HIGH) pattern += "1";
        else if (v < LOW) pattern += "0";
        else break;
      }
      const colour = pattern.length === 3 ? byPattern.get(pattern) : undefined;
      if (!colour) continue;
      const s = sums.get(colour) ?? { x: 0, y: 0, count: 0 };
      s.x += x + 0.5;
      s.y += y + 0.5;
      s.count++;
      sums.set(colour, s);
    }
  }
  const spots = new Map<Colour, Spot>();
  for (const [colour, s] of sums) if (s.count >= MIN_PIXELS) spots.set(colour, { x: s.x / s.count, y: s.y / s.count, count: s.count });
  return spots;
}

/**
 * The independent oracle: an upright source point (x, y) lands on canvas
 * point (x * scaledWidth / displayWidth - offsetX, y * scaledHeight /
 * displayHeight - offsetY). Returns where each fully visible marker's centre
 * and area land; markers fully outside the canvas are absent, and one the
 * crop cuts through is a fixture mistake.
 */
function predict(design: Design, placement: CoverPlacement, canvas: { width: number; height: number }): Map<Colour, Spot> {
  const kx = placement.scaledWidth / design.width;
  const ky = placement.scaledHeight / design.height;
  const spots = new Map<Colour, Spot>();
  for (const m of design.markers) {
    const left = m.x * kx - placement.offsetX;
    const right = (m.x + m.size) * kx - placement.offsetX;
    const top = m.y * ky - placement.offsetY;
    const bottom = (m.y + m.size) * ky - placement.offsetY;
    const inside = left >= 0 && top >= 0 && right <= canvas.width && bottom <= canvas.height;
    const outside = right <= 0 || bottom <= 0 || left >= canvas.width || top >= canvas.height;
    if (!inside && !outside) throw new Error(`fixture: the ${m.colour} marker straddles the crop edge`);
    if (inside) spots.set(m.colour, { x: (left + right) / 2, y: (top + bottom) / 2, count: (right - left) * (bottom - top) });
  }
  return spots;
}

/** The largest centroid distance over `expected`'s markers; Infinity when one is missing from `measured`. */
function maxError(measured: Map<Colour, Spot>, expected: Map<Colour, Spot>): number {
  let worst = 0;
  for (const [colour, e] of expected) {
    const m = measured.get(colour);
    if (!m) return Infinity;
    worst = Math.max(worst, Math.hypot(m.x - e.x, m.y - e.y));
  }
  return worst;
}

/** `expected` with every centroid moved by a function of the canvas point: the placement bugs the bound must catch. */
function moved(expected: Map<Colour, Spot>, f: (s: Spot) => { x: number; y: number }): Map<Colour, Spot> {
  return new Map([...expected].map(([c, s]) => [c, { ...s, ...f(s) }]));
}

const sorted = (m: Map<Colour, Spot>) => [...m.keys()].sort();
const round = (n: number) => Math.round(n * 100) / 100;

interface Sample {
  label: string;
  frame: number;
  design: Design;
  /** Canvas pixels, for every comparison of this sample. */
  bound: number;
}

/** Errors per sample, for the report in the test output. */
const report: Record<string, { exportVsPreview: number; exportVsOracle: number; previewVsOracle: number }> = {};

/**
 * Renders the production, then for each sample checks the export frame and
 * the preview screenshot against each other and against the oracle, and that
 * the bound catches a 4 px offset, a mirror and a half turn.
 */
async function checkParity(doc: Production, name: string, samples: Sample[]): Promise<{ plan: RenderPlan; measured: Map<string, { exported: Map<Colour, Spot>; previewed: Map<Colour, Spot>; expected: Map<Colour, Spot> }> }> {
  const { plan, video } = await exportProduction(doc, name);
  const { width, height } = plan.canvas;
  const measured = new Map<string, { exported: Map<Colour, Spot>; previewed: Map<Colour, Spot>; expected: Map<Colour, Spot> }>();
  const browser = await puppeteer.launch({
    executablePath: chromeExecutable()!,
    headless: true,
    pipe: true,
    args: [...OVERLAY_CHROME_ARGS],
    userDataDir: path.join(root, `browser-${name}`),
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  try {
    for (const sample of samples) {
      const { bound } = sample;
      const layer = layerAt(plan, sample.frame);
      const exported = measure(await exportFrame(video, plan, sample.frame), width, height);
      const previewed = measure(await previewFrame(browser, plan, layer, await proxyPicture(layer, sample.frame, `${name}-${sample.frame}`), `${name}-${sample.frame}`), width, height);
      const expected = predict(sample.design, layer.placement, plan.canvas);
      measured.set(sample.label, { exported, previewed, expected });
      const detail = JSON.stringify({ placement: layer.placement, exported: Object.fromEntries(exported), previewed: Object.fromEntries(previewed), expected: Object.fromEntries(expected) });

      // The same markers are visible in both, and they are the ones cover-fit keeps.
      expect(sorted(exported), `${sample.label}: markers visible in the export ${detail}`).toEqual(sorted(expected));
      expect(sorted(previewed), `${sample.label}: markers visible in the preview ${detail}`).toEqual(sorted(expected));
      expect(sorted(expected).length, "every case crops markers away").toBeLessThan(sample.design.markers.length);

      const errors = { exportVsPreview: maxError(previewed, exported), exportVsOracle: maxError(exported, expected), previewVsOracle: maxError(previewed, expected) };
      report[sample.label] = { exportVsPreview: round(errors.exportVsPreview), exportVsOracle: round(errors.exportVsOracle), previewVsOracle: round(errors.previewVsOracle) };
      expect(errors.exportVsPreview, `${sample.label}: export and preview centroids ${detail}`).toBeLessThanOrEqual(bound);
      expect(errors.exportVsOracle, `${sample.label}: export against the placement ${detail}`).toBeLessThanOrEqual(bound);
      expect(errors.previewVsOracle, `${sample.label}: preview against the placement ${detail}`).toBeLessThanOrEqual(bound);

      // Each marker's area matches the scaled square on both sides (a wrong scale with a lucky centre fails here).
      for (const [colour, e] of expected) {
        for (const [side, spots] of [["export", exported], ["preview", previewed]] as const) {
          expect(spots.get(colour)!.count / e.count, `${sample.label}: ${colour} area in the ${side}`).toBeGreaterThan(0.85);
          expect(spots.get(colour)!.count / e.count, `${sample.label}: ${colour} area in the ${side}`).toBeLessThan(1.15);
        }
      }

      // Negative controls: the measurement fails a placement 4 px off, mirrored, or turned half way.
      const { scaledWidth, scaledHeight, offsetX, offsetY } = layer.placement;
      const mirrorX = (x: number) => scaledWidth - 2 * offsetX - x;
      const wrong = {
        offset4: moved(expected, (s) => ({ x: s.x + 4, y: s.y + (offsetY > 0 ? 4 : 0) })),
        mirrored: moved(expected, (s) => ({ x: mirrorX(s.x), y: s.y })),
        halfTurn: moved(expected, (s) => ({ x: mirrorX(s.x), y: scaledHeight - 2 * offsetY - s.y })),
      };
      for (const [kind, positions] of Object.entries(wrong)) {
        expect(maxError(exported, positions), `${sample.label}: a ${kind} placement is caught in the export`).toBeGreaterThan(bound);
        expect(maxError(previewed, positions), `${sample.label}: a ${kind} placement is caught in the preview`).toBeGreaterThan(bound);
      }
    }
  } finally {
    await browser.close();
  }
  return { plan, measured };
}

/** Processes whose command line names the folder: every browser and FFmpeg this file starts does. */
function processesUsing(dir: string): string[] {
  return execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf-8" })
    .split("\n")
    .filter((line) => line.includes(dir) && !line.includes(" ps "));
}

/** The original as a player shows it (FFmpeg's autorotation): the fixture really is the upright design. */
async function checkUpright(record: MediaRecord, design: Design): Promise<void> {
  const shown = measure(await decodeRgb(registry.originalPath(record), design.width, design.height), design.width, design.height);
  const placed = predict(design, { scaledWidth: design.width, scaledHeight: design.height, offsetX: 0, offsetY: 0 }, design);
  expect(sorted(shown)).toEqual(sorted(placed));
  expect(maxError(shown, placed), `fixture ${record.originalName} is upright: ${JSON.stringify(Object.fromEntries(shown))}`).toBeLessThanOrEqual(1);
}

// ---------------------------------------------------------------------------

describe.skipIf(MISSING)(`preview and export place footage on the same canvas pixels${MISSING ? ` (skipped: ${MISSING})` : ""}`, () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "cb-parity-")));
    sources = path.join(root, "footage");
    await mkdir(sources);
    registry = new MediaRegistry({ dataDir: path.join(root, "data") });
    jobs = new MediaJobs(registry, { log: () => undefined });
    // Read from the app's node_modules: this file never changes the working folder.
    fonts = await bundledFonts();
  });

  afterAll(async () => {
    jobs?.stop();
    await jobs?.idle();
    // Printed so a run shows how much margin each case has under its bound.
    console.info("[parity] max centroid error in canvas px", report);
    if (!root) return;
    try {
      expect(processesUsing(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("landscape video cropped left and right on a 1080x1920 canvas", { timeout: 240_000 }, async () => {
    const record = await importMedia(await designVideo(LANDSCAPE, "landscape", 0));
    expect(record.facts.video).toMatchObject({ width: 1920, height: 1080, rotation: 0, dynamicRange: "sdr" });
    await checkUpright(record, LANDSCAPE);
    const { plan } = await checkParity(production({ width: 1080, height: 1920 }, [{ record, role: "a-roll" }], "a-roll"), "landscape", [{ label: "landscape", frame: MID, design: LANDSCAPE, bound: VIDEO_BOUND_PX }]);
    expect(plan.video[0].placement).toEqual({ scaledWidth: 3413, scaledHeight: 1920, offsetX: 1166, offsetY: 0 });
    expect(processesUsing(root)).toEqual([]);
  });

  it("portrait phone video stored landscape with 90 and 270 degree rotation, cropped top and bottom on 1080x1350", { timeout: 240_000 }, async () => {
    const r90 = await importMedia(await designVideo(PORTRAIT, "portrait-90", 90));
    const r270 = await importMedia(await designVideo(PORTRAIT, "portrait-270", 270));
    // Stored 1920x1080 with a display matrix; the registry reads the clockwise turn a player applies.
    expect(r90.facts.video).toMatchObject({ width: 1920, height: 1080, rotation: 90, dynamicRange: "sdr" });
    expect(r270.facts.video).toMatchObject({ width: 1920, height: 1080, rotation: 270, dynamicRange: "sdr" });
    await checkUpright(r90, PORTRAIT);
    await checkUpright(r270, PORTRAIT);
    const doc = production({ width: 1080, height: 1350 }, [{ record: r90, role: "a-roll" }, { record: r270, role: "b-roll" }], "a-roll");
    const { plan } = await checkParity(doc, "portrait", [
      { label: "rotation 90", frame: MID, design: PORTRAIT, bound: VIDEO_BOUND_PX },
      { label: "rotation 270", frame: CLIP_FRAMES + MID, design: PORTRAIT, bound: VIDEO_BOUND_PX },
    ]);
    expect(plan.inputs.map((i) => ({ rotation: i.rotation, display: i.display }))).toEqual([
      { rotation: 90, display: { width: 1080, height: 1920 } },
      { rotation: 270, display: { width: 1080, height: 1920 } },
    ]);
    expect(plan.video[0].placement).toEqual({ scaledWidth: 1080, scaledHeight: 1920, offsetX: 0, offsetY: 285 });
    expect(processesUsing(root)).toEqual([]);
  });

  it("stills with an odd overhang on 1080x1080 put the extra pixel on the right", { timeout: 240_000 }, async () => {
    const scaled = await importMedia(await designPng(STILL_SCALED, path.join(sources, "still-scaled.png")));
    const unscaled = await importMedia(await designPng(STILL_UNSCALED, path.join(sources, "still-unscaled.png")));
    const doc = production({ width: 1080, height: 1080 }, [{ record: scaled, role: "image" }, { record: unscaled, role: "image" }], "b-roll");
    const { plan, measured } = await checkParity(doc, "stills", [
      { label: "still 1000x700", frame: MID, design: STILL_SCALED, bound: STILL_SCALED_BOUND_PX },
      { label: "still 1371x1080", frame: CLIP_FRAMES + MID, design: STILL_UNSCALED, bound: STILL_UNSCALED_BOUND_PX },
    ]);
    // Odd overhangs: 1543 - 1080 = 463 and 1371 - 1080 = 291, the extra pixel on the right.
    expect(plan.video.map((l) => l.placement)).toEqual([
      { scaledWidth: 1543, scaledHeight: 1080, offsetX: 231, offsetY: 0 },
      { scaledWidth: 1371, scaledHeight: 1080, offsetX: 145, offsetY: 0 },
    ]);
    // Rounding the other way (offsetX 146, the extra pixel on the left) is a whole pixel off, and the unscaled still's bound sees it.
    const { exported, previewed, expected } = measured.get("still 1371x1080")!;
    const leftRule = moved(expected, (s) => ({ x: s.x - 1, y: s.y }));
    expect(maxError(exported, leftRule)).toBeGreaterThan(STILL_UNSCALED_BOUND_PX);
    expect(maxError(previewed, leftRule)).toBeGreaterThan(STILL_UNSCALED_BOUND_PX);
    expect(processesUsing(root)).toEqual([]);
  });
});
