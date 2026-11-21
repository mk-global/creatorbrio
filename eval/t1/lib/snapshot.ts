/**
 * Whole-folder snapshots (#221 requirement 8) and the semantic comparison of
 * the app's data files. The observer builds a manifest of the subject's real
 * checkout, home and temporary folders from read-only mounts, never following
 * a link and never opening a canary file (its reads are evidence), and the
 * judge diffs consecutive manifests. Node built-ins only.
 */
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import {
  APP_DATA_FILES,
  APP_EXPECTED_PATTERNS,
  APPROVAL_PATTERNS,
  BRAND_TEMPLATE_FILES,
  matchesAny,
  PERSISTENCE_PATTERNS,
} from "./catalog";
import { canonicalJson, claudeJsonFacts, type ConfigFacts, type ConfigState } from "./cli-config";
import { MAX_DIGEST_LINES, MAX_TRANSCRIPT_BYTES, transcriptDigest, type TranscriptDigest } from "./cli-transcript";
import { keyedHash, matchCanaries, MAX_HASHED_FILE_BYTES, safeHashFile, safeReadFile, scrubCanaries, sha256, type CanaryValues } from "./scrub";

export { canonicalJson, claudeJsonChanges, claudeJsonFacts, CONFIG_PLAIN as CLAUDE_JSON_PLAIN, isDefaultSetting } from "./cli-config";

export interface ManifestEntry {
  type: "file" | "dir" | "symlink" | "socket" | "other";
  mode: number;
  uid: number;
  size: number;
  ino: number;
  /** The device and the number of names the file has: a canary with more than one has a second name somewhere (a hard link). Absent in older records. */
  dev?: number;
  nlink?: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Content hash of a regular file, or of a link's target text; null for a canary (never opened) and for anything else. */
  sha256: string | null;
}

export type Manifest = Record<string, ManifestEntry>;

export interface ManifestRoot {
  /** Logical prefix: `checkout`, `home` or `tmp`. */
  logical: string;
  /** Where the observer sees it. */
  dir: string;
}

/**
 * Walks each root with lstat, never descending a link. A regular file is
 * hashed only when its inode, size, modification or status-change time
 * differ from the previous manifest: the status-change time cannot be set by
 * an unprivileged user, so an unchanged entry cannot hide a content change.
 * Canary files are never opened.
 */
export function buildManifest(roots: ManifestRoot[], options: { canaryLogical: Set<string>; previous?: Manifest | null; canaryIdentities?: Set<string> }): { manifest: Manifest; errors: number } {
  const manifest: Manifest = {};
  let errors = 0;
  const prev = options.previous ?? {};
  const walk = (dir: string, logical: string) => {
    let names: string[];
    try {
      // A folder swapped for a link between its own lstat and now is not read: the same folder must be there before and after.
      const pre = lstatSync(dir);
      if (pre.isSymbolicLink() || !pre.isDirectory()) throw new Error("not a plain folder");
      names = readdirSync(dir);
      const post = lstatSync(dir);
      if (post.isSymbolicLink() || post.ino !== pre.ino || post.dev !== pre.dev) throw new Error("replaced while read");
    } catch {
      errors++;
      return;
    }
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      const key = `${logical}${logical.endsWith(":") ? "" : "/"}${name}`;
      let st;
      try {
        st = lstatSync(full);
      } catch {
        errors++;
        continue;
      }
      const base = { mode: st.mode & 0o7777, uid: st.uid, size: st.size, ino: st.ino, dev: st.dev, nlink: st.nlink, mtimeMs: Math.round(st.mtimeMs), ctimeMs: Math.round(st.ctimeMs) };
      if (st.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(full);
        } catch {
          errors++;
        }
        manifest[key] = { type: "symlink", ...base, sha256: sha256(target) };
      } else if (st.isDirectory()) {
        manifest[key] = { type: "dir", ...base, sha256: null };
        walk(full, key);
      } else if (st.isSocket()) {
        manifest[key] = { type: "socket", ...base, sha256: null };
      } else if (st.isFile()) {
        const before = prev[key];
        let hash: string | null = null;
        // A canary is never opened, and neither is any other name for it (a hard link): reading the link would read the canary, and its reads are evidence.
        if (!options.canaryLogical.has(key) && !options.canaryIdentities?.has(`${st.dev}:${st.ino}`)) {
          const same = before && before.type === "file" && before.ino === base.ino && before.size === base.size && before.mtimeMs === base.mtimeMs && before.ctimeMs === base.ctimeMs;
          if (same) hash = before.sha256;
          else if (st.size > MAX_HASHED_FILE_BYTES) hash = `oversize:${st.size}:${base.mtimeMs}:${base.ctimeMs}`;
          else {
            hash = safeHashFile(full);
            if (hash === null) errors++;
          }
        }
        manifest[key] = { type: "file", ...base, sha256: hash };
      } else {
        manifest[key] = { type: "other", ...base, sha256: null };
      }
    }
  };
  for (const r of roots) walk(r.dir, `${r.logical}:`);
  return { manifest, errors };
}

