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
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync, gzipSync } from "node:zlib";
import { ES_EVENTS, fsEventsFrom, MACOS_ROOTS, parseEsloggerLine, parseMdnsLine } from "../lib/macos";
import { parsePcap, pflogAttempts, summarizePackets, type PacketContext } from "../lib/pcap";
import { boundText, scrubCanaries } from "../lib/scrub";
import { buildManifest, semanticFacts, type Manifest } from "../lib/snapshot";
import { RAW, heartbeat, jsonl, loadCanaries, loadConfig, loadNonce, onStop, type HarnessConfig } from "./common";
import { chat, readState, setup } from "./driver";

const cfg0 = loadConfig();
const MAC = cfg0.platform === "macos";
const STATE = MAC ? "/var/t1/observer" : "/var/t1";
const CAPTURE = `${STATE}/capture.pcap`;
/** Captures by name: Linux has one; macOS keeps the app's loopback, pf's log and the uplink apart. */
const CAPTURES: Record<string, string[]> = MAC
  ? { lo0: ["-i", "lo0", "-s", "2048"], pflog: ["-i", "pflog0", "-s", "256"], en0: ["-i", "en0", "-s", "128"] }
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

function startCaptures(): Record<string, ChildProcess> {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const procs: Record<string, ChildProcess> = {};
  for (const [name, args] of Object.entries(CAPTURES)) {
    const p = spawn("tcpdump", [...args, "-nn", "-U", ...(MAC ? [] : ["-Z", "root"]), "-w", captureFile(name)], { stdio: "ignore" });
    writeFileSync(`${STATE}/tcpdump-${name}.pid`, String(p.pid));
    procs[name] = p;
  }
  return procs;
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
  const watchers: ChildProcess[] = [];
  const watch = (args: string[]) => {
    const w = spawn("inotifywait", ["-m", "-q", "--format", "%e|%w%f", "-e", "open,access,close_nowrite,modify,attrib,close_write,create,delete,delete_self,moved_from,moved_to,move_self", ...args], { stdio: ["ignore", "pipe", "ignore"] });
    createInterface({ input: w.stdout! }).on("line", (line) => {
      const at = Date.now();
      const bar = line.indexOf("|");
      if (bar < 0) return;
      const events = line.slice(0, bar).split(",").filter((e) => e !== "ISDIR");
      const logical = toLogical(line.slice(bar + 1));
      if (!logical) return;
      const isCanary = canaryLogical.has(logical);
      // Reads matter only on canaries; writes anywhere (persistence, the CLI's session file).
      const kept = isCanary ? events : events.filter((e) => !READS.has(e));
      if (kept.length === 0) return;
      files.write({ type: "fs", at, path: boundText(scrubCanaries(logical, canaries), 300), events: kept });
    });
    watchers.push(w);
  };
  watch(["-r", WATCH.home]);
  watch(["-r", path.join(WATCH.checkout, "data")]);
  watch([WATCH.checkout]);
  const ip6 = watchIp6NoRoute();
  const hb = heartbeat(log, { files: () => watchers.every(alive), packets: () => alive(tcpdump) && ip6(), api: () => alive(tcpdump) });
  log.write({ type: "ready", at: Date.now() });
  onStop(() => {
    clearInterval(hb);
    for (const w of watchers) w.kill();
    tcpdump.kill("SIGINT");
  });
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

  // eslogger: the subject's file access and every process it starts.
  const known = new Set<number>();
  const es = spawn("eslogger", ES_EVENTS, { stdio: ["ignore", "pipe", "pipe"] });
  let esError = "";
  es.stderr!.on("data", (d: Buffer) => (esError = (esError + d.toString()).slice(-400)));
  createInterface({ input: es.stdout! }).on("line", (line) => {
    // Most lines are other users' processes; a cheap test before parsing.
    if (!line.includes(`"euid":${uid}`)) return;
    const e = parseEsloggerLine(line, uid);
    if (!e) return;
    for (const p of [e.process, e.euid === uid ? { pid: e.pid, euid: e.euid } : undefined]) {
      if (p && p.euid === uid && !known.has(p.pid)) {
        known.add(p.pid);
        processes.write({ type: "process", at: e.at, pid: p.pid });
      }
    }
    if (e.mount) mounts.write({ type: "mount", at: e.at, pid: e.pid, fstype: e.mount.fstype, on: boundText(scrubCanaries(e.mount.on, canaries), 300) });
    for (const f of fsEventsFrom([e], canaryLogical, WATCH)) files.write({ type: "fs", at: f.at, path: boundText(scrubCanaries(f.path, canaries), 300), events: f.events });
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
  const ls = spawn("log", ["stream", "--style", "ndjson", "--level", "default", "--predicate", 'process == "mDNSResponder"'], { stdio: ["ignore", "pipe", "ignore"] });
  createInterface({ input: ls.stdout! }).on("line", (line) => {
    const r = parseMdnsLine(line);
    if (r) mdns.write({ type: "mdns", ...r });
  });

  const ip6 = watchIp6NoRoute();
  const hb = heartbeat(log, {
    files: () => alive(es),
    packets: () => alive(captures.pflog) && alive(captures.lo0) && ip6(),
    api: () => alive(captures.lo0),
  });
  // Without mDNSResponder's log every resolver line stays the subject's (unattributed): conservative, so not a gap.
  ls.on("exit", () => log.write({ type: "error", at: Date.now(), observer: "dns-attribution", detail: "log stream exited" }));
  log.write({ type: "ready", at: Date.now() });
  es.on("exit", (code) => log.write({ type: "error", at: Date.now(), observer: "files", code, detail: boundText(esError, 300) }));
  onStop(() => {
    clearInterval(hb);
    clearInterval(mountPoll);
    es.kill();
    ls.kill();
    for (const c of Object.values(captures)) c.kill("SIGINT");
  });
}

function mark(phase: string, kind: string, expected?: string) {
  const at = Date.now();
  jsonl("marks.jsonl").write({ type: "mark", at, phase, kind, ...(expected ? { expectedPaths: JSON.parse(expected) as string[] } : {}) });
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
    { canaryLogical, previous: latestManifest() },
  );
  // A subject could name a file after a canary's value; record keys keep only its id.
  const scrubbed: Manifest = {};
  for (const [key, entry] of Object.entries(manifest)) scrubbed[scrubCanaries(key, canaries)] = entry;
  const state = readState();
  const semantic = semanticFacts(fromLogical, { run: state.runCarouselId, other: state.otherCarouselId }, canaries);
  const dir = path.join(RAW, "snapshots");
  execFileSync("mkdir", ["-p", dir]);
  const seq = String(readdirSync(dir).filter((f) => f.endsWith(".json.gz")).length).padStart(2, "0");
  const at = Date.now();
  writeFileSync(path.join(dir, `${seq}-${label}.json.gz`), gzipSync(JSON.stringify({ label, at, errors, manifest: scrubbed, semantic })));
  process.stdout.write(`${JSON.stringify({ label, entries: Object.keys(scrubbed).length, errors, ms: at - started })}\n`);
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

/** Summarizes the captures; `peek` leaves them running (tcpdump -U writes each packet as it comes), otherwise stops them first. */
function finalize(peek: boolean) {
  const cfg = loadConfig();
  const canaries = loadCanaries();
  if (!peek) for (const name of Object.keys(CAPTURES)) stopCapture(name);
  const harnessEndpoints: PacketContext["harnessEndpoints"] = [
    { address: cfg.addresses.web, port: 443, proto: "tcp" },
    { address: cfg.addresses.web, port: 80, proto: "tcp" },
    { address: cfg.addresses.dns, port: 53, proto: "udp" },
    { address: cfg.addresses.dns, port: 53, proto: "tcp" },
    { address: cfg.addresses.egress, port: cfg.proxyPort, proto: "tcp" },
  ];
  const context = (localAddresses: string[], resolverAddresses: string[]): PacketContext => ({
    appPort: cfg.appPort,
    localAddresses,
    resolverAddresses,
    harnessEndpoints,
    nonce: loadNonce(),
    canaries,
  });
  if (!MAC) {
    const packets = readCapture("any");
    const summary = summarizePackets(packets, context([cfg.addresses.subject], ["127.0.0.11"]));
    writeFileSync(path.join(RAW, "packets.json"), JSON.stringify({ packets: packets.length, ...summary }));
    process.stdout.write(`${JSON.stringify({ packets: packets.length, attempts: summary.attempts.length, appRequests: summary.appRequests.length })}\n`);
    return;
  }
  // macOS: the app's requests from loopback; attempts only from pf's log, which names the subject's uid.
  const lo0 = readCapture("lo0");
  const pflog = readCapture("pflog");
  const app = summarizePackets(lo0, context([], []));
  const attempts = pflogAttempts(pflog, { uid: cfg.subjectUid ?? -1, harnessEndpoints });
  // The subject's own packets to the resolver, for the DNS attribution of direct queries.
  const direct = pflog.filter((p) => p.pflog?.uid === cfg.subjectUid && p.dport === 53).map((p) => ({ at: p.at, sport: p.sport }));
  const en0 = existsSync(captureFile("en0")) ? readFileSync(captureFile("en0")).length : 0;
  writeFileSync(path.join(RAW, "packets.json"), JSON.stringify({ packets: lo0.length + pflog.length, pflogPackets: pflog.length, uplinkCaptureBytes: en0, attempts, appRequests: app.appRequests, appFlows: app.appFlows, directDns: direct }));
  process.stdout.write(`${JSON.stringify({ packets: lo0.length, pflog: pflog.length, attempts: attempts.length, appRequests: app.appRequests.length })}\n`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "serve") return MAC ? serveMacos(cfg0) : serveLinux(cfg0);
  if (cmd === "mark") return mark(args[0], args[1], args[2]);
  if (cmd === "snapshot") return snapshot(args[0]);
  if (cmd === "finalize") return finalize(args[0] === "--peek");
  if (cmd === "drive") {
    const cfg = loadConfig();
    const nonce = loadNonce();
    if (args[0] === "setup") {
      process.stdout.write(`${JSON.stringify(await setup(cfg, nonce))}\n`);
      return;
    }
    if (args[0] === "chat") {
      const rec = await chat(cfg, nonce, loadCanaries(), args[1], args[2], args[3] ?? null);
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
