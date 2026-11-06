/**
 * Preview and export agree on the overlay (#144 acceptance criterion; ADR
 * decision 3; docs/architecture/video-rendering.md, "The overlay document").
 *
 * One plan with a title card, a lower third and timed captions in both
 * presets is built twice, as the export document and as the preview
 * document. The export side is drawn by the real export renderer
 * (`OverlayRenderer`, hardened browsers with `OVERLAY_CHROME_ARGS`, seeked
 * through `document.getAnimations()`), streamed in frame order exactly as the
 * executor feeds FFmpeg. The preview side is what a creator's browser shows:
 * a separate Chromium with default flags, a canvas-sized host page holding
 * `<iframe sandbox="">` whose `srcdoc` is `previewOverlayAt(doc, frame, fps)`.
 * Twenty sampled frames are compared pixel by pixel.
 *
 * Skipped where Chromium is missing (CI has none, #142), including when HOME
 * is empty, because Puppeteer installs Chromium under HOME.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CATALOG } from "@/lib/video/capabilities/catalog";
import { chromeExecutable } from "@/lib/video/render/chrome";
import type { FontAsset } from "@/lib/video/render/execute-types";
import { bundledFonts } from "@/lib/video/render/fonts";
import { buildOverlay, previewOverlayAt } from "@/lib/video/render/overlay";
import { OverlayRenderer } from "@/lib/video/render/overlay-renderer";
import { PLAN_VERSION, type GraphicPlacement, type RenderPlan } from "@/lib/video/render/plan";
import type { JsonValue } from "@/types/production";

const CHROME_MISSING = chromeExecutable() ? null : "no Chromium is installed for Puppeteer (npx puppeteer browsers install chrome)";

const W = 1080;
const H = 1920;
const FPS = 30;
const DURATION = 180;

function graphic(clipId: string, startFrame: number, durationFrames: number, id: string, params: unknown, trackIndex: number): GraphicPlacement {
  return { clipId, trackId: `track-${trackIndex}`, trackIndex, capability: { id, version: "1.0.0", params: params as JsonValue }, startFrame, durationFrames };
}

/**
 * - title card [0, 60): scale and fade in over 12 frames, fade out over 8;
 * - lower third [50, 130): slides in over 10 frames, out over 8;
 * - kinetic captions [70, 130): five words over [70, 100), one revealed every
 *   6 frames with a 6-frame pop and the current word in the accent colour,
 *   then four words over [100, 130), one of them `<b>&"'`;
 * - sentence captions [135, 175), centred, fading in over 4 frames;
 * - nothing on [130, 135) and [175, 180).
 */
const PLAN: RenderPlan = {
  version: PLAN_VERSION,
  productionId: "prod-overlay-parity",
  revision: 1,
  profile: "instagram",
  canvas: { width: W, height: H, fps: FPS },
  durationFrames: DURATION,
  video: [],
  audio: [],
  graphics: [
    graphic("clip-title", 0, 60, "graphics.title-card", { title: "Studio Parity Check", subtitle: "Preview and export, frame for frame", align: "center", scrim: true }, 4),
    graphic("clip-lower", 50, 80, "graphics.lower-third", { title: "Ada Lovelace", subtitle: "Analyst, Engine No. 1" }, 3),
    graphic(
      "clip-kinetic",
      70,
      60,
      "captions.timed",
      {
        preset: "kinetic",
        position: "lower",
        cues: [
          { start: 0, end: 30, text: "Every word pops right here" },
          { start: 30, end: 60, text: `Escape <b>&"' safely now` },
        ],
      },
      2
    ),
    graphic("clip-sentence", 135, 40, "captions.timed", { preset: "sentence", position: "center", accent: "#00ccff", cues: [{ start: 0, end: 40, text: "A whole sentence fades in at once" }] }, 2),
  ],
  captions: [],
  inputs: [],
  loudness: { targetLufs: -14 },
};

/** The sampled frames and what each one exercises. */
const FRAMES: readonly (readonly [number, string])[] = [
  [0, "title entry, first frame"],
  [4, "title entry, mid scale and fade"],
  [9, "title entry, late"],
  [30, "title steady"],
  [54, "title exit and lower third entry, mid"],
  [57, "title exit late, lower third entry late"],
  [66, "lower third steady"],
  [72, "kinetic word 1 popping"],
  [79, "kinetic word 2 popping, accent"],
  [87, "kinetic word 3 late in its pop, accent"],
  [98, "kinetic cue 1 last word popping, accent"],
  [103, "kinetic cue 2 word 1 popping"],
  [109, "kinetic escaped word popping"],
  [125, "lower third exit, mid"],
  [128, "lower third exit late, last word settled, accent"],
  [132, "nothing visible"],
  [136, "sentence fade, mid"],
  [150, "sentence steady"],
  [174, "sentence last frame"],
  [178, "nothing visible"],
];

