import { describe, expect, it } from "vitest";
import {
  AGENT_TOKEN_ENV,
  CONTAINED_PROFILE,
  agentTempDirFits,
  compareCliVersions,
  containedArgs,
  containedEnv,
  containedSettings,
  designAgentProfileName,
  INHERITED_ENV,
  SIGN_IN_TOKEN_ENV,
  privateReadDirs,
  type ContainedLayout,
} from "@/lib/design-agent-profile";
import { designAgentArgs } from "@/lib/design-agent";
import { DIRECTOR_PROFILE, directorArgs } from "@/lib/visual-director";

const LAYOUT: ContainedLayout = {
  workDir: "/home/designer/.creatorbrio/design-agent/2f1c9a52-8d3e-4b7a-9f21-0e4d5c6b7a89/7c0d4e1a-5b2f-4c3d-8e9f-0a1b2c3d4e5f",
  stagingDir: "/home/designer/.creatorbrio/design-agent/2f1c9a52-8d3e-4b7a-9f21-0e4d5c6b7a89/.staged/7c0d4e1a-5b2f-4c3d-8e9f-0a1b2c3d4e5f",
  tempDir: "/tmp/cbrs/a1b",
  tempRoot: "/tmp/cbrs",
  homeDir: "/home/designer",
  agentHome: "/home/designer/.creatorbrio/design-agent/.home",
  // A configured token file outside every denied folder, so only its own rule covers it.
  signInTokenFile: "/srv/secrets/design-agent-token",
  repoDir: "/srv/creatorbrio",
  dataDir: "/srv/creatorbrio/data",
  listenerPort: 48211,
  platform: "linux",
  uid: 1000,
  privateDirs: ["/home/designer/.creatorbrio/design-agent"],
};

const args = (overrides: Partial<Parameters<typeof containedArgs>[0]> = {}) =>
  containedArgs({ taskMessage: "- a task that starts with a dash", systemPrompt: "SYSTEM", resumeSessionId: null, budgetUsd: null, layout: LAYOUT, ...overrides });

const flagValues = (argv: string[], flag: string) => {
  const at = argv.indexOf(flag);
  const values: string[] = [];
  for (let i = at + 1; i < argv.length && !argv[i].startsWith("-"); i++) values.push(argv[i]);
  return values;
};

describe("Design Agent profile selection", () => {
  it("defaults to the legacy profile and accepts only the two names", () => {
    expect(designAgentProfileName({})).toEqual({ ok: true, name: "legacy" });
    expect(designAgentProfileName({ CREATORBRIO_DESIGN_AGENT_PROFILE: " " })).toEqual({ ok: true, name: "legacy" });
    expect(designAgentProfileName({ CREATORBRIO_DESIGN_AGENT_PROFILE: "contained" })).toEqual({ ok: true, name: "contained" });
    for (const bad of ["Contained", "sandbox", "off", "1"]) {
      expect(designAgentProfileName({ CREATORBRIO_DESIGN_AGENT_PROFILE: bad })).toEqual({ ok: false });
    }
  });

  it("leaves the legacy agent's arguments exactly as they were", () => {
    expect(designAgentArgs({ taskMessage: "T", systemPrompt: "S", resumeSessionId: null, budgetUsd: null })).toEqual([
      "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
      "--append-system-prompt", "S", "--allowedTools", "Bash", "--allowedTools", "WebFetch", "--allowedTools", "Read",
      "--name", "creatorbrio-chat", "--", "T",
    ]);
  });
});

describe("contained profile arguments", () => {
  it("pins the isolation flags, model, effort, tools and permission mode", () => {
    const argv = args();
    expect(argv.slice(0, 7)).toEqual(["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--append-system-prompt", "SYSTEM"]);
    expect(flagValues(argv, "--model")).toEqual(["claude-opus-5-5"]);
    expect(flagValues(argv, "--effort")).toEqual(["medium"]);
    expect(flagValues(argv, "--tools")).toEqual(["Bash", "Read"]);
    expect(flagValues(argv, "--allowedTools")).toEqual(["Bash", `Read(/${LAYOUT.workDir}/**)`, `Read(/${LAYOUT.stagingDir}/**)`]);
    expect(flagValues(argv, "--permission-mode")).toEqual(["dontAsk"]);
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--disable-slash-commands");
    expect(argv.slice(-2)).toEqual(["--", "- a task that starts with a dash"]);
  });

  it("offers no web fetch, file-editing or delegating tool and never bypasses permissions", () => {
    const argv = args();
    for (const tool of ["WebFetch", "WebSearch", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task", "Skill"]) {
      expect(flagValues(argv, "--tools")).not.toContain(tool);
      expect(flagValues(argv, "--allowedTools").some((t) => t.startsWith(tool))).toBe(false);
    }
    expect(argv.join(" ")).not.toMatch(/bypassPermissions|dangerously|--add-dir|--mcp-config|--plugin-dir|--agents/);
  });

  it("passes a spending cap and a session to resume only when given", () => {
    expect(args()).not.toContain("--max-budget-usd");
    expect(args()).not.toContain("--resume");
    const argv = args({ budgetUsd: 2.5, resumeSessionId: "6c1f9a52-8d3e-4b7a-9f21-0e4d5c6b7a89" });
    expect(flagValues(argv, "--max-budget-usd")).toEqual(["2.5"]);
    expect(flagValues(argv, "--resume")).toEqual(["6c1f9a52-8d3e-4b7a-9f21-0e4d5c6b7a89"]);
  });

  it("carries exactly the profile's settings", () => {
    const argv = args();
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1])).toEqual(containedSettings(LAYOUT));
  });
});

