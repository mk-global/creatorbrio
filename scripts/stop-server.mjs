#!/usr/bin/env node
// Stop the CreatorBrio server this checkout is running, and nothing else.
//
// Pure Node, no dependencies.
//
// `/stop` used to kill whatever listened on port 3000. A server started with
// `/start 3010` was left running, while an unrelated app on 3000, or another
// worktree's CreatorBrio, was killed instead. A port number says nothing about
// who owns the process behind it, so this script decides from the process
// itself. A listening process counts as this checkout's server only when all
// of these hold:
//
//   - it belongs to the current user,
//   - its command line is a Next.js server (`next dev`, `next start`, or the
//     `next-server` worker that actually holds the socket), and
//   - its working directory is this checkout's root. `npm run dev`, `npm start`
//     and scripts/dev-server.mjs all run Next.js from there, and every worktree
//     has its own root, so this is what tells instances apart.
//
// Without a port, the script stops the one server that matches; with several
// it lists them and stops none. With a port, it stops that port's server only
// if it matches, and otherwise says what is there and leaves it running.
// Nothing is recorded at start, so there is no state to go stale.
//
// The server's descendants (a Design Agent run and what it started) are
// listed before the server is signalled and stopped after it, if any outlived
// it: SIGTERM, then SIGKILL after a bounded wait. Each is identified by its
// process id and start time, so a process id reused meanwhile is never hit.
// The server stops its own contained runs when it is signalled (#241); this
// covers a server that could not.
//
// Usage: node scripts/stop-server.mjs [port]
// Exit status: 0 stopped or nothing to stop, 1 refused or ambiguous, 2 usage.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The program itself, never its arguments: the `next-server (vX)` process that
 * holds the socket, or `node …/next dev|start`. Anchored at the start because
 * an argument can contain anything; the design agent runs as `claude -p
 * "<the user's message>"` from this checkout, and a message such as "move the
 * CTA to the next slide" must not make it look like a server.
 */
const NEXT_SERVER_COMMAND =
  /^(next-server(\s|$)|\S*\bnode(\.exe)?\s+\S*[\\/]next\s+(dev|start)(\s|$))/;

const STOP_TIMEOUT_MS = 10_000;
const DESCENDANT_GRACE_MS = 3_000;

// ---------------------------------------------------------------------------
// Reading the system. Each probe answers two questions: which processes listen
// on which TCP ports, and who/what/where a process is.

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    // lsof exits 1 when it finds nothing, still printing what it found.
    return typeof err?.stdout === "string" ? err.stdout : "";
  }
}

/** Reads `lsof -nP -iTCP -sTCP:LISTEN -Fpn` output as {pid, port} pairs. */
export function parseLsofListeners(output) {
  const found = new Map();
  let pid = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid !== null) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (Number.isInteger(port) && port > 0) found.set(`${pid}:${port}`, { pid, port });
    }
  }
  return [...found.values()];
}

/** Reads `ps -o uid= -o command= -p <pid>` output. */
export function parsePsLine(output) {
  const match = output.trim().match(/^(\d+)\s+(.*)$/);
  return match ? { uid: Number(match[1]), command: match[2].trim() } : null;
}

/** Reads `ps -A -o pid=,ppid=,uid=,lstart=` output; the start time identifies a process with its id. */
export function parsePsProcesses(output) {
  const out = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), start: m[4] });
  }
  return out;
}

/** Reads one `/proc/<pid>/stat` line: the parent and the start time (field 22). */
export function parseProcStatLine(text) {
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) && fields[19] !== undefined ? { ppid, start: fields[19] } : null;
}

/** Every process descended from `root`, from one listing; never `root` itself. */
export function descendantsOf(root, processes) {
  const children = new Map();
  for (const p of processes) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const found = [];
  const seen = new Set([root]);
  const queue = [...(children.get(root) ?? [])];
  while (queue.length > 0) {
    const p = queue.shift();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    found.push(p);
    queue.push(...(children.get(p.pid) ?? []));
  }
  return found;
}

