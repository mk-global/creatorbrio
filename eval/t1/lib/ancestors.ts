/**
 * The proof that the subject cannot write where a reader reads outside every watched root (round 7), from root's own facts. A folder is closed when it is a real directory (not a link) owned by root, with
 * no group or other write bit, no ACL (any ACL, or one that could not be read, is a gap this module does not interpret: an `allow` entry could grant what the mode denies) and no flag it does not know, and when
 * it holds no entry a reader reads. Every ancestor of every watched root, root included, is such a folder, and so is every parent of a system path a reader reads (managed settings, the system's shell startup
 * files), which must itself be owned by root and not writable by anyone else. On Linux the subject's root file system must also be read-only, which Docker says and the subject cannot change.
 *
 * The facts are taken as root, never by the subject: on macOS in the VM over SSH, on Linux by `docker exec` as root into the subject's container. One script (`COLLECT_SCRIPT`, plain JavaScript run by `node -e`)
 * takes them on both, and everything that interprets them is here, pure, so the unit tests feed it facts.
 */
import { execFileSync } from "node:child_process";
import type { Platform } from "./catalog";
import { ancestorDirs, nameMatches, provedSystemPaths, rootAncestorDirs } from "./readers";

export interface DirFacts {
  path: string;
  type: "dir" | "file" | "symlink" | "socket" | "other" | "missing";
  uid: number;
  gid: number;
  /** The permission bits, including the sticky, setuid and setgid bits. */
  mode: number;
  ino: number;
  ctimeMs: number;
  /** BSD file flags as `ls -O` prints them (comma separated), or null when there are none or the platform has none. */
  flags: string | null;
  /** Whether the entry has an ACL; null when it could not be read (never taken for no). */
  acl: boolean | null;
  /** The names in the folder that a reader reads (as spelled on disk); empty for a file. */
  entries: string[];
}

/** The flags that only restrict, which an ancestor may carry (the system volume's `/` and `/Library` are `sunlnk`, `/private` is `sunlnk,hidden`, `/usr` is `restricted`; a file may be `compressed`). Any other token is a gap. */
const SAFE_FLAGS = new Set(["restricted", "hidden", "nodump", "schg", "uchg", "sappnd", "uappnd", "opaque", "compressed", "dataless", "tracked", "sunlnk"]);

/** Plain JavaScript, run by `node -` (the script on standard input) with `T1_FACTS_ARG` in the environment: `{"paths": [...], "platform": "linux"|"macos"}`. Prints a JSON array of raw facts, one per path; nothing here decides anything. */
export const COLLECT_SCRIPT = `
const fs = require("node:fs");
const cp = require("node:child_process");
const arg = JSON.parse(process.env.T1_FACTS_ARG);
const mac = process.platform === "darwin";
const out = [];
for (const p of arg.paths) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { out.push({ path: p, type: "missing" }); continue; }
  const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSocket() ? "socket" : "other";
  let names = null;
  if (type === "dir") { try { names = fs.readdirSync(p); if (names.length > 20000) names = null; } catch (e) { names = null; } }
  let ls = null;
  try { ls = cp.execFileSync("/bin/ls", mac ? ["-ldeO", p] : ["-ld", p], { encoding: "utf8", timeout: 10000 }); } catch (e) { ls = null; }
  out.push({ path: p, type, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777, ino: st.ino, ctimeMs: Math.round(st.ctimeMs), names, ls, lsKind: mac ? "bsd" : "gnu" });
}
process.stdout.write(JSON.stringify(out));
`;

export interface RawFacts {
  path: string;
  type: DirFacts["type"];
  uid?: number;
  gid?: number;
  mode?: number;
  ino?: number;
  ctimeMs?: number;
  names?: string[] | null;
  ls?: string | null;
  lsKind?: "bsd" | "gnu";
}

/**
 * Flags and ACL from `ls -ld` (GNU) or `ls -ldeO` (BSD) output. On BSD the numbered ACL lines are read: a `deny` entry only takes access away, so only an `allow` entry (or an ACL marked on the mode whose
 * entries were not listed) is an ACL here; GNU's `ls` shows only the `+`, which is taken as one. The fifth column of BSD output is the flags.
 */
