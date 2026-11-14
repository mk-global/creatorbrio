import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  censusAvailable,
  createTestRun,
  endAbandonedRuns,
  endTestRun,
  processStarted,
  processesInside,
  runsFolder,
  stopProcessesInside,
} from "./helpers/browser-census";

// #204: the census that fails a test run when a browser it launched outlives
// it. Plain Node processes stand in for browsers: what matters is the profile
// path on their command line. Every folder is inside a temporary base, never
// the folder of the run executing these tests.
let base: string;
const started: ChildProcess[] = [];

/** A long-lived process whose command line names `profile`, as a browser's does. */
function standIn(profile: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)", "--", `--user-data-dir=${profile}`], {
    detached: true,
    stdio: "ignore",
  });
  started.push(child);
  return child;
}

/** Whether `child` exits within a second: a killed child does, one left running does not. */
async function exits(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Waits until `ps` lists the stand-in, which it does only once it has started. */
async function listed(folder: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processesInside(folder).length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "creatorbrio-census-"));
});

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await rm(base, { recursive: true, force: true });
});

describe.skipIf(!censusAvailable)("test run browser census (#204)", () => {
  it("counts only processes naming a path inside the run's folder, not a sibling sharing its name's start", async () => {
    const run = createTestRun(base);
    const inside = standIn(path.join(run.workers, "puppeteer_dev_chrome_profile-a"));
    standIn(`${run.root}-other/puppeteer_dev_chrome_profile-b`);
    standIn(path.join(base, "puppeteer_dev_chrome_profile-c"));
    await listed(run.root, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(processesInside(run.root)).toEqual([inside.pid]);
  });

  it("ends a run by stopping its surviving processes and removing its folder, leaving every other process running", async () => {
    const run = createTestRun(base);
    const workerBrowser = standIn(path.join(run.workers, "puppeteer_dev_chrome_profile-a"));
    const serverBrowser = standIn(path.join(run.appServers, "puppeteer_dev_chrome_profile-b"));
    const unrelated = standIn(path.join(base, "elsewhere", "puppeteer_dev_chrome_profile-c"));
    await mkdir(path.join(run.workers, "puppeteer_dev_chrome_profile-a"));
    await mkdir(path.join(run.appServers, "puppeteer_dev_chrome_profile-b"));
    await listed(run.root, 2);

    const census = await endTestRun(run);

    expect(census).toEqual({ survivors: 2, workerProfiles: 1, appServerProfiles: 1 });
    expect(await exits(workerBrowser)).toBe(true);
    expect(await exits(serverBrowser)).toBe(true);
    expect(await exits(unrelated)).toBe(false);
    expect(existsSync(run.root)).toBe(false);
  });

  it("stops a found process's whole group, so a child without the profile path on its command line goes too", async () => {
    const run = createTestRun(base);
    const childPidFile = path.join(base, "child.pid");
    // A group leader naming the run's folder, which starts a child that does not.
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn("sleep", ["600"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(childPidFile)}, String(c.pid)); setTimeout(() => {}, 600000);`,
        "--",
        `--user-data-dir=${path.join(run.workers, "puppeteer_dev_chrome_profile-a")}`,
      ],
      { detached: true, stdio: "ignore" }
    );
    started.push(leader);
    const deadline = Date.now() + 5_000;
    while (!existsSync(childPidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const child = Number(await readFile(childPidFile, "utf8"));
    expect(processesInside(run.root)).toEqual([leader.pid]);

    expect((await endTestRun(run)).survivors).toBe(1);
    expect(await exits(leader)).toBe(true);
    const childGone = async () => {
      for (const until = Date.now() + 2_000; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
        try {
          process.kill(child, 0);
        } catch {
          return true;
        }
      }
      return false;
    };
    expect(await childGone()).toBe(true);
  });

  it("reports a clean run as clean", async () => {
    const run = createTestRun(base);
    expect(await endTestRun(run)).toEqual({ survivors: 0, workerProfiles: 0, appServerProfiles: 0 });
  });

  it("cleans up a run whose runner died, and leaves a running run and any folder it did not create alone", async () => {
    // A run whose owner has exited.
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
    const ownerStarted = await (async () => {
      const deadline = Date.now() + 5_000;
      let value: string | null = null;
      while (!(value = processStarted(owner.pid!)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return value;
    })();
    expect(ownerStarted).not.toBeNull();
    const exited = new Promise((resolve) => owner.once("exit", resolve));
    owner.kill("SIGKILL");
    await exited;
    const dead = path.join(runsFolder(base), `run-${owner.pid}-dead`);
    await mkdir(path.join(dead, "workers"), { recursive: true });
    await writeFile(path.join(dead, "owner.json"), JSON.stringify({ pid: owner.pid, started: ownerStarted }));
    const orphan = standIn(path.join(dead, "workers", "puppeteer_dev_chrome_profile-a"));

    // A run still running: this process owns it.
    const running = createTestRun(base);
    const inUse = standIn(path.join(running.workers, "puppeteer_dev_chrome_profile-b"));

    // A folder this code did not write.
    const foreign = path.join(runsFolder(base), "something-else");
    await mkdir(foreign);
    const foreignProcess = standIn(path.join(foreign, "puppeteer_dev_chrome_profile-c"));
    await listed(runsFolder(base), 3);

    expect(await endAbandonedRuns(base)).toEqual({ runs: 1, survivors: 1 });
    expect(await exits(orphan)).toBe(true);
    expect(await exits(inUse)).toBe(false);
    expect(await exits(foreignProcess)).toBe(false);
    expect((await readdir(runsFolder(base))).sort()).toEqual([path.basename(running.root), "something-else"].sort());
  });

  it("treats a reused process ID as a different, dead owner", async () => {
    const reused = path.join(runsFolder(base), `run-${process.pid}-reused`);
    await mkdir(reused, { recursive: true });
    await writeFile(path.join(reused, "owner.json"), JSON.stringify({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970" }));
    expect(await endAbandonedRuns(base)).toEqual({ runs: 1, survivors: 0 });
    expect(existsSync(reused)).toBe(false);
  });

  it("stops nothing when the folder names no process", async () => {
    const run = createTestRun(base);
    expect(await stopProcessesInside(run.root, 100)).toBe(0);
  });
});
