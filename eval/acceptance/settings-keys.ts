import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The key names of the settings files the pinned CLI reads (#232), recorded
 * before the ledger reservation and never as values.
 *
 * A settings file can set the model, the effort, the thinking, an `env` block
 * (any variable, so an endpoint or a token limit too) and an `apiKeyHelper`,
 * and the harness neither refuses nor overrides them: the Design Agent and the
 * Design-Agent-only arm run without `--setting-sources`, so they load the
 * user, project and project-local files, and managed settings apply to every
 * role, the Director and the judge (which pass `--setting-sources ""`)
 * included, since the CLI always adds them. What the harness can do is show
 * which keys are present, by name, so a reader sees what a run was exposed to.
 * A value is parsed in memory to take its key names and is never kept, so no
 * record, summary or printed line holds one. results.json (never committed)
 * keeps every recorded name, the managed drop-in files' names included;
 * summary.md and a dry run name only what this module defines in source (the
 * fixed file labels and the CLI's own key names in `SETTINGS_KEYS_OF_NOTE`)
 * and count everything else, since a name read from the operator's machine can
 * carry an organization, project or machine detail.
 *
 * The files are those read in the pinned CLI (2.1.328), taken from its own
 * code (the text of the installed binary): the user folder's `settings.json`
 * (the user folder is `CLAUDE_CONFIG_DIR`, else `~/.claude`), the working
 * directory's `.claude/settings.json` and `.claude/settings.local.json`, the
 * local settings of the repository's canonical Git root (the main worktree,
 * when the working directory is a linked worktree; the CLI applies an
 * ownership check of its own to it, which is not repeated here), the managed settings file
 * `managed-settings.json` and its drop-in folder `managed-settings.d` in the
 * platform's managed folder (`/Library/Application Support/ClaudeCode` on
 * macOS, `/etc/claude-code` on Linux, `C:\Program Files\ClaudeCode` on
 * Windows), and on macOS the managed preferences property lists. That
 * version reads no `settings.local.json` in the user folder. Server-managed
 * settings and the Windows registry are not files and are not read here. This
 * module imports nothing from the harness, so any of its modules can use it
 * without an import cycle.
 */

/** The CLI version the list of files was read from; a different pinned CLI may read others. */
export const SETTINGS_LISTED_FOR_CLI = "2.1.328";

export type SettingsFileState =
  /** No file there. */
  | "absent"
  /** A JSON object, whose key names were taken. */
  | "ok"
  /** A file that is not a JSON object; its hash is recorded and its keys are not shown. */
  | "unparseable"
  /** Something is there that could not be read as a file (a folder, no permission, too large). */
  | "unreadable"
  /** A property list (macOS managed preferences), recorded by existence and hash only. */
  | "not-parsed";

export interface SettingsFileRecord {
  /**
   * `user`, `project`, `project-local`, `project-local-main`, `managed`, `managed-drop-in/<name>`, `managed-mdm-user` or `managed-mdm-device`: never a path.
   * A drop-in file's name is in results.json only; summary.md and a dry run count the drop-in files.
   */
  label: string;
  exists: boolean;
  state: SettingsFileState;
  /** SHA-256 of the file's bytes, the same bytes the keys were taken from; null when absent or unreadable. */
  sha256: string | null;
  /** The top-level key names, sorted; empty unless `state` is `ok`. */
  keys: string[];
  /** The names under the `env` key, sorted; empty unless `state` is `ok`. Never a value. */
  envKeys: string[];
  /** Names left out because they are not plain names (a name can hold anything), counted only. */
  unrecordedNames: number;
}