export function parseLs(ls: string | null | undefined, kind: "bsd" | "gnu" | undefined): { flags: string | null; acl: boolean | null } {
  if (!ls) return { flags: null, acl: null };
  const lines = ls.split("\n").filter((l) => l.trim() !== "");
  const first = lines[0] ?? "";
  const cols = first.trim().split(/\s+/);
  if (!/^[-dlbcps][-rwxsStT?]{9}[+@.]?$/.test(cols[0] ?? "")) return { flags: null, acl: null };
  const entries = lines.slice(1).filter((l) => /^\s*\d+: /.test(l));
  let acl: boolean;
  if (kind === "bsd" && entries.length > 0) acl = entries.some((l) => /\ballow\b/.test(l) || !/\b(allow|deny)\b/.test(l));
  else acl = cols[0].endsWith("+");
  let flags: string | null = null;
  if (kind === "bsd") {
    const f = cols[4];
    flags = f && f !== "-" ? f : null;
  }
  return { flags, acl };
}

/** Raw facts as the record keeps them: the entries are the names a reader reads. */
export function factsFromRaw(raw: RawFacts[], names: string[], platform: Platform): DirFacts[] {
  return raw.map((r) => {
    if (r.type === "missing" || r.uid === undefined) return { path: r.path, type: "missing" as const, uid: -1, gid: -1, mode: 0, ino: 0, ctimeMs: 0, flags: null, acl: null, entries: [] };
    const { flags, acl } = parseLs(r.ls, r.lsKind);
    // A folder whose names could not be listed is not one that holds none: it is a gap, which the verdict reads from `entries` being null in the record (kept as a marker entry that is never a real name).
    const listed = r.type === "dir" ? (r.names ?? null) : [];
    return {
      path: r.path,
      type: r.type,
      uid: r.uid,
      gid: r.gid ?? -1,
      mode: r.mode ?? 0,
      ino: r.ino ?? 0,
      ctimeMs: r.ctimeMs ?? 0,
      flags,
      acl,
      entries: listed === null ? ["\u0000unlisted"] : listed.filter((n) => nameMatches(n, names, platform)).sort(),
    };
  });
}

/** Runs the collector locally (the unit tests); a runner on another machine runs `COLLECT_SCRIPT` there (as root, over SSH or `docker exec`) and calls `factsFromRaw`. */
export function collectFacts(
  paths: string[],
  names: string[],
  platform: Platform,
  run: (script: string, arg: string) => string = (script, arg) => execFileSync(process.execPath, ["-"], { input: script, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, T1_FACTS_ARG: arg } }),
): DirFacts[] {
  const raw = JSON.parse(run(COLLECT_SCRIPT, JSON.stringify({ paths, platform }))) as RawFacts[];
  return factsFromRaw(raw, names, platform);
}

const writableByOthers = (f: DirFacts) => (f.mode & 0o022) !== 0;

function dirProblem(f: DirFacts | undefined, p: string, walked: boolean): string | null {
  if (!f) return `no root listing of ${p}, so it is not proved closed`;
  if (f.type === "missing") return `${p} does not exist, so it is not proved closed`;
  if (f.type !== "dir") return `${p} is a ${f.type}, not a real folder`;
  if (f.uid !== 0) return `${p} is owned by uid ${f.uid}, not root`;
  if (writableByOthers(f)) return `${p} is writable by its group or by others (mode ${f.mode.toString(8)})`;
  if (f.acl !== false) return `${p} ${f.acl === null ? "had no ACL reading" : "has an ACL"} (an ACL is a gap this check does not interpret)`;
  if (f.flags && f.flags.split(",").some((t) => !SAFE_FLAGS.has(t.trim()))) return `${p} carries a file flag the check does not know (${f.flags})`;
  // Only a folder a reader walks (an ancestor of a watched root) must hold no entry a reader reads; the parent of a system path only has to be closed (`/usr/local/lib` holds the global `node_modules`, which nothing reads from there).
  if (walked && f.entries.length > 0) return `${p} holds ${f.entries.some((e) => e.startsWith("\u0000")) ? "names that could not be listed" : `an entry a reader reads (${f.entries.slice(0, 4).join(", ")})`}`;
  return null;
}

