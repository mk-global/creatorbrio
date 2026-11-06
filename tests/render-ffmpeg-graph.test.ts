/**
 * The export's pure pieces (#144), which run without FFmpeg or Chromium (CI
 * has neither): the FFmpeg argument and filter-graph builders, the gain
 * signal checked sample by sample against `gainAt`, loudnorm parsing, the
 * pinned Chromium flags, the overlay PNG normaliser and the renderer's input
 * checks that refuse before any browser starts.
 */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { gainAt } from "@/lib/video/render/audio-envelope";
import { chromeExecutable, OVERLAY_CHROME_ARGS, sandboxDisablingFlags } from "@/lib/video/render/chrome";
import { RenderFailure, type OverlayDocument } from "@/lib/video/render/execute-types";
import { toRenderFailure } from "@/lib/video/render/execute";
import {
  encodedCheckArgs,
  envelopeSamples,
  floatWav,
  loudnessTargets,
  measureArgs,
  mixRun,
  normaliseArgs,
  parseLoudnorm,
  rangeTarget,
  shapesSound,
  trimArgs,
} from "@/lib/video/render/ffmpeg-audio";
import {
  AUDIO_SAMPLE_RATE,
  audioEncoderArgs,
  graphOptions,
  GraphError,
  MAX_INLINE_GRAPH_BYTES,
  num,
  PREROLL_US,
  runArgs,
  SELECT_TOLERANCE_US,
  totalSamples,
  videoRun,
  type VideoSourceFile,
} from "@/lib/video/render/ffmpeg-graph";
import { OverlayRenderer } from "@/lib/video/render/overlay-renderer";
import { PngShapeError, toRgbaPng, transparentPng } from "@/lib/video/render/overlay-png";
import type { AudioSource, GainPoint, PlanInput, RenderPlan, VideoLayer } from "@/lib/video/render/plan";
import { INSTAGRAM_PROFILE } from "@/lib/video/render/profile";
import { ToolError } from "@/lib/video/media/tools";
// The G1 gate's pinned flags, which the product must use unchanged.
import { CHROME_ARGS } from "../scripts/gates/g1/chrome-args.mjs";

/** The largest difference between the gain signal and `gainAt` (rounded to float32) over a render of `total` samples. */
function maxError(envelope: GainPoint[], total: number): number {
  const samples = envelopeSamples(envelope, total);
  expect(samples.length).toBe(total);
  let worst = 0;
  for (let s = 0; s < total; s++) worst = Math.max(worst, Math.abs(samples[s] - Math.fround(gainAt(envelope, (s * 1e6) / AUDIO_SAMPLE_RATE))));
  return worst;
}

const canvas = { width: 360, height: 640, fps: 30 as const };

function plan(overrides: Partial<RenderPlan> = {}): RenderPlan {
  return {
    version: 1,
    productionId: "prod-1",
    revision: 3,
    profile: "instagram",
    canvas,
    durationFrames: 90,
    video: [],
    audio: [],
    graphics: [],
    captions: [],
    inputs: [],
    loudness: { targetLufs: -14 },
    ...overrides,
  };
}

const place = { scaledWidth: 360, scaledHeight: 640, offsetX: 0, offsetY: 0 };

function layer(over: Partial<VideoLayer>): VideoLayer {
  return { clipId: "c", trackId: "t", trackIndex: 0, kind: "video", mediaId: "m1", startFrame: 0, durationFrames: 30, sourceInUs: 0, placement: place, ...over };
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return { mediaId: "m1", kind: "video", display: { width: 360, height: 640 }, rotation: 0, dynamicRange: "sdr", hasAudio: true, durationUs: 10_000_000, ...over };
}

function source(over: Partial<AudioSource>): AudioSource {
  return {
    clipId: "a",
    trackId: "t",
    role: "music",
    mediaId: "m1",
    startFrame: 0,
    durationFrames: 30,
    sourceInUs: 0,
    envelope: [
      { atUs: 0, gain: 1 },
      { atUs: 1_000_000, gain: 1 },
    ],
    ...over,
  };
}

const videoFiles = (...inputs: PlanInput[]) => new Map<string, VideoSourceFile>(inputs.map((i) => [i.mediaId, { path: `/media/${i.mediaId}.mov`, input: i }]));

