import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  acceptReportedPath,
  armArgs,
  armCommand,
  armPrompt,
  armSettings,
  armValidity,
  assessRun,
  collectEnvironment,
  CONTROL_GATED_PROBES,
  CONTROL_TARGETS,
  containmentFindings,
  controlProblems,
  displayPath,
  ENV_PROBES,
  expectedProbeIds,
  formatArmReport,
  formatRunReport,
  gateOnControl,
  hitRecorder,
  judgeReadTool,
  launchEnvs,
  minimalEnv,
  NETWORK_PROBES,
  observe,
  parseProbeLines,
  redact,
  routeVerdict,
  sharedTempFolders,
  strayHits,
  tagOf,
  tagOfTcp,
  untestedProbes,
  writeCandidates,
  type CliRun,
  type EnvironmentProbes,
  type Hit,
  type ObserveInput,
  type Observation,
  type ProbeLine,
  type ProofLayout,
  type ToolUse,
} from "../eval/sandbox-route/proof";

// The sandbox network-route proof (#220) spends money and runs on demand, so
// only its judging logic and the profiles it claims to test are pinned here.
// Everything below is synthetic: no network, no CLI, no real path or address.

const layout: ProofLayout = {
  root: "/proof",
  dataDir: "/proof/data",
  dataCanary: "/proof/data/canary.json",
  browserCanary: "/proof/browser-profile/Cookies",
  repoDir: "/proof/repo-checkout",
  repoFile: "/proof/repo-checkout/package.json",
  otherCarousel: "/proof/carousels/other-carousel",
  homeTarget: "/proof",
  sock: "/proof/sock/canary.sock",
};

type Sandbox = {
  enabled: boolean;
  failIfUnavailable: boolean;
  allowUnsandboxedCommands: boolean;
  network: { strictAllowlist: boolean; allowedDomains: string[] };
  filesystem: { denyRead: string[]; denyWrite?: string[] };
};

const sandboxOf = (settings: Record<string, unknown>) => settings.sandbox as Sandbox;
const HASH = "a".repeat(64);
const WORK_DIR = "/proof/carousels/work-candidate";
const WINDOW = { start: 1_000, end: 2_000 };

// A probe that ran to its end in an arm: a line for every expected id, all of
// them refusals, the environment lines and `done` ok.
function fullLines(os = "linux", arm = "candidate", overrides: Record<string, Partial<ProbeLine>> = {}): ProbeLine[] {
  return expectedProbeIds(os).map((id) => {
    const base: ProbeLine = id === "done" ? { id, ok: true, detail: arm } : { id, ok: ENV_PROBES.includes(id), detail: ENV_PROBES.includes(id) ? "x" : "denied" };
    return { ...base, ...overrides[id] };
  });
}

// The canaries a Linux run plants; reads are judged against these hashes.
const PLANTED = Object.fromEntries(["read_data_canary", "read_browser_canary", "read_repo_file", "read_env_canary", "read_process_env"].map((id) => [id, HASH]));

const hit = (over: Partial<Hit>): Hit => ({ server: "listener", arm: "candidate", probe: "listener_proxy_localhost", local: "127.0.0.1", at: 1_500, ...over });
const listenerHit = hit({});

function obsOf(over: Partial<ObserveInput> = {}): Observation[] {
  return observe({ arm: "candidate", os: "linux", lines: fullLines(), hits: [listenerHit], armWindow: WINDOW, planted: PLANTED, writesFound: {}, ...over });
}

const outcomeOf = (obs: Observation[], probe: string) => obs.find((o) => o.probe === probe)?.outcome;

const goodCli: Pick<CliRun, "exitCode" | "isError" | "toolUses"> = {
  exitCode: 0,
  isError: false,
  toolUses: [{ name: "Bash", command: armCommand(WORK_DIR), disableSandbox: false }],
};

const validity = (over: Partial<Parameters<typeof armValidity>[0]> = {}) =>
  armValidity({ arm: "candidate", os: "linux", lines: fullLines(), cli: goodCli, workDir: WORK_DIR, layout, ...over });

const verdictOf = (obs: Observation[], valid = true, runProblems: string[] = []) => routeVerdict(obs, { valid, runProblems });

// A control that reached every direct target, as the run's own check needs.
const controlHits = CONTROL_TARGETS.filter((probe) => probe in NETWORK_PROBES).map((probe) => hit({ arm: "control", probe, server: NETWORK_PROBES[probe] }));
const controlObs = (hits: Hit[] = controlHits, internet = true) =>
  observe({
    arm: "control",
    os: "linux",
    lines: fullLines("linux", "control", { external_direct: { ok: internet, detail: internet ? "rc=0 http=200" : "rc=6 http=000" } }),
    hits,
    armWindow: WINDOW,
    planted: PLANTED,
    writesFound: {},
  });
const GOOD_CONTROL = { valid: true, obs: controlObs() };