/** Reads `lsof -a -p <pid> -d cwd -Fn` output: the `n` line is the directory. */
export function parseLsofCwd(output) {
  const line = output.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

/**
 * Reads /proc/net/tcp or /proc/net/tcp6 as a map from socket inode to port,
 * for sockets in the LISTEN state (st 0A).
 */
export function parseProcNetTcp(text) {
  const byInode = new Map();
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== "0A") continue;
    const port = parseInt(cols[1].split(":").pop(), 16);
    if (port > 0) byInode.set(cols[9], port);
  }
  return byInode;
}

function realDir(dir) {
  try {
    // The native call also returns the on-disk letter case, which matters on
    // macOS, where /Users/me/CreatorBrio and /Users/me/creatorbrio are one folder.
    return fs.realpathSync.native(dir);
  } catch {
    return null;
  }
}

/**
 * macOS and other systems with lsof. lsof only reports sockets of processes it
 * may inspect, which for an ordinary user means their own.
 */
export const lsofProbe = {
  listListeners() {
    return parseLsofListeners(run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  },
  processInfo(pid) {
    const ps = parsePsLine(run("ps", ["-ww", "-o", "uid=", "-o", "command=", "-p", String(pid)]));
    if (!ps) return null;
    const cwd = parseLsofCwd(run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]));
    return { ...ps, cwd: cwd && realDir(cwd) };
  },
  listProcesses() {
    return parsePsProcesses(run("ps", ["-A", "-o", "pid=,ppid=,uid=,lstart="]));
  },
};

/**
 * Linux, from /proc. Some sandboxes ship an lsof that cannot map sockets to
 * processes; /proc always can, for every process the user may inspect.
 */
