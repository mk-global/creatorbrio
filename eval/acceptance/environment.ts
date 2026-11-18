import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHECKOUT_ROOT, isInside } from "./ledger";

/**
 * What a later run must match to be comparable with this one (#224): the CLI
 * version, the models seen, the configuration the Design Agent inherits and
 * the harness's own files. The configuration is fingerprinted by redacted
 * label, existence, size and SHA-256 only; no file content, and no home or
 * checkout path, is ever recorded.
 *
 * The inherited configuration is more than a few files. The CLI also loads
 * skills, agents, commands and plugins from the user's configuration folder
 * and the project's `.claude/`, reads MCP servers from `~/.claude.json`, and
 * takes its model, effort and thinking settings from the environment, so each
 * of those is fingerprinted too: a tree by relative file names, sizes and
 * hashes with one combined hash, MCP servers by name only (never a command,
 * argument, environment value or URL) and each model-related variable by name
 * and the hash of its value.
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
  inheritedConfiguration: InheritedConfiguration;
  harnessFiles: { file: string; sha256: string }[];
}

export interface TreeFile {
  /** Relative to the tree's root, `/`-separated. */
  path: string;
  size: number;
  /** Null for a file too large to hash, an unreadable one or a broken link. */
  sha256: string | null;
}

export interface TreeFingerprint {
  /** A redacted label such as `~/.claude/skills`. */
  label: string;
  exists: boolean;
  files: TreeFile[];
  /** Files fingerprinted and their total size. */
  count: number;
  bytes: number;
  /** One hash over every file's path, size and hash, in order. */
  sha256: string | null;
  /** The walk stopped at the file limit, so the tree is only partly fingerprinted. */
  truncated: boolean;
}

export interface McpServers {
  /** A redacted label of the file read. */
  source: string;
  found: boolean;
  /** Server names in the user scope. */
  user: string[];
  /** Server names in this project's entry, or null when it has none. */
  project: string[] | null;
  /** Set when the file could not be read as JSON; never any of its content. */
  error: string | null;
}

export interface EnvVariable {
  name: string;
  /** SHA-256 of the value; the value itself is never recorded. */
  sha256: string;
}

export interface InheritedConfiguration {
  files: FileFingerprint[];
  trees: TreeFingerprint[];
  mcpServers: McpServers;
  environment: {
    /** Model, effort and thinking variables in the environment the servers receive. */
    received: EnvVariable[];
    /** The same kind of variable set in the shell that started the harness but removed by it: what the app's normal launch would pass on. */
    strippedByHarness: EnvVariable[];
    /** Such variables the servers load from the checkout's `.env` files, by file. */
    envFiles: (EnvVariable & { file: string })[];
  };
  /** What this fingerprint cannot show, stated rather than implied. */
  limitations: string[];
  /** Everything fingerprinted: existing files, tree files, MCP server names and variables. */
  count: number;
  /** One hash over all of the above. */
  sha256: string;
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

const TREE_LIMITS = { files: 20_000, fileBytes: 16 * 1024 * 1024, depth: 16 };
/** Folders whose contents cannot change what the CLI loads, or are too large to fingerprint. */
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);
const SKIPPED_FILES = new Set([".DS_Store"]);

/**
 * A folder's files by relative name, size and SHA-256, with one combined
 * hash, in a fixed order. Symbolic links are followed (the CLI follows them),
 * with cycles skipped; `.git` and `node_modules` folders and `.DS_Store` files
 * are left out; a file over 16 MB is sized but not hashed; at most 20,000
 * files are read and the tree is marked truncated beyond that. File content is
 * hashed and never kept.
 */
export function treeFingerprint(dir: string, label: string, limits = TREE_LIMITS): TreeFingerprint {
  const absent: TreeFingerprint = { label, exists: false, files: [], count: 0, bytes: 0, sha256: null, truncated: false };
  try {
    if (!statSync(dir).isDirectory()) return absent;
  } catch {
    return absent;
  }
  const files: TreeFile[] = [];
  let truncated = false;
  const walk = (abs: string, rel: string, ancestors: string[], depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.length >= limits.files) {
        truncated = true;
        return;
      }
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try {
        st = statSync(childAbs); // follows a link
      } catch {
        files.push({ path: childRel, size: 0, sha256: null }); // a broken link
        continue;
      }
      if (st.isDirectory()) {
        if (SKIPPED_FOLDERS.has(e.name)) continue;
        if (depth >= limits.depth) {
          truncated = true;
          continue;
        }
        let real: string;
        try {
          real = realpathSync(childAbs);
        } catch {
          continue;
        }
        if (!ancestors.includes(real)) walk(childAbs, childRel, [...ancestors, real], depth + 1);
      } else if (st.isFile() && !SKIPPED_FILES.has(e.name)) {
        let digest: string | null = null;
        if (st.size <= limits.fileBytes) {
          try {
            digest = sha256(readFileSync(childAbs));
          } catch {
            digest = null;
          }
        }
        files.push({ path: childRel, size: st.size, sha256: digest });
      }
    }
  };
  let rootReal: string;
  try {
    rootReal = realpathSync(dir);
  } catch {
    return absent;
  }
  walk(dir, "", [rootReal], 0);
  const combined = createHash("sha256");
  for (const f of files) combined.update(`${f.path}\0${f.size}\0${f.sha256 ?? "-"}\n`);
  return { label, exists: true, files, count: files.length, bytes: files.reduce((a, f) => a + f.size, 0), sha256: combined.digest("hex"), truncated };
}

