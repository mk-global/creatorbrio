/**
 * The export's sound (#144): the mix of every source in the plan, normalised
 * to the plan's loudness under the profile's true-peak ceiling, as one 48 kHz
 * stereo float WAV of exactly the render's length.
 *
 *   1. Mix (`mixRun`). A plan without sound gets silence: `no-audio`.
 *   2. Measure the mix with loudnorm. Below the profile's silence floor it is
 *      left as it is: `skipped-silence`.
 *   3. loudnorm's second pass with the measurements, aiming at the target and
 *      a true peak 0.5 dB under the ceiling, in linear mode whenever the peak
 *      allows; `linear` or `dynamic` is loudnorm's own report.
 *   4. Conformance check on what the deliverable will actually carry: the WAV
 *      is encoded with the profile's AAC settings and measured. If the
 *      integrated loudness is more than `CONFORM_TOLERANCE_LU` from the target
 *      or the true peak above the ceiling less `PEAK_MARGIN_DB`, a static gain
 *      and a true-peak limiter (`trimArgs`) are applied to loudnorm's output
 *      and the check repeats, at most `MAX_CONFORM_PASSES` times. Measured
 *      reasons it is needed: loudnorm's dynamic mode landed at -15.0 LUFS for
 *      a -14 target on peaky material, and AAC encoding added 0.6 dB of true
 *      peak to a mix limited at -1.5 dBTP. A result still outside after the
 *      last pass is returned as it is; the verifier then fails the render.
 */
import type { LoudnessResult } from "./execute-types";
import { encodedCheckArgs, loudnessTargets, measureArgs, mixRun, normaliseArgs, parseLoudnorm, trimArgs, type AudioSourceFile } from "./ffmpeg-audio";
import { GraphError, runArgs, totalSamples, type FfmpegRun } from "./ffmpeg-graph";
import type { RenderPlan } from "./plan";
import type { ExportProfile } from "./profile";
import { runTool } from "@/lib/video/media/tools";

/** How far from the target the encoded loudness may be before it is corrected. */
export const CONFORM_TOLERANCE_LU = 0.2;
/** How far under the profile's ceiling the encoded true peak must stay. */
export const PEAK_MARGIN_DB = 0.1;
export const MAX_CONFORM_PASSES = 4;

export interface MasterOptions {
  plan: RenderPlan;
  profile: ExportProfile;
  files: ReadonlyMap<string, AudioSourceFile>;
  /** A path in the render's scratch folder. */
  at: (name: string) => string;
  /** The options that pass a run's filter graph (inline or from a file). */
  graphFor: (name: string, run: FfmpegRun) => Promise<string[]>;
  signal: AbortSignal;
  onPass?: (done: number, total: number) => void;
}

/** Mixes and normalises the plan's sound. Throws ToolError or GraphError. */
export async function masterAudio(options: MasterOptions): Promise<{ file: string; loudness: LoudnessResult }> {
  const { plan, profile, at, signal } = options;
  const seconds = plan.durationFrames / plan.canvas.fps;
  const total = totalSamples(plan);
  const passes = plan.audio.length === 0 ? 1 : 3;
  const mix = at("mix.wav");
  const mixing = mixRun(plan, options.files, mix);
  await runTool("ffmpeg", runArgs(mixing, await options.graphFor("mix", mixing)), { timeoutMs: Math.max(120_000, seconds * 10_000), signal });
  options.onPass?.(1, passes);
  if (plan.audio.length === 0) return { file: mix, loudness: { measured: null, normalisation: "no-audio" } };

  const targets = loudnessTargets(plan, profile);
  const timeoutMs = Math.max(60_000, seconds * 5_000);
  const measure = async (file: string) => parseLoudnorm((await runTool("ffmpeg", measureArgs(file, targets), { timeoutMs, signal, stderrTailBytes: 32_768 })).stderrTail);

  const first = await measure(mix);
  options.onPass?.(2, passes);
  const values = [first.inputI, first.inputTp, first.inputLra, first.inputThresh];
  const measured = values.every(Number.isFinite) ? { integratedLufs: first.inputI, truePeakDb: first.inputTp, lra: first.inputLra, thresholdLufs: first.inputThresh } : null;
  if (!(first.inputI >= profile.loudness.silenceLufs)) return { file: mix, loudness: { measured, normalisation: "skipped-silence" } };

  const normalised = at("audio.wav");
  const second = await runTool("ffmpeg", normaliseArgs(mix, first, targets, total, normalised), { timeoutMs, signal, stderrTailBytes: 32_768 });
  const type = parseLoudnorm(second.stderrTail).normalizationType;
  if (type === null) throw new GraphError("loudnorm did not say how it normalised the mix");

  const goalPeak = profile.loudness.truePeakDb - PEAK_MARGIN_DB;
  let file = normalised;
  let gain = 0;
  let ceiling = targets.truePeakDb;
  let previous: { gain: number; integrated: number } | null = null;
  for (let pass = 0; ; pass++) {
    const encoded = at(`audio-check-${pass}.m4a`);
    await runTool("ffmpeg", encodedCheckArgs(file, profile, encoded), { timeoutMs, signal });
    const check = await measure(encoded);
    if (!Number.isFinite(check.inputI) || !Number.isFinite(check.inputTp)) throw new GraphError("the normalised mix has no measurable loudness");
    const loudOk = Math.abs(targets.integratedLufs - check.inputI) <= CONFORM_TOLERANCE_LU;
    const peakOk = check.inputTp <= goalPeak;
    if ((loudOk && peakOk) || pass === MAX_CONFORM_PASSES) break;
    // The limiter takes back part of any gain, so the step uses the response seen since the
    // ceiling last moved (secant), and a plain step when there is none.
    const slope = previous && gain !== previous.gain ? Math.min(1, Math.max(0.25, (check.inputI - previous.integrated) / (gain - previous.gain))) : 1;
    previous = { gain, integrated: check.inputI };
    if (!loudOk) gain += (targets.integratedLufs - check.inputI) / slope;
    if (!peakOk) {
      ceiling -= check.inputTp - goalPeak + 0.1;
      previous = null;
    }
    file = at(`audio-conformed-${pass + 1}.wav`);
    await runTool("ffmpeg", trimArgs(normalised, gain, ceiling, total, file), { timeoutMs, signal });
  }
  options.onPass?.(3, passes);
  return { file, loudness: { measured, normalisation: type } };
}