export const procProbe = {
  listListeners() {
    const ports = new Map();
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        for (const [inode, port] of parseProcNetTcp(fs.readFileSync(table, "utf-8"))) {
          ports.set(inode, port);
        }
      } catch {
        // No IPv6 table, for example.
      }
    }
    const found = new Map();
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let fds;
      try {
        fds = fs.readdirSync(`/proc/${entry}/fd`);
      } catch {
        continue; // Gone, or not ours to inspect.
      }
      for (const fd of fds) {
        let target;
        try {
          target = fs.readlinkSync(`/proc/${entry}/fd/${fd}`);
        } catch {
          continue;
        }
        const inode = target.match(/^socket:\[(\d+)\]$/)?.[1];
        const port = inode && ports.get(inode);
        if (port) found.set(`${entry}:${port}`, { pid: Number(entry), port });
      }
    }
    return [...found.values()];
  },
  processInfo(pid) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
      const command = fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf-8")
        .split("\0")
        .join(" ")
        .trim();
      return { uid, command, cwd: realDir(`/proc/${pid}/cwd`) };
    } catch {
      return null;
    }
  },
  listProcesses() {
    const out = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = parseProcStatLine(fs.readFileSync(`/proc/${entry}/stat`, "utf-8"));
        const uid = Number(fs.readFileSync(`/proc/${entry}/status`, "utf-8").match(/^Uid:\s+(\d+)/m)?.[1]);
        if (stat && Number.isInteger(uid)) out.push({ pid: Number(entry), ...stat, uid });
      } catch {
        // Gone, or not ours to inspect.
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Deciding. Pure functions of what the probe saw, so every case is testable.

/**
 * "ours": this checkout's CreatorBrio server. "other-checkout": a Next.js
 * server of the same user running from another directory, such as another
 * worktree. "unrelated": anything else, including another user's process.
 * "gone": exited since it was listed.
 */
export function classify(info, { root, uid }) {
  if (!info) return "gone";
  if (info.uid !== uid || !NEXT_SERVER_COMMAND.test(info.command)) return "unrelated";
  return info.cwd === root ? "ours" : "other-checkout";
}

function describe({ pid, port, info, kind }) {
  const what = info ? info.command.replace(/\s+/g, " ").slice(0, 80) : "exited";
  const where =
    kind === "other-checkout" ? `, CreatorBrio/Next.js from ${info.cwd}` : "";
  return `  :${port}  PID ${pid}  ${what}${where}`;
}

/**
 * Decides what to stop. `listeners` are {pid, port, info} as the probe saw
 * them. Returns {action: "stop", pids, ports, message} or {action: "none" |
 * "refuse" | "ambiguous", message}; only "stop" lets anything be signalled.
 */
export function planStop({ root, uid, port, listeners }) {
  const seen = listeners.map((l) => ({ ...l, kind: classify(l.info, { root, uid }) }));

  if (port !== undefined) {
    const onPort = seen.filter((l) => l.port === port && l.kind !== "gone");
    if (onPort.length === 0) {
      return { action: "none", message: `No process of yours is listening on :${port}.` };
    }
    const ours = onPort.filter((l) => l.kind === "ours");
    const others = onPort.filter((l) => l.kind !== "ours");
    if (ours.length === 0) {
      const hint = others.some((l) => l.kind === "other-checkout")
        ? "\nTo stop another checkout's server, run /stop from that checkout."
        : "";
      return {
        action: "refuse",
        message:
          `Port ${port} is not served by this checkout's CreatorBrio server (${root}), ` +
          `so nothing was stopped:\n${others.map(describe).join("\n")}${hint}`,
      };
    }
    const leftRunning = others.length
      ? `\nLeft running on the same port:\n${others.map(describe).join("\n")}`
      : "";
    return {
      action: "stop",
      pids: [...new Set(ours.map((l) => l.pid))],
      ports: [port],
      message: leftRunning,
    };
  }

  const ours = seen.filter((l) => l.kind === "ours");
  const pids = [...new Set(ours.map((l) => l.pid))];
  const otherCheckouts = seen.filter((l) => l.kind === "other-checkout");
  const elsewhere = otherCheckouts.length
    ? `\nServers from other checkouts were left running:\n${otherCheckouts.map(describe).join("\n")}`
    : "";

  if (pids.length === 0) {
    return {
      action: "none",
      message: `No CreatorBrio server from this checkout (${root}) is running.${elsewhere}`,
    };
  }
  if (pids.length > 1) {
    return {
      action: "ambiguous",
      message:
        `Found ${pids.length} CreatorBrio servers from this checkout (${root}), so nothing was stopped:\n` +
        `${ours.map(describe).join("\n")}\n` +
        "Run /stop <port> to choose which one to stop.",
    };
  }
  return {
    action: "stop",
    pids,
    ports: [...new Set(ours.map((l) => l.port))].sort((a, b) => a - b),
    message: elsewhere,
  };
}

// ---------------------------------------------------------------------------
// Acting.

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** Reads a port argument; "" or undefined means none. Returns NaN if invalid. */
export function parsePortArg(arg) {
  if (arg === undefined || arg.trim() === "") return undefined;
  const text = arg.trim();
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  return port >= 1 && port <= 65535 ? port : NaN;
}

/**
 * @typedef {{ pid: number, ppid: number, uid: number, start: string }} ListedProcess
 * @typedef {{
 *   listListeners(): { pid: number, port: number }[],
 *   processInfo(pid: number): { uid: number, command: string, cwd: string | null } | null,
 *   listProcesses?: () => ListedProcess[],
 * }} Probe
 * @param {{
 *   args?: string[], root?: string, uid?: number, probe?: Probe,
 *   signal?: (pid: number, sig?: NodeJS.Signals) => void, alive?: (pid: number) => boolean,
 *   timeoutMs?: number, log?: (line: string) => void,
 * }} [options]
 */
export async function main({
  args = process.argv.slice(2),
  root = ROOT,
  uid = process.getuid?.(),
  probe = process.platform === "linux" ? procProbe : lsofProbe,
  signal = (pid, sig = /** @type {NodeJS.Signals} */ ("SIGTERM")) => {
    process.kill(pid, sig);
  },
  alive = isAlive,
  timeoutMs = STOP_TIMEOUT_MS,
  log = (line) => console.log(line),
} = {}) {
  if (process.platform === "win32" || uid === undefined) {
    log("/stop is not supported on Windows. Stop the server with Ctrl+C in its terminal.");
    return 1;
  }

  const port = parsePortArg(args[0]);
  if (Number.isNaN(port)) {
    log(`"${args[0]}" is not a port number. Usage: /stop [port]`);
    return 2;
  }

  const realRoot = realDir(root) ?? root;
  const listeners = probe
    .listListeners()
    .filter((l) => port === undefined || l.port === port)
    .map((l) => ({ ...l, info: probe.processInfo(l.pid) }));

  const plan = planStop({ root: realRoot, uid, port, listeners });
  if (plan.action !== "stop") {
    log(plan.message);
    return plan.action === "none" ? 0 : 1;
  }

  // The server's descendants, listed while it still runs: once it exits they
  // belong to another parent and cannot be told apart.
  const listing = probe.listProcesses?.() ?? [];
  const descendants = plan.pids.flatMap((pid) => descendantsOf(pid, listing)).filter((p) => p.uid === uid);

  // Check each process again right before signalling it, so a PID that has
  // exited, or been reused by something else since it was listed, is never hit.
  const signalled = [];
  let exitedMeanwhile = 0;
  for (const pid of plan.pids) {
    const now = classify(probe.processInfo(pid), { root: realRoot, uid });
    if (now === "gone") {
      log(`The server with PID ${pid} has already exited.`);
      exitedMeanwhile++;
      continue;
    }
    if (now !== "ours") {
      log(`PID ${pid} is no longer this checkout's server; left alone.`);
      continue;
    }
    try {
      signal(pid);
      signalled.push(pid);
    } catch (err) {
      log(`Could not stop PID ${pid}: ${err?.message ?? err}`);
    }
  }
  if (signalled.length === 0) return exitedMeanwhile === plan.pids.length ? 0 : 1;

  const deadline = Date.now() + timeoutMs;
  while (signalled.some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const ports = plan.ports.map((p) => `:${p}`).join(", ");
  const still = signalled.filter(alive);
  // Only once the server is gone: until then its descendants are its own to stop.
  if (still.length === 0) {
    const leftover = await stopDescendants(descendants, { probe, signal, alive });
    if (leftover.stopped > 0) log(`Stopped ${leftover.stopped} process(es) the server had started that outlived it.`);
    if (leftover.left > 0) log(`${leftover.left} process(es) the server had started are still running after SIGKILL.`);
  }
  if (still.length > 0) {
    log(
      `Asked the server on ${ports} to stop (PID ${signalled.join(", ")}), ` +
        `but PID ${still.join(", ")} is still running after ${timeoutMs / 1000}s.`
    );
    return 1;
  }
  log(`Stopped the CreatorBrio server on ${ports} (PID ${signalled.join(", ")}).${plan.message}`);
  return 0;
}

/**
 * Stops the recorded descendants still running as the same processes (same
 * id and start time): SIGTERM, a bounded wait, then SIGKILL.
 * @param {ListedProcess[]} recorded
 * @param {{ probe: Probe, signal: (pid: number, sig?: NodeJS.Signals) => void, alive: (pid: number) => boolean, graceMs?: number }} options
 */
export async function stopDescendants(recorded, { probe, signal, alive, graceMs = DESCENDANT_GRACE_MS }) {
  if (recorded.length === 0) return { stopped: 0, left: 0 };
  const same = () => {
    const now = new Map((probe.listProcesses?.() ?? []).map((p) => [p.pid, p.start]));
    return recorded.filter((p) => now.get(p.pid) === p.start && alive(p.pid));
  };
  const targets = same();
  if (targets.length === 0) return { stopped: 0, left: 0 };
  for (const p of targets) {
    try {
      signal(p.pid, "SIGTERM");
    } catch {
      // Gone meanwhile.
    }
  }
  const deadline = Date.now() + graceMs;
  while (same().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const p of same()) {
    try {
      signal(p.pid, "SIGKILL");
    } catch {
      // Gone meanwhile.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { stopped: targets.length, left: same().length };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realDir(process.argv[1]) ?? "").href;
if (invokedDirectly) {
  process.exitCode = await main();
}
