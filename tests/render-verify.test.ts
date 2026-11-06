/**
 * Export verification (#144). The pure parsers and every check run against
 * recorded tool output (`tests/fixtures/render-ffprobe.json` is ffprobe 9.0.2
 * on a one-second 1080x1920 30 fps profile-conformant MP4), so CI covers them
 * without FFmpeg; a gated test runs the real tools on files made here.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toolPath } from "@/lib/video/media/tools";
import type { RenderPlan } from "@/lib/video/render/plan";
import { INSTAGRAM_PROFILE } from "@/lib/video/render/profile";
import {
  bufferSource,
  checkExport,
  parseEbur128Summary,
  parseProbe,
  rateIs,
  topLevelBoxes,
  verifyExport,
  VerifyInputError,
  type CheckInput,
  type Mp4Box,
} from "@/lib/video/render/verify";
import { FFMPEG_MISSING } from "./helpers/media-fixtures";

const RECORDED = path.join(__dirname, "fixtures", "render-ffprobe.json");

/** ebur128's summary for FFmpeg's 440 Hz test tone, as FFmpeg 9.0.2 prints it at the end of stderr. */
const TONE_SUMMARY = `  Stream #0:0(und): Audio: pcm_s16le, 48000 Hz, stereo, s16, 1536 kb/s (default)
[Parsed_ebur128_0 @ 0x763cc74a80] Summary:

  Integrated loudness:
    I:         -21.8 LUFS
    Threshold: -31.8 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold:   0.0 LUFS
    LRA low:     0.0 LUFS
    LRA high:    0.0 LUFS

  True peak:
    Peak:      -20.8 dBFS
[out#0/null @ 0x763cc74300] video:0KiB audio:188KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:00:01.00 bitrate=N/A speed= 102x elapsed=0:00:00.00
`;

const SILENT_SUMMARY = `[Parsed_ebur128_0 @ 0x748885c900] Summary:

  Integrated loudness:
    I:         -70.0 LUFS
    Threshold:   0.0 LUFS

  True peak:
    Peak:       -inf dBFS
`;

function plan(overrides: Partial<RenderPlan> = {}): RenderPlan {
  return {
    version: 1,
    productionId: "prod-verify",
    revision: 3,
    profile: "instagram",
    canvas: { width: 1080, height: 1920, fps: 30 },
    durationFrames: 30,
    video: [],
    audio: [],
    graphics: [],
    captions: [],
    inputs: [],
    loudness: { targetLufs: -14 },
    ...overrides,
  };
}

const FASTSTART: Mp4Box[] = [
  { type: "ftyp", offset: 0, size: 32 },
  { type: "moov", offset: 32, size: 2466 },
  { type: "free", offset: 2498, size: 8 },
  { type: "mdat", offset: 2506, size: 788236 },
];

type Raw = { streams: Record<string, unknown>[]; format: Record<string, unknown> };
let recorded: string;
beforeAll(async () => {
  recorded = await readFile(RECORDED, "utf-8");
});

function input(edit: (raw: Raw) => void = () => undefined, extra: Partial<CheckInput> = {}): CheckInput {
  const raw = JSON.parse(recorded) as Raw;
  edit(raw);
  return {
    probe: parseProbe(JSON.stringify(raw)),
    boxes: FASTSTART,
    measured: { integratedLufs: -14.3, truePeakDb: -1.4 },
    plan: plan(),
    profile: INSTAGRAM_PROFILE,
    normalisation: "linear",
    maxDurationMs: 90_000,
    ...extra,
  };
}

const failed = (i: CheckInput) => {
  const report = checkExport(i);
  return { ok: report.ok, failed: report.checks.filter((c) => c.status === "failed").map((c) => c.id) };
};

const video = (raw: Raw) => raw.streams.find((s) => s.codec_type === "video")!;
const audio = (raw: Raw) => raw.streams.find((s) => s.codec_type === "audio")!;