describe("number formatting", () => {
  it("never uses exponents or negative zero and trims zeros", () => {
    expect(num(0.0000001)).toBe("0.0000001");
    expect(num(-0.0000000001)).toBe("0");
    expect(num(1.5)).toBe("1.5");
    expect(num(2)).toBe("2");
    expect(num(1234567.25)).toBe("1234567.25");
    expect(() => num(Number.NaN)).toThrow(GraphError);
  });

  it("counts the render's samples from frames", () => {
    expect(totalSamples({ durationFrames: 30, canvas })).toBe(48000);
    expect(totalSamples({ durationFrames: 1, canvas: { ...canvas, fps: 24 } })).toBe(2000);
    expect(totalSamples({ durationFrames: 7, canvas: { ...canvas, fps: 60 } })).toBe(5600);
  });
});

describe("envelope gain signal", () => {
  it("is exactly gainAt at every sample for ramps, steps and holds, and silent outside", () => {
    const envelope: GainPoint[] = [
      { atUs: 100_000, gain: 0 },
      { atUs: 600_000, gain: 1 },
      { atUs: 1_200_000, gain: 1 },
      { atUs: 1_200_001, gain: 0.25 },
      { atUs: 2_000_000, gain: 0.25 },
      { atUs: 2_533_333, gain: 0.8 },
      { atUs: 3_000_000, gain: 0 },
    ];
    expect(maxError(envelope, 4 * AUDIO_SAMPLE_RATE)).toBe(0);
    const samples = envelopeSamples(envelope, 4 * AUDIO_SAMPLE_RATE);
    expect(samples[0]).toBe(0);
    expect(samples[AUDIO_SAMPLE_RATE]).toBe(1);
    expect(samples[3.5 * AUDIO_SAMPLE_RATE]).toBe(0);
  });

  it("is exact for a dense, irregular envelope of thousands of points, as a fade over a ducked bed needs", () => {
    const envelope: GainPoint[] = [];
    let at = 33_333;
    for (let i = 0; i < 10_000; i++) {
      envelope.push({ atUs: at, gain: Math.round((0.5 + 0.45 * Math.sin(i / 7)) * 1e6) / 1e6 });
      at += 1 + ((i * 7919) % 2_000);
    }
    const total = Math.ceil((at / 1e6) * AUDIO_SAMPLE_RATE) + 100;
    expect(maxError(envelope, total)).toBe(0);
  });

  it("follows gainAt where points share a time", () => {
    const envelope: GainPoint[] = [
      { atUs: 0, gain: 0.5 },
      { atUs: 500_000, gain: 0.5 },
      { atUs: 500_000, gain: 1 },
      { atUs: 1_000_000, gain: 1 },
    ];
    expect(maxError(envelope, AUDIO_SAMPLE_RATE + 10)).toBe(0);
  });

  it("is written as a mono 48 kHz float WAV", () => {
    const wav = floatWav(new Float32Array([0, 0.5, 1]));
    expect(wav.length).toBe(44 + 12);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)]).toEqual([3, 1, 48000, 32]);
    expect(wav.readUInt32LE(40)).toBe(12);
    expect(wav.readFloatLE(48)).toBe(0.5);
  });

  it("needs no gain signal for unity gain", () => {
    expect(shapesSound([{ atUs: 0, gain: 1 }, { atUs: 2_000_000, gain: 1 }])).toBe(false);
    expect(shapesSound([{ atUs: 1_000_000, gain: 0.5 }, { atUs: 2_000_000, gain: 0.5 }])).toBe(true);
  });

  it("refuses envelopes that are empty, unordered or not finite", () => {
    expect(() => shapesSound([])).toThrow(GraphError);
    expect(() => shapesSound([{ atUs: 10, gain: 1 }, { atUs: 5, gain: 1 }])).toThrow(GraphError);
    expect(() => shapesSound([{ atUs: 0, gain: Number.POSITIVE_INFINITY }, { atUs: 5, gain: 1 }])).toThrow(GraphError);
    expect(() => envelopeSamples([{ atUs: 0.5, gain: 1 }, { atUs: 5, gain: 1 }], 10)).toThrow(GraphError);
  });
});

