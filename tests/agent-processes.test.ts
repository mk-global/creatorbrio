/**
 * The contained Design Agent's processes (#241): what belongs to a run, and
 * that a run's end, its stop and the server's shutdown stop all of it within
 * a bounded wait, while unrelated processes of the same user are left alone.
 * Real processes stand in for the CLI and what its commands start.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installShutdownHook,
  liveRunCount,
  parseLsofCwds,
  parseProcStat,
  parsePsTable,
  runTargets,
  shutdownLiveRuns,
  trackRun,
  type HookedProcess,
  type ProcessEntry,
} from "@/lib/agent-processes";

const posix = process.platform !== "win32";

/** Running, and not a zombie waiting to be reaped. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
    }
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// Stands in for the CLI: one process in its own group, one command in a group
// of its own that leaves an orphan working in the run's folder, one process in
// a new session working in the run's folder that ignores SIGTERM, and, when
// it keeps running, a live command in its own group working elsewhere.
const LEADER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [folder, outside, record, mode] = process.argv.slice(2);
const forever = ["-e", "setInterval(() => {}, 1000)"];
const stubborn = ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"];
const pids = {};
pids.sameGroup = spawn(process.execPath, forever, { stdio: "ignore" }).pid;
pids.newSession = spawn(process.execPath, stubborn, { stdio: "ignore", detached: true, cwd: folder }).pid;
if (mode === "hang") pids.liveCommand = spawn(process.execPath, forever, { stdio: "ignore", detached: true, cwd: outside }).pid;
const command = spawn(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', cwd: process.argv[1] }); require('node:fs').writeFileSync(process.argv[2], String(c.pid)); c.unref();", folder, record + ".orphan"], { stdio: "ignore", detached: true, cwd: outside });
command.on("exit", () => {
  pids.orphan = Number(fs.readFileSync(record + ".orphan", "utf8"));
  fs.writeFileSync(record, JSON.stringify(pids));
  if (mode === "exit") setTimeout(() => process.exit(0), 100);
});
setInterval(() => {}, 1000);
`;

let base: string;
let folder: string;
let outside: string;
let leaderScript: string;
const started: number[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-processes-")));
  folder = path.join(base, "conversation");
  outside = path.join(base, "elsewhere");
  for (const d of [folder, outside]) await mkdir(d);
  leaderScript = path.join(base, "leader.cjs");
  await writeFile(leaderScript, LEADER);
});

afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
  }
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await rm(base, { recursive: true, force: true });
});

async function startLeader(mode: "exit" | "hang") {
  const record = path.join(base, `pids-${mode}.json`);
  const leader = spawn(process.execPath, [leaderScript, folder, outside, record, mode], { cwd: folder, detached: true, stdio: "ignore" });
  children.push(leader);
  started.push(leader.pid!);
  const pids = async () => JSON.parse(await readFile(record, "utf8")) as Record<string, number>;
  expect(await until(async () => (await readFile(record, "utf8").catch(() => "")) !== "")).toBe(true);
  const all = await pids();
  started.push(...Object.values(all));
  return { leader, pids: all };
}

/** A process of the same user that has nothing to do with the run: its own group, working elsewhere. */
function unrelated(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: outside, detached: true, stdio: "ignore" });
  children.push(child);
  return child.pid!;
}