describe("checking a probed export", () => {
  it("passes a conformant file, recording what each check expected and found", () => {
    const report = checkExport(input());
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.status === "passed")).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      "container",
      "video_streams",
      "video_codec",
      "video_profile",
      "pixel_format",
      "width",
      "height",
      "r_frame_rate",
      "avg_frame_rate",
      "frame_count",
      "color_primaries",
      "color_transfer",
      "color_space",
      "color_range",
      "video_duration",
      "audio_streams",
      "audio_codec",
      "audio_profile",
      "sample_rate",
      "channels",
      "audio_duration",
      "duration",
      "max_duration",
      "faststart",
      "integrated_loudness",
      "true_peak",
    ]);
    expect(report.checks.find((c) => c.id === "frame_count")).toEqual({ id: "frame_count", status: "passed", expected: 30, actual: 30 });
    expect(report.checks.find((c) => c.id === "faststart")!.actual).toBe("ftyp,moov,free,mdat");
  });

  const cases: [string, (raw: Raw) => void, string[]][] = [
    ["a Matroska container", (r) => (r.format.format_name = "matroska,webm"), ["container"]],
    ["a QuickTime brand", (r) => ((r.format.tags as Record<string, string>).major_brand = "qt  "), ["container"]],
    ["two video streams", (r) => r.streams.push({ ...video(r) }), ["video_streams", "video_codec", "video_profile", "pixel_format", "width", "height", "r_frame_rate", "avg_frame_rate", "frame_count", "color_primaries", "color_transfer", "color_space", "color_range", "video_duration"]],
    ["HEVC", (r) => (video(r).codec_name = "hevc"), ["video_codec"]],
    ["the Main profile", (r) => (video(r).profile = "Main"), ["video_profile"]],
    ["10-bit pixels", (r) => (video(r).pix_fmt = "yuv420p10le"), ["pixel_format"]],
    ["another size", (r) => Object.assign(video(r), { width: 1080, height: 1350 }), ["height"]],
    ["NTSC frame rates", (r) => Object.assign(video(r), { r_frame_rate: "30000/1001", avg_frame_rate: "2997/100" }), ["r_frame_rate", "avg_frame_rate"]],
    ["a dropped frame", (r) => (video(r).nb_read_packets = "29"), ["frame_count"]],
    ["BT.2020 primaries", (r) => (video(r).color_primaries = "bt2020"), ["color_primaries"]],
    ["an HLG transfer", (r) => (video(r).color_transfer = "arib-std-b67"), ["color_transfer"]],
    ["a BT.601 matrix", (r) => (video(r).color_space = "smpte170m"), ["color_space"]],
    ["full range", (r) => (video(r).color_range = "pc"), ["color_range"]],
    ["untagged colour", (r) => ["color_primaries", "color_transfer", "color_space", "color_range"].forEach((k) => delete video(r)[k]), ["color_primaries", "color_transfer", "color_space", "color_range"]],
    ["long video", (r) => (video(r).duration = "1.100000"), ["video_duration"]],
    ["no audio stream", (r) => r.streams.splice(r.streams.indexOf(audio(r)), 1), ["audio_streams", "audio_codec", "audio_profile", "sample_rate", "channels", "audio_duration"]],
    ["MP3 audio", (r) => (audio(r).codec_name = "mp3"), ["audio_codec"]],
    ["HE-AAC", (r) => (audio(r).profile = "HE-AAC"), ["audio_profile"]],
    ["44.1 kHz", (r) => (audio(r).sample_rate = "44100"), ["sample_rate"]],
    ["mono", (r) => (audio(r).channels = 1), ["channels"]],
    ["short audio", (r) => (audio(r).duration = "0.900000"), ["audio_duration"]],
    ["a long container", (r) => (r.format.duration = "1.050000"), ["duration"]],
    ["no container duration", (r) => delete r.format.duration, ["duration", "max_duration"]],
  ];
  it.each(cases)("fails %s", (_name, edit, ids) => {
    expect(failed(input(edit))).toEqual({ ok: false, failed: ids });
  });

  it("accepts a frame rate written with another denominator", () => {
    expect(rateIs("60/2", 30)).toBe(true);
    expect(rateIs("30/1", 30)).toBe(true);
    expect(rateIs("0/0", 30)).toBe(false);
    expect(rateIs("30", 30)).toBe(false);
    expect(failed(input((r) => (video(r).r_frame_rate = "60/2")))).toEqual({ ok: true, failed: [] });
  });

  it("allows a duration within one frame, and not beyond", () => {
    expect(failed(input((r) => (r.format.duration = "1.033000"))).ok).toBe(true);
    expect(failed(input((r) => (r.format.duration = "1.034000"))).failed).toEqual(["duration"]);
  });

  it("fails a file longer than the production allows", () => {
    expect(failed(input(undefined, { maxDurationMs: 999 }))).toEqual({ ok: false, failed: ["max_duration"] });
    expect(failed(input(undefined, { maxDurationMs: 1000 })).ok).toBe(true);
  });

  it("fails mdat before moov, a missing moov and unreadable boxes", () => {
    const late = [FASTSTART[0], FASTSTART[3], FASTSTART[1]];
    expect(failed(input(undefined, { boxes: late }))).toEqual({ ok: false, failed: ["faststart"] });
    expect(failed(input(undefined, { boxes: [FASTSTART[0], FASTSTART[3]] })).failed).toEqual(["faststart"]);
    const unreadable = checkExport(input(undefined, { boxes: null }));
    expect(unreadable.checks.find((c) => c.id === "faststart")).toMatchObject({ status: "failed", actual: null });
  });

  it("fails loudness off target, a peak over the ceiling and a missing measurement", () => {
    expect(failed(input(undefined, { measured: { integratedLufs: -15.2, truePeakDb: -1.4 } })).failed).toEqual(["integrated_loudness"]);
    expect(failed(input(undefined, { measured: { integratedLufs: -13.1, truePeakDb: -1.4 } })).ok).toBe(true);
    expect(failed(input(undefined, { measured: { integratedLufs: -14, truePeakDb: -0.6 } })).failed).toEqual(["true_peak"]);
    expect(failed(input(undefined, { measured: null })).failed).toEqual(["integrated_loudness", "true_peak"]);
  });

  it("records loudness as skipped, with the reason, when the mix was not normalised", () => {
    for (const normalisation of ["no-audio", "skipped-silence"] as const) {
      const report = checkExport(input(undefined, { normalisation, measured: null }));
      expect(report.ok).toBe(true);
      const skipped = report.checks.filter((c) => c.status === "skipped");
      expect(skipped.map((c) => c.id)).toEqual(["integrated_loudness", "true_peak"]);
      expect(skipped.every((c) => typeof c.reason === "string" && c.reason.length > 0)).toBe(true);
    }
  });

  it("refuses ffprobe output that is not its JSON", () => {
    expect(() => parseProbe("not json")).toThrow(VerifyInputError);
    expect(() => parseProbe(JSON.stringify({ streams: [] }))).toThrow(VerifyInputError);
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: "video", width: "wide", nb_read_packets: "x" }], format: {} })).streams[0]).toMatchObject({ codecType: "video", width: undefined, packets: undefined });
  });
});

