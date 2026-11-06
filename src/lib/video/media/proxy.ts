/**
 * The files derived from an original for preview (WS2 slice, #140): a small,
 * upright, SDR BT.709 copy a browser can play and seek quickly, a poster frame
 * and audio peaks. They are previews only; export always renders from the
 * original (ADR decision 3).
 *
 * - Video: H.264 (libx264, else VideoToolbox) yuv420p within 540×960 portrait
 *   or 960×540 landscape, a keyframe every 15 frames for scrubbing, source
 *   timestamps kept, AAC 48 kHz stereo, faststart, no rotation flag (the
 *   picture itself is turned upright).
 * - HLG and PQ video: converted on VideoToolbox with `scale_vt` (G2 #98), the
 *   only HDR conversion this FFmpeg build offers. Without it the job fails as
 *   a configuration problem rather than producing a washed-out preview.
 * - Audio: AAC 48 kHz stereo in M4A.
 * - Images: PNG within 1080×1920 (or 1920×1080), keeping transparency.
 * - Poster: one JPEG frame taken from the finished video proxy.
 * - Peaks: the loudest sample per bucket, 0 to 255, at up to 100 per second.
 *
 * Every file is written into a scratch folder; the job publishes them.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { MediaRecord, DerivedFile } from "./registry";
import { ffmpegHas, ffmpegRecentEnough, fileUrl, MIN_FFMPEG, runTool } from "./tools";

export type FailureClass = "transient" | "permanent" | "configuration";

export class ProxyFailure extends Error {
  constructor(
    readonly failureClass: FailureClass,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ProxyFailure";
  }
}

export interface DerivedOutput {
  files: DerivedFile[];
  /** How the preview's colour relates to the original. */
  color: "sdr" | "hdr-converted" | "none";
}

const PEAKS_SAMPLE_RATE = 8000;
const MAX_PEAKS = 100_000;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The upright size of a picture fitted inside a box that matches its orientation. */
export function fitSize(width: number, height: number, rotation: number, portraitBox: { w: number; h: number }): { w: number; h: number } {
  const [dw, dh] = rotation === 90 || rotation === 270 ? [height, width] : [width, height];
  const box = dw > dh ? { w: portraitBox.h, h: portraitBox.w } : portraitBox;
  const scale = Math.min(1, box.w / dw, box.h / dh);
  return { w: even(dw * scale), h: even(dh * scale) };
}

/** Seconds of tool time allowed, scaled from the media's length. */
function deadline(record: MediaRecord, perSecond: number, minimumMs: number): number {
  const seconds = (record.facts.durationUs ?? 0) / 1_000_000;
  return Math.max(minimumMs, Math.ceil(seconds * perSecond * 1000));
}

const SDR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
/** Frame-level BT.709 tags; output flags alone are ignored once filters have set frame properties. */
const SDR_FRAMES = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";

function videoEncoder(): string[] {
  if (ffmpegHas("encoders", "libx264")) return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high"];
  if (ffmpegHas("encoders", "h264_videotoolbox")) return ["-c:v", "h264_videotoolbox", "-b:v", "3M", "-profile:v", "high"];
  throw new ProxyFailure("configuration", "encoder_missing", "this FFmpeg has no H.264 encoder");
}

/** A software transpose for a clockwise rotation, for frames FFmpeg has not already turned. */
function uprightFilter(rotation: number): string | null {
  if (rotation === 90) return "transpose=clock";
  if (rotation === 270) return "transpose=cclock";
  if (rotation === 180) return "hflip,vflip";
  return null;
}

async function videoProxy(record: MediaRecord, original: string, out: string, signal: AbortSignal): Promise<"sdr" | "hdr-converted"> {
  const video = record.facts.video!;
  const size = fitSize(video.width, video.height, video.rotation, { w: 540, h: 960 });
  const hdr = video.dynamicRange !== "sdr";
  let input: string[];
  let filter: string;
  if (hdr) {
    if (!ffmpegHas("filters", "scale_vt") || !ffmpegHas("filters", "hwdownload")) {
      throw new ProxyFailure("configuration", "hdr_conversion_unavailable", "HDR footage needs FFmpeg with VideoToolbox (scale_vt) to make a preview on this computer");
    }
    // FFmpeg's automatic rotation is dropped on this hardware path, so the source's rotation is
    // ignored on input and the converted frames are turned upright in software.
    const coded = video.rotation === 90 || video.rotation === 270 ? { w: size.h, h: size.w } : size;
    input = ["-display_rotation", "0", "-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"];
    filter = [
      `scale_vt=w=${coded.w}:h=${coded.h}:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709`,
      "hwdownload",
      "format=p010le",
      uprightFilter(video.rotation),
      "format=yuv420p",
      SDR_FRAMES,
    ]
      .filter(Boolean)
      .join(",");
  } else {
    // Software decoding: FFmpeg turns the picture upright itself and writes no rotation flag.
    input = [];
    filter = `scale=${size.w}:${size.h}:flags=bicubic:out_color_matrix=bt709:out_range=tv,format=yuv420p,${SDR_FRAMES}`;
  }
  const audio = record.facts.audio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"] : ["-an"];
  await runTool(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-v", "error", "-y",
      ...input,
      "-i", fileUrl(original),
      "-map", "0:v:0", ...audio,
      "-vf", filter,
      ...videoEncoder(),
      "-g", "15", "-keyint_min", "15", "-fps_mode", "passthrough",
      ...SDR_TAGS,
      "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
      "-movflags", "+faststart",
      fileUrl(out),
    ],
    { timeoutMs: deadline(record, 4, 120_000), signal }
  );
  return hdr ? "hdr-converted" : "sdr";
}