describe("audio mix run", () => {
  const files = new Map([
    ["m1", { path: "/media/clip.mov", channels: 2 }],
    ["m2", { path: "/media/voice.wav", channels: 1 }],
  ]);

  it("seeks each source, trims, pads and delays it exactly in samples, and mixes without normalising", () => {
    const run = mixRun(
      plan({
        durationFrames: 120,
        audio: [
          source({ mediaId: "m1", startFrame: 0, durationFrames: 60, sourceInUs: 1_500_000 }),
          source({ mediaId: "m2", startFrame: 45, durationFrames: 75, sourceInUs: 0, envelope: [{ atUs: 1_500_000, gain: 0 }, { atUs: 4_000_000, gain: 2 }] }),
        ],
      }),
      files,
      "/work/mix.wav",
      (index) => `/work/gain-${index}.wav`
    );
    expect(run.inputs).toEqual(["-ss", "1.5", "-i", "file:/media/clip.mov", "-i", "file:/media/voice.wav", "-i", "file:/work/gain-1.wav"]);
    expect(run.envelopes).toEqual([{ sourceIndex: 1, file: "/work/gain-1.wav" }]);
    const [first, second, gain, shaped, mix] = run.graph.split(";");
    expect(first).toContain("[0:a:0]aresample=48000");
    expect(first).toContain("atrim=end_sample=96000,apad=whole_len=96000");
    expect(first).not.toContain("adelay");
    expect(first).not.toContain("amultiply");
    expect(first).toMatch(/atrim=end_sample=192000,apad=whole_len=192000\[a0\]$/);
    expect(second).toContain("[1:a:0]pan=stereo|c0=c0|c1=c0,aresample=48000");
    expect(second).toContain("atrim=end_sample=120000,apad=whole_len=120000");
    expect(second).toContain("adelay=delays=72000S:all=1,asetpts=N/SR/TB");
    expect(second).toMatch(/atrim=end_sample=192000,apad=whole_len=192000\[p1\]$/);
    expect(gain).toBe("[2:a:0]aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=mono,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo[g1]");
    expect(shaped).toBe("[p1][g1]amultiply,atrim=end_sample=192000,apad=whole_len=192000[a1]");
    expect(mix).toBe("[a0][a1]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0,atrim=end_sample=192000,apad=whole_len=192000,aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo[mix]");
    expect(run.outputs).toEqual(expect.arrayContaining(["-c:a", "pcm_f32le", "-fflags", "+bitexact", "-map_metadata", "-1"]));
    expect(run.outputs.at(-1)).toBe("file:/work/mix.wav");
  });

  it("makes silence of the render's length when the plan has no sound", () => {
    const run = mixRun(plan({ durationFrames: 45 }), files, "/work/mix.wav", () => "/work/unused.wav");
    expect(run.inputs).toEqual([]);
    expect(run.graph).toBe("anullsrc=r=48000:cl=stereo,atrim=end_sample=72000,apad=whole_len=72000,aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo[mix]");
  });

  it("refuses a sound whose media is missing", () => {
    expect(() => mixRun(plan({ audio: [source({ mediaId: "nope" })] }), files, "/work/mix.wav", () => "/work/gain.wav")).toThrow(GraphError);
  });

  it("keeps the graph the same size however many points an envelope has", () => {
    const dense: GainPoint[] = Array.from({ length: 10_000 }, (_, i) => ({ atUs: i * 100, gain: (i % 7) / 7 }));
    const small = mixRun(plan({ audio: [source({ envelope: [{ atUs: 0, gain: 0 }, { atUs: 1_000_000, gain: 1 }] })] }), files, "/w/mix.wav", (i) => `/w/gain-${i}.wav`);
    const large = mixRun(plan({ audio: [source({ envelope: dense })] }), files, "/w/mix.wav", (i) => `/w/gain-${i}.wav`);
    expect(large.graph).toBe(small.graph);
  });
});

