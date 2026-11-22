/**
 * The contained Design Agent's processes (#241).
 *
 * The CLI is started as the leader of its own process group, so a terminal's
 * Ctrl-C never reaches it directly and the server decides when it stops. The
 * CLI starts each shell command in a group of its own, and on macOS a process
 * a command leaves in the background can outlive the CLI (on Linux the
 * sandbox's process namespace ends them with it).
 *
 * While a run is live the server reads the process table periodically (the
 * process table only, never a listing of working folders) and records every
 * process descended from the CLI, or from a process it recorded, with its start
 * time and its group. Start times are read in one fixed time zone and locale,
 * so the same process always has the same start. A recorded process or group is
 * signalled later only while a member with the same id and start time is still
 * there, so an id the system has since reused is never hit; the one exception
 * is the server's shutdown, below.
 *
 * Whenever a run is stopped, times out or ends, the server stops, with SIGTERM,
 * a bounded wait, then SIGKILL:
 *
 * - the CLI's own group;
 * - every recorded group and process, with what is descended from them;
 * - every process still descended from the CLI;
 * - every process whose working folder is inside one of the run's folders and
 *   that has no controlling terminal, with its descendants, which is how a
 *   command's orphaned background process is found once the CLI has exited.
 *   Such a process's group is signalled only when the run recorded it, or
 *   when the process leads it; a person's own shell, which has a terminal,
 *   is never taken for the run's, nor is a group that has such a member.
 *
 * When the server shuts down it sends SIGKILL at once, because the development
 * server's supervisor ends the server process about 100 ms after the signal.
 * Within that time it kills the CLI's group before reading anything, then
 * everything the run recorded in a look that is only seconds old (an id could
 * be reused in that time only if the system cycled through every process id),
 * then reads the process table once, verifies the older records by start time
 * and kills those and what is descended from them. It lists no working folders (that takes several times longer than the
 * window). A process that only works in the run's folders and was never seen is
 * stopped by the next start's sweep (`stopStrayProcesses`); one that was never
 * seen and does not work there is the residual below.
 *
 * The CLI's process id is the run's only while it is the same process: its
 * start time is recorded when it is spawned, so an id the system has since
 * reused is never signalled.
 *
 * Only this user's processes are signalled, never the server itself, its own
 * process group or anything it descends from. A process that was never
 * recorded and leaves the run's folders and its groups and detaches from the
 * CLI is not found: on macOS it keeps running under the run's sandbox rules,
 * whose write rules follow the paths of folders the server moves into
 * quarantine, so it cannot write into a later conversation. The boundary that
 * would stop it is a separate operating-system account or a virtual machine
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
  /** Whether it has a controlling terminal: then it is a person's, never taken for a run's by its folder. */
  tty: boolean;
  /** When it started, as the system prints it: with the id, which process this is. */
  start: string;
}

/** Reads `ps -A -o pid=,ppid=,pgid=,uid=,tty=,lstart=` output; a tty of `??` or `?` is none. */
export function parsePsTable(output: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), tty: m[5] !== "??" && m[5] !== "?", start: m[6] });
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
export function parseProcStat(text: string): { ppid: number; pgid: number; tty: boolean; start: string } | null {
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const ttyNr = Number(fields[4]);
  const start = fields[19];
  return Number.isInteger(ppid) && Number.isInteger(pgid) && Number.isInteger(ttyNr) && start !== undefined ? { ppid, pgid, tty: ttyNr !== 0, start } : null;
}

/**
 * A look at the system that failed. The message names the probe and a reason
 * only (no paths, no output), so it is safe to log.
 */
export class ProbeFailure extends Error {
  // Declared fields, not constructor parameter properties: the evaluation
  // harnesses load this module with Node's type stripping, which rejects them.
  readonly probe: string;
  readonly reason: string;

  constructor(probe: string, reason: string) {
    super(`${probe}: ${reason}`);
    this.probe = probe;
    this.reason = reason;
  }
}

/** The loggable text of a failed look. */
export function describeFailure(err: unknown): string {
  if (err instanceof ProbeFailure) return err.message;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? `probe: ${code}` : "probe: failed";
}

