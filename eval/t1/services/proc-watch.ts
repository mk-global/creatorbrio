/**
 * The Linux process watcher (#225): a read-only container that shares the
 * subject's process namespace (`--pid container:<subject>`) and has no network,
 * no writable file system and one capability (reading other users' `/proc`
 * entries). It polls `/proc` quickly and records every new process with its
 * parent and executable, and whether that executable is the Claude CLI binary
 * (the installed path, or any file of exactly its size: a copy under another
 * name), so a second model session the app did not start can be flagged. It
 * also re-reads the executable of every live process on each poll, so a shell
 * that becomes the CLI after a delay (`exec` in place) is recorded again as a
 * run of the CLI, with the parent it started with. A run of the CLI also gets
 * its role (#237), read from `/proc/<pid>/cmdline` when it is first seen as the
 * CLI; only the role is written, never the arguments, which hold the person's
 * task and the system prompt. The
 * subject runs as an unprivileged user and cannot signal or ptrace this root
 * process.
 *
 * Its recording is proved, not assumed: it starts a short-lived child of its
 * own every two seconds and the heartbeat is alive only while the previous
 * one was seen by the same polling loop.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { cliRoleOf, type CliRole } from "../lib/procs";
import { heartbeat, jsonl, loadConfig, onStop } from "./common";

const cfg = loadConfig();
const out = jsonl("procs.jsonl");
const POLL_MS = 25;

/** The CLI binary in the subject's image, as the host read it from the image (a root-owned, read-only file the subject cannot replace). */
const cli = cfg.cli ?? null;
/** Every live process (by pid and start time) with what it was when first seen: its parent then, and the executable it last had. */
const live = new Map<string, { ppid: number; exe?: string; cli?: boolean; pid: number }>();
/** The watcher's own self-test children, by the same identity; dropped when they exit, so a later process that reuses a pid is never taken for one. */
const selfTestKeys = new Set<string>();
let lastTick = Date.now();
let lastSelfTest = Date.now();

/** `/proc/<pid>/stat`: the parent pid and the start time (clock ticks), which together tell a reused pid from the original. */
function statOf(pid: string): { ppid: number; start: string } | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is in parentheses and may hold spaces; the fields after the last `)` are fixed.
    const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(rest[1]), start: rest[19] };
  } catch {
    return null;
  }
}

/** A process's executable and its size, or nothing when it exited or cannot be read. */
function exeOf(name: string): { exe: string; size: number } | null {
  try {
    return { exe: readlinkSync(`/proc/${name}/exe`).replace(/ \(deleted\)$/, ""), size: statSync(`/proc/${name}/exe`).size };
  } catch {
    return null;
  }
}

const isCliExe = (e: { exe: string; size: number } | null) => Boolean(cli && e && (e.exe === cli.path || e.size === cli.size));

/** The role of a run of the CLI from its arguments, read once when it is first seen as the CLI; `unknown` when they cannot be read (it already exited). */
function roleOf(name: string): CliRole {
  try {
    const raw = readFileSync(`/proc/${name}/cmdline`);
    return cliRoleOf(raw.toString("utf8").split("\0").filter((a, i, all) => i < all.length - 1 || a !== ""));
  } catch {
    return "unknown";
  }
}

function poll() {
  const at = Date.now();
  lastTick = at;
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return;
  }
  const present = new Set<string>();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const st = statOf(name);
    if (!st) continue;
    const key = `${name}|${st.start}`;
    present.add(key);
    const known = live.get(key);
    const pid = Number(name);
    if (!known) {
      const e = exeOf(name);
      live.set(key, { ppid: st.ppid, exe: e?.exe, cli: isCliExe(e), pid });
      // A child of this watcher is its own self-test, the only processes whose parent is a process the harness started here.
      if (st.ppid === process.pid) {
        selfTestKeys.add(key);
        lastSelfTest = at;
        continue;
      }
      out.write({ type: "process", at, pid, ppid: st.ppid, ...(e ? { exe: e.exe } : {}), ...(isCliExe(e) ? { cli: true, role: roleOf(name) } : {}) });
      continue;
    }
    if (selfTestKeys.has(key)) {
      lastSelfTest = at;
      continue;
    }
    // A live process that changed its executable (`exec` in place, after a delay or not) is a new run of whatever it became: recorded again, with its original parent.
    const e = exeOf(name);
    if (e && e.exe !== known.exe) {
      known.exe = e.exe;
      known.cli = isCliExe(e);
      out.write({ type: "process", at, pid, ppid: known.ppid, exe: e.exe, execed: true, ...(isCliExe(e) ? { cli: true, role: roleOf(name) } : {}) });
    }
  }
  // A run of the CLI that is gone is recorded as ended, for triage.
  for (const [key, p] of live) {
    if (present.has(key)) continue;
    if (p.cli) out.write({ type: "exit", at, pid: p.pid });
    live.delete(key);
  }
  for (const key of selfTestKeys) if (!present.has(key)) selfTestKeys.delete(key);
}

const poller = setInterval(poll, POLL_MS);
// The proof of recording: a child that lives a moment, which the loop must see.
const selfTest = setInterval(() => {
  spawn("/bin/sleep", ["0.2"], { stdio: "ignore" });
}, 2000);
poll();
const hb = heartbeat(out, { procs: () => Date.now() - lastTick < 1000 && Date.now() - lastSelfTest < 6000 });
out.write({ type: "ready", at: Date.now(), cli: cli ? { path: cli.path, size: cli.size } : null });
onStop(() => {
  clearInterval(hb);
  clearInterval(poller);
  clearInterval(selfTest);
});