describe("loudness runs", () => {
  const stderr = `[Parsed_loudnorm_0 @ 0x1]
{
\t"input_i" : "-23.41",
\t"input_tp" : "-4.02",
\t"input_lra" : "12.30",
\t"input_thresh" : "-33.80",
\t"output_i" : "-14.05",
\t"output_tp" : "-1.50",
\t"output_lra" : "11.00",
\t"output_thresh" : "-24.40",
\t"normalization_type" : "linear",
\t"target_offset" : "0.05"
}
[out#0/null @ 0x2] video:0KiB audio:0KiB`;

  it("aims 0.5 dB under the profile's true-peak ceiling", () => {
    expect(loudnessTargets(plan(), INSTAGRAM_PROFILE)).toEqual({ integratedLufs: -14, truePeakDb: -1.5 });
    expect(() => loudnessTargets(plan({ loudness: { targetLufs: -2 } }), INSTAGRAM_PROFILE)).toThrow(GraphError);
  });

  it("parses loudnorm's report, infinities included", () => {
    expect(parseLoudnorm(stderr)).toEqual({ inputI: -23.41, inputTp: -4.02, inputLra: 12.3, inputThresh: -33.8, targetOffset: 0.05, normalizationType: "linear" });
    const silent = stderr.replace('"-23.41"', '"-inf"').replace('"-4.02"', '"-inf"');
    expect(parseLoudnorm(silent).inputI).toBe(Number.NEGATIVE_INFINITY);
    expect(() => parseLoudnorm("no report")).toThrow(GraphError);
    expect(() => parseLoudnorm(stderr.replace('"-23.41"', '"loud"'))).toThrow(GraphError);
  });

  it("sets a range target wide enough for linear normalisation", () => {
    expect(rangeTarget(0)).toBe(7);
    expect(rangeTarget(12.3)).toBe(14);
    expect(rangeTarget(80)).toBe(50);
  });

  it("measures, then normalises linearly back to 48 kHz at the exact length", () => {
    const targets = loudnessTargets(plan(), INSTAGRAM_PROFILE);
    expect(measureArgs("/w/mix.wav", targets).join(" ")).toContain("-af loudnorm=I=-14:TP=-1.5:LRA=7:print_format=json -f null -");
    const args = normaliseArgs("/w/mix.wav", parseLoudnorm(stderr), targets, 96000, "/w/audio.wav");
    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toBe(
      "loudnorm=I=-14:TP=-1.5:LRA=14:measured_I=-23.41:measured_TP=-4.02:measured_LRA=12.3:measured_thresh=-33.8:offset=0.05:linear=true:print_format=json," +
        "aresample=48000,aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo,atrim=end_sample=96000,apad=whole_len=96000"
    );
    expect(args.at(-1)).toBe("file:/w/audio.wav");
    expect(() => normaliseArgs("/w/mix.wav", parseLoudnorm(stderr.replace('"-23.41"', '"-inf"')), targets, 96000, "/w/a.wav")).toThrow(GraphError);
  });

  it("corrects with a static gain and an oversampled true-peak limiter that keeps the length and sync", () => {
    const args = trimArgs("/w/audio.wav", 0.75, -1.6, 96000, "/w/audio-conformed-1.wav");
    expect(args[args.indexOf("-i") + 1]).toBe("file:/w/audio.wav");
    expect(args[args.indexOf("-af") + 1]).toBe(
      "volume=0.75dB:precision=float,aresample=192000,alimiter=limit=0.831764:attack=5:release=50:asc=0:level=0:latency=1," +
        "aresample=48000,aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo,atrim=end_sample=96000,apad=whole_len=96000"
    );
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2)).toEqual(["-c:a", "pcm_f32le"]);
    expect(args).toEqual(expect.arrayContaining(["-fflags", "+bitexact", "-map_metadata", "-1"]));
    expect(args.at(-1)).toBe("file:/w/audio-conformed-1.wav");
    // The limit stays a usable amplitude however far the ceiling is pushed.
    const limiter = (ceilingDb: number) => {
      const trim = trimArgs("/w/a.wav", 0, ceilingDb, 96000, "/w/b.wav");
      return trim[trim.indexOf("-af") + 1];
    };
    expect(limiter(3)).toContain("alimiter=limit=1:");
    expect(limiter(-60)).toContain("alimiter=limit=0.0625:");
    expect(() => trimArgs("/w/a.wav", Number.NaN, -1.6, 96000, "/w/b.wav")).toThrow(GraphError);
  });

  it("checks loudness on the same AAC encoding the deliverable carries", () => {
    const encoder = audioEncoderArgs(INSTAGRAM_PROFILE);
    const { audio } = INSTAGRAM_PROFILE;
    expect(encoder).toEqual(["-c:a", audio.codec, "-profile:a", "aac_low", "-b:a", `${audio.bitrateKbps}k`, "-ar", String(audio.sampleRate), "-ac", String(audio.channels)]);
    const check = encodedCheckArgs("/w/audio.wav", INSTAGRAM_PROFILE, "/w/audio-check-0.m4a");
    expect(check.join(" ")).toContain(encoder.join(" "));
    expect(check.slice(-3)).toEqual(["-f", "mp4", "file:/w/audio-check-0.m4a"]);
    const video = videoRun(plan(), INSTAGRAM_PROFILE, new Map(), "/w/audio.wav", "/w/render.mp4");
    expect(video.outputs.join(" ")).toContain(encoder.join(" "));
  });
});

