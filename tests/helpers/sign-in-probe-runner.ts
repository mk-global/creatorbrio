/**
 * The only way a test runs the qualification's sign-in probe (#246).
 *
 * The probe lists the environments of processes: of its own ancestors, and of
 * every process it can see. Run as it is written, on a computer it reads
 * whatever processes are really there, and a test has no business with those.
 * So no run here touches this computer's processes. Each one has
 *
 * - a PATH that holds one folder and nothing else: a stand-in `ps`, which
 *   answers from a fixed table of made-up processes and writes down every
 *   call it gets, and links to the few utilities the probe needs. A lookup by
 *   name can reach no other `ps`, whatever the shell does or however late it
 *   asks. The shell itself is started by its absolute path, since the child's
 *   PATH holds no shell;
 * - a synthetic folder in place of `/proc` (absent, as on macOS, or filled
 *   from the same table, as on Linux), put in by rewriting the probe's text;
 * - an environment of exactly three synthetic variables, so what the probe
 *   reads of its own environment is made up too.
 *
 * The shell runs as the leader of its own process group. When it does not
 * finish in time, the whole group is killed, and the folder holding the
 * stand-ins stays in place until the group is gone, so that no subshell that
 * outlived the shell can find anything of the real system. Were the group to
 * outlive a bounded wait, the folder is left where it is and the run fails.
 *
 * The one real process id in the table is this test process's own, which is the
 * shell's parent, so the probe's walk up its ancestors starts in the table.
 * Nothing real is read for it: the stand-in answers from the table.
 *
 * Canaries make this checkable rather than assumed. Every run fails if the
 * shell does not resolve `ps` to the stand-in, if its PATH is anything but the
 * run's own folder, if the probe's text still names the real `/proc` or names
 * `ps` by a path, if the stand-in was never called, or if it was asked about a
 * process outside its table.
 *
 * Nothing but this file may build the probe's text in a test; a test in
 * `tests/containment-stand-in.test.ts` keeps it that way.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signInFindings, signInProbe } from "../../eval/sandbox-route/qualify";

/** The synthetic token the stand-in world holds, in the form the probe looks for. */
export const PROBE_TOKEN = "CBQS_0123456789abcdef";
const TOKEN_VALUE = `sk-ant-oat01-${PROBE_TOKEN}`;

/** How long a probe may run before its process group is killed. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** How long the killed group may take to be gone before the run gives up and leaves its folder in place. */
const GROUP_GONE_MS = 10_000;

/**
 * The utilities the probe and the stand-in `ps` call by name. They are the only
 * commands besides the stand-in on the shell's PATH, each a link to the one
 * found on this computer's PATH. The shell's own commands need no link.
 */
export const PROBE_TOOLS = ["cat", "dirname", "env", "grep", "ls", "sed", "sort", "tr"] as const;

export type ProcessShape = "ps" | "proc";

interface StandInProcess {
  pid: number;
  ppid: number;
  env: string[];
  /** Whether a system-wide listing shows it (the ancestors are reached by walking up, not by listing). */
  listed: boolean;
}

// Ids no system uses: the largest process id a system hands out is far below these.
const GRANDPARENT_PID = 7_777_770;

/** The fixed table. The first entry is this process, the probe shell's parent. */
function table(): StandInProcess[] {
  return [
    { pid: process.pid, ppid: GRANDPARENT_PID, env: ["PARENT=1", `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_VALUE}`, "ANTHROPIC_BASE_URL=http://127.0.0.1:1"], listed: false },
    { pid: GRANDPARENT_PID, ppid: 1, env: ["GRANDPARENT=1"], listed: false },
    { pid: 7_777_771, ppid: 1, env: ["OTHER=baz"], listed: true },
    { pid: 7_777_772, ppid: 1, env: ["WORKER=bar", `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_VALUE}`], listed: true },
  ];
}

const STAND_IN_PS = `#!/bin/sh
# A stand-in for ps (#246): answers from the files beside it, writes every call down, reads nothing real.
here=$(dirname "$0")
printf '%s\\n' "$*" >> "$here/calls.log"
args="$*"
last=\${args##* }
case "$args" in
  "-A -o pid=") cat "$here/listed" 2>/dev/null ;;
  "eww -o command= -p "*) cat "$here/env-$last" 2>/dev/null ;;
  "-o ppid= -p "*) cat "$here/ppid-$last" 2>/dev/null ;;
esac
exit 0
`;

