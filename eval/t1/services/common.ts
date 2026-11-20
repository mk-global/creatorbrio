/**
 * What every T1 harness service shares: its configuration (from the
 * environment of a harness container on Linux, or a root-only file in the
 * macOS VM; never the subject's), the canary
 * values it matches against (never written anywhere), and append-only JSONL
 * records with heartbeats, so a silent service is told apart from a quiet one.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AllowedTarget } from "../lib/policy";
import type { CanaryValues } from "../lib/scrub";

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
}

export const runDir = (cfg: HarnessConfig) => cfg.runDir ?? "/run/t1";

/** The macOS VM's root-only file holding both the configuration and the canaries. */
function configFile(): { config: HarnessConfig; canaries: CanaryValues; nonce?: string } | null {
  const file = process.env.T1_CONFIG_FILE;
  return file ? (JSON.parse(readFileSync(file, "utf8")) as { config: HarnessConfig; canaries: CanaryValues; nonce?: string }) : null;
}

/** The driver's per-run nonce: from the observer container's environment on Linux, the root-only file on macOS. */
export const loadNonce = (): string => configFile()?.nonce ?? process.env.T1_DRIVER_NONCE ?? "";

export const RECORDS = process.env.T1_RECORDS ?? "/records";
export const RAW = path.join(RECORDS, "raw");

export function loadConfig(): HarnessConfig {
  const fromFile = configFile();
  if (fromFile) return fromFile.config;
  const raw = process.env.T1_CONFIG;
  if (!raw) throw new Error("T1_CONFIG is not set");
  return JSON.parse(raw) as HarnessConfig;
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

export function onStop(fn: () => void) {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      try {
        fn();
      } finally {
        process.exit(0);
      }
    });
  }
}