describe("video run", () => {
  const sdr = input({ mediaId: "m1" });
  const still = input({ mediaId: "m2", kind: "image", hasAudio: false, durationUs: undefined });

  it("reads the overlay from stdin and converts it to BT.709 explicitly before compositing", () => {
    const run = videoRun(plan({ video: [layer({})], inputs: [sdr] }), INSTAGRAM_PROFILE, videoFiles(sdr), "/w/audio.wav", "/w/render.mp4");
    expect(run.inputs.slice(0, 10)).toEqual(["-f", "image2pipe", "-framerate", "30", "-c:v", "png", "-i", "pipe:0", "-i", "file:/w/audio.wav"]);
    expect(run.graph).toContain("[0:v:0]format=rgba,scale=flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv,format=yuva444p,setsar=1[ov]");
    expect(run.graph).toMatch(/\[c0\]\[ov\]overlay=x=0:y=0:format=yuv444:eof_action=endall,scale=in_color_matrix=bt709:in_range=tv:[^,]*out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=field_mode=prog:range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709\[vout\]$/);
    // 4:2:0 happens once, at the very end.
    expect(run.graph.match(/yuv420p/g)).toHaveLength(1);
  });

  it("encodes with the profile, fixed threads and bitexact muxing", () => {
    const args = runArgs(videoRun(plan({ durationFrames: 75 }), INSTAGRAM_PROFILE, videoFiles(), "/w/a.wav", "/w/r.mp4"), ["-filter_complex", "x"]);
    const after = (flag: string) => args[args.lastIndexOf(flag) + 1];
    expect(after("-c:v")).toBe("libx264");
    expect(after("-preset")).toBe("medium");
    expect(after("-crf")).toBe("18");
    expect(after("-maxrate")).toBe("20000k");
    expect(after("-bufsize")).toBe("40000k");
    expect(after("-profile:v")).toBe("high");
    expect(after("-g")).toBe("60");
    expect(after("-threads")).toBe("4");
    expect(after("-c:a")).toBe("aac");
    expect(after("-profile:a")).toBe("aac_low");
    expect(after("-b:a")).toBe("192k");
    expect(after("-ar")).toBe("48000");
    expect(after("-ac")).toBe("2");
    expect(after("-fps_mode")).toBe("cfr");
    expect(after("-frames:v")).toBe("75");
    expect(after("-movflags")).toBe("+faststart");
    expect(after("-fflags")).toBe("+bitexact");
    expect(after("-flags:v")).toBe("+bitexact");
    expect(after("-flags:a")).toBe("+bitexact");
    expect(after("-map_metadata")).toBe("-1");
    expect(after("-colorspace")).toBe("bt709");
    expect(after("-color_range")).toBe("tv");
    expect(after("-progress")).toBe("pipe:1");
    expect(args.at(-1)).toBe("file:/w/r.mp4");
  });

  it("seeks a preroll before the clip's source time and selects frames from there", () => {
    const run = videoRun(
      plan({ video: [layer({ sourceInUs: 2_500_000 }), layer({ mediaId: "m1", startFrame: 30, durationFrames: 60, sourceInUs: 400_000 })], inputs: [sdr] }),
      INSTAGRAM_PROFILE,
      videoFiles(sdr),
      "/w/a.wav",
      "/w/r.mp4"
    );
    expect(run.inputs.slice(10)).toEqual(["-ss", "1.5", "-i", "file:/media/m1.mov", "-i", "file:/media/m1.mov"]);
    const shift = (us: number) => num(us / 1e6, 6);
    expect(run.graph).toContain(`[2:v:0]setpts=PTS-${shift(PREROLL_US + SELECT_TOLERANCE_US)}/TB,fps=fps=30:start_time=0:round=up,tpad=stop_mode=clone:stop=30,trim=end_frame=30,`);
    expect(run.graph).toContain(`[3:v:0]setpts=PTS-${shift(400_000 + SELECT_TOLERANCE_US)}/TB,fps=fps=30:start_time=0:round=up,tpad=stop_mode=clone:stop=60,trim=end_frame=60,`);
    expect(run.graph).toContain("[l0][l1]concat=n=2:v=1:a=0[t0]");
  });

  it("scales to the cover size and crops at the placement offsets", () => {
    const placement = { scaledWidth: 1138, scaledHeight: 640, offsetX: 389, offsetY: 0 };
    const run = videoRun(plan({ video: [layer({ placement })], inputs: [sdr] }), INSTAGRAM_PROFILE, videoFiles(sdr), "/w/a.wav", "/w/r.mp4");
    expect(run.graph).toContain("scale=w=1138:h=640:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv,format=yuva444p,crop=w=360:h=640:x=389:y=0:exact=1");
    const bad = { scaledWidth: 300, scaledHeight: 640, offsetX: 0, offsetY: 0 };
    expect(() => videoRun(plan({ video: [layer({ placement: bad })], inputs: [sdr] }), INSTAGRAM_PROFILE, videoFiles(sdr), "/w/a.wav", "/w/r.mp4")).toThrow(GraphError);
  });

  it("fills a track's gaps with transparent frames so every track lasts the whole render", () => {
    const run = videoRun(
      plan({ durationFrames: 100, video: [layer({ startFrame: 10, durationFrames: 20 }), layer({ startFrame: 50, durationFrames: 30 })], inputs: [sdr] }),
      INSTAGRAM_PROFILE,
      videoFiles(sdr),
      "/w/a.wav",
      "/w/r.mp4"
    );
    expect(run.graph).toContain("color=c=black@0:s=360x640:r=30,format=yuva444p,trim=end_frame=10,setsar=1[g0_0]");
    expect(run.graph).toContain("trim=end_frame=20,setsar=1[g0_1]");
    expect(run.graph).toContain("trim=end_frame=20,setsar=1[g0_end]");
    expect(run.graph).toContain("[g0_0][l0][g0_1][l1][g0_end]concat=n=5:v=1:a=0[t0]");
    expect(run.graph).toContain("color=c=black:s=360x640:r=30,format=yuv444p,trim=end_frame=100,setsar=1[base]");
  });

  it("composites tracks bottom to top whatever the layer order", () => {
    const run = videoRun(
      plan({ video: [layer({ trackIndex: 3, durationFrames: 90 }), layer({ trackIndex: 1, durationFrames: 90 })], inputs: [sdr] }),
      INSTAGRAM_PROFILE,
      videoFiles(sdr),
      "/w/a.wav",
      "/w/r.mp4"
    );
    expect(run.graph).toContain("[l1]null[t0]");
    expect(run.graph).toContain("[l0]null[t1]");
    expect(run.graph).toContain("[base][t0]overlay=x=0:y=0:format=yuv444:eof_action=endall[c0]");
    expect(run.graph).toContain("[c0][t1]overlay=x=0:y=0:format=yuv444:eof_action=endall[c1]");
  });

  it("refuses overlapping layers on one track", () => {
    const overlapping = plan({ video: [layer({ startFrame: 0, durationFrames: 40 }), layer({ startFrame: 30, durationFrames: 30 })], inputs: [sdr] });
    expect(() => videoRun(overlapping, INSTAGRAM_PROFILE, videoFiles(sdr), "/w/a.wav", "/w/r.mp4")).toThrow(GraphError);
  });

  it("loops stills for exactly their clip", () => {
    const run = videoRun(plan({ video: [layer({ kind: "still", mediaId: "m2", sourceInUs: undefined, durationFrames: 45 })], inputs: [still] }), INSTAGRAM_PROFILE, videoFiles(still), "/w/a.wav", "/w/r.mp4");
    expect(run.inputs.slice(10)).toEqual(["-loop", "1", "-framerate", "30", "-t", "1.533333", "-i", "file:/media/m2.mov"]);
    expect(run.graph).toContain("[2:v:0]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=45,trim=end_frame=45,");
  });

  it("converts HLG and PQ sources on VideoToolbox, turning them upright", () => {
    const hdr = input({ mediaId: "m3", dynamicRange: "hlg", rotation: 90, display: { width: 720, height: 1280 } });
    const run = videoRun(plan({ video: [layer({ mediaId: "m3", sourceInUs: 0 })], inputs: [hdr] }), INSTAGRAM_PROFILE, videoFiles(hdr), "/w/a.wav", "/w/r.mp4");
    expect(run.inputs.slice(10)).toEqual(["-display_rotation", "0", "-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld", "-i", "file:/media/m3.mov"]);
    expect(run.graph).toContain("[2:v:0]scale_vt=w=1280:h=720:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le,transpose=clock,format=yuv420p,setparams=");
  });
});

