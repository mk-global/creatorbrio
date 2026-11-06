/**
 * Pure builders for the export's final FFmpeg run (#144, ADR decision 3),
 * which cuts and composites the footage from the originals under the
 * overlay and muxes it with the mastered sound, and the pieces every run
 * shares. The sound's own runs are in `ffmpeg-audio.ts`. Nothing here runs
 * a process; `execute.ts` does.
 *
 * Picture, at 4:4:4 BT.709 limited range until the very end: a black base at
 * the canvas size; each track is one stream of exactly `durationFrames`
 * frames, its clips concatenated in time with fully transparent gaps and the
 * result put back on the frame grid (concat stamps its output in
 * microseconds, which can end the track just before the base's last frame
 * and so cut the render a frame short). A clip's source is opened `PREROLL_US` before `sourceInUs` (accurate seek),
 * shifted so `sourceInUs` is time 0, and converted to the plan's rate so
 * frame k shows the source frame on screen at `sourceInUs + k / fps` (the
 * latest one starting at or before it, within `SELECT_TOLERANCE_US`); a source
 * that ends early holds its last frame. It is then scaled to the cover size
 * and cropped at the placement offsets. Stills loop for their clip. SDR
 * sources are turned upright by FFmpeg's autorotation; HLG and PQ sources go
 * through the VideoToolbox conversion the preview proxies use (`hdrToSdr`).
 * Tracks are composited bottom to top, then the overlay, whose RGBA PNG
 * frames are converted to BT.709 limited range explicitly (FFmpeg's
 * automatic conversion would use BT.601). The result is subsampled to
 * yuv420p once and tagged BT.709 tv on every frame and on the stream.
 *
 * Encoding follows the export profile with fixed encoder threads, no
 * metadata and bitexact muxing, so one plan encodes to the same bytes on the
 * same machine and FFmpeg build.
 */
import type { PlanInput, RenderPlan, VideoLayer } from "./plan";
import type { ExportProfile } from "./profile";
import { hdrToSdr } from "@/lib/video/media/proxy";
import { fileUrl } from "@/lib/video/media/tools";

export const AUDIO_SAMPLE_RATE = 48000;
/** Video sources are opened this long before the first time they show, so the frame on screen then is decoded even when it began earlier. */
export const PREROLL_US = 1_000_000;
/** A source frame starting this little after a frame's time still counts as on screen then, absorbing timestamp rounding. */
export const SELECT_TOLERANCE_US = 100;
/** Larger filter graphs go to a file instead of the command line. */
export const MAX_INLINE_GRAPH_BYTES = 64 * 1024;

/** A plan the builders cannot express; the executor reports it as an internal error. */
export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

/** An FFmpeg run before its filter graph is attached: input options, the graph, output options. */
export interface FfmpegRun {
  inputs: string[];
  /** A `-filter_complex` graph, or "" for none. */
  graph: string;
  outputs: string[];
}

export const COMMON = ["-nostdin", "-hide_banner", "-nostats"];
export const BITEXACT = ["-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", "-map_chapters", "-1"];

/** A decimal FFmpeg accepts everywhere: no exponent, no negative zero, trailing zeros trimmed. */
export function num(value: number, decimals = 9): string {
  if (!Number.isFinite(value)) throw new GraphError("a filter value is not a finite number");
  const text = value.toFixed(decimals).replace(/\.?0+$/, "");
  return text === "-0" || text === "" ? "0" : text;
}

/** Seconds, exactly, from integer microseconds. */
export function seconds(us: number): string {
  if (!Number.isSafeInteger(us)) throw new GraphError("a time is not a whole number of microseconds");
  return num(us / 1_000_000, 6);
}

export function samplesFor(frames: number, fps: number): number {
  const samples = (frames * AUDIO_SAMPLE_RATE) / fps;
  if (!Number.isSafeInteger(samples)) throw new GraphError(`${fps} fps does not divide 48 kHz into whole samples`);
  return samples;
}

/** The render's audio length in samples: `round(durationFrames * 48000 / fps)`. */
export function totalSamples(plan: Pick<RenderPlan, "durationFrames" | "canvas">): number {
  return Math.round((plan.durationFrames * AUDIO_SAMPLE_RATE) / plan.canvas.fps);
}

/** The AAC encoder settings of the profile, shared by the final encode and the loudness check so both produce the same bitstream. */
export function audioEncoderArgs(profile: ExportProfile): string[] {
  const a = profile.audio;
  return ["-c:a", a.codec, "-profile:a", "aac_low", "-b:a", `${a.bitrateKbps}k`, "-ar", String(a.sampleRate), "-ac", String(a.channels)];
}

export interface VideoSourceFile {
  /** Absolute path of the original. */
  path: string;
  input: PlanInput;
}