describe.skipIf(!posix)("a contained run's processes", () => {
  it("are all stopped after the CLI exits, a SIGTERM-ignoring one with SIGKILL, and an unrelated process is left alone", async () => {
    const other = unrelated();
    const before = liveRunCount();
    const { leader, pids } = await startLeader("exit");
    const tracked = trackRun({ leaderPid: leader.pid!, folders: [folder], abort: () => {} });
    expect(liveRunCount()).toBe(before + 1);
    if (leader.exitCode === null) await once(leader, "exit");
    const started = Date.now();
    const report = await tracked.stop();
    expect(Date.now() - started).toBeLessThan(8000);
    expect(report.left).toBe(0);
    expect(report.found).toBeGreaterThan(0);
    for (const [name, pid] of Object.entries(pids)) expect({ name, running: isRunning(pid) }).toEqual({ name, running: false });
    expect(isRunning(other)).toBe(true);
    expect(liveRunCount()).toBe(before);
  });

  it("are stopped when the run is stopped: the CLI's group and the groups seen among its descendants", async () => {
    const other = unrelated();
    const { leader, pids } = await startLeader("hang");
    const tracked = trackRun({ leaderPid: leader.pid!, folders: [folder], abort: () => {} });
    tracked.signal("SIGTERM");
    await once(leader, "exit");
    // The live command worked outside the run's folders; its group was recorded when the run was signalled.
    expect(await until(() => !isRunning(pids.liveCommand))).toBe(true);
    const report = await tracked.stop();
    expect(report.left).toBe(0);
    for (const [name, pid] of Object.entries(pids)) expect({ name, running: isRunning(pid) }).toEqual({ name, running: false });
    expect(isRunning(other)).toBe(true);
  });

  it("are stopped at once when the server shuts down, and the run is aborted", async () => {
    const other = unrelated();
    const { leader, pids } = await startLeader("hang");
    let aborted = 0;
    const tracked = trackRun({ leaderPid: leader.pid!, folders: [folder], abort: () => aborted++ });
    expect(shutdownLiveRuns()).toBeGreaterThanOrEqual(1);
    expect(aborted).toBe(1);
    expect(await until(() => !isRunning(leader.pid!))).toBe(true);
    for (const [name, pid] of Object.entries(pids)) {
      expect({ name, stopped: await until(() => !isRunning(pid)) }).toEqual({ name, stopped: true });
    }
    expect(isRunning(other)).toBe(true);
    await tracked.stop();
  });
});

describe.skipIf(!posix)("the shutdown hook", () => {
  class FakeProcess extends EventEmitter implements HookedProcess {
    pid = 424242;
    raised: [number, string | undefined][] = [];
    kill(pid: number, signal?: NodeJS.Signals) {
      this.raised.push([pid, signal]);
      return true;
    }
  }

  it("stops live runs on SIGTERM and re-raises the signal when nothing else handles it", async () => {
    const fake = new FakeProcess();
    installShutdownHook(fake);
    installShutdownHook(fake);
    expect(fake.listenerCount("SIGTERM")).toBe(1);
    const { leader, pids } = await startLeader("hang");
    const tracked = trackRun({ leaderPid: leader.pid!, folders: [folder], abort: () => {} });
    fake.emit("SIGTERM");
    expect(fake.raised).toEqual([[424242, "SIGTERM"]]);
    expect(fake.listenerCount("SIGTERM")).toBe(0);
    expect(await until(() => !isRunning(leader.pid!))).toBe(true);
    for (const pid of Object.values(pids)) expect(await until(() => !isRunning(pid))).toBe(true);
    await tracked.stop();
  });

  it("leaves termination to the server's own handler when there is one", () => {
    const fake = new FakeProcess();
    let handled = 0;
    fake.on("SIGINT", () => handled++);
    installShutdownHook(fake);
    fake.emit("SIGINT");
    expect(handled).toBe(1);
    expect(fake.raised).toEqual([]);
  });
});