const SERVER_NAME = /^[\w.@:+ -]{1,100}$/;
const namesOf = (value: unknown): string[] =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).filter((k) => SERVER_NAME.test(k)).sort() : [];

/**
 * The names, and only the names, of the MCP servers the CLI would load from
 * its `.claude.json` (in `CLAUDE_CONFIG_DIR` when set, else the home folder):
 * the user scope and this project's own entry. A server's command, arguments,
 * environment and URL are never read into the record.
 */
export function mcpServerNames(options: { home: string; project: string; configDir?: string }): McpServers {
  const file = options.configDir ? path.join(options.configDir, ".claude.json") : path.join(options.home, ".claude.json");
  const source = options.configDir ? "$CLAUDE_CONFIG_DIR/.claude.json" : "~/.claude.json";
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { source, found: false, user: [], project: null, error: null };
  }
  try {
    const data = JSON.parse(text) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> };
    const keys = new Set([options.project]);
    try {
      keys.add(realpathSync(options.project));
    } catch {
      // The project path is only a lookup key.
    }
    const entry = [...keys].map((k) => data.projects?.[k]).find((p) => p && typeof p === "object");
    return { source, found: true, user: namesOf(data.mcpServers), project: entry ? namesOf(entry.mcpServers) : null, error: null };
  } catch {
    return { source, found: true, user: [], project: null, error: "not readable as JSON" };
  }
}

/**
 * The variables that choose a model, its effort or its thinking: the
 * Anthropic model variables, the Claude Code ones for models, effort,
 * thinking and output tokens, `CLAUDE_EFFORT`, `MAX_THINKING_TOKENS`, and the
 * switches that route to another provider's models.
 */