describe("filter graph delivery", () => {
  it("passes small graphs inline and large ones from a file, by FFmpeg release", () => {
    expect(graphOptions("[a]null[b]", "/w/g.graph", { major: 9 })).toEqual({ options: ["-filter_complex", "[a]null[b]"], script: null });
    const big = "x".repeat(MAX_INLINE_GRAPH_BYTES + 1);
    expect(graphOptions(big, "/w/g.graph", { major: 9 })).toEqual({ options: ["-/filter_complex", "file:/w/g.graph"], script: big });
    expect(graphOptions(big, "/w/g.graph", null).options[0]).toBe("-/filter_complex");
    expect(graphOptions(big, "/w/g.graph", { major: 6 }).options[0]).toBe("-filter_complex_script");
    expect(graphOptions("", "/w/g.graph", { major: 9 })).toEqual({ options: [], script: null });
  });
});

describe("overlay Chromium", () => {
  const saved = process.env.PUPPETEER_EXECUTABLE_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = saved;
  });

  it("uses exactly the G1 gate's pinned raster flags, and never disables the sandbox", () => {
    expect(OVERLAY_CHROME_ARGS.slice(0, CHROME_ARGS.length)).toEqual(CHROME_ARGS);
    expect(sandboxDisablingFlags(OVERLAY_CHROME_ARGS)).toEqual([]);
    expect(Object.isFrozen(OVERLAY_CHROME_ARGS)).toBe(true);
  });

  it("recognises sandbox-disabling flags in a command line", () => {
    expect(sandboxDisablingFlags(["/chrome", "--headless=new", "--no-sandbox", "--disable-setuid-sandbox", "--no-zygote", "--sandbox-ok"])).toEqual([
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--no-zygote",
    ]);
  });

  it("honours an explicit executable only when it is an absolute path to a file", () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = "/nonexistent/chrome";
    expect(chromeExecutable()).toBeNull();
    process.env.PUPPETEER_EXECUTABLE_PATH = "relative/chrome";
    expect(chromeExecutable()).toBeNull();
    process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath;
    expect(chromeExecutable()).toBe(process.execPath);
  });
});