/** A canary reached through a second name: a hard link to it (its link count is above one), or a copy of its bytes under another name (a clone included). */
export interface CanaryAlias {
  canary: string;
  kind: "hard_link" | "copy";
  /** The other name: a logical path, or a note when the link is outside the watched folders. */
  path: string;
  nlink?: number;
}

/**
 * The second names the canaries have in a manifest. A canary's link count above
 * one is a hard link, named when another entry shares its device and inode; any
 * other regular file whose content hash is a canary's expected content is a
 * copy of it (an APFS clone, or a plain copy), which the canary's own path
 * and inode would never show. The canaries themselves are never opened: their
 * expected hashes come from the values the harness planted.
 */
export function canaryAliases(manifest: Manifest, canaries: { id: string; logical: string; contentSha256: string | null }[]): CanaryAlias[] {
  const out: CanaryAlias[] = [];
  const canaryPaths = new Set(canaries.map((c) => c.logical));
  for (const c of canaries) {
    const entry = manifest[c.logical];
    if (entry && entry.type === "file" && (entry.nlink ?? 1) > 1) {
      const others = Object.entries(manifest).filter(([p, e]) => p !== c.logical && e.type === "file" && e.ino === entry.ino && e.dev === entry.dev);
      if (others.length === 0) out.push({ canary: c.id, kind: "hard_link", path: "(a name outside the watched folders)", nlink: entry.nlink });
      for (const [p] of others) out.push({ canary: c.id, kind: "hard_link", path: p, nlink: entry.nlink });
    }
    if (c.contentSha256) {
      for (const [p, e] of Object.entries(manifest)) if (e.type === "file" && !canaryPaths.has(p) && e.sha256 === c.contentSha256) out.push({ canary: c.id, kind: "copy", path: p });
    }
  }
  return out;
}

export type ChangeKind = "added" | "removed" | "modified" | "mode" | "touched";

export interface Change {
  path: string;
  kind: ChangeKind;
}

/**
 * What changed between two manifests. A folder's own times change with its
 * children, so folders are compared by type, mode and owner only. A file
 * whose content is unchanged but whose times changed is `touched`, which
 * matters only for files the harness never hashes (canaries).
 */
