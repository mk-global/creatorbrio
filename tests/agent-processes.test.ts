/**
 * The contained Design Agent's processes (#241): what belongs to a run, and
 * that a run's end, its stop and the server's shutdown stop all of it within
 * a bounded wait, while unrelated processes of the same user are left alone.
 * Real processes stand in for the CLI and what its commands start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProbeFailure,
  defaultProbe,
  installShutdownHook,
  liveRunCount,
  parseLsofCwds,
  parseProcStat,
  parsePsTable,
  psProbe,
  runTargets,
  shutdownLiveRuns,
  strayTargets,
  stopStrayProcesses,
  trackRun,
  type HookedProcess,
  type ProcessEntry,
  type ProcessProbe,
} from "@/lib/agent-processes";

const posix = process.platform !== "win32";

// Real processes, a shared machine and, in CI, a slow one: none of these waits is a measurement.
vi.setConfig({ testTimeout: 30_000 });

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

// Stands in for a CLI whose command leaves a job behind that changes folder
// and stays in the command's group, and then ends: the run ends by itself with
// the job still running, working outside the run's folders.
const JOB_LEADER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [outside, record] = process.argv.slice(1);
const command = spawn(process.execPath, ["-e", "const j = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', cwd: process.argv[1] }); require('node:fs').writeFileSync(process.argv[2], String(j.pid)); j.unref(); setTimeout(() => process.exit(0), 700);", outside, record + ".job"], { stdio: "ignore", detached: true, cwd: outside });
command.on("exit", () => {
  fs.writeFileSync(record, fs.readFileSync(record + ".job", "utf8"));
  setTimeout(() => process.exit(0), 100);
});
setInterval(() => {}, 1000);
`;

/** A process of the same user that has nothing to do with the run: its own group, working elsewhere. */
function unrelated(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: outside, detached: true, stdio: "ignore" });
  children.push(child);
  return child.pid!;
}

/** What was in the CLI's tree when the table was read at shutdown: everything but the orphan, which only works in the run's folder. */
const treeOf = (pids: Record<string, number>) => Object.entries(pids).filter(([name]) => name !== "orphan").map(([, pid]) => pid);

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
    // Everything in the CLI's tree when the table was read: the shutdown lists no working folders.
    const { orphan, ...inTheTree } = pids;
    for (const [name, pid] of Object.entries(inTheTree)) {
      expect({ name, stopped: await until(() => !isRunning(pid)) }).toEqual({ name, stopped: true });
    }
    expect(isRunning(other)).toBe(true);
    await tracked.stop();
    // An orphan that only works in the run's folder is left to the next start's sweep.
    await stopStrayProcesses({ belongs: (cwd) => cwd === folder || cwd.startsWith(folder + path.sep) });
    expect(await until(() => !isRunning(orphan))).toBe(true);
  });
});

