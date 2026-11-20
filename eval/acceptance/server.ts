import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Starts and stops a real CreatorBrio server for the acceptance harness.
 * Only the harness ports are ever used, a port that is already taken is never
 * touched, and the server runs from this checkout with its own data folder.
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HARNESS_PORTS = [3417, 3418, 3419, 3420] as const;
export type HarnessPort = (typeof HARNESS_PORTS)[number];
export type ServerMode = "prod" | "dev";

const READY_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 5_000;

let runName: string | null = null;
let runDirectory: string | null = null;

/** This harness run's id, `acceptance-<timestamp>`: its results folder's name, ledger run id and archive folder. */
export function runId(): string {
  runName ??= `acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return runName;
}

/** This harness run's results folder, created on first use. */
export function runDir(): string {
  if (!runDirectory) {
    runDirectory = path.join(ROOT, "eval", "results", runId());
    mkdirSync(runDirectory, { recursive: true });
  }
  return runDirectory;
}

/**
 * The environment a user's own terminal would give the app: this session's
 * Claude Code variables (session identity, messaging socket) are removed so
 * the agents the server spawns are ordinary top-level CLI runs, and a fake
 * CLI path left over from a test can never be picked up.
 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...cleanEnvFrom(process.env), ...extra } as NodeJS.ProcessEnv;
}

function cleanEnvFrom(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CLI_PATH|IMAGE_SERVICE_URL)$/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export interface RunningServer {
  origin: string;
  port: HarnessPort;
  mode: ServerMode;
  logPath: string;
  startedAt: number;
  readyMs: number;
  /** Stops the whole process group: `first` (default SIGTERM), then SIGKILL after 5 s. */
  stop(first?: NodeJS.Signals): Promise<void>;
}

export interface StartOptions {
  mode: ServerMode;
  port: HarnessPort;
  /** The CLI the server's Director and Design Agent spawn, given explicitly (#232). */
  cliPath: string;
  env?: Record<string, string>;
}

/** The `NODE_ENV` Next.js expects for each mode; `test`, which the test runner sets, makes it skip `.env.local`. */
export const SERVER_NODE_ENV: Record<ServerMode, "production" | "development"> = { prod: "production", dev: "development" };

/**
 * The environment a harness server starts with (#232): the clean environment,
 * `NODE_ENV` matching its mode, so Next.js loads `.env.local` as the app does
 * in normal use, and `CLAUDE_CLI_PATH` set to the CLI the harness pinned,
 * which takes precedence over any `.env` file. `extra` (the image service
 * address and the per-call caps) is applied last but cannot change either.
 */
export function serverEnvironment(options: { mode: ServerMode; cliPath: string; extra?: Record<string, string>; base?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  return {
    ...cleanEnvFrom(options.base ?? process.env),
    ...options.extra,
    NODE_ENV: SERVER_NODE_ENV[options.mode],
    CLAUDE_CLI_PATH: options.cliPath,
  } as NodeJS.ProcessEnv;
}

export async function startServer({ mode, port, cliPath, env = {} }: StartOptions): Promise<RunningServer> {
  if (!HARNESS_PORTS.includes(port)) throw new Error(`Port ${port} is not a harness port`);
  if (await portInUse(port)) throw new Error(`Port ${port} is already in use; the harness never stops a process it did not start`);
  if (mode === "prod" && !existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    throw new Error("No production build: run `npm run build` in this checkout first");
  }

  const logPath = path.join(runDir(), `server-${port}.log`);
  // Appended, so a restarted server continues the same log.
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} starting next ${mode === "prod" ? "start" : "dev"} on ${port} ---\n`);

  const args = mode === "prod" ? ["next", "start", "-H", "127.0.0.1", "-p", String(port)] : ["next", "dev", "-H", "127.0.0.1", "-p", String(port)];
  const child: ChildProcess = spawn("npx", args, {
    cwd: ROOT,
    env: serverEnvironment({ mode, cliPath, extra: env }),
    // Its own process group, so stop() also ends the Next worker and any agent it spawned.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });

  const origin = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  while (true) {
    if (exited) throw new Error(`Server on ${port} exited before it was ready; see ${logPath}`);
    if (Date.now() - startedAt > READY_TIMEOUT_MS) {
      await killGroup(child, exitPromise, () => exited);
      throw new Error(`Server on ${port} was not ready after ${READY_TIMEOUT_MS / 1000} s`);
    }
    try {
      const res = await fetch(`${origin}/`, { signal: AbortSignal.timeout(30_000) });
      await res.arrayBuffer();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const readyMs = Date.now() - startedAt;

  let stopped = false;
  return {
    origin,
    port,
    mode,
    logPath,
    startedAt,
    readyMs,
    async stop(first: NodeJS.Signals = "SIGTERM") {
      if (stopped) return;
      stopped = true;
      await killGroup(child, exitPromise, () => exited, first);
      log.write(`--- ${new Date().toISOString()} stopped ---\n`);
      await new Promise<void>((resolve) => log.end(resolve));
    },
  };
}

async function killGroup(
  child: ChildProcess,
  exitPromise: Promise<void>,
  hasExited: () => boolean,
  first: NodeJS.Signals = "SIGTERM"
) {
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      // The group is already gone.
    }
  };
  signal(first);
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, STOP_GRACE_MS))]);
  // The group may outlive its leader (the Next worker), so it is always killed.
  signal("SIGKILL");
  if (!hasExited()) await Promise.race([exitPromise, new Promise((r) => setTimeout(r, STOP_GRACE_MS))]);
}
