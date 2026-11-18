import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * What a later run must match to be comparable with this one (#224): the CLI
 * version, the models seen, the configuration the Design Agent inherits and
 * the harness's own files. The configuration is fingerprinted by redacted
 * label, existence, size and SHA-256 only; no file content, and no home or
 * checkout path, is ever recorded.
 */

export interface FileFingerprint {
  /** A redacted label such as `~/.claude/settings.json` or `<project>/CLAUDE.md`. */
  label: string;
  exists: boolean;
  size: number | null;
  sha256: string | null;
}

export interface EnvironmentRecord {
  commit: string;
  /** Tracked files differ from the commit. */
  commitDirty: boolean;
  node: string;
  platform: string;
  cli: {
    /** The CLI the servers spawn (the Design Agent and the Director). */
    server: { path: string | null; version: string | null };
    /** The CLI the harness spawns (the judges and the Design-Agent-only arm). */
    harness: { path: string | null; version: string | null };
  };
  models: {
    designAgent: { models: string[]; source: string };
    director: { models: string[]; source: string };
    designAgentOnly: string[];
    judge: string[];
  };
  inheritedConfiguration: FileFingerprint[];
  harnessFiles: { file: string; sha256: string }[];
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Replaces the home folder with `~`, so a recorded path names no account. */
export function redactPath(p: string, home: string): string {
  const rel = path.relative(home, p);
  return rel === "" ? "~" : !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : p;
}

function fingerprint(file: string, label: string): FileFingerprint {
  try {
    const st = statSync(file);
    if (!st.isFile()) return { label, exists: false, size: null, sha256: null };
    return { label, exists: true, size: st.size, sha256: sha256(readFileSync(file)) };
  } catch {
    return { label, exists: false, size: null, sha256: null };
  }
}

function markdownUnder(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".md")).map((f) => f.split(path.sep).join("/")).sort();
  } catch {
    return [];
  }
}

/** Where managed (enterprise) settings live on this platform, a fixed system path. */
function managedSettings(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "linux") return "/etc/claude-code/managed-settings.json";
  return null;
}

/**
 * The configuration a CLI started in `project` without `--setting-sources`
 * loads: user settings, instructions and rules (under `CLAUDE_CONFIG_DIR`
 * when set), managed settings, the project's instructions, settings, rules
 * and MCP file, and instruction files in every folder above the project.
 */
export function configFingerprint(options: { home: string; project: string; configDir?: string; platform?: NodeJS.Platform }): FileFingerprint[] {
  const { home, project } = options;
  const userDir = options.configDir || path.join(home, ".claude");
  const userLabel = options.configDir ? "$CLAUDE_CONFIG_DIR" : "~/.claude";
  const out: FileFingerprint[] = [];
  for (const name of ["settings.json", "settings.local.json", "CLAUDE.md"]) out.push(fingerprint(path.join(userDir, name), `${userLabel}/${name}`));
  for (const rel of markdownUnder(path.join(userDir, "rules"))) out.push(fingerprint(path.join(userDir, "rules", rel), `${userLabel}/rules/${rel}`));
  const managed = managedSettings(options.platform ?? process.platform);
  if (managed) out.push(fingerprint(managed, managed));
  for (const rel of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json", ".mcp.json"]) {
    out.push(fingerprint(path.join(project, rel), `<project>/${rel}`));
  }
  for (const rel of markdownUnder(path.join(project, ".claude", "rules"))) out.push(fingerprint(path.join(project, ".claude", "rules", rel), `<project>/.claude/rules/${rel}`));
  // Instruction files above the project, recorded only where they exist.
  let dir = project;
  for (let up = 1; path.dirname(dir) !== dir; up++) {
    dir = path.dirname(dir);
    for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
      const f = fingerprint(path.join(dir, name), `<project>/${"../".repeat(up)}${name}`);
      if (f.exists) out.push(f);
    }
  }
  return out;
}

/** The SHA-256 of every file in the harness folder, by file name. */
export function harnessHashes(dir: string): { file: string; sha256: string }[] {
  return readdirSync(dir)
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .sort()
    .map((file) => ({ file, sha256: sha256(readFileSync(path.join(dir, file))) }));
}

/** `CLAUDE_CLI_PATH` from the checkout's `.env.local`, which the servers load; null when absent. */
export function envLocalCliPath(root: string): string | null {
  let text: string;
  try {
    text = readFileSync(path.join(root, ".env.local"), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?CLAUDE_CLI_PATH\s*=\s*(.*?)\s*$/);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, "$2") || null;
  }
  return null;
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

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The models named on assistant messages in the CLI's own transcripts of
 * these sessions, under `<config dir>/projects/`. Only the model names are
 * read. The server does not log the Design Agent's model, so this is the
 * only record of it; an absent transcript yields nothing.
 */
export function transcriptModels(sessionIds: string[], configDir: string): string[] {
  const projects = path.join(configDir, "projects");
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return [];
  }
  const models = new Set<string>();
  for (const id of new Set(sessionIds.filter((s) => SESSION_ID.test(s)))) {
    const folder = folders.find((f) => existsSync(path.join(projects, f, `${id}.jsonl`)));
    if (!folder) continue;
    for (const line of readFileSync(path.join(projects, folder, `${id}.jsonl`), "utf8").split("\n")) {
      if (!line.includes('"model"')) continue;
      try {
        const e = JSON.parse(line) as { type?: unknown; message?: { model?: unknown } };
        const model = e.type === "assistant" ? e.message?.model : null;
        if (typeof model === "string" && /^[\w.:@/-]{1,128}$/.test(model) && model !== "<synthetic>") models.add(model);
      } catch {
        // A partial line is skipped.
      }
    }
  }
  return [...models].sort();
}

/** The current commit and whether tracked files differ from it. */
export function gitState(root: string): { commit: string; dirty: boolean } {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root }).toString().trim();
  try {
    return { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "" };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}