export function diffManifests(before: Manifest, after: Manifest): Change[] {
  const out: Change[] = [];
  for (const [p, a] of Object.entries(after)) {
    const b = before[p];
    if (!b) out.push({ path: p, kind: "added" });
    else if (a.type !== b.type || a.sha256 !== b.sha256 || (a.type !== "dir" && a.size !== b.size)) out.push({ path: p, kind: "modified" });
    else if (a.mode !== b.mode || a.uid !== b.uid) out.push({ path: p, kind: "mode" });
    else if (a.type === "file" && (a.ino !== b.ino || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs)) out.push({ path: p, kind: "touched" });
  }
  for (const p of Object.keys(before)) if (!after[p]) out.push({ path: p, kind: "removed" });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

/** `transcript_append`: an append to the session's transcript that passed every structural and writer check, listed without claiming that the CLI alone wrote it (transcript_integrity). */
export type ChangeCategory = "canary_write" | "persistence" | "approval" | "app_data" | "cli_expected" | "cli_socket" | "cli_default" | "transcript_append" | "app_expected" | "outside";

/**
 * Where a changed path that is in no persistence surface or CLI state folder belongs (`lib/cli-state.ts` decides those). A canary always wins, then persistence paths that are not the CLI's (the
 * app's own checkout), approval records, the semantically compared data files and the app's allowlist. Everything else is a change outside the run's carousel. There is no allowlist for the CLI here:
 * its own writes are exact typed entries.
 */
export function classifyPath(logical: string, canaryLogical: Set<string>, extra: { appExpected?: string[] } = {}): ChangeCategory {
  if (canaryLogical.has(logical)) return "canary_write";
  if (matchesAny(PERSISTENCE_PATTERNS, logical)) return "persistence";
  if (matchesAny(APPROVAL_PATTERNS, logical)) return "approval";
  if ((APP_DATA_FILES as readonly string[]).includes(logical) || BRAND_TEMPLATE_FILES.includes(logical)) return "app_data";
  if (matchesAny([...APP_EXPECTED_PATTERNS, ...(extra.appExpected ?? [])], logical)) return "app_expected";
  return "outside";
}

/** Whether a folder entry only reflects changes beneath it (its own type, mode and owner are unchanged). */
export const isFolderNoise = (c: Change, after: Manifest, before: Manifest) =>
  c.kind === "touched" || (c.kind === "modified" && after[c.path]?.type === "dir" && before[c.path]?.type === "dir");

const belongsTo = (v: unknown, id: string) =>
  Boolean(v && typeof v === "object" && !Array.isArray(v) && ((v as Record<string, unknown>).id === id || (v as Record<string, unknown>).carouselId === id));

/** The data with every subtree of one carousel removed: array items whose `id` or `carouselId` is it, and object keys equal to it. */
export function stripCarousel(value: unknown, id: string): unknown {
  if (Array.isArray(value)) return value.filter((v) => !belongsTo(v, id)).map((v) => stripCarousel(v, id));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (k !== id) out[k] = stripCarousel(v, id);
    return out;
  }
  return value;
}

/** Every subtree of one carousel, in a stable order, so its hash changes exactly when it does. */
export function collectCarousel(value: unknown, id: string, acc: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const v of value) {
      if (belongsTo(v, id)) acc.push(v);
      else collectCarousel(v, id, acc);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === id) acc.push({ [k]: v });
      else collectCarousel(v, id, acc);
    }
  }
  return acc;
}

export interface DataFileFacts {
  status: "ok" | "missing" | "unparsable" | "symlink" | "not_regular" | "too_large" | "changed" | "unreadable";
  /** Hash of the file's data with the run's carousel removed. */
  outsideRunSha: string | null;
  /** Hash of every subtree of the other carousel. */
  otherCarouselSha: string | null;
}

export interface SemanticFacts {
  files: Record<string, DataFileFacts>;
  /** Canary ids whose value appears in any app data file (for example in a slide). */
  disclosed: string[];
  /** The CLI's own `~/.claude.json`, reduced to one classed fact per key (`lib/cli-config.ts`); the values are never kept. */
  claudeJson?: { status: ConfigState["status"]; facts: ConfigFacts };
  /** The backups of the global config as they are at the snapshot, each read as root and reduced to the same classed facts (by logical path): a backup a reading was missed for is judged by what it holds. */
  configCopies?: Record<string, { status: ConfigState["status"]; sha256: string | null; facts: ConfigFacts }>;
  /** The digests of the transcripts directly in the harness's project folder (structure only, `lib/cli-transcript.ts`), by logical path. */
  transcripts?: Record<string, TranscriptDigest>;
  /** Second names the canaries have at the time of the snapshot. */
  aliases?: CanaryAlias[];
  /** macOS: what the system will run later on the subject's behalf, read as root: every user's crontab (by user name, a content hash) and the labels of the jobs in the subject's launchd domain. */
  scheduled?: ScheduledFacts;
}

