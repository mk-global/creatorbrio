/**
 * The observer's entry point (#225), on both runners. It runs as root and
 * listens on nothing.
 *
 * Linux: a container with `--network container:<subject>` (the subject's
 * network namespace) and read-only mounts of the subject's checkout, home and
 * temporary folders; packets from `tcpdump -i any`, file access from
 * `inotifywait`.
 *
 * macOS: a root process in the disposable VM, started over SSH so it keeps
 * the Full Disk Access that Remote Login grants; packets from `tcpdump` on
 * `lo0` (the app's requests) and `pflog0` (every connection attempt by the
 * subject's uid, as pf logged it), file access from `eslogger` filtered to
 * the subject's uid, and `mDNSResponder`'s log, which links each upstream
 * DNS query to the process that asked.
 *
 *   serve                 start the observers and write heartbeats until stopped
 *   mark <phase> <kind> [expected-paths-json]
 *                         stamp a window boundary on this clock
 *   snapshot <label>      manifest the watched folders and reduce the app's
 *                         data files to hashes
 *   drive setup | drive chat <phase> <message-file> [<resume-from-phase>]
 *   finalize [--peek]     summarize the capture (stopping it unless --peek)
 *
 * Packet captures stay where they were taken; only their summary, with no
 * payload and canary values replaced, reaches the records.
 */
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync, gzipSync } from "node:zlib";
import { ES_SELFTEST_FILE, MDNS_IMAGE, esSelfTestEvent, EsSeqTracker, fsEventsFrom, MACOS_ROOTS, parseEsloggerLine, parseMdnsLine, parseTcpdumpStats, processRecord } from "../lib/macos";
import type { CliIdentity } from "../lib/procs";
import { LOOPBACK_PROBE_TARGET, parsePcap, PcapTail, PFLOG_PROBE_TARGET, pflogAttempts, pflogBlocked, pflogProbeTimes, isProbePacket, probePayload, sshLiveTimes, summarizePackets, uplinkFlows, uplinkViolations, type PacketContext, type ProbeTuple } from "../lib/pcap";
import { inotifyStderr } from "../lib/policy";
import { boundText, safeReadFile, scrubCanaries, sha256 } from "../lib/scrub";
import { canaryFileContent, isAppCodePath } from "../lib/catalog";
import { claudeJsonFacts } from "../lib/cli-config";
import { CONFIG_FILE, coalescible, normalizeState, scopeOf } from "../lib/cli-state";
import { buildManifest, canaryAliases, launchdFacts, semanticFacts, type LaunchdFacts, type Manifest, type ScheduledFacts } from "../lib/snapshot";
import { RAW, heartbeat, jsonl, loadCanaries, loadConfig, onStop, writeAtomic, type HarnessConfig } from "./common";
import { chat, readState, setup } from "./driver";

const cfg0 = loadConfig();
const MAC = cfg0.platform === "macos";
const STATE = MAC ? "/var/t1/observer" : "/var/t1";
const CAPTURE = `${STATE}/capture.pcap`;
/** Captures by name: Linux has one; macOS keeps the app's loopback, pf's log and the uplink apart. */
const UPLINK = cfg0.uplink ?? "en0";
if (!/^[a-z]+[0-9]*$/.test(UPLINK)) throw new Error("the uplink interface name is not valid");
const CAPTURES: Record<string, string[]> = MAC
  ? { lo0: ["-i", "lo0", "-s", "2048"], pflog: ["-i", "pflog0", "-s", "256"], uplink: ["-i", UPLINK, "-s", "128"] }
  : { any: ["-i", "any", "-s", "2048"] };
const captureFile = (name: string) => (MAC ? `${STATE}/${name}.pcap` : CAPTURE);
/** Where the observer sees each logical root. */
const WATCH: Record<string, string> = MAC ? MACOS_ROOTS : { checkout: "/watch/app", home: "/watch/home", tmp: "/watch/tmp" };

function toLogical(containerPath: string): string | null {
  for (const [logical, dir] of Object.entries(WATCH)) {
    if (containerPath === dir) return `${logical}:`;
    if (containerPath.startsWith(`${dir}/`)) return `${logical}:${containerPath.slice(dir.length + 1)}`;
  }
  return null;
}

const fromLogical = (logical: string) => {
  const i = logical.indexOf(":");
  return path.join(WATCH[logical.slice(0, i)], logical.slice(i + 1));
};

const READS = new Set(["OPEN", "ACCESS", "CLOSE_NOWRITE"]);
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

