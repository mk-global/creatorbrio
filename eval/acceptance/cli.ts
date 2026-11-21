import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { homeFolders, redactPath } from "./redact";
import { serverSetting, type LoadedServerEnv } from "./server-env";

/**
 * The one CLI every model call of a harness run spawns (#232), and everything
 * the harness knows about it: how it is resolved, checked and re-checked, and
 * how each model call's version is shown.
 *
 * Every role shares one pinned path by design: the servers (the Director and
 * the Design Agent), the judges and the Design-Agent-only arm are all given
 * the same real file. The cross-check in `checkCliPin` compares their uses
 * all the same, so a future change that gives one role a different CLI, or a
 * different version, is refused before any spend instead of being accepted
 * because it used to be impossible.
 *
 * The harness resolves the CLI once (`resolveServerCli`), checks it
 * (`checkCliPin`) and pins it here (`pinCli`). The servers get it as
 * `CLAUDE_CLI_PATH`; the judges and the Design-Agent-only arm spawn this
 * exact real path and never look for another, so a CLI that disappears
 * mid-run fails the call instead of letting the app's discovery pick a
 * different one. The harness process's own `CLAUDE_CLI_PATH` is set to it too,
 * so anything else in this process that asks `getClaudePath()` gets the same
 * file.
 */

let pinned: string | null = null;
let previousEnv: { had: boolean; value: string | undefined } | null = null;

/** Pins `file`, an absolute real path, for every spawn in this process. */
export function pinCli(file: string): void {
  if (!path.isAbsolute(file)) throw new Error("The pinned CLI must be an absolute path");
  previousEnv ??= { had: "CLAUDE_CLI_PATH" in process.env, value: process.env.CLAUDE_CLI_PATH };
  pinned = file;
  process.env.CLAUDE_CLI_PATH = file;
}

/** Forgets the pin and restores the process's own `CLAUDE_CLI_PATH`. Only tests need it. */
export function forgetPinnedCli(): void {
  pinned = null;
  if (previousEnv) {
    if (previousEnv.had && previousEnv.value !== undefined) process.env.CLAUDE_CLI_PATH = previousEnv.value;
    else delete process.env.CLAUDE_CLI_PATH;
  }
  previousEnv = null;
}

/** The pinned CLI, or null when none was pinned. */
export const pinnedCliOrNull = (): string | null => pinned;

/** The pinned CLI. Throws when none was pinned, so a spawn never falls back to discovery. */
export function pinnedCli(): string {
  if (!pinned) throw new Error("No CLI is pinned: the harness resolves and checks CLAUDE_CLI_PATH before any model call");
  return pinned;
}

// ---------------------------------------------------------------------------
// Resolution.

export interface ServerCli {
  /**
   * The CLI's real path, links resolved, made absolute against the checkout.
   * When a configured path does not resolve it is kept as given, so the pin
   * check refuses it instead of letting the app fall back to discovery; null
   * when none is configured and discovery finds none.
   */
  path: string | null;
  source: string;
  /** `CLAUDE_CLI_PATH` names it, in the harness's environment or a `.env` file. A discovered CLI is never explicit, and never pinned. */
  explicit: boolean;
}