/**
 * How the server sees processes: the process table, and working folders of
 * this user's processes. A look that cannot be completed rejects (or throws)
 * with a `ProbeFailure`, so a failed look is never mistaken for an empty system.
 */
export interface ProcessProbe {
  list(): Promise<ProcessEntry[]>;
  cwds(uid: number): Promise<Map<number, string>>;
  listSync(): ProcessEntry[];
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * `ps` prints a start time in the local time zone and language, so the same
 * process would have a different start under different settings, and a server
 * started under one would look like another process to a server started under
 * another. Every read of start times (`ps ... lstart=`) runs in one fixed time
 * zone and locale. Nothing else does: `lsof` prints a working folder with any
 * non-ASCII letter in it as an escape in the fixed locale, which would never
 * match the real path.
 */
export const PROBE_ENVIRONMENT = { TZ: "UTC0", LC_ALL: "C" } as const;
const probeEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...PROBE_ENVIRONMENT });

function failureReason(err: unknown): string {
  const e = err as { code?: unknown; status?: unknown; killed?: boolean; signal?: unknown };
  if (typeof e.code === "string" && e.code !== "ETIMEDOUT") return e.code;
  if (e.code === "ETIMEDOUT" || e.killed || e.signal) return "timed out";
  return typeof e.status === "number" ? `exit ${e.status}` : typeof e.code === "number" ? `exit ${e.code}` : "failed";
}

function run(command: string, args: string[], options: { tolerateExit1?: boolean; startTimes?: boolean } = {}): Promise<string> {
  const { tolerateExit1 = false, startTimes = false } = options;
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, ...(startTimes ? { env: probeEnv() } : {}) }, (err, stdout) => {
      if (!err) return resolve(stdout);
      // lsof exits 1 when it could not inspect everything or found nothing, still printing what it found.
      if (tolerateExit1 && (err as { code?: unknown }).code === 1 && typeof stdout === "string") return resolve(stdout);
      reject(new ProbeFailure(command, failureReason(err)));
    });
  });
}

function runSync(command: string, args: string[], timeout: number, startTimes = false): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], ...(startTimes ? { env: probeEnv() } : {}) });
  } catch (err) {
    throw new ProbeFailure(command, failureReason(err));
  }
}

const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,uid=,tty=,lstart="];
const lsofArgs = (uid: number) => ["-w", "-a", "-d", "cwd", "-u", String(uid), "-Fpn"];

function psTable(output: string): ProcessEntry[] {
  const table = parsePsTable(output);
  // Every system has at least one process: an empty table is a failed read.
  if (table.length === 0) throw new ProbeFailure("ps", "no processes listed");
  return table;
}

/** macOS (and other systems with ps and lsof). */
export const psProbe: ProcessProbe = {
  list: async () => psTable(await run("ps", PS_ARGS, { startTimes: true })),
  cwds: async (uid) => parseLsofCwds(await run("lsof", lsofArgs(uid), { tolerateExit1: true })),
  listSync: () => psTable(runSync("ps", PS_ARGS, 2_000, true)),
};

