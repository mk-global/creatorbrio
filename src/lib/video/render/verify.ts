/**
 * Export verification (#144): proves an encoded MP4 is the deliverable the
 * export profile describes, before render jobs publish it as one.
 *
 * Three measurements of the file, each with a pure parser so CI (which has no
 * FFmpeg) tests every rule against recorded output:
 *   - ffprobe JSON (`-show_streams -show_format -count_packets`): codecs,
 *     profile, pixel format, size, frame rates, frame count, colour tags,
 *     audio format and durations (`parseProbe`);
 *   - the top-level MP4 boxes read from the file's own headers, 64-bit sizes
 *     included, for `moov` before `mdat` (`topLevelBoxes`);
 *   - an EBU R128 measurement (`ffmpeg -af ebur128=peak=true`), for integrated
 *     loudness and true peak (`parseEbur128Summary`).
 * `checkExport` turns them into a report; `verifyExport` runs the tools.
 *
 * Every check is recorded with what was expected and what was found. A check
 * that does not apply (loudness of a mix that was not normalised because it
 * is silent or absent) is recorded as `skipped` with the reason, never as
 * passed. The report is ok only when no check failed.
 */
import { open } from "node:fs/promises";

import { fileUrl, runTool, ToolError } from "../media/tools";
import type { LoudnessResult } from "./execute-types";
import type { RenderPlan } from "./plan";
import type { ExportProfile } from "./profile";

export type CheckStatus = "passed" | "failed" | "skipped";
type Value = string | number | null;

export interface VerificationCheck {
  /** Stable id, e.g. `video_profile`, `faststart`, `integrated_loudness`. */
  id: string;
  status: CheckStatus;
  expected: Value;
  actual: Value;
  /** Why a check was skipped. */
  reason?: string;
}

export interface VerificationReport {
  /** True when no check failed. */
  ok: boolean;
  checks: VerificationCheck[];
}

// ---------------------------------------------------------------------------
// ffprobe

export interface ProbeStream {
  codecType?: string;
  codecName?: string;
  profile?: string;
  pixFmt?: string;
  width?: number;
  height?: number;
  rFrameRate?: string;
  avgFrameRate?: string;
  /** Packets counted by `-count_packets`; one per frame for H.264 video. */
  packets?: number;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
  sampleRate?: number;
  channels?: number;
  durationSeconds?: number;
}

export interface ProbeSummary {
  formatName?: string;
  majorBrand?: string;
  durationSeconds?: number;
  streams: ProbeStream[];
}

export class VerifyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyInputError";
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const int = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
};
const seconds = (value: unknown): number | undefined => {
  const n = typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Reads ffprobe's JSON, keeping only the fields the checks use, each type-checked. */
export function parseProbe(json: string): ProbeSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new VerifyInputError("ffprobe did not print JSON");
  }
  const root = parsed as { streams?: unknown; format?: unknown };
  if (!root || typeof root !== "object" || !Array.isArray(root.streams) || !root.format || typeof root.format !== "object") {
    throw new VerifyInputError("ffprobe's JSON has no streams or format");
  }
  const format = root.format as Record<string, unknown>;
  const tags = (format.tags && typeof format.tags === "object" ? format.tags : {}) as Record<string, unknown>;
  return {
    formatName: str(format.format_name),
    majorBrand: str(tags.major_brand),
    durationSeconds: seconds(format.duration),
    streams: (root.streams as unknown[]).map((raw) => {
      const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      return {
        codecType: str(s.codec_type),
        codecName: str(s.codec_name),
        profile: str(s.profile),
        pixFmt: str(s.pix_fmt),
        width: int(s.width),
        height: int(s.height),
        rFrameRate: str(s.r_frame_rate),
        avgFrameRate: str(s.avg_frame_rate),
        packets: int(s.nb_read_packets),
        colorPrimaries: str(s.color_primaries),
        colorTransfer: str(s.color_transfer),
        colorSpace: str(s.color_space),
        colorRange: str(s.color_range),
        sampleRate: int(s.sample_rate),
        channels: int(s.channels),
        durationSeconds: seconds(s.duration),
      };
    }),
  };
}