/** The sampled frames on which nothing is visible. */
const EMPTY = new Set([132, 178]);

/** Negative controls: preview frame N against export frame N + 3, during an animation. */
const SHIFTED_IN_TIME = [4, 54, 72, 136] as const;

/** Negative control: the kinetic captions with a white accent, previewed on a frame with an accented word. */
const ACCENT_FRAME = 87;
const WRONG_ACCENT: RenderPlan = {
  ...PLAN,
  graphics: PLAN.graphics.map((g) =>
    g.clipId === "clip-kinetic" ? { ...g, capability: { ...g.capability, params: { ...(g.capability.params as Record<string, JsonValue>), accent: "#ffffff" } } } : g
  ),
};

interface Rgba {
  data: Buffer;
  width: number;
  height: number;
}

async function decode(png: Buffer): Promise<Rgba> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`expected 4 channels, got ${info.channels}`);
  return { data, width: info.width, height: info.height };
}

/** The image moved `dx` pixels right, transparent where nothing moved in. */
function shifted(image: Rgba, dx: number): Rgba {
  const data = Buffer.alloc(image.data.length);
  const row = image.width * 4;
  for (let y = 0; y < image.height; y++) image.data.copy(data, y * row + dx * 4, y * row, (y + 1) * row - dx * 4);
  return { ...image, data };
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Metrics {
  /** Mean absolute difference per channel over every pixel, colour premultiplied by alpha. */
  mean: [number, number, number, number];
  /** Fraction of pixels whose largest channel difference exceeds 64. */
  over64: number;
  preview: Box | null;
  exported: Box | null;
  /** Largest edge distance between the two alpha coverage boxes, 0 when both are empty, Infinity when only one is. */
  boxDelta: number;
}

function coverage(image: Rgba): Box | null {
  let box: Box | null = null;
  const { data, width, height } = image;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (!box) box = { left: x, top: y, right: x, bottom: y };
      else {
        if (x < box.left) box.left = x;
        if (x > box.right) box.right = x;
        if (y < box.top) box.top = y;
        if (y > box.bottom) box.bottom = y;
      }
    }
  }
  return box;
}

/**
 * Compares two RGBA frames. Colour is compared premultiplied by alpha: a
 * screenshot's straight colour is undefined where alpha is 0 and quantised
 * coarsely where it is small, while premultiplied colour is what compositing
 * over the footage actually uses.
 */
function compare(preview: Rgba, exported: Rgba): Metrics {
  if (preview.width !== exported.width || preview.height !== exported.height) throw new Error("frame sizes differ");
  const a = preview.data;
  const b = exported.data;
  const sums = [0, 0, 0, 0];
  let over = 0;
  for (let i = 0; i < a.length; i += 4) {
    const aa = a[i + 3];
    const ba = b[i + 3];
    let worst = Math.abs(aa - ba);
    sums[3] += worst;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs((a[i + c] * aa) / 255 - (b[i + c] * ba) / 255);
      sums[c] += d;
      if (d > worst) worst = d;
    }
    if (worst > 64) over++;
  }
  const pixels = a.length / 4;
  const pb = coverage(preview);
  const eb = coverage(exported);
  const boxDelta =
    pb && eb
      ? Math.max(Math.abs(pb.left - eb.left), Math.abs(pb.top - eb.top), Math.abs(pb.right - eb.right), Math.abs(pb.bottom - eb.bottom))
      : pb || eb
        ? Infinity
        : 0;
  return { mean: sums.map((s) => s / pixels) as Metrics["mean"], over64: over / pixels, preview: pb, exported: eb, boxDelta };
}

/**
 * The recorded thresholds. The two sides are drawn by differently configured
 * browsers on purpose: the export forces sRGB, software raster, grayscale
 * anti-aliasing and no hinting (`OVERLAY_CHROME_ARGS`), the preview uses the
 * browser's defaults, so glyph and rounded-corner edges differ by a few
 * levels of coverage. Geometry, timing and colour must not differ.
 *
 * Measured on Apple Silicon with Chrome for Testing 146.0.7680.153, over the
 * 20 sampled frames (the table this test logs, identical run to run): worst
 * mean per channel 0.185 (alpha, frame 9), worst over-64 fraction 0.00057
 * (frame 98, about 1,200 edge pixels of a full kinetic caption over the
 * lower third), worst coverage box delta 1 px. The thresholds are mean 0.5
 * (2.7x the worst), over-64 fraction 0.0015 (2.6x, about 3,100 pixels) and
 * box 2 px (the acceptance criterion's figure).
 *
 * The fractions are over the whole canvas, so the smallest real
 * disagreement sets how tight they must be: one accented word drawn white
 * instead of yellow measured 0.0029 over-64 (about 6,000 pixels), 1.9x the
 * threshold. Every negative control (preview frame N against export frame
 * N + 3, a preview 4 px to the right, that wrong accent) fails the mean or
 * over-64 threshold on its own, before the box check.
 */