/** An RGB PNG whose rows use every filter type, written independently of the code under test. */
function rgbPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): { png: Buffer; rgb: Buffer } {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(pixel(x, y), (y * width + x) * 3);
  const stride = width * 3;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const type = y % 5;
    const row = Buffer.alloc(stride + 1);
    row[0] = type;
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x];
      const a = x >= 3 ? rgb[y * stride + x - 3] : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + x] : 0;
      const c = x >= 3 && y > 0 ? rgb[(y - 1) * stride + x - 3] : 0;
      const p = a + b - c;
      const predictor = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][type];
      row[x + 1] = (v - predictor) & 0xff;
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
  return { png, rgb };
}

/** Reads an RGBA PNG written with filter type 0 (as the normaliser writes it). */
function readRgba(png: Buffer): { width: number; height: number; colourType: number; pixels: Buffer; chunks: string[] } {
  const chunks: string[] = [];
  const idat: Buffer[] = [];
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    chunks.push(type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colourType = data[9];
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    raw.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, colourType, pixels, chunks };
}

describe("overlay PNG normalisation", () => {
  it("makes a transparent RGBA frame with only the chunks Chromium writes", () => {
    const png = readRgba(transparentPng(36, 64));
    expect(png).toMatchObject({ width: 36, height: 64, colourType: 6, chunks: ["IHDR", "IDAT", "IEND"] });
    expect(png.pixels.every((byte) => byte === 0)).toBe(true);
  });

  it("turns an opaque RGB screenshot into RGBA with the same pixels, through every row filter", () => {
    const { png, rgb } = rgbPng(23, 17, (x, y) => [(x * 37 + y * 11) & 0xff, (x * y * 3) & 0xff, (255 - x * 5 - y) & 0xff]);
    const out = readRgba(toRgbaPng(png, 23, 17));
    expect(out.colourType).toBe(6);
    for (let i = 0; i < 23 * 17; i++) {
      expect([...out.pixels.subarray(i * 4, i * 4 + 4)]).toEqual([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255]);
    }
  });

  it("passes an RGBA frame through unchanged and refuses anything else", () => {
    const rgba = transparentPng(10, 10);
    expect(toRgbaPng(rgba, 10, 10)).toBe(rgba);
    expect(() => toRgbaPng(rgba, 11, 10)).toThrow(PngShapeError);
    expect(() => toRgbaPng(Buffer.from("not a png at all, really not one"), 10, 10)).toThrow(PngShapeError);
    const grey = Buffer.from(rgba);
    grey[8 + 8 + 9] = 0;
    expect(() => toRgbaPng(grey, 10, 10)).toThrow(PngShapeError);
  });
});

