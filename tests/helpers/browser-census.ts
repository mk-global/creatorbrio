/**
 * Which headless browsers a test run launched, and whether any outlived it
 * (#204).
 *
 * Every browser that Puppeteer launches with a temporary profile makes that
 * profile under `PUPPETEER_TMP_DIR`, and every one of its processes carries
 * the profile's path on its command line. Global setup points that variable at
 * a folder created for the run, so a process is the run's own exactly when its
 * command line names a path inside that folder. Nothing else is ever matched:
 * not a browser name, a profile-name pattern or a process's age, all of which
 * the person's own browsers and the running app's export browser share.
 *
 * Browsers launched with their own `userDataDir` (the overlay renderer and the
 * render parity tests) are not seen here; they close in their own suites.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The folder that holds one folder per test run. */
export function runsFolder(base: string = tmpdir()): string {
  return path.join(base, "creatorbrio-test-runs");
}

export interface TestRun {
  /** The run's own folder; everything the run's browsers create is inside it. */
  root: string;
  /** `PUPPETEER_TMP_DIR` for the test workers. */
  workers: string;
  /** `PUPPETEER_TMP_DIR` for the app servers the browser tests start. */
  appServers: string;
}

/** When `pid` started, as `ps` reports it, or null when no such process is running. */
export function processStarted(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Creates a run's folders, recording this process as their owner. */
export function createTestRun(base?: string): TestRun {
  const parent = runsFolder(base);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(parent, `run-${process.pid}-`));
  writeFileSync(path.join(root, "owner.json"), JSON.stringify({ pid: process.pid, started: processStarted(process.pid) }));
  const run = { root, workers: path.join(root, "workers"), appServers: path.join(root, "app-servers") };
  mkdirSync(run.workers);
  mkdirSync(run.appServers);
  return run;
}

/** The process IDs whose command line names a path inside `folder`. */
export function processesInside(folder: string): number[] {
  const marker = folder.endsWith(path.sep) ? folder : folder + path.sep;
  const listing = execFileSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const pids: number[] = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[1]) !== process.pid && match[2].includes(marker)) pids.push(Number(match[1]));
  }
  return pids;
}

/** Kills every process inside `folder` and waits, bounded, for them to go; returns how many there were. */
export async function stopProcessesInside(folder: string, waitMs = 5_000): Promise<number> {
  const found = processesInside(folder);
  for (const pid of found) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + waitMs;
  while (processesInside(folder).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return found.length;
}

/** The browser profiles still inside `folder`. */
export function profilesInside(folder: string): string[] {
  try {
    return readdirSync(folder).filter((name) => name.startsWith("puppeteer_dev_"));
  } catch {
    return [];
  }
}

export interface RunCensus {
  /** Browser processes of the run still alive at its end, now killed. */
  survivors: number;
  /** Profiles left by the test workers' browsers, now removed. */
  workerProfiles: number;
  /** Profiles left by the app servers' browsers, now removed. */
  appServerProfiles: number;
}

/**
 * Ends a run: kills its surviving browsers, counts the profiles left behind
 * and removes the run's folder.
 */
export async function endTestRun(run: TestRun): Promise<RunCensus> {
  const survivors = await stopProcessesInside(run.root);
  const census = {
    survivors,
    workerProfiles: profilesInside(run.workers).length,
    appServerProfiles: profilesInside(run.appServers).length,
  };
  rmSync(run.root, { recursive: true, force: true });
  return census;
}

/**
 * Ends the runs whose owner is no longer running, such as one whose runner was
 * killed before its teardown: kills their browsers and removes their folders.
 * A run whose owner still runs, such as another checkout's test run at the
 * same time, is left alone. Returns how many processes were killed.
 */
export async function endAbandonedRuns(base?: string): Promise<{ runs: number; survivors: number }> {
  const parent = runsFolder(base);
  let runs = 0;
  let survivors = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(parent);
  } catch {
    return { runs, survivors };
  }
  for (const name of entries) {
    const root = path.join(parent, name);
    let owner: { pid?: unknown; started?: unknown };
    try {
      owner = JSON.parse(readFileSync(path.join(root, "owner.json"), "utf8"));
    } catch {
      // Not a run folder this code wrote, or one still being created: left alone.
      continue;
    }
    if (typeof owner.pid !== "number" || typeof owner.started !== "string") continue;
    // The same process ID started at the same time is the same process.
    if (processStarted(owner.pid) === owner.started) continue;
    survivors += await stopProcessesInside(root);
    rmSync(root, { recursive: true, force: true });
    runs++;
  }
  return { runs, survivors };
}