/** True when an ffprobe rate such as `30/1` or `60/2` is exactly `fps` frames per second. */
export function rateIs(rate: string | undefined, fps: number): boolean {
  const match = /^(\d+)\/(\d+)$/.exec(rate ?? "");
  if (!match) return false;
  const num = Number(match[1]);
  const den = Number(match[2]);
  return den > 0 && num === fps * den;
}

// ---------------------------------------------------------------------------
// MP4 boxes

/** Random access to a file's bytes, so the box walk never holds a whole export in memory. */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface Mp4Box {
  type: string;
  offset: number;
  size: number;
}

const MAX_TOP_LEVEL_BOXES = 4096;

export function bufferSource(buffer: Buffer): ByteSource {
  return { size: buffer.length, read: async (offset, length) => buffer.subarray(offset, Math.min(buffer.length, offset + length)) };
}

/**
 * The file's top-level boxes in order, from their headers: a 32-bit size and a
 * four-character type; size 1 means a 64-bit size follows the type, size 0
 * means the box runs to the end of the file. Throws `VerifyInputError` when the
 * headers do not tile the file exactly.
 */
export async function topLevelBoxes(source: ByteSource): Promise<Mp4Box[]> {
  const boxes: Mp4Box[] = [];
  let offset = 0;
  while (offset < source.size) {
    if (boxes.length >= MAX_TOP_LEVEL_BOXES) throw new VerifyInputError("the file has too many top-level boxes");
    if (source.size - offset < 8) throw new VerifyInputError("the file ends inside a box header");
    const header = await source.read(offset, Math.min(16, source.size - offset));
    const small = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) throw new VerifyInputError("a box type is not printable");
    let size: number;
    let headerLength = 8;
    if (small === 1) {
      if (header.length < 16) throw new VerifyInputError("the file ends inside a 64-bit box header");
      const large = header.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new VerifyInputError("a box is larger than any file this reads");
      size = Number(large);
      headerLength = 16;
    } else if (small === 0) {
      size = source.size - offset;
    } else {
      size = small;
    }
    if (size < headerLength || offset + size > source.size) throw new VerifyInputError("a box's size does not fit the file");
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

async function fileBoxes(file: string): Promise<Mp4Box[]> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    return await topLevelBoxes({
      size,
      read: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      },
    });
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// EBU R128

export interface LoudnessMeasurement {
  integratedLufs: number;
  /** dBTP; `-Infinity` for digital silence. */
  truePeakDb: number;
}

const LEVEL = "(-?(?:\\d+(?:\\.\\d+)?|inf))";

function level(text: string): number {
  if (text === "-inf") return -Infinity;
  if (text === "inf") return Infinity;
  return Number(text);
}

/** The integrated loudness and true peak from the summary the ebur128 filter prints when it ends, or null without one. */
export function parseEbur128Summary(stderr: string): LoudnessMeasurement | null {
  const at = stderr.lastIndexOf("Summary:");
  if (at < 0) return null;
  const summary = stderr.slice(at);
  const integrated = new RegExp(`\\bI:\\s+${LEVEL}\\s+LUFS`).exec(summary);
  const peak = new RegExp(`\\bPeak:\\s+${LEVEL}\\s+dBFS`).exec(summary);
  if (!integrated || !peak) return null;
  return { integratedLufs: level(integrated[1]), truePeakDb: level(peak[1]) };
}

// ---------------------------------------------------------------------------
// The checks

export interface CheckInput {
  probe: ProbeSummary;
  /** Null when the box headers could not be read. */
  boxes: Mp4Box[] | null;
  /** Null when not measured (skipped) or when the measurement printed no summary. */
  measured: LoudnessMeasurement | null;
  plan: RenderPlan;
  profile: ExportProfile;
  /** The executor's normalisation outcome; decides whether loudness applies. */
  normalisation: LoudnessResult["normalisation"];
  maxDurationMs: number;
}

