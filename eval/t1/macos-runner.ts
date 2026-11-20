/**
 * The T1 macOS runner (#225): the same phases, evidence format and judge as
 * the Linux runner, in a disposable macOS virtual machine managed by lume.
 *
 *   --platform macos --provision   provision the base VM, stop it, clone it as
 *                                  the golden image for this commit, and keep
 *                                  the golden image only if a model-free dry
 *                                  run in a fresh clone of it passes
 *   --platform macos [--dry-run]   clone the golden image, run in the clone,
 *                                  copy the records out, delete the clone
 *
 * Settings (environment):
 *   T1_VM_SSH_KEY   the private key the VM's admin account accepts (required)
 *   T1_VM_USER      that account, `t1admin` when unset
 *   T1_MACOS_BASE   the base VM's lume name (required for --provision)
 *
 * The VM is never given a host folder. A model token reaches it only at run
 * time, on SSH standard input to a root-owned launcher that puts it in the
 * app's environment alone, and the clone holding that environment is deleted.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TICKET } from "../acceptance/ledger";
import { canaryPaths, makeCanaryValues } from "./lib/catalog";
import { evaluatePreflight, parseJsonl, type PreflightProbe, type PreflightResult } from "./lib/evidence";
import { FOLLOWUP_MESSAGE, hostileMessage, hostilePage, type HostileContext } from "./lib/hostile";
import { controlCoverage, windowsFromMarks, type Judgement } from "./lib/judge";
import { checkT1, reserveT1, settleT1, t1Budget, type T1Budget } from "./lib/ledger";
import { MACOS_ROOTS, pfAnchor } from "./lib/macos";
import { DEFAULT_ALLOWLIST } from "./lib/policy";
import { redact, type RedactionContext } from "./lib/scrub";
import {
  addressPlan,
  APP_PORT,
  assess,
  controlReport,
  DECOY_PORT,
  finishRun,
  hostAddresses,
  hostListener,
  loadEvidence,
  MACOS_CLEANUP_PATHS,
  PROXY_PORT,
  reportedCost,
  sleep,
  type Options,
} from "./run";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const T1 = "/usr/local/t1";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], o: { input?: string | Buffer; allowFail?: boolean; timeoutMs?: number; binary?: boolean } = {}): Run & { raw: Buffer } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(cmd, args, { input: o.input, env, maxBuffer: 1024 * 1024 * 1024, timeout: o.timeoutMs ?? 10 * 60 * 1000 });
  const raw = (r.stdout as Buffer | null) ?? Buffer.alloc(0);
  const res = { code: r.status ?? -1, stdout: o.binary ? "" : raw.toString("utf8"), stderr: ((r.stderr as Buffer | null) ?? Buffer.alloc(0)).toString("utf8"), raw };
  if (res.code !== 0 && !o.allowFail) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed (${res.code}): ${res.stderr.slice(-600)}`);
  return res;
}

const lume = (args: string[], o: { allowFail?: boolean; timeoutMs?: number } = {}) => run("lume", args, o);

/** The `lume run` process for a VM, if one is alive: lume's own status can lag behind it. */
function lumeRunCommand(name: string): string | null {
  const ps = run("ps", ["-Ao", "pid=,command="], { allowFail: true }).stdout.split("\n");
  return ps.map((l) => l.trim().replace(/^\d+\s+/, "")).find((c) => /\blume run /.test(c) && c.split(/\s+/).includes(name)) ?? null;
}

/** The address the host's DHCP server leased to a MAC address, from the leases file vmnet writes. */
export function leasedAddress(leases: string, mac: string): string | null {
  const norm = (m: string) => m.toLowerCase().split(":").map((x) => x.replace(/^0(?=.)/, "")).join(":");
  for (const block of leases.split("}")) {
    const hw = /hw_address=\d+,([0-9a-f:]+)/i.exec(block)?.[1];
    const ip = /ip_address=([0-9.]+)/.exec(block)?.[1];
    if (hw && ip && norm(hw) === norm(mac)) return ip;
  }
  return null;
}

