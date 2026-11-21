import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * The environment a server the harness starts holds once Next.js has loaded
 * the checkout's `.env` files (#232), taken from Next.js's own loader rather
 * than from a parser of the harness's own: `@next/env`'s `loadEnvConfig` runs
 * in a child process that is given the environment the server is spawned
 * with, and what it leaves is what the servers, and the Design-Agent-only
 * arm, see, except for what Next.js itself adds to a running server
 * (`NEXT_ADDED_TO_SERVER`: the names measured in a started `next start`
 * server of the installed Next.js, and `__NEXT_PROCESSED_ENV`, which the
 * loader sets; `next dev` adds more).
 *
 * Only names are ever recorded, never values. The loaded values stay in
 * memory, for the arm's environment and the product's own reading of the
 * Design Agent's settings.
 */

export type EnvMode = "prod" | "dev";

/**
 * What Next.js itself adds to a running server's environment, so that a
 * server's own environment has these names and the arm's does not. Seven were
 * measured in a started `next start` server of the installed Next.js
 * (16.4.5), by listing its process environment against the one it was spawned
 * with; `__NEXT_PROCESSED_ENV` is set by `@next/env` once it has loaded the
 * files (read in its code, not seen in the measurement), and `loadServerEnv`
 * leaves it out with every other `__NEXT_` name.
 * The list is what was found, not a promise that nothing else is added:
 * `next dev` adds more, which is one more reason a paid dev run is refused.
 */
export const NEXT_ADDED_TO_SERVER: readonly string[] = [
  "NEXT_DEPLOYMENT_ID",
  "NEXT_PRIVATE_START_TIME",
  "NEXT_RUNTIME",
  "PORT",
  "RUST_MIN_STACK",
  "TURBOPACK",
  "__NEXT_PRIVATE_ORIGIN",
  "__NEXT_PROCESSED_ENV",
];

/** The `.env` files Next.js reads for a server in `mode`, highest precedence first. `NODE_ENV=test` makes it read the test set and skip `.env.local`. */
export function envFileNames(mode: EnvMode, nodeEnv: string | undefined): string[] {
  const d = nodeEnv === "test" ? "test" : mode === "dev" ? "development" : "production";
  return [`.env.${d}.local`, ...(d !== "test" ? [".env.local"] : []), `.env.${d}`, ".env"];
}

/**
 * The variables a server's `.env` files may add beyond the harness's
 * environment, each chosen by name (#232). Everything else is refused, not
 * by a pattern: an unknown variable could carry a credential, an endpoint (a
 * proxy, gateway, socket or model catalogue), another configuration folder,
 * `NODE_OPTIONS`, a delegated session or a token limit into every model call
 * (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
 * `MAX_THINKING_TOKENS` could let one call overshoot the allowance the run
 * reserved), and the record could not show it. The `DESIGN_AGENT_*` and
 * `DIRECTOR_*` names are the ones `src/` reads, and nothing more.
 * `CLAUDE_CODE_EFFORT_LEVEL` is not allowed either: `src/` never reads it and
 * it can raise one turn's thinking past that allowance.
 */