const MP4_BRANDS = /^(isom|iso[2-9]|mp41|mp42|avc1)$/;
const round = (n: number | undefined, places = 3): number | null => (n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** places) / 10 ** places);

/** Whether loudness checks apply, and if not, why. */
export function loudnessSkipReason(normalisation: LoudnessResult["normalisation"]): string | null {
  if (normalisation === "no-audio") return "the production has no sound, so the silent track is not normalised";
  if (normalisation === "skipped-silence") return "the mix is below the profile's silence floor, so it is not normalised";
  return null;
}

/** Applies every rule of the export profile to the measurements. Pure. */
export function checkExport(input: CheckInput): VerificationReport {
  const { probe, plan, profile } = input;
  const checks: VerificationCheck[] = [];
  const check = (id: string, ok: boolean, expected: Value, actual: Value) => checks.push({ id, status: ok ? "passed" : "failed", expected, actual });
  const fps = plan.canvas.fps;
  const frame = 1 / fps;
  const expectedSeconds = plan.durationFrames / fps;
  const color = profile.video.color;

  const formats = (probe.formatName ?? "").split(",");
  check("container", formats.includes(profile.container.format) && MP4_BRANDS.test(probe.majorBrand ?? ""), profile.container.format, probe.majorBrand ?? null);

  const videos = probe.streams.filter((s) => s.codecType === "video");
  const audios = probe.streams.filter((s) => s.codecType === "audio");
  check("video_streams", videos.length === 1, 1, videos.length);
  const v: ProbeStream = videos.length === 1 ? videos[0] : {};
  check("video_codec", v.codecName === profile.video.codec, profile.video.codec, v.codecName ?? null);
  check("video_profile", v.profile === profile.video.profile, profile.video.profile, v.profile ?? null);
  check("pixel_format", v.pixFmt === profile.video.pixelFormat, profile.video.pixelFormat, v.pixFmt ?? null);
  check("width", v.width === plan.canvas.width, plan.canvas.width, v.width ?? null);
  check("height", v.height === plan.canvas.height, plan.canvas.height, v.height ?? null);
  check("r_frame_rate", rateIs(v.rFrameRate, fps), `${fps}/1`, v.rFrameRate ?? null);
  check("avg_frame_rate", rateIs(v.avgFrameRate, fps), `${fps}/1`, v.avgFrameRate ?? null);
  check("frame_count", v.packets === plan.durationFrames, plan.durationFrames, v.packets ?? null);
  check("color_primaries", v.colorPrimaries === color.primaries, color.primaries, v.colorPrimaries ?? null);
  check("color_transfer", v.colorTransfer === color.transfer, color.transfer, v.colorTransfer ?? null);
  check("color_space", v.colorSpace === color.matrix, color.matrix, v.colorSpace ?? null);
  check("color_range", v.colorRange === color.range, color.range, v.colorRange ?? null);
  const vDuration = v.durationSeconds;
  check("video_duration", vDuration !== undefined && Math.abs(vDuration - expectedSeconds) <= frame + 1e-6, round(expectedSeconds), round(vDuration));

  check("audio_streams", audios.length === 1, 1, audios.length);
  const a: ProbeStream = audios.length === 1 ? audios[0] : {};
  check("audio_codec", a.codecName === profile.audio.codec, profile.audio.codec, a.codecName ?? null);
  check("audio_profile", a.profile === profile.audio.profile, profile.audio.profile, a.profile ?? null);
  check("sample_rate", a.sampleRate === profile.audio.sampleRate, profile.audio.sampleRate, a.sampleRate ?? null);
  check("channels", a.channels === profile.audio.channels, profile.audio.channels, a.channels ?? null);
  const aDuration = a.durationSeconds;
  check("audio_duration", aDuration !== undefined && Math.abs(aDuration - expectedSeconds) <= frame + 1e-6, round(expectedSeconds), round(aDuration));

  const total = probe.durationSeconds;
  check("duration", total !== undefined && Math.abs(total - expectedSeconds) <= frame + 1e-6, round(expectedSeconds), round(total));
  check("max_duration", total !== undefined && total * 1000 <= input.maxDurationMs + 1e-6, input.maxDurationMs, total === undefined ? null : Math.round(total * 1000));

  const moov = input.boxes?.findIndex((b) => b.type === "moov") ?? -1;
  const mdat = input.boxes?.findIndex((b) => b.type === "mdat") ?? -1;
  const order = input.boxes ? input.boxes.map((b) => b.type).join(",") : null;
  check("faststart", moov >= 0 && mdat >= 0 && moov < mdat, "moov before mdat", order);

  const skip = loudnessSkipReason(input.normalisation);
  const target = plan.loudness.targetLufs;
  if (skip) {
    checks.push({ id: "integrated_loudness", status: "skipped", expected: target, actual: null, reason: skip });
    checks.push({ id: "true_peak", status: "skipped", expected: profile.loudness.truePeakDb, actual: null, reason: skip });
  } else {
    const m = input.measured;
    check("integrated_loudness", m !== null && Math.abs(m.integratedLufs - target) <= profile.loudness.toleranceLu, target, round(m?.integratedLufs, 1));
    check("true_peak", m !== null && m.truePeakDb <= profile.loudness.truePeakDb, profile.loudness.truePeakDb, round(m?.truePeakDb, 1));
  }

  return { ok: checks.every((c) => c.status !== "failed"), checks };
}

