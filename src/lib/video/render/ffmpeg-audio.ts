/**
 * Pure builders for the export's sound runs (#144, ADR decision 3): the mix
 * of every source, loudnorm's measurement and normalisation, the corrective
 * gain and true-peak limiter, and the AAC check encode. `audio-master.ts`
 * runs them.
 *
 * Audio, in timeline time (48 kHz stereo 32-bit float WAV throughout):
 * each `AudioSource` is its own input, seeked accurately to `sourceInUs`,
 * resampled to 48 kHz stereo (a mono source is copied to both channels),
 * trimmed to its clip and padded with silence when the source is shorter,
 * delayed by exactly `startFrame * 48000 / fps` samples, then shaped by its
 * envelope and padded to the render's length. The envelope becomes a
 * `volume` expression evaluated every 16 samples (`GAIN_STEP_SAMPLES`, a
 * third of a millisecond, at the centre of each step), written as a flat sum
 * of one linear term per envelope segment. The sources are summed with
 * `amix` without normalisation. The mix always has exactly
 * `round(durationFrames * 48000 / fps)` samples; no sound gives silence.
 *
 */
import type { AudioSource, GainPoint, RenderPlan } from "./plan";
import type { ExportProfile } from "./profile";
import { AUDIO_SAMPLE_RATE, audioEncoderArgs, BITEXACT, COMMON, GraphError, num, samplesFor, seconds, totalSamples, type FfmpegRun } from "./ffmpeg-graph";
import { fileUrl } from "@/lib/video/media/tools";

/** Samples per gain step: a whole number of these fits every supported frame rate's frame, so steps never straddle a clip edge. */
export const GAIN_STEP_SAMPLES = 16;
/** loudnorm's accepted integrated-loudness targets. */
const LOUDNORM_TARGET = { min: -70, max: -5 };

/**
 * The `volume` expression for an envelope, in timeline seconds `t` at the
 * start of each `GAIN_STEP_SAMPLES` step, evaluated at the step's centre:
 * `gte(t,a)*lt(t,b)*(g+k*(t-a))` per segment, summed. Outside the envelope
 * the gain is 0, as `gainAt` defines it. Returns null when the gain is 1
 * throughout, so no filter is needed.
 */
export function envelopeExpression(envelope: readonly GainPoint[]): string | null {
  if (envelope.length === 0) throw new GraphError("a sound has an empty gain envelope");
  for (let i = 0; i < envelope.length; i++) {
    const point = envelope[i];
    if (!Number.isSafeInteger(point.atUs) || !Number.isFinite(point.gain) || point.gain < 0) throw new GraphError("a gain envelope point is invalid");
    if (i > 0 && point.atUs < envelope[i - 1].atUs) throw new GraphError("a gain envelope is not in time order");
  }
  if (envelope.length > 1 && envelope.every((point) => point.gain === 1)) return null;
  const centre = GAIN_STEP_SAMPLES / 2 / AUDIO_SAMPLE_RATE;
  const terms: string[] = [];
  for (let i = 0; i + 1 < envelope.length; i++) {
    const from = envelope[i];
    const to = envelope[i + 1];
    if (to.atUs === from.atUs) continue;
    const start = from.atUs / 1_000_000 - centre;
    const end = to.atUs / 1_000_000 - centre;
    const slope = ((to.gain - from.gain) * 1_000_000) / (to.atUs - from.atUs);
    const window = `gte(t,${num(start)})*lt(t,${num(end)})`;
    if (slope === 0) {
      if (from.gain !== 0) terms.push(`${window}*${num(from.gain)}`);
      continue;
    }
    const offset = start < 0 ? `t+${num(-start)}` : `t-${num(start)}`;
    terms.push(`${window}*(${num(from.gain)}${slope < 0 ? "-" : "+"}${num(Math.abs(slope))}*(${offset}))`);
  }
  return terms.length === 0 ? "0" : terms.join("+");
}

export interface AudioSourceFile {
  /** Absolute path of the original. */
  path: string;
  /** Channels of its first audio stream. */
  channels: number;
}