function procList(): ProcessEntry[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch (err) {
    throw new ProbeFailure("proc", (err as NodeJS.ErrnoException).code ?? "failed");
  }
  const out: ProcessEntry[] = [];
  for (const name of names) {
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
};

const noProbe: ProcessProbe = {
  list: async () => [],
  cwds: async () => new Map(),
  listSync: () => [],
};

export function defaultProbe(platform: NodeJS.Platform = process.platform): ProcessProbe {
  if (platform === "linux") return procProbe;
  if (platform === "win32") return noProbe;
  return psProbe;
}

/** What a run's processes are known by. */
export interface RunIdentity {
  leaderPid: number;
  /** The CLI's start time, recorded when it was spawned; null when it could not be read. */
  leaderStart: string | null;
  /** The run's folders: a process working inside one of them belongs to the run. */
  folders: readonly string[];
  /** Groups seen among the CLI's descendants while it was alive. */
  groups: ReadonlySet<number>;
  /** Processes seen as the CLI's descendants, by id, with the start time that tells which process each was. */
  known: ReadonlyMap<number, string>;
}

interface MutableRun extends RunIdentity {
  groups: Set<number>;
  known: Map<number, string>;
}

export interface Targets {
  groups: number[];
  pids: number[];
}

const inside = (dir: string, folders: readonly string[]) => folders.some((f) => dir === f || dir.startsWith(f + path.sep));

/** The server and everything it descends from, which are never signalled. */
function protectedFrom(byPid: ReadonlyMap<number, ProcessEntry>, self: { pid: number }): Set<number> {
  const protectedPids = new Set<number>([0, 1, self.pid]);
  for (let p: ProcessEntry | undefined = byPid.get(self.pid), guard = 0; p && guard < 4096; p = byPid.get(p.ppid), guard++) protectedPids.add(p.pid);
  return protectedPids;
}

/** Collects `roots` and everything descended from them into `into`, never a protected or skipped process. */
function collect(
  roots: number[],
  into: Set<number>,
  input: { byPid: ReadonlyMap<number, ProcessEntry>; children: ReadonlyMap<number, ProcessEntry[]>; protectedPids: ReadonlySet<number> },
  skip: (p: ProcessEntry) => boolean,
  mayBeMissing: (pid: number) => boolean = () => false
): void {
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (into.has(pid) || input.protectedPids.has(pid)) continue;
    const entry = input.byPid.get(pid);
    if (entry ? skip(entry) : !mayBeMissing(pid)) continue;
    into.add(pid);
    for (const child of input.children.get(pid) ?? []) queue.push(child.pid);
  }
}

function tableOf(procs: readonly ProcessEntry[], uid: number) {
  const own = procs.filter((p) => p.uid === uid);
  const byPid = new Map(own.map((p) => [p.pid, p]));
  const children = new Map<number, ProcessEntry[]>();
  for (const p of own) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const members = new Map<number, ProcessEntry[]>();
  for (const p of own) members.set(p.pgid, [...(members.get(p.pgid) ?? []), p]);
  return { own, byPid, children, members };
}

/**
 * The groups and processes that belong to a run, from one look at the system.
 * Pure, so every case is testable. `self` is the server: neither it, its own
 * group, nor anything it descends from is ever a target. `leaderUnreaped`
 * says the server has not yet reaped the CLI, so its id is still the CLI's
 * whatever the table shows.
 */
export function runTargets(input: {
  run: RunIdentity;
  procs: readonly ProcessEntry[];
  cwds: ReadonlyMap<number, string>;
  uid: number;
  self: { pid: number; pgid: number };
  leaderUnreaped?: boolean;
}): Targets {
  const { run } = input;
  const { byPid, children, members } = tableOf(input.procs, input.uid);
  const protectedPids = protectedFrom(byPid, input.self);
  const walkInput = { byPid, children, protectedPids };

  // The leader is the run's only while it is the same process.
  const leaderEntry = byPid.get(run.leaderPid);
  const leaderOk =
    input.leaderUnreaped === true ||
    (leaderEntry !== undefined && (run.leaderStart !== null ? leaderEntry.start === run.leaderStart : leaderEntry.ppid === input.self.pid));

  // What the run recorded that is still the same process (same id and start
  // time), never one with a controlling terminal.
  const recorded: number[] = [];
  for (const [pid, start] of run.known) {
    const entry = byPid.get(pid);
    if (entry !== undefined && entry.start === start && !entry.tty) recorded.push(pid);
  }

  // The CLI, what it recorded, and everything descended from either. Only the
  // verified CLI may be missing from the table (it was not readable).
  const tree = new Set<number>();
  collect([...(leaderOk ? [run.leaderPid] : []), ...recorded], tree, walkInput, (p) => p.tty, (pid) => pid === run.leaderPid);
  // What works in the run's folders, and its descendants: never a process with a terminal.
  const byFolder = new Set<number>();
  const folderRoots = [...input.cwds].filter(([pid, cwd]) => inside(cwd, run.folders) && byPid.has(pid) && !tree.has(pid)).map(([pid]) => pid);
  collect(folderRoots, byFolder, walkInput, (p) => p.tty || tree.has(p.pid));

  const candidates = new Set<number>(run.groups);
  if (leaderOk) candidates.add(run.leaderPid);
  for (const pid of tree) {
    const pgid = byPid.get(pid)?.pgid;
    if (pgid !== undefined) candidates.add(pgid);
  }
  // A process found by its folder alone brings its group only when the run
  // recorded that group, or when it leads the group itself.
  for (const pid of byFolder) {
    const p = byPid.get(pid)!;
    if (run.groups.has(p.pgid) || (p.pid === p.pgid && !p.tty)) candidates.add(p.pgid);
  }
  // A group is signalled only while one of its members is known to be the
  // run's (the same id and start time), so a group number the system has since
  // given to another process group is never signalled, nor is a group with a
  // member that has a controlling terminal. Without a process table (the probe
  // failed), the CLI's own group is still signalled while the CLI is unreaped.
  const known = new Set<number>([...recorded, ...tree, ...byFolder]);
  if (leaderOk) known.add(run.leaderPid);
  const groups = [...candidates].filter((g) => {
    if (g <= 1 || g === input.self.pgid || protectedPids.has(g)) return false;
    const group = members.get(g) ?? [];
    if (group.some((m) => m.tty)) return false;
    return group.some((m) => known.has(m.pid)) || (input.procs.length === 0 && leaderOk && g === run.leaderPid);
  });
  const pids = new Set([...tree, ...byFolder]);
  // The verified leader is signalled through its group; a pid listed here is one that may have left it.
  if (leaderOk) pids.delete(run.leaderPid);
  return { groups: groups.sort((a, b) => a - b), pids: [...pids].sort((a, b) => a - b) };
}

