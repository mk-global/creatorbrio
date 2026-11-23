import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containedAvailability, modelApiAvailability, platformAvailability, versionAvailability, type AvailabilityChecks } from "@/lib/design-agent-availability";
import { AGENT_TOKEN_FILE_ENV } from "@/lib/agent-sign-in";
import { AGENT_WORKSPACES_ENV } from "@/lib/agent-workspace";
import { claimContainedServer, releaseContainedServer, resetContainedServerForTests } from "@/lib/contained-server";
import { MODEL_API_URL_ENV } from "@/lib/design-agent-profile";

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
    // Each refusal names macOS as the first activation platform, which it is, and not as qualified, which it is not yet.
    for (const facts of [host("win32"), host("freebsd"), host("linux", ["bwrap", "socat"], "5.15.153.1-microsoft-standard-WSL2")]) {
      expect(platformAvailability(facts)).toMatchObject({ ok: false, guidance: "Run CreatorBrio on macOS, the contained Design Agent's first activation platform." });
    }
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

describe("what else it needs: this server's ownership of its folders, its own sign-in and a valid model API setting (#246)", () => {
  const ok = async () => ({ ok: true as const });
  const no = (reason: string) => async () => ({ ok: false as const, reason, guidance: `Fix ${reason}.` });
  // A path no CLI is at: reached only when every other check passes.
  const missingCli = "/nonexistent/claude-for-availability-tests";

  it("is unavailable while another server owns the folders, before anything else is asked", async () => {
    let asked = false;
    const checks: AvailabilityChecks = { server: no("owned elsewhere"), signIn: async () => ((asked = true), { ok: true }), modelApi: async () => ((asked = true), { ok: true }) };
    expect(await containedAvailability(missingCli, host("darwin"), checks)).toEqual({ available: false, reason: "owned elsewhere", guidance: "Fix owned elsewhere." });
    expect(asked).toBe(false);
  });

  it("is unavailable without a usable sign-in token, and only then asks the CLI's version", async () => {
    expect(await containedAvailability(missingCli, host("darwin"), { server: ok, signIn: no("no token"), modelApi: ok })).toEqual({ available: false, reason: "no token", guidance: "Fix no token." });
    expect(await containedAvailability(missingCli, host("darwin"), { server: ok, signIn: ok, modelApi: ok })).toMatchObject({ available: false, reason: expect.stringMatching(/version could not be read/) });
  });

  it("is unavailable with an invalid model API setting, before the CLI's version is asked", async () => {
    expect(await containedAvailability(missingCli, host("darwin"), { server: ok, signIn: ok, modelApi: no("bad address") })).toEqual({ available: false, reason: "bad address", guidance: "Fix bad address." });
  });

  it("judges the model API setting as a launch would: unset or valid is usable, anything else is refused without echoing it", async () => {
    expect(await modelApiAvailability({})).toEqual({ ok: true });
    expect(await modelApiAvailability({ [MODEL_API_URL_ENV]: "https://models.example.test" })).toEqual({ ok: true });
    const refused = await modelApiAvailability({ [MODEL_API_URL_ENV]: "http://user:synthetic-pass@models.example.test" });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining(MODEL_API_URL_ENV) });
    expect(JSON.stringify(refused)).not.toContain("synthetic-pass");
    expect(JSON.stringify(refused)).not.toContain("models.example.test");
  });

  it("answers for the platform first", async () => {
    expect(await containedAvailability(missingCli, host("win32"), { server: no("x"), signIn: no("y"), modelApi: no("z") })).toMatchObject({ available: false, reason: expect.stringMatching(/Windows/) });
  });
});

