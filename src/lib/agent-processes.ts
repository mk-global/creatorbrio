/**
 * The contained Design Agent's processes (#241).
 *
 * The CLI is started as the leader of its own process group, so a terminal's
 * Ctrl-C never reaches it directly and the server decides when it stops. The
 * CLI starts each shell command in a group of its own, and on macOS a process
 * a command leaves in the background can outlive the CLI (on Linux the
 * sandbox's process namespace ends them with it). So whenever a run is
 * stopped, times out, ends, or the server shuts down, the server stops:
 *
 * - the CLI's own group;
 * - every group it saw among the CLI's descendants when it signalled the CLI;
 * - every process still descended from the CLI;
 * - every process whose working folder is inside one of the run's folders,
 *   with its descendants, which is how a command's orphaned background
 *   process is found once the CLI has exited.
 *
 * It sends SIGTERM, waits a bounded time, then sends SIGKILL to what is left.
 * At server shutdown it sends SIGKILL at once, because the development
 * server's supervisor ends the server process about 100 ms after the signal.
 *
 * Only this user's processes are signalled, never the server itself, its own
 * process group or anything it descends from. A process that leaves the run's
 * folders and its groups and detaches from the CLI is not found: on macOS it
 * keeps running under the run's sandbox rules, whose write rules follow the
 * paths of folders the server moves into quarantine and never reuses, so it
 * cannot write into a later conversation. The boundary that would stop it is
 * a separate operating-system account or a virtual machine
 * (docs/architecture/design-agent.md).
 */
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
}

/** Reads `ps -A -o pid=,ppid=,pgid=,uid=` output. */
export function parsePsTable(output: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]) });
  }
  return out;
}

/** Reads `lsof -a -d cwd -u <uid> -Fpn` output as process id to working folder. */
export function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** Reads one `/proc/<pid>/stat` line; the command name may hold spaces and parentheses. */
export function parseProcStat(text: string): { ppid: number; pgid: number } | null {
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  return Number.isInteger(ppid) && Number.isInteger(pgid) ? { ppid, pgid } : null;
}

/** How the server sees processes: the process table, and working folders of this user's processes. */
export interface ProcessProbe {
  list(): Promise<ProcessEntry[]>;
  cwds(uid: number): Promise<Map<number, string>>;
  listSync(): ProcessEntry[];
  cwdsSync(uid: number): Map<number, string>;
}

const PROBE_TIMEOUT_MS = 5_000;

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout) => resolve(typeof stdout === "string" ? stdout : ""));
  });
}

function runSync(command: string, args: string[], timeout: number): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    // lsof exits 1 when it finds nothing, still printing what it found.
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,uid="];
const lsofArgs = (uid: number) => ["-w", "-a", "-d", "cwd", "-u", String(uid), "-Fpn"];

/** macOS (and other systems with ps and lsof). */
export const psProbe: ProcessProbe = {
  list: async () => parsePsTable(await run("ps", PS_ARGS)),
  cwds: async (uid) => parseLsofCwds(await run("lsof", lsofArgs(uid))),
  listSync: () => parsePsTable(runSync("ps", PS_ARGS, 2_000)),
  cwdsSync: (uid) => parseLsofCwds(runSync("lsof", lsofArgs(uid), 2_000)),
};