/**
 * Remembers what `targets` found, from the table they were found in: each
 * process by id and start time and each group, so a later look verifies the
 * same processes. What is gone, or no longer the same process, is forgotten,
 * which bounds what a long run keeps.
 */
function recordInto(run: MutableRun, targets: Targets, procs: readonly ProcessEntry[]): void {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const known = new Map<number, string>();
  for (const pid of targets.pids) {
    const entry = byPid.get(pid);
    if (entry) known.set(pid, entry.start);
  }
  run.known = known;
  run.groups = new Set(targets.groups);
}

/**
 * Leftovers of runs that no server owns: processes of this user with no
 * controlling terminal whose working folder `belongs` (the contained
 * profile's folders), with their descendants, never the server or what it
 * descends from. A process that leads its own group brings the group.
 */
export function strayTargets(input: {
  procs: readonly ProcessEntry[];
  cwds: ReadonlyMap<number, string>;
  uid: number;
  self: { pid: number; pgid: number };
  belongs: (cwd: string) => boolean;
}): Targets {
  const { byPid, children, members } = tableOf(input.procs, input.uid);
  const protectedPids = protectedFrom(byPid, input.self);
  const roots = [...input.cwds].filter(([pid, cwd]) => byPid.get(pid) !== undefined && !byPid.get(pid)!.tty && input.belongs(cwd)).map(([pid]) => pid);
  const found = new Set<number>();
  collect(roots, found, { byPid, children, protectedPids }, (p) => p.tty);
  const groups: number[] = [];
  for (const pid of found) {
    const p = byPid.get(pid)!;
    if (p.pid === p.pgid && p.pgid !== input.self.pgid && !(members.get(p.pgid) ?? []).some((m) => m.tty)) groups.push(p.pgid);
  }
  return { groups: groups.sort((a, b) => a - b), pids: [...found].sort((a, b) => a - b) };
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

const isEmpty = (t: Targets) => t.groups.length === 0 && t.pids.length === 0;
const sizeOf = (t: Targets) => t.groups.length + t.pids.length;

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
  /** Looks at the system that failed, by probe and reason only: a failed look finds nothing, and is reported rather than taken for an empty system. */
  probeFailures: string[];
  /** The leftover stop did not finish, because another server had started meanwhile. */
  abandoned?: boolean;
  /** SIGTERM had been sent to the processes before it was abandoned; none was sent SIGKILL. */
  sigtermSent?: boolean;
}

/**
 * Stops everything a run left: SIGTERM, up to `graceMs` for it to go, then
 * SIGKILL and up to `killWaitMs` more. Bounded however the processes behave.
 * What the first look finds is remembered by id and start time, so every
 * later look and the SIGKILL pass act on those same processes only.
 */