describe("ebur128 summaries", () => {
  it("reads integrated loudness and true peak from the summary", () => {
    expect(parseEbur128Summary(TONE_SUMMARY)).toEqual({ integratedLufs: -21.8, truePeakDb: -20.8 });
    expect(parseEbur128Summary(SILENT_SUMMARY)).toEqual({ integratedLufs: -70, truePeakDb: -Infinity });
  });

  it("reads the last summary only, and nothing without one", () => {
    expect(parseEbur128Summary(SILENT_SUMMARY + TONE_SUMMARY)).toEqual({ integratedLufs: -21.8, truePeakDb: -20.8 });
    expect(parseEbur128Summary("[Parsed_ebur128_0] t: 0.1 M: -120.7 S:-120.7 I: -70.0 LUFS")).toBeNull();
    expect(parseEbur128Summary("Summary:\n  Integrated loudness:\n    I: -14.0 LUFS\n")).toBeNull();
  });
});

describe("top-level MP4 boxes", () => {
  const box = (type: string, payload: number) => {
    const b = Buffer.alloc(8 + payload);
    b.writeUInt32BE(8 + payload, 0);
    b.write(type, 4, "latin1");
    return b;
  };
  const large = (type: string, payload: number) => {
    const b = Buffer.alloc(16 + payload);
    b.writeUInt32BE(1, 0);
    b.write(type, 4, "latin1");
    b.writeBigUInt64BE(BigInt(16 + payload), 8);
    return b;
  };
  const types = async (buffer: Buffer) => (await topLevelBoxes(bufferSource(buffer))).map((b) => `${b.type}@${b.offset}+${b.size}`);

  it("walks faststart and non-faststart layouts", async () => {
    expect(await types(Buffer.concat([box("ftyp", 24), box("moov", 100), box("free", 0), box("mdat", 50)]))).toEqual(["ftyp@0+32", "moov@32+108", "free@140+8", "mdat@148+58"]);
    expect(await types(Buffer.concat([box("ftyp", 24), box("mdat", 50), box("moov", 100)]))).toEqual(["ftyp@0+32", "mdat@32+58", "moov@90+108"]);
  });

  it("reads 64-bit sizes and a last box that runs to the end of the file", async () => {
    expect(await types(Buffer.concat([box("ftyp", 24), box("moov", 10), large("mdat", 40)]))).toEqual(["ftyp@0+32", "moov@32+18", "mdat@50+56"]);
    const open = box("mdat", 30);
    open.writeUInt32BE(0, 0);
    expect(await types(Buffer.concat([box("ftyp", 24), open]))).toEqual(["ftyp@0+32", "mdat@32+38"]);
  });

  it("refuses headers that do not tile the file", async () => {
    const oversize = box("moov", 10);
    oversize.writeUInt32BE(1000, 0);
    await expect(topLevelBoxes(bufferSource(Buffer.concat([box("ftyp", 24), oversize])))).rejects.toThrow(VerifyInputError);
    await expect(topLevelBoxes(bufferSource(Buffer.concat([box("ftyp", 24), Buffer.alloc(4)])))).rejects.toThrow(VerifyInputError);
    const tiny = box("free", 0);
    tiny.writeUInt32BE(4, 0);
    await expect(topLevelBoxes(bufferSource(tiny))).rejects.toThrow(VerifyInputError);
    await expect(topLevelBoxes(bufferSource(Buffer.from([0, 0, 0, 1, 0x6d, 0x64, 0x61, 0x74, 0, 0])))).rejects.toThrow(VerifyInputError);
    expect(await topLevelBoxes(bufferSource(Buffer.alloc(0)))).toEqual([]);
  });
});