/** Pass 1: the mix of every sound in the plan, as 48 kHz stereo float WAV. */
export function mixRun(plan: RenderPlan, files: ReadonlyMap<string, AudioSourceFile>, output: string): FfmpegRun {
  const fps = plan.canvas.fps;
  const total = totalSamples(plan);
  const inputs: string[] = [];
  const chains: string[] = [];
  plan.audio.forEach((source: AudioSource, index) => {
    const file = files.get(source.mediaId);
    if (!file) throw new GraphError("a sound's media is not available");
    if (!Number.isSafeInteger(source.sourceInUs) || source.sourceInUs < 0) throw new GraphError("a sound's source time is invalid");
    if (source.sourceInUs > 0) inputs.push("-ss", seconds(source.sourceInUs));
    inputs.push("-i", fileUrl(file.path));
    const length = samplesFor(source.durationFrames, fps);
    const delay = samplesFor(source.startFrame, fps);
    const gain = envelopeExpression(source.envelope);
    chains.push(
      [
        `[${index}:a:0]${file.channels === 1 ? "pan=stereo|c0=c0|c1=c0," : ""}aresample=${AUDIO_SAMPLE_RATE}`,
        `aformat=sample_fmts=flt:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo`,
        "asetpts=N/SR/TB",
        `atrim=end_sample=${length}`,
        `apad=whole_len=${length}`,
        ...(delay > 0 ? [`adelay=delays=${delay}S:all=1`] : []),
        "asetpts=N/SR/TB",
        ...(gain === null ? [] : [`asetnsamples=n=${GAIN_STEP_SAMPLES}:p=0`, `volume=volume='${gain}':eval=frame:precision=float`]),
        `atrim=end_sample=${total}`,
        `apad=whole_len=${total}[a${index}]`,
      ].join(",")
    );
  });
  const n = plan.audio.length;
  const finish = `atrim=end_sample=${total},apad=whole_len=${total},aformat=sample_fmts=flt:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo[mix]`;
  if (n === 0) chains.push(`anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo,${finish}`);
  else if (n === 1) chains.push(`[a0]${finish}`);
  else chains.push(`${plan.audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${n}:normalize=0:duration=longest:dropout_transition=0,${finish}`);
  return {
    inputs,
    graph: chains.join(";"),
    outputs: ["-map", "[mix]", "-c:a", "pcm_f32le", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "2", ...BITEXACT, "-f", "wav", fileUrl(output)],
  };
}

export interface LoudnessTargets {
  integratedLufs: number;
  truePeakDb: number;
}

/**
 * The targets the normalisation aims at: the plan's integrated loudness, and
 * a true peak 0.5 dB under the profile's ceiling, headroom for the overshoot
 * AAC encoding adds.
 */
export function loudnessTargets(plan: RenderPlan, profile: ExportProfile): LoudnessTargets {
  const integratedLufs = plan.loudness.targetLufs;
  if (!Number.isFinite(integratedLufs) || integratedLufs < LOUDNORM_TARGET.min || integratedLufs > LOUDNORM_TARGET.max) {
    throw new GraphError(`the loudness target must be between ${LOUDNORM_TARGET.min} and ${LOUDNORM_TARGET.max} LUFS`);
  }
  return { integratedLufs, truePeakDb: profile.loudness.truePeakDb - 0.5 };
}

/** loudnorm's first-pass report, with "-inf" and "inf" as infinities. */
export interface LoudnormReport {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
  normalizationType: "linear" | "dynamic" | null;
}

/** Pass 2a: measures the mix. loudnorm reports at `info` level on stderr. */
export function measureArgs(mix: string, targets: LoudnessTargets): string[] {
  return [
    ...COMMON, "-v", "info", "-i", fileUrl(mix), "-map", "0:a:0",
    "-af", `loudnorm=I=${num(targets.integratedLufs, 2)}:TP=${num(targets.truePeakDb, 2)}:LRA=7:print_format=json`,
    "-f", "null", "-",
  ];
}

const LOUDNORM_NUMBER = /^-?(?:\d{1,6}(?:\.\d{1,6})?|inf)$/;

/** Reads the last loudnorm JSON report from FFmpeg's stderr. Throws GraphError when there is none or it is malformed. */
export function parseLoudnorm(stderr: string): LoudnormReport {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!blocks) throw new GraphError("loudnorm printed no measurement");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(blocks[blocks.length - 1]) as Record<string, unknown>;
  } catch {
    throw new GraphError("loudnorm's measurement is not valid JSON");
  }
  const read = (key: string): number => {
    const value = json[key];
    if (typeof value !== "string" || !LOUDNORM_NUMBER.test(value.trim())) throw new GraphError(`loudnorm's ${key} is not a number`);
    const text = value.trim();
    return text === "inf" ? Infinity : text === "-inf" ? -Infinity : Number(text);
  };
  const type = json.normalization_type;
  return {
    inputI: read("input_i"),
    inputTp: read("input_tp"),
    inputLra: read("input_lra"),
    inputThresh: read("input_thresh"),
    targetOffset: read("target_offset"),
    normalizationType: type === "linear" || type === "dynamic" ? type : null,
  };
}

