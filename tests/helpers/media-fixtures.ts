/**
 * Media for tests.
 *
 * - `registerFixtureMedia` puts the production fixtures' media ids (which are
 *   not real SHA-256 digests of any file) into a registry folder as records
 *   whose derived files are already done, so tests of the Production API run
 *   against the real ledger without FFmpeg.
 * - `makeMedia` generates small synthetic, legally unencumbered media with
 *   FFmpeg for import and proxy tests; `FFMPEG_MISSING` names why those tests
 *   are skipped where FFmpeg is not installed.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { MediaKind } from "@/types/production";
import { ffmpegHas, ffmpegRecentEnough, MIN_FFMPEG, toolPath } from "@/lib/video/media/tools";
import { MEDIA } from "./production-fixtures";

const run = promisify(execFile);

export const FIXTURE_DURATION_US = 3_600_000_000;

const FIXTURE_KINDS: Record<keyof typeof MEDIA, MediaKind> = {
  aRoll: "video",
  bRoll: "video",
  music: "audio",
  logo: "image",
  narration: "audio",
  illustration: "image",
  sfx: "audio",
};

/** Writes registry records for media ids directly, as a published import would leave them. */
export async function registerMedia(dataDir: string, media: { mediaId: string; kind: MediaKind; durationUs?: number }[]): Promise<void> {
  for (const m of media) {
    const dir = path.join(dataDir, "video-media", "objects", m.mediaId);
    await mkdir(dir, { recursive: true });
    const durationUs = m.kind === "image" ? undefined : (m.durationUs ?? FIXTURE_DURATION_US);
    const record = {
      version: 1,
      mediaId: m.mediaId,
      kind: m.kind,
      originalName: `${m.kind}-fixture.bin`,
      extension: ".bin",
      sizeBytes: 1,
      importedAt: "2026-11-06T00:00:00.000Z",
      facts: { kind: m.kind, container: "fixture", ...(durationUs === undefined ? {} : { durationUs }) },
      provenance: { source: "local-file", rights: "user-supplied" },
    };
    const job = {
      version: 1,
      mediaId: m.mediaId,
      state: "succeeded",
      attempts: 1,
      updatedAt: "2026-11-06T00:00:00.000Z",
      output: { files: [], color: "none" },
      history: [],
    };
    await writeFile(path.join(dir, "record.json"), JSON.stringify(record));
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job));
  }
}

/** Registers every media id the production fixtures use. */
export function registerFixtureMedia(dataDir: string): Promise<void> {
  return registerMedia(
    dataDir,
    (Object.keys(MEDIA) as (keyof typeof MEDIA)[]).map((name) => ({ mediaId: MEDIA[name], kind: FIXTURE_KINDS[name] }))
  );
}

export const FFMPEG_MISSING = !(toolPath("ffmpeg") && toolPath("ffprobe"))
  ? "FFmpeg and ffprobe are not installed"
  : ffmpegRecentEnough()
    ? null
    : `FFmpeg is older than ${MIN_FFMPEG.major}.${MIN_FFMPEG.minor}`;
export const HDR_MISSING = FFMPEG_MISSING ?? (ffmpegHas("filters", "scale_vt") && ffmpegHas("encoders", "hevc_videotoolbox") ? null : "this FFmpeg has no VideoToolbox HDR path");

async function ffmpeg(args: string[]): Promise<void> {
  await run(toolPath("ffmpeg")!, ["-nostdin", "-hide_banner", "-v", "error", "-y", ...args], { timeout: 60_000 });
}

export type SyntheticMedia = "video" | "video-portrait" | "audio" | "image" | "hdr-portrait";

/** Generates a small synthetic file and returns its absolute path. */
export async function makeMedia(dir: string, kind: SyntheticMedia, name?: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"];
  const encode = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  switch (kind) {
    case "video": {
      const file = path.join(dir, name ?? "clip.mp4");
      await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=2", ...tone, ...encode, "-c:a", "aac", "-shortest", file]);
      return file;
    }
    case "video-portrait": {
      // Stored landscape with a rotation flag, as phones record portrait video.
      const coded = path.join(dir, "coded.mp4");
      await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=2", ...encode, coded]);
      const file = path.join(dir, name ?? "portrait.mp4");
      await ffmpeg(["-display_rotation", "90", "-i", coded, "-c", "copy", file]);
      return file;
    }
    case "hdr-portrait": {
      const coded = path.join(dir, "hdr-coded.mov");
      await ffmpeg([
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=2",
        "-vf", "format=p010le,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv",
        "-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-tag:v", "hvc1", "-b:v", "8M", coded,
      ]);
      const file = path.join(dir, name ?? "hdr-portrait.mov");
      await ffmpeg(["-display_rotation", "90", "-i", coded, "-c", "copy", file]);
      return file;
    }
    case "audio": {
      const file = path.join(dir, name ?? "tone.m4a");
      await ffmpeg([...tone, "-c:a", "aac", file]);
      return file;
    }
    case "image": {
      const file = path.join(dir, name ?? "logo.png");
      await ffmpeg(["-f", "lavfi", "-i", "color=c=red@0.5:size=400x200,format=rgba", "-frames:v", "1", "-update", "1", file]);
      return file;
    }
  }
}

/** ffprobe's view of a file's first video stream, for assertions. */
export async function probeVideo(file: string): Promise<Record<string, unknown> & { side_data_list?: { rotation?: number }[] }> {
  const { stdout } = await run(toolPath("ffprobe")!, ["-v", "error", "-select_streams", "v:0", "-show_streams", "-print_format", "json", file]);
  return (JSON.parse(stdout) as { streams: Record<string, unknown>[] }).streams[0] ?? {};
}

/** Presentation times, in seconds, of a file's video keyframes. */
export async function keyframeTimes(file: string): Promise<number[]> {
  const { stdout } = await run(toolPath("ffprobe")!, ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((t) => Math.round(Number.parseFloat(t) * 1000) / 1000);
}