/** The probe's text for a token file, for a test that only inspects the text. It must never be run except through `runSignInProbe`. */
export function probeTextFor(tokenFile: string): string {
  return signInProbe(tokenFile);
}

/** The text with its `/proc` replaced by a folder of the run's own. */
function withProcessRoot(probe: string, root: string): string {
  return probe.replaceAll("/proc", root);
}

/** The file a command name is found at on this computer's PATH: where a link for it points. */
function foundOnThisPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; the next folder on the PATH.
    }
  }
  throw new Error(`the sign-in probe's runner needs ${name}, which is not on this computer's PATH`);
}

// The canaries. Each throws, so a run that breaks one fails whatever the test asserts.

export function assertNoRealProc(text: string): void {
  if (text.includes("/proc")) throw new Error("the sign-in probe's text still names the real /proc");
}

/** A `ps` named by a path (`/bin/ps`, `./ps`) is not looked up on the PATH, so no stand-in would answer it. */
export function assertNoPathQualifiedPs(text: string): void {
  if (/\/ps(?![\w./-])/.test(text)) throw new Error("the sign-in probe's text names ps by a path");
}

export function assertSyntheticEnv(env: Record<string, string>, dir: string): void {
  const names = Object.keys(env).sort();
  if (names.join(",") !== "CLAUDE_CODE_OAUTH_TOKEN,HOME,PATH") throw new Error(`the sign-in probe's shell would get an environment other than the three synthetic variables: ${names.join(",")}`);
  if (env.CLAUDE_CODE_OAUTH_TOKEN !== TOKEN_VALUE) throw new Error("the sign-in probe's shell would get a token other than the synthetic one");
  if (!env.HOME.startsWith(dir)) throw new Error("the sign-in probe's shell would get a home outside its own folder");
  if (env.PATH !== path.join(dir, "bin")) throw new Error("the sign-in probe's shell would get a PATH other than the run's own folder of stand-ins and links");
}

/** The shell must resolve `ps` to the stand-in: otherwise the probe would run the real one. */
export function assertStandInPs(shell: string, shellArgs: readonly string[], env: Record<string, string>, bin: string): void {
  const run = spawnSync(shell, [...shellArgs, "-c", "command -v ps"], { encoding: "utf8", env: env as unknown as NodeJS.ProcessEnv, timeout: 10_000 });
  if ((run.stdout ?? "").trim() !== path.join(bin, "ps")) throw new Error(`${shell} does not resolve ps to the stand-in`);
}

/** The stand-in must have been called, and only about its own table. */
export function assertOnlyTableCalls(calls: readonly string[], pids: readonly number[]): void {
  if (calls.length === 0) throw new Error("the stand-in ps was never called, so the probe did not run against it");
  const known = new Set(pids.map(String));
  for (const call of calls) {
    const asked = /^(?:eww -o command= -p|-o ppid= -p) (\d+)$/.exec(call);
    if (call === "-A -o pid=") continue;
    if (!asked) throw new Error(`the stand-in ps got a call it does not know: ${call}`);
    if (!known.has(asked[1])) throw new Error(`the stand-in ps was asked about a process outside its table: ${asked[1]}`);
  }
}

/** Sends a signal to a whole process group. False when no such group exists any more. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    // A group this process may not signal still exists.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Kills the group and waits until it is gone: no member is left, not even one not yet collected. False when it outlived the wait. */
async function endGroup(pgid: number): Promise<boolean> {
  signalGroup(pgid, "SIGKILL");
  const deadline = Date.now() + GROUP_GONE_MS;
  while (signalGroup(pgid, 0)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** Runs the shell as the leader of its own process group, and kills the whole group when it has not finished by the deadline. */
function runShell(shell: string, args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<{ output: string; timedOut: boolean; pgid: number | undefined }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args], { env: env as unknown as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let timedOut = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ output, timedOut, pgid: child.pid });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
      // The output pipe closes with the group; if it does not, the run still ends.
      setTimeout(finish, 5_000).unref();
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (output += chunk));
    child.on("error", (error) => {
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", finish);
  });
}

export interface SignInProbeRun {
  /** What the probe printed. */
  output: string;
  /** The planted token's findings, as the qualification reads them (`token in ancestors`, and so on). */
  found: string[];
  /** The stand-in ps's calls, in order. */
  psCalls: string[];
  /** The probe's text as it ran, with its `/proc` rewritten. */
  ran: string;
}

