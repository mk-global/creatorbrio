/**
 * Whether the contained Design Agent can run on this computer (#227, #246).
 *
 * macOS is its first activation platform (#246). Linux is unsupported while
 * the CLI's sandbox leaves the shared temporary folders writable there; with
 * Claude Code's sandbox prerequisites (bubblewrap and socat) it still runs, as
 * the stand-in checks need, and the doctor says it is unsupported. Native
 * Windows and WSL2 are reported unavailable.
 *
 * It also needs this server to own the data folder and the agent folders
 * (`src/lib/contained-server.ts`), the contained CLI's own sign-in token
 * (`src/lib/agent-sign-in.ts`) and, when one is set, a valid model API
 * address for it (`containedModelApiAddress`); without any of them it is
 * unavailable, with what to do.
 *
 * The CLI version is checked once per CLI path: one older than the sandbox's
 * `strictAllowlist` is refused, and one other than the tested version runs
 * with a warning. The CLI itself refuses to start without a working sandbox
 * (`failIfUnavailable`).
 */
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import { agentSignIn } from "@/lib/agent-sign-in";
import { agentWorkspaceRoot, serverTempRoot } from "@/lib/agent-workspace";
import { containedServerStatus } from "@/lib/contained-server";
import { CONTAINED_PROFILE, compareCliVersions, containedModelApiAddress } from "@/lib/design-agent-profile";

export type Availability =
  | { available: true; cliVersion: string; versionWarning: string | null }
  | { available: false; reason: string; guidance: string };

interface HostFacts {
  platform: NodeJS.Platform;
  /** The kernel release on Linux, which names Microsoft under WSL. */
  kernelRelease: string | null;
  /** Whether a program is on PATH. */
  has: (program: string) => boolean;
}

