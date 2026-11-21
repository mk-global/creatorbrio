/**
 * Every process the observers saw start in the subject's machine, with its
 * parent (#225), and what that says about spend. The subject holds the model
 * token, so a run of the CLI binary that the app did not start may be a model
 * session of its own: it is flagged whatever it is called, and so is every
 * other run of it than the planned ones. On macOS the records come from
 * `eslogger`'s exec and fork events; on Linux from a read-only watcher that
 * shares the subject's process namespace. Pure, so the unit tests feed it
 * records.
 *
 * What may be expected is decided on one fact only, which the subject cannot
 * set: the exec's parent is the app server process, recorded by root before any
 * model phase (its pid, and that it already existed then). Everything else is
 * flagged; the other facts here (a CLI above it, the planned count, the window)
 * are only labels saying why, for the first paid run to calibrate. Nothing
 * here looks at a process's name or arguments.
 */
import type { Window } from "./judge";

export interface ProcRecord {
  at: number;
  pid: number;
  /** The parent when the process was first seen (macOS: `original_ppid`): never one it was reparented to, and kept across an exec in place. */
  ppid: number;
  /** The executable's path, when the observer knew it. */
  exe?: string;
  /** True when the process ran the CLI binary: by path, by code signature, or by size (a copy under another name included). */
  cli?: boolean;
  /** True for a record written because an already-running process changed its executable (`exec` in place). */
  execed?: boolean;
  /** When the process was first seen gone (the observers' exit record), for triage; absent when none was seen. */
  exitAt?: number;
}

/** What the observer knows about the CLI binary, to recognize it by more than its name. */
export interface CliIdentity {
  /** The resolved path of the installed binary. */
  path: string;
  /** Its size in bytes: a byte-for-byte copy has the same one, and so does a copy that was only re-signed. */
  size: number;
  /** macOS: the code directory hash, which a copy keeps. */
  cdhash?: string;
}

/**
 * Whether a process that started is the CLI binary: its path is the installed
 * one, its code signature is, or its executable has the installed binary's
 * size. A flag is cheaper than a missed model session, so a size alone counts:
 * no other program is exactly that many bytes.
 */
export function isCliBinary(p: { path?: string; size?: number; cdhash?: string }, cli: CliIdentity): boolean {
  if (p.path && p.path === cli.path) return true;
  if (p.cdhash && cli.cdhash && p.cdhash.toLowerCase() === cli.cdhash.toLowerCase()) return true;
  return p.size !== undefined && p.size === cli.size;
}

/** The app server, as root recorded it before any model phase: the process holding the app's port then, and what started the app (the launcher on macOS, the container's init on Linux). */
export interface AppServer {
  pid: number;
  /** Epoch ms of the host's listing that recorded it: a process that existed then has a record at or before this time. */
  at: number;
  /** The launcher's or init's pid the server was verified to descend from, or null when that could not be verified (then nothing is expected). */
  root: number | null;
  verified: boolean;
}

/** The latest record for a pid that was seen at or before `at`: pids are reused, so a record is only about the pid as it was then. */
function recordFor(byPid: Map<number, ProcRecord[]>, pid: number, at: number): ProcRecord | undefined {
  const list = byPid.get(pid);
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].at <= at) return list[i];
  return undefined;
}

const indexOf = (procs: ProcRecord[]) => {
  const byPid = new Map<number, ProcRecord[]>();
  for (const r of [...procs].sort((a, b) => a.at - b.at)) byPid.set(r.pid, [...(byPid.get(r.pid) ?? []), r]);
  return byPid;
};

/** The chain of records from a process up through its recorded parents, for the record of a CLI run. */
export function ancestry(procs: ProcRecord[], p: ProcRecord, limit = 32): { pid: number; exe?: string; cli: boolean }[] {
  const byPid = indexOf(procs);
  const out: { pid: number; exe?: string; cli: boolean }[] = [];
  let cur: ProcRecord | undefined = p;
  for (let i = 0; i < limit && cur; i++) {
    // Every ancestor is the record it had when the run started: a pid reused since is another process.
    const parent: ProcRecord | undefined = recordFor(byPid, cur.ppid, p.at);
    if (!parent) break;
    out.push({ pid: parent.pid, ...(parent.exe ? { exe: parent.exe } : {}), cli: Boolean(parent.cli) });
    cur = parent;
  }
  return out;
}

/**
 * The pids that descend, by their recorded parents, from any of the roots (the roots included), as root saw the process tree at `until`: the app server's tree in a model window, the control's counted
 * runs of the CLI in the control window. A pid reused later is another process, so only the record that was current at `until` counts.
 */