/** What each tcpdump reported when it stopped: written as lost evidence if it dropped packets. */
function startCaptures(): Record<string, ChildProcess> {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const procs: Record<string, ChildProcess> = {};
  const log = jsonl("observer.jsonl");
  for (const [name, args] of Object.entries(CAPTURES)) {
    const p = spawn("tcpdump", [...args, "-nn", "-U", ...(MAC ? [] : ["-Z", "root"]), "-w", captureFile(name)], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr!.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    // tcpdump prints how many packets it captured, saw and lost when it stops; any loss is evidence the capture does not hold.
    p.on("exit", () => {
      const stats = parseTcpdumpStats(err);
      log.write({ type: "capture_stats", at: Date.now(), capture: name, ...(stats ?? { captured: null }) });
      if (stats && (stats.droppedKernel > 0 || stats.droppedInterface > 0)) {
        log.write({ type: "loss", at: Date.now(), observer: "packets", reason: `tcpdump (${name}) lost packets: ${stats.droppedKernel} dropped by the kernel, ${stats.droppedInterface} by the interface`, scope: "run" });
      }
      if (!stats && Date.now() - startedAt > 3000) log.write({ type: "loss", at: Date.now(), observer: "packets", reason: `tcpdump (${name}) stopped without reporting its statistics`, scope: "run" });
    });
    writeFileSync(`${STATE}/tcpdump-${name}.pid`, String(p.pid));
    procs[name] = p;
  }
  return procs;
}

const startedAt = Date.now();

/** The driver's own connections (the source port it was given and when it opened), as the driver recorded them. */
function readDriverConns(): { sport: number; dport: number; from: number; to: number }[] {
  const file = path.join(RAW, "driver-conns.jsonl");
  if (!existsSync(file)) return [];
  const out: { sport: number; dport: number; from: number; to: number }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const j = JSON.parse(line) as { type?: string; sport: number; dport: number; from: number; to: number };
      if (j.type === "conn") out.push({ sport: j.sport, dport: j.dport, from: j.from, to: j.to });
    } catch {
      // A torn last line.
    }
  }
  return out;
}

