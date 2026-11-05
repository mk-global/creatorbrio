/**
 * FFmpeg and ffprobe for the media registry: where they are, and how they are
 * run. They run as separate processes (never through a shell), with a
 * deadline, bounded captured output and an abort signal, so a bad file or a
 * stuck decoder cannot hold a request or a job forever.
 *
 * Every launch goes through cross-spawn, as the Visual Director's does: a
 * direct `child_process` call with a program path computed at run time makes
 * the Next.js build trace the whole project. On macOS and Linux it is a plain
 * spawn without a shell.
 *
 * Discovery: `CREATORBRIO_FFMPEG` / `CREATORBRIO_FFPROBE` when set (an
 * absolute path), else the usual install locations, else the absolute
 * folders on `PATH`. Tools always run by absolute path.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import crossSpawn from "cross-spawn";

export type Tool = "ffmpeg" | "ffprobe";

const ENV: Record<Tool, string> = { ffmpeg: "CREATORBRIO_FFMPEG", ffprobe: "CREATORBRIO_FFPROBE" };
const DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const resolved = new Map<Tool, string | null>();

/** The tool's executable as an absolute path, or null when it is not installed. */
export function toolPath(tool: Tool): string | null {
  if (resolved.has(tool)) return resolved.get(tool)!;
  const fromEnv = process.env[ENV[tool]];
  const dirs = [...DIRS, ...(process.env.PATH ?? "").split(path.delimiter)].filter((dir) => path.isAbsolute(dir));
  const candidates = fromEnv ? [fromEnv].filter((file) => path.isAbsolute(file)) : [...new Set(dirs)].map((dir) => path.join(/*turbopackIgnore: true*/ dir, tool));
  let found: string | null = null;
  for (const candidate of candidates) {
    // Runtime lookups, not build input: the ignore comments stop Next.js tracing the whole project.
    if (!existsSync(/*turbopackIgnore: true*/ candidate)) continue;
    const probe = crossSpawn.sync(candidate, ["-version"], { stdio: "ignore", timeout: 5000 });
    if (probe.status === 0) {
      found = candidate;
      break;
    }
  }
  resolved.set(tool, found);
  return found;
}

/**
 * The oldest FFmpeg release that has every option the pipeline uses
 * (`-display_rotation` arrived in 6.0, `-fps_mode` in 5.1). Tested so far
 * with 9.0.2 only.
 */
export const MIN_FFMPEG = { major: 6, minor: 0 };

/** The installed FFmpeg's release, or null for an unnumbered (development) build or none. */
let version: { major: number; minor: number } | null | undefined;
export function ffmpegVersion(): { major: number; minor: number } | null {
  if (version !== undefined) return version;
  const ffmpeg = toolPath("ffmpeg");
  const banner = ffmpeg ? crossSpawn.sync(ffmpeg, ["-version"], { encoding: "utf-8", timeout: 5000 }).stdout ?? "" : "";
  const match = /^ffmpeg version n?(\d+)\.(\d+)/m.exec(String(banner));
  version = match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
  return version;
}

/** False only for a numbered release older than MIN_FFMPEG. */
export function ffmpegRecentEnough(): boolean {
  const v = ffmpegVersion();
  return !v || v.major > MIN_FFMPEG.major || (v.major === MIN_FFMPEG.major && v.minor >= MIN_FFMPEG.minor);
}

/** Whether this FFmpeg can encode or filter with a named component (cached). */
const capabilities = new Map<string, boolean>();
export function ffmpegHas(kind: "encoders" | "filters", name: string): boolean {
  const key = `${kind}:${name}`;
  if (capabilities.has(key)) return capabilities.get(key)!;
  const ffmpeg = toolPath("ffmpeg");
  let has = false;
  if (ffmpeg) {
    const listing = crossSpawn.sync(ffmpeg, ["-hide_banner", `-${kind}`], { encoding: "utf-8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    has = new RegExp(`\\s${name}\\s`).test(listing.stdout ?? "");
  }
  capabilities.set(key, has);
  return has;
}

/**
 * An absolute path as an FFmpeg input or output. The `file:` protocol prefix
 * stops a name being read as another protocol or as an option.
 */
export function fileUrl(absolutePath: string): string {
  if (!absolutePath.startsWith("/")) throw new Error("media tool paths must be absolute");
  return `file:${absolutePath}`;
}

export class ToolError extends Error {
  constructor(
    readonly reason: "missing" | "timeout" | "aborted" | "failed",
    message: string,
    readonly exitCode: number | null = null
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export interface RunOptions {
  timeoutMs: number;
  /** Bytes of stdout kept; more is an error. stderr keeps only its tail. */
  maxStdout?: number;
  signal?: AbortSignal;
  /** Receives stdout as it arrives instead of keeping it; `maxStdout` still bounds the total. */
  onStdout?: (chunk: Buffer) => void;
}

/** Runs a tool to completion. Resolves with stdout and the tail of stderr; rejects with a ToolError. */
export function runTool(tool: Tool, args: string[], options: RunOptions): Promise<{ stdout: string; stderrTail: string }> {
  const executable = toolPath(tool);
  if (!executable) return Promise.reject(new ToolError("missing", `${tool} is not installed`));
  const maxStdout = options.maxStdout ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = crossSpawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errTail = "";
    let settled = false;
    const finish = (error: ToolError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else {
        resolve({ stdout: Buffer.concat(out).toString("utf-8"), stderrTail: errTail });
      }
    };
    const timer = setTimeout(() => finish(new ToolError("timeout", `${tool} did not finish within ${options.timeoutMs} ms`)), options.timeoutMs);
    const onAbort = () => finish(new ToolError("aborted", `${tool} was cancelled`));
    if (options.signal?.aborted) return finish(new ToolError("aborted", `${tool} was cancelled`));
    options.signal?.addEventListener("abort", onAbort);
    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) return finish(new ToolError("failed", `${tool} produced more output than expected`));
      if (options.onStdout) options.onStdout(chunk);
      else out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errTail = (errTail + chunk.toString("utf-8")).slice(-2000);
    });
    child.on("error", () => finish(new ToolError("failed", `${tool} could not be started`)));
    child.on("close", (code) => {
      if (code === 0) finish(null);
      else finish(new ToolError("failed", `${tool} exited with code ${code}`, code));
    });
  });
}