export interface SettingsKeysRecord {
  /** The CLI version the list of files was read from (`SETTINGS_LISTED_FOR_CLI`). */
  listedForCli: string;
  /** The pinned CLI is the one the list was read from. False when it is another version, or unknown: the list may then be incomplete. */
  listedForPinnedCli: boolean;
  files: SettingsFileRecord[];
}

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
/** A name recorded as it is: a plain setting or variable name. Anything else is only counted. */
const PLAIN_NAME = /^[\w.@:+-]{1,100}$/;
const PLAIN_FILE_NAME = /^[\w.@+-]{1,64}\.json$/;

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The platform's managed settings folder, as the pinned CLI chooses it. */
export function managedSettingsDir(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

export interface SettingsSource {
  label: string;
  /** In memory only, never recorded. */
  file: string;
  /** False for a property list, which is never parsed here. */
  parsed: boolean;
}

export interface SettingsSourceOptions {
  home: string;
  /** `CLAUDE_CONFIG_DIR` as the servers see it; the user folder is `~/.claude` without it. */
  configDir?: string;
  /** The working directory the Design Agent runs in: the checkout. */
  project: string;
  /** The repository's main worktree when the checkout is a linked one. */
  mainWorktree?: string | null;
  platform?: NodeJS.Platform;
  /** The managed settings folder, the platform's by default; null for none. */
  managedDir?: string | null;
  /** The account's user name, for the per-user macOS managed preferences. */
  username?: string | null;
}

/** The `.json` files of the managed drop-in folder, sorted, without hidden files. */
function dropIns(managedDir: string): string[] {
  try {
    return readdirSync(path.join(managedDir, "managed-settings.d"))
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

/** Every file the pinned CLI may read settings from, with its label; the files need not exist. */
export function settingsSources(options: SettingsSourceOptions): SettingsSource[] {
  const platform = options.platform ?? process.platform;
  const userDir = options.configDir ? path.resolve(options.project, options.configDir) : path.join(options.home, ".claude");
  const sources: SettingsSource[] = [
    { label: "user", file: path.join(userDir, "settings.json"), parsed: true },
    { label: "project", file: path.join(options.project, ".claude", "settings.json"), parsed: true },
    { label: "project-local", file: path.join(options.project, ".claude", "settings.local.json"), parsed: true },
  ];
  if (options.mainWorktree && real(options.mainWorktree) !== real(options.project)) {
    sources.push({ label: "project-local-main", file: path.join(options.mainWorktree, ".claude", "settings.local.json"), parsed: true });
  }
  const managedDir = options.managedDir === undefined ? managedSettingsDir(platform) : options.managedDir;
  if (managedDir) {
    sources.push({ label: "managed", file: path.join(managedDir, "managed-settings.json"), parsed: true });
    dropIns(managedDir).forEach((name, i) => {
      sources.push({ label: `managed-drop-in/${PLAIN_FILE_NAME.test(name) ? name : `(unusual name ${i + 1})`}`, file: path.join(managedDir, "managed-settings.d", name), parsed: true });
    });
  }
  if (platform === "darwin") {
    if (options.username) sources.push({ label: "managed-mdm-user", file: `/Library/Managed Preferences/${options.username}/com.anthropic.claudecode.plist`, parsed: false });
    sources.push({ label: "managed-mdm-device", file: "/Library/Managed Preferences/com.anthropic.claudecode.plist", parsed: false });
  }
  return sources;
}

/** The plain names among an object's keys, sorted, and how many were left out. */
function namesOf(value: unknown): { names: string[]; unrecorded: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { names: [], unrecorded: 0 };
  const all = Object.keys(value);
  const names = all.filter((k) => PLAIN_NAME.test(k)).sort();
  return { names, unrecorded: all.length - names.length };
}

const none = (label: string, exists: boolean, state: SettingsFileState, sha256: string | null = null): SettingsFileRecord => ({
  label,
  exists,
  state,
  sha256,
  keys: [],
  envKeys: [],
  unrecordedNames: 0,
});

/**
 * What one settings file holds, by key name: read once, hashed and parsed from
 * the same bytes. A file that is missing is absent; anything that is not a
 * readable regular file, or is over 4 MB, is unreadable; a file that is not a
 * JSON object (a leading byte-order mark is skipped) is unparseable and keeps
 * its hash. No value is kept, and no path or error text is recorded.
 */
export function readSettingsFile(source: SettingsSource): SettingsFileRecord {
  const { label, file } = source;
  let bytes: Buffer;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_SETTINGS_BYTES) return none(label, true, "unreadable");
    bytes = readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? none(label, false, "absent") : none(label, true, "unreadable");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!source.parsed) return none(label, true, "not-parsed", sha256);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    return none(label, true, "unparseable", sha256);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return none(label, true, "unparseable", sha256);
  const top = namesOf(value);
  const env = namesOf((value as { env?: unknown }).env);
  return { label, exists: true, state: "ok", sha256, keys: top.names, envKeys: env.names, unrecordedNames: top.unrecorded + env.unrecorded };
}

/**
 * Reads every settings file the pinned CLI may read for the Design Agent, the
 * Design-Agent-only arm and (managed settings) every role, by key name.
 * `cliVersion` is the pinned CLI's version number: the list of files was read
 * from `SETTINGS_LISTED_FOR_CLI`, so another version marks the list as
 * possibly incomplete.
 */
export function recordSettingsKeys(options: SettingsSourceOptions & { cliVersion: string | null }): SettingsKeysRecord {
  return {
    listedForCli: SETTINGS_LISTED_FOR_CLI,
    listedForPinnedCli: options.cliVersion === SETTINGS_LISTED_FOR_CLI,
    files: settingsSources(options).map(readSettingsFile),
  };
}

/**
 * The settings top-level key names that summary.md and a dry run may print:
 * the CLI's own key names for what decides or changes a model call, fixed here
 * in source. A key name read from a file is printed only when it is one of
 * these; any other name, including one that merely contains `model`,
 * `effort`, `think` or `token`, is only counted, because a name in a file can
 * carry an organization, project or machine detail. results.json keeps every
 * recorded name.
 */
export const SETTINGS_KEYS_OF_NOTE: readonly string[] = ["model", "effortLevel", "alwaysThinkingEnabled", "env", "apiKeyHelper", "modelPricing"];
/** Any other key whose name contains one of these words, in either case: counted in the banner, never named. */
const NOTEWORTHY_KEY = /model|effort|think|token/i;

/** A key that is on the fixed list of the CLI's own key names. */
export const isNamedKey = (key: string): boolean => SETTINGS_KEYS_OF_NOTE.includes(key);
/** A key that is not on the fixed list but whose name contains model, effort, think or token: counted and not named. */
export const isOtherNoteworthyKey = (key: string): boolean => !isNamedKey(key) && NOTEWORTHY_KEY.test(key);
export const isNoteworthyKey = (key: string): boolean => isNamedKey(key) || NOTEWORTHY_KEY.test(key);

/**
 * The labels this module defines for the files it reads. Every other label (a
 * managed drop-in file's, which is named after the file on the operator's
 * machine) is counted and never printed.
 */
export const FIXED_SETTINGS_LABELS: readonly string[] = ["user", "project", "project-local", "project-local-main", "managed", "managed-mdm-user", "managed-mdm-device"];
const DROP_IN_PREFIX = "managed-drop-in/";
const isDropIn = (label: string): boolean => label.startsWith(DROP_IN_PREFIX);

/** The files of one fixed label, or every managed drop-in file together: the unit summary.md and a dry run speak of. */
interface SourceGroup {
  /** A fixed label, or `managed drop-in files`. */
  name: string;
  dropIn: boolean;
  files: SettingsFileRecord[];
}

/** The records grouped for text that may be committed or pasted, in the order of first appearance; the drop-in files form one group. */
function groupSources(record: SettingsKeysRecord): SourceGroup[] {
  const groups: SourceGroup[] = [];
  for (const f of record.files) {
    const dropIn = isDropIn(f.label);
    const name = dropIn ? "managed drop-in files" : FIXED_SETTINGS_LABELS.includes(f.label) ? f.label : "settings files with another label";
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, dropIn: dropIn || !FIXED_SETTINGS_LABELS.includes(f.label), files: [] }));
    g.files.push(f);
  }
  return groups;
}