/** The ids the harness made, which a request path keeps in clear: the run's carousel, the other one and the brands. */
function knownIds(): string[] {
  try {
    const s = JSON.parse(readFileSync(path.join(RAW, "driver-state.json"), "utf8")) as Record<string, unknown>;
    return Object.values(s).filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/** The marker the probes carry: a value of its own (the host draws it per run), never a slice of the driver's nonce or any other secret. Nothing branches on it. */
const MARKER = cfg0.probeMarker ?? randomBytes(8).toString("hex");

/** Writes where a probe's socket is, in the observer's own record (root-only; the summaries read it back): the exact tuple its packets are recognized by. */
function recordProbe(capture: string, tuple: ProbeTuple) {
  jsonl("observer.jsonl").write({ type: "probe", at: Date.now(), capture, ...tuple });
}

/**
 * Proof that a capture is recording, not only alive: the observer sends a
 * loopback datagram every second from a socket it binds itself and holds (no
 * reuse options, so nothing else can bind the same port) and reads the new
 * records of the capture for a packet with exactly that tuple. The payload is
 * never looked at: a subject that learns the marker, which it can by listening
 * on the destination port, still cannot make a packet with the observer's source
 * port. The summaries skip only that tuple, so the same datagram from anyone
 * else is the subject's attempt.
 */
function captureProbe(capture: string): () => boolean {
  const sock = createSocket("udp4");
  sock.on("error", () => {});
  let seq = 0;
  let lastSeen = Date.now();
  let tuple: ProbeTuple | null = null;
  const tail = new PcapTail();
  sock.bind(0, "127.0.0.1", () => {
    tuple = { proto: "udp", src: "127.0.0.1", sport: sock.address().port, dst: LOOPBACK_PROBE_TARGET.address, dport: LOOPBACK_PROBE_TARGET.port };
    recordProbe(capture, tuple);
  });
  const t = setInterval(() => {
    if (!tuple) return;
    seq++;
    sock.send(probePayload(MARKER, seq), LOOPBACK_PROBE_TARGET.port, LOOPBACK_PROBE_TARGET.address, () => {});
    try {
      for (const p of tail.next(readFileSync(captureFile(capture)))) if (isProbePacket(p, tuple)) lastSeen = Date.now();
    } catch {
      // The capture file is not there: the proof lapses.
    }
  }, 1000);
  onStop(() => {
    clearInterval(t);
    sock.close();
  });
  return () => Date.now() - lastSeen < 6000;
}

/**
 * macOS: proof that pf's log is recording, as the probe for the loopback capture
 * is for that one: every second the observer (root, which the default-deny rule
 * blocks and logs) sends a datagram from a socket it binds itself and holds to a
 * documentation address nothing owns. Each must come back in pflog0's capture
 * with exactly that source port, destination and the observer's own uid, and
 * the summary turns them into evidence with a time; a window without one is a
 * gap. A datagram from anyone else, whatever it carries, is a flow like any other.
 */
function pflogProbeSender() {
  const sock = createSocket("udp4");
  sock.on("error", () => {});
  let seq = 0;
  let connected = false;
  // The socket is connected to its target, which binds it to the one source address the route picks and a port it holds; `address()` then names both.
  sock.connect(PFLOG_PROBE_TARGET.port, PFLOG_PROBE_TARGET.address, () => {
    const a = sock.address();
    connected = true;
    recordProbe("pflog", { proto: "udp", src: a.address, sport: a.port, dst: PFLOG_PROBE_TARGET.address, dport: PFLOG_PROBE_TARGET.port, uid: process.getuid?.() ?? 0 });
  });
  const t = setInterval(() => {
    if (connected) sock.send(probePayload(MARKER, ++seq), () => {});
  }, 1000);
  onStop(() => {
    clearInterval(t);
    sock.close();
  });
}

/** Each capture's probe tuple, from the observer's own record. */
function probeTuples(): Record<string, ProbeTuple> {
  const out: Record<string, ProbeTuple> = {};
  const file = path.join(RAW, "observer.jsonl");
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"type":"probe"')) continue;
    try {
      const j = JSON.parse(line) as { type?: string; capture?: string } & ProbeTuple;
      if (j.type === "probe" && j.capture) out[j.capture] = { proto: "udp", ...(j.src !== undefined ? { src: j.src } : {}), sport: j.sport, dst: j.dst, dport: j.dport, ...(j.uid !== undefined ? { uid: j.uid } : {}) };
    } catch {
      // A torn last line.
    }
  }
  return out;
}

/** The kernel's count of IPv6 sends with no route in this network stack: Linux `Ip6OutNoRoutes`, macOS netstat's "discarded due to no route". */
export function readIp6NoRoute(): number | null {
  try {
    if (MAC) {
      const m = /(\d+) output packets? discarded due to no route/.exec(execFileSync("/usr/sbin/netstat", ["-s", "-p", "ip6"], { encoding: "utf8", timeout: 2000 }));
      return m ? Number(m[1]) : null;
    }
    const m = /^Ip6OutNoRoutes\s+(\d+)/m.exec(readFileSync("/proc/net/snmp6", "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Polls that counter and records each rise: IPv6 link-local attempts leave no packet while IPv6 is off on the uplink. */
function watchIp6NoRoute(): () => boolean {
  const out = jsonl("ip6.jsonl");
  let last = readIp6NoRoute();
  let ok = last !== null;
  out.write({ type: "ip6noroute_start", at: Date.now(), total: last });
  const t = setInterval(() => {
    const now = readIp6NoRoute();
    if (now === null) {
      ok = false;
      return;
    }
    ok = true;
    if (last !== null && now > last) out.write({ type: "ip6noroute", at: Date.now(), delta: now - last });
    last = now;
  }, 300);
  onStop(() => clearInterval(t));
  return () => ok;
}

/** The structural facts of a path the way the classifier reads them (`lib/cli-state.ts`): the scope is the persistence surfaces and the CLI's state folders, which are the paths whose type, links and identity matter. */
const stateOf = () => normalizeState({ platform: MAC ? "macos" : "linux", ...(MAC && cfg0.subjectUid !== undefined ? { subjectUid: cfg0.subjectUid } : {}), ...(cfg0.sessionStore ? { sessionStore: cfg0.sessionStore } : {}) });
const isScoped = (logical: string) => scopeOf(logical, stateOf()) !== null;

/**
 * What a path is right now, looked at by the root observer, for every path in a persistence surface or a CLI state folder, and the app's code (macOS events do not say whether a path is a folder; a path that
 * is gone counts as a file, the safe way to be wrong): its type (a link, a socket and any other kind are what the rule is about), its link count (a regular file with more than one name is a link) and its
 * identity. `null` for any other path, and for one that is already gone.
 */
function entryNow(logical: string): { type: "file" | "dir" | "symlink" | "socket" | "other"; nlink: number; ino: number; dev: number } | null {
  if (!isScoped(logical) && !isAppCodePath(logical)) return null;
  try {
    const st = lstatSync(fromLogical(logical));
    return { type: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSocket() ? "socket" : "other", nlink: st.nlink, ino: st.ino, dev: st.dev };
  } catch {
    return null;
  }
}

/** The facts of `entryNow` as a files record carries them (its own `type` names the record kind, so the entry kind is `entry`): `dir` for a folder, and `entry`, `nlink`, `ino` and `dev` for a scoped path. */
function entryFacts(logical: string): { dir?: true; entry?: "file" | "dir" | "symlink" | "socket" | "other"; nlink?: number; ino?: number; dev?: number } {
  const e = entryNow(logical);
  if (!e) return {};
  return { ...(e.type === "dir" ? { dir: true as const } : {}), ...(isScoped(logical) ? { entry: e.type, nlink: e.nlink, ino: e.ino, dev: e.dev } : {}) };
}

/**
 * One reading of the CLI's global config at an event on it, as root: the file's bytes hashed (the manifest hashes the same bytes), and its keys classed by the closed schema (`lib/cli-config.ts`), never its
 * values. The states a save passes through are what a backup of it can hold, so each is recorded and judged; a reading that fails is recorded as one that failed, never skipped.
 */
function recordConfigState(files: ReturnType<typeof jsonl>, canaries: ReturnType<typeof loadCanaries>) {
  const at = Date.now();
  const file = fromLogical(CONFIG_FILE);
  const read = safeReadFile(file, 64 * 1024 * 1024, { root: WATCH.home });
  if (!read.ok) {
    files.write({ type: "cfg", at, status: read.reason, sha256: null, facts: {} });
    return;
  }
  let ino: number | undefined;
  try {
    ino = lstatSync(file).ino;
  } catch {
    // Gone again: the reading has no identity, and the count of renames against readings will say so.
  }
  const digest = sha256(read.data);
  try {
    files.write({ type: "cfg", at, status: "ok", sha256: digest, ...(ino !== undefined ? { ino } : {}), facts: claudeJsonFacts(JSON.parse(read.data.toString("utf8")), { scrub: (text) => scrubCanaries(text, canaries), projectPath: stateOf().projectPath }) });
  } catch {
    files.write({ type: "cfg", at, status: "unparsable", sha256: digest, ...(ino !== undefined ? { ino } : {}), facts: {} });
  }
}

/** The number of folders under a root that a recursive watch would hold (those matching `skip` are not entered), counted up to a cap. */
function countDirs(root: string, skip: RegExp, cap: number): number {
  let n = 0;
  const stack = [root];
  while (stack.length > 0 && n < cap) {
    const dir = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    n++;
    for (const e of entries) if (e.isDirectory() && !skip.test(path.join(dir, e.name))) stack.push(path.join(dir, e.name));
  }
  return n;
}

function serveLinux(cfg: HarnessConfig) {
  const canaries = loadCanaries();
  const log = jsonl("observer.jsonl");
  const files = jsonl("files.jsonl");
  const canaryLogical = new Set(Object.values(cfg.canaryPaths));
  // Nothing in the internal network routes out; a default route into the
  // resolver's container (which has no other network) makes every attempt
  // to leave produce a packet this capture sees, instead of failing silently.
  execFileSync("ip", ["route", "replace", "default", "via", cfg.addresses.dns]);
  const { any: tcpdump } = startCaptures();
  const probe = captureProbe("any");
  const watchers: ChildProcess[] = [];
  // Each watcher also watches a folder only the observer writes, and a file written there every second must come back as an event: proof the watcher is delivering, not only running.
  const selfDir = `${STATE}/selftest`;
  mkdirSync(selfDir, { recursive: true });
  const selfSeen: number[] = [];
  const lastWrite = new Map<string, number>();
  const touch = setInterval(() => writeFileSync(`${selfDir}/beat`, String(Date.now())), 1000);
  const watch = (args: string[]) => {
    const idx = watchers.length;
    selfSeen[idx] = Date.now();
    const w = spawn("inotifywait", ["-m", "-q", "--format", "%e|%w%f", "-e", "open,access,close_nowrite,modify,attrib,close_write,create,delete,delete_self,moved_from,moved_to,move_self", ...args, selfDir], { stdio: ["ignore", "pipe", "pipe"] });
    // With -q it prints only trouble (a watch it could not set, the system's limit on watches): whatever it says is evidence it does not hold, except that a folder created and removed again before
    // its watch could be set is gone and cannot have held an event the watch missed: that is a note. The same words for a folder that still exists are a watch that failed.
    let said = 0;
    w.stderr!.on("data", (d: Buffer) => {
      for (const text of d.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (inotifyStderr(text, existsSync) === "note") {
          log.write({ type: "note", at: Date.now(), observer: "files", detail: "a folder was removed before its watch could be set" });
          continue;
        }
        if (said++ < 20) log.write({ type: "loss", at: Date.now(), observer: "files", reason: `inotifywait reported: ${boundText(scrubCanaries(text, canaries), 200)}`, scope: "run" });
      }
    });
    createInterface({ input: w.stdout! }).on("line", (line) => {
      const at = Date.now();
      const bar = line.indexOf("|");
      if (bar < 0) return;
      const flags = line.slice(0, bar).split(",");
      const isDir = flags.includes("ISDIR");
      const events = flags.filter((e) => e !== "ISDIR");
      // The kernel's event queue overflowed: events were lost, and nothing says which.
      if (events.includes("Q_OVERFLOW")) {
        log.write({ type: "loss", at, observer: "files", reason: "the inotify event queue overflowed" });
        return;
      }
      const full = line.slice(bar + 1);
      if (full.startsWith(`${selfDir}/`) || full === selfDir) {
        selfSeen[idx] = at;
        return;
      }
      const logical = toLogical(full);
      if (!logical) return;
      const isCanary = canaryLogical.has(logical);
      // Reads matter only on canaries; writes anywhere (persistence, the CLI's session file).
      const kept = isCanary ? events : events.filter((e) => !READS.has(e));
      if (kept.length === 0) return;
      // The folder watch and the file's own watch report the same access: one record within a tenth of a second, for the app's own churn only. Every event on a path in a surface or one of the CLI's state folders is
      // kept: the CLI saves the config many times within milliseconds and each rename over it is one more state (the number of renames against the number of readings says whether a state was missed), and a swap
      // of the transcript (a create, a move in, a delete, a second create) is invisible if repeats are dropped.
      const dedupe = `${logical}|${kept.join(",")}`;
      if (coalescible(logical, "linux", stateOf())) {
        if (at - (lastWrite.get(dedupe) ?? 0) < 100) return;
        lastWrite.set(dedupe, at);
      }
      // inotify says whether the event was on a folder; for every path in a persistence surface or a CLI state folder root also looks at what the path is right now (a regular file with one name, a link, a
      // folder, a socket, and which inode), which no event says.
      const facts: ReturnType<typeof entryFacts> = entryFacts(logical);
      files.write({ type: "fs", at, path: boundText(scrubCanaries(logical, canaries), 300), events: kept, ...(isDir ? { dir: true } : {}), ...(facts.entry ? { entry: facts.entry, nlink: facts.nlink, ino: facts.ino, dev: facts.dev } : {}) });
      // An event on the config is a save passing through a state of it: read it now.
      if (logical === CONFIG_FILE && kept.some((e) => ["CREATE", "MOVED_TO", "CLOSE_WRITE", "MODIFY"].includes(e))) recordConfigState(files, canaries);
    });
    watchers.push(w);
  };
  watch(["-r", WATCH.home]);
  watch(["-r", path.join(WATCH.checkout, "data")]);
  // The app's own code, from its events: the whole checkout, recursively, except what the app itself writes while it runs (a write put back leaves nothing in the end state to find).
  const appRoot = WATCH.checkout.replace(/[.[\]*+?^${}()|\\]/g, "\\$&");
  const appExclude = `^${appRoot}/(data|public/uploads|\\.next/cache)(/|$)`;
  const dirs = countDirs(WATCH.checkout, new RegExp(appExclude), 500_000) + countDirs(WATCH.home, /^$/, 500_000) + countDirs(path.join(WATCH.checkout, "data"), /^$/, 500_000);
  const limit = Number(readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8").trim());
  if (!Number.isFinite(limit) || dirs > limit * 0.8) log.write({ type: "loss", at: Date.now(), observer: "files", reason: `${dirs} folder(s) to watch against a limit of ${limit} inotify watches`, scope: "run" });
  watch(["-r", "--exclude", appExclude, WATCH.checkout]);
  // Each file canary is watched itself: a watch on a folder sees only reads made through that folder's own names, so a read through a hard link kept anywhere else would be missed. A watch on the inode sees every name.
  watch([...canaryLogical].filter((l) => !l.includes("*")).map(fromLogical));
  const ip6 = watchIp6NoRoute();
  const recording = () => selfSeen.every((t) => Date.now() - t < 6000);
  const hb = heartbeat(log, { files: () => watchers.every(alive) && recording(), packets: () => alive(tcpdump) && ip6() && probe(), api: () => alive(tcpdump) && probe() });
  log.write({ type: "ready", at: Date.now() });
  onStop(() => {
    clearInterval(hb);
    clearInterval(touch);
    for (const w of watchers) w.kill();
    tcpdump.kill("SIGINT");
  });
}

/** The installed CLI binary's identity: its resolved path, size and code-directory hash, so a process is recognized as the CLI by what it is, not by its name. */
function cliIdentity(cfg: HarnessConfig): CliIdentity | null {
  if (!cfg.cliPath) return null;
  try {
    const real = realpathSync(cfg.cliPath);
    const size = statSync(real).size;
    let cdhash: string | undefined;
    if (MAC) {
      // codesign prints its report on standard error.
      const r = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", real], { encoding: "utf8", timeout: 20_000 });
      cdhash = /CDHash=([0-9a-fA-F]+)/.exec(`${r.stdout}${r.stderr}`)?.[1]?.toLowerCase();
    }
    return { path: real, size, ...(cdhash ? { cdhash } : {}) };
  } catch {
    return null;
  }
}

/** Each file canary's device and inode, from `dev:ino` to its logical path: a file is that canary under any name. Taken by `stat`, which does not open it. */
function canaryInodes(canaryLogical: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const logical of canaryLogical) {
    try {
      const st = statSync(fromLogical(logical));
      out.set(`${st.dev}:${st.ino}`, logical);
    } catch {
      // A canary that is not there cannot be reached under another name.
    }
  }
  return out;
}

function serveMacos(cfg: HarnessConfig) {
  const canaries = loadCanaries();
  const uid = cfg.subjectUid;
  if (!uid) throw new Error("subjectUid is not set");
  const log = jsonl("observer.jsonl");
  const files = jsonl("files.jsonl");
  const processes = jsonl("processes.jsonl");
  const mounts = jsonl("mounts.jsonl");
  const mdns = jsonl("mdns.jsonl");
  const canaryLogical = new Set(Object.values(cfg.canaryPaths));
  const captures = startCaptures();
  const probe = captureProbe("lo0");
  pflogProbeSender();

  // eslogger's JSON, read from a FIFO. `eslogger` runs in an ssh session of its own (start.sh es-start) because it mutes the events of its own audit
  // session while still counting them in its sequence numbers: started here, it would hide this observer's own file activity and make every
  // skipped number a false alarm. Its sequence numbers say whether the system dropped events before this client saw them, and a file the
  // self-test daemon rewrites every second must come back as an event: proof the stream is recording.
  const known = new Set<number>();
  const cliPids = new Set<number>();
  const cli = cliIdentity(cfg);
  const inodes = canaryInodes(canaryLogical);
  const esFifo = `${STATE}/es.fifo`;
  const esStream = createReadStream(esFifo);
  let esAlive = true;
  const seq = new EsSeqTracker();
  let selfSeen = Date.now();
  esStream.on("close", () => {
    esAlive = false;
    log.write({ type: "error", at: Date.now(), observer: "files", detail: "the eslogger stream ended" });
  });
  esStream.on("error", (err) => {
    esAlive = false;
    log.write({ type: "error", at: Date.now(), observer: "files", detail: boundText(String(err), 200) });
  });
  createInterface({ input: esStream }).on("line", (line) => {
    const skipped = seq.feed(line);
    if (skipped > 0) log.write({ type: "loss", at: Date.now(), observer: "files", reason: `eslogger sequence numbers skipped ${skipped} event(s): the system dropped them before the observer saw them` });
    if (esSelfTestEvent(line, ES_SELFTEST_FILE)) selfSeen = Date.now();
    // Most lines are other users' processes; a cheap test before parsing.
    if (!line.includes(`"euid":${uid}`)) return;
    const e = parseEsloggerLine(line, uid);
    if (!e) return;
    // Every start of a process of the subject's uid, with its parent and whether it ran the CLI binary; and a process first seen by what it did.
    const started = processRecord(e, cli);
    if (started && e.process?.euid === uid) {
      known.add(started.pid);
      if (started.cli) cliPids.add(started.pid);
      processes.write({ type: "process", at: e.at, ...started, exe: started.exe ? boundText(scrubCanaries(started.exe, canaries), 300) : undefined });
    } else if (e.euid === uid && !known.has(e.pid)) {
      known.add(e.pid);
      processes.write({ type: "process", at: e.at, pid: e.pid });
    }
    // A run of the CLI that ends is recorded as ended, for triage.
    if (e.exited && cliPids.has(e.pid)) {
      cliPids.delete(e.pid);
      processes.write({ type: "exit", at: e.at, pid: e.pid });
    }
    if (e.mount) mounts.write({ type: "mount", at: e.at, pid: e.pid, fstype: e.mount.fstype, on: boundText(scrubCanaries(e.mount.on, canaries), 300) });
    for (const f of fsEventsFrom([e], canaryLogical, WATCH, 1000, inodes)) {
      files.write({ type: "fs", at: f.at, path: boundText(scrubCanaries(f.path, canaries), 300), events: f.events, ...(f.via ? { via: boundText(scrubCanaries(f.via, canaries), 300) } : {}), ...(f.pid !== undefined ? { pid: f.pid } : {}), ...entryFacts(f.path) });
      if (f.path === CONFIG_FILE && f.events.some((x) => ["CREATE", "MOVED_TO", "CLOSE_WRITE", "MODIFY"].includes(x))) recordConfigState(files, canaries);
    }
  });

  // The VM's VirtioFS device (lume's live share) must stay unmounted: any mount of it is a host channel. eslogger does not report those mounts, so the table is polled.
  const seenMounts = new Set<string>();
  const mountPoll = setInterval(() => {
    execFile("/sbin/mount", { timeout: 2000 }, (err, out) => {
      if (err) return;
      for (const line of out.split("\n")) {
        const m = /^(\S+) on (.+) \(([^,)]+)/.exec(line);
        if (!m || !/virtio|virtiofs/i.test(m[3])) continue;
        const key = `${m[2]}|${m[3]}`;
        if (seenMounts.has(key)) continue;
        seenMounts.add(key);
        mounts.write({ type: "mount", at: Date.now(), fstype: m[3].slice(0, 32), on: boundText(scrubCanaries(m[2], canaries), 300), owner: /mounted by (\S+)\)/.exec(line)?.[1] ?? "system" });
      }
      for (const key of seenMounts) if (!out.includes(` on ${key.split("|")[0]} (`)) seenMounts.delete(key);
    });
  }, 1000);

  // mDNSResponder: request (client pid) -> question -> upstream DNS id. Names are private in this log.
  // By the executable's path, not its name: any program can call itself mDNSResponder, and its log lines would then be taken for the resolver's.
  const ls = spawn("log", ["stream", "--style", "ndjson", "--level", "default", "--predicate", `processImagePath == "${MDNS_IMAGE}"`], { stdio: ["ignore", "pipe", "ignore"] });
  createInterface({ input: ls.stdout! }).on("line", (line) => {
    const r = parseMdnsLine(line);
    if (r) mdns.write({ type: "mdns", ...r });
  });

  const ip6 = watchIp6NoRoute();
  const hb = heartbeat(log, {
    files: () => esAlive && Date.now() - selfSeen < 6000,
    procs: () => esAlive && Date.now() - selfSeen < 6000,
    packets: () => alive(captures.pflog) && alive(captures.lo0) && alive(captures.uplink) && ip6() && probe(),
    api: () => alive(captures.lo0) && probe(),
  });
  // Without mDNSResponder's log every resolver line stays the subject's (unattributed): conservative, so not a gap.
  ls.on("exit", () => log.write({ type: "error", at: Date.now(), observer: "dns-attribution", detail: "log stream exited" }));
  log.write({ type: "ready", at: Date.now() });
  onStop(() => {
    clearInterval(hb);
    clearInterval(mountPoll);
    esStream.destroy();
    ls.kill();
    for (const c of Object.values(captures)) c.kill("SIGINT");
  });
}

function mark(phase: string, kind: string, expected?: string) {
  const at = Date.now();
  jsonl("marks.jsonl").write({ type: "mark", at, phase, kind, ...(expected ? { expectedPaths: JSON.parse(expected) as string[] } : {}) });
  // The egress proxy reads the current phase from a file to apply its per-phase budget: on Linux it shares this folder, on macOS it has its own.
  const state = JSON.stringify({ phase, kind, at });
  writeAtomic(path.join(RAW, "phase.json"), state);
  const egress = loadConfig().egressDir;
  if (egress) writeAtomic(path.join(egress, "raw", "phase.json"), state);
  process.stdout.write(`${at}\n`);
}

function latestManifest(): Manifest | null {
  const dir = path.join(RAW, "snapshots");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json.gz")).sort();
  if (files.length === 0) return null;
  return (JSON.parse(gunzipSync(readFileSync(path.join(dir, files[files.length - 1]))).toString("utf8")) as { manifest: Manifest }).manifest;
}

function snapshot(label: string) {
  const cfg = loadConfig();
  const canaries = loadCanaries();
  const started = Date.now();
  const canaryLogical = new Set(Object.values(cfg.canaryPaths));
  const { manifest, errors } = buildManifest(
    Object.entries(WATCH).map(([logical, dir]) => ({ logical, dir })),
    { canaryLogical, previous: latestManifest(), canaryIdentities: new Set(canaryInodes(canaryLogical).keys()) },
  );
  // A subject could name a file after a canary's value; record keys keep only its id.
  const scrubbed: Manifest = {};
  for (const [key, entry] of Object.entries(manifest)) scrubbed[scrubCanaries(key, canaries)] = entry;
  const state = readState();
  const stateCtx = stateOf();
  const transcriptDir = stateCtx.projectKey === null ? null : `${stateCtx.sessionStore}/${stateCtx.projectKey}`;
  const semantic = semanticFacts(fromLogical, { run: state.runCarouselId, other: state.otherCarouselId }, canaries, { rootOf: (logical) => WATCH[logical.slice(0, logical.indexOf(":"))], transcriptDir, backupsDir: "home:.claude/backups", projectPath: stateCtx.projectPath });
  // macOS: what the system will run later on the subject's behalf, read as root (a user's crontab is a file only root reads; the subject's launchd domain is asked for by root).
  if (MAC && cfg.subjectUid) semantic.scheduled = scheduledFacts(cfg.subjectUid);
  // Second names the canaries have (a hard link, a copy or clone of their bytes), from the manifest alone: the canaries are never opened.
  semantic.aliases = canaryAliases(
    manifest,
    Object.entries(cfg.canaryPaths).map(([id, logical]) => {
      const content = canaries[id] === undefined ? null : canaryFileContent(id, canaries[id]);
      return { id, logical, contentSha256: content === null ? null : sha256(content) };
    }),
  ).map((a) => ({ ...a, path: scrubCanaries(a.path, canaries) }));
  const dir = path.join(RAW, "snapshots");
  execFileSync("mkdir", ["-p", dir]);
  const seq = String(readdirSync(dir).filter((f) => f.endsWith(".json.gz")).length).padStart(2, "0");
  const at = Date.now();
  writeFileSync(path.join(dir, `${seq}-${label}.json.gz`), gzipSync(JSON.stringify({ label, at, errors, manifest: scrubbed, semantic })));
  process.stdout.write(`${JSON.stringify({ label, entries: Object.keys(scrubbed).length, errors, ms: at - started })}\n`);
}

/** Every user's crontab (by user name, a content hash of the file) and the labels in the subject's launchd domain. */
function scheduledFacts(uid: number): ScheduledFacts {
  const cron: Record<string, string> = {};
  const seen = new Set<string>();
  for (const dir of ["/private/var/at/tabs", "/usr/lib/cron/tabs"]) {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    for (const name of readdirSync(real)) {
      try {
        cron[name] = sha256(readFileSync(path.join(real, name)));
      } catch {
        cron[name] = "unreadable";
      }
    }
  }
  let launchd: LaunchdFacts | null = null;
  const r = spawnSync("/bin/launchctl", ["print", `user/${uid}`], { encoding: "utf8", timeout: 20_000 });
  if (r.status === 0) launchd = launchdFacts(r.stdout);
  return { cron, launchd };
}

function stopCapture(name: string) {
  const pid = Number(readFileSync(`${STATE}/tcpdump-${name}.pid`, "utf8"));
  try {
    process.kill(pid, "SIGINT");
  } catch {
    // Already gone; the capture file is what it is.
  }
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    execFileSync("sleep", ["0.2"]);
  }
}

const readCapture = (name: string) => (existsSync(captureFile(name)) ? parsePcap(readFileSync(captureFile(name))) : []);

/** Waits until the serving observer has recorded each stopped capture's own statistics (it writes them when tcpdump exits). */
function waitForCaptureStats(names: string[]) {
  const until = Date.now() + 8000;
  const have = () => {
    const f = path.join(RAW, "observer.jsonl");
    const text = existsSync(f) ? readFileSync(f, "utf8") : "";
    return names.every((n) => text.includes(`"type":"capture_stats"`) && new RegExp(`"capture":"${n}"`).test(text));
  };
  while (Date.now() < until && !have()) execFileSync("sleep", ["0.3"]);
}

/** The addresses the egress proxy's own log shows it connected to: what an uplink flow to port 443 must be matched against. */
function proxyUpstreams(egressDir: string | undefined): string[] {
  const file = egressDir ? path.join(egressDir, "raw", "proxy.jsonl") : path.join(RAW, "proxy.jsonl");
  if (!existsSync(file)) return [];
  const out = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"proxy_connect"')) continue;
    try {
      const j = JSON.parse(line) as { type?: string; address?: string };
      if (j.type === "proxy_connect" && j.address) out.add(j.address);
    } catch {
      // A torn last line.
    }
  }
  return [...out];
}

/** Summarizes the captures; `peek` leaves them running (tcpdump -U writes each packet as it comes), otherwise stops them first. */
function finalize(peek: boolean) {
  const cfg = loadConfig();
  const canaries = loadCanaries();
  if (!peek) {
    for (const name of Object.keys(CAPTURES)) stopCapture(name);
    waitForCaptureStats(Object.keys(CAPTURES));
  }
  const harnessEndpoints: PacketContext["harnessEndpoints"] = [
    { address: cfg.addresses.web, port: 443, proto: "tcp" },
    { address: cfg.addresses.web, port: 80, proto: "tcp" },
    { address: cfg.addresses.dns, port: 53, proto: "udp" },
    { address: cfg.addresses.dns, port: 53, proto: "tcp" },
    { address: cfg.addresses.egress, port: cfg.proxyPort, proto: "tcp" },
  ];
  const probes = probeTuples();
  const context = (localAddresses: string[], resolverAddresses: string[], probe: ProbeTuple | undefined): PacketContext => ({
    appPort: cfg.appPort,
    extraAppPorts: cfg.extraAppPorts ?? [],
    localAddresses,
    resolverAddresses,
    harnessEndpoints,
    driverConns: readDriverConns(),
    knownWords: knownIds(),
    probe,
    canaries,
  });
  if (!MAC) {
    const packets = readCapture("any");
    const summary = summarizePackets(packets, context([cfg.addresses.subject], ["127.0.0.11"], probes.any));
    writeFileSync(path.join(RAW, "packets.json"), JSON.stringify({ packets: packets.length, ...summary }));
    process.stdout.write(`${JSON.stringify({ packets: packets.length, attempts: summary.attempts.length, appRequests: summary.appRequests.length, replies: summary.replies?.length ?? 0 })}\n`);
    return;
  }
  // macOS: the app's requests from loopback; attempts only from pf's log, which names the subject's uid; and what really left the machine from the uplink capture.
  const own = cfg.localAddresses ?? [];
  const lo0 = readCapture("lo0");
  const pflog = readCapture("pflog");
  const app = summarizePackets(lo0, context(own, [], probes.lo0));
  const attempts = pflogAttempts(pflog, { uid: cfg.subjectUid ?? -1, harnessEndpoints, localAddresses: own, probe: probes.pflog });
  const blocked = pflogBlocked(pflog, { uid: cfg.subjectUid ?? -1, probe: probes.pflog });
  // The subject's own packets to the resolver, for the DNS attribution of direct queries.
  const direct = pflog.filter((p) => p.pflog?.uid === cfg.subjectUid && p.dport === 53).map((p) => ({ at: p.at, sport: p.sport }));
  const en0Bytes = existsSync(captureFile("uplink")) ? readFileSync(captureFile("uplink")).length : 0;
  const uplinkPackets = readCapture("uplink");
  const up = uplinkFlows(uplinkPackets, own, { peer: cfg.peer });
  const violations = uplinkViolations(up.flows, { upstreamDns: cfg.upstreamDns ?? [], modelAddresses: proxyUpstreams(cfg.egressDir), gateway: cfg.addresses.gateway });
  writeFileSync(
    path.join(RAW, "packets.json"),
    JSON.stringify({
      packets: lo0.length + pflog.length,
      pflogPackets: pflog.length,
      uplinkCaptureBytes: en0Bytes,
      attempts,
      appRequests: app.appRequests,
      appFlows: app.appFlows,
      replies: [],
      directDns: direct,
      blocked,
      // Proof, with the time of each packet, that each capture was recording: the host's keepalive on the uplink, and the observer's own blocked probe in pf's log.
      recording: { uplink: cfg.peer ? sshLiveTimes(uplinkPackets, cfg.peer) : [], pflog: pflogProbeTimes(pflog, probes.pflog ?? null) },
      uplink: { flows: up.flows.slice(0, 500), violations: violations.slice(0, 200), sshReplyPackets: up.sshReplyPackets, captureBytes: en0Bytes },
    }),
  );
  process.stdout.write(`${JSON.stringify({ packets: lo0.length, pflog: pflog.length, attempts: attempts.length, blocked: blocked.length, appRequests: app.appRequests.length, uplinkFlows: up.flows.length, uplinkViolations: violations.length })}\n`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "serve") return MAC ? serveMacos(cfg0) : serveLinux(cfg0);
  if (cmd === "mark") return mark(args[0], args[1], args[2]);
  if (cmd === "snapshot") return snapshot(args[0]);
  if (cmd === "finalize") return finalize(args[0] === "--peek");
  if (cmd === "drive") {
    const cfg = loadConfig();
    if (args[0] === "setup") {
      process.stdout.write(`${JSON.stringify(await setup(cfg))}\n`);
      return;
    }
    if (args[0] === "chat") {
      const rec = await chat(cfg, loadCanaries(), args[1], args[2], args[3] ?? null);
      process.stdout.write(`${JSON.stringify({ phase: rec.phase, status: rec.status, errorCode: rec.errorCode, events: rec.events })}\n`);
      return;
    }
  }
  throw new Error(`unknown command: ${[cmd, ...args].join(" ")}`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