describe.skipIf(!posix)("a run that ends on its own", () => {
  it("stops a background job that changed folder and stayed in its command's group (#241 A3)", async () => {
    const record = path.join(base, "job-record");
    const leader = spawn(process.execPath, ["-e", JOB_LEADER, outside, record], { cwd: folder, detached: true, stdio: "ignore" });
    children.push(leader);
    started.push(leader.pid!);
    const tracked = trackRun({ leaderPid: leader.pid!, folders: [folder], abort: () => {}, recordEveryMs: 50 });
    await once(leader, "exit");
    const job = Number(await readFile(record, "utf8"));
    started.push(job);
    // The job outlived its command and the CLI, working outside the run's folders, and nobody signalled anything.
    expect(isRunning(job)).toBe(true);
    const report = await tracked.stop();
    expect(report.found).toBeGreaterThan(0);
    expect(report.left).toBe(0);
    expect(await until(() => !isRunning(job))).toBe(true);
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
    for (const pid of treeOf(pids)) expect(await until(() => !isRunning(pid))).toBe(true);
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

  it("also stops live runs when the terminal closes (SIGHUP), and then lets the server end as it would have (#241 A2)", async () => {
    const fake = new FakeProcess();
    installShutdownHook(fake);
    expect(fake.listenerCount("SIGHUP")).toBe(1);
    const { leader, pids } = await startLeader("hang");
    const tracked = trackRun({ leaderPid: leader.pid!, folders: [folder], abort: () => {} });
    fake.emit("SIGHUP");
    expect(fake.raised).toEqual([[424242, "SIGHUP"]]);
    expect(await until(() => !isRunning(leader.pid!))).toBe(true);
    for (const pid of treeOf(pids)) expect(await until(() => !isRunning(pid))).toBe(true);
    await tracked.stop();
  });

  it("kills the CLI's group before it reads anything, reads the table once, and the abort sends nothing further and reads nothing (#241 A2)", async () => {
    const real = defaultProbe();
    // One log of the calls in the order they were made, so what is asserted is order, not whether a process had died yet.
    const calls: string[] = [];
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal !== 0 && signal !== undefined) calls.push(`${String(signal)} ${pid}`);
      return kill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
    const probe: ProcessProbe = {
      list: () => real.list(),
      cwds: (uid) => real.cwds(uid),
      listSync: () => {
        calls.push("read");
        return real.listSync();
      },
    };
    const { leader } = await startLeader("hang");
    let aborted = 0;
    // As the chat route does: an abort signals the run, which must not read the process table again.
    const tracked = trackRun({
      leaderPid: leader.pid!,
      folders: [folder],
      abort: () => (aborted++, tracked.signal("SIGTERM")),
      probe,
      leaderUnreaped: () => leader.exitCode === null && leader.signalCode === null,
    });
    calls.length = 0;
    expect(shutdownLiveRuns(probe)).toBe(1);
    expect(aborted).toBe(1);
    expect(calls[0]).toBe(`SIGKILL ${-leader.pid!}`);
    expect(calls.filter((call) => call === "read")).toHaveLength(1);
    // The abort signalled nothing: nothing but SIGKILL was sent, and nothing after the one read read again.
    expect(calls.filter((call) => !call.startsWith("SIGKILL ") && call !== "read")).toEqual([]);
    await tracked.stop();
  });
});

describe.skipIf(!posix)("the server's shutdown, in the order its short window needs (#241 B2, B7)", () => {
  const me = process.getuid?.() ?? 0;
  const LEADER = 910001;
  const COMMAND = 910002;
  const JOB = 910003;
  const entry = (pid: number, ppid: number, pgid: number, start = `s${pid}`): ProcessEntry => ({ pid, ppid, pgid, uid: me, tty: false, start });
  /** Only this server, so a stop finds nothing to wait for. */
  const quiet = () => [entry(process.pid, 1, process.pid)];
  let table: ProcessEntry[];
  let calls: string[];
  let lists: number;

  // Nothing here is a real process: the process ids are made up, and no signal reaches the system.
  beforeEach(() => {
    table = [entry(COMMAND, LEADER, COMMAND), entry(JOB, COMMAND, COMMAND)];
    calls = [];
    lists = 0;
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal !== 0 && signal !== undefined) calls.push(`${String(signal)} ${pid}`);
      return true;
    }) as typeof process.kill);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const probeOf = (list: () => Promise<ProcessEntry[]> = async () => (lists++, table)): ProcessProbe => ({
    list,
    cwds: async () => new Map(),
    listSync: () => (calls.push("read"), table),
  });
  const track = (probe: ProcessProbe) => {
    const tracked = trackRun({ leaderPid: LEADER, folders: [folder], abort: () => tracked.signal("SIGTERM"), probe, leaderUnreaped: () => true, recordEveryMs: 20 });
    return tracked;
  };

  it("kills the CLI's group, then everything a recent look recorded, and only then reads the process table", async () => {
    const probe = probeOf();
    const tracked = track(probe);
    // The look has recorded the command and its job: a second one has begun.
    expect(await until(() => lists >= 2)).toBe(true);
    calls.length = 0;
    expect(shutdownLiveRuns(probe)).toBe(1);
    const read = calls.indexOf("read");
    expect(calls.slice(0, read)).toEqual([`SIGKILL ${-LEADER}`, `SIGKILL ${-COMMAND}`, `SIGKILL ${COMMAND}`, `SIGKILL ${JOB}`]);
    expect(calls.filter((call) => call === "read")).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("SIGTERM"))).toBe(false);
    table = quiet();
    await tracked.stop();
  });

  it("acts on an old record only once the process table confirms each process by its start time", async () => {
    let failing = false;
    const probe = probeOf(async () => {
      if (failing) throw new ProbeFailure("ps", "timed out");
      lists++;
      return table;
    });
    const tracked = track(probe);
    expect(await until(() => lists >= 2)).toBe(true);
    // No look succeeds from here on, and time passes: the record is old, and the ids now belong to other processes.
    failing = true;
    const later = performance.now() + 10_000;
    vi.spyOn(performance, "now").mockReturnValue(later);
    table = [entry(COMMAND, 1, COMMAND, "another process"), entry(JOB, 1, COMMAND, "another process")];
    calls.length = 0;
    shutdownLiveRuns(probe);
    // The CLI's own group only: nothing recorded long ago is signalled by its bare id.
    expect(calls.filter((call) => call.startsWith("SIGKILL "))).toEqual([`SIGKILL ${-LEADER}`]);
    table = quiet();
    await tracked.stop();
  });

  it("counts a record's age from when its look began, not from when its read returned (#241 C4)", async () => {
    let finish!: (table: ProcessEntry[]) => void;
    const began = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(began);
    const probe = probeOf(() => (++lists === 1 ? new Promise<ProcessEntry[]>((resolve) => (finish = resolve)) : Promise.resolve(table)));
    const tracked = trackRun({ leaderPid: LEADER, folders: [folder], abort: () => {}, probe, leaderUnreaped: () => true, recordEveryMs: 1_000_000 });
    // The read takes longer than the window, and returns with the table as it was.
    clock.mockReturnValue(began + 3_000);
    finish(table);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Meanwhile the ids went to other processes: a record that old is checked, not trusted.
    table = [entry(COMMAND, 1, COMMAND, "another process"), entry(JOB, 1, COMMAND, "another process")];
    calls.length = 0;
    shutdownLiveRuns(probe);
    expect(calls.filter((call) => call.startsWith("SIGKILL "))).toEqual([`SIGKILL ${-LEADER}`]);
    table = quiet();
    await tracked.stop();
  });

  it("does not let a look that was overtaken replace a newer record (#241 B7)", async () => {
    let finishFirst!: (table: ProcessEntry[]) => void;
    const probe = probeOf(() => (++lists === 1 ? new Promise<ProcessEntry[]>((resolve) => (finishFirst = resolve)) : Promise.resolve(table)));
    // The first periodic look is waiting on the system, and the next is a long way off.
    const tracked = trackRun({ leaderPid: LEADER, folders: [folder], abort: () => {}, probe, leaderUnreaped: () => true, recordEveryMs: 1_000_000 });
    // The stop's own look reads the table at once, and records what it sees.
    tracked.signal("SIGTERM");
    // The waiting look now finishes, with what it saw before: a process that is not in the table any more.
    finishFirst([entry(910009, LEADER, 910009)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls.length = 0;
    shutdownLiveRuns(probe);
    const killedFirst = calls.slice(0, calls.indexOf("read"));
    expect(killedFirst).toContain(`SIGKILL ${JOB}`);
    expect(killedFirst).not.toContain("SIGKILL 910009");
    table = quiet();
    await tracked.stop();
  });
});