const MAX_MEAN = 0.5;
const MAX_OVER64 = 0.0015;
const MAX_BOX_DELTA = 2;

/** Whether the colour and coverage measurements alone are within the thresholds. */
const pixelsAgree = (m: Metrics) => m.mean.every((v) => v <= MAX_MEAN) && m.over64 <= MAX_OVER64;

/** Attribute-escapes a document for `srcdoc="..."`. */
const attribute = (html: string) => html.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const hostPage = (srcdoc: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;background:transparent}iframe{display:block;border:0;width:${W}px;height:${H}px}</style></head>` +
  `<body><iframe sandbox="" width="${W}" height="${H}" srcdoc="${attribute(srcdoc)}"></iframe></body></html>`;

/** Processes whose command line names the folder: every browser this test starts does. */
function processesUsing(dir: string): string[] {
  return execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf-8" })
    .split("\n")
    .filter((line) => line.includes(dir) && !line.includes(" ps "));
}

const fmt = (n: number) => (n === Infinity ? "inf" : n.toFixed(n < 0.01 && n > 0 ? 5 : 3));
const boxText = (b: Box | null) => (b ? `${b.left},${b.top}-${b.right},${b.bottom}` : "none");

describe.skipIf(CHROME_MISSING)(`overlay preview and export parity${CHROME_MISSING ? ` (skipped: ${CHROME_MISSING})` : ""}`, () => {
  let root: string;
  let fonts: FontAsset[];

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "cb-overlay-parity-")));
    fonts = await bundledFonts();
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** Every frame of the plan from the export renderer, as the executor streams them, keeping the ones asked for. */
  async function exportFrames(wanted: ReadonlySet<number>): Promise<Map<number, Rgba>> {
    const overlay = buildOverlay(PLAN, { catalog: DEFAULT_CATALOG, fonts, target: "export" });
    const renderer = await OverlayRenderer.open({
      executablePath: chromeExecutable()!,
      overlay,
      fonts,
      canvas: { width: W, height: H },
      fps: FPS,
      durationFrames: DURATION,
      workers: 4,
      profileDir: path.join(root, "export"),
      signal: new AbortController().signal,
    });
    const pngs = new Map<number, Buffer>();
    try {
      let frame = 0;
      await renderer.stream(async (png) => {
        if (wanted.has(frame)) pngs.set(frame, png);
        frame++;
      });
      expect(frame).toBe(DURATION);
    } finally {
      await renderer.close();
    }
    const frames = new Map<number, Rgba>();
    for (const [n, png] of pngs) frames.set(n, await decode(png));
    return frames;
  }

  /** The preview of each frame in a creator's browser: default flags, a sandboxed iframe, a transparent screenshot. */
  async function previewFrames(shots: readonly { frame: number; plan: RenderPlan }[]): Promise<Rgba[]> {
    let browser: Browser | null = null;
    const frames: Rgba[] = [];
    const profile = path.join(root, "preview");
    try {
      browser = await puppeteer.launch({
        executablePath: chromeExecutable()!,
        headless: true,
        pipe: true,
        userDataDir: profile,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      // The process check at the end is not vacuous: this browser is found by its profile folder.
      expect(processesUsing(profile).length).toBeGreaterThan(0);
      const page = await browser.newPage();
      await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
      const outside: string[] = [];
      page.on("request", (request) => {
        const url = request.url();
        if (!url.startsWith("data:") && url !== "about:blank" && url !== "about:srcdoc") outside.push(request.resourceType());
      });
      for (const { frame: n, plan } of shots) {
        const doc = buildOverlay(plan, { catalog: DEFAULT_CATALOG, fonts, target: "preview" });
        await page.setContent(hostPage(previewOverlayAt(doc, n, FPS)), { waitUntil: "load" });
        const frame = page.frames().find((f) => f !== page.mainFrame());
        expect(frame, `frame ${n}: the preview iframe`).toBeDefined();
        // The sandboxed document's fonts are data: URLs, loaded when text first uses them.
        const fontsState = await frame!.evaluate(async () => {
          await document.fonts.ready;
          const faces = Array.from(document.fonts);
          return { status: document.fonts.status, loaded: faces.filter((f) => f.status === "loaded").length, failed: faces.filter((f) => f.status === "error").length };
        });
        expect(fontsState, `frame ${n}: preview fonts`).toMatchObject({ status: "loaded", failed: 0 });
        if (!EMPTY.has(n)) expect(fontsState.loaded, `frame ${n}: preview fonts in use`).toBeGreaterThan(0);
        const png = await page.screenshot({ type: "png", omitBackground: true });
        frames.push(await decode(Buffer.from(png)));
      }
      expect(outside).toEqual([]);
    } finally {
      await browser?.close();
    }
    return frames;
  }

  it("draws the same overlay in a sandboxed preview iframe and in the export at 20 sampled frames", async () => {
    const started = performance.now();
    const sampled = FRAMES.map(([n]) => n);
    const exportWanted = new Set([...sampled, ...SHIFTED_IN_TIME.map((n) => n + 3)]);
    const shots = [...sampled.map((frame) => ({ frame, plan: PLAN })), { frame: ACCENT_FRAME, plan: WRONG_ACCENT }];
    const [exported, previewShots] = await Promise.all([exportFrames(exportWanted), previewFrames(shots)]);
    const preview = new Map(sampled.map((n, i) => [n, previewShots[i]]));
    const wrongAccent = previewShots[sampled.length];

    const rows: string[] = ["frame  meanR   meanG   meanB   meanA   over64   box(preview)           box(export)            boxDelta  what"];
    const results = FRAMES.map(([n, what]) => {
      const p = preview.get(n)!;
      const e = exported.get(n)!;
      expect([p.width, p.height, e.width, e.height]).toEqual([W, H, W, H]);
      const m = compare(p, e);
      rows.push(
        `${String(n).padStart(5)}  ${m.mean.map((v) => fmt(v).padEnd(6)).join("  ")}  ${fmt(m.over64).padEnd(7)}  ${boxText(m.preview).padEnd(21)}  ${boxText(m.exported).padEnd(21)}  ${fmt(m.boxDelta).padEnd(8)}  ${what}`
      );
      return { n, what, m };
    });

    const controls = [
      ...SHIFTED_IN_TIME.map((n) => ({ label: `preview ${n} vs export ${n + 3}`, m: compare(preview.get(n)!, exported.get(n + 3)!) })),
      ...[30, 66, 98, 150].map((n) => ({ label: `preview ${n} shifted 4 px vs export ${n}`, m: compare(shifted(preview.get(n)!, 4), exported.get(n)!) })),
      { label: `preview ${ACCENT_FRAME} white accent vs export`, m: compare(wrongAccent, exported.get(ACCENT_FRAME)!) },
    ];
    rows.push("negative controls (each must fail):");
    for (const { label, m } of controls) {
      rows.push(`  ${label.padEnd(36)} mean ${m.mean.map(fmt).join("/")}  over64 ${fmt(m.over64)}  boxDelta ${fmt(m.boxDelta)}`);
    }
    const worst = {
      mean: Math.max(...results.flatMap((r) => r.m.mean)),
      over64: Math.max(...results.map((r) => r.m.over64)),
      boxDelta: Math.max(...results.map((r) => r.m.boxDelta)),
    };
    rows.push(`worst sampled: mean ${fmt(worst.mean)}  over64 ${fmt(worst.over64)}  boxDelta ${fmt(worst.boxDelta)}; thresholds mean <= ${MAX_MEAN}, over64 <= ${MAX_OVER64}, boxDelta <= ${MAX_BOX_DELTA}`);
    rows.push(`elapsed ${((performance.now() - started) / 1000).toFixed(1)} s`);
    console.info(`overlay preview/export parity at ${W}x${H} ${FPS} fps\n${rows.join("\n")}`);

    // Frames where nothing is visible are empty on both sides, and every other frame shows something on both.
    for (const { n, m } of results) {
      const empty = EMPTY.has(n);
      expect(m.preview === null, `frame ${n}: preview empty`).toBe(empty);
      expect(m.exported === null, `frame ${n}: export empty`).toBe(empty);
    }
    for (const { n, m } of results) {
      expect(m.boxDelta, `frame ${n}: coverage box`).toBeLessThanOrEqual(MAX_BOX_DELTA);
      expect(m.over64, `frame ${n}: pixels differing by more than 64`).toBeLessThanOrEqual(MAX_OVER64);
      for (const [c, v] of m.mean.entries()) expect(v, `frame ${n}: mean difference of channel ${"RGBA"[c]}`).toBeLessThanOrEqual(MAX_MEAN);
    }
    // Each negative control fails on colour and coverage alone, without relying on the box check.
    for (const { label, m } of controls) expect(pixelsAgree(m), `negative control ${label}`).toBe(false);

    expect(processesUsing(root)).toEqual([]);
  }, 120_000);
});
