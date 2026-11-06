/**
 * Still-image orientation in the media facts (#144 review): a phone photo is
 * stored landscape with EXIF Orientation 6, which FFmpeg attaches only to
 * the decoded frame and turns upright on decode. The facts must give the
 * same upright size, or the export's placement stretches the picture.
 *
 * The parsing is tested on ffprobe-shaped JSON for every EXIF orientation;
 * real synthetic JPEGs and a PNG (EXIF bytes written by hand) are probed,
 * decoded and imported where FFmpeg is installed.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseImageOrientation, probeFile, UnsupportedMedia } from "@/lib/video/media/facts";
import { MediaJobs } from "@/lib/video/media/jobs";
import { ImportFailure, MediaRegistry } from "@/lib/video/media/registry";
import { toolPath } from "@/lib/video/media/tools";
import { displaySize } from "@/lib/video/render/placement";
import { jpegWithOrientation, pngWithOrientation, type ExifOrientation } from "./helpers/exif-orientation";
import { FFMPEG_MISSING } from "./helpers/media-fixtures";

const run = promisify(execFile);

/** The 2x2 part of FFmpeg's display matrix for each EXIF orientation, in 16.16 units, as FFmpeg 9 decodes them. */
const MATRIX: Record<ExifOrientation, [number, number, number, number]> = {
  1: [1, 0, 0, 1],
  2: [-1, 0, 0, 1],
  3: [-1, 0, 0, -1],
  4: [1, 0, 0, -1],
  5: [0, 1, 1, 0],
  6: [0, 1, -1, 0],
  7: [0, -1, -1, 0],
  8: [0, -1, 1, 0],
};
/** ffprobe's `rotation` for the same matrices: it cannot tell a mirror from a turn. */
const PROBE_ROTATION: Record<ExifOrientation, number> = { 1: 0, 2: -180, 3: -180, 4: 0, 5: -90, 6: -90, 7: 90, 8: 90 };

/** ffprobe's printed display matrix, `%08x:` row numbers and `%11d` entries. */
function printed(entries: number[]): string {
  const row = (i: number) => `${i.toString(16).padStart(8, "0")}: ${entries.slice(i * 3, i * 3 + 3).map((v) => String(v).padStart(11)).join(" ")}`;
  return `\n${row(0)}\n${row(1)}\n${row(2)}\n`;
}

function frameJson(sideData: Record<string, unknown>[] | undefined): string {
  return JSON.stringify({ frames: [{ media_type: "video", width: 320, height: 240, ...(sideData ? { side_data_list: sideData } : {}) }] });
}

function orientationFrame(o: ExifOrientation): string {
  const [a, b, c, d] = MATRIX[o].map((v) => v * 65536);
  return frameJson([
    { side_data_type: "3x3 displaymatrix", displaymatrix: printed([a, b, 0, c, d, 0, 0, 0, 1 << 30]), rotation: PROBE_ROTATION[o] },
    { side_data_type: "EXIF metadata", size: 26 },
  ]);
}

describe("still image orientation from the decoded frame's display matrix", () => {
  it("reads the four quarter turns as the clockwise turn a player applies", () => {
    expect(parseImageOrientation(orientationFrame(1))).toBe(0);
    expect(parseImageOrientation(orientationFrame(3))).toBe(180);
    expect(parseImageOrientation(orientationFrame(6))).toBe(90);
    expect(parseImageOrientation(orientationFrame(8))).toBe(270);
  });

  it("refuses the mirrored orientations, which ffprobe's rotation would misreport as turns", () => {
    for (const o of [2, 4, 5, 7] as const) {
      expect(() => parseImageOrientation(orientationFrame(o)), `orientation ${o}`).toThrow(UnsupportedMedia);
      expect(() => parseImageOrientation(orientationFrame(o)), `orientation ${o}`).toThrow(/mirrored/);
    }
  });

  it("keeps the stream's facts when the frame has no display matrix", () => {
    expect(parseImageOrientation(frameJson(undefined))).toBeNull();
    expect(parseImageOrientation(frameJson([{ side_data_type: "EXIF metadata", size: 14 }]))).toBeNull();
  });

  it("refuses an image that does not decode, and any matrix that is not an unscaled quarter turn", () => {
    expect(() => parseImageOrientation(JSON.stringify({ frames: [] }))).toThrow(/could not be decoded/);
    expect(() => parseImageOrientation("{}")).toThrow(/could not be decoded/);
    expect(() => parseImageOrientation("not json")).toThrow(UnsupportedMedia);
    const s = Math.round(65536 * Math.SQRT1_2);
    const odd = (entries: number[]) => frameJson([{ side_data_type: "3x3 displaymatrix", displaymatrix: printed(entries) }]);
    expect(() => parseImageOrientation(odd([s, s, 0, -s, s, 0, 0, 0, 1 << 30]))).toThrow(/not a quarter turn/); // 45 degrees
    expect(() => parseImageOrientation(odd([131072, 0, 0, 0, 131072, 0, 0, 0, 1 << 30]))).toThrow(/not a quarter turn/); // scaled
    expect(() => parseImageOrientation(odd([65536, 65536, 0, 0, 65536, 0, 0, 0, 1 << 30]))).toThrow(/not a quarter turn/); // sheared
    expect(() => parseImageOrientation(frameJson([{ side_data_type: "3x3 displaymatrix", displaymatrix: "garbled" }]))).toThrow(/could not be read/);
    const twice = JSON.parse(orientationFrame(6));
    twice.frames[0].side_data_list.push(twice.frames[0].side_data_list[0]);
    expect(() => parseImageOrientation(JSON.stringify(twice))).toThrow(/more than one/);
  });
});