async function poster(record: MediaRecord, proxy: string, out: string, signal: AbortSignal): Promise<void> {
  const seconds = Math.min(1, (record.facts.durationUs ?? 0) / 2_000_000);
  await runTool(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-v", "error", "-y", "-ss", seconds.toFixed(3), "-i", fileUrl(proxy), "-frames:v", "1", "-q:v", "3", "-update", "1", fileUrl(out)],
    { timeoutMs: 30_000, signal }
  );
}

async function audioProxy(record: MediaRecord, original: string, out: string, signal: AbortSignal): Promise<void> {
  await runTool(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-v", "error", "-y", "-i", fileUrl(original),
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
      "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4", fileUrl(out),
    ],
    { timeoutMs: deadline(record, 1, 60_000), signal }
  );
}

async function imageProxy(record: MediaRecord, original: string, out: string, signal: AbortSignal): Promise<void> {
  const video = record.facts.video!;
  const size = fitSize(video.width, video.height, video.rotation, { w: 1080, h: 1920 });
  await runTool(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-v", "error", "-y", "-i", fileUrl(original),
      "-frames:v", "1", "-vf", `scale=${size.w}:${size.h}:flags=lanczos,format=rgba`, "-map_metadata", "-1", "-update", "1", fileUrl(out),
    ],
    { timeoutMs: 60_000, signal }
  );
}

/** Peaks per second, lowered for long media so the file stays bounded. */
export function peaksPerSecond(durationUs: number): number {
  const seconds = durationUs / 1_000_000;
  return Math.max(1, Math.min(100, Math.floor(MAX_PEAKS / Math.max(seconds, 1))));
}

async function peaks(record: MediaRecord, original: string, out: string, signal: AbortSignal): Promise<void> {
  const durationUs = record.facts.durationUs!;
  const rate = peaksPerSecond(durationUs);
  const bucket = Math.floor(PEAKS_SAMPLE_RATE / rate);
  const values: number[] = [];
  let current = 0;
  let inBucket = 0;
  let carry: Buffer | null = null;
  const expectedBytes = Math.ceil((durationUs / 1_000_000 + 5) * PEAKS_SAMPLE_RATE * 2 * 1.1);
  await runTool(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-v", "error", "-i", fileUrl(original), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(PEAKS_SAMPLE_RATE), "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1"],
    {
      timeoutMs: deadline(record, 0.5, 60_000),
      signal,
      maxStdout: expectedBytes,
      onStdout: (chunk) => {
        const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
        const whole = data.length - (data.length % 2);
        for (let i = 0; i < whole; i += 2) {
          const sample = Math.abs(data.readInt16LE(i));
          if (sample > current) current = sample;
          if (++inBucket === bucket) {
            values.push(Math.min(255, Math.round((current / 32768) * 255)));
            current = 0;
            inBucket = 0;
          }
        }
        carry = whole < data.length ? data.subarray(whole) : null;
      },
    }
  );
  if (inBucket > 0) values.push(Math.min(255, Math.round((current / 32768) * 255)));
  await writeFile(out, JSON.stringify({ version: 1, peaksPerSecond: rate, peaks: values }) + "\n", { mode: 0o644 });
}

/** Builds every derived file for one media into `dir`. Throws ToolError or ProxyFailure. */
export async function buildDerived(record: MediaRecord, original: string, dir: string, signal: AbortSignal): Promise<DerivedOutput> {
  if (!ffmpegRecentEnough()) {
    throw new ProxyFailure("configuration", "ffmpeg_too_old", `previews need FFmpeg ${MIN_FFMPEG.major}.${MIN_FFMPEG.minor} or newer`);
  }
  const at = (file: DerivedFile) => path.join(/*turbopackIgnore: true*/ dir, file);
  if (record.kind === "video") {
    const color = await videoProxy(record, original, at("proxy.mp4"), signal);
    await poster(record, at("proxy.mp4"), at("poster.jpg"), signal);
    const files: DerivedFile[] = ["proxy.mp4", "poster.jpg"];
    if (record.facts.audio) {
      await peaks(record, original, at("peaks.json"), signal);
      files.push("peaks.json");
    }
    return { files, color };
  }
  if (record.kind === "audio") {
    await audioProxy(record, original, at("proxy.m4a"), signal);
    await peaks(record, original, at("peaks.json"), signal);
    return { files: ["proxy.m4a", "peaks.json"], color: "none" };
  }
  await imageProxy(record, original, at("proxy.png"), signal);
  return { files: ["proxy.png"], color: "sdr" };
}
