/**
 * Whether the process that claimed a piece of durable work is still running.
 * Shared by the production store (agent runs), the media jobs (proxy work) and
 * the render jobs, which record their owner as a process id on a host.
 *
 * A process id alone can name another process after a restart, so an owner
 * recorded by `currentProcess()` also carries its process's start time as `ps`
 * reports it. An owner whose process id is alive but started at another time
 * is a different process, so the owner is gone. An owner recorded without a
 * start time (an older record, or one written where `ps` could not be read) is
 * checked by process id only, as before.
 */
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

export interface ProcessOwner {
  pid: number;
  host: string;
  /** When the process started, in milliseconds since the epoch at one-second precision, as `ps` reports it. */
  startedAt?: number;
}

/**
 * When the process with this id started, read from `ps` at one-second
 * precision; null when there is no such process or `ps` cannot say.
 */
export function processStartedAt(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      // A fixed locale and zone, so every process reads the same start time the same way.
      env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    const ms = out ? Date.parse(`${out} UTC`) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

let ownStart: number | null | undefined;
function ownStartedAt(): number | null {
  if (ownStart === undefined) ownStart = processStartedAt(process.pid);
  return ownStart;
}

/** True or false on this host; null when the owner ran on another host and cannot be checked. */
export function ownerAlive(owner: ProcessOwner): boolean | null {
  if (owner.host !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (typeof owner.startedAt !== "number") return true;
  const actual = owner.pid === process.pid ? ownStartedAt() : processStartedAt(owner.pid);
  // When the start time cannot be read, the live process id is taken to be the owner.
  return actual === null || actual === owner.startedAt;
}

export function currentProcess(): ProcessOwner {
  const startedAt = ownStartedAt();
  return { pid: process.pid, host: hostname(), ...(startedAt !== null ? { startedAt } : {}) };
}