describe.skipIf(!posix)("a server whose supervisor ends it shortly after forwarding the signal (#241 A2)", () => {
  const worker = fileURLToPath(new URL("./helpers/shutdown-worker.mjs", import.meta.url));

  async function readyWorker() {
    const record = path.join(base, "worker-record");
    const child = spawn(process.execPath, [worker, folder, outside, record], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    started.push(child.pid!);
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    expect(await until(() => out.includes("ready"), 20000)).toBe(true);
    const pids = JSON.parse(await readFile(record, "utf8")) as Record<string, number>;
    started.push(...Object.values(pids));
    return { child, pids };
  }

  for (const signal of ["SIGINT", "SIGHUP"] as const) {
    it(`stops the CLI's group and what the run recorded when ${signal} is followed by SIGKILL 100 ms later`, async () => {
      const { child, pids } = await readyWorker();
      // The job left its command and works outside the run's folders: only the record finds it.
      expect(isRunning(pids.job)).toBe(true);
      const ended = once(child, "exit");
      child.kill(signal);
      setTimeout(() => child.kill("SIGKILL"), 100);
      await ended;
      for (const [name, pid] of Object.entries(pids)) expect({ name, stopped: await until(() => !isRunning(pid)) }).toEqual({ name, stopped: true });
    });
  }
});

/** Whether `ps` can be run here: the container this suite is sometimes run in has none, and the check below needs a real one. */
const hasPs = (() => {
  try {
    execFileSync("ps", ["-o", "pid=", "-p", String(process.pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!posix || !hasPs)("a process's start time (#241 B1)", () => {
  it("reads the same whatever the time zone and language of the server that reads it", async () => {
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    const seen = new Set<string>();
    try {
      for (const [tz, lc] of [
        ["UTC", "C"],
        ["Asia/Tokyo", "de_DE.UTF-8"],
        ["America/New_York", "hi_IN.UTF-8"],
      ]) {
        process.env.TZ = tz;
        process.env.LC_ALL = lc;
        seen.add(psProbe.listSync().find((p) => p.pid === process.pid)!.start);
        seen.add((await psProbe.list()).find((p) => p.pid === process.pid)!.start);
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect([...seen]).toHaveLength(1);
  });
});

describe.skipIf(process.platform !== "darwin")("a working folder with a non-ASCII letter in its path (#241 C1)", () => {
  it("is read as the real path, which the fixed locale for start times must not turn into an escape", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-cwd-\u00e9-")));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: dir, stdio: "ignore" });
    children.push(child);
    try {
      const uid = process.getuid!();
      expect(await until(async () => (await psProbe.cwds(uid)).get(child.pid!) === dir)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!posix)("looks at the system that fail", () => {
  const failing: ProcessProbe = {
    list: async () => {
      throw new ProbeFailure("ps", "timed out");
    },
    cwds: async () => {
      throw new ProbeFailure("lsof", "timed out");
    },
    listSync: () => {
      throw new ProbeFailure("ps", "timed out");
    },
  };

  it("are reported by the stop, which signals nothing it could not verify, instead of passing as a clean stop (#241 A5)", async () => {
    const { leader, pids } = await startLeader("hang");
    const tracked = trackRun({ leaderPid: leader.pid!, folders: [folder], abort: () => {}, probe: failing, recordEveryMs: 20 });
    leader.kill("SIGKILL");
    await once(leader, "exit");
    const report = await tracked.stop();
    expect(report.found).toBe(0);
    expect(report.probeFailures).toEqual(expect.arrayContaining(["ps: timed out", "lsof: timed out"]));
    // What could not be verified is left running, and said so, rather than signalled by a bare process id.
    expect(isRunning(pids.liveCommand)).toBe(true);
  });

  it("make the real probes reject with a reason and never a path, not resolve with nothing", async () => {
    const path0 = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(psProbe.list()).rejects.toMatchObject({ probe: "ps", reason: "ENOENT" });
      await expect(psProbe.cwds(1)).rejects.toMatchObject({ probe: "lsof", reason: "ENOENT" });
      expect(() => psProbe.listSync()).toThrow(ProbeFailure);
    } finally {
      process.env.PATH = path0;
    }
  });
});

describe.skipIf(!posix)("the stop of leftover processes at server start (#241 B5)", () => {
  /** A process that says when it has set up its handling of SIGTERM, so a signal never arrives before it. */
  function leftover(name: string, onTerm: "exit-after-marking" | "ignore") {
    const marker = path.join(base, `${name}-term`);
    const ready = path.join(base, `${name}-ready`);
    const handler = onTerm === "ignore" ? "() => {}" : `() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }`;
    const child = spawn(process.execPath, ["-e", `process.on('SIGTERM', ${handler}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'x'); setInterval(() => {}, 1000)`], { cwd: folder, detached: true, stdio: "ignore" });
    children.push(child);
    started.push(child.pid!);
    return { pid: child.pid!, marker, ready };
  }
  const belongs = (cwd: string) => cwd === folder || cwd.startsWith(folder + path.sep);

  it("sends SIGTERM first, and SIGKILL only to what ignores it", async () => {
    const polite = leftover("polite", "exit-after-marking");
    const stubborn = leftover("stubborn", "ignore");
    expect(await until(() => existsSync(polite.ready) && existsSync(stubborn.ready), 20_000)).toBe(true);
    const report = await stopStrayProcesses({ belongs, graceMs: 500, killWaitMs: 5_000 });
    expect(report.found).toBeGreaterThanOrEqual(2);
    expect(report.left).toBe(0);
    expect(await until(() => !isRunning(polite.pid) && !isRunning(stubborn.pid))).toBe(true);
    // The one that handles SIGTERM got it, and was not killed before it could act on it.
    expect(existsSync(polite.marker)).toBe(true);
    expect(existsSync(stubborn.marker)).toBe(false);
  });

  it("still sends SIGKILL to a group member that ignores SIGTERM after the leader has exited on it (#241 C5)", async () => {
    const outsideDir = outside;
    const readyMember = path.join(base, "member-pid");
    const helperPid = path.join(base, "helper-pid");
    const member = path.join(base, "member.cjs");
    const helper = path.join(base, "helper.cjs");
    const leaderScript = path.join(base, "group-leader.cjs");
    await writeFile(member, `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
    // Starts the member, in this group and working outside the run's folders, and exits: the member is orphaned.
    await writeFile(helper, `const m = require("node:child_process").spawn(process.execPath, [${JSON.stringify(member)}, ${JSON.stringify(readyMember)}], { stdio: "ignore", cwd: ${JSON.stringify(outsideDir)} }); m.unref();`);
    await writeFile(
      leaderScript,
      `const h = require("node:child_process").spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(helperPid)}, String(h.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);`
    );
    // The leader works in the run's folder and leads its own group, as a stray does.
    const leaderChild = spawn(process.execPath, [leaderScript], { cwd: folder, detached: true, stdio: "ignore" });
    children.push(leaderChild);
    started.push(leaderChild.pid!);
    expect(await until(() => existsSync(readyMember) && existsSync(helperPid), 20_000)).toBe(true);
    const memberPid = Number(await readFile(readyMember, "utf8"));
    started.push(memberPid);
    // The helper has gone: the member is no longer anyone's child in the run, and works outside its folders.
    expect(await until(() => !isRunning(Number(readFileSync(helperPid, "utf8"))), 20_000)).toBe(true);
    const report = await stopStrayProcesses({ belongs, graceMs: 500, killWaitMs: 5_000 });
    expect(report.found).toBeGreaterThan(0);
    expect(await until(() => !isRunning(leaderChild.pid!))).toBe(true);
    // The leader left on SIGTERM; the member, which ignores it, is still in the group and goes with SIGKILL.
    expect(await until(() => !isRunning(memberPid))).toBe(true);
  });

  it("signals nothing, and says so, when another server has started since the processes were read", async () => {
    const one = leftover("one", "ignore");
    expect(await until(() => existsSync(one.ready), 20_000)).toBe(true);
    const report = await stopStrayProcesses({ belongs, graceMs: 200, killWaitMs: 200, proceed: async () => false });
    expect(report).toMatchObject({ abandoned: true, sigtermSent: false });
    expect(isRunning(one.pid)).toBe(true);
  });

  it("sends no SIGKILL, and reports that SIGTERM had been sent, when another server starts after that (#241 C3)", async () => {
    const one = leftover("late", "ignore");
    expect(await until(() => existsSync(one.ready), 20_000)).toBe(true);
    let asked = 0;
    // Allowed before the first signal, refused before SIGKILL.
    const report = await stopStrayProcesses({ belongs, graceMs: 200, killWaitMs: 200, proceed: async () => ++asked === 1 });
    expect(asked).toBe(2);
    expect(report).toMatchObject({ abandoned: true, sigtermSent: true });
    expect(isRunning(one.pid)).toBe(true);
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
  const run = { leaderPid: 200, leaderStart: "t200", folders: ["/agents/c/conv"], groups: new Set<number>(), known: new Map<number, string>() };
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
    const recorded = { ...run, groups: new Set([250, 400]), known: new Map<number, string>() };
    expect(runTargets({ run: recorded, procs, cwds: new Map(), uid: UID, self }).groups).toEqual([200, 210]);
    const known = { ...recorded, known: new Map([[400, "t400"]]) };
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

  it("signals a recorded process only while it is the same process, and brings what is below it once its parent is gone (#241 A6)", () => {
    // The command 210 ended; its job 310, recorded with its start time, was reparented to 1 and has a child 311 of its own.
    const orphaned = [p(90, 1, 90), p(100, 90, 90), p(310, 1, 210), p(311, 310, 210), p(400, 1, 400)];
    const recorded = { ...run, known: new Map([[310, "t310"]]), groups: new Set([210]) };
    expect(runTargets({ run: recorded, procs: orphaned, cwds: new Map(), uid: UID, self })).toEqual({ groups: [210], pids: [310, 311] });
    // The id now belongs to another process (another start time): not the run's, nor its group, nor what is below it.
    const reused = orphaned.map((q) => (q.pid === 310 ? { ...q, start: "later" } : q));
    expect(runTargets({ run: recorded, procs: reused, cwds: new Map(), uid: UID, self })).toEqual({ groups: [], pids: [] });
  });

  it("never signals a group that has a member with a controlling terminal, though one of its members is known", () => {
    // A person's shell shares the recorded group of a job.
    const mixed = [p(90, 1, 90), p(100, 90, 90), p(310, 1, 210), p(600, 1, 210, UID, { tty: true })];
    const recorded = { ...run, known: new Map([[310, "t310"]]), groups: new Set([210]) };
    expect(runTargets({ run: recorded, procs: mixed, cwds: new Map(), uid: UID, self })).toEqual({ groups: [], pids: [310] });
  });

  it("finds leftovers of runs no server owns by their folder alone: this user's, without a terminal, with their descendants, never the server or its ancestors (#241 A2)", () => {
    const table = [p(90, 1, 90), p(100, 90, 90), p(300, 1, 300), p(301, 300, 300), p(302, 301, 300), p(310, 1, 310, UID, { tty: true }), p(311, 310, 310, UID, { tty: true }), p(400, 1, 400), p(500, 1, 500, 0)];
    const here = new Map([
      [300, "/agents/c/conv/sub"],
      [310, "/agents/c/conv"],
      [400, "/home/someone"],
      [500, "/agents/c/conv"],
      [100, "/agents/c/conv"],
      [90, "/agents/c/conv"],
    ]);
    const belongs = (cwd: string) => cwd.startsWith("/agents/c/conv");
    // 300 leads its own group, so the group comes with it; the terminal's shell, another user's process, an unrelated one and the server with its parent do not.
    expect(strayTargets({ procs: table, cwds: here, uid: UID, self, belongs })).toEqual({ groups: [300], pids: [300, 301, 302] });
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
