/**
 * The built app, started for a browser test (#150). It runs `next start` from
 * a temporary folder that links in this checkout's build, `node_modules`,
 * `public` and configuration, so its `data/` folder is the test's own and no
 * real data is touched. The server's PATH holds only Node, FFmpeg and
 * ffprobe, so it cannot find a Claude CLI: what the test does works without
 * one. `restart()` stops the server and starts it again over the same data.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { toolPath } from "@/lib/video/media/tools";

const ROOT = path.resolve(__dirname, "../..");
const LINKED = [".next", "node_modules", "public", "package.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs"];

/** The newest modification time under `dir`, in ms. */
function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
  }
  return latest;
}

/** Why the built app cannot be used, or null: no build, or a build older than the sources it was made from. */
export function builtAppMissing(): string | null {
  const buildId = path.join(ROOT, ".next", "BUILD_ID");
  if (!existsSync(buildId)) return "no production build (run npm run build)";
  const built = statSync(buildId).mtimeMs;
  const sources = Math.max(newest(path.join(ROOT, "src")), statSync(path.join(ROOT, "next.config.ts")).mtimeMs, statSync(path.join(ROOT, "package-lock.json")).mtimeMs);
  return sources > built ? "the production build is older than the sources (run npm run build)" : null;
}

export interface BuiltApp {
  url: string;
  dataDir: string;
  /** Absolute folder outside the app for test media. */
  scratch: string;
  restart(): Promise<void>;
  stop(): Promise<void>;
  /** The end of the server's output, for a failure message. */
  logTail(chars?: number): string;
}

async function waitForReady(url: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited with ${child.exitCode}: ${log().slice(-2000)}`);
    try {
      const res = await fetch(`${url}/studio`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the app did not start: ${log().slice(-2000)}`);
}

/**
 * `chromium` is the browser the overlay renderer uses for exports, given the
 * way an operator would (`PUPPETEER_EXECUTABLE_PATH`): the server's HOME is
 * empty, so it has no browser cache of its own.
 *
 * `claudeStub` gives the server a Claude CLI (`CLAUDE_CLI_PATH`) that refuses
 * every call, so screens look as they do on a set-up computer while no design
 * run can ever start or cost anything.
 */
export async function startBuiltApp(port: number, options: { chromium?: string; claudeStub?: boolean } = {}): Promise<BuiltApp> {
  const workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-studio-e2e-")));
  const appDir = path.join(workdir, "app");
  const scratch = path.join(workdir, "media");
  await mkdir(appDir);
  await mkdir(scratch);
  for (const name of LINKED) if (existsSync(path.join(ROOT, name))) await symlink(path.join(ROOT, name), path.join(appDir, name));

  // Only Node and the media tools: no Claude CLI can be found from here.
  const bin = path.join(workdir, "bin");
  await mkdir(bin);
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    const found = toolPath(tool);
    if (found) await symlink(found, path.join(bin, tool));
  }
  await symlink(process.execPath, path.join(bin, "node"));
  const home = path.join(workdir, "home");
  await mkdir(home);
  const env: NodeJS.ProcessEnv = { PATH: bin, HOME: home, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ...(options.chromium ? { PUPPETEER_EXECUTABLE_PATH: options.chromium } : {}) };
  if (options.claudeStub) {
    const stub = path.join(workdir, "claude-stub");
    await writeFile(stub, '#!/bin/sh\necho "test stub: no design runs in tests" >&2\nexit 97\n');
    await chmod(stub, 0o755);
    env.CLAUDE_CLI_PATH = stub;
  }

  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let output = "";
  const start = async () => {
    output = "";
    const started = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
    child = started;
    started.stdout!.on("data", (d) => (output += d));
    started.stderr!.on("data", (d) => (output += d));
    await waitForReady(url, started, () => output);
  };
  const stopChild = async () => {
    const c = child as ChildProcess | null;
    if (!c || c.exitCode !== null) return;
    const exited = new Promise((r) => c.once("exit", r));
    c.kill("SIGTERM");
    const timer = setTimeout(() => c.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  };

  await start();
  return {
    url,
    dataDir: path.join(appDir, "data"),
    scratch,
    restart: async () => {
      await stopChild();
      await start();
    },
    stop: async () => {
      await stopChild();
      await rm(workdir, { recursive: true, force: true });
    },
    logTail: (chars = 4000) => output.slice(-chars),
  };
}