const realOrSelf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * The one CLI the whole run uses (#232), resolved once: the harness's own
 * `CLAUDE_CLI_PATH`, else the one the checkout's `.env` files set (`loaded`
 * is what Next.js leaves a server given the harness's environment without it),
 * else what the app's own discovery finds. A blank value names nothing, as in
 * the app. Its real path is what the servers get as `CLAUDE_CLI_PATH`, and
 * what the judges and the Design-Agent-only arm spawn, so an install that is
 * re-pointed (a link a CLI's auto-update moves) cannot change it mid-run.
 */
export function resolveServerCli(options: { root: string; loaded: Pick<LoadedServerEnv, "env" | "fileOf">; discover: () => string | null }): ServerCli {
  const configured = serverSetting(options.loaded, "CLAUDE_CLI_PATH");
  const value = configured?.value.trim();
  if (configured && value) return { path: realOrSelf(path.resolve(options.root, value)), source: `CLAUDE_CLI_PATH from ${configured.source}`, explicit: true };
  const found = options.discover();
  return { path: found ? realOrSelf(path.resolve(options.root, found)) : null, source: "the app's discovery (no CLAUDE_CLI_PATH is set)", explicit: false };
}

// ---------------------------------------------------------------------------
// The file, its version, and the pin check.

/** The size and SHA-256 of a CLI file, read in chunks (a native CLI is hundreds of megabytes). */
export interface CliFile {
  size: number;
  sha256: string;
}

/** The file's size and SHA-256; null when it is not a readable file. */
export function cliFileFacts(file: string): CliFile | null {
  let fd: number | null = null;
  try {
    if (!statSync(file).isFile()) return null;
    fd = openSync(file, "r");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    let size = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
      size += n;
    }
    return { size, sha256: hash.digest("hex") };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing more to do with a descriptor that will not close.
      }
    }
  }
}

/** One part of the run that spawns the CLI, and the CLI it spawns. */
export interface CliUse {
  role: string;
  path: string | null;
  version: string | null;
}

/** One re-check of the pinned file during the run. */
export interface CliRecheck {
  /** When it was made: a server start, or the end of the run. */
  at: string;
  ok: boolean;
  /** What differs from the pin, in words; never a path. */
  changes: string[];
}

/** The re-check made when the run ends; the Director's and the judge's versions are shown by it (`pinProof`). */
export const END_OF_RUN = "end of the run";

export interface CliPin {
  /** Every use names one existing CLI at one real path and one version, and `CLAUDE_CLI_PATH` named it rather than discovery finding it. */
  ok: boolean;
  /** `CLAUDE_CLI_PATH` named the CLI. False when only the app's discovery found it, which is never a pin. */
  explicit: boolean;
  /** Where the path came from, as a redacted label. */
  source: string;
  /** Paths redacted. */
  uses: CliUse[];
  /** The pinned file when the run was checked. Every later re-check compares with it. */
  file: CliFile | null;
  message: string;
  /** The file and its `--version`, re-checked at each server start and at the end of the run. */
  rechecks: CliRecheck[];
  /** Any re-check found a difference: the run is not comparable and is never silently accepted. */
  changed: boolean;
}

/**
 * Whether the servers (Director and Design Agent), the Design-Agent-only arm
 * and the judge use one CLI: the same real path and the same `--version`
 * line, named by `CLAUDE_CLI_PATH` and not found by discovery. A missing
 * path, an unknown version or a file that cannot be read cannot be shown to
 * match, so each refuses too. A paid run is refused before any spend when
 * this is not ok.
 */
export function checkCliPin(uses: CliUse[], options: { explicit: boolean; source: string; file: CliFile | null; home?: string | readonly string[] }): CliPin {
  const shown = uses.map((u) => ({ ...u, path: u.path ? redactPath(u.path, options.home ?? homeFolders()) : null }));
  const describe = shown.map((u) => `${u.role} ${u.path ?? "no CLI found"} (${u.version ?? "version unknown"})`).join("; ");
  const missing = uses.filter((u) => !u.path || !u.version);
  const paths = new Set(uses.map((u) => (u.path ? realOrSelf(u.path) : null)));
  const versions = new Set(uses.map((u) => u.version));
  const reasons: string[] = [];
  if (!options.explicit) reasons.push("no CLAUDE_CLI_PATH names the CLI, so it is whichever the app's discovery finds, and a discovered CLI is not pinned");
  if (uses.length === 0 || missing.length > 0) reasons.push("a CLI is missing or its version is unknown");
  if (paths.size > 1) reasons.push("the uses do not share one real path");
  if (versions.size > 1) reasons.push("the uses do not share one version");
  if (!options.file) reasons.push("the CLI file could not be read for its size and SHA-256");
  const ok = reasons.length === 0;
  return {
    ok,
    explicit: options.explicit,
    source: options.source,
    uses: shown,
    file: options.file,
    message: ok
      ? `CLI pinned: every model call uses ${shown[0].path} (${shown[0].version}), named by ${options.source}.`
      : `Refusing a paid run before any spend: the CLI is not pinned (${reasons.join("; ")}): ${describe}. Run the harness with CLAUDE_CLI_PATH=<one installed CLI> in its environment.`,
    rechecks: [],
    changed: false,
  };
}