export async function stopRunProcesses(
  run: RunIdentity,
  options: { graceMs?: number; killWaitMs?: number; probe?: ProcessProbe; uid?: number; leaderUnreaped?: () => boolean } = {}
): Promise<StopReport> {
  const probe = options.probe ?? defaultProbe();
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const failures = new Set<string>();
  const report = (found: number, left: number): StopReport => ({ found, left, probeFailures: [...failures] });
  const ident: MutableRun = { ...run, groups: new Set(run.groups), known: new Map(run.known) };
  const look = async (folders: boolean): Promise<{ targets: Targets; ok: boolean }> => {
    let ok = true;
    const [procs, cwds] = await Promise.all([
      probe.list().catch((err) => {
        failures.add(describeFailure(err));
        ok = false;
        return [] as ProcessEntry[];
      }),
      folders
        ? probe.cwds(uid).catch((err) => {
            failures.add(describeFailure(err));
            return new Map<number, string>();
          })
        : Promise.resolve(new Map<number, string>()),
    ]);
    const targets = runTargets({ run: ident, procs, cwds, uid, self: selfIdentity(procs), leaderUnreaped: options.leaderUnreaped?.() });
    if (procs.length > 0) recordInto(ident, targets, procs);
    return { targets, ok };
  };
  /** Looks until nothing is left or `ms` has passed; null when the table could not be read to tell. */
  const settle = async (ms: number): Promise<Targets | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const now = await look(false);
      if (now.ok && isEmpty(now.targets)) return now.targets;
      if (Date.now() >= deadline) return now.ok ? now.targets : null;
      await sleep(50);
    }
  };

  const first = await look(true);
  if (isEmpty(first.targets)) return report(0, 0);
  const found = sizeOf(first.targets);
  signalTargets(first.targets, "SIGTERM");
  const grace = await settle(options.graceMs ?? 2_000);
  if (grace && isEmpty(grace)) return report(found, 0);
  // What is left, and anything that started meanwhile, verified by a fresh look.
  const second = await look(true);
  if (second.ok && isEmpty(second.targets)) return report(found, 0);
  // Nothing is signalled that a look has not just confirmed to be the run's.
  if (!second.ok) return report(found, sizeOf(grace ?? first.targets));
  signalTargets(second.targets, "SIGKILL");
  const rest = await settle(options.killWaitMs ?? 1_000);
  return report(found, sizeOf(rest ?? second.targets));
}

/**
 * Stops the leftovers of runs that no server owns (`strayTargets`): the
 * processes are read and confirmed again by id and start time immediately
 * before each signal, sent SIGTERM, given `graceMs` to go, then sent SIGKILL
 * with a bounded wait. The caller decides when it is safe to look. `proceed` is
 * asked right before each signal (after the confirming read): when it says no
 * (another server has started meanwhile), nothing more is signalled and the
 * report says the stop was abandoned.
 */
