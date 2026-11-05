/**
 * What a media file is, read with ffprobe and parsed strictly. ffprobe's JSON
 * describes whatever file a person pointed at, so it is treated as untrusted
 * input: only a known shape is accepted, numbers are bounded, and anything
 * that is not clearly video, audio or a still image is refused.
 */
import type { MediaKind } from "@/types/production";
import { fileUrl, runTool, ToolError } from "./tools";

export type DynamicRange = "sdr" | "hlg" | "pq";

export interface VideoFacts {
  codec: string;
  /** Coded size, before rotation. */
  width: number;
  height: number;
  /** Clockwise rotation a player applies: 0, 90, 180 or 270. */
  rotation: 0 | 90 | 180 | 270;
  /** Frame rate as a rational, from the stream's nominal rate. */
  frameRate: { num: number; den: number } | null;
  /** The average rate differs from the nominal rate by more than 1 %. */
  variableFrameRate: boolean;
  pixelFormat: string | null;
  bitDepth: number | null;
  color: { primaries: string | null; transfer: string | null; matrix: string | null; range: string | null };
  dynamicRange: DynamicRange;
}

export interface AudioFacts {
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface MediaFacts {
  kind: MediaKind;
  container: string;
  /** Whole microseconds, rounded down; absent for still images. */
  durationUs?: number;
  video?: VideoFacts;
  audio?: AudioFacts;
}

export class UnsupportedMedia extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMedia";
  }
}

const MAX_DIMENSION = 16384;
const MAX_DURATION_US = 6 * 60 * 60 * 1_000_000;
const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "tiff"]);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length < 200 ? v : null);
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};
const seconds = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function rational(v: unknown): { num: number; den: number } | null {
  const m = typeof v === "string" ? /^(\d{1,9})\/(\d{1,9})$/.exec(v) : null;
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  return num > 0 && den > 0 && num / den <= 1000 ? { num, den } : null;
}

function rotationOf(stream: Json): VideoFacts["rotation"] {
  let degrees = 0;
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  for (const entry of sideData) {
    if (isObject(entry) && typeof entry.rotation === "number") degrees = entry.rotation;
  }
  const tags = isObject(stream.tags) ? stream.tags : {};
  if (degrees === 0 && typeof tags.rotate === "string" && /^-?\d+$/.test(tags.rotate)) degrees = Number(tags.rotate);
  // Display-matrix rotation is counter-clockwise; players turn the picture the other way.
  const clockwise = (((-degrees % 360) + 360) % 360) as number;
  return clockwise === 90 || clockwise === 180 || clockwise === 270 ? clockwise : 0;
}

function dynamicRange(transfer: string | null): DynamicRange {
  if (transfer === "arib-std-b67") return "hlg";
  if (transfer === "smpte2084") return "pq";
  return "sdr";
}

/** Parses ffprobe's `-show_format -show_streams` JSON. Exported for tests. */
export function parseProbe(text: string): MediaFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UnsupportedMedia("the file could not be read as media");
  }
  if (!isObject(parsed) || !isObject(parsed.format) || !Array.isArray(parsed.streams)) {
    throw new UnsupportedMedia("the file could not be read as media");
  }
  const format = parsed.format;
  const container = str(format.format_name);
  if (!container) throw new UnsupportedMedia("the file has no recognised container");
  const streams = parsed.streams.filter(isObject);

  const pictures = streams.filter((s) => s.codec_type === "video");
  const isCoverArt = (s: Json) => isObject(s.disposition) && s.disposition.attached_pic === 1;
  const moving = pictures.filter((s) => !isCoverArt(s) && !IMAGE_CODECS.has(String(s.codec_name)));
  const still = pictures.find((s) => !isCoverArt(s) && IMAGE_CODECS.has(String(s.codec_name)));
  const sound = streams.find((s) => s.codec_type === "audio");

  const durationSeconds = seconds(format.duration);
  const durationUs = durationSeconds === null ? null : Math.floor(durationSeconds * 1_000_000);
  if (durationUs !== null && durationUs > MAX_DURATION_US) throw new UnsupportedMedia("the media is longer than six hours");

  const audio = sound ? audioFacts(sound) : undefined;

  if (moving.length > 0) {
    const video = videoFacts(moving[0]);
    if (!durationUs) throw new UnsupportedMedia("the video has no duration");
    return { kind: "video", container, durationUs, video, ...(audio ? { audio } : {}) };
  }
  if (still && !sound && /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe)(,|$)/.test(container)) {
    return { kind: "image", container, video: videoFacts(still) };
  }
  if (audio) {
    if (!durationUs) throw new UnsupportedMedia("the audio has no duration");
    return { kind: "audio", container, durationUs, audio };
  }
  throw new UnsupportedMedia("the file has no video, audio or image stream");
}

function videoFacts(stream: Json): VideoFacts {
  const codec = str(stream.codec_name);
  const width = int(stream.width);
  const height = int(stream.height);
  if (!codec || !width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new UnsupportedMedia("the picture size is missing or too large");
  }
  const nominal = rational(stream.r_frame_rate);
  const average = rational(stream.avg_frame_rate);
  const variableFrameRate = !!(nominal && average && Math.abs(nominal.num / nominal.den - average.num / average.den) / (nominal.num / nominal.den) > 0.01);
  const transfer = str(stream.color_transfer);
  return {
    codec,
    width,
    height,
    rotation: rotationOf(stream),
    frameRate: nominal,
    variableFrameRate,
    pixelFormat: str(stream.pix_fmt),
    bitDepth: int(stream.bits_per_raw_sample),
    color: { primaries: str(stream.color_primaries), transfer, matrix: str(stream.color_space), range: str(stream.color_range) },
    dynamicRange: dynamicRange(transfer),
  };
}

function audioFacts(stream: Json): AudioFacts | undefined {
  const codec = str(stream.codec_name);
  const sampleRate = int(stream.sample_rate);
  const channels = int(stream.channels);
  if (!codec || !sampleRate || !channels || sampleRate > 768000 || channels > 64) return undefined;
  return { codec, sampleRate, channels };
}

/** Probes a file. Rejects with UnsupportedMedia for anything that is not usable media. */
export async function probeFile(file: string, signal?: AbortSignal): Promise<MediaFacts> {
  try {
    const { stdout } = await runTool("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", fileUrl(file)], {
      timeoutMs: 30_000,
      maxStdout: 4 * 1024 * 1024,
      signal,
    });
    return parseProbe(stdout);
  } catch (error) {
    if (error instanceof ToolError && error.reason === "failed") throw new UnsupportedMedia("the file could not be read as media");
    throw error;
  }
}