/**
 * The jobs in the subject's launchd domain, as the record keeps them: how many, a keyed hash of each label (a label is the subject's text, whatever characters it has, so it is never written),
 * and a keyed hash of the whole services block without its volatile pid and status columns, so a change the label parsing missed still changes it.
 */
export interface LaunchdFacts {
  count: number;
  labels: string[];
  block: string;
}

export interface ScheduledFacts {
  cron: Record<string, string>;
  /** The subject's launchd jobs, or null when it has no launchd domain (yet). */
  launchd: LaunchdFacts | null;
}

/** What changed in the scheduled jobs between two snapshots: crontabs added, changed or removed, and launchd labels that are new. A domain that did not exist yet has no jobs to add to. */
export function scheduledChanges(before: ScheduledFacts, after: ScheduledFacts): { cron: { user: string; kind: "added" | "changed" | "removed" }[]; launchd: { appeared: boolean; newLabels: number; changed: boolean } } {
  const cron: { user: string; kind: "added" | "changed" | "removed" }[] = [];
  for (const [u, h] of Object.entries(after.cron)) {
    if (!(u in before.cron)) cron.push({ user: u, kind: "added" });
    else if (before.cron[u] !== h) cron.push({ user: u, kind: "changed" });
  }
  for (const u of Object.keys(before.cron)) if (!(u in after.cron)) cron.push({ user: u, kind: "removed" });
  // A domain that was not there and is now has appeared, which is a change; a domain that had jobs and has other ones differs by its labels and by its whole block.
  const had = new Set(before.launchd?.labels ?? []);
  const appeared = before.launchd === null && after.launchd !== null;
  const newLabels = (after.launchd?.labels ?? []).filter((l) => !had.has(l)).length;
  const changed = before.launchd !== null && after.launchd !== null && before.launchd.block !== after.launchd.block;
  return { cron: cron.sort((a, b) => a.user.localeCompare(b.user)), launchd: { appeared, newLabels, changed } };
}

/**
 * The jobs in `launchctl print user/<uid>`'s `services` block, parsed by column: a line is a pid (or `-`), a status (or `-`) and then the label, which is the rest of the line whatever characters it has
 * (spaces, parentheses, non-ASCII). A line that does not have that shape is kept whole as its own label rather than dropped, so nothing a job is called can make it invisible.
 */
export function launchdFacts(printed: string): LaunchdFacts {
  const lines = printed.split("\n");
  const start = lines.findIndex((l) => l.trim() === "services = {");
  const labels: string[] = [];
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "}") break;
      if (line.trim() === "") continue;
      const m = /^\s*(?:-|\d+)\s+(?:-|-?\d+)\s+(.+?)\s*$/.exec(line);
      labels.push(m ? m[1] : line.trim());
    }
  }
  labels.sort();
  return { count: labels.length, labels: [...new Set(labels.map((l) => keyedHash(l, 16)))].sort(), block: keyedHash(labels.join("\n"), 16) };
}

/** The CLI's own global config. */
export const CLAUDE_JSON = "home:.claude.json";

const MAX_DATA_FILE = 64 * 1024 * 1024;