function targetProblem(f: DirFacts | undefined, p: string): string | null {
  // A path that is not there cannot be written to the subject's ends while every folder above it is closed (checked separately).
  if (!f) return `no root listing of ${p}`;
  if (f.type === "missing") return null;
  if (f.type === "symlink" || f.type === "socket" || f.type === "other") return `${p} is a ${f.type}`;
  if (f.uid !== 0) return `${p} is owned by uid ${f.uid}, not root`;
  if (writableByOthers(f)) return `${p} is writable by its group or by others (mode ${f.mode.toString(8)})`;
  if (f.acl !== false) return `${p} ${f.acl === null ? "had no ACL reading" : "has an ACL"}`;
  return null;
}

export interface AncestorProof {
  checks: { check: string; ok: boolean; detail: string }[];
}

/** The proof as checks: one per closed folder, one per system path, and on Linux the read-only root file system. */
export function ancestorChecks(facts: DirFacts[], o: { platform: Platform; readOnlyRootfs?: boolean | null }): AncestorProof["checks"] {
  const by = new Map(facts.map((f) => [f.path, f]));
  const checks: AncestorProof["checks"] = [];
  const walked = new Set(rootAncestorDirs(o.platform));
  for (const p of ancestorDirs(o.platform)) {
    const problem = dirProblem(by.get(p), p, walked.has(p));
    checks.push({ check: walked.has(p) ? `ancestor of a watched root ${p} is a closed folder owned by root` : `parent of a system path ${p} is a closed folder owned by root`, ok: problem === null, detail: problem ?? (walked.has(p) ? "a real folder, owned by root, not writable by group or others, no ACL, no reader-named entry" : "a real folder, owned by root, not writable by group or others, no ACL") });
  }
  for (const p of provedSystemPaths(o.platform)) {
    const problem = targetProblem(by.get(p), p);
    checks.push({ check: `managed or system path ${p} is root-owned and not writable by the subject`, ok: problem === null, detail: problem ?? (by.get(p)?.type === "missing" ? "absent, under closed folders" : "owned by root, not writable by group or others, no ACL") });
  }
  if (o.platform === "linux") {
    const ok = o.readOnlyRootfs === true;
    checks.push({ check: "the subject's root file system is read-only (ancestor of every watched root)", ok, detail: o.readOnlyRootfs === true ? "Docker reports ReadonlyRootfs" : o.readOnlyRootfs === false ? "Docker reports it writable" : "Docker's answer was not read" });
  }
  return checks;
}

/** The paths root must take facts of: every closed folder and every system path. */
export const proofPaths = (platform: Platform): string[] => [...new Set([...ancestorDirs(platform), ...provedSystemPaths(platform)])].sort();

export interface AncestorChange {
  path: string;
  why: string;
}

/**
 * What changed in the closed folders between two root listings: any change of identity, owner, mode, flags or ACL, and any reader-named entry that was not there. The status-change time is recorded with every
 * listing but not judged alone: it moves whenever anything is added to or removed from a folder (the system does that to `/` by itself), and what matters about an addition is its name, which is judged.
 */
export function ancestorChanges(before: DirFacts[], after: DirFacts[], walked?: ReadonlySet<string>): AncestorChange[] {
  const b = new Map(before.map((f) => [f.path, f]));
  const out: AncestorChange[] = [];
  for (const a of after) {
    const o = b.get(a.path);
    const reads = !walked || walked.has(a.path);
    if (!o) {
      if (reads && a.entries.length > 0) out.push({ path: a.path, why: "a reader-named entry in a folder that was not listed before" });
      continue;
    }
    const changed: string[] = [];
    if (o.type !== a.type) changed.push(`changed from a ${o.type} to a ${a.type}`);
    if (o.ino !== a.ino) changed.push("replaced by another folder");
    if (o.uid !== a.uid || o.gid !== a.gid) changed.push("its owner changed");
    if (o.mode !== a.mode) changed.push("its mode changed");
    if (o.flags !== a.flags) changed.push("its flags changed");
    if (o.acl !== a.acl) changed.push("its ACL changed");
    const gained = reads ? a.entries.filter((e) => !o.entries.includes(e)) : [];
    if (gained.length > 0) changed.push(`gained ${gained.length} reader-named entr${gained.length === 1 ? "y" : "ies"} (${gained.slice(0, 4).join(", ")})`);
    for (const why of changed) out.push({ path: a.path, why });
  }
  return out;
}