export const MODEL_ENV_NAME =
  /^(ANTHROPIC_[A-Z0-9_]*MODEL[A-Z0-9_]*|CLAUDE_CODE_[A-Z0-9_]*(MODEL|EFFORT|THINK|TOKENS)[A-Z0-9_]*|CLAUDE_EFFORT|MAX_THINKING_TOKENS|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;

/** Each model-related variable in `env`, by name and the hash of its value, sorted. */
export function modelEnvironment(env: Record<string, string | undefined>): EnvVariable[] {
  return Object.entries(env)
    .filter((e): e is [string, string] => MODEL_ENV_NAME.test(e[0]) && typeof e[1] === "string")
    .map(([name, value]) => ({ name, sha256: sha256(Buffer.from(value)) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The model-related variables a checkout's `.env` files set, which the servers load: names and value hashes only. */
export function envFileVariables(root: string, mode: "prod" | "dev"): (EnvVariable & { file: string })[] {
  const suffix = mode === "prod" ? "production" : "development";
  const out: (EnvVariable & { file: string })[] = [];
  for (const file of [".env", `.env.${suffix}`, ".env.local", `.env.${suffix}.local`]) {
    let text: string;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    const values: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    for (const v of modelEnvironment(values)) out.push({ ...v, file: `<project>/${file}` });
  }
  return out;
}

const CLEAN_ENV_LIMITATION =
  "The harness strips CLAUDE_CODE_*, CLAUDE_EFFORT, CLAUDECODE, CLAUDE_PID, CLAUDE_CLI_PATH and IMAGE_SERVICE_URL from the environment it gives the servers, the judges and the Design-Agent-only arm, while the app's normal launch through /start passes them through, so a baseline launched by the harness can differ from the app's normal launch. strippedByHarness names the model, effort and thinking variables it removed from the invoking shell.";
const MEMORY_LIMITATION =
  "The Design Agent does not disable auto-memory (the Director does, with autoMemoryEnabled false), so it can read the project's auto-memory folder and write to it: a run can change what a later run reads. The memory tree is fingerprinted once, before the run, by file name, size and hash.";
const MEMORY_LOCATION_LIMITATION =
  "The auto-memory folder is located by the CLI's project-folder naming convention (every character that is not a letter or digit becomes a hyphen) for the working directory and for the repository's main worktree, under the configuration folder's projects folder; a CLI version or a setting that places it elsewhere is not seen, and only the memory subfolder is read, never the session transcripts beside it.";
const TREE_LIMITATION =
  "Trees skip .git and node_modules folders and .DS_Store files, follow symbolic links, leave a file over 16 MB unhashed and stop at 20,000 files (truncated is then true); file content is hashed and never kept.";

/** The folders whose auto-memory the Design Agent's CLI can use: the working directory, and the repository's main worktree, which linked worktrees may share. */
export function memoryRoots(root: string): { label: string; path: string }[] {
  const roots = [{ label: "working directory", path: root }];
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const gitDir = realpathSync(path.resolve(root, common));
    if (path.basename(gitDir) === ".git" && path.dirname(gitDir) !== realpathSync(root)) roots.push({ label: "main worktree", path: path.dirname(gitDir) });
  } catch {
    // Not a Git checkout: only the working directory is a candidate.
  }
  return roots;
}

/** The CLI's folder name for a project path: every character that is not a letter or digit becomes a hyphen; the older form only replaced separators and dots. */
const projectFolderNames = (p: string): string[] => [...new Set([p.replace(/[^a-zA-Z0-9]/g, "-"), p.replace(/[\\/.]/g, "-")])];

/**
 * The auto-memory folder of each project root, `<config dir>/projects/<project folder>/memory`, as a tree
 * of file names, sizes and hashes. Only the memory subfolder is read: the session transcripts beside it
 * never are. A root with no such folder is recorded as absent. The label names the root by role, not by path.
 */
export function memoryTrees(options: { userDir: string; userLabel: string; roots: { label: string; path: string }[] }): TreeFingerprint[] {
  const out: TreeFingerprint[] = [];
  const seen = new Set<string>();
  for (const root of options.roots) {
    const candidates = new Set<string>();
    for (const p of new Set([root.path, (() => { try { return realpathSync(root.path); } catch { return root.path; } })()])) {
      for (const name of projectFolderNames(p)) candidates.add(name);
    }
    const names = [...candidates];
    if (names.some((n) => seen.has(n))) continue; // the same folder, reached by another root
    for (const n of names) seen.add(n);
    const found = names.find((n) => existsSync(path.join(options.userDir, "projects", n, "memory")));
    const label = `${options.userLabel}/projects/<${root.label}>/memory`;
    out.push(
      found
        ? treeFingerprint(path.join(options.userDir, "projects", found, "memory"), label)
        : { label, exists: false, files: [], count: 0, bytes: 0, sha256: null, truncated: false }
    );
  }
  return out;
}

/**
 * Everything the Design Agent's CLI inherits that this record can name: the
 * configuration files, the skills, agents, commands, plugins, hooks and
 * output-styles trees of the user's configuration folder, the skills, agents
 * and commands trees of the project's `.claude/`, the project's auto-memory
 * folder (file names, sizes and hashes only), MCP server names, and the model,
 * effort and thinking variables of the environment the servers receive
 * (`serverEnv`), of the invoking shell (`harnessEnv`, to show what the harness
 * removed) and of the checkout's `.env` files.
 */
export function inheritedConfiguration(options: {
  home: string;
  project: string;
  configDir?: string;
  platform?: NodeJS.Platform;
  mode?: "prod" | "dev";
  /** The project roots whose auto-memory to fingerprint; the project itself by default. See `memoryRoots`. */
  memoryRoots?: { label: string; path: string }[];
  serverEnv: Record<string, string | undefined>;
  harnessEnv: Record<string, string | undefined>;
}): InheritedConfiguration {
  const { home, project } = options;
  const userDir = options.configDir || path.join(home, ".claude");
  const userLabel = options.configDir ? "$CLAUDE_CONFIG_DIR" : "~/.claude";
  const files = configFingerprint(options);
  const trees = [
    ...["skills", "agents", "commands", "plugins", "hooks", "output-styles"].map((name) => treeFingerprint(path.join(userDir, name), `${userLabel}/${name}`)),
    ...["skills", "agents", "commands"].map((name) => treeFingerprint(path.join(project, ".claude", name), `<project>/.claude/${name}`)),
    ...memoryTrees({ userDir, userLabel, roots: options.memoryRoots ?? [{ label: "working directory", path: project }] }),
  ];
  const mcpServers = mcpServerNames({ home, project, configDir: options.configDir });
  const received = modelEnvironment(options.serverEnv);
  const receivedNames = new Set(received.map((v) => v.name));
  const strippedByHarness = modelEnvironment(options.harnessEnv).filter((v) => !receivedNames.has(v.name));
  const envFiles = envFileVariables(project, options.mode ?? "prod");
  const count =
    files.filter((f) => f.exists).length +
    trees.reduce((a, t) => a + t.count, 0) +
    mcpServers.user.length +
    (mcpServers.project?.length ?? 0) +
    received.length +
    strippedByHarness.length +
    envFiles.length;
  const canonical = JSON.stringify({
    files: files.map((f) => [f.label, f.exists, f.size, f.sha256]),
    trees: trees.map((t) => [t.label, t.exists, t.count, t.bytes, t.sha256, t.truncated]),
    mcp: [mcpServers.found, mcpServers.user, mcpServers.project],
    env: [received, strippedByHarness, envFiles.map((v) => [v.file, v.name, v.sha256])],
  });
  return {
    files,
    trees,
    mcpServers,
    environment: { received, strippedByHarness, envFiles },
    limitations: [CLEAN_ENV_LIMITATION, TREE_LIMITATION, MEMORY_LIMITATION, MEMORY_LOCATION_LIMITATION],
    count,
    sha256: sha256(Buffer.from(canonical)),
  };
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

/** The folders whose paths a stored message must not contain. */
export interface Redaction {
  home: string;
  root: string;
}

const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces the checkout with `<checkout>` and the home folder with `~` in
 * `text`, also by their real paths, so a stored error message or a summary
 * names neither. The checkout goes first because it usually lies under the
 * home folder; a longer folder name that merely starts with either is left alone.
 */
export function redactText(text: string, redaction: Redaction = { home: os.homedir(), root: CHECKOUT_ROOT }): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  let out = text;
  const replace = (folder: string, label: string) => {
    for (const variant of new Set([folder, real(folder)])) {
      if (variant.length < 2) continue;
      out = out.replace(new RegExp(`${escapeRegExp(variant.replace(/[\\/]+$/, ""))}(?![\\w-]|\\.\\w)`, "g"), label);
    }
  };
  replace(redaction.root, "<checkout>");
  replace(redaction.home, "~");
  return out;
}

/** The folders the servers read and write under the checkout. */
const LIVE_FOLDERS = ["data", path.join("public", "uploads")];

/**
 * Refuses to run in the repository's primary worktree. The harness's servers
 * read and write the checkout's `data/` folder, which in the primary worktree
 * holds the person's real carousels, brands and uploads; a linked worktree has
 * its own. A linked worktree has a `--git-dir` of its own inside the common
 * one; the primary worktree's `--git-dir` is the common `--git-common-dir`.
 * A linked worktree whose `data/` or `public/uploads` is a link out of the
 * checkout is refused too: it would reach the same live data.
 */
export function assertLinkedWorktree(root: string): void {
  const git = (arg: string) => execFileSync("git", ["rev-parse", arg], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const resolved = (p: string) => realpathSync(path.resolve(root, p));
  let primary: boolean;
  try {
    primary = resolved(git("--git-dir")) === resolved(git("--git-common-dir"));
  } catch {
    throw new Error("Refusing to run: this checkout's Git worktree could not be determined, so it cannot be shown that it is not the primary worktree holding live data. Run the harness from a dedicated linked worktree (git worktree add).");
  }
  if (primary) {
    throw new Error(
      "Refusing to run in the repository's primary worktree: the servers the harness starts read and write its data/ folder, which holds real carousels, brands and uploads. Create a dedicated linked worktree (git worktree add <folder> -b <branch>) and run the harness from there."
    );
  }
  // A linked worktree whose data/ or public/uploads is a link to another folder would still reach live data.
  for (const rel of LIVE_FOLDERS) {
    const p = path.join(root, rel);
    let present = true;
    try {
      lstatSync(p);
    } catch {
      present = false; // the server makes it; `isInside` checks the nearest existing parent
    }
    let resolves = true;
    if (present) {
      try {
        realpathSync(p);
      } catch {
        resolves = false; // a link whose target is missing: the server would make the target
      }
    }
    if (!resolves || !isInside(p, root)) {
      throw new Error(
        `Refusing to run: ${rel.split(path.sep).join("/")}/ in this checkout resolves outside it (a link), so the servers the harness starts would read and write data elsewhere, possibly the real carousels, brands and uploads. Remove the link so the folder is the worktree's own.`
      );
    }
  }
}