describe("contained profile settings", () => {
  const settings = containedSettings(LAYOUT) as {
    autoMemoryEnabled: boolean;
    sandbox: Record<string, unknown> & { network: Record<string, unknown>; filesystem: Record<string, string[]> };
    permissions: { allow: string[]; deny: string[] };
  };

  it("requires the sandbox, with no escape hatch, and auto-memory off", () => {
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true });
  });

  it("lets the network reach only the listener's port, strictly", () => {
    expect(settings.sandbox.network).toEqual({ strictAllowlist: true, allowedDomains: ["localhost:48211"] });
  });

  it("never sets the rejected options", () => {
    const json = JSON.stringify(settings);
    expect(json).not.toMatch(/allowLocalBinding|excludedCommands|allowUnixSockets|allowAllUnixSockets|enableWeakerNestedSandbox/);
    expect(settings.sandbox.network.allowedDomains).not.toContain("localhost");
  });

  it("denies reading the home folder, the CLI's server-owned home, repository, data folder and server temporary parent, re-allowing only the run's own folders", () => {
    expect(settings.sandbox.filesystem.denyRead).toEqual([
      "/home/designer",
      "/home/designer/.creatorbrio/design-agent/.home",
      "/srv/creatorbrio",
      "/srv/creatorbrio/data",
      "/tmp/claude-1000",
      "/private/tmp/claude-1000",
      "/tmp/cbrs",
      "/home/designer/.creatorbrio/design-agent",
      "/srv/secrets/design-agent-token",
    ]);
    // The staged images are readable, never writable. Of the server-owned
    // temporary parent, only this run's folder: never another run's, nor the
    // Visual Director's image copies (#241).
    expect(settings.sandbox.filesystem.allowRead).toEqual([LAYOUT.workDir, LAYOUT.stagingDir, LAYOUT.tempDir]);
    expect(settings.sandbox.filesystem.allowRead.some((dir: string) => dir === LAYOUT.tempRoot)).toBe(false);
  });

  it("names the private folders outside home: the workspace root, a configuration folder and the macOS per-user temporary folder", () => {
    const input = { workspaceRoot: "/srv/agents", userTempDir: "/var/folders/ab/synthetic/T" };
    expect(privateReadDirs({ ...input, env: {}, platform: "linux" })).toEqual(["/srv/agents"]);
    expect(privateReadDirs({ ...input, env: { CLAUDE_CONFIG_DIR: "/opt/claude-config/" }, platform: "linux" })).toEqual(["/srv/agents", "/opt/claude-config"]);
    expect(privateReadDirs({ ...input, env: { CLAUDE_CONFIG_DIR: "relative" }, platform: "darwin" })).toEqual(["/srv/agents", "/var/folders/ab/synthetic/T"]);
    // Without TMPDIR the per-user folder is the shared system one, which holds the run's own folder.
    expect(privateReadDirs({ ...input, env: {}, platform: "darwin", userTempDir: "/private/tmp" })).toEqual(["/srv/agents"]);
  });

  it("denies writing the CLI's shared temporary folder in every spelling", () => {
    expect(settings.sandbox.filesystem.denyWrite).toEqual(["/tmp/claude-1000", "/private/tmp/claude-1000", LAYOUT.stagingDir]);
    expect(settings.sandbox.filesystem).not.toHaveProperty("allowWrite");
  });

  it("allows the Read tool only in the carousel's folder and denies the protected folders by name", () => {
    expect(settings.permissions.allow).toEqual([`Read(/${LAYOUT.workDir}/**)`, `Read(/${LAYOUT.stagingDir}/**)`]);
    expect(settings.permissions.deny).toEqual([
      "Read(//srv/creatorbrio/**)",
      "Read(//srv/creatorbrio/data/**)",
      "Read(//tmp/cbrs/**)",
      "Read(//home/designer/.creatorbrio/design-agent/.home/**)",
      "Read(//home/designer/.claude/**)",
      "Read(//home/designer/.claude.json)",
      "Read(//srv/secrets/design-agent-token)",
    ]);
  });

  it("also denies the login keychains by name on macOS", () => {
    const mac = containedSettings({ ...LAYOUT, platform: "darwin", homeDir: "/Users/designer" }) as typeof settings;
    expect(mac.sandbox.filesystem.denyRead).toContain("/Users/designer/Library/Keychains");
    expect(mac.permissions.deny).toContain("Read(//Users/designer/Library/Keychains/**)");
  });
});

