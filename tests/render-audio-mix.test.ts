/**
 * The export's sound mix with real FFmpeg (#144): a dense gain envelope, of
 * the size a fade over a ducked bed produces, is applied sample-accurately.
 * The mix used to carry the envelope as one `volume` expression, which FFmpeg
 * could not parse at a few hundred points, so such productions failed to
 * render (`tool_failed`). Skipped where FFmpeg is missing (CI, #142).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fileUrl, toolPath } from "@/lib/video/media/tools";
import { masterAudio } from "@/lib/video/render/audio-master";
import { gainAt } from "@/lib/video/render/audio-envelope";
import type { GainPoint, RenderPlan } from "@/lib/video/render/plan";
import { INSTAGRAM_PROFILE } from "@/lib/video/render/profile";
import { FFMPEG_MISSING } from "./helpers/media-fixtures";

const run = promisify(execFile);
const RATE = 48_000;

/** The interleaved float samples of a 32-bit float WAV, found by its data chunk. */
function floatSamples(wav: Buffer): Float32Array {
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "data") {
      const bytes = wav.subarray(at + 8, at + 8 + size);
      return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

/** 4,001 points: a fade-in from silence over 0.4 s in 0.2 ms pieces, unity to 1 s, then a step down to a quarter. */
function denseEnvelope(): GainPoint[] {
  const points: GainPoint[] = [];
  for (let i = 0; i <= 2000; i++) points.push({ atUs: i * 200, gain: i / 2000 });
  for (let i = 1; i <= 1998; i++) points.push({ atUs: 400_000 + i * 300, gain: 1 });
  points.push({ atUs: 1_000_000, gain: 1 }, { atUs: 1_000_001, gain: 0.25 }, { atUs: 2_000_000, gain: 0.25 });
  return points;
}

describe.skipIf(FFMPEG_MISSING)(`the sound mix with real FFmpeg${FFMPEG_MISSING ? ` (skipped: ${FFMPEG_MISSING})` : ""}`, () => {
  let dir: string;
  let tone: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "cb-mix-")));
    tone = path.join(dir, "tone.wav");
    await run(toolPath("ffmpeg")!, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=1000:sample_rate=${RATE}:duration=2`, "-ac", "1", "-c:a", "pcm_f32le", fileUrl(tone)]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("applies a 4,001-point envelope sample-accurately on both channels", { timeout: 60_000 }, async () => {
    const envelope = denseEnvelope();
    const plan: RenderPlan = {
      version: 1,
      productionId: "prod-mix",
      revision: 1,
      profile: "instagram",
      canvas: { width: 1080, height: 1920, fps: 30 },
      durationFrames: 60,
      video: [],
      audio: [{ clipId: "m", trackId: "t", role: "music", mediaId: "tone", startFrame: 0, durationFrames: 60, sourceInUs: 0, envelope }],
      graphics: [],
      captions: [],
      inputs: [{ mediaId: "tone", kind: "audio", rotation: 0, dynamicRange: "sdr", hasAudio: true, durationUs: 2_000_000 }],
      loudness: { targetLufs: -14 },
    };
    const work = await mkdtemp(path.join(dir, "work-"));
    const at = (name: string) => path.join(work, name);
    await masterAudio({
      plan,
      profile: INSTAGRAM_PROFILE,
      files: new Map([["tone", { path: tone, channels: 1 }]]),
      at,
      graphFor: async (_name, mixRun) => ["-filter_complex", mixRun.graph],
      signal: new AbortController().signal,
    });

    // The mix stage's output, before loudness normalisation changes its level.
    const mix = floatSamples(await readFile(at("mix.wav")));
    expect(mix.length).toBe(2 * 2 * RATE);
    const source = floatSamples(await readFile(tone));

    let worst = 0;
    for (let s = 0; s < 2 * RATE; s++) {
      const expected = source[s] * Math.fround(gainAt(envelope, (s * 1e6) / RATE));
      worst = Math.max(worst, Math.abs(mix[2 * s] - expected), Math.abs(mix[2 * s + 1] - expected));
    }
    // Float rounding of one multiply and of the resampler's pass-through only.
    expect(worst).toBeLessThan(1e-6);

    // The level in 10 ms windows follows the envelope: deep in the fade, half way up it, at unity and a quarter (-12 dB) down.
    const window = RATE / 100;
    const level = (samples: Float32Array, from: number, stride: number) => {
      let sum = 0;
      for (let s = from; s < from + window; s++) sum += samples[stride * s] ** 2;
      return Math.sqrt(sum / window);
    };
    const expectedDb = (from: number) => {
      let sum = 0;
      for (let s = from; s < from + window; s++) sum += gainAt(envelope, (s * 1e6) / RATE) ** 2;
      return 10 * Math.log10(sum / window);
    };
    for (const seconds of [0, 0.2, 0.7, 1.5]) {
      const from = seconds * RATE;
      expect(20 * Math.log10(level(mix, from, 2) / level(source, from, 1))).toBeCloseTo(expectedDb(from), 1);
    }
    expect(expectedDb(1.5 * RATE)).toBeCloseTo(-12.04, 1);
  });
});
