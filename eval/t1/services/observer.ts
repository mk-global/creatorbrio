/**
 * The observer container's entry point (#225). Runs as root with
 * `--network container:<subject>` (the subject's network namespace, its own
 * processes and files) and read-only mounts of the subject's real checkout,
 * home and temporary folders. It listens on nothing.
 *
 *   serve                 capture packets (all interfaces, loopback included),
 *                         watch file access, route the namespace's default
 *                         traffic into a blackhole so attempts are visible,
 *                         and write heartbeats until stopped
 *   mark <phase> <kind> [expected-paths-json]
 *                         stamp a window boundary on this clock
 *   snapshot <label>      manifest the watched folders and reduce the app's
 *                         data files to hashes
 *   drive setup | drive chat <phase> <message-file> [<resume-from-phase>]
 *   finalize              stop the capture and write its summary
 *
 * The packet capture stays inside this container; only its summary, with no
 * payload and canary values replaced, reaches the records.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync, gzipSync } from "node:zlib";
import { parsePcap, summarizePackets } from "../lib/pcap";
import { boundText, scrubCanaries } from "../lib/scrub";
import { buildManifest, semanticFacts, type Manifest } from "../lib/snapshot";
import { RAW, heartbeat, jsonl, loadCanaries, loadConfig, onStop } from "./common";
import { chat, readState, setup } from "./driver";

const STATE = "/var/t1";
const CAPTURE = `${STATE}/capture.pcap`;
/** Where the observer sees each logical root. */
const WATCH: Record<string, string> = { checkout: "/watch/app", home: "/watch/home", tmp: "/watch/tmp" };

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

function serve() {
  const cfg = loadConfig();
  const canaries = loadCanaries();
  const log = jsonl("observer.jsonl");
  const files = jsonl("files.jsonl");
  const canaryLogical = new Set(Object.values(cfg.canaryPaths));
  // Nothing in the internal network routes out; a default route into the
  // resolver's container (which has no other network) makes every attempt
  // to leave produce a packet this capture sees, instead of failing silently.
  execFileSync("ip", ["route", "replace", "default", "via", cfg.addresses.dns]);
  const tcpdump = spawn("tcpdump", ["-i", "any", "-nn", "-U", "-s", "2048", "-Z", "root", "-w", CAPTURE], { stdio: "ignore" });
  writeFileSync(`${STATE}/tcpdump.pid`, String(tcpdump.pid));
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
  const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
  const hb = heartbeat(log, { files: () => watchers.every(alive), packets: () => alive(tcpdump), api: () => alive(tcpdump) });
  log.write({ type: "ready", at: Date.now() });
  onStop(() => {
    clearInterval(hb);
    for (const w of watchers) w.kill();
    tcpdump.kill("SIGINT");
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

/** Summarizes the capture; `peek` leaves it running (tcpdump -U writes each packet as it comes), otherwise stops it first. */
function finalize(peek: boolean) {
  const cfg = loadConfig();
  const canaries = loadCanaries();
  const pid = Number(readFileSync(`${STATE}/tcpdump.pid`, "utf8"));
  if (!peek) {
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
  const packets = parsePcap(readFileSync(CAPTURE));
  const summary = summarizePackets(packets, {
    appPort: cfg.appPort,
    localAddresses: [cfg.addresses.subject],
    resolverAddresses: ["127.0.0.11"],
    harnessEndpoints: [
      { address: cfg.addresses.web, port: 443, proto: "tcp" },
      { address: cfg.addresses.web, port: 80, proto: "tcp" },
      { address: cfg.addresses.dns, port: 53, proto: "udp" },
      { address: cfg.addresses.dns, port: 53, proto: "tcp" },
      { address: cfg.addresses.egress, port: cfg.proxyPort, proto: "tcp" },
    ],
    nonce: process.env.T1_DRIVER_NONCE ?? "",
    canaries,
  });
  writeFileSync(path.join(RAW, "packets.json"), JSON.stringify({ packets: packets.length, ...summary }));
  process.stdout.write(`${JSON.stringify({ packets: packets.length, attempts: summary.attempts.length, appRequests: summary.appRequests.length })}\n`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "serve") return serve();
  if (cmd === "mark") return mark(args[0], args[1], args[2]);
  if (cmd === "snapshot") return snapshot(args[0]);
  if (cmd === "finalize") return finalize(args[0] === "--peek");
  if (cmd === "drive") {
    const cfg = loadConfig();
    const nonce = process.env.T1_DRIVER_NONCE ?? "";
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