export async function stopStrayProcesses(input: {
  belongs: (cwd: string) => boolean;
  probe?: ProcessProbe;
  uid?: number;
  graceMs?: number;
  killWaitMs?: number;
  proceed?: () => Promise<boolean>;
}): Promise<StopReport> {
  const probe = input.probe ?? defaultProbe();
  const uid = input.uid ?? process.getuid?.() ?? 0;
  const failures = new Set<string>();
  const report = (found: number, left: number, abandoned = false, sigtermSent = false): StopReport => ({
    found,
    left,
    probeFailures: [...failures],
    ...(abandoned ? { abandoned, sigtermSent } : {}),
  });
  const read = async <T>(look: () => Promise<T>): Promise<T | null> => {
    try {
      return await look();
    } catch (err) {
      failures.add(describeFailure(err));
      return null;
    }
  };
  const [procs, cwds] = await Promise.all([read(() => probe.list()), read(() => probe.cwds(uid))]);
  if (!procs || !cwds) return report(0, 0);
  const targets = strayTargets({ procs, cwds, uid, self: selfIdentity(procs), belongs: input.belongs });
  if (isEmpty(targets)) return report(0, 0);
  const startOf = new Map(procs.map((p) => [p.pid, p.start]));
  // Who was in each group to be signalled, at the first look.
  const membersOf = new Map(targets.groups.map((g) => [g, procs.filter((p) => p.pgid === g).map((p) => p.pid)]));
  // What of the first look is still the same process in `again`. A group stays
  // while any member it had is still the same process and still in it, not only
  // while its leader is: a member that ignores SIGTERM outlives a leader that
  // does not.
  const confirm = (again: readonly ProcessEntry[]): Targets => {
    const now = new Map(again.map((p) => [p.pid, p]));
    const same = (pid: number) => now.get(pid)?.start === startOf.get(pid) && now.has(pid);
    return {
      groups: targets.groups.filter((g) => (membersOf.get(g) ?? []).some((pid) => same(pid) && now.get(pid)!.pgid === g)),
      pids: targets.pids.filter(same),
    };
  };
  /** The same processes now; or why nothing may be signalled: the table cannot be read, or another server has started. */
  const confirmed = async (): Promise<Targets | "unreadable" | "abandoned"> => {
    const again = await read(() => probe.list());
    if (!again) return "unreadable";
    const same = confirm(again);
    if (isEmpty(same)) return same;
    return input.proceed && !(await input.proceed()) ? "abandoned" : same;
  };
  const first = await confirmed();
  if (first === "unreadable" || first === "abandoned") return report(sizeOf(targets), sizeOf(targets), first === "abandoned");
  if (isEmpty(first)) return report(0, 0);
  const found = sizeOf(first);
  signalTargets(first, "SIGTERM");
  const deadline = Date.now() + (input.graceMs ?? 2_000);
  let left = first;
  while (Date.now() < deadline) {
    const now = await read(() => probe.list());
    if (!now) break;
    left = confirm(now);
    if (isEmpty(left)) return report(found, 0);
    await sleep(50);
  }
  // What did not go, confirmed again, is sent SIGKILL.
  const last = await confirmed();
  if (last === "unreadable" || last === "abandoned") return report(found, sizeOf(left), last === "abandoned", true);
  if (isEmpty(last)) return report(found, 0);
  signalTargets(last, "SIGKILL");
  const killDeadline = Date.now() + (input.killWaitMs ?? 1_000);
  left = last;
  while (Date.now() < killDeadline) {
    const now = await read(() => probe.list());
    if (!now) break;
    left = confirm(now);
    if (isEmpty(left)) break;
    await sleep(50);
  }
  return report(found, sizeOf(left));
}

interface LiveRun {
  run: MutableRun;
  abort: () => void;
  leaderUnreaped: () => boolean;
  /** Set once the server's shutdown has ended this run: nothing signals or looks at the system for it again. */
  shutDown: boolean;
  /** Ends the periodic look. */
  stopRecording: () => void;
  /** What the periodic look could not read, for the run's report. */
  lookFailures: Set<string>;
  /** Numbers each look as it starts, so a look that was overtaken by a newer one is not stored over it. */
  lookSeq: number;
  /** The number of the look whose record is stored. */
  storedSeq: number;
  /** When the stored record was taken (`performance.now()`), or null before the first look succeeded. */
  recordedAt: number | null;
}

/**
 * Stores what a look found, unless a look that started later has stored its
 * own already: an asynchronous look that was overtaken by a synchronous one
 * (the stop's) must not replace the fresher record. `at` is when the look
 * began, before it read the table: a look that took long to return is as old as
 * it was when it began.
 */
function storeRecord(live: LiveRun, seq: number, at: number, targets: Targets, procs: readonly ProcessEntry[]): void {
  if (seq < live.storedSeq) return;
  live.storedSeq = seq;
  recordInto(live.run, targets, procs);
  live.recordedAt = at;
}

/**
 * How recent a stored record must be for the server's shutdown to act on it
 * without checking it against the process table. In that time a process id
 * could be reused only if the system cycled through every process id, which it
 * does not. The groups of the record were checked for a member with a
 * controlling terminal when it was taken, and that check is not made again.
 */
const FRESH_RECORD_MS = 2_000;

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

/** How often a live run's processes are recorded: the process table only, so cheap. */
const RECORD_EVERY_MS = 1_000;

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
 * `abort` ends the run as a stop does. `leaderUnreaped` (from the spawned
 * child: no exit code and no signal yet) says its id is still the CLI's; the
 * CLI's start time is recorded here as well, while it is certainly the CLI.
 * While the run is live its descendants are recorded every `recordEveryMs`.
 */