const BT709 = "out_color_matrix=bt709:out_range=tv";
const SCALE_FLAGS = "flags=lanczos+accurate_rnd+full_chroma_int";

/** The filters that turn one layer's input into exactly its clip's frames, placed on the canvas, as yuva444p BT.709. */
function layerChain(plan: RenderPlan, layer: VideoLayer, index: number, input: PlanInput): { options: string[]; chain: string } {
  const { width, height, fps } = plan.canvas;
  const { placement } = layer;
  const ints = [layer.durationFrames, placement.scaledWidth, placement.scaledHeight, placement.offsetX, placement.offsetY];
  if (!ints.every((n) => Number.isSafeInteger(n)) || layer.durationFrames < 1) throw new GraphError("a picture layer has an invalid length or placement");
  if (placement.scaledWidth < width || placement.scaledHeight < height || placement.offsetX < 0 || placement.offsetY < 0 || placement.offsetX + width > placement.scaledWidth || placement.offsetY + height > placement.scaledHeight) {
    throw new GraphError("a picture layer's placement does not cover the canvas");
  }
  const frames = layer.durationFrames;
  const place = [
    `tpad=stop_mode=clone:stop=${frames}`,
    `trim=end_frame=${frames}`,
    "setpts=PTS-STARTPTS",
    `scale=w=${placement.scaledWidth}:h=${placement.scaledHeight}:${SCALE_FLAGS}:${BT709}`,
    "format=yuva444p",
    `crop=w=${width}:h=${height}:x=${placement.offsetX}:y=${placement.offsetY}:exact=1`,
    "setsar=1",
  ];
  if (layer.kind === "still") {
    // Looped at the plan's rate for one frame longer than needed; the trim makes it exact. Autorotation stays on:
    // it turns an EXIF-oriented still upright, and the facts read that same turn from the decoded frame (`facts.ts`).
    const options = ["-loop", "1", "-framerate", String(fps), "-t", num((frames + 1) / fps, 6)];
    return { options, chain: [`[${index}:v:0]setpts=PTS-STARTPTS`, ...place].join(",") };
  }
  const sourceInUs = layer.sourceInUs;
  if (sourceInUs === undefined || !Number.isSafeInteger(sourceInUs) || sourceInUs < 0) throw new GraphError("a video layer has no valid source time");
  const openAt = Math.max(0, sourceInUs - PREROLL_US);
  const shiftUs = sourceInUs - openAt + SELECT_TOLERANCE_US;
  const options: string[] = [];
  const steps: string[] = [];
  if (input.dynamicRange !== "sdr") {
    if (!input.display) throw new GraphError("an HDR layer's media has no picture size");
    const hdr = hdrToSdr({ w: input.display.width, h: input.display.height }, input.rotation);
    options.push(...hdr.input);
    steps.push(hdr.filter);
  }
  if (openAt > 0) options.push("-ss", seconds(openAt));
  // Shifted so the tolerance-adjusted source time is 0; rounding timestamps up then keeps, for each
  // output frame, the latest source frame that starts at or before its time.
  steps.push(`setpts=PTS-${seconds(shiftUs)}/TB`, `fps=fps=${fps}:start_time=0:round=up`);
  return { options, chain: [`[${index}:v:0]${steps.join(",")}`, ...place].join(",") };
}

/** Indexes of the fixed inputs of the video run. */
export const OVERLAY_INPUT = 0;
export const AUDIO_INPUT = 1;
const FIRST_LAYER_INPUT = 2;

/**
 * Pass 3: the picture, composited and encoded with the normalised sound.
 * Input 0 is the overlay as an image2pipe PNG stream on stdin, input 1 the
 * normalised WAV, then one input per video layer in plan order.
 */