/**
 * The loudness range target for pass 2: wide enough that linear (gain-only)
 * normalisation is possible whenever the true peak allows it, since loudnorm
 * falls back to its dynamic mode when the measured range exceeds the target.
 */
export function rangeTarget(measuredLra: number): number {
  return Math.min(50, Math.max(7, Math.ceil(measuredLra) + 1));
}

/** Pass 2b: normalises the mix with the first pass's measurements, back at 48 kHz and exactly the render's length. */
export function normaliseArgs(mix: string, measured: LoudnormReport, targets: LoudnessTargets, total: number, output: string): string[] {
  const values = [measured.inputI, measured.inputTp, measured.inputLra, measured.inputThresh, measured.targetOffset];
  if (!values.every(Number.isFinite)) throw new GraphError("a silent mix cannot be normalised");
  const clamp = (value: number, min: number, max: number) => num(Math.min(max, Math.max(min, value)), 2);
  const loudnorm = [
    `loudnorm=I=${num(targets.integratedLufs, 2)}`,
    `TP=${num(targets.truePeakDb, 2)}`,
    `LRA=${rangeTarget(measured.inputLra)}`,
    `measured_I=${clamp(measured.inputI, -99, 0)}`,
    `measured_TP=${clamp(measured.inputTp, -99, 99)}`,
    `measured_LRA=${clamp(measured.inputLra, 0, 99)}`,
    `measured_thresh=${clamp(measured.inputThresh, -99, 0)}`,
    `offset=${clamp(measured.targetOffset, -99, 99)}`,
    "linear=true",
    "print_format=json",
  ].join(":");
  return [
    ...COMMON, "-v", "info", "-i", fileUrl(mix), "-map", "0:a:0",
    // loudnorm works at 192 kHz internally; bring it back to 48 kHz and the exact length.
    "-af", `${loudnorm},aresample=${AUDIO_SAMPLE_RATE},aformat=sample_fmts=flt:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,atrim=end_sample=${total},apad=whole_len=${total}`,
    "-c:a", "pcm_f32le", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "2", ...BITEXACT, "-f", "wav", fileUrl(output),
  ];
}

/**
 * A conformance correction applied to loudnorm's output when its encoded
 * result misses the target or the ceiling (`audio-master.ts`): a static gain,
 * which moves the integrated loudness by that many dB, then a true-peak
 * limiter at `ceilingDb`. The limiter works at 4x oversampling (192 kHz, as
 * true peak is measured), looks 5 ms ahead with its delay compensated so the
 * sound stays in sync, and adds no make-up gain.
 */
export function trimArgs(input: string, gainDb: number, ceilingDb: number, total: number, output: string): string[] {
  const limit = Math.min(1, Math.max(0.0625, 10 ** (ceilingDb / 20)));
  return [
    ...COMMON, "-v", "error", "-i", fileUrl(input), "-map", "0:a:0",
    "-af",
    `volume=${num(gainDb, 3)}dB:precision=float,aresample=${4 * AUDIO_SAMPLE_RATE},alimiter=limit=${num(limit, 6)}:attack=5:release=50:asc=0:level=0:latency=1,` +
      `aresample=${AUDIO_SAMPLE_RATE},aformat=sample_fmts=flt:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,atrim=end_sample=${total},apad=whole_len=${total}`,
    "-c:a", "pcm_f32le", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "2", ...BITEXACT, "-f", "wav", fileUrl(output),
  ];
}

/** Encodes a WAV with the profile's AAC settings alone, to measure the loudness and true peak the deliverable will have. */
export function encodedCheckArgs(input: string, profile: ExportProfile, output: string): string[] {
  return [...COMMON, "-v", "error", "-i", fileUrl(input), "-map", "0:a:0", ...audioEncoderArgs(profile), ...BITEXACT, "-f", "mp4", fileUrl(output)];
}
