/**
 * What every T1 harness service shares: its configuration (from the
 * environment of a harness container on Linux, or a root-only file in the
 * macOS VM; never the subject's), the canary
 * values it matches against (never written anywhere), and append-only JSONL
 * records with heartbeats, so a silent service is told apart from a quiet one.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import type { AllowedTarget } from "../lib/policy";
import type { ModelConnectionBudget } from "../lib/spend";
import { setRecordKey, type CanaryValues } from "../lib/scrub";

export interface HarnessConfig {
  runId: string;
  /** The internal network's range, CIDR. */
  subnet: string;
  addresses: { subject: string; web: string; dns: string; egress: string; gateway: string };
  appPort: number;
  decoyPort: number;
  proxyPort: number;
  /** Names the logging resolver answers, to their fixed addresses. */
  harnessNames: Record<string, string>;
  modelHosts: string[];
  allowlist: AllowedTarget[];
  /** Logical canary paths by canary id. */
  canaryPaths: Record<string, string>;
  /** Seconds a model phase may run before the driver stops waiting. */
  phaseDeadlineSeconds: number;
  /** "linux" when absent. */
  platform?: "linux" | "macos";
  /** The canary sockets' and certificate authority's folder; /run/t1 when absent. */
  runDir?: string;
  /** Resolvers the egress proxy asks itself, when the system resolver is the harness's logging one (macOS). */
  upstreamDns?: string[];
  /** The subject user's uid (macOS: pf and eslogger attribution). */
  subjectUid?: number;
  /** Where the CLI keeps its project folders, as a logical path (`home:.claude/projects` when absent): the observer takes a digest of the transcripts in the project folder under it. */
  sessionStore?: string;
  /** App-side ports besides the main one whose HTTP requests are reconstructed (the agent-only listener). */
  extraAppPorts?: number[];
  /** The machine's own addresses on the uplink (macOS): a packet from one of them on the uplink capture left the machine. */
  localAddresses?: string[];
  /** A random key (hex) the host draws per run, which every hash of a string the subject chose is keyed with (`keyedHash`): in this configuration and in no record. */
  recordKey?: string;
  /** A random value the host draws per run, which the observers' recording probes carry as their payload and the control sends too: nothing branches on it (probes are recognized by their exact tuple). */
  probeMarker?: string;
  /** macOS: the interface the default route uses (`discover` reports it), which the uplink capture is taken on. */
  uplink?: string;
  /** macOS: the harness peer (the host's address on the VM's network): the SSH session the host keeps alive with it shows the uplink capture is recording. */
  peer?: string;
  /** macOS: the egress proxy's own folder (a service account's, outside the root-only state), where `mark` mirrors the current phase. */
  egressDir?: string;
  /** Model API connections the egress proxy allows per phase (the plan, which flags a settlement, and the ceiling, which refuses) and the bytes its tunnels may carry. Absent: no limit (unit tests only). */
  modelBudget?: ModelConnectionBudget;
  /** macOS: where the Claude CLI binary is installed in the VM; the observer reads its size and code signature there and recognizes a run of it (or of a copy) by them, whatever the process is called. */
  cliPath?: string;
  /** Linux: the CLI binary in the subject's image (its resolved path and size, read from the image by the host): the process watcher recognizes a run of it, or of any file of exactly its size. */
  cli?: { path: string; size: number };
}

export const runDir = (cfg: HarnessConfig) => cfg.runDir ?? "/run/t1";

/** The macOS VM's root-only file holding both the configuration and the canaries. */
function configFile(): { config: HarnessConfig; canaries: CanaryValues } | null {
  const file = process.env.T1_CONFIG_FILE;
  return file ? (JSON.parse(readFileSync(file, "utf8")) as { config: HarnessConfig; canaries: CanaryValues }) : null;
}

export const RECORDS = process.env.T1_RECORDS ?? "/records";
export const RAW = path.join(RECORDS, "raw");

export function loadConfig(): HarnessConfig {
  const fromFile = configFile();
  const raw = process.env.T1_CONFIG;
  if (!fromFile && !raw) throw new Error("T1_CONFIG is not set");
  const config = fromFile ? fromFile.config : (JSON.parse(raw as string) as HarnessConfig);
  // Every service that reads its configuration keys its record hashes with the run's key from then on.
  if (config.recordKey) setRecordKey(config.recordKey);
  return config;
}

export function loadCanaries(): CanaryValues {
  const fromFile = configFile();
  if (fromFile) return fromFile.canaries;
  const raw = process.env.T1_CANARIES;
  if (!raw) throw new Error("T1_CANARIES is not set");
  return JSON.parse(raw) as CanaryValues;
}

export function jsonl(name: string) {
  mkdirSync(RAW, { recursive: true });
  const file = path.join(RAW, name);
  return {
    file,
    write(value: Record<string, unknown>) {
      appendFileSync(file, `${JSON.stringify(value)}\n`);
    },
  };
}

/** Writes a heartbeat for each named observer every interval, with whether it is still up. */
export function heartbeat(log: ReturnType<typeof jsonl>, observers: Record<string, () => boolean>, intervalMs = 1000) {
  const beat = () => {
    const at = Date.now();
    for (const [observer, alive] of Object.entries(observers)) log.write({ type: "heartbeat", at, observer, alive: alive() });
  };
  beat();
  return setInterval(beat, intervalMs);
}

/** Writes a small state file through a temporary file and a rename, so a reader never sees half of it. */
export function writeAtomic(file: string, text: string, mode = 0o644) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** The window the observer last marked, which services outside its process (the egress proxy) read to know the phase. */
export function readPhase(raw = RAW): string {
  try {
    return String((JSON.parse(readFileSync(path.join(raw, "phase.json"), "utf8")) as { phase?: unknown }).phase ?? "unknown");
  } catch {
    return "unknown";
  }
}

export function onStop(fn: () => void) {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      try {
        fn();
      } finally {
        process.exit(0);
      }
    });
  }
}