describe("overlay renderer input checks", () => {
  const html = "<!doctype html><html><body></body></html>";
  const doc = (over: Partial<OverlayDocument> = {}): OverlayDocument => ({ html, activeRanges: [], sha256: createHash("sha256").update(html).digest("hex"), ...over });
  const open = (overlay: OverlayDocument, fonts: { urlPath: string }[] = []) =>
    OverlayRenderer.open({
      executablePath: "/nonexistent/chrome",
      overlay,
      fonts: fonts.map((f) => ({ ...f, family: "F", weight: 400, bytes: Buffer.alloc(1), sha256: "", source: "test" })),
      canvas: { width: 36, height: 64 },
      fps: 30,
      durationFrames: 30,
      workers: 2,
      profileDir: "/nonexistent/profiles",
      signal: new AbortController().signal,
    });
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(RenderFailure);
    return error as RenderFailure;
  };

  it("refuses active ranges that are unsorted, overlapping, empty or outside the render, before starting a browser", async () => {
    for (const activeRanges of [
      [{ startFrame: 10, endFrame: 20 }, { startFrame: 5, endFrame: 8 }],
      [{ startFrame: 0, endFrame: 10 }, { startFrame: 9, endFrame: 12 }],
      [{ startFrame: 4, endFrame: 4 }],
      [{ startFrame: 20, endFrame: 31 }],
    ]) {
      expect((await refusal(open(doc({ activeRanges })))).code).toBe("internal_error");
    }
  });

  it("refuses a document that does not match its hash, and invalid font paths", async () => {
    expect((await refusal(open(doc({ sha256: "0".repeat(64) })))).code).toBe("internal_error");
    expect((await refusal(open(doc(), [{ urlPath: "/fonts/../x.woff2" }]))).code).toBe("internal_error");
    expect((await refusal(open(doc(), [{ urlPath: "/fonts/a.ttf" }]))).code).toBe("internal_error");
    expect((await refusal(open(doc(), [{ urlPath: "/fonts/a.woff2" }, { urlPath: "/fonts/a.woff2" }]))).code).toBe("internal_error");
  });

  it("reports a browser that cannot start as a permanent tool failure", async () => {
    const failure = await refusal(open(doc()));
    expect(failure).toMatchObject({ failureClass: "permanent", code: "tool_failed" });
    expect(failure.message).not.toContain("/nonexistent");
  });
});

describe("failure classification", () => {
  it("maps tool, graph and disk errors to typed render failures", () => {
    expect(toRenderFailure(new ToolError("missing", "ffmpeg is not installed"))).toMatchObject({ failureClass: "configuration", code: "tool_missing" });
    expect(toRenderFailure(new ToolError("timeout", "slow"))).toMatchObject({ failureClass: "transient", code: "timeout" });
    expect(toRenderFailure(new ToolError("aborted", "stop"))).toMatchObject({ failureClass: "transient", code: "interrupted" });
    expect(toRenderFailure(new ToolError("failed", "ffmpeg exited with code 1", 1))).toMatchObject({ failureClass: "permanent", code: "tool_failed" });
    expect(toRenderFailure(new GraphError("bad plan"))).toMatchObject({ failureClass: "permanent", code: "internal_error" });
    expect(toRenderFailure(Object.assign(new Error("full"), { code: "ENOSPC" }))).toMatchObject({ failureClass: "transient", code: "io_error" });
    expect(toRenderFailure(new Error("/secret/path broke"))).toMatchObject({ code: "internal_error", message: "the render failed unexpectedly" });
  });
});