/** A counted group's name with a number of its files (`1 managed drop-in file`, `2 managed drop-in files`). */
const counted = (g: SourceGroup, n: number): string => `${n} ${n === 1 ? g.name.replace(/ files\b/, " file") : g.name}`;

/** A group's name for text: a fixed label as it is, a counted group with its number of files. */
const groupText = (g: SourceGroup): string => (g.dropIn ? counted(g, g.files.length) : g.name);

/** What a group's present, readable files hold, by class: the fixed key names found, and counts of every other name. */
function groupKeys(g: SourceGroup): { named: string[]; otherNoteworthy: number; otherKeys: number; keys: number; envNames: number; unrecordedNames: number } {
  const ok = g.files.filter((f) => f.state === "ok");
  const keys = ok.flatMap((f) => f.keys);
  const named = [...new Set(keys.filter(isNamedKey))].sort();
  const otherNoteworthy = keys.filter(isOtherNoteworthyKey).length;
  return {
    named,
    otherNoteworthy,
    otherKeys: keys.filter((k) => !isNamedKey(k)).length,
    keys: keys.length,
    envNames: ok.reduce((a, f) => a + f.envKeys.length, 0),
    unrecordedNames: ok.reduce((a, f) => a + f.unrecordedNames, 0),
  };
}

const reasonNotShown = (state: SettingsFileState): string | null =>
  state === "unparseable" ? "not a JSON object" : state === "unreadable" ? "could not be read" : state === "not-parsed" ? "a property list, keys not read" : null;