export function trackRun(input: {
  leaderPid: number;
  folders: readonly string[];
  abort: () => void;
  probe?: ProcessProbe;
  leaderUnreaped?: () => boolean;
  recordEveryMs?: number;
}): TrackedRun {
  const probe = input.probe ?? defaultProbe();
  let leaderStart: string | null = null;
  try {
    leaderStart = probe.listSync().find((p) => p.pid === input.leaderPid)?.start ?? null;
  } catch {
    // Without it the CLI is recognised as the server's child.
  }
  const leaderUnreaped = input.leaderUnreaped ?? (() => false);
  const live: LiveRun = {
    run: { leaderPid: input.leaderPid, leaderStart, folders: [...input.folders], groups: new Set(), known: new Map() },
    abort: input.abort,
    leaderUnreaped,
    shutDown: false,
    stopRecording: () => {},
    lookFailures: new Set(),
    lookSeq: 0,
    storedSeq: 0,
    recordedAt: null,
  };
  registry().set(input.leaderPid, live);
  installShutdownHook();
  live.stopRecording = startRecording(live, probe, input.recordEveryMs ?? RECORD_EVERY_MS);
  let stopped: Promise<StopReport> | null = null;
  return {
    signal(signal) {
      // The server's shutdown has already killed everything, with no time to spare for another look.
      if (live.shutDown) return;
      const at = performance.now();
      let procs: ProcessEntry[] = [];
      try {
        procs = probe.listSync();
      } catch {
        // The CLI's own group is still signalled.
      }
      const uid = process.getuid?.() ?? 0;
      const seq = ++live.lookSeq;
      const t = runTargets({ run: live.run, procs, cwds: new Map(), uid, self: selfIdentity(procs), leaderUnreaped: leaderUnreaped() });
      if (procs.length > 0) storeRecord(live, seq, at, t, procs);
      signalTargets(t, signal);
    },
    stop() {
      stopped ??= (async () => {
        live.stopRecording();
        const report = await stopRunProcesses(live.run, { probe, leaderUnreaped });
        return { ...report, probeFailures: [...new Set([...report.probeFailures, ...live.lookFailures])] };
      })().finally(() => {
        if (registry().get(input.leaderPid) === live) registry().delete(input.leaderPid);
      });
      return stopped;
    },
  };
}

/** Records the run's descendants now and then, until stopped. One look at a time; failures are kept for the report, not logged each time. */
function startRecording(live: LiveRun, probe: ProcessProbe, everyMs: number): () => void {
  let busy = false;
  let ended = false;
  const record = async () => {
    if (busy || ended || live.shutDown) return;
    busy = true;
    try {
      const seq = ++live.lookSeq;
      // When the look began: the record is no newer than this, however long the read takes.
      const at = performance.now();
      const procs = await probe.list();
      // A look that a newer one overtook while it waited has nothing to add.
      if (ended || live.shutDown || seq < live.storedSeq) return;
      const uid = process.getuid?.() ?? 0;
      const t = runTargets({ run: live.run, procs, cwds: new Map(), uid, self: selfIdentity(procs), leaderUnreaped: live.leaderUnreaped() });
      storeRecord(live, seq, at, t, procs);
    } catch (err) {
      live.lookFailures.add(describeFailure(err));
    } finally {
      busy = false;
    }
  };
  void record();
  const timer = setInterval(record, everyMs);
  timer.unref();
  return () => {
    ended = true;
    clearInterval(timer);
  };
}

/**
 * The server is shutting down: ends every live contained run and kills its
 * processes with SIGKILL, synchronously, so it completes before the process
 * exits, which the development server's supervisor forces about 100 ms after
 * forwarding the signal. In that order: the CLI's own group before anything is
 * read; then every process and group recorded by a look only seconds old; then
 * one read of the process table and a kill of every recorded process and group
 * that is still the same process (which covers older records), and of what is
 * descended from them; then the runs are aborted (their stop does not look
 * again). No working folder is listed: what only works in a run's folders and
 * was never recorded is stopped by the next start's sweep. Returns how many
 * runs it ended.
 */