describe("what belongs to a run", () => {
  const UID = 501;
  const p = (pid: number, ppid: number, pgid: number, uid = UID, extra: Partial<ProcessEntry> = {}): ProcessEntry => ({ pid, ppid, pgid, uid, tty: false, start: `t${pid}`, ...extra });
  // The server 100 (its group 90, under a shell 90), the CLI 200 with a
  // command 210 in its own group and that command's child 211, an orphan 300
  // working in the run's folder in the dead command group 250, an unrelated
  // process 400, and another user's process 500 in the run's folder.
  const procs = [p(90, 1, 90), p(100, 90, 90), p(200, 100, 200), p(210, 200, 210), p(211, 210, 210), p(300, 1, 250), p(400, 1, 400), p(500, 1, 500, 0)];
  const cwds = new Map([
    [300, "/agents/c/conv/sub"],
    [400, "/agents/c/conversation-other"],
    [100, "/agents/c/conv"],
    [500, "/agents/c/conv"],
  ]);
  const run = { leaderPid: 200, leaderStart: "t200", folders: ["/agents/c/conv"], groups: new Set<number>(), known: new Set<number>() };
  const self = { pid: 100, pgid: 90 };

  it("is the CLI's group, its descendants and their groups, and what works in its folders, never the server or its ancestors", () => {
    // The orphan is signalled by itself: its group was not recorded and it does not lead it.
    expect(runTargets({ run, procs, cwds, uid: UID, self })).toEqual({ groups: [200, 210], pids: [210, 211, 300] });
  });

  it("brings a folder-matched process's group only when the run recorded it or the process leads it", () => {
    // 300 works in the folder but shares the foreign group 400 that it does not lead: the group is left alone.
    const shared = [...procs.filter((q) => q.pid !== 300), p(300, 1, 400)];
    expect(runTargets({ run, procs: shared, cwds, uid: UID, self })).toEqual({ groups: [200, 210], pids: [210, 211, 300] });
    // A process in a new session of its own, working in the folder, leads its group.
    const leader = [...procs.filter((q) => q.pid !== 300), p(300, 1, 300)];
    expect(runTargets({ run, procs: leader, cwds, uid: UID, self }).groups).toEqual([200, 210, 300]);
    // A group the run recorded while the CLI lived is signalled again.
    const recorded = { ...run, groups: new Set([250]) };
    expect(runTargets({ run: recorded, procs, cwds, uid: UID, self }).groups).toEqual([200, 210, 250]);
  });

  it("never takes a process with a controlling terminal for the run's by its folder, nor its group", () => {
    // A person's shell that changed into the conversation's folder, leading its own group, with a child.
    const shell = [...procs, p(600, 1, 600, UID, { tty: true }), p(601, 600, 600, UID, { tty: true })];
    const inFolder = new Map([...cwds, [600, "/agents/c/conv"]]);
    expect(runTargets({ run, procs: shell, cwds: inFolder, uid: UID, self })).toEqual({ groups: [200, 210], pids: [210, 211, 300] });
  });

  it("signals a recorded group only while one of its members is known to be the run's", () => {
    const recorded = { ...run, groups: new Set([250, 400]), known: new Set<number>() };
    expect(runTargets({ run: recorded, procs, cwds: new Map(), uid: UID, self }).groups).toEqual([200, 210]);
    const known = { ...recorded, known: new Set([400]) };
    expect(runTargets({ run: known, procs, cwds: new Map(), uid: UID, self }).groups).toEqual([200, 210, 400]);
  });

  it("never signals a reused CLI process id, its group or its descendants", () => {
    // The CLI exited and another process of the same user now has its id and group.
    const reused = procs.map((q) => (q.pid === 200 ? { ...q, start: "later" } : q));
    expect(runTargets({ run, procs: reused, cwds: new Map(), uid: UID, self })).toEqual({ groups: [], pids: [] });
    // Without a recorded start time, only the server's own child is the CLI.
    const noStart = { ...run, leaderStart: null };
    expect(runTargets({ run: noStart, procs, cwds: new Map(), uid: UID, self }).groups).toEqual([200, 210]);
    const adopted = procs.map((q) => (q.pid === 200 ? { ...q, ppid: 1 } : q));
    expect(runTargets({ run: noStart, procs: adopted, cwds: new Map(), uid: UID, self })).toEqual({ groups: [], pids: [] });
  });

  it("still signals the CLI's group without a process table only while the server has not reaped the CLI", () => {
    expect(runTargets({ run, procs: [], cwds: new Map(), uid: UID, self, leaderUnreaped: true })).toEqual({ groups: [200], pids: [] });
    expect(runTargets({ run, procs: [], cwds: new Map(), uid: UID, self, leaderUnreaped: false })).toEqual({ groups: [], pids: [] });
  });

  it("parses the process table and working folders as ps, lsof and /proc print them", () => {
    expect(parsePsTable("  1     0     1     0 ??       Sat Nov 21 23:42:31 2026\n 812   1 812  501 ttys001  Sun Nov 22 01:02:03 2026\nbad line\n")).toEqual([
      p(1, 0, 1, 0, { start: "Sat Nov 21 23:42:31 2026" }),
      p(812, 1, 812, UID, { tty: true, start: "Sun Nov 22 01:02:03 2026" }),
    ]);
    expect([...parseLsofCwds("p812\nfcwd\nn/agents/c/conv\np900\nfcwd\nn/\n")]).toEqual([
      [812, "/agents/c/conv"],
      [900, "/"],
    ]);
    expect(parseProcStat("812 (node (x) y) S 1 812 812 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 98765 0")).toEqual({ ppid: 1, pgid: 812, tty: false, start: "98765" });
    expect(parseProcStat("812 (bash) S 1 812 812 34816 812 4194304 1 0 0 0 0 0 0 0 20 0 1 0 98765 0")).toMatchObject({ tty: true });
  });
});
