/**
 * The waveform peaks (#144) sit at the same file time as the sound the
 * export plays. A video whose audio stream starts after the file does used to
 * get peaks that began at the stream's first sample, so the Studio waveform
 * would sit early against the exported sound. Skipped where FFmpeg is
 * missing (CI, #142).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probeFile } from "@/lib/video/media/facts";
import { buildDerived } from "@/lib/video/media/proxy";
import type { MediaRecord } from "@/lib/video/media/registry";
import { fileUrl, toolPath } from "@/lib/video/media/tools";
import { FFMPEG_MISSING } from "./helpers/media-fixtures";

const run = promisify(execFile);
/** A 30 ms 1 kHz beep at the start of every second of the stream. */
const BEEPS = "aevalsrc=exprs='if(lt(mod(t\\,1)\\,0.03)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:d=4";

describe.skipIf(FFMPEG_MISSING)(`waveform peaks timing${FFMPEG_MISSING ? ` (skipped: ${FFMPEG_MISSING})` : ""}`, () => {
  let dir: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "cb-peaks-")));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("places the peaks of an audio stream that starts late at its file time", { timeout: 60_000 }, async () => {
    // The picture starts at 0 and the sound 0.5 s later, so the beeps are at file times 0.5, 1.5, 2.5 and 3.5 s.
    const file = path.join(dir, "late.mp4");
    await run(toolPath("ffmpeg")!, [
      "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=30:d=4", "-itsoffset", "0.5", "-f", "lavfi", "-i", BEEPS,
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ac", "2", fileUrl(file),
    ]);
    const facts = await probeFile(file);
    const record: MediaRecord = {
      version: 1,
      mediaId: "a".repeat(64),
      kind: "video",
      originalName: "late.mp4",
      extension: ".mp4",
      sizeBytes: 1,
      importedAt: "2026-11-06T00:00:00.000Z",
      facts,
      provenance: { source: "local-file", rights: "user-supplied" },
    };
    const out = await mkdtemp(path.join(dir, "derived-"));
    await buildDerived(record, file, out, new AbortController().signal);
    const { peaksPerSecond, peaks } = JSON.parse(await readFile(path.join(out, "peaks.json"), "utf-8")) as { peaksPerSecond: number; peaks: number[] };

    // Where each beep starts, in seconds of file time.
    const onsets: number[] = [];
    peaks.forEach((value, i) => {
      if (value > 64 && !(peaks[i - 1] > 64)) onsets.push(i / peaksPerSecond);
    });
    expect(onsets).toHaveLength(4);
    onsets.forEach((at, k) => expect(Math.abs(at - (0.5 + k))).toBeLessThanOrEqual(0.02));
  });
});