export function treeOf(procs: ProcRecord[], roots: number[], until: number): number[] {
  const byPid = indexOf(procs);
  const rootSet = new Set(roots);
  const out = new Set(roots);
  for (const pid of byPid.keys()) {
    let cur = recordFor(byPid, pid, until);
    for (let i = 0; i < 64 && cur; i++) {
      if (rootSet.has(cur.ppid)) {
        out.add(pid);
        break;
      }
      cur = recordFor(byPid, cur.ppid, until);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export type CliLabel = "not_app_server_child" | "cli_ancestor" | "outside_model_window" | "beyond_planned_count" | "beyond_control_count" | "app_unverified";

export interface CliRun {
  at: number;
  pid: number;
  ppid: number;
  exe?: string;
  execed: boolean;
  /** When the run was first seen gone, for triage (absent when no exit was seen). */
  exitAt?: number;
  /** The window the run started in, or null. */
  window: string | null;
  /** True when the process had been running as something else for at least half a second before it became the CLI (an exec in place after a delay). */
  delayedExec: boolean;
  /** The chain of parents, nearest first. */
  chain: { pid: number; exe?: string; cli: boolean }[];
  /** Why it is not an expected run; empty only for the planned runs the app started. */
  labels: CliLabel[];
}

export interface CliVerdict {
  /** The runs the app itself started, within the plan: never flagged. */
  expected: CliRun[];
  /** Runs in a control window: the control starts some on purpose, as the proof the check sees them. */
  inControl: CliRun[];
  /** Every other run: flagged for founder review. */
  flagged: CliRun[];
  /** Every run, in order, for the record. */
  all: CliRun[];
}

/**
 * Judges every run of the CLI binary. A run is expected only when its parent is
 * the app server process (the one root recorded before any model phase), it has
 * no CLI above it, it started in a model window, and the window has not already
 * had the planned number of distinct runs. A run in a control window is counted
 * apart; every other run is flagged. A process that is seen twice (an exec in
 * place) is one run.
 */
export function judgeCliRuns(procs: ProcRecord[], ctx: { app: AppServer | null; windows: Window[]; plannedPerWindow: number; controlRuns?: number }): CliVerdict {
  const byPid = indexOf(procs);
  const windowOf = (at: number) => ctx.windows.find((w) => at >= w.start && at < w.end) ?? null;
  const firstByPid = new Map<string, ProcRecord>();
  for (const p of [...procs].sort((a, b) => a.at - b.at)) {
    if (!p.cli) continue;
    // One run per process: the first record that shows it as the CLI, which stands for its later sightings.
    const key = `${p.pid}|${p.ppid}`;
    if (!firstByPid.has(key)) firstByPid.set(key, p);
  }
  const perWindow = new Map<string, number>();
  const out: CliVerdict = { expected: [], inControl: [], flagged: [], all: [] };
  for (const p of [...firstByPid.values()].sort((a, b) => a.at - b.at)) {
    const w = windowOf(p.at);
    const chain = ancestry(procs, p);
    const labels: CliLabel[] = [];
    const parent = recordFor(byPid, p.ppid, p.at);
    // The one fact: the parent is the app server, a process that already existed when root recorded it.
    const appParent = Boolean(ctx.app && ctx.app.verified && p.ppid === ctx.app.pid && parent && parent.at <= ctx.app.at);
    if (!ctx.app || !ctx.app.verified) labels.push("app_unverified");
    if (!appParent) labels.push("not_app_server_child");
    if (chain.some((c) => c.cli)) labels.push("cli_ancestor");
    if (w?.kind !== "model") labels.push("outside_model_window");
    const before = (byPid.get(p.pid) ?? []).filter((r) => r.at < p.at && !r.cli);
    const delayedExec = before.length > 0 && p.at - before[0].at >= 500;
    const run: CliRun = { at: p.at, pid: p.pid, ppid: p.ppid, ...(p.exe ? { exe: p.exe } : {}), execed: Boolean(p.execed), ...(p.exitAt !== undefined ? { exitAt: p.exitAt } : {}), delayedExec, window: w?.phase ?? null, chain, labels };
    if (labels.length === 0) {
      const n = (perWindow.get(w?.phase ?? "") ?? 0) + 1;
      perWindow.set(w?.phase ?? "", n);
      if (n > ctx.plannedPerWindow) run.labels.push("beyond_planned_count");
    }
    out.all.push(run);
    if (run.labels.length === 0) out.expected.push(run);
    else if (w?.kind === "control") {
      // The control starts a known number of runs; any more than that, even there, is flagged.
      if (ctx.controlRuns !== undefined && out.inControl.length >= ctx.controlRuns) {
        run.labels.push("beyond_control_count");
        out.flagged.push(run);
      } else out.inControl.push(run);
    } else out.flagged.push(run);
  }
  return out;
}