describe("contained profile environment", () => {
  const source = {
    HOME: "/home/designer",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-server-sign-in",
    ANTHROPIC_API_KEY: "synthetic-server-key",
    ANTHROPIC_AUTH_TOKEN: "synthetic-server-auth",
    OPENAI_API_KEY: "synthetic-app-secret",
    CREATORBRIO_IMAGE_KEY: "synthetic",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/synthetic.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "synthetic",
    CLOUDSDK_PROXY_PASSWORD: "synthetic",
    AWS_SECRET_ACCESS_KEY: "synthetic",
    CLAUDE_CODE_USE_BEDROCK: "1",
    NODE_OPTIONS: "--require /tmp/evil.js",
    CREATORBRIO_DESIGN_AGENT_PROFILE: "contained",
    EMPTY: "",
  };

  const run = { tempDir: "/tmp/cb-Ab12Cd", token: "T0KEN", home: "/home/designer/.creatorbrio/design-agent/.home", signInToken: "synthetic-dedicated-token" };

  it("is an explicit allowlist plus the server-owned home, its own sign-in token, the run's folder and grant", () => {
    expect(containedEnv(source, run)).toEqual({
      HOME: "/home/designer/.creatorbrio/design-agent/.home",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-dedicated-token",
      CLAUDE_CODE_TMPDIR: "/tmp/cb-Ab12Cd",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      [AGENT_TOKEN_ENV]: "T0KEN",
    });
  });

  it("signs the CLI in only with its own token, never with a credential the server holds (#246)", () => {
    const env = containedEnv(source, run);
    expect(env[SIGN_IN_TOKEN_ENV]).toBe(run.signInToken);
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "AWS_SECRET_ACCESS_KEY"]) expect(env).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toMatch(/synthetic-server-/);
    // No credential variable is inherited at all.
    expect(INHERITED_ENV.filter((name) => /TOKEN|KEY|SECRET|PASS|AUTH/.test(name))).toEqual([]);
  });

  it("never gives the CLI the person's home, their configuration folder or the location of their sign-in store (#242, #246)", () => {
    const env = containedEnv({ ...source, CLAUDE_CONFIG_DIR: "/opt/claude-config", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/somewhere/else" }, run);
    expect(env.HOME).toBe(run.home);
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  });
});

describe("the run's temporary folder", () => {
  it("must leave room for the CLI's per-user folder within 44 bytes", () => {
    expect(agentTempDirFits("/tmp/cb-Ab12Cd", 1000)).toBe(true);
    expect(agentTempDirFits("/private/tmp/cb-Ab12Cd", 65534)).toBe(true);
    expect(agentTempDirFits("/var/folders/zz/synthetic0000000000000000000gn/T/cb-Ab12Cd", 501)).toBe(false);
  });
});

describe("CLI versions", () => {
  it("compares dotted versions and refuses anything else", () => {
    expect(compareCliVersions("2.1.328", CONTAINED_PROFILE.qualifiedCliVersion)).toBe(0);
    expect(compareCliVersions("2.1.218", CONTAINED_PROFILE.minimumCliVersion)).toBe(-1);
    expect(compareCliVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareCliVersions("2.1.328-beta", "2.1.328")).toBeNull();
  });
});

describe("the creative agents' profile model (#186)", () => {
  it("records the contained Design Agent's isolation, and its arguments embody it", () => {
    const argv = args();
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe(CONTAINED_PROFILE.settingSources);
    expect(argv.includes("--strict-mcp-config")).toBe(CONTAINED_PROFILE.strictMcpConfig);
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]).autoMemoryEnabled).toBe(CONTAINED_PROFILE.autoMemoryEnabled);
  });

  it("records the Visual Director's existing isolation, and its arguments embody it", () => {
    expect(DIRECTOR_PROFILE).toEqual({
      version: 1,
      model: null,
      effort: null,
      tools: ["Read"],
      permissionMode: null,
      settingSources: "",
      strictMcpConfig: true,
      autoMemoryEnabled: false,
    });
    const argv = directorArgs("/tmp/creatorbrio-director-x", null);
    expect(flagValues(argv, "--tools")).toEqual([...DIRECTOR_PROFILE.tools]);
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1])).toEqual({ autoMemoryEnabled: false });
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--effort");
    expect(argv).not.toContain("--permission-mode");
  });
});