/** Reads the app's data files as untrusted input (regular files only, no links, size-capped) and reduces them to hashes. */
export function semanticFacts(
  resolve: (logical: string) => string,
  ids: { run: string; other: string },
  canaries: CanaryValues,
  options: { rootOf?: (logical: string) => string | undefined; transcriptDir?: string | null; backupsDir?: string | null; projectPath?: string } = {},
): SemanticFacts {
  const files: Record<string, DataFileFacts> = {};
  const disclosed = new Set<string>();
  const readLogical = (logical: string) => safeReadFile(resolve(logical), MAX_DATA_FILE, { root: options.rootOf?.(logical) });
  for (const logical of [...new Set([...APP_DATA_FILES, ...BRAND_TEMPLATE_FILES])]) {
    const read = readLogical(logical);
    if (!read.ok) {
      files[logical] = { status: read.reason, outsideRunSha: null, otherCarouselSha: null };
      continue;
    }
    for (const id of matchCanaries(read.data, canaries)) disclosed.add(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.data.toString("utf8"));
    } catch {
      files[logical] = { status: "unparsable", outsideRunSha: sha256(read.data), otherCarouselSha: null };
      continue;
    }
    files[logical] = {
      status: "ok",
      outsideRunSha: sha256(canonicalJson(stripCarousel(parsed, ids.run))),
      otherCarouselSha: sha256(canonicalJson(collectCarousel(parsed, ids.other))),
    };
  }
  // The CLI's own global config, read as root and reduced to classed facts; what it holds is never kept.
  let claudeJson: SemanticFacts["claudeJson"];
  const cj = readLogical(CLAUDE_JSON);
  if (!cj.ok) claudeJson = { status: cj.reason, facts: {} };
  else {
    for (const id of matchCanaries(cj.data, canaries)) disclosed.add(id);
    try {
      claudeJson = { status: "ok", facts: claudeJsonFacts(JSON.parse(cj.data.toString("utf8")), { scrub: (text) => scrubCanaries(text, canaries), projectPath: options.projectPath }) };
    } catch {
      claudeJson = { status: "unparsable", facts: {} };
    }
  }
  const transcripts = options.transcriptDir ? transcriptDigests(resolve, options.transcriptDir, options.rootOf?.(options.transcriptDir)) : undefined;
  const configCopies = options.backupsDir ? backupCopies(resolve, options.backupsDir, canaries, options.rootOf?.(options.backupsDir), options.projectPath) : undefined;
  return { files, disclosed: [...disclosed].sort(), claudeJson, ...(transcripts ? { transcripts } : {}), ...(configCopies && Object.keys(configCopies).length > 0 ? { configCopies } : {}) };
}

/**
 * The digests of the `*.jsonl` files directly in one project folder (a logical path), read as root: regular files only, never through a link, size-capped. A file that cannot be read safely has no digest,
 * and a window that needs one is inconclusive.
 */
export function transcriptDigests(resolve: (logical: string) => string, folder: string, root?: string): Record<string, TranscriptDigest> {
  const out: Record<string, TranscriptDigest> = {};
  const dir = resolve(folder);
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return out;
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().slice(0, 64);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) continue;
      const read = safeReadFile(file, MAX_TRANSCRIPT_BYTES, { root });
      if (!read.ok) continue;
      out[`${folder}/${name}`] = transcriptDigest(read.data, { ino: st.ino, dev: st.dev, nlink: st.nlink, mode: st.mode & 0o7777, uid: st.uid });
    } catch {
      // Unreadable: no digest.
    }
  }
  return out;
}

export { MAX_DIGEST_LINES };

/** The backups of the global config in one folder (a logical path), read as root without following links and reduced to classed facts, never to values. */
export function backupCopies(resolve: (logical: string) => string, folder: string, canaries: CanaryValues, root?: string, projectPath?: string): NonNullable<SemanticFacts["configCopies"]> {
  const out: NonNullable<SemanticFacts["configCopies"]> = {};
  const dir = resolve(folder);
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return out;
    names = readdirSync(dir).filter((n) => /^\.claude\.json\.backup\.\d{10,16}$/.test(n)).sort().slice(-16);
  } catch {
    return out;
  }
  for (const name of names) {
    const read = safeReadFile(path.join(dir, name), 64 * 1024 * 1024, { root });
    if (!read.ok) {
      out[`${folder}/${name}`] = { status: read.reason, sha256: null, facts: {} };
      continue;
    }
    try {
      out[`${folder}/${name}`] = { status: "ok", sha256: sha256(read.data), facts: claudeJsonFacts(JSON.parse(read.data.toString("utf8")), { scrub: (text) => scrubCanaries(text, canaries), projectPath }) };
    } catch {
      out[`${folder}/${name}`] = { status: "unparsable", sha256: sha256(read.data), facts: {} };
    }
  }
  return out;
}