export function shutdownLiveRuns(probe: ProcessProbe = defaultProbe()): number {
  const lives = [...registry().values()].filter((live) => !live.shutDown);
  if (lives.length === 0) return 0;
  const uid = process.getuid?.() ?? 0;
  for (const live of lives) {
    live.shutDown = true;
    live.stopRecording();
    // The CLI is the run's own process while it is unreaped, whatever the table shows.
    if (live.run.leaderPid > 1 && live.leaderUnreaped()) send(-live.run.leaderPid, "SIGKILL");
  }
  // Right after it, everything the run recorded in a look only seconds old,
  // with no table to read first: the table read takes a good part of the window.
  const now = performance.now();
  for (const live of lives) {
    if (live.recordedAt === null || now - live.recordedAt > FRESH_RECORD_MS) continue;
    signalTargets({ groups: [...live.run.groups].filter((g) => g > 1), pids: [...live.run.known.keys()].filter((p) => p > 1 && p !== process.pid) }, "SIGKILL");
  }
  let procs: ProcessEntry[] = [];
  try {
    procs = probe.listSync();
  } catch {
    // The groups are still signalled.
  }
  for (const live of lives) {
    signalTargets(runTargets({ run: live.run, procs, cwds: new Map(), uid, self: selfIdentity(procs), leaderUnreaped: live.leaderUnreaped() }), "SIGKILL");
  }
  for (const live of lives) {
    try {
      live.abort();
    } catch {
      // The processes are stopped above whatever the run does.
    }
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
const SHUTDOWN_TASKS = Symbol.for("creatorbrio.agent-processes.shutdown-tasks");

/** The tasks the shutdown hook runs once, after it has stopped the live runs. */
function shutdownTasks(): Set<() => void> {
  const g = globalThis as typeof globalThis & { [SHUTDOWN_TASKS]?: Set<() => void> };
  g[SHUTDOWN_TASKS] ??= new Set();
  return g[SHUTDOWN_TASKS];
}

/**
 * Has the shutdown hook run `task` once when the server stops, by signal or
 * any other exit, after the live runs are stopped; for the contained server's
 * ownership records (#246). The task must be synchronous and must not throw.
 */
export function onServerShutdown(task: () => void): void {
  shutdownTasks().add(task);
}

function runShutdownTasks(): void {
  const tasks = [...shutdownTasks()];
  shutdownTasks().clear();
  for (const task of tasks) {
    try {
      task();
    } catch {
      // The rest still run.
    }
  }
}

/**
 * Stops live contained runs when the server receives SIGTERM, SIGINT or
 * SIGHUP (a closed terminal), and kills their groups if the process exits any
 * other way; either way it then runs the tasks given to `onServerShutdown`,
 * once. Installed once per process. Next.js has its own handlers for
 * SIGINT and SIGTERM, which end the server; where none is installed (SIGHUP),
 * this handler re-raises the signal after its work so the default termination
 * still happens, as it did before the handler existed.
 */
export function installShutdownHook(proc: HookedProcess = process as unknown as HookedProcess, probe?: ProcessProbe): void {
  if (proc === (process as unknown as HookedProcess) && !isMainThread) return;
  const marked = proc as HookedProcess & { [HOOKED]?: true };
  if (marked[HOOKED]) return;
  marked[HOOKED] = true;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const handler = () => {
      const ended = shutdownLiveRuns(probe);
      runShutdownTasks();
      // An expected end of the server, not a fault.
      if (ended > 0) console.warn("[design-agent] the server is stopping; its live design runs were stopped", { runs: ended, signal });
      if (proc.listenerCount(signal) === 1) {
        proc.removeListener(signal, handler);
        proc.kill(proc.pid, signal);
      }
    };
    proc.on(signal, handler);
  }
  proc.on("exit", () => {
    for (const live of registry().values()) {
      // No process table here: only the CLI's own group, and only while the CLI is unreaped, so its id is still its own.
      if (!live.shutDown && live.run.leaderPid > 1 && live.leaderUnreaped()) send(-live.run.leaderPid, "SIGKILL");
    }
    runShutdownTasks();
  });
}