export function videoRun(plan: RenderPlan, profile: ExportProfile, files: ReadonlyMap<string, VideoSourceFile>, audio: string, output: string): FfmpegRun {
  const { width, height, fps } = plan.canvas;
  const total = plan.durationFrames;
  if (!Number.isSafeInteger(total) || total < 1) throw new GraphError("the render has no frames");
  const inputs = ["-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "pipe:0", "-i", fileUrl(audio)];
  const chains: string[] = [];
  const tracks = new Map<number, { layer: VideoLayer; label: string }[]>();
  plan.video.forEach((layer, i) => {
    const file = files.get(layer.mediaId);
    if (!file) throw new GraphError("a picture layer's media is not available");
    const { options, chain } = layerChain(plan, layer, FIRST_LAYER_INPUT + i, file.input);
    inputs.push(...options, "-i", fileUrl(file.path));
    chains.push(`${chain}[l${i}]`);
    const track = tracks.get(layer.trackIndex) ?? [];
    track.push({ layer, label: `l${i}` });
    tracks.set(layer.trackIndex, track);
  });
  const gap = (frames: number, label: string) => chains.push(`color=c=black@0:s=${width}x${height}:r=${fps},format=yuva444p,trim=end_frame=${frames},setsar=1[${label}]`);
  chains.push(`color=c=black:s=${width}x${height}:r=${fps},format=yuv444p,trim=end_frame=${total},setsar=1[base]`);
  let below = "base";
  const order = [...tracks.keys()].sort((a, b) => a - b);
  order.forEach((trackIndex, t) => {
    const layers = tracks.get(trackIndex)!.sort((a, b) => a.layer.startFrame - b.layer.startFrame);
    const segments: string[] = [];
    let at = 0;
    layers.forEach(({ layer, label }, j) => {
      if (!Number.isSafeInteger(layer.startFrame) || layer.startFrame < at || layer.startFrame + layer.durationFrames > total) {
        throw new GraphError("picture layers on one track overlap or run past the render");
      }
      if (layer.startFrame > at) {
        gap(layer.startFrame - at, `g${t}_${j}`);
        segments.push(`[g${t}_${j}]`);
      }
      segments.push(`[${label}]`);
      at = layer.startFrame + layer.durationFrames;
    });
    if (at < total) {
      gap(total - at, `g${t}_end`);
      segments.push(`[g${t}_end]`);
    }
    const track = `t${t}`;
    // Frame n of a joined track is frame n of the render: concat's microsecond timestamps are replaced by the grid.
    chains.push(segments.length === 1 ? `${segments[0]}null[${track}]` : `${segments.join("")}concat=n=${segments.length}:v=1:a=0,settb=1/${fps},setpts=N[${track}]`);
    chains.push(`[${below}][${track}]overlay=x=0:y=0:format=yuv444:eof_action=endall[c${t}]`);
    below = `c${t}`;
  });
  const color = profile.video.color;
  // The overlay's RGBA is converted to BT.709 limited range here, explicitly.
  chains.push(`[${OVERLAY_INPUT}:v:0]format=rgba,scale=${SCALE_FLAGS}:${BT709},format=yuva444p,setsar=1[ov]`);
  chains.push(
    `[${below}][ov]overlay=x=0:y=0:format=yuv444:eof_action=endall,` +
      `scale=in_color_matrix=bt709:in_range=tv:${SCALE_FLAGS}:${BT709},format=${profile.video.pixelFormat},` +
      `setparams=field_mode=prog:range=${color.range}:color_primaries=${color.primaries}:color_trc=${color.transfer}:colorspace=${color.matrix}[vout]`
  );
  const v = profile.video;
  const outputs = [
    "-map", "[vout]", "-map", `${AUDIO_INPUT}:a:0`,
    "-c:v", v.encoder, "-preset", v.preset, "-crf", String(v.crf), "-maxrate", `${v.maxrateKbps}k`, "-bufsize", `${v.bufsizeKbps}k`,
    "-profile:v", v.profile.toLowerCase(), "-g", String(Math.round(v.keyframeSeconds * fps)), "-threads", String(v.threads),
    "-colorspace", color.matrix, "-color_primaries", color.primaries, "-color_trc", color.transfer, "-color_range", color.range,
    ...audioEncoderArgs(profile),
    "-fps_mode", "cfr", "-r", String(fps), "-frames:v", String(total),
    "-sn", "-dn", ...BITEXACT,
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-stats_period", "0.5",
    "-f", profile.container.format, fileUrl(output),
  ];
  return { inputs, graph: chains.join(";"), outputs };
}

/**
 * How a run's graph is passed: inline when small, else from `scriptPath`,
 * with `-/filter_complex` (FFmpeg 7.0 and later, where `-filter_complex_script`
 * is deprecated and later removed) or `-filter_complex_script` (6.x). A
 * development build (`version` null) is treated as current.
 */
export function graphOptions(graph: string, scriptPath: string, version: { major: number } | null): { options: string[]; script: string | null } {
  if (graph === "") return { options: [], script: null };
  if (Buffer.byteLength(graph, "utf-8") <= MAX_INLINE_GRAPH_BYTES) return { options: ["-filter_complex", graph], script: null };
  const option = version === null || version.major >= 7 ? "-/filter_complex" : "-filter_complex_script";
  return { options: [option, fileUrl(scriptPath)], script: graph };
}

/** The complete argument list of a run. */
export function runArgs(run: FfmpegRun, graph: string[], verbosity: "error" | "info" = "error"): string[] {
  return [...COMMON, "-v", verbosity, "-y", ...run.inputs, ...graph, ...run.outputs];
}