/**
 * The banner of the settings record, as plain text lines (summary.md puts
 * them under its commit line): first the keys present that can change a model
 * call, by file label, then the sources whose keys are not shown (a file that
 * could not be read as JSON, a property list, a list of files read from
 * another CLI version). Key names are the CLI's own, from the fixed list
 * (`SETTINGS_KEYS_OF_NOTE`); any other key whose name contains model, effort,
 * think or token is counted, and the managed drop-in files are counted and
 * never named, so the banner holds no name from the operator's machine and
 * never a value. Empty when nothing is to be said.
 */
export function settingsBannerLines(record: SettingsKeysRecord): string[] {
  const present: string[] = [];
  const notShown: string[] = [];
  const unreadable = new Map<string, { group: SourceGroup; reason: string; count: number }>();
  for (const g of groupSources(record)) {
    for (const f of g.files) {
      const reason = reasonNotShown(f.state);
      if (!reason) continue;
      const key = `${g.name}\u0000${reason}`;
      const seen = unreadable.get(key);
      if (seen) seen.count += 1;
      else unreadable.set(key, { group: g, reason, count: 1 });
    }
    const k = groupKeys(g);
    if (k.named.length || k.otherNoteworthy) {
      const other = k.otherNoteworthy ? `${k.otherNoteworthy} other key(s) whose name contains model, effort, think or token` : "";
      present.push(`${groupText(g)}: ${[k.named.join(", "), other].filter(Boolean).join(", and ")}`);
    }
  }
  for (const { group, reason, count } of unreadable.values()) notShown.push(`${group.dropIn ? counted(group, count) : group.name} (${reason})`);
  if (!record.listedForPinnedCli) notShown.push(`the list of files, read from CLI ${record.listedForCli} and not from the pinned CLI, which may read others`);
  const lines: string[] = [];
  if (present.length) lines.push(`Settings keys present that can change a model call (the CLI's own key names, never values; any other key is counted): ${present.join("; ")}.`);
  if (notShown.length) lines.push(`Settings sources whose keys are not shown: ${notShown.join("; ")}.`);
  return lines;
}

/** The sources that exist, as summary.md names them: a fixed label as it is, the drop-in files (`counted`) as a number of files. */
export function presentSources(record: SettingsKeysRecord): { text: string; counted: boolean }[] {
  return groupSources(record).flatMap((g) => {
    const present = g.files.filter((f) => f.exists).length;
    if (present === 0) return [];
    return [{ text: g.dropIn ? counted(g, present) : g.name, counted: g.dropIn }];
  });
}

/** One file, or a group of them, as a dry run prints it: its state, hash and key counts, never a name from the file or a value. */
export function describeSettingsFile(f: SettingsFileRecord): string {
  const hash = f.sha256 ? `SHA-256 ${f.sha256.slice(0, 12)}` : "";
  switch (f.state) {
    case "absent":
      return "absent";
    case "ok": {
      const k = groupKeys({ name: f.label, dropIn: false, files: [f] });
      return `present, ${hash}, ${k.keys} top-level key(s), of which ${k.named.join(", ") || "none"} named by the CLI's own key list and ${k.otherKeys} other(s) counted only; ${k.envNames} name(s) under env, counted only${f.unrecordedNames ? `; ${f.unrecordedNames} name(s) not recorded` : ""}`;
    }
    case "unparseable":
      return `present but not a JSON object, ${hash}, keys not shown`;
    case "not-parsed":
      return `present (a property list), ${hash}, keys not read`;
    case "unreadable":
      return "present but could not be read, keys not shown";
  }
}

/**
 * The lines a dry run prints for the settings files: one per fixed label, and
 * one for every managed drop-in file together, with counts and never a drop-in
 * file's name, a key name that is not on the fixed list or a name under `env`.
 */
export function describeSettingsFiles(record: SettingsKeysRecord): string[] {
  return groupSources(record).flatMap((g) => {
    if (!g.dropIn) return g.files.map((f) => `${g.name}: ${describeSettingsFile(f)}`);
    const present = g.files.filter((f) => f.exists);
    if (present.length === 0) return `${g.name}: none`;
    const k = groupKeys(g);
    const notRead = present.filter((f) => f.state !== "ok").length;
    return `${counted(g, present.length)}: ${k.keys} top-level key(s) in all, of which ${k.named.join(", ") || "none"} named by the CLI's own key list and ${k.otherKeys} other(s) counted only; ${k.envNames} name(s) under env, counted only${notRead ? `; ${notRead} file(s) whose keys are not shown` : ""}`;
  });
}