describe.skipIf(FFMPEG_MISSING)(`verifying real files${FFMPEG_MISSING ? ` (skipped: ${FFMPEG_MISSING})` : ""}`, () => {
  const run = promisify(execFile);
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "creatorbrio-verify-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function encode(name: string, faststart: boolean): Promise<string> {
    const file = path.join(dir, name);
    await run(toolPath("ffmpeg")!, [
      "-nostdin", "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p",
      "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-threads", "4",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      ...(faststart ? ["-movflags", "+faststart"] : []),
      file,
    ], { timeout: 60_000 });
    return file;
  }

  // The test tone measures about -21.8 LUFS with a -20.8 dBTP peak.
  const tonePlan = plan({ loudness: { targetLufs: -22 } });
  const linear = { measured: null, normalisation: "linear" as const };

  it("passes a conformant file and fails one without faststart", async () => {
    const good = await verifyExport(await encode("good.mp4", true), tonePlan, INSTAGRAM_PROFILE, linear, { maxDurationMs: 90_000 });
    expect(good.checks.filter((c) => c.status !== "passed")).toEqual([]);
    expect(good.ok).toBe(true);
    const slow = await verifyExport(await encode("slow.mp4", false), tonePlan, INSTAGRAM_PROFILE, linear, { maxDurationMs: 90_000 });
    expect(slow.checks.filter((c) => c.status === "failed").map((c) => c.id)).toEqual(["faststart"]);
  });

  it("reports a file that is not media as unreadable", async () => {
    const file = path.join(dir, "text.mp4");
    await writeFile(file, "not a video");
    const report = await verifyExport(file, tonePlan, INSTAGRAM_PROFILE, linear, { maxDurationMs: 90_000 });
    expect(report).toEqual({ ok: false, checks: [{ id: "readable", status: "failed", expected: "an MP4 file ffprobe can read", actual: "unreadable" }] });
  });
});
