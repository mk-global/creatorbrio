import path from "node:path";
import { describe, expect, it } from "vitest";
import { containedAvailability, platformAvailability, versionAvailability, type AvailabilityChecks } from "@/lib/design-agent-availability";

const host = (platform: NodeJS.Platform, programs: string[] = [], kernelRelease: string | null = null) => ({
  platform,
  kernelRelease,
  has: (program: string) => programs.includes(program),
});

describe("where the contained Design Agent may run", () => {
  it("runs on macOS", () => {
    expect(platformAvailability(host("darwin"))).toEqual({ ok: true });
  });

  it("runs on Linux only with bubblewrap and socat", () => {
    expect(platformAvailability(host("linux", ["bwrap", "socat"], "6.8.0-45-generic"))).toEqual({ ok: true });
    expect(platformAvailability(host("linux", ["socat"], "6.8.0"))).toMatchObject({ ok: false, reason: expect.stringMatching(/needs bubblewrap, which is not installed/) });
    expect(platformAvailability(host("linux", [], "6.8.0"))).toMatchObject({ ok: false, reason: expect.stringMatching(/bubblewrap and socat, which are not installed/) });
  });

  it("is not available on WSL2 or Windows, which have not been qualified", () => {
    expect(platformAvailability(host("linux", ["bwrap", "socat"], "5.15.153.1-microsoft-standard-WSL2"))).toMatchObject({ ok: false, reason: expect.stringMatching(/WSL2/) });
    expect(platformAvailability(host("win32"))).toMatchObject({ ok: false, reason: expect.stringMatching(/Windows/) });
    expect(platformAvailability(host("freebsd"))).toMatchObject({ ok: false });
  });
});

describe("which Claude Code versions it accepts", () => {
  it("accepts the qualified version without a warning", () => {
    expect(versionAvailability("2.1.328")).toEqual({ available: true, cliVersion: "2.1.328", versionWarning: null });
  });

  it("runs another version from the first with the sandbox setting, with a warning", () => {
    expect(versionAvailability("2.1.330")).toMatchObject({ available: true, versionWarning: expect.stringMatching(/2\.1\.330 has not been tested.*2\.1\.328 has/) });
    expect(versionAvailability("2.1.219")).toMatchObject({ available: true });
  });

  it("refuses an older version, and one whose version could not be read", () => {
    expect(versionAvailability("2.1.218")).toMatchObject({ available: false, reason: expect.stringMatching(/older than 2\.1\.219/) });
    expect(versionAvailability(null)).toMatchObject({ available: false });
    expect(versionAvailability("2.1.328-beta")).toMatchObject({ available: false });
  });
});

describe("what else it needs: this server's ownership of its folders and its own sign-in (#246)", () => {
  const ok = async () => ({ ok: true as const });
  const no = (reason: string) => async () => ({ ok: false as const, reason, guidance: `Fix ${reason}.` });
  // A path no CLI is at: reached only when every other check passes.
  const missingCli = "/nonexistent/claude-for-availability-tests";

  it("is unavailable while another server owns the folders, before anything else is asked", async () => {
    let asked = false;
    const checks: AvailabilityChecks = { server: no("owned elsewhere"), signIn: async () => ((asked = true), { ok: true }) };
    expect(await containedAvailability(missingCli, host("darwin"), checks)).toEqual({ available: false, reason: "owned elsewhere", guidance: "Fix owned elsewhere." });
    expect(asked).toBe(false);
  });

  it("is unavailable without a usable sign-in token, and only then asks the CLI's version", async () => {
    expect(await containedAvailability(missingCli, host("darwin"), { server: ok, signIn: no("no token") })).toEqual({ available: false, reason: "no token", guidance: "Fix no token." });
    expect(await containedAvailability(missingCli, host("darwin"), { server: ok, signIn: ok })).toMatchObject({ available: false, reason: expect.stringMatching(/version could not be read/) });
  });

  it("answers for the platform first", async () => {
    expect(await containedAvailability(missingCli, host("win32"), { server: no("x"), signIn: no("y") })).toMatchObject({ available: false, reason: expect.stringMatching(/Windows/) });
  });
});

describe("the doctor command", () => {
  it("checks the contained profile's own versions", async () => {
    const { readFile } = await import("node:fs/promises");
    const { CONTAINED_PROFILE } = await import("@/lib/design-agent-profile");
    const doctor = await readFile("scripts/doctor.mjs", "utf8");
    expect(doctor).toContain(`const QUALIFIED_CLI_VERSION = "${CONTAINED_PROFILE.qualifiedCliVersion}";`);
    expect(doctor).toContain(`const MINIMUM_CLI_VERSION = "${CONTAINED_PROFILE.minimumCliVersion}";`);
  });

  it("checks the contained Design Agent's own token file where the app reads it, without printing it (#246)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { AGENT_TOKEN_FILE_ENV, defaultAgentTokenFile } = await import("@/lib/agent-sign-in");
    const doctor = await readFile("scripts/doctor.mjs", "utf8");
    expect(defaultAgentTokenFile("/HOME")).toBe(path.join("/HOME", ".creatorbrio", "design-agent-token"));
    expect(doctor).toContain(`const TOKEN_FILE_SETTING = "${AGENT_TOKEN_FILE_ENV}";`);
    expect(doctor).toContain(`join(homedir(), ".creatorbrio", "design-agent-token")`);
  });

  it("reports the token file as present and private, not private, or absent, and never prints it (#246)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { chmod, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "cb-doctor-"));
    const token = "sk-ant-oat01-synthetic-doctor-value";
    const file = path.join(dir, "token");
    const signInLine = () => {
      let out = "";
      try {
        out = execFileSync(process.execPath, ["scripts/doctor.mjs"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, CREATORBRIO_DESIGN_AGENT_PROFILE: "contained", CREATORBRIO_DESIGN_AGENT_TOKEN_FILE: file } as unknown as NodeJS.ProcessEnv });
      } catch (err) {
        out = (err as { stdout: string }).stdout;
      }
      expect(out).not.toContain(token);
      return out.split("\n").find((line) => line.includes("Design Agent sign-in")) ?? "";
    };
    try {
      await writeFile(file, `${token}\n`, { mode: 0o600 });
      expect(signInLine()).toMatch(/✓.*present and private/);
      await chmod(file, 0o644);
      expect(signInLine()).toMatch(/✗.*not private.*chmod 600/);
      await rm(file);
      expect(signInLine()).toMatch(/✗.*no token file.*claude setup-token/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