/**
 * Runs the sign-in probe under a shell on the stand-in world.
 *
 * `shape` is the system the probe sees: `ps`, where processes' environments
 * come from `ps eww` and there is no `/proc` (macOS), or `proc`, where they
 * come from a `/proc` of the run's own and the stand-in `ps` says nothing
 * (Linux). `transform` changes the text before it runs, to show what an earlier
 * form of the probe would have done. A probe that has not finished after
 * `timeoutMs` is a failed run, after its whole process group is gone.
 */
export async function runSignInProbe(input: {
  shell: string;
  /** Options given to the shell before `-c`, for example `["-O", "failglob"]`. */
  shellArgs?: readonly string[];
  shape: ProcessShape;
  /** Whether the token file the probe reads holds the synthetic token. */
  tokenFile?: "present" | "absent";
  transform?: (probe: string) => string;
  timeoutMs?: number;
}): Promise<SignInProbeRun> {
  const dir = mkdtempSync(path.join(tmpdir(), "cbq-sign-in-probe-"));
  let pgid: number | undefined;
  let outlived = false;
  try {
    if (dir.includes("/proc") || /[\s'"$`\\]/.test(dir)) throw new Error("the temporary folder's name cannot be used safely by the sign-in probe's runner");
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "ps"), STAND_IN_PS);
    chmodSync(path.join(bin, "ps"), 0o755);
    for (const tool of PROBE_TOOLS) symlinkSync(foundOnThisPath(tool), path.join(bin, tool));
    const world = table();
    const procRoot = path.join(dir, "root");
    if (input.shape === "ps") {
      // No process folder at all, as on macOS; every environment comes from the stand-in ps.
      writeFileSync(path.join(bin, "listed"), `${world.filter((p) => p.listed).map((p) => `  ${p.pid}`).join("\n")}\n`);
      for (const p of world) {
        writeFileSync(path.join(bin, `env-${p.pid}`), `stand-in ${p.env.join(" ")}\n`);
        writeFileSync(path.join(bin, `ppid-${p.pid}`), `  ${p.ppid}\n`);
      }
    } else {
      // A process folder filled from the table; the stand-in ps lists and says nothing, so only the folder can find the token.
      for (const p of world) {
        mkdirSync(path.join(procRoot, String(p.pid)), { recursive: true });
        writeFileSync(path.join(procRoot, String(p.pid), "environ"), `${p.env.join("\0")}\0`);
        writeFileSync(path.join(procRoot, String(p.pid), "status"), `Name:\tstand-in\nPPid:\t${p.ppid}\n`);
      }
    }
    const tokenFile = path.join(dir, "token");
    if (input.tokenFile === "present") writeFileSync(tokenFile, `${TOKEN_VALUE}\n`, { mode: 0o600 });
    const ran = withProcessRoot((input.transform ?? ((probe: string) => probe))(signInProbe(tokenFile)), procRoot);
    assertNoRealProc(ran);
    assertNoPathQualifiedPs(ran);
    // The child's PATH holds no shell, so the shell is named by where this computer's PATH finds it.
    const shell = foundOnThisPath(input.shell);
    const env = { PATH: bin, HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: TOKEN_VALUE };
    assertSyntheticEnv(env, dir);
    const shellArgs = input.shellArgs ?? [];
    assertStandInPs(shell, shellArgs, env, bin);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const run = await runShell(shell, [...shellArgs, "-c", ran], env, timeoutMs);
    pgid = run.pgid;
    if (run.timedOut) throw new Error(`the sign-in probe did not finish within ${timeoutMs} ms`);
    const calls = (() => {
      try {
        return readFileSync(path.join(bin, "calls.log"), "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    })();
    assertOnlyTableCalls(calls, world.map((p) => p.pid));
    return { output: run.output, found: signInFindings(run.output, { token: PROBE_TOKEN }), psCalls: calls, ran };
  } finally {
    // The stand-ins stay until no process of the run is left to look anything up.
    if (pgid !== undefined) outlived = !(await endGroup(pgid));
    if (!outlived) rmSync(dir, { recursive: true, force: true });
    // Left in place on purpose, and said so, since removing it would let a surviving process find the real system.
    else throw new Error(`a process of the sign-in probe outlived its kill, so its folder of stand-ins was left in place: ${dir}`);
  }
}