describe.skipIf(FFMPEG_MISSING)(`EXIF-oriented images probed, decoded and imported${FFMPEG_MISSING ? ` (skipped: ${FFMPEG_MISSING})` : ""}`, () => {
  let work: string;
  let plainJpeg: Buffer;
  let plainPng: Buffer;

  const ffmpeg = (args: string[]) => run(toolPath("ffmpeg")!, ["-nostdin", "-hide_banner", "-v", "error", "-y", ...args], { timeout: 60_000 });

  beforeAll(async () => {
    work = await realpath(await mkdtemp(path.join(tmpdir(), "cb-orientation-")));
    // 320x240 stored, as a phone stores a portrait photo landscape.
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1", "-frames:v", "1", "-q:v", "2", path.join(work, "plain.jpg")]);
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1", "-frames:v", "1", "-update", "1", path.join(work, "plain.png")]);
    plainJpeg = await readFile(path.join(work, "plain.jpg"));
    plainPng = await readFile(path.join(work, "plain.png"));
  });
  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  async function oriented(o: ExifOrientation, order: "MM" | "II" = "MM"): Promise<string> {
    const file = path.join(work, `o${o}-${order}.jpg`);
    await writeFile(file, jpegWithOrientation(plainJpeg, o, order));
    return file;
  }

  /** The size FFmpeg decodes the still to with the export's own still options (autorotation on). */
  async function decodedSize(file: string): Promise<{ width: number; height: number }> {
    const { stderr } = await run(toolPath("ffmpeg")!, ["-nostdin", "-hide_banner", "-v", "info", "-loop", "1", "-framerate", "30", "-t", "0.1", "-i", file, "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-"], { encoding: "utf-8" });
    const m = / s:(\d+)x(\d+) /.exec(stderr);
    if (!m) throw new Error("showinfo printed no frame size");
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  it("records the quarter turn of JPEG orientations 1, 3, 6 and 8, so the upright size is the one FFmpeg decodes", async () => {
    const expected: [ExifOrientation, 0 | 90 | 180 | 270][] = [[1, 0], [3, 180], [6, 90], [8, 270]];
    for (const [o, rotation] of expected) {
      for (const order of ["MM", "II"] as const) {
        const file = await oriented(o, order);
        const facts = await probeFile(file);
        expect(facts.kind, `orientation ${o} ${order}`).toBe("image");
        expect(facts.video, `orientation ${o} ${order}`).toMatchObject({ codec: "mjpeg", width: 320, height: 240, rotation });
        expect(displaySize(facts.video!), `orientation ${o} ${order}: the facts' upright size is the decoded size`).toEqual(await decodedSize(file));
      }
    }
  });

  it("records PNG eXIf orientation the same way", async () => {
    const file = path.join(work, "o6.png");
    await writeFile(file, pngWithOrientation(plainPng, 6));
    const facts = await probeFile(file);
    expect(facts.video).toMatchObject({ codec: "png", width: 320, height: 240, rotation: 90 });
    expect(displaySize(facts.video!)).toEqual(await decodedSize(file));
  });

  it("refuses mirrored JPEG orientations at import with a typed outcome", async () => {
    const registry = new MediaRegistry({ dataDir: path.join(work, "data-mirrored") });
    for (const o of [2, 4, 5, 7] as const) {
      await expect(probeFile(await oriented(o)), `orientation ${o}`).rejects.toThrow(/mirrored/);
      const error = await registry.importPath(await oriented(o, "II")).then(
        () => null,
        (e: unknown) => e
      );
      expect(error, `orientation ${o}`).toBeInstanceOf(ImportFailure);
      expect((error as ImportFailure).code).toBe("unsupported_media");
    }
  });

  it("builds an upright, unstretched image proxy for an Orientation 6 photo", async () => {
    const registry = new MediaRegistry({ dataDir: path.join(work, "data-proxy") });
    const jobs = new MediaJobs(registry, { log: () => undefined });
    try {
      const { record } = await registry.importPath(await oriented(6));
      expect(record.facts.video).toMatchObject({ width: 320, height: 240, rotation: 90 });
      await jobs.enqueue(record.mediaId);
      await jobs.idle();
      expect(await jobs.read(record.mediaId)).toMatchObject({ state: "succeeded" });
      const proxy = registry.derivedPath(record.mediaId, "proxy.png");
      // The proxy is the portrait picture at its own size, and carries no orientation a browser would apply again.
      expect(await decodedSize(proxy)).toEqual({ width: 240, height: 320 });
      expect(parseImageOrientation((await run(toolPath("ffprobe")!, ["-v", "error", "-print_format", "json", "-read_intervals", "%+#1", "-show_frames", proxy], { encoding: "utf-8" })).stdout)).toBeNull();
    } finally {
      jobs.stop();
      await jobs.idle();
    }
  });
});