/** The version number in a `--version` line such as `2.1.3 (Claude Code)`, or null. */
export function versionNumber(line: string | null): string | null {
  return line?.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0] ?? null;
}

/** The CLI's own `--version` line (no model is involved), or null. */
export function cliVersion(cliPath: string | null, env: NodeJS.ProcessEnv): string | null {
  if (!cliPath || !existsSync(cliPath)) return null;
  try {
    const out = execFileSync(cliPath, ["--version"], { env, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return out.split(/\r?\n/)[0].trim().slice(0, 120) || null;
  } catch {
    return null;
  }
}

/**
 * Checks that the pinned file still exists with the size and SHA-256 it had
 * when the run began and still reports the same `--version` line. Run at each
 * server start and at the end of the run; no model is involved.
 */
export function recheckCli(pin: { path: string; file: CliFile; version: string }, at: string, env: NodeJS.ProcessEnv): CliRecheck {
  const changes: string[] = [];
  const facts = cliFileFacts(pin.path);
  if (!facts) changes.push("the file no longer exists or cannot be read");
  else {
    if (facts.size !== pin.file.size) changes.push(`size changed from ${pin.file.size} to ${facts.size} bytes`);
    if (facts.sha256 !== pin.file.sha256) changes.push("SHA-256 changed");
  }
  const version = facts ? cliVersion(pin.path, env) : null;
  if (version !== pin.version) changes.push(`--version changed from "${pin.version}" to ${version === null ? "unknown" : `"${version}"`}`);
  return { at, ok: changes.length === 0, changes };
}

/** Records a re-check on the pin and flags the run when it found a difference. */
export function recordRecheck(pin: CliPin, recheck: CliRecheck): CliRecheck {
  pin.rechecks.push(recheck);
  if (!recheck.ok) pin.changed = true;
  return recheck;
}

// ---------------------------------------------------------------------------
// How a model call's version is shown when it keeps no transcript.

/**
 * How the version of a model call that keeps no transcript is shown. The
 * Director's CLI and the judge's both run with `--no-session-persistence`, so
 * neither can be read from a transcript: each is shown by the resolved pin
 * plus the file re-checks, the last at the end of the run (#232).
 */
export interface PinProof {
  method: string;
  /** The version the pin recorded, from `--version`. */
  version: string | null;
  /** The pin held (one explicit CLI, no re-check found a difference) and the re-check at the end of the run was made. */
  proven: boolean;
}

export const DIRECTOR_PROOF_METHOD =
  "not read from a transcript: the Director runs with --no-session-persistence, so its CLI keeps none; its version is shown by the resolved pin, the one real CLI file its server is given as CLAUDE_CLI_PATH, re-checked by size, SHA-256 and --version at every server start and at the end of the run";

export const JUDGE_PROOF_METHOD =
  "not read from a transcript: the judge runs with --no-session-persistence, so its CLI keeps none; its version is shown by the resolved pin, the one real CLI file the harness spawns for it, re-checked by size, SHA-256 and --version at every server start and at the end of the run";

function pinProof(method: string, pin: CliPin, configuredLine: string | null): PinProof {
  const atEnd = pin.rechecks.some((r) => r.at === END_OF_RUN);
  return { method, version: versionNumber(configuredLine), proven: pin.ok && pin.explicit && !pin.changed && atEnd };
}

export const directorProof = (pin: CliPin, configuredLine: string | null): PinProof => pinProof(DIRECTOR_PROOF_METHOD, pin, configuredLine);
export const judgeProof = (pin: CliPin, configuredLine: string | null): PinProof => pinProof(JUDGE_PROOF_METHOD, pin, configuredLine);