// ---------------------------------------------------------------------------
// Running the tools

export interface VerifyOptions {
  /** The production's `format.maxDurationMs`, from the render's snapshot. */
  maxDurationMs: number;
  signal?: AbortSignal;
}

/** A report for a file ffprobe or the box walk cannot read at all. */
function unreadable(): VerificationReport {
  return { ok: false, checks: [{ id: "readable", status: "failed", expected: "an MP4 file ffprobe can read", actual: "unreadable" }] };
}

/**
 * Measures `file` and checks it against the plan and the profile. Tool
 * problems other than an unreadable file (missing, timed out, cancelled)
 * propagate as `ToolError` for render jobs to classify.
 */
export async function verifyExport(file: string, plan: RenderPlan, profile: ExportProfile, loudness: LoudnessResult, options: VerifyOptions): Promise<VerificationReport> {
  // Both tools read the whole file; allow them a generous multiple of real time.
  const timeoutMs = 60_000 + Math.ceil((plan.durationFrames / plan.canvas.fps) * 2000);
  let probe: ProbeSummary;
  try {
    const { stdout } = await runTool("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-count_packets", fileUrl(file)], {
      timeoutMs,
      signal: options.signal,
    });
    probe = parseProbe(stdout);
  } catch (error) {
    if ((error instanceof ToolError && error.reason === "failed") || error instanceof VerifyInputError) return unreadable();
    throw error;
  }

  const boxes = await fileBoxes(file).catch((error: unknown) => {
    if (error instanceof VerifyInputError) return null;
    throw error;
  });

  let measured: LoudnessMeasurement | null = null;
  if (!loudnessSkipReason(loudness.normalisation)) {
    // framelog=verbose keeps the per-block lines out of the info log, and
    // -nostats the progress line, so the summary stays in the kept stderr tail.
    // A file whose audio cannot be decoded leaves `measured` null, which fails
    // the loudness checks instead of the job.
    measured = await runTool(
      "ffmpeg",
      ["-nostdin", "-hide_banner", "-nostats", "-i", fileUrl(file), "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"],
      { timeoutMs, signal: options.signal }
    ).then(
      ({ stderrTail }) => parseEbur128Summary(stderrTail),
      (error: unknown) => {
        if (error instanceof ToolError && error.reason === "failed") return null;
        throw error;
      }
    );
  }

  return checkExport({ probe, boxes, measured, plan, profile, normalisation: loudness.normalisation, maxDurationMs: options.maxDurationMs });
}
