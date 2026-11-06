/**
 * Whether the process that claimed a piece of durable work is still running.
 * Shared by the production store (agent runs) and the media jobs (proxy work),
 * which both record their owner as a process id on a host.
 */
import { hostname } from "node:os";

export interface ProcessOwner {
  pid: number;
  host: string;
}

/** True or false on this host; null when the owner ran on another host and cannot be checked. */
export function ownerAlive(owner: ProcessOwner): boolean | null {
  if (owner.host !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function currentProcess(): ProcessOwner {
  return { pid: process.pid, host: hostname() };
}