function procList(): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
      const uid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${name}/status`, "utf8"))?.[1]);
      if (stat && Number.isInteger(uid)) out.push({ pid: Number(name), ...stat, uid });
    } catch {
      // Gone, or not ours to inspect.
    }
  }
  return out;
}

function procCwds(uid: number): Map<number, string> {
  const cwds = new Map<number, string>();
  for (const entry of procList()) {
    if (entry.uid !== uid) continue;
    try {
      cwds.set(entry.pid, readlinkSync(`/proc/${entry.pid}/cwd`));
    } catch {
      // Gone, or not readable.
    }
  }
  return cwds;
}

/** Linux, from /proc. */
export const procProbe: ProcessProbe = {
  list: async () => procList(),
  cwds: async (uid) => procCwds(uid),
  listSync: procList,
  cwdsSync: procCwds,
};

const noProbe: ProcessProbe = {
  list: async () => [],
  cwds: async () => new Map(),
  listSync: () => [],
  cwdsSync: () => new Map(),
};

export function defaultProbe(platform: NodeJS.Platform = process.platform): ProcessProbe {
  if (platform === "linux") return procProbe;
  if (platform === "win32") return noProbe;
  return psProbe;
}

/** What a run's processes are known by. */
export interface RunIdentity {
  leaderPid: number;
  /** The run's folders: a process working inside one of them belongs to the run. */
  folders: readonly string[];
  /** Groups seen among the CLI's descendants while it was alive. */
  groups: ReadonlySet<number>;
  /** Processes seen as the CLI's descendants while it was alive. */
  known: ReadonlySet<number>;
}

export interface Targets {
  groups: number[];
  pids: number[];
}

const inside = (dir: string, folders: readonly string[]) => folders.some((f) => dir === f || dir.startsWith(f + path.sep));

/**
 * The groups and processes that belong to a run, from one look at the system.
 * Pure, so every case is testable. `self` is the server: neither it, its own
 * group, nor anything it descends from is ever a target.
 */
export function runTargets(input: {
  run: RunIdentity;
  procs: readonly ProcessEntry[];
  cwds: ReadonlyMap<number, string>;
  uid: number;
  self: { pid: number; pgid: number };
}): Targets {
  const own = input.procs.filter((p) => p.uid === input.uid);
  const byPid = new Map(own.map((p) => [p.pid, p]));
  const children = new Map<number, ProcessEntry[]>();
  for (const p of own) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const protectedPids = new Set<number>([0, 1]);
  for (let p: ProcessEntry | undefined = byPid.get(input.self.pid), guard = 0; p && guard < 4096; p = byPid.get(p.ppid), guard++) protectedPids.add(p.pid);
  protectedPids.add(input.self.pid);

  const roots = [input.run.leaderPid];
  for (const [pid, cwd] of input.cwds) if (inside(cwd, input.run.folders) && byPid.has(pid)) roots.push(pid);
  const pids = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (pids.has(pid) || protectedPids.has(pid)) continue;
    if (pid !== input.run.leaderPid && !byPid.has(pid)) continue;
    pids.add(pid);
    for (const child of children.get(pid) ?? []) queue.push(child.pid);
  }
  // A group is signalled only while one of its members is known to be the
  // run's, so a group number the system has since given to another process
  // group is never signalled. Without a process table (the probe failed),
  // the CLI's own group is still signalled.
  const known = new Set<number>([input.run.leaderPid, ...input.run.known, ...pids]);
  const members = new Map<number, number[]>();
  for (const p of own) members.set(p.pgid, [...(members.get(p.pgid) ?? []), p.pid]);
  const candidates = new Set<number>([input.run.leaderPid, ...input.run.groups]);
  for (const pid of pids) {
    const pgid = byPid.get(pid)?.pgid;
    if (pgid !== undefined) candidates.add(pgid);
  }
  const groups = [...candidates].filter(
    (g) =>
      g > 1 &&
      g !== input.self.pgid &&
      !protectedPids.has(g) &&
      ((members.get(g) ?? []).some((m) => known.has(m)) || (input.procs.length === 0 && g === input.run.leaderPid))
  );
  // The leader is signalled through its group; a pid listed here is one that may have left it.
  pids.delete(input.run.leaderPid);
  return { groups: groups.sort((a, b) => a - b), pids: [...pids].sort((a, b) => a - b) };
}

function send(target: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    // Gone (ESRCH), or not ours (EPERM): nothing to do either way.
    return false;
  }
}

function signalTargets(t: Targets, signal: NodeJS.Signals): void {
  for (const g of t.groups) send(-g, signal);
  for (const p of t.pids) send(p, signal);
}

function remaining(t: Targets): Targets {
  return { groups: t.groups.filter((g) => send(-g, 0)), pids: t.pids.filter((p) => send(p, 0)) };
}

const isEmpty = (t: Targets) => t.groups.length === 0 && t.pids.length === 0;

function merge(a: Targets, b: Targets): Targets {
  return { groups: [...new Set([...a.groups, ...b.groups])], pids: [...new Set([...a.pids, ...b.pids])] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server's own process group, which is never signalled. */
function selfIdentity(procs: readonly ProcessEntry[]): { pid: number; pgid: number } {
  return { pid: process.pid, pgid: procs.find((p) => p.pid === process.pid)?.pgid ?? process.pid };
}

export interface StopReport {
  /** Processes and groups found and signalled. */
  found: number;
  /** Still present after SIGKILL and the bounded wait. */
  left: number;
}

/**
 * Stops everything a run left: SIGTERM, up to `graceMs` for it to go, then
 * SIGKILL and up to `killWaitMs` more. Bounded however the processes behave.
 */
export async function stopRunProcesses(
  run: RunIdentity,
  options: { graceMs?: number; killWaitMs?: number; probe?: ProcessProbe; uid?: number } = {}
): Promise<StopReport> {
  const probe = options.probe ?? defaultProbe();
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const look = async () => {
    const [procs, cwds] = await Promise.all([probe.list().catch(() => []), probe.cwds(uid).catch(() => new Map<number, string>())]);
    return remaining(runTargets({ run, procs, cwds, uid, self: selfIdentity(procs) }));
  };
  let targets = await look();
  if (isEmpty(targets)) return { found: 0, left: 0 };
  const found = targets.groups.length + targets.pids.length;
  signalTargets(targets, "SIGTERM");
  const waitGone = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      targets = remaining(targets);
      if (isEmpty(targets)) return;
      await sleep(50);
    }
  };
  await waitGone(options.graceMs ?? 2_000);
  // Anything that started meanwhile is stopped too.
  targets = merge(remaining(targets), await look());
  if (!isEmpty(targets)) {
    signalTargets(targets, "SIGKILL");
    await waitGone(options.killWaitMs ?? 1_000);
  }
  targets = remaining(targets);
  return { found, left: targets.groups.length + targets.pids.length };
}

interface LiveRun {
  run: { leaderPid: number; folders: readonly string[]; groups: Set<number>; known: Set<number> };
  abort: () => void;
}

const REGISTRY_KEY = Symbol.for("creatorbrio.agent-processes");

function registry(): Map<number, LiveRun> {
  const store = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<number, LiveRun> };
  store[REGISTRY_KEY] ??= new Map();
  return store[REGISTRY_KEY];
}

/** How many contained runs' processes the server is tracking. */
export function liveRunCount(): number {
  return registry().size;
}

export interface TrackedRun {
  /**
   * Signals the CLI's group and every group among its descendants, recording
   * those groups so they are stopped again after the CLI exits.
   */
  signal(signal: NodeJS.Signals): void;
  /** After the CLI has exited: stops whatever the run left, then stops tracking it. */
  stop(): Promise<StopReport>;
}

/**
 * Tracks one contained run's processes from the moment its CLI is spawned,
 * so the run's stop, its end and the server's shutdown all reach them.
 * `abort` ends the run as a stop does.
 */
export function trackRun(input: { leaderPid: number; folders: readonly string[]; abort: () => void; probe?: ProcessProbe }): TrackedRun {
  const probe = input.probe ?? defaultProbe();
  const live: LiveRun = { run: { leaderPid: input.leaderPid, folders: [...input.folders], groups: new Set(), known: new Set() }, abort: input.abort };
  registry().set(input.leaderPid, live);
  installShutdownHook();
  let stopped: Promise<StopReport> | null = null;
  return {
    signal(signal) {
      let procs: ProcessEntry[] = [];
      try {
        procs = probe.listSync();
      } catch {
        // The CLI's own group is still signalled.
      }
      const uid = process.getuid?.() ?? 0;
      const t = runTargets({ run: live.run, procs, cwds: new Map(), uid, self: selfIdentity(procs) });
      for (const g of t.groups) live.run.groups.add(g);
      for (const p of t.pids) live.run.known.add(p);
      signalTargets(t, signal);
    },
    stop() {
      stopped ??= stopRunProcesses(live.run, { probe }).finally(() => {
        if (registry().get(input.leaderPid) === live) registry().delete(input.leaderPid);
      });
      return stopped;
    },
  };
}

/**
 * The server is shutting down: ends every live contained run and stops its
 * processes at once with SIGKILL, synchronously, so it completes before the
 * process exits. Returns how many runs it ended.
 */
export function shutdownLiveRuns(probe: ProcessProbe = defaultProbe()): number {
  const lives = [...registry().values()];
  if (lives.length === 0) return 0;
  const uid = process.getuid?.() ?? 0;
  // The process table first: the CLI's descendants are found only while it lives.
  let procs: ProcessEntry[] = [];
  try {
    procs = probe.listSync();
  } catch {
    // The groups are still signalled.
  }
  for (const live of lives) {
    try {
      live.abort();
    } catch {
      // The processes are stopped below whatever the run does.
    }
    signalTargets(runTargets({ run: live.run, procs, cwds: new Map(), uid, self: selfIdentity(procs) }), "SIGKILL");
  }
  // Then what works in the runs' folders, which outlived their commands.
  try {
    const after = probe.listSync();
    const cwds = probe.cwdsSync(uid);
    for (const live of lives) signalTargets(runTargets({ run: live.run, procs: after, cwds, uid, self: selfIdentity(after) }), "SIGKILL");
  } catch {
    // Best effort within the shutdown.
  }
  return lives.length;
}

/** The minimal process surface the shutdown hook needs, so tests can drive it. */
export interface HookedProcess {
  pid: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: string): number;
  kill(pid: number, signal?: NodeJS.Signals): unknown;
}

const HOOKED = Symbol.for("creatorbrio.agent-processes.hooked");

/**
 * Stops live contained runs when the server receives SIGTERM or SIGINT, and
 * kills their groups if the process exits any other way. Installed once per
 * process. Next.js has its own handlers for both signals, which end the
 * server; where none is installed, this handler re-raises the signal after
 * its work so the default termination still happens.
 */
export function installShutdownHook(proc: HookedProcess = process as unknown as HookedProcess, probe?: ProcessProbe): void {
  if (proc === (process as unknown as HookedProcess) && !isMainThread) return;
  const marked = proc as HookedProcess & { [HOOKED]?: true };
  if (marked[HOOKED]) return;
  marked[HOOKED] = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => {
      const ended = shutdownLiveRuns(probe);
      if (ended > 0) console.error("[design-agent] the server is stopping; its live design runs were stopped", { runs: ended, signal });
      if (proc.listenerCount(signal) === 1) {
        proc.removeListener(signal, handler);
        proc.kill(proc.pid, signal);
      }
    };
    proc.on(signal, handler);
  }
  proc.on("exit", () => {
    for (const live of registry().values()) {
      // No process table here: only the CLI's own group, which exists while it or a member lives.
      if (live.run.leaderPid > 1) send(-live.run.leaderPid, "SIGKILL");
    }
  });
}