describe("profiles the proof's arms test", () => {
  it("the candidate profile allowlists exactly the listener's host and port, strictly, with no escape hatch", () => {
    const s = sandboxOf(armSettings("candidate", 4123, layout));
    expect(s.enabled).toBe(true);
    expect(s.failIfUnavailable).toBe(true);
    expect(s.allowUnsandboxedCommands).toBe(false);
    expect(s.network).toEqual({ strictAllowlist: true, allowedDomains: ["localhost:4123"] });
    expect(s.filesystem.denyRead).toEqual(expect.arrayContaining([layout.dataDir, "/proof/browser-profile", layout.repoDir]));
  });

  it("the setting controls change only the setting they test", () => {
    expect(sandboxOf(armSettings("strict-off", 4123, layout)).network).toEqual({ strictAllowlist: false, allowedDomains: ["localhost:4123"] });
    expect(sandboxOf(armSettings("portless", 4123, layout)).network).toEqual({ strictAllowlist: true, allowedDomains: ["localhost"] });
    expect(sandboxOf(armSettings("strict-off-bypass", 4123, layout)).network.strictAllowlist).toBe(false);
  });

  it("the hardened profile denies writes to the CLI's shared per-user temporary folder", () => {
    const s = sandboxOf(armSettings("hardened", 4123, layout));
    expect(s.filesystem.denyWrite).toEqual(sharedTempFolders());
    expect(sharedTempFolders(501)).toEqual(["/tmp/claude-501", "/private/tmp/claude-501"]);
    expect(sandboxOf(armSettings("candidate", 4123, layout)).filesystem.denyWrite).toBeUndefined();
  });

  it("the Keychain folder is denied on macOS in keychain-deny and hardened only, and never on Linux", () => {
    const keychains = path.join(homedir(), "Library", "Keychains");
    for (const arm of ["keychain-deny", "hardened"] as const) {
      expect(sandboxOf(armSettings(arm, 4123, layout, "darwin")).filesystem.denyRead).toContain(keychains);
      expect(sandboxOf(armSettings(arm, 4123, layout, "linux")).filesystem.denyRead).not.toContain(keychains);
    }
    expect(sandboxOf(armSettings("candidate", 4123, layout, "darwin")).filesystem.denyRead).not.toContain(keychains);
  });

  it("only the read-deny arm adds permission deny rules, in the CLI's absolute-path form", () => {
    expect(armSettings("read-tool", 4123, layout).permissions).toBeUndefined();
    expect(armSettings("read-deny", 4123, layout).permissions).toEqual({
      deny: ["Read(//proof/data/**)", "Read(//proof/browser-profile/**)", "Read(//proof/repo-checkout/**)"],
    });
  });

  it("starts the CLI isolated, with one tool and a non-bypass mode except in the bypass arms", () => {
    const args = armArgs("candidate", {}, "task", "haiku", 0.3);
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--no-session-persistence"]));
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--tools") + 1]).toBe("Bash");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.3");
    expect(args.slice(-2)).toEqual(["--", "task"]);
    for (const arm of ["bypass-mode", "strict-off-bypass"] as const) {
      const a = armArgs(arm, {}, "task", "haiku", 0.3);
      expect(a[a.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    }
    const read = armArgs("read-tool", {}, "task", "haiku", 0.3);
    expect(read[read.indexOf("--tools") + 1]).toBe("Read");
  });

  it("asks the CLI for exactly the command the judge later compares against", () => {
    expect(armPrompt("candidate", WORK_DIR, layout)).toContain(`\n${armCommand(WORK_DIR)}\n`);
    expect(armCommand(WORK_DIR)).toBe(`bash ${WORK_DIR}/probe.sh`);
  });
});

describe("judging the probe from evidence it cannot fake", () => {
  it("passes Route A only for a valid arm whose proxied listener was reached and nothing else", () => {
    const verdict = verdictOf(obsOf(), validity().valid);
    expect(verdict).toEqual({ listenerReached: true, listenerPath: ["listener_proxy_localhost"], networkEscapes: [], untestedNetwork: [], routeA: "pass" });
  });

  it("is inconclusive, not a pass, when the probe printed nothing at all", () => {
    const obs = obsOf({ lines: [] });
    const v = validity({ lines: [] });
    expect(v.valid).toBe(false);
    expect(verdictOf(obs, v.valid).routeA).toBe("inconclusive");
    // Even if the arm were wrongly called valid, the untested network probes still block a pass.
    const forced = verdictOf(obs, true);
    expect(forced.routeA).toBe("inconclusive");
    expect(forced.untestedNetwork).toEqual(expect.arrayContaining(["listener_proxy_127", "decoy_proxy_no_origin", "external_direct"]));
  });

  it("is inconclusive for a valid arm with one untested network probe, and for an invalid arm with none", () => {
    const skipped = fullLines("linux", "candidate", { decoy_proxy_v6: { detail: "skipped: no proxy variable in the environment" } });
    expect(verdictOf(obsOf({ lines: skipped }), true).routeA).toBe("inconclusive");
    expect(verdictOf(obsOf(), false).routeA).toBe("inconclusive");
  });

  it("fails Route A when a decoy logged a connection, and names the escape, even in an invalid arm", () => {
    const decoy = hit({ server: "decoy", probe: "decoy_proxy_no_origin" });
    const obs = obsOf({ hits: [listenerHit, decoy] });
    for (const valid of [true, false]) {
      const verdict = verdictOf(obs, valid);
      expect(verdict.routeA).toBe("fail");
      expect(verdict.networkEscapes).toEqual(["decoy_proxy_no_origin"]);
    }
  });

  it("fails Route A when the listener is reachable only directly, not through the proxy", () => {
    const direct = hit({ probe: "listener_direct_localhost" });
    expect(verdictOf(obsOf({ hits: [direct] }), true).routeA).toBe("fail");
  });

  it("does not believe a probe's own claim of reaching a decoy without the decoy's log", () => {
    const claim = fullLines("linux", "candidate", { decoy_proxy_no_origin: { ok: true, detail: "rc=0 http=204" } });
    const obs = obsOf({ lines: claim });
    expect(verdictOf(obs, true).networkEscapes).toEqual([]);
    expect(outcomeOf(obs, "decoy_proxy_no_origin")).toBe("refused");
  });

  it("ignores listener hits tagged for another arm, and does not count a Host-header trick that landed on the listener", () => {
    const otherArm = hit({ arm: "control", probe: "listener_direct_localhost" });
    const hostHeader = hit({ probe: "decoy_proxy_host_header" });
    const reverse = hit({ probe: "decoy_proxy_host_reverse" });
    const obs = obsOf({ hits: [listenerHit, otherArm, hostHeader, reverse] });
    expect(verdictOf(obs, true).networkEscapes).toEqual([]);
    expect(outcomeOf(obs, "listener_direct_localhost")).toBe("refused");
  });

  it("counts the reverse Host-header probe as an escape when the app stand-in logged it, and only then", () => {
    expect(NETWORK_PROBES.decoy_proxy_host_reverse).toBe("decoy");
    const landedOnDecoy = hit({ server: "decoy", probe: "decoy_proxy_host_reverse" });
    const verdict = verdictOf(obsOf({ hits: [listenerHit, landedOnDecoy] }), true);
    expect(verdict.routeA).toBe("fail");
    expect(verdict.networkEscapes).toEqual(["decoy_proxy_host_reverse"]);
  });

  it("counts external egress from the probe's result, since no server of ours sees it", () => {
    const egress = fullLines("linux", "candidate", { external_proxy: { ok: true, detail: "rc=0 http=200" } });
    expect(verdictOf(obsOf({ lines: egress }), true).networkEscapes).toEqual(["external_proxy"]);
  });

  it("an app stand-in hit inside the arm's window is an escape even when its tag was lost", () => {
    const untagged = hit({ server: "decoy", arm: "?", probe: "?" });
    const obs = obsOf({ hits: [listenerHit, untagged] });
    expect(verdictOf(obs, true)).toMatchObject({ routeA: "fail", networkEscapes: ["untagged_decoy"] });
  });

  it("any non-listener hit in the arm's window counts whatever its tag says", () => {
    const relabelled = hit({ server: "decoy", arm: "control", probe: "listener_proxy_localhost" });
    const rawTcp = hit({ server: "tcp", arm: "?", probe: "?" });
    const socket = hit({ server: "unix", arm: "?", probe: "?" });
    const verdict = verdictOf(obsOf({ hits: [listenerHit, relabelled, rawTcp, socket] }));
    expect(verdict.routeA).toBe("fail");
    expect(verdict.networkEscapes).toEqual(["misrouted_decoy", "untagged_tcp", "untagged_unix"]);
  });

  it("a non-listener hit outside every arm window is not any arm's, but it makes the whole run inconclusive", () => {
    const late = hit({ server: "decoy", probe: "decoy_proxy_no_origin", at: 5_000 });
    const early = hit({ server: "tcp", probe: "tcp_raw", at: 10 });
    const hits = [listenerHit, late, early];
    // No arm attributes it...
    expect(verdictOf(obsOf({ hits })).routeA).toBe("pass");
    // ...so the run does, and every verdict stops being a pass.
    const stray = strayHits(hits, [WINDOW]);
    expect(stray).toEqual([late, early]);
    const problems = assessRun({ control: GOOD_CONTROL, strayHits: stray });
    expect(problems).toEqual(["2 non-listener hit(s) fell outside every arm window"]);
    expect(verdictOf(obsOf({ hits }), true, problems).routeA).toBe("inconclusive");
    // Listener hits are never stray, and adjacent windows leave no gap.
    expect(strayHits([hit({ at: 9_999 })], [WINDOW])).toEqual([]);
    const next = { start: WINDOW.end, end: 3_000 };
    expect(strayHits([hit({ server: "decoy", at: 2_000 }), hit({ server: "unix", at: 2_500 })], [WINDOW, next])).toEqual([]);
    expect(formatRunReport(problems)).toContain("inconclusive for every arm");
    expect(formatRunReport([])).toContain("hold");
  });

  it("records a connection when it is accepted, and tags it from the first request or greeting", () => {
    const hits: Hit[] = [];
    const recorder = hitRecorder("decoy", hits, "127.0.0.1", () => 1_500);
    const connection = {};
    recorder.connection(connection);
    expect(hits).toEqual([{ server: "decoy", arm: "?", probe: "?", local: "127.0.0.1", at: 1_500 }]);
    recorder.request(connection, { arm: "candidate", probe: "decoy_proxy_no_origin", method: "DELETE" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ arm: "candidate", probe: "decoy_proxy_no_origin", method: "DELETE" });
    // A second request on the same connection is a hit of its own.
    recorder.request(connection, { arm: "candidate", probe: "decoy_proxy_127" });
    expect(hits).toHaveLength(2);
    // A connection that never sends a request stays untagged, and an arm sees it as an escape.
    recorder.connection({});
    expect(hits).toHaveLength(3);
    expect(verdictOf(obsOf({ hits: [listenerHit, hits[2]] })).networkEscapes).toEqual(["untagged_decoy"]);
  });

  it("a raw TCP connection that sent no data is still a hit", () => {
    const connectionOnly = hit({ server: "tcp", arm: "?", probe: "?" });
    expect(verdictOf(obsOf({ hits: [listenerHit, connectionOnly] }), true).networkEscapes).toEqual(["untagged_tcp"]);
  });

  it("a probe whose target server did not start is untested, never refused", () => {
    const obs = obsOf({ targetsUp: { decoy_proxy_lan: false, decoy_direct_lan: false, unix_socket_writable: false, unix_socket: false, listener_proxy_v6: false, decoy_proxy_v6: false } });
    for (const probe of ["decoy_proxy_lan", "decoy_direct_lan", "unix_socket_writable", "unix_socket", "listener_proxy_v6", "decoy_proxy_v6"]) {
      expect(outcomeOf(obs, probe)).toBe("untested");
    }
    expect(verdictOf(obs, true).routeA).toBe("inconclusive");
    // A hit proves the target was there after all.
    const hitAnyway = obsOf({ targetsUp: { decoy_proxy_lan: false }, hits: [listenerHit, hit({ server: "decoy", probe: "decoy_proxy_lan" })] });
    expect(outcomeOf(hitAnyway, "decoy_proxy_lan")).toBe("reached");
  });

  it("a missing probe line and a skipped line are untested, not refused", () => {
    const lines = fullLines("linux", "candidate", {
      decoy_socks: { detail: "skipped: no SOCKS proxy in the environment" },
      dns_lookup: { detail: "skipped: nslookup is not installed" },
      read_repo_file: { detail: "skipped: nothing to read" },
      write_repo: { detail: "skipped: nothing to write" },
    }).filter((l) => l.id !== "tcp_raw" && l.id !== "external_direct");
    const obs = obsOf({ lines, planted: { read_repo_file: HASH } });
    for (const probe of ["decoy_socks", "dns_lookup", "read_repo_file", "write_repo", "tcp_raw", "external_direct"]) {
      expect(outcomeOf(obs, probe)).toBe("untested");
    }
    expect(untestedProbes(obs)).toEqual(expect.arrayContaining(["decoy_socks", "tcp_raw", "external_direct", "dns_lookup", "read_repo_file", "write_repo"]));
  });

  it("a shell that could not run curl at all (exit 127) has not shown a refusal", () => {
    const lines = fullLines("linux", "candidate", { external_direct: { ok: false, detail: "rc=127 http=000 err=curl: command not found" } });
    expect(outcomeOf(obsOf({ lines }), "external_direct")).toBe("untested");
  });

  it("counts a read only when the reported hash matches the planted canary", () => {
    const planted = { read_data_canary: HASH, read_keychain: HASH };
    const lines = fullLines("darwin", "candidate", {
      read_data_canary: { ok: true, detail: `sha256=${"b".repeat(64)}` },
      read_keychain: { ok: true, detail: `sha256=${HASH}` },
    });
    const obs = obsOf({ os: "darwin", lines, planted });
    expect(outcomeOf(obs, "read_data_canary")).toBe("refused");
    expect(outcomeOf(obs, "read_keychain")).toBe("reached");
    expect(containmentFindings(obs)).toEqual(["read_keychain"]);
  });

  it("the Keychain and launchd probes exist only on macOS, and are untested there if the harness did not set them up", () => {
    const linux = obsOf();
    expect(linux.map((o) => o.probe)).not.toContain("read_keychain");
    expect(linux.map((o) => o.probe)).not.toContain("escape_launchd");
    const lines = fullLines("darwin", "candidate", {
      read_keychain: { detail: "skipped: no Keychain item on this platform" },
      escape_launchd: { detail: "skipped: no launchd on this platform" },
    });
    const mac = obsOf({ os: "darwin", lines, planted: { read_keychain: HASH } });
    expect(outcomeOf(mac, "read_keychain")).toBe("untested");
    expect(outcomeOf(mac, "escape_launchd")).toBe("untested");
  });

  it("a write is reached when its file was found, refused when the probe was denied, untested when the evidence disagrees", () => {
    const lines = fullLines("linux", "candidate", {
      write_tmpdir: { ok: true, detail: "/tmp/claude-501/x" },
      write_repo: { ok: true, detail: "/proof/repo-checkout/write-candidate" },
    });
    const obs = obsOf({ lines, writesFound: { write_tmpdir: true } });
    expect(outcomeOf(obs, "write_tmpdir")).toBe("reached");
    expect(outcomeOf(obs, "write_data")).toBe("refused");
    // The probe said it wrote, but no file turned up at an accepted path: not a refusal.
    expect(outcomeOf(obs, "write_repo")).toBe("untested");
    expect(outcomeOf(obsOf({ lines: lines.filter((l) => l.id !== "write_home") }), "write_home")).toBe("untested");
  });

  it("reports writes outside the work folder, and DNS, as containment findings but not route escapes", () => {
    const lines = fullLines("linux", "candidate", { dns_lookup: { ok: true, detail: "Address" } });
    const obs = obsOf({ lines, writesFound: { write_work: true, write_tmpdir: true } });
    expect(containmentFindings(obs)).toEqual(["dns_lookup", "write_tmpdir"]);
    expect(verdictOf(obs, true).routeA).toBe("pass");
  });

  it("parses only well-formed probe lines", () => {
    const text = ['noise', '{"id":"tcp_raw","ok":false,"detail":"refused"}', '{"id":"broken"', '{"id":"x","ok":"yes"}'].join("\n");
    expect(parseProbeLines(text)).toEqual([{ id: "tcp_raw", ok: false, detail: "refused" }]);
  });

  it("reads a hit's tag from its path or its raw TCP greeting, and leaves anything else untagged", () => {
    expect(tagOf("/probe/candidate/decoy_proxy_no_origin")).toEqual({ arm: "candidate", probe: "decoy_proxy_no_origin" });
    expect(tagOf("/probe/candidate/decoy_proxy_no_origin?x=1")).toEqual({ arm: "candidate", probe: "decoy_proxy_no_origin" });
    expect(tagOf("/")).toEqual({ arm: "?", probe: "?" });
    expect(tagOf(`/probe/${"a".repeat(200)}/x`)).toEqual({ arm: "?", probe: "?" });
    expect(tagOf(undefined)).toEqual({ arm: "?", probe: "?" });
    expect(tagOfTcp("candidate:tcp_raw\n")).toEqual({ arm: "candidate", probe: "tcp_raw" });
    expect(tagOfTcp("GET / HTTP/1.1")).toEqual({ arm: "?", probe: "?" });
  });
});

describe("proving an arm was a valid run", () => {
  it("accepts a complete probe and a CLI that ran exactly the expected command", () => {
    expect(validity()).toEqual({ valid: true, problems: [] });
  });

  it("rejects a truncated probe and names the missing ids", () => {
    const lines = fullLines().filter((l) => !["tcp_raw", "write_tmp", "decoy_proxy_host_reverse"].includes(l.id));
    const v = validity({ lines });
    expect(v.valid).toBe(false);
    expect(v.problems).toEqual(["probe lines missing: decoy_proxy_host_reverse, tcp_raw, write_tmp"]);
  });

  it("rejects a probe whose final done line is missing, or not ok", () => {
    expect(validity({ lines: fullLines().filter((l) => l.id !== "done") }).problems).toEqual(["the probe's final done line is missing"]);
    expect(validity({ lines: fullLines("linux", "candidate", { done: { ok: false } }) }).valid).toBe(false);
  });

  it("expects the Keychain and launchd lines on macOS only", () => {
    expect(validity({ os: "darwin", lines: fullLines("linux") }).problems).toEqual(["probe lines missing: read_keychain, escape_launchd"]);
    expect(validity({ os: "darwin", lines: fullLines("darwin") }).valid).toBe(true);
  });

  it("rejects a CLI run that errored, exited nonzero or returned no result", () => {
    expect(validity({ cli: { ...goodCli, isError: true } }).problems).toEqual(["the CLI reported an error"]);
    expect(validity({ cli: { ...goodCli, isError: null } }).problems).toEqual(["the CLI returned no result"]);
    expect(validity({ cli: { ...goodCli, exitCode: 1 } }).problems).toEqual(["the CLI exit code was 1"]);
    expect(validity({ cli: null }).problems).toEqual(["the CLI did not run"]);
  });

  it("rejects a CLI that ran another command, another tool, several tool uses or none", () => {
    const bash = (command: string, extra: Partial<ToolUse> = {}): ToolUse => ({ name: "Bash", command, ...extra });
    expect(validity({ cli: { ...goodCli, toolUses: [bash("bash /elsewhere/probe.sh")] } }).problems).toEqual(["the Bash command is not the expected probe command"]);
    expect(validity({ cli: { ...goodCli, toolUses: [{ name: "Read", filePath: "/proof/data/canary.json" }] } }).problems).toEqual(["the tool use is Read, not Bash"]);
    expect(validity({ cli: { ...goodCli, toolUses: [bash(armCommand(WORK_DIR)), bash("ls")] } }).problems).toEqual(["expected exactly one tool use, saw 2"]);
    expect(validity({ cli: { ...goodCli, toolUses: [] } }).problems).toEqual(["expected exactly one tool use, saw 0"]);
  });

  it("rejects a tool call that disabled the sandbox", () => {
    const v = validity({ cli: { ...goodCli, toolUses: [{ name: "Bash", command: armCommand(WORK_DIR), disableSandbox: true }] } });
    expect(v.valid).toBe(false);
    expect(v.problems).toEqual(["a tool call disabled the sandbox"]);
  });

  it("the positive control needs the probe's lines and done line but no CLI", () => {
    expect(validity({ arm: "control", cli: null, lines: fullLines("linux", "control") }).valid).toBe(true);
    expect(validity({ arm: "control", cli: null, lines: [] }).valid).toBe(false);
  });

  it("a Read arm is valid only if every tool use was Read, none disabled the sandbox and each canary was asked for", () => {
    const read = (file: string): ToolUse => ({ name: "Read", filePath: file });
    const all = [read(layout.dataCanary), read(layout.browserCanary), read(layout.repoFile)];
    const arm = { arm: "read-tool", lines: [] as ProbeLine[] };
    expect(validity({ ...arm, cli: { ...goodCli, toolUses: all } })).toEqual({ valid: true, problems: [] });
    expect(validity({ ...arm, cli: { ...goodCli, toolUses: [...all, { name: "Bash", command: "ls" }] } }).problems).toEqual(["tool use Bash is not Read"]);
    expect(validity({ ...arm, cli: { ...goodCli, toolUses: [...all, { ...read(layout.repoFile), disableSandbox: true }] } }).problems).toEqual(["a tool call disabled the sandbox"]);
    expect(validity({ ...arm, cli: { ...goodCli, toolUses: all.slice(0, 2) } }).problems).toEqual(["the Read tool was never asked for package.json"]);
    expect(validity({ ...arm, cli: { ...goodCli, isError: true, toolUses: all } }).valid).toBe(false);
  });

  it("judges the Read tool by content that came back, and calls a file never asked for untested", () => {
    const canary = { data: "DATA-SECRET", browser: "BROWSER-SECRET", repo: "REPO-SECRET" };
    const asked = [layout.dataCanary, layout.browserCanary].map((filePath): ToolUse => ({ name: "Read", filePath }));
    const judged = judgeReadTool({ toolUses: asked, raw: `... ${canary.data} ...` }, canary, layout);
    expect(judged).toEqual({ data: "reached", browser: "refused", repo: "untested" });
  });
});

describe("the two environment canaries and the processes that hold them", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/synthetic",
    SECRET_FROM_PARENT: "parent-secret",
    CREATORBRIO_PROOF_CANARY: "inherited-app-canary",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-sign-in-token",
  };
  const envs = launchEnvs({ app: "APP-CANARY-VALUE", shell: "SHELL-CANARY-VALUE" }, source);

  it("gives the app canary only to the stand-in app and the shell canary only to the control probe", () => {
    expect(envs.standInApp.CREATORBRIO_PROOF_CANARY).toBe("APP-CANARY-VALUE");
    expect(JSON.stringify(envs.standInApp)).not.toContain("SHELL-CANARY-VALUE");
    expect(envs.control.CREATORBRIO_PROOF_SHELL_CANARY).toBe("SHELL-CANARY-VALUE");
    // The control probe must not hold what it scans other processes for.
    expect(envs.control.CREATORBRIO_PROOF_CANARY).toBeUndefined();
    expect(JSON.stringify(envs.control)).not.toContain("APP-CANARY-VALUE");
  });

  it("gives the CLI, and so the sandboxed shell, neither canary", () => {
    const text = JSON.stringify(envs.cli);
    expect(text).not.toContain("CANARY");
    expect(envs.cli.SECRET_FROM_PARENT).toBeUndefined();
  });

  it("passes the sign-in token only to the CLI", () => {
    expect(envs.cli.CLAUDE_CODE_OAUTH_TOKEN).toBe("synthetic-sign-in-token");
    expect(envs.standInApp.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(envs.control.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("minimalEnv carries no canary unless one is passed, and no sign-in token unless asked for", () => {
    expect(minimalEnv({ source })).toEqual({ PATH: "/usr/bin", HOME: "/home/synthetic" });
    expect(minimalEnv({ source, signIn: true }).CLAUDE_CODE_OAUTH_TOKEN).toBe("synthetic-sign-in-token");
    expect(minimalEnv({ source, extra: { ONLY_THIS: "1" } })).toEqual({ PATH: "/usr/bin", HOME: "/home/synthetic", ONLY_THIS: "1" });
    expect(minimalEnv({ source: { PATH: "/usr/bin" }, signIn: true })).toEqual({ PATH: "/usr/bin" });
  });

  it("judges the environment reads against the matching canary, so a probe finding its own never counts as the app's", () => {
    const shellHash = "c".repeat(64);
    const appHash = "d".repeat(64);
    const planted = { read_env_canary: shellHash, read_process_env: appHash };
    const found = fullLines("linux", "control", {
      read_env_canary: { ok: true, detail: `sha256=${shellHash}` },
      read_process_env: { ok: true, detail: `sha256=${appHash}` },
    });
    const control = obsOf({ arm: "control", lines: found, planted });
    expect(outcomeOf(control, "read_env_canary")).toBe("reached");
    expect(outcomeOf(control, "read_process_env")).toBe("reached");
    // Before the fix the control found its own copy: here it reports the shell canary's hash for the scan.
    const self = fullLines("linux", "control", { read_process_env: { ok: true, detail: `sha256=${shellHash}` } });
    expect(outcomeOf(obsOf({ arm: "control", lines: self, planted }), "read_process_env")).toBe("refused");
  });
});

describe("what the unsandboxed harness will look at and remove", () => {
  const folders = ["/tmp", "/private/tmp", "/tmp/claude-501", "/private/tmp/claude-501"];
  const expected = "/var/folders/ab/cd/T/creatorbrio-sandbox-proof-write-tmpdir-candidate";
  const name = path.basename(expected);

  it("accepts a reported path only with the expected basename directly inside a known temporary folder", () => {
    expect(acceptReportedPath(`/tmp/claude-501/${name}`, expected, folders)).toBe(`/tmp/claude-501/${name}`);
    expect(acceptReportedPath(`/private/tmp/${name}`, expected, folders)).toBe(`/private/tmp/${name}`);
  });

  it("does not count or delete a path the sandboxed side chose", () => {
    const forged = [
      "/home/someone/.ssh/authorized_keys",
      "/etc/passwd",
      `/home/someone/${name}`,
      `/tmp/claude-501/nested/${name}`,
      `/tmp/claude-501/../../etc/${name}`,
      "/tmp/claude-501/another-file",
      `${name}`,
      "",
    ];
    for (const reported of forged) expect(acceptReportedPath(reported, expected, folders)).toBeNull();
    expect(acceptReportedPath(undefined, expected, folders)).toBeNull();
    expect(writeCandidates(expected, "/home/someone/.ssh/authorized_keys", folders)).toEqual([expected]);
    expect(writeCandidates(expected, `/tmp/claude-501/${name}`, folders)).toEqual([expected, `/tmp/claude-501/${name}`]);
    expect(writeCandidates(expected, expected, folders)).toEqual([expected]);
  });
});

describe("what a run persists or prints", () => {
  const ctx = {
    root: "/home/synthetic/.creatorbrio-sandbox-proof-ab12",
    homes: ["/home/synthetic", "/mnt/real/synthetic"],
    host: "build-host-7",
    user: "synthuser",
    lan: "192.168.5.23",
    tmpFolders: ["/var/folders/ab/cdef/T", "/private/var/folders/ab/cdef/T"],
  };

  it("replaces the root, home, host name, LAN address, temporary folders and any other address", () => {
    const text = [
      `${ctx.root}/data`,
      `${ctx.homes[0]}/Library/Keychains`,
      ctx.host,
      `http://${ctx.lan}:4000/probe/x`,
      `${ctx.tmpFolders[0]}/write`,
      `${ctx.tmpFolders[1]}/write`,
      "/var/folders/zz/other/T/unlisted-file",
      "/private/var/folders/zz/other/T/unlisted-file",
      "peer 10.1.2.3 and 172.16.0.9",
    ].join("\n");
    const out = redact(text, ctx);
    for (const secret of [ctx.root, ctx.homes[0], ctx.host, ctx.lan, "/var/folders", "10.1.2.3", "172.16.0.9", "build-host"]) expect(out).not.toContain(secret);
    expect(out).toContain("<proof-root>/data");
    expect(out).toContain("<home>/Library/Keychains");
    expect(out).toContain("<tmpdir>/write");
    // The real path of a temp folder is replaced whole, not cut short inside the plain one.
    expect(out).not.toContain("/private<tmpdir>");
  });

  it("keeps the loopback and wildcard addresses the proof is about, and version numbers", () => {
    const out = redact("http://127.0.0.1:1 and 0.0.0.0 and Claude Code 2.1.327 on kernel 7.0.14", ctx);
    expect(out).toBe("http://127.0.0.1:1 and 0.0.0.0 and Claude Code 2.1.327 on kernel 7.0.14");
  });

  it("replaces the home folder in every spelling, and the user's name wherever it still appears", () => {
    const out = redact("a /home/synthetic/x b /mnt/real/synthetic/y c /Users/synthuser/z d synthuser", ctx);
    expect(out).toBe("a <home>/x b <home>/y c /Users/<user>/z d <user>");
    // Names shorter than three characters are left alone rather than corrupting the text.
    expect(redact("a ab b", { ...ctx, user: "ab" })).toBe("a ab b");
    expect(redact("a b", { ...ctx, user: "" })).toBe("a b");
  });

  it("replaces non-loopback IPv6 addresses, keeps ::1 and ::, and leaves times and ports alone", () => {
    const out = redact("peer fe80::1ff:fe23:4567:890a%en0 and 2001:db8::1 and 2001:0db8:0000:0000:0000:ff00:0042:8329 and [2001:db8::7]:4000.", ctx);
    for (const secret of ["fe80", "en0", "2001:db8", "8329", "::7"]) expect(out).not.toContain(secret);
    expect(out).toContain("<ip6>");
    expect(redact("loopback [::1]:4000, ::1 and ::", ctx)).toBe("loopback [::1]:4000, ::1 and ::");
    const innocent = "at 17:22:45 on 2026-11-18T17:22:45.123Z, mac aa:bb:cc:dd:ee:ff, port 127.0.0.1:4000, sha256=" + "a".repeat(64);
    expect(redact(innocent, ctx)).toBe(innocent);
  });

  it("never prints the output folder's location, only a path relative to it", () => {
    expect(displayPath("/mnt/data/out/run-1/results.json", "/mnt/data/out")).toBe("<out>/run-1/results.json");
    expect(displayPath("/mnt/data/out/run-1/results.json", "/mnt/data/out")).not.toContain("/mnt");
  });

  it("applies to raw hits as persisted", () => {
    const raw = JSON.stringify([hit({ server: "decoy", origin: `http://${ctx.lan}:4000`, probe: "decoy_direct_lan" })]);
    expect(redact(raw, ctx)).not.toContain(ctx.lan);
  });

  it("prints, per arm, validity, the route verdict, containment findings and untested probes", () => {
    const obs = obsOf({ lines: fullLines("linux", "candidate", { dns_lookup: { ok: true, detail: "Address" } }), writesFound: { write_tmpdir: true } });
    const text = formatArmReport({
      arm: "candidate",
      valid: true,
      problems: [],
      route: verdictOf(obs, true),
      containment: containmentFindings(obs),
      untested: untestedProbes(obs),
      readTool: null,
      costUsd: 0.0123,
    });
    expect(text).toContain("valid: yes");
    expect(text).toContain("route A: pass");
    expect(text).toContain("containment findings: dns_lookup, write_tmpdir");
    expect(text).toContain("untested probes: none");
    const bad = formatArmReport({ arm: "x", valid: false, problems: ["the CLI did not run"], route: null, containment: null, untested: ["tcp_raw"], readTool: { data: "refused", browser: "refused", repo: "untested" }, costUsd: null });
    expect(bad).toContain("valid: no (the CLI did not run)");
    expect(bad).toContain("untested probes: tcp_raw");
    expect(bad).toContain("repo untested");
  });
});

describe("the SOCKS proxy the sandbox exposes", () => {
  it("is probed for the listener, the app stand-in at two names, and the internet", () => {
    expect(NETWORK_PROBES).toMatchObject({ listener_socks: "listener", decoy_socks: "decoy", decoy_socks_127: "decoy" });
    expect(expectedProbeIds("linux")).toEqual(expect.arrayContaining(["listener_socks", "decoy_socks", "decoy_socks_127", "external_socks"]));
  });

  it("counts a decoy or internet hit through SOCKS as an escape", () => {
    const viaSocks = [hit({ server: "decoy", probe: "decoy_socks" }), hit({ server: "decoy", probe: "decoy_socks_127" })];
    const egress = fullLines("linux", "candidate", { external_socks: { ok: true, detail: "rc=0 http=200" } });
    const verdict = verdictOf(obsOf({ hits: [listenerHit, ...viaSocks], lines: egress }));
    expect(verdict.routeA).toBe("fail");
    expect(verdict.networkEscapes).toEqual(["decoy_socks", "decoy_socks_127", "external_socks"]);
  });

  it("records the listener reached through SOCKS, which is neither an escape nor required for Route A", () => {
    const viaSocks = hit({ probe: "listener_socks" });
    const both = verdictOf(obsOf({ hits: [listenerHit, viaSocks] }));
    expect(both).toMatchObject({ routeA: "pass", networkEscapes: [], listenerPath: ["listener_proxy_localhost", "listener_socks"] });
    // Without the proxied path at localhost the SOCKS path alone does not make a pass.
    expect(verdictOf(obsOf({ hits: [viaSocks] }))).toMatchObject({ routeA: "fail", listenerReached: false });
  });

  it("an untested SOCKS probe leaves Route A inconclusive, like any other network probe", () => {
    const skipped = fullLines("linux", "candidate", {
      listener_socks: { detail: "skipped: no SOCKS proxy in the environment" },
      decoy_socks: { detail: "skipped: no SOCKS proxy in the environment" },
      decoy_socks_127: { detail: "skipped: no SOCKS proxy in the environment" },
      external_socks: { detail: "skipped: no SOCKS proxy in the environment" },
    });
    const verdict = verdictOf(obsOf({ lines: skipped }));
    expect(verdict.routeA).toBe("inconclusive");
    expect(verdict.untestedNetwork).toEqual(["listener_socks", "decoy_socks", "decoy_socks_127", "external_socks"]);
  });
});

describe("the positive control the run itself must hold", () => {
  it("is satisfied only by a valid control that reached every direct target", () => {
    expect(CONTROL_TARGETS).toEqual(
      expect.arrayContaining(["listener_direct_localhost", "listener_direct_127", "decoy_direct_localhost", "decoy_direct_lan", "tcp_raw", "unix_socket", "unix_socket_writable"]),
    );
    expect(controlProblems(GOOD_CONTROL)).toEqual([]);
    expect(assessRun({ control: GOOD_CONTROL, strayHits: [] })).toEqual([]);
  });

  it("is not satisfied without a control arm, with an invalid one, or one that missed a target", () => {
    expect(controlProblems(null)).toEqual(["the run has no control arm"]);
    expect(controlProblems({ ...GOOD_CONTROL, valid: false })).toEqual(["the control arm was not valid"]);
    const missing = controlHits.filter((h) => h.probe !== "unix_socket" && h.probe !== "decoy_direct_lan");
    expect(controlProblems({ valid: true, obs: controlObs(missing, false) })).toEqual(["the control did not reach: decoy_direct_lan, unix_socket, external_direct"]);
  });

  it("makes every sandboxed arm's Route A inconclusive when it fails, yet never hides an escape", () => {
    const problems = controlProblems(null);
    expect(verdictOf(obsOf(), true, problems).routeA).toBe("inconclusive");
    expect(verdictOf(obsOf(), true, assessRun({ control: GOOD_CONTROL, strayHits: [] })).routeA).toBe("pass");
    const escape = hit({ server: "decoy", probe: "decoy_proxy_no_origin" });
    expect(verdictOf(obsOf({ hits: [listenerHit, escape] }), true, problems).routeA).toBe("fail");
  });
});

describe("a refused read or write counts only where the control reached the same probe (#246)", () => {
  const reads = ["read_data_canary", "read_browser_canary", "read_repo_file", "read_env_canary", "read_process_env"];
  /** An arm's lines where every read and write is refused, and the control's where the given reads found their canary. */
  const sandboxedObs = () => obsOf();
  const controlReaching = (reached: string[]) =>
    observe({
      arm: "control",
      os: "linux",
      lines: fullLines("linux", "control", Object.fromEntries(reached.map((id) => [id, { ok: true, detail: `sha256=${HASH}` }]))),
      hits: controlHits,
      armWindow: WINDOW,
      planted: PLANTED,
      writesFound: Object.fromEntries(reached.filter((id) => id.startsWith("write_")).map((id) => [id, true])),
    });

  it("gates every read and write but the run's own folder, and no network probe", () => {
    expect(CONTROL_GATED_PROBES).toEqual(expect.arrayContaining([...reads, "write_repo", "write_data", "write_home", "write_tmpdir", "write_tmp", "write_other_carousel"]));
    expect(CONTROL_GATED_PROBES).not.toContain("write_work");
    expect(CONTROL_GATED_PROBES.some((probe) => probe in NETWORK_PROBES || probe.startsWith("external_") || probe === "dns_lookup")).toBe(false);
  });

  it("keeps a refusal when the control reached the probe, and makes it untested when it did not", () => {
    const control = controlReaching(["read_data_canary", "read_repo_file", "write_repo"]);
    const gated = gateOnControl(sandboxedObs(), control);
    for (const probe of ["read_data_canary", "read_repo_file", "write_repo"]) expect(outcomeOf(gated, probe), probe).toBe("refused");
    for (const probe of ["read_browser_canary", "read_env_canary", "read_process_env", "write_data", "write_home", "write_tmpdir", "write_tmp", "write_other_carousel"]) {
      expect(outcomeOf(gated, probe), probe).toBe("untested");
    }
    expect(untestedProbes(gated)).toEqual(expect.arrayContaining(["read_process_env", "write_data"]));
    expect(gated.find((o) => o.probe === "read_process_env")?.evidence).toMatch(/the control did not reach this probe in the same run, so its refusal proves nothing/);
    // Nothing else changes: the network probes and the own-folder write keep their outcomes.
    const plain = sandboxedObs();
    for (const probe of [...Object.keys(NETWORK_PROBES), "write_work", "dns_lookup"]) expect(outcomeOf(gated, probe), probe).toBe(outcomeOf(plain, probe));
  });

  it("makes every refusal untested without a control, and never hides a read or write that went through", () => {
    const withoutControl = gateOnControl(sandboxedObs(), null);
    for (const probe of CONTROL_GATED_PROBES.filter((p) => expectedProbeIds("linux").includes(p))) expect(outcomeOf(withoutControl, probe), probe).toBe("untested");
    const escape = obsOf({ lines: fullLines("linux", "candidate", { read_data_canary: { ok: true, detail: `sha256=${HASH}` } }) });
    expect(outcomeOf(escape, "read_data_canary")).toBe("reached");
    expect(containmentFindings(gateOnControl(escape, null))).toEqual(["read_data_canary"]);
    expect(containmentFindings(gateOnControl(escape, controlReaching([])))).toEqual(["read_data_canary"]);
  });
});

describe("the environment a run records", () => {
  const probes = (over: Partial<EnvironmentProbes> = {}): EnvironmentProbes => ({
    run: (command, args) =>
      (
        ({
          "npm root -g": "/synthetic/npm-root\n",
          "bwrap --version": "bubblewrap 0.8.0\n",
          "socat -V": "socat by Gerhard Rieger\nsocat version 1.7.4.4 on Jan  1 2025\n",
          "sw_vers -productVersion": "27.2\n",
        }) as Record<string, string>
      )[`${command} ${args.join(" ")}`] ?? null,
    readText: (file) => (file === "/etc/os-release" ? 'NAME="Synthetic Linux"\nPRETTY_NAME="Synthetic Linux 12 (test)"\nID=synthetic\n' : null),
    exists: (file) => file === "/synthetic/npm-root/@anthropic-ai/sandbox-runtime",
    ...over,
  });

  it("on Linux, names the distribution, the versions of bwrap and socat, and whether the vendor package is installed", () => {
    expect(collectEnvironment("linux", probes(), undefined)).toEqual({
      osPrettyName: "Synthetic Linux 12 (test)",
      macosVersion: null,
      bwrapVersion: "bubblewrap 0.8.0",
      socatVersion: "1.7.4.4",
      sandboxRuntimeInstalled: true,
    });
  });

  it("on macOS, records the product version only", () => {
    expect(collectEnvironment("darwin", probes(), undefined)).toEqual({
      osPrettyName: null,
      macosVersion: "27.2",
      bwrapVersion: null,
      socatVersion: null,
      sandboxRuntimeInstalled: true,
    });
  });

  it("records null, never an error, when a command or file fails, and false when the package is absent", () => {
    const none = probes({ run: () => null, readText: () => null, exists: () => false });
    expect(collectEnvironment("linux", none, undefined)).toEqual({ osPrettyName: null, macosVersion: null, bwrapVersion: null, socatVersion: null, sandboxRuntimeInstalled: false });
    expect(collectEnvironment("darwin", none, undefined).macosVersion).toBeNull();
  });

  it("also looks in the global module folder named by the npm prefix", () => {
    const viaPrefix = probes({ run: () => null, exists: (file) => file === "/synthetic/prefix/lib/node_modules/@anthropic-ai/sandbox-runtime" });
    expect(collectEnvironment("linux", viaPrefix, "/synthetic/prefix").sandboxRuntimeInstalled).toBe(true);
  });
});

describe("the probe script", () => {
  const file = path.join(__dirname, "../eval/sandbox-route/probe.sh");
  const script = readFileSync(file, "utf8");

  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", file])).not.toThrow();
  });

  it("names every id the judge expects, so the two cannot drift apart", () => {
    for (const id of expectedProbeIds("darwin")) expect(script, id).toContain(id);
  });

  it("marks a probe that cannot apply as skipped and scans other processes for the app canary only, skipping itself", () => {
    expect(script).toContain('emit "$id" false "skipped: $why"');
    expect(script).toContain("CREATORBRIO_PROOF_SHELL_CANARY");
    expect(script).toContain("[ \"$pid\" = \"$$\" ] && continue");
    expect(script).toContain("$1 != self");
  });

  it("sends the two direct decoy probes straight out, past the proxy variables", () => {
    for (const id of ["decoy_direct_localhost", "decoy_direct_lan"]) {
      const line = script.split("\n").find((l) => l.startsWith(`http ${id} `));
      expect(line, id).toContain("--noproxy '*'");
    }
  });

  // The functions and the SOCKS choice are run from the script's own text, so the
  // test exercises what the probe runs; nothing here touches the network.
  const functionText = (name: string) => script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0] ?? "";
  const socksBlock = script.match(/^socks=""\nfor v in [\s\S]*?^done$/m)?.[0] ?? "";
  const chooseSocks = (env: Record<string, string>) =>
    execFileSync("bash", ["-c", `${socksBlock}\nprintf %s "$socks"`], { env: { ...process.env, ALL_PROXY: undefined, all_proxy: undefined, FTP_PROXY: undefined, ftp_proxy: undefined, ...env }, encoding: "utf8" });

  it("takes the SOCKS proxy from the first variable holding a SOCKS address, since ALL_PROXY is the HTTP proxy when one exists", () => {
    expect(socksBlock).not.toBe("");
    expect(chooseSocks({ ALL_PROXY: "http://c@127.0.0.1:1", FTP_PROXY: "socks5h://c@127.0.0.1:2" })).toBe("socks5h://c@127.0.0.1:2");
    expect(chooseSocks({ ALL_PROXY: "socks5://c@127.0.0.1:3", FTP_PROXY: "socks5h://c@127.0.0.1:2" })).toBe("socks5://c@127.0.0.1:3");
    expect(chooseSocks({ ftp_proxy: "socks4a://c@127.0.0.1:4" })).toBe("socks4a://c@127.0.0.1:4");
    expect(chooseSocks({ ALL_PROXY: "http://c@127.0.0.1:1", HTTP_PROXY: "http://c@127.0.0.1:1" })).toBe("");
    expect(chooseSocks({})).toBe("");
  });

  it("probes through that SOCKS address with the proxy exceptions cleared, and skips every SOCKS probe when there is none", () => {
    for (const id of ["listener_socks", "decoy_socks", "decoy_socks_127"]) {
      expect(script.split("\n").find((l) => l.trim().startsWith(`http ${id} `)), id).toContain(`--proxy "$socks" --noproxy ''`);
    }
    expect(script).toContain(`http external_socks "$external" --proxy "$socks" --noproxy ''`);
    // The external target defaults to example.com over HTTPS; the proof may replace it per host and records it.
    expect(script).toContain('external="${EXTERNAL_URL:-https://example.com/}"');
    expect(script).toContain('skip_all "no SOCKS proxy in the environment" listener_socks decoy_socks decoy_socks_127');
    expect(script).toContain('skip_all "no SOCKS proxy in the environment" external_socks');
  });

  it("never prints a proxy credential: the address, the FTP_PROXY line and curl's own errors are redacted", () => {
    const out = execFileSync("bash", ["-c", `${functionText("redact")}\nredact "socks5h://cred:tok@127.0.0.1:9"`], { encoding: "utf8" }).trim();
    expect(out).toBe("socks5h://<credential>@127.0.0.1:9");
    expect(script).toContain('FTP_PROXY=$(redact "${FTP_PROXY:-}")');
    expect(script).toContain('err=$(redact "$(head -c 160');
  });

  it("reports every environment variable name, in as many lines as it takes, and none cut", () => {
    const names = Array.from({ length: 150 }, (_, i) => `SYNTHETIC_VARIABLE_NAME_${i}`);
    const run = (input: string) =>
      parseProbeLines(execFileSync("bash", ["-c", `out=/dev/null\n${functionText("emit")}\n${functionText("emit_names")}\nemit_names env_names`], { input, encoding: "utf8" }));
    const lines = run(`${names.join("\n")}\n`);
    const chunks = lines.filter((l) => /^env_names_\d+$/.test(l.id));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((l) => l.detail.trim().split(" "))).toEqual(names);
    expect(lines.at(-1)).toEqual({ id: "env_names", ok: true, detail: `count=150 lines=${chunks.length}` });
    expect(run("")).toEqual([{ id: "env_names", ok: true, detail: "count=0 lines=0" }]);
    expect(script).toContain("| emit_names env_names");
    expect(script).toContain("| emit_names env_sensitive");
  });
});

describe("external probes over plain HTTP", () => {
  it("count only the destination's success or redirect as reached, and the sandbox proxy's own refusal as refused", async () => {
    const { externalOutcome, SANDBOX_PROXY_REFUSAL } = await import("../eval/sandbox-route/proof");
    expect(externalOutcome({ ok: true, detail: "rc=0 http=200 body=<!doctype html>" })).toBe("reached");
    expect(externalOutcome({ ok: true, detail: "rc=0 http=301 body=" })).toBe("reached");
    expect(externalOutcome({ ok: true, detail: `rc=0 http=403 body=${SANDBOX_PROXY_REFUSAL}` })).toBe("refused");
    // Any other error status could be the destination or anything between: never refused.
    expect(externalOutcome({ ok: true, detail: "rc=0 http=403 body=Forbidden" })).toBe("untested");
    expect(externalOutcome({ ok: true, detail: "rc=0 http=502 body=" })).toBe("untested");
    expect(externalOutcome({ ok: false, detail: "rc=6 http=000 err=curl: (6) Could not resolve host" })).toBe("refused");
  });
});