describe("the default checks, unmocked: ownership, token and address as Home, Settings and the chat ask them (#246)", () => {
  const SETTINGS = [AGENT_TOKEN_FILE_ENV, AGENT_WORKSPACES_ENV, MODEL_API_URL_ENV];
  const SIGN_IN_TOKEN = "sk-ant-oat01-synthetic-availability-value";
  const saved = new Map<string, string | undefined>();
  let base = "";
  let tokenFile = "";
  let stub = "";

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), "cb-availability-")));
    for (const name of SETTINGS) saved.set(name, process.env[name]);
    await mkdir(path.join(base, "agents"));
    await mkdir(path.join(base, "repo", "data"), { recursive: true });
    await mkdir(path.join(base, "secrets"));
    tokenFile = path.join(base, "secrets", "design-agent-token");
    await writeFile(tokenFile, `${SIGN_IN_TOKEN}\n`, { mode: 0o600 });
    // A stub that answers its version: the installed CLI is never started.
    stub = path.join(base, "claude-stub");
    await writeFile(stub, "#!/bin/sh\necho 2.1.328\n", { mode: 0o755 });
    process.env[AGENT_TOKEN_FILE_ENV] = tokenFile;
    process.env[AGENT_WORKSPACES_ENV] = path.join(base, "agents");
    delete process.env[MODEL_API_URL_ENV];
    resetContainedServerForTests();
  });

  afterEach(async () => {
    releaseContainedServer();
    resetContainedServerForTests();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(base, { recursive: true, force: true });
  });

  /** As the server takes charge of its folders when it starts. */
  const start = () => claimContainedServer({ dataDir: path.join(base, "repo", "data"), repoDir: path.join(base, "repo"), settleMs: 10 });
  /** The check Home, Settings and the chat make: no checks passed in, so the defaults run. */
  const ask = () => containedAvailability(stub, host("darwin"));

  it("is unavailable until this server has taken charge of its folders, and available once it has and everything else is in order", async () => {
    expect(await ask()).toMatchObject({ available: false, reason: expect.stringMatching(/did not take charge of the contained Design Agent's folders/) });
    expect(await start()).toEqual({ owned: true });
    expect(await ask()).toEqual({ available: true, cliVersion: "2.1.328", versionWarning: null });
  });

  it("is unavailable without a usable token file, and never returns the token", async () => {
    expect(await start()).toEqual({ owned: true });
    await rm(tokenFile);
    expect(await ask()).toMatchObject({ available: false, reason: "The contained Design Agent has no sign-in token of its own.", guidance: expect.stringContaining("claude setup-token") });
    await writeFile(tokenFile, `${SIGN_IN_TOKEN}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o644);
    const refused = await ask();
    expect(refused).toMatchObject({ available: false, reason: expect.stringMatching(/can be read or changed by other accounts/) });
    expect(JSON.stringify(refused)).not.toContain(SIGN_IN_TOKEN);
  });

  it("is unavailable with an invalid model API setting, naming the setting and never its value", async () => {
    expect(await start()).toEqual({ owned: true });
    process.env[MODEL_API_URL_ENV] = "http://user:synthetic-pass@models.example.test";
    const refused = await ask();
    expect(refused).toMatchObject({ available: false, reason: expect.stringContaining(MODEL_API_URL_ENV) });
    expect(JSON.stringify(refused)).not.toMatch(/synthetic-pass|models\.example\.test/);
    process.env[MODEL_API_URL_ENV] = "https://models.example.test";
    expect(await ask()).toMatchObject({ available: true });
  });

  it("asks in order: this server's ownership, then the token, then the address", async () => {
    await rm(tokenFile);
    process.env[MODEL_API_URL_ENV] = "not an address";
    expect(await ask()).toMatchObject({ available: false, reason: expect.stringMatching(/did not take charge/) });
    expect(await start()).toEqual({ owned: true });
    expect(await ask()).toMatchObject({ available: false, reason: expect.stringMatching(/no sign-in token/) });
    await writeFile(tokenFile, `${SIGN_IN_TOKEN}\n`, { mode: 0o600 });
    expect(await ask()).toMatchObject({ available: false, reason: expect.stringContaining(MODEL_API_URL_ENV) });
  });
});

describe("the doctor command", () => {
  /**
   * A home for running `scripts/doctor.mjs` against a stub CLI and nothing else (#246): the doctor's PATH holds no `claude`, so the installed CLI
   * is never found, let alone started, and `CLAUDE_CLI_PATH` names the stub, which answers its version and writes its call down. Every run asserts that
   * the doctor found the stub and that the stub was asked exactly once. `asLinux` makes the doctor take its Linux branch on any platform.
   * The doctor runs from the home's own folder, never from the checkout the tests run in, whose `.env.local` it would otherwise read (#246).
   */
  const DOCTOR = path.resolve("scripts/doctor.mjs");
  const doctorHome = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cb-doctor-"));
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    const calls = path.join(dir, "stub-calls.log");
    const stub = path.join(dir, "claude-stub");
    await writeFile(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\necho 2.1.328\n`, { mode: 0o755 });
    const preload = path.join(dir, "as-linux.mjs");
    await writeFile(preload, 'Object.defineProperty(process, "platform", { value: "linux" });\n');
    const run = async (settings: Record<string, string | undefined>, options: { asLinux?: boolean } = {}) => {
      const env: Record<string, string> = { PATH: bin, HOME: dir, CLAUDE_CLI_PATH: stub, CREATORBRIO_DESIGN_AGENT_PROFILE: "contained" };
      for (const [name, value] of Object.entries(settings)) if (value !== undefined) env[name] = value;
      await rm(calls, { force: true });
      let out = "";
      try {
        out = execFileSync(process.execPath, [...(options.asLinux ? ["--import", preload] : []), DOCTOR], { encoding: "utf8", env: env as unknown as NodeJS.ProcessEnv, cwd: dir });
      } catch (err) {
        out = (err as { stdout: string }).stdout;
      }
      const line = (label: string) => out.split("\n").find((l) => l.includes(label)) ?? "";
      expect(line("Claude CLI"), "the CLI the doctor found").toContain(stub);
      expect((await readFile(calls, "utf8")).trim().split("\n"), "the stub CLI's calls").toEqual(["--version"]);
      return { out, line };
    };
    return { dir, run, cleanup: () => rm(dir, { recursive: true, force: true }) };
  };

  it("never reads a .env.local of the folder the tests run in (#246)", async () => {
    const { dir, run, cleanup } = await doctorHome();
    const checkout = await mkdtemp(path.join(tmpdir(), "cb-doctor-checkout-"));
    const file = path.join(dir, "token");
    const here = process.cwd();
    try {
      await writeFile(file, "sk-ant-oat01-synthetic-doctor-value\n", { mode: 0o600 });
      // A synthetic .env.local with a setting the doctor refuses, in the folder the tests run in.
      await writeFile(path.join(checkout, ".env.local"), `${MODEL_API_URL_ENV}=not an address\n`);
      process.chdir(checkout);
      // The control: a doctor started in that folder does read it, so the file would change the result.
      let started = "";
      try {
        started = execFileSync(process.execPath, [DOCTOR], {
          encoding: "utf8",
          cwd: checkout,
          env: { PATH: dir, HOME: dir, CLAUDE_CLI_PATH: path.join(dir, "claude-stub"), CREATORBRIO_DESIGN_AGENT_PROFILE: "contained", CREATORBRIO_DESIGN_AGENT_TOKEN_FILE: file } as unknown as NodeJS.ProcessEnv,
        });
      } catch (err) {
        // A refused setting makes the doctor exit non-zero; what it printed is what is read.
        started = (err as { stdout: string }).stdout;
      }
      expect(started).toMatch(/✗.*Design Agent model API/);
      // The tests' doctor runs from its own folder and sees none of it.
      const { line } = await run({ CREATORBRIO_DESIGN_AGENT_TOKEN_FILE: file });
      expect(line("Design Agent model API")).toBe("");
    } finally {
      process.chdir(here);
      await rm(checkout, { recursive: true, force: true });
      await cleanup();
    }
  }, 60_000);

  it("checks the contained profile's own versions", async () => {
    const { CONTAINED_PROFILE } = await import("@/lib/design-agent-profile");
    const doctor = await readFile("scripts/doctor.mjs", "utf8");
    expect(doctor).toContain(`const QUALIFIED_CLI_VERSION = "${CONTAINED_PROFILE.qualifiedCliVersion}";`);
    expect(doctor).toContain(`const MINIMUM_CLI_VERSION = "${CONTAINED_PROFILE.minimumCliVersion}";`);
  });

  it("checks the contained Design Agent's own token file where the app reads it, without printing it (#246)", async () => {
    const { AGENT_TOKEN_FILE_ENV, defaultAgentTokenFile } = await import("@/lib/agent-sign-in");
    const doctor = await readFile("scripts/doctor.mjs", "utf8");
    expect(defaultAgentTokenFile("/HOME")).toBe(path.join("/HOME", ".creatorbrio", "design-agent-token"));
    expect(doctor).toContain(`const TOKEN_FILE_SETTING = "${AGENT_TOKEN_FILE_ENV}";`);
    expect(doctor).toContain(`join(homedir(), ".creatorbrio", "design-agent-token")`);
  });

  it("reports the token file as present and private, not private, or absent, and never prints it (#246)", async () => {
    const { dir, run, cleanup } = await doctorHome();
    const token = "sk-ant-oat01-synthetic-doctor-value";
    const file = path.join(dir, "token");
    const signInLine = async () => {
      const { out, line } = await run({ CREATORBRIO_DESIGN_AGENT_TOKEN_FILE: file });
      expect(out).not.toContain(token);
      return line("Design Agent sign-in");
    };
    try {
      await writeFile(file, `${token}\n`, { mode: 0o600 });
      expect(await signInLine()).toMatch(/✓.*present and private/);
      await chmod(file, 0o644);
      expect(await signInLine()).toMatch(/✗.*not private.*chmod 600/);
      await rm(file);
      expect(await signInLine()).toMatch(/✗.*no token file.*claude setup-token/);
      // A second name for the file is a second path to the token, as the app refuses it (#246).
      await writeFile(file, `${token}\n`, { mode: 0o600 });
      await link(file, path.join(dir, "another-name"));
      expect(await signInLine()).toMatch(/✗.*more than one name.*new file of its own/);
    } finally {
      await cleanup();
    }
    // Each check starts the doctor, which looks for the CLI and runs it, so a loaded machine needs more than the default.
  }, 60_000);

  it("checks the model API setting where the app reads it, and never prints its value (#246)", async () => {
    const doctor = await readFile("scripts/doctor.mjs", "utf8");
    expect(doctor).toContain(`const MODEL_API_SETTING = "${MODEL_API_URL_ENV}";`);
    const { dir, run, cleanup } = await doctorHome();
    const file = path.join(dir, "token");
    const apiLine = async (value: string | undefined) => {
      const { out, line } = await run({ CREATORBRIO_DESIGN_AGENT_TOKEN_FILE: file, [MODEL_API_URL_ENV]: value });
      expect(out).not.toMatch(/synthetic-pass|models\.example\.test/);
      return line("Design Agent model API");
    };
    try {
      await writeFile(file, "sk-ant-oat01-synthetic-doctor-value\n", { mode: 0o600 });
      expect(await apiLine(undefined)).toBe("");
      expect(await apiLine("https://models.example.test/v1")).toMatch(/○.*never to ANTHROPIC_BASE_URL/);
      for (const bad of ["models.example.test", "ftp://models.example.test", "http://user:synthetic-pass@models.example.test"]) {
        expect(await apiLine(bad), bad).toMatch(new RegExp(`✗.*${MODEL_API_URL_ENV}.*absolute http or https address`));
      }
    } finally {
      await cleanup();
    }
  }, 60_000);

  it("warns on Linux that the contained profile is unsupported there and says macOS is its first activation platform, and says nothing of the kind elsewhere (#246)", async () => {
    const { dir, run, cleanup } = await doctorHome();
    const file = path.join(dir, "token");
    try {
      await writeFile(file, "sk-ant-oat01-synthetic-doctor-value\n", { mode: 0o600 });
      // The doctor's Linux branch, taken whatever this platform is.
      const linux = (await run({ CREATORBRIO_DESIGN_AGENT_TOKEN_FILE: file }, { asLinux: true })).line("Design Agent platform");
      expect(linux).toMatch(/!\s+Design Agent platform\s+the contained profile is unsupported on Linux \(its sandbox leaves the shared temporary folders writable\); macOS is its first activation platform/);
      // Not a claim that macOS is qualified: it is not yet.
      expect(linux).not.toMatch(/qualified/);
      // Run as it is: the line is there on Linux and nowhere else.
      const native = (await run({ CREATORBRIO_DESIGN_AGENT_TOKEN_FILE: file })).line("Design Agent platform");
      if (process.platform === "linux") expect(native).toMatch(/unsupported on Linux/);
      else expect(native).toBe("");
    } finally {
      await cleanup();
    }
  }, 60_000);
});