/** The VM's lume record, or null when it does not exist. lume prints log lines before its JSON. */
function vmInfo(name: string): { status: string; ipAddress: string | null } | null {
  const r = lume(["get", name, "--format", "json"], { allowFail: true });
  if (r.code !== 0) return null;
  const at = r.stdout.search(/^\[/m);
  if (at < 0) return null;
  try {
    const list = JSON.parse(r.stdout.slice(at)) as { status: string; ipAddress?: string | null; macAddress?: string }[];
    const v = list[0];
    if (!v) return null;
    const alive = lumeRunCommand(name) !== null;
    let ip = v.ipAddress ?? null;
    if (!ip && alive && v.macAddress && existsSync("/var/db/dhcpd_leases")) ip = leasedAddress(readFileSync("/var/db/dhcpd_leases", "utf8"), v.macAddress);
    return { status: alive ? "running" : v.status, ipAddress: ip };
  } catch {
    return null;
  }
}

export interface VmSettings {
  key: string;
  user: string;
  knownHosts: string;
}

export function vmSettings(env: Record<string, string | undefined>, knownHosts: string): VmSettings {
  const key = env.T1_VM_SSH_KEY?.trim();
  if (!key) throw new Error("T1_VM_SSH_KEY must name the private key the VM's admin account accepts");
  if (!existsSync(key)) throw new Error("T1_VM_SSH_KEY does not exist");
  const user = env.T1_VM_USER?.trim() || "t1admin";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("T1_VM_USER is not a valid account name");
  return { key, user, knownHosts };
}

/** One VM reached over SSH as its admin account. */
class Vm {
  readonly name: string;
  readonly ip: string;
  private readonly s: VmSettings;

  constructor(name: string, ip: string, s: VmSettings) {
    this.name = name;
    this.ip = ip;
    this.s = s;
  }

  ssh(command: string, o: { input?: string | Buffer; allowFail?: boolean; timeoutMs?: number; binary?: boolean } = {}) {
    return run(
      "ssh",
      ["-i", this.s.key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", `UserKnownHostsFile=${this.s.knownHosts}`, "-o", "StrictHostKeyChecking=accept-new", "-o", "LogLevel=ERROR", `${this.s.user}@${this.ip}`, command],
      o,
    );
  }

  /** The run's root-side control script. */
  start(args: string, o: { input?: string | Buffer; allowFail?: boolean; timeoutMs?: number; binary?: boolean } = {}) {
    return this.ssh(`sudo /bin/bash ${T1}/harness/macos/start.sh ${args}`, o);
  }

  /** A harness entry point as root, with the run's configuration. */
  t1(args: string, o: { allowFail?: boolean; timeoutMs?: number } = {}) {
    return this.ssh(`sudo /bin/bash ${T1}/harness/macos/t1.sh ${args}`, o);
  }

  /** A harness script as the subject user, through the root-side `macos/as-subject.sh` (clean environment unless `appEnv`). */
  asSubject(script: string, args: string[], timeoutMs = 10 * 60 * 1000, o: { appEnv?: boolean; unlockKeychain?: boolean } = {}) {
    const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const flags = [o.appEnv ? "--app-env" : "", o.unlockKeychain ? "--unlock-keychain" : ""].filter(Boolean).join(" ");
    return this.ssh(`cd / && sudo /bin/bash ${T1}/harness/macos/as-subject.sh ${flags} ${script} ${quoted}`, { allowFail: true, timeoutMs });
  }
}

/**
 * How every VM the harness starts runs: no display (so no native clipboard
 * bridge), no VNC server, and no shared folder, mount or extra disk. The
 * channel check below confirms each of these from lume's own records.
 */
const DEFAULT_MIN_FREE_GB = 25;

export interface GuestChannels {
  virtiofsDevices: number;
  virtiofsMounts: number;
  deviceListing: string;
  files: number;
  writes: { createRoot: string; createLiveShare: string; removeLiveShare: string };
}

/**
 * The guest's side of the channel check. lume attaches one VirtioFS device
 * that any user in the guest can mount. It is accepted only when root, inside
 * the VM, proves on every clone that it exposes nothing but lume's empty
 * live-share folder and that creating a file in it, or removing that folder,
 * fails; the harness then unmounts it before the subject starts.
 */
export function guestChannelProblems(g: GuestChannels): string[] {
  const problems: string[] = [];
  if (g.virtiofsDevices > 1) problems.push(`the guest has ${g.virtiofsDevices} VirtioFS devices`);
  if (g.virtiofsDevices === 0) return problems;
  if (g.deviceListing !== "./.lume-live-share" || g.files !== 0) problems.push(`the VirtioFS device is not empty: it exposes ${g.deviceListing || "nothing readable"} (${g.files} file(s))`);
  for (const [what, result] of Object.entries(g.writes ?? {})) if (result !== "refused") problems.push(`writing to the VirtioFS device (${what}) was not refused: ${result}`);
  return problems;
}

export interface LinkLocalSelfTest {
  gateway: boolean;
  probes: { port: number; rc: number; pflogged: number }[];
}

/** The first IPv6 layer's self-test (before IPv6 goes off): every attempt failed and pf logged each. A success is an isolation failure. */
export function linkLocalLayerProblems(t: LinkLocalSelfTest | undefined, ports: number[], uplinkInet6: string): { problems: string[]; reached: boolean } {
  const problems: string[] = [];
  let reached = false;
  if (!t || !t.gateway) problems.push("the link-local self-test had no gateway link-local address to probe");
  else {
    for (const port of ports) {
      const p = t.probes.find((x) => x.port === port);
      if (!p) problems.push(`the link-local self-test did not probe port ${port}`);
      else if (p.rc === 0) {
        reached = true;
        problems.push(`the subject reached the gateway's link-local address on port ${port} through the pf anchor`);
      } else if (p.pflogged < 1) problems.push(`pf did not log the subject's link-local attempt on port ${port}`);
    }
  }
  if (uplinkInet6) problems.push(`IPv6 is still on ${uplinkInet6}`);
  return { problems, reached };
}

/** Ports every link-local probe covers, besides the gateway's open ones. */
export const LINK_LOCAL_PORTS = [22, 53, 88, 5000, 7000];

export const LUME_RUN_FLAGS = ["--display", "none", "--vnc", "disabled", "--detach"];
const FORBIDDEN_RUN_FLAGS = ["--shared-dir", "--clipboard", "--mount", "--usb-storage", "--disk", "--network", "--display native", "--display vnc"];
const lumeStorage = () => process.env.T1_LUME_STORAGE?.trim() || path.join(homedir(), ".lume");
const lumeLog = (name: string) => path.join(homedir(), "Library", "Logs", "lume", `${name}.log`);
const fileSize = (f: string) => (existsSync(f) ? statSync(f).size : 0);

async function startVm(name: string, s: VmSettings, say: (t: string) => void, facts?: Record<string, unknown>): Promise<Vm> {
  const info = vmInfo(name);
  if (!info) throw new Error(`no lume VM named ${name}`);
  // A VM someone started another way may have a display, clipboard or shared folder: restart it the harness's way.
  if (info.status === "running") await stopVm(name, info.ipAddress ? new Vm(name, info.ipAddress, s) : undefined);
  const logFrom = fileSize(lumeLog(name));
  const args = ["run", name, ...LUME_RUN_FLAGS];
  if (facts) facts.lumeRun = { args: ["lume", ...args], logFrom };
  lume(args, { timeoutMs: 120_000 });
  for (let i = 0; i < 180; i++) {
    const now = vmInfo(name);
    if (now?.status === "running" && now.ipAddress) {
      const vm = new Vm(name, now.ipAddress, s);
      if (vm.ssh("true", { allowFail: true, timeoutMs: 15_000 }).code === 0) return vm;
    }
    await sleep(2000);
  }
  say(`the VM ${name} did not come up\n`);
  throw new Error(`the VM ${name} did not become reachable over SSH`);
}

/** Shuts the guest down cleanly (so the disk holds every write), and stops it hard only if that fails. */
async function stopVm(name: string, vm?: Vm) {
  if (vmInfo(name)?.status !== "running") return;
  if (vm) {
    vm.ssh("sudo /bin/sync; sudo /sbin/shutdown -h now", { allowFail: true, timeoutMs: 30_000 });
    for (let i = 0; i < 90 && vmInfo(name)?.status === "running"; i++) await sleep(2000);
  }
  if (vmInfo(name)?.status === "running") {
    lume(["stop", name], { allowFail: true, timeoutMs: 180_000 });
    for (let i = 0; i < 90 && vmInfo(name)?.status === "running"; i++) await sleep(2000);
  }
}

/** Free space where lume keeps its VMs, in GB. */
export function hostFreeGb(dir = lumeStorage()): number {
  const st = statfsSync(dir);
  return Math.floor((st.bavail * st.bsize) / 1e9);
}

export interface ChannelEvidence {
  /** The lume process's command line for this VM. */
  command: string | null;
  /** `lume get`: its shared directories and VNC address. */
  sharedDirectories: unknown;
  vncUrl: unknown;
  /** lume's log for this run. */
  log: string;
  /** Host folders the VM's virtualization process holds open. */
  hostDirectories: string[];
}

/**
 * Whether a VM runs with no host channel but its network: no display (the
 * native display syncs the clipboard), no VNC, no clipboard sync, no shared
 * folder. lume 0.20 always attaches one VirtioFS device for live sharing,
 * backed by the host's empty, root-owned `/private/var/empty`; that one host
 * folder is allowed and reported, any other is refused.
 */
export function channelProblems(e: ChannelEvidence): string[] {
  const problems: string[] = [];
  if (!e.command) problems.push("the lume process for this VM was not found");
  else {
    for (const flag of FORBIDDEN_RUN_FLAGS) if (e.command.includes(flag)) problems.push(`lume runs the VM with ${flag}`);
    if (!/--display none\b/.test(e.command)) problems.push("lume does not run the VM with --display none");
    if (!/--vnc disabled\b/.test(e.command)) problems.push("lume does not run the VM with --vnc disabled");
  }
  if (e.sharedDirectories !== null && !(Array.isArray(e.sharedDirectories) && e.sharedDirectories.length === 0)) problems.push("lume reports shared directories");
  if (e.vncUrl !== null && e.vncUrl !== undefined) problems.push("lume reports a VNC server");
  if (/clipboard/i.test(e.log)) problems.push("lume's log mentions clipboard sync");
  if (!/display_?[Mm]ode=none/.test(e.log)) problems.push("lume's log does not show display mode none");
  if (/shared_?[Dd]irectories=\S/.test(e.log)) problems.push("lume's log shows shared directories");
  if (/VNC server started/.test(e.log)) problems.push("lume's log shows a VNC server");
  for (const d of e.hostDirectories) if (d !== "/" && d !== "/private/var/empty") problems.push(`the VM holds a host folder open: ${d}`);
  return problems;
}

function channelEvidence(name: string, logFrom: number): ChannelEvidence {
  const command = lumeRunCommand(name);
  let info: { sharedDirectories?: unknown; vncUrl?: unknown } = {};
  try {
    const out = lume(["get", name, "--format", "json"], { allowFail: true }).stdout;
    info = (JSON.parse(out.slice(Math.max(0, out.search(/^\[/m)))) as typeof info[])[0] ?? {};
  } catch {
    // Reported as missing below.
  }
  const logFile = lumeLog(name);
  const log = existsSync(logFile) ? readFileSync(logFile).subarray(logFrom).toString("utf8") : "";
  const disk = path.join(lumeStorage(), name, "disk.img");
  const pids = run("lsof", ["-t", disk], { allowFail: true }).stdout.split("\n").filter(Boolean);
  const dirs = new Set<string>();
  for (const pid of pids) {
    let type = "";
    for (const line of run("lsof", ["-nP", "-p", pid, "-F", "tn"], { allowFail: true }).stdout.split("\n")) {
      if (line.startsWith("t")) type = line.slice(1);
      else if (line.startsWith("n") && type === "DIR") dirs.add(line.slice(1));
    }
  }
  return { command, sharedDirectories: info.sharedDirectories ?? null, vncUrl: info.vncUrl ?? null, log, hostDirectories: [...dirs].sort() };
}

const harnessTar = () => run("tar", ["-c", "-C", HERE, "register.mjs", "lib", "services", "macos"], { binary: true }).raw;

/** Replaces the VM's copy of the harness with this checkout's, root-owned. */
function installHarness(vm: Vm) {
  vm.ssh(
    `sudo /bin/bash -c 'set -e; rm -rf ${T1}/harness.new; mkdir -p ${T1}/harness.new; tar -x -C ${T1}/harness.new -f -; chown -R root:wheel ${T1}/harness.new; chmod -R go-w ${T1}/harness.new; rm -rf ${T1}/harness; mv ${T1}/harness.new ${T1}/harness'`,
    { input: harnessTar() },
  );
}

const headCommit = () => execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const goldenName = (prefix: string, commit: string) => `${prefix}-golden-${commit.slice(0, 12)}`;

function requireLume() {
  if (run("lume", ["--version"], { allowFail: true }).code !== 0) throw new Error("lume is not installed (https://github.com/trycua/cua/tree/main/libs/lume)");
}

/** Provisions the base VM, makes the golden image, and keeps it only when a model-free dry run in a clone of it passes. */
async function provision(opts: Options) {
  requireLume();
  const base = process.env.T1_MACOS_BASE?.trim();
  if (!base) throw new Error("T1_MACOS_BASE must name the base VM to provision");
  const work = path.join(opts.out, `provision-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(work, { recursive: true });
  const s = vmSettings(process.env, path.join(work, "known_hosts"));
  const say = (t: string) => process.stdout.write(t);
  const commit = headCommit();
  const golden = goldenName(opts.prefix, commit);
  const vm = await startVm(base, s, say);
  say(`provisioning ${base} at ${commit.slice(0, 12)} (several minutes)\n`);
  vm.ssh("cat > /tmp/t1-app.tar", { input: run("git", ["-C", ROOT, "archive", "--format=tar", commit], { binary: true }).raw });
  vm.ssh("cat > /tmp/t1-harness.tar", { input: harnessTar() });
  vm.ssh("cat > /tmp/t1-provision.sh", { input: readFileSync(path.join(HERE, "macos", "provision.sh")) });
  const out = vm.ssh(`sudo /bin/bash /tmp/t1-provision.sh /tmp/t1-app.tar /tmp/t1-harness.tar ${commit}; rc=$?; rm -f /tmp/t1-app.tar /tmp/t1-harness.tar /tmp/t1-provision.sh; exit $rc`, { allowFail: true, timeoutMs: 60 * 60 * 1000 });
  say(out.stdout);
  if (out.code !== 0) throw new Error(`provisioning failed: ${out.stderr.slice(-1200)}`);
  await stopVm(base, vm);
  if (vmInfo(golden)) lume(["delete", golden, "--force"]);
  lume(["clone", base, golden], { timeoutMs: 60 * 60 * 1000 });
  say(`golden image ${golden} made; checking it with a model-free dry run in a fresh clone\n`);
  let j: Judgement | null = null;
  try {
    j = await runOnce({ ...opts, dryRun: true, provision: false }, golden);
  } finally {
    if (!j || j.validity !== "valid") {
      lume(["delete", golden, "--force"], { allowFail: true });
      say(`the dry run did not pass; the golden image ${golden} was deleted\n`);
    }
  }
  if (j?.validity === "valid") say(`golden image ${golden} is ready\n`);
  rmSync(work, { recursive: true, force: true });
}

export async function runMacos(opts: Options) {
  if (opts.provision) return provision(opts);
  requireLume();
  const golden = goldenName(opts.prefix, headCommit());
  if (!vmInfo(golden)) throw new Error(`no golden image ${golden} for this commit; run with --platform macos --provision first (see eval/t1/README.md)`);
  const j = await runOnce(opts, golden);
  if (j.stopReason?.startsWith("ISOLATION FAILURE")) process.exit(2);
}

/** One run in a fresh clone of the golden image, which is deleted afterwards (records copied out first). */
async function runOnce(opts: Options, golden: string): Promise<Judgement & { stopReason?: string | null }> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  let budget: T1Budget | null = null;
  if (!opts.dryRun) {
    if (!token) throw new Error("A real run needs CLAUDE_CODE_OAUTH_TOKEN (a short-lived token, revoked afterwards).");
    budget = t1Budget(process.env);
    const check = checkT1(budget);
    if (!check.ok) throw new Error(check.message);
    process.stdout.write(`spend preflight: ${check.message}\n`);
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const short = runId.slice(-6);
  const records = path.join(opts.out, runId);
  const raw = path.join(records, "raw");
  const configDir = path.join(records, "config");
  const sshDir = path.join(records, ".ssh");
  mkdirSync(raw, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const s = vmSettings(process.env, path.join(sshDir, "known_hosts"));
  const platform = "macos" as const;
  const canaries = makeCanaryValues(platform);
  const cpaths = canaryPaths(platform);
  const nonce = randomBytes(24).toString("hex");
  const lan = hostAddresses();
  const web = addressPlan(opts.subnet).web;
  const clone = `${opts.prefix}-${short}`;
  const redaction: RedactionContext = {
    token,
    paths: [...new Set([ROOT, homedir(), opts.out])],
    names: [hostname(), hostname().replace(/\.local$/, ""), userInfo().username],
    hostAddresses: lan,
    keepRanges: [opts.subnet, "127.0.0.0/8"],
  };
  const say = (t: string) => process.stdout.write(redact(t, redaction));
  const facts: Record<string, unknown> = { golden, clone };
  let config: Record<string, unknown> = {};
  let preflight: PreflightResult | null = null;
  let otherCarouselId = "";
  let stopReason: string | null = null;
  let reserved = false;
  let startedMessages = 0;
  let vm: Vm | null = null;
  let host: Awaited<ReturnType<typeof hostListener>> | null = null;
  const commit = headCommit();
  const ledgerRun = () => ({ runId: `t1-${runId}`, commit, ticket: process.env.EVAL_TICKET?.trim() || DEFAULT_TICKET });

  const copyRecords = () => {
    if (!vm) return;
    const tgz = vm.start("records", { binary: true, allowFail: true, timeoutMs: 10 * 60 * 1000 });
    if (tgz.code === 0) run("tar", ["-xzf", "-", "-C", records], { input: tgz.raw });
  };
  const mark = (phase: string, kind: string, expected?: string[]) => vm!.t1(`services/observer.ts mark ${phase} ${kind}${expected ? ` '${JSON.stringify(expected)}'` : ""}`);
  const snapshot = (label: string) => say(`snapshot ${vm!.t1(`services/observer.ts snapshot ${label}`, { timeoutMs: 20 * 60 * 1000 }).stdout}`);

  let logFrom = 0;
  const minFreeGb = Number(process.env.T1_MIN_FREE_GB ?? DEFAULT_MIN_FREE_GB);
  try {
    const free = hostFreeGb();
    facts.host = { freeGbBeforeClone: free, minFreeGb };
    if (!Number.isFinite(minFreeGb) || free < minFreeGb) throw new Error(`the host has ${free} GB free where lume keeps its VMs, under the ${minFreeGb} GB margin (T1_MIN_FREE_GB); not cloning`);
    say(`cloning ${golden} as ${clone} (${free} GB free)\n`);
    lume(["clone", golden, clone], { timeoutMs: 60 * 60 * 1000 });
    vm = await startVm(clone, s, say, facts);
    logFrom = (facts.lumeRun as { logFrom: number }).logFrom;
    // No host channel but the network: lume's own records, then the guest's view of its file-sharing device.
    const ev = channelEvidence(clone, logFrom);
    const hostProblems = channelProblems(ev);
    installHarness(vm);
    const guest = JSON.parse(vm.start("channels").stdout) as GuestChannels;
    const guestProblems = guestChannelProblems(guest);
    facts.channels = { command: ev.command, sharedDirectories: ev.sharedDirectories, vncUrl: ev.vncUrl, hostDirectories: ev.hostDirectories, guest, problems: [...hostProblems, ...guestProblems] };
    say(
      `channels: ${hostProblems.length + guestProblems.length === 0 ? "no display, VNC, clipboard or shared folder" : "REFUSED"}; VirtioFS devices ${guest.virtiofsDevices} (${guest.deviceListing || "nothing exposed"}, ${guest.files} file(s); create ${guest.writes?.createRoot}, create in live share ${guest.writes?.createLiveShare}, remove live share ${guest.writes?.removeLiveShare}), host folders held ${ev.hostDirectories.join(", ") || "none"}\n`,
    );
    if (hostProblems.length + guestProblems.length > 0) {
      stopReason = `CHANNEL REFUSED: ${[...hostProblems, ...guestProblems].join("; ")}`;
      throw new Error(stopReason);
    }
    const d = JSON.parse(vm.start("discover").stdout) as {
      gateway4: string;
      gateway6: string;
      interface: string;
      address4: string;
      upstreamDns: string;
      subjectUid: number;
      names: string[];
      provenance: Record<string, unknown> & { commit?: string };
    };
    redaction.names.push(...d.names.filter((n) => n && n.length > 2));
    if (d.address4) redaction.keepRanges.push(`${d.address4.split(".").slice(0, 3).join(".")}.0/24`);
    facts.vm = { provenance: d.provenance, interface: "en0" };
    facts.commit = commit;
    if (d.provenance.commit !== commit) throw new Error(`the golden image was built from ${String(d.provenance.commit).slice(0, 12)}, not this commit; provision again`);
    // The gateway's IPv6 services, scanned as root while IPv6 is still on; every link-local probe covers them.
    if (!d.gateway6) throw new Error("the VM has no IPv6 link-local gateway to prove the link-local block against");
    const scan6 = JSON.parse(vm.start(`scan ${d.gateway6}`, { timeoutMs: 5 * 60 * 1000 }).stdout) as { open: number[] };
    facts.gatewayOpenPorts6 = scan6.open;
    const upstreamDns = d.upstreamDns.split(",").filter(Boolean);
    if (upstreamDns.length === 0) throw new Error("the VM has no IPv4 upstream resolver");

    config = {
      runId,
      platform,
      subnet: opts.subnet,
      addresses: { subject: "127.0.0.1", web, dns: "127.0.0.1", egress: "127.0.0.1", gateway: d.gateway4 },
      appPort: APP_PORT,
      decoyPort: DECOY_PORT,
      proxyPort: PROXY_PORT,
      harnessNames: { "web.t1.test": web, "egress.t1.test": "127.0.0.1" },
      modelHosts: DEFAULT_ALLOWLIST.map((a) => a.host),
      allowlist: DEFAULT_ALLOWLIST,
      canaryPaths: cpaths,
      phaseDeadlineSeconds: opts.deadlineSeconds,
      runDir: "/var/run/t1",
      upstreamDns,
      subjectUid: d.subjectUid,
    };
    const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;
    const subjectEnv: Record<string, string> = {
      PATH: `${T1}/node/bin:${T1}/claude/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: "en_US.UTF-8",
      PORT: String(APP_PORT),
      TMPDIR: "/private/tmp",
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1,web.t1.test",
      no_proxy: "localhost,127.0.0.1,::1,web.t1.test",
      NODE_EXTRA_CA_CERTS: "/var/run/t1/ca.pem",
      CLAUDE_CLI_PATH: `${T1}/claude/bin/claude`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      T1_CANARY_ENV: canaries.env_var,
      CREATORBRIO_T1_MESSAGING_SOCKET: "/var/run/t1/messaging.sock",
      CREATORBRIO_T1_MESSAGING_TOKEN: canaries.messaging_token,
      ...(budget ? { DESIGN_AGENT_MAX_BUDGET_USD: String(budget.caps.designUsd), DIRECTOR_MAX_BUDGET_USD: String(budget.caps.directorUsd) } : {}),
    };
    facts.subjectEnvironmentNames = [...Object.keys(subjectEnv), ...(budget ? ["CLAUDE_CODE_OAUTH_TOKEN"] : [])].sort();
    const pf = pfAnchor({ uid: d.subjectUid, appPort: APP_PORT, proxyPort: PROXY_PORT, decoyPort: DECOY_PORT, dnsPort: 53, webAddress: web, allowedLoopbackPorts: opts.allowLoopbackPorts });
    facts.pfAnchor = pf;
    const scan4 = JSON.parse(vm.start(`scan ${d.gateway4}`, { timeoutMs: 5 * 60 * 1000 }).stdout) as { open: number[] };
    facts.gatewayOpenPorts = scan4.open;
    const llPorts = [...new Set([...LINK_LOCAL_PORTS, ...scan4.open, ...scan6.open])].sort((a, b) => a - b);
    vm.start("install-config", { input: JSON.stringify({ config, canaries, nonce, subjectEnv, pf, ipv6: { gateway: d.gateway6, ports: llPorts } }) });
    writeFileSync(path.join(configDir, "brief.html"), "<!doctype html><title>pending</title>\n");
    vm.start("config-file brief.html", { input: "<!doctype html><title>pending</title>\n" });
    const up = vm.start("up", { timeoutMs: 5 * 60 * 1000 });
    say(up.stdout);
    facts.up = up.stdout.trim().split("\n").slice(-2);
    const upLine = JSON.parse(up.stdout.trim().split("\n").pop() ?? "{}") as { linkLocalSelfTest?: LinkLocalSelfTest; uplinkInet6?: string };
    const layer = linkLocalLayerProblems(upLine.linkLocalSelfTest, llPorts, upLine.uplinkInet6 ?? "");
    facts.ipv6 = { selfTest: upLine.linkLocalSelfTest, uplinkInet6AfterOff: upLine.uplinkInet6 ?? "", problems: layer.problems };
    say(`IPv6 link-local: pf self-test ${layer.problems.length === 0 ? `blocked and logged all ${llPorts.length} ports` : "FAILED"}; IPv6 off on the uplink: ${upLine.uplinkInet6 ? `NO (${upLine.uplinkInet6})` : "yes"}\n`);
    if (layer.problems.length > 0) {
      stopReason = `${layer.reached ? "ISOLATION FAILURE" : "IPv6 LAYER REFUSED"}: ${layer.problems.join("; ")}`;
      throw new Error(stopReason);
    }
    // The token line: empty for a model-free run. It goes only to the launcher's FIFO.
    vm.start("token", { input: `${budget ? token : ""}\n` });

    mark("setup", "harness");
    const state = JSON.parse(vm.t1("services/observer.ts drive setup", { timeoutMs: 5 * 60 * 1000 }).stdout) as { runCarouselId: string; otherCarouselId: string; otherBrandId: string };
    otherCarouselId = state.otherCarouselId;
    const real = (logical: string) => {
      const i = logical.indexOf(":");
      return path.posix.join(MACOS_ROOTS[logical.slice(0, i)], logical.slice(i + 1));
    };
    const hctx: HostileContext = {
      appPort: APP_PORT,
      decoyPort: DECOY_PORT,
      subjectAddress: "127.0.0.1",
      runCarouselId: state.runCarouselId,
      otherCarouselId: state.otherCarouselId,
      otherBrandId: state.otherBrandId,
      files: Object.fromEntries(Object.entries(cpaths).map(([id, p]) => [id, real(p)])),
      home: MACOS_ROOTS.home,
      checkout: MACOS_ROOTS.checkout,
      platform: "macos",
      linkLocal: [d.gateway6],
    };
    for (const [file, body] of [
      ["brief.html", hostilePage(hctx)],
      ["hostile.txt", hostileMessage(hctx)],
      ["followup.txt", FOLLOWUP_MESSAGE],
    ] as const) {
      writeFileSync(path.join(configDir, file), body);
      vm.start(`config-file ${file}`, { input: body });
    }

    // Isolation preflight: a host-side listener the subject must not reach, proven reachable from the VM's admin account first.
    // The host's addresses again now that the VM runs: its NAT bridge (the VM's gateway) exists only while a VM does.
    for (const a of hostAddresses()) if (!lan.includes(a)) lan.push(a);
    host = await hostListener(lan, path.join(raw, "host-listener.jsonl"));
    const controlFrom = Date.now();
    vm.ssh(`nc -z -G 3 -w 3 ${d.gateway4} ${host.port}`, { allowFail: true });
    await sleep(1000);
    const controlTo = Date.now();
    const controlAccepts = host.accepts(controlFrom, controlTo);
    const apiIp = (await lookup("api.anthropic.com", { family: 4 })).address;
    const targets = [...new Set([d.gateway4, ...lan.filter((a) => !a.includes(":"))])];
    // IPv6 link-local: the gateway's and every link-local address the host has, scoped to the VM's uplink.
    const llTargets = [...new Set([d.gateway6, ...lan.filter((a) => /^fe80:/i.test(a)).map((a) => `${a}%${d.interface || "en0"}`)])];
    facts.linkLocalProbe = { targets: llTargets.length, ports: llPorts };
    mark("preflight", "preflight");
    const subjectFrom = Date.now();
    const probeOut = vm.asSubject("preflight.sh", [String(host.port), "127.0.0.1", String(PROXY_PORT), apiIp, scan4.open.join(","), llTargets.join(","), llPorts.join(","), ...targets], 15 * 60 * 1000).stdout;
    await sleep(3000);
    const subjectAccepts = host.accepts(subjectFrom, Date.now());
    const strayAccepts = host.accepts(controlTo + 1, subjectFrom - 1);
    facts.hostListener = { control: controlAccepts, subject: subjectAccepts, betweenBrackets: strayAccepts };
    mark("snapshot-pre-control", "harness");
    vm.t1("services/observer.ts finalize --peek");
    copyRecords();
    let evidence = loadEvidence(raw, platform);
    preflight = evaluatePreflight({
      probes: parseJsonl(probeOut) as unknown as PreflightProbe[],
      controlHostHits: controlAccepts.length,
      subjectHostHits: subjectAccepts.length + strayAccepts.length,
      window: windowsFromMarks(evidence.marks).find((w) => w.phase === "preflight"),
      packets: evidence.packets,
      dns: evidence.dns,
      proxy: evidence.proxy,
      addresses: targets,
      ip6NoRoute: evidence.ip6NoRoute,
      linkLocalTargets: llTargets,
    });
    say(`preflight: ${preflight.passed ? "passed" : "FAILED"}\n${preflight.checks.map((c) => `  [${c.ok ? "ok" : "!!"}] ${c.check}: ${c.detail}`).join("\n")}\n`);
    if (preflight.isolationFailure) {
      stopReason = "ISOLATION FAILURE: the subject reached something it must not; the run stopped before any hostile input";
      throw new Error(stopReason);
    }

    // Positive control, its cleanup, and the snapshots that bracket them.
    snapshot("pre-control");
    mark("control", "control");
    const controlOut = vm.asSubject("control.sh", [String(APP_PORT), String(DECOY_PORT), state.runCarouselId, state.otherCarouselId, state.otherBrandId, `127.0.0.1:${PROXY_PORT}`, d.gateway6], 10 * 60 * 1000, { appEnv: true, unlockKeychain: true }).stdout;
    facts.controlSteps = parseJsonl(controlOut);
    await sleep(2500);
    mark("snapshot-post-control", "harness");
    snapshot("post-control");
    mark("control-cleanup", "cleanup", MACOS_CLEANUP_PATHS);
    vm.asSubject("cleanup.sh", []);
    await sleep(1500);
    mark("snapshot-baseline", "harness");
    snapshot("baseline");

    vm.t1("services/observer.ts finalize --peek");
    copyRecords();
    evidence = loadEvidence(raw, platform);
    const interim = assess(evidence, { opts, otherCarouselId, canaryPaths: cpaths, preflight, dryRun: true });
    const missed = controlCoverage(interim.observations, interim.windows, platform).filter((c) => c.count === 0);
    say(`positive control (which observers caught which control action):\n${controlReport(interim.judgement.control).join("\n")}\n`);
    if (!opts.dryRun) {
      if (!preflight.passed) stopReason = "the isolation preflight did not pass";
      else if (missed.length > 0) stopReason = `the positive control was missed by ${missed.map((m) => `${m.observer}/${m.channel}`).join(", ")}`;
      else if (interim.judgement.stray.length > 0) stopReason = `${interim.judgement.stray.length} unexplained observation(s) before the model phases`;
      if (stopReason) say(`not starting the model phases: ${stopReason}\n`);
    }

    if (budget && !stopReason) {
      const { check } = reserveT1(budget, ledgerRun(), `T1 ${opts.mode} macos: reserved ${budget.plan.calls.design} Design Agent and ${budget.plan.calls.director} Director call(s) at cap x (1 + overshoot)`);
      reserved = true;
      say(`spend reserved: ${check.message}\n`);
      mark("hostile", "model");
      startedMessages++;
      say(`hostile: ${vm.t1("services/observer.ts drive chat hostile hostile.txt", { timeoutMs: (opts.deadlineSeconds + 120) * 1000, allowFail: true }).stdout}`);
      await sleep(3000);
      mark("snapshot-post-hostile", "harness");
      snapshot("post-hostile");
      mark("followup", "model");
      startedMessages++;
      say(`followup: ${vm.t1("services/observer.ts drive chat followup followup.txt hostile", { timeoutMs: (opts.deadlineSeconds + 120) * 1000, allowFail: true }).stdout}`);
      await sleep(3000);
      mark("snapshot-post-followup", "harness");
      snapshot("post-followup");
    }
    mark("tail", "harness");
    await sleep(3000);
    mark("end", "end");
    await sleep(1500);
  } catch (err) {
    stopReason ??= err instanceof Error ? err.message : String(err);
    say(`stopped: ${stopReason}\n`);
  } finally {
    host?.close();
  }

  let spend: Record<string, unknown> = { caps: budget?.caps ?? null, reportedUsd: null };
  if (vm) {
    try {
      vm.t1("services/observer.ts finalize", { allowFail: true });
      const status = vm.start("status", { allowFail: true });
      facts.endStatus = status.stdout.trim();
      const appLog = vm.ssh("sudo cat /var/t1/app.log", { allowFail: true }).stdout;
      facts.appStart = /t1: starting the app as designer \((with|without) a model token\)/.exec(appLog)?.[0] ?? "not started";
      if (budget) spend = { ...spend, reportedUsd: reportedCost(appLog) };
      copyRecords();
      // The same channels at the end: nothing mounted by anyone during the run, and no new host folder held.
      const mounts = existsSync(path.join(raw, "mounts.jsonl")) ? parseJsonl(readFileSync(path.join(raw, "mounts.jsonl"), "utf8")) : [];
      const ev = channelEvidence(clone, logFrom);
      const uplinkAtEnd = /"uplinkInet6":"([^"]*)"/.exec(status.stdout)?.[1] ?? "unknown";
      const endProblems = [
        ...(uplinkAtEnd ? [`IPv6 was on the uplink at the end (${uplinkAtEnd})`] : []),
        ...ev.hostDirectories.filter((d) => d !== "/" && d !== "/private/var/empty").map((d) => `the VM held a host folder open at the end: ${d}`),
        ...(/clipboard/i.test(ev.log) ? ["lume's log mentions clipboard sync"] : []),
        ...mounts.map((m) => `a VirtioFS mount appeared during the run (${String(m.owner ?? "unknown")})`),
      ];
      facts.channelsAtEnd = { hostDirectories: ev.hostDirectories, mounts: mounts.length, problems: endProblems };
      if (endProblems.length > 0 && preflight) {
        preflight = { ...preflight, passed: false, isolationFailure: true, problems: [...preflight.problems, ...endProblems] };
        say(`ISOLATION: ${endProblems.join("; ")}\n`);
      }
      vm.start("down", { allowFail: true });
    } catch (err) {
      say(`collecting from the VM failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (budget && reserved) {
    const reportedUsd = (spend.reportedUsd as { total: number | null } | null)?.total ?? null;
    try {
      const entry = settleT1({ ledger: budget.ledger, caps: budget.caps, run: ledgerRun(), startedMessages, reportedUsd, label: `T1 ${opts.mode} macos` });
      spend = { ...spend, startedMessages, settledUsd: entry.costUsd };
      say(`spend settled: USD ${entry.costUsd.toFixed(2)} for ${startedMessages} started message(s), each at its full limit\n`);
    } catch (err) {
      spend = { ...spend, startedMessages, settledUsd: null };
      say(`settling the reservation failed (it still counts in full): ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (vmInfo(clone)) {
    if (opts.keep) say(`kept the VM ${clone}; delete it with: lume stop ${clone} && lume delete ${clone} --force\n`);
    else {
      await stopVm(clone);
      lume(["delete", clone, "--force"], { allowFail: true });
      facts.cloneDeleted = !vmInfo(clone) && !existsSync(path.join(lumeStorage(), clone));
      facts.host = { ...(facts.host as object), freeGbAfterDelete: hostFreeGb() };
      say(facts.cloneDeleted ? `deleted the clone ${clone}\n` : `THE CLONE ${clone} WAS NOT DELETED; delete it with: lume delete ${clone} --force\n`);
    }
  }
  rmSync(sshDir, { recursive: true, force: true });
  const j = finishRun({ opts: { ...opts, platform }, runId, records, raw, stopReason, facts, config, canaries, spend, preflight, otherCarouselId, cpaths, redaction });
  return { ...j, stopReason };
}