export function hostFacts(env: Record<string, string | undefined> = process.env): HostFacts {
  let kernelRelease: string | null = null;
  if (process.platform === "linux") {
    try {
      kernelRelease = readFileSync("/proc/sys/kernel/osrelease", "utf8").trim();
    } catch {
      kernelRelease = null;
    }
  }
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return {
    platform: process.platform,
    kernelRelease,
    has: (program) =>
      dirs.some((dir) => {
        try {
          accessSync(path.join(dir, program), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
  };
}

/** The platform half of the check: no process is started. */
export function platformAvailability(facts: HostFacts): { ok: true } | { ok: false; reason: string; guidance: string } {
  if (facts.platform === "darwin") return { ok: true };
  if (facts.platform === "win32") {
    return {
      ok: false,
      reason: "The contained Design Agent is not available on Windows.",
      guidance: "Run CreatorBrio on macOS, the contained Design Agent's first activation platform.",
    };
  }
  if (facts.platform === "linux") {
    if (facts.kernelRelease && /microsoft|wsl/i.test(facts.kernelRelease)) {
      return {
        ok: false,
        reason: "The contained Design Agent has not been tested on WSL2.",
        guidance: "Run CreatorBrio on macOS, the contained Design Agent's first activation platform.",
      };
    }
    const missing = ["bwrap", "socat"].filter((p) => !facts.has(p));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Claude Code's sandbox needs ${missing.map((p) => (p === "bwrap" ? "bubblewrap" : p)).join(" and ")}, which ${missing.length > 1 ? "are" : "is"} not installed.`,
        guidance: "Install them (for example `sudo apt install bubblewrap socat`), then restart CreatorBrio and run `npm run doctor`.",
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    reason: `The contained Design Agent is not available on ${facts.platform}.`,
    guidance: "Run CreatorBrio on macOS, the contained Design Agent's first activation platform.",
  };
}

/** The version half: refuse a CLI older than the floor, warn about any but the qualified one. */
export function versionAvailability(cliVersion: string | null): Availability {
  if (!cliVersion) {
    return { available: false, reason: "Claude Code's version could not be read.", guidance: "Check that Claude Code runs in a terminal, then run `npm run doctor`." };
  }
  const floor = compareCliVersions(cliVersion, CONTAINED_PROFILE.minimumCliVersion);
  if (floor === null || floor < 0) {
    return {
      available: false,
      reason: `Claude Code ${cliVersion} is older than ${CONTAINED_PROFILE.minimumCliVersion}, the first version with the sandbox setting the Design Agent needs.`,
      guidance: `Install Claude Code ${CONTAINED_PROFILE.qualifiedCliVersion} and point CLAUDE_CLI_PATH at it.`,
    };
  }
  const warning = cliVersion === CONTAINED_PROFILE.qualifiedCliVersion
    ? null
    : `Claude Code ${cliVersion} has not been tested with the contained Design Agent; ${CONTAINED_PROFILE.qualifiedCliVersion} has. Its sandbox may behave differently.`;
  return { available: true, cliVersion, versionWarning: warning };
}

const VERSION_KEY = Symbol.for("creatorbrio.claudeCliVersions");

/** The CLI's version, read once per path and process (`claude --version`). */
export function cliVersion(claudePath: string): Promise<string | null> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<string | null>> | undefined>;
  const cache = (g[VERSION_KEY] ??= new Map());
  let pending = cache.get(claudePath);
  if (!pending) {
    pending = new Promise((resolve) => {
      execFile(claudePath, ["--version"], { timeout: 15_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv, encoding: "utf8" }, (err: Error | null, stdout: string) => {
        const match = err ? null : /^(\d+\.\d+\.\d+)\b/.exec(stdout.trim());
        resolve(match ? match[1] : null);
      });
    });
    cache.set(claudePath, pending);
    // A failed read is retried on the next request rather than remembered.
    void pending.then((v: string | null) => v === null && cache.delete(claudePath));
  }
  return pending;
}

/** Whether the contained CLI has a usable sign-in token of its own, without keeping it (#246). */
export async function signInAvailability(env: Record<string, string | undefined> = process.env): Promise<{ ok: true } | { ok: false; reason: string; guidance: string }> {
  let workspaceRoot: string | null;
  try {
    workspaceRoot = agentWorkspaceRoot(env);
  } catch {
    // An unusable agent folder setting is reported by the launch.
    workspaceRoot = null;
  }
  const repoDir = process.cwd();
  const signIn = await agentSignIn({ env, repoDir, dataDir: path.join(repoDir, "data"), workspaceRoot, tempRoot: serverTempRoot() });
  return signIn.ok ? { ok: true } : signIn;
}

/** Whether the contained CLI's model API setting, when there is one, is usable: the same refusal a launch would give. */
export async function modelApiAvailability(env: Record<string, string | undefined> = process.env): Promise<{ ok: true } | { ok: false; reason: string; guidance: string }> {
  const address = containedModelApiAddress(env);
  return address.ok ? { ok: true } : address;
}

/** What the availability check asks besides the platform and the CLI's version; replaced in tests. */
export interface AvailabilityChecks {
  server: () => Promise<{ ok: true } | { ok: false; reason: string; guidance: string }>;
  signIn: () => Promise<{ ok: true } | { ok: false; reason: string; guidance: string }>;
  modelApi: () => Promise<{ ok: true } | { ok: false; reason: string; guidance: string }>;
}

const DEFAULT_CHECKS: AvailabilityChecks = { server: containedServerStatus, signIn: () => signInAvailability(), modelApi: () => modelApiAvailability() };

/** The platform, then this server's ownership of its folders, then the sign-in token, then the model API setting, then the CLI's version: the first that fails is the answer. */
export async function containedAvailability(claudePath: string, facts: HostFacts = hostFacts(), checks: AvailabilityChecks = DEFAULT_CHECKS): Promise<Availability> {
  const host = platformAvailability(facts);
  if (!host.ok) return { available: false, reason: host.reason, guidance: host.guidance };
  for (const check of [checks.server, checks.signIn, checks.modelApi]) {
    const result = await check();
    if (!result.ok) return { available: false, reason: result.reason, guidance: result.guidance };
  }
  return versionAvailability(await cliVersion(claudePath));
}