export const SERVER_ENV_ALLOWLIST: readonly { name: string; why: string }[] = [
  { name: "CLAUDE_CLI_PATH", why: "names the CLI; a file's value is resolved to a real path and pinned by the harness, which gives that path to the servers explicitly, so they never read the file's value directly" },
  { name: "DISABLE_AUTOUPDATER", why: "keeps the CLI from replacing itself during a run" },
  { name: "DESIGN_AGENT_MAX_BUDGET_USD", why: "the Design Agent's spending cap, which src/lib/design-agent.ts reads; the harness sets it" },
  { name: "DESIGN_AGENT_TIMEOUT_SECONDS", why: "the Design Agent's absolute deadline, which src/lib/design-agent.ts reads and the harness sizes its timeouts from" },
  { name: "DESIGN_AGENT_INACTIVITY_SECONDS", why: "the Design Agent's inactivity limit, which src/lib/design-agent.ts reads" },
  { name: "DIRECTOR_MAX_BUDGET_USD", why: "the Director's spending cap, which src/lib/visual-director.ts reads; the harness sets it" },
  { name: "IMAGE_SERVICE_URL", why: "the image service address; the harness overrides it with its own loopback address" },
  { name: "ANTHROPIC_MODEL", why: "selects the model; recorded by name and value hash" },
  { name: "ANTHROPIC_SMALL_FAST_MODEL", why: "selects the small model; recorded by name and value hash" },
  { name: "ANTHROPIC_DEFAULT_OPUS_MODEL", why: "selects the model behind the opus alias; recorded by name and value hash" },
  { name: "ANTHROPIC_DEFAULT_SONNET_MODEL", why: "selects the model behind the sonnet alias; recorded by name and value hash" },
  { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", why: "selects the model behind the haiku alias; recorded by name and value hash" },
  { name: "CLAUDE_CODE_SUBAGENT_MODEL", why: "selects the sub-agent model; recorded by name and value hash" },
];

const ALLOWED = new Set(SERVER_ENV_ALLOWLIST.map((a) => a.name));
export const isAllowedServerVariable = (name: string): boolean => ALLOWED.has(name);

export interface ServerEnvFile {
  /** A redacted label such as `<project>/.env.local`. */
  file: string;
  /** `file`: a regular file, hashed. `absent`: nothing there. `directory`: Next.js skips it. `other`: a socket or a pipe, which the harness refuses. */
  state: "file" | "absent" | "directory" | "other";
  /** SHA-256 of the file's bytes; null unless a regular file. */
  sha256: string | null;
}

/** A line of a loaded file that the loader's result does not account for: its position and why, never its content or name. */
export interface UnaccountedLine {
  file: string;
  line: number;
  reason: string;
}

/** One re-check of the loaded files during the run. */
export interface EnvFilesRecheck {
  /** When it was made: a server start, or the end of the run. */
  at: string;
  ok: boolean;
  /** What differs, by file label; never any content. */
  changes: string[];
}

export interface ServerEnvFiles {
  /** The files the loader reads for this mode, as they were when checked. They are re-checked at every server start and at the end of the run. */
  files: ServerEnvFile[];
  /** Variables the files add beyond the harness's environment: names and the file that sets them, never values. */
  added: { name: string; file: string }[];
  /** The added names that are not on the allowlist. A paid run is refused when there is one. */
  refused: string[];
  /** Lines the loader's result does not account for. A paid run is refused when there is one. */
  unaccounted: UnaccountedLine[];
  /** Set when the loader could not be run or a file could not be read; a paid run is refused. */
  loaderError: string | null;
  /** The allowed names. */
  allowlist: string[];
  ok: boolean;
  /** The full text of why a paid run is refused (or that the files are fine): it names the variables the files add. For the operator's own terminal and results.json, which is never committed. */
  message: string;
  /**
   * `message` without any variable name that is not on the allowlist (those are counted), for text that may be committed or pasted: a dry run's output.
   * Absent on a record that was not built by `loadServerEnv`; use `printableMessage`.
   */
  printable?: string;
  rechecks: EnvFilesRecheck[];
  /** Any re-check found a difference: the run is not comparable and a server does not start. */
  changed: boolean;
}

/** What a server's process environment holds once Next.js has loaded the files, with the record of what was loaded. */
export interface LoadedServerEnv {
  /** The environment the server and its Design Agent see; in memory only, never recorded. Next.js's own `__NEXT_` markers are left out. */
  env: NodeJS.ProcessEnv;
  /** For each name a file added, the file that set it: the first in Next.js's precedence order. */
  fileOf: ReadonlyMap<string, string>;
  record: ServerEnvFiles;
}

const label = (file: string) => `<project>/${file}`;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** What each candidate file is right now. A file that is not a plain file is never read here. */
export function hashEnvFiles(root: string, names: string[]): ServerEnvFile[] {
  return names.map((name) => {
    const file = label(name);
    try {
      const st = statSync(path.join(root, name));
      if (st.isDirectory()) return { file, state: "directory" as const, sha256: null };
      if (!st.isFile()) return { file, state: "other" as const, sha256: null };
      return { file, state: "file" as const, sha256: sha256(readFileSync(path.join(root, name))) };
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR"
        ? { file, state: "absent" as const, sha256: null }
        : { file, state: "other" as const, sha256: null };
    }
  });
}

/**
 * dotenv's own assignment pattern, as the loader Next.js ships uses it
 * (`@next/env`, dotenv 16.3.1). It is used only to find where each
 * assignment lies in a file, so that every line can be accounted for; the
 * names and values come from the loader itself, and a name this pattern finds
 * that the loader did not load leaves its lines unaccounted for, so a loader
 * that changes its mind is refused rather than trusted.
 */
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
/** A line that reads like the start of an assignment. */
const ASSIGNMENT_LOOKING = /^\s*(?:export\s+)?[\w.-]+\s*[=:]/;

/**
 * The lines of a file that are neither blank, a comment, nor part of an
 * assignment the loader loaded (`loaded` holds the names it loaded from this
 * file). A line inside a multi-line value that reads like an assignment is
 * reported too: it was swallowed by the value, so no variable was set from
 * it, which is not what its author can have meant. 1-based line numbers.
 */
export function unaccountedLines(contents: string, loaded: ReadonlySet<string>): { line: number; reason: string }[] {
  const text = contents.replace(/\r\n?/gm, "\n");
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const lineAt = (at: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const accounted = lines.map(() => false);
  const swallowed = new Set<number>();
  for (const m of text.matchAll(new RegExp(DOTENV_LINE.source, "gm"))) {
    if (!loaded.has(m[1])) continue;
    const nameAt = m.index + /^\s*(?:export\s+)?/.exec(m[0])![0].length;
    const endAt = m.index + m[0].replace(/\s+$/, "").length;
    const first = lineAt(nameAt);
    const last = lineAt(Math.max(nameAt, endAt - 1));
    for (let i = first; i <= last; i++) accounted[i] = true;
    for (let i = first + 1; i <= last; i++) if (ASSIGNMENT_LOOKING.test(lines[i])) swallowed.add(i);
  }
  const out: { line: number; reason: string }[] = [];
  lines.forEach((l, i) => {
    if (/^\s*$/.test(l) || /^\s*#/.test(l)) return;
    if (swallowed.has(i)) out.push({ line: i + 1, reason: "inside a multi-line value, but reads like an assignment that was not made" });
    else if (!accounted[i]) out.push({ line: i + 1, reason: "not an assignment the loader reads" });
  });
  return out;
}

/** Runs in the child: Next.js's loader over `dir`, with the environment the server will have. */
const LOADER_SCRIPT = `
const nextEnv = require(process.argv[1]);
const errors = [];
const { parsedEnv, loadedEnvFiles } = nextEnv.loadEnvConfig(process.argv[2], process.argv[3] === "dev", { info() {}, error() { errors.push(1); } });
process.stdout.write(JSON.stringify({
  env: process.env,
  added: Object.keys(parsedEnv ?? {}),
  files: loadedEnvFiles.map((f) => ({ path: f.path, contents: f.contents, names: Object.keys(f.env ?? {}) })),
  errors: errors.length,
}));
`;

/** Resolves `@next/env` from this checkout, whatever folder is being loaded. */
const requireFromHere = createRequire(import.meta.url);
const LOADER_TIMEOUT_MS = 30_000;

interface LoaderOutput {
  env: Record<string, string>;
  added: string[];
  files: { path: string; contents: string; names: string[] }[];
  errors: number;
}

/** The loader's output was not what it writes: not JSON, or not the shape of `LoaderOutput`. */
class LoaderOutputError extends Error {}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function parseLoaderOutput(text: string): LoaderOutput {
  const out = JSON.parse(text) as Partial<LoaderOutput> | null;
  const env = out?.env;
  const valid =
    !!out &&
    !!env &&
    typeof env === "object" &&
    !Array.isArray(env) &&
    Object.values(env).every((v) => typeof v === "string") &&
    isStrings(out.added) &&
    Array.isArray(out.files) &&
    out.files.every((f) => !!f && typeof f.path === "string" && typeof f.contents === "string" && isStrings(f.names)) &&
    typeof out.errors === "number";
  if (!valid) throw new LoaderOutputError("shape");
  return out as LoaderOutput;
}

/**
 * Why the loader failed, as a fixed string and never any text of the failure:
 * an error message or the loader's own output can hold a path, an account name
 * or part of a file. The classes are a timeout, a non-zero exit (with its
 * code), a module that was not found, output that was not valid, and anything
 * else, which is that the loader did not run.
 */
export function classifyLoaderFailure(err: unknown): string {
  if (err instanceof LoaderOutputError || err instanceof SyntaxError) return "the loader's output was not valid";
  const e = (err ?? {}) as { code?: unknown; status?: unknown };
  if (e.code === "ETIMEDOUT") return "the loader timed out";
  if (e.code === "MODULE_NOT_FOUND") return "the loader's module (@next/env) was not found";
  if (typeof e.status === "number") return `the loader exited with code ${e.status}`;
  return "the loader did not run";
}

function runLoader(root: string, mode: EnvMode, env: Record<string, string | undefined>): LoaderOutput {
  const clean = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const out = execFileSync(process.execPath, ["-e", LOADER_SCRIPT, requireFromHere.resolve("@next/env"), root, mode], {
    env: clean as NodeJS.ProcessEnv,
    timeout: LOADER_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
  return parseLoaderOutput(out);
}

const sameFiles = (a: ServerEnvFile[], b: ServerEnvFile[]) => a.length === b.length && a.every((f, i) => f.file === b[i].file && f.state === b[i].state && f.sha256 === b[i].sha256);

/**
 * The names the files added, split for text that may be committed or pasted
 * (summary.md, a dry run): the names on the allowlist, which are fixed strings
 * of this source, with their file, and the count of every other name, which
 * came from the operator's machine and can carry an organization, project or
 * machine detail. The full names are in results.json, which is never committed.
 */
export function splitAddedNames(record: Pick<ServerEnvFiles, "added" | "refused">): { named: { name: string; file: string }[]; notAllowed: number } {
  const named = record.added.filter((v) => isAllowedServerVariable(v.name));
  const notAllowed = new Set([...record.added.filter((v) => !isAllowedServerVariable(v.name)).map((v) => v.name), ...record.refused]).size;
  return { named, notAllowed };
}

/** `message` when the record has no printable form (a record that was not built by `loadServerEnv`, which holds no name that needs hiding). */
export const printableMessage = (record: ServerEnvFiles): string => record.printable ?? record.message;

function build(record: Omit<ServerEnvFiles, "ok" | "message" | "printable" | "rechecks" | "changed">, loaderNotRun = false): ServerEnvFiles {
  const split = splitAddedNames(record);
  // `printable` leaves out every name that is not on the allowlist, which is counted instead.
  const compose = (printable: boolean) => {
    const names = printable
      ? `${split.named.map((v) => v.name).join(", ") || "none"}${split.notAllowed ? `; ${split.notAllowed} not on the allowlist, counted and not named` : ""}`
      : record.added.map((v) => v.name).join(", ") || "none";
    const problems: string[] = [];
    const advice: string[] = [];
    if (record.loaderError) {
      problems.push(`the .env files could not be loaded as Next.js loads them (${record.loaderError})`);
      advice.push(
        loaderNotRun
          ? "Reinstall the dependencies (npm ci) so that Next.js's loader runs, then run the harness again."
          : "Correct or remove the .env file the problem names, then run the harness again."
      );
    }
    if (record.unaccounted.length) {
      const where = record.unaccounted.map((u) => `${u.file} line ${u.line} (${u.reason})`).join("; ");
      problems.push(`lines the loader's result does not account for, so what the servers see cannot be shown: ${where}`);
      advice.push("Correct or remove those lines so that the loader reads them as assignments.");
    }
    if (record.refused.length) {
      problems.push(
        printable
          ? `${split.notAllowed} variable(s) the harness does not allow, not named here (all added: ${names})`
          : `variables the harness does not allow: ${record.refused.join(", ")} (all added: ${names})`
      );
      advice.push(
        `An unknown variable could carry a credential, endpoint, proxy, configuration folder, NODE_OPTIONS or token limit into every model call, so it is refused rather than allowed. Remove ${record.refused.length === 1 ? "it" : "them"} from the .env files, or add the name to SERVER_ENV_ALLOWLIST in eval/acceptance/server-env.ts after review. A variable the harness's own environment defines is not added by a file; that environment is recorded separately, in results.json under harnessEnvironment: by name only, every variable it passes on that is not reviewed as harmless (HARMLESS_HARNESS_NAMES in eval/acceptance/harness-env.ts), and the model variables by name and value hash. summary.md shows only counts of those names by class. Allowed: ${record.allowlist.join(", ")}.`
      );
    }
    return {
      ok: problems.length === 0,
      text:
        problems.length === 0
          ? `The servers' .env files add these variables beyond the harness's environment, all allowed: ${names}.`
          : `Refusing a paid run before any spend: the servers' .env files are not acceptable: ${problems.join("; ")}. ${advice.join(" ")}`,
    };
  };
  const full = compose(false);
  return { ...record, ok: full.ok, message: full.text, printable: compose(true).text, rechecks: [], changed: false };
}

/**
 * Loads the checkout's `.env` files as Next.js does, over `env`, which must be
 * the environment the server is given, and checks the result: every name a
 * file adds is on the allowlist, every non-blank, non-comment line of a loaded
 * file is accounted for by the loader's result, and the files did not change
 * while they were read. Fails closed: when the loader cannot be run the
 * record is not ok, and `env` comes back unchanged.
 */
export function loadServerEnv(options: { root: string; mode: EnvMode; env: Record<string, string | undefined> }): LoadedServerEnv {
  const names = envFileNames(options.mode, options.env.NODE_ENV);
  const allowlist = SERVER_ENV_ALLOWLIST.map((a) => a.name);
  const files = hashEnvFiles(options.root, names);
  const failed = (loaderError: string, loaderNotRun = false): LoadedServerEnv => ({
    env: { ...options.env } as NodeJS.ProcessEnv,
    fileOf: new Map(),
    record: build({ files, added: [], refused: [], unaccounted: [], loaderError, allowlist }, loaderNotRun),
  });
  const odd = files.find((f) => f.state === "other");
  if (odd) return failed(`${odd.file} is not a readable plain file`);
  let loaded: LoaderOutput;
  try {
    loaded = runLoader(options.root, options.mode, options.env);
  } catch (err) {
    return failed(classifyLoaderFailure(err), true);
  }
  if (loaded.errors > 0) return failed("the loader reported an error reading a file");
  if (!sameFiles(files, hashEnvFiles(options.root, names))) return failed("a file changed while it was read");

  // A name the environment already defines is not added by a file (its value stays), so it has no file.
  const addedNames = new Set(loaded.added);
  const fileOf = new Map<string, string>();
  const unaccounted: UnaccountedLine[] = [];
  for (const f of loaded.files) {
    for (const name of f.names) if (addedNames.has(name) && !fileOf.has(name)) fileOf.set(name, label(f.path));
    for (const u of unaccountedLines(f.contents, new Set(f.names))) unaccounted.push({ file: label(f.path), ...u });
  }
  const added = loaded.added
    .map((name) => ({ name, file: fileOf.get(name) ?? "an .env file" }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const refused = added.filter((v) => !isAllowedServerVariable(v.name)).map((v) => v.name);
  const env = Object.fromEntries(Object.entries(loaded.env).filter(([name]) => !name.startsWith("__NEXT_")));
  return { env: env as NodeJS.ProcessEnv, fileOf, record: build({ files, added, refused, unaccounted, loaderError: null, allowlist }) };
}

/**
 * The value a server started by the harness sees for `name`, with where it
 * came from as a redacted label; null when nothing sets it. A defined name is
 * defined even when its value is empty, as in Next.js, so an empty
 * `DESIGN_AGENT_*` setting in the environment means the product's default,
 * not a file's value.
 */
export function serverSetting(loaded: Pick<LoadedServerEnv, "env" | "fileOf">, name: string): { value: string; source: string } | null {
  const value = loaded.env[name];
  if (value === undefined) return null;
  return { value, source: loaded.fileOf.get(name) ?? "the harness's environment" };
}

/** The model-related variables the files added, by name and the hash of the value, for the environment fingerprint. */
export function loadedFileVariables(loaded: LoadedServerEnv, wanted: (name: string) => boolean): { name: string; sha256: string; file: string }[] {
  return loaded.record.added
    .filter((v) => wanted(v.name) && typeof loaded.env[v.name] === "string")
    .map((v) => ({ name: v.name, sha256: sha256(Buffer.from(loaded.env[v.name]!)), file: v.file }));
}

/**
 * Checks the loaded files against what they were at check time, by name and
 * SHA-256: made at each server start and at the end of the run. No content is
 * read into the result. `recordEnvRecheck` puts it on the record.
 */
export function recheckEnvFiles(loaded: Pick<LoadedServerEnv, "record">, root: string, at: string): EnvFilesRecheck {
  const before = loaded.record.files;
  const now = hashEnvFiles(
    root,
    before.map((f) => f.file.replace(/^<project>\//, ""))
  );
  const changes: string[] = [];
  before.forEach((was, i) => {
    const is = now[i];
    if (was.state === is.state && was.sha256 === is.sha256) return;
    changes.push(`${was.file} ${was.state === "absent" ? "appeared" : is.state === "absent" ? "was removed" : "changed"}`);
  });
  return { at, ok: changes.length === 0, changes };
}

/** Records a re-check on the loaded files and flags the run when it found a difference. */
export function recordEnvRecheck(record: ServerEnvFiles, recheck: EnvFilesRecheck): EnvFilesRecheck {
  record.rechecks.push(recheck);
  if (!recheck.ok) record.changed = true;
  return recheck;
}
