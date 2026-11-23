/**
 * The Design Agent's execution profiles (#156, #186, #227).
 *
 * `legacy` is the agent as it ran before M1: the arguments in
 * `designAgentArgs`, the person's own Claude Code configuration, the full
 * process environment and the repository as its working folder. It stays the
 * default until the contained profile is qualified and activated (#237).
 *
 * `contained` is the controlled, versioned profile. Everything that decides
 * what the agent can load, use, read, write and reach is a pure function of
 * this module, so tests pin it exactly and the qualification suite launches the
 * same configuration the app ships:
 *
 * - no setting sources, no MCP servers, no skills or slash commands, auto-memory
 *   off, and an explicit model and effort, so no personal instruction, rule,
 *   skill, agent, hook, plugin, MCP server or settings model reaches it;
 * - only the `Bash` and `Read` tools, so it has no web fetch and no file-editing
 *   tool; `Read` is allowed only inside the carousel's own folder and its staged images, and
 *   anything not allowed is refused: the subprocess credential scrub makes the
 *   CLI replace the requested `dontAsk` mode with `default`, and a headless run
 *   in `default` mode refuses every tool use that would need approval, as the
 *   product-read arm of the stand-in network proof recorded for one `Read` on
 *   macOS (no Linux evidence is claimed for it);
 * - Claude Code's sandbox for the shell, required (`failIfUnavailable`), with
 *   no unsandboxed escape hatch, a strict network allowlist naming only the
 *   run's listener port, the home folder, repository and data folder
 *   read-denied with only the conversation's folder and its staged images
 *   re-allowed, the per-user parent of every run's temporary folder
 *   read-denied with only the run's own folder re-allowed, and the CLI's
 *   shared per-user temporary folder read- and write-denied;
 * - a server-owned home folder (`prepareAgentHome`) holding no shell startup
 *   file, so the CLI's shell preparation runs nothing of the person's, and
 *   nothing else of theirs (#242, #246), read-denied with the rest;
 * - its own sign-in token (`src/lib/agent-sign-in.ts`), passed only to the
 *   CLI, whose environment scrub keeps it from the shell, with its file
 *   denied to the shell and the `Read` tool by name; no other credential
 *   reaches the CLI (#246);
 * - an explicit environment allowlist, plus the run's own short temporary
 *   folder and the listener token, and a model API address only from the
 *   CreatorBrio setting that names one (`containedModelApiAddress`), never
 *   the server's own `ANTHROPIC_BASE_URL`, which would send the contained
 *   CLI's dedicated token wherever the person's own Claude Code points.
 *
 * This is risk reduction under the vendor's sandbox and permission rules, not
 * an operating-system account boundary. See docs/architecture/design-agent.md.
 */
import path from "node:path";

export const DESIGN_AGENT_PROFILE_ENV = "CREATORBRIO_DESIGN_AGENT_PROFILE";

export type DesignAgentProfileName = "legacy" | "contained";

/** Unset or blank means the legacy profile; anything but the two names is refused, never ignored. */
export function designAgentProfileName(
  env: Record<string, string | undefined> = process.env
): { ok: true; name: DesignAgentProfileName } | { ok: false } {
  const raw = env[DESIGN_AGENT_PROFILE_ENV]?.trim() ?? "";
  if (raw === "" || raw === "legacy") return { ok: true, name: "legacy" };
  if (raw === "contained") return { ok: true, name: "contained" };
  return { ok: false };
}

/**
 * One execution profile model for both creative agents (#186): what each is
 * started with, recorded so that tests pin it and a change to it is explicit.
 * `model` and `effort` are null where the CLI's own default applies.
 */
export interface ExecutionProfile {
  readonly version: number;
  readonly model: string | null;
  readonly effort: string | null;
  /** Recorded, not passed: the CLI's own thinking mode for the model, which no setting source can change. */
  readonly thinking?: string;
  readonly tools: readonly string[];
  readonly permissionMode: string | null;
  /** Setting sources loaded: none, so no personal or project settings, instructions, skills, agents or hooks. */
  readonly settingSources: "";
  readonly strictMcpConfig: true;
  readonly autoMemoryEnabled: false;
  /** The CLI version the profile was qualified on, where it has been qualified on one. */
  readonly qualifiedCliVersion?: string;
  /** The oldest CLI version the profile starts on, where it has a floor. */
  readonly minimumCliVersion?: string;
}

export const CONTAINED_PROFILE = {
  version: 1,
  settingSources: "",
  strictMcpConfig: true,
  autoMemoryEnabled: false,
  /** The model the recorded creative-quality baseline ran on. */
  model: "claude-opus-5-5",
  /** The CLI's default effort for that model on the qualified version, made explicit. */
  effort: "medium",
  /** The CLI's default for that model on 2.1.328, as the stand-in recorded it. */
  thinking: "adaptive",
  tools: ["Bash", "Read"],
  permissionMode: "dontAsk",
  /** The CLI version the contained profile's containment was tested on (#237); another version starts with a warning. */
  qualifiedCliVersion: "2.1.328",
  /** The first CLI version with the sandbox's `strictAllowlist`; older versions are refused. */
  minimumCliVersion: "2.1.219",
} as const satisfies ExecutionProfile;

/**
 * The variable the run's listener token reaches the agent's shell in; never
 * its value in a prompt. Named so the CLI's environment scrub (below) keeps
 * it: measured on 2.1.328, the scrub removes names ending in TOKEN or PASS.
 */
export const AGENT_TOKEN_ENV = "CREATORBRIO_AGENT_GRANT";

/**
 * The CLI gives its sandboxed shell `$CLAUDE_CODE_TMPDIR/claude-<uid>` as its
 * temporary folder only when that path is at most this many bytes; otherwise
 * it falls back to the shared `/tmp/claude-<uid>` (observed in 2.1.328 and
 * 2.1.330), which the profile write-denies.
 */
export const MAX_AGENT_TEMP_PATH_BYTES = 44;

export interface ContainedLayout {
  /** The conversation's own folder: the working folder, and the only place outside the run's temporary folder the agent writes. */
  workDir: string;
  /** The server-only folder of the images the agent may view: readable, never writable. */
  stagingDir: string;
  /** The run's own temporary folder (`CLAUDE_CODE_TMPDIR`), short enough for the CLI to use it. */
  tempDir: string;
  /**
   * The per-user parent of every run's temporary folder and of the Visual
   * Director's image copies (`serverTempRoot`): read-denied, with only
   * `tempDir` re-allowed, so a run never reads another run's files.
   */
  tempRoot: string;
  /** The person's own home folder, read-denied. */
  homeDir: string;
  /** The CLI's server-owned home folder (#242), read-denied: it holds the CLI's sessions and configuration. */
  agentHome: string;
  /** The contained CLI's own sign-in token file (#246), denied by name wherever it is. */
  signInTokenFile: string;
  repoDir: string;
  dataDir: string;
  listenerPort: number;
  platform: NodeJS.Platform;
  uid: number;
  /** Other folders the shell must not read; see `privateReadDirs`. */
  privateDirs: readonly string[];
}

const SYSTEM_TEMP_DIRS = ["/tmp", "/private/tmp"];

/**
 * Folders outside the home folder that hold the person's private files, which
 * the shell must not read: the folder that holds every carousel's folder (only
 * the run's own is re-allowed), a CLI configuration folder kept outside home
 * (it holds the CLI's sign-in on Linux) and, on macOS, the per-user temporary
 * folder. The CLI's shared temporary folder and the sign-in token file are
 * added by `containedSettings`.
 */
export function privateReadDirs(input: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  workspaceRoot: string;
  userTempDir: string;
}): string[] {
  const dirs = [input.workspaceRoot];
  const configDir = input.env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir && path.isAbsolute(configDir)) dirs.push(path.resolve(configDir));
  // Without TMPDIR the per-user folder falls back to the shared system one,
  // which holds the run's own temporary folder and nothing of the person's.
  if (input.platform === "darwin" && !SYSTEM_TEMP_DIRS.includes(input.userTempDir)) dirs.push(input.userTempDir);
  return unique(dirs);
}

/** The shared per-user temporary folder the CLI would otherwise give the shell, in every spelling. */
export function sharedCliTempFolders(uid: number): string[] {
  return [`/tmp/claude-${uid}`, `/private/tmp/claude-${uid}`];
}

/** Whether the CLI will give the shell this run's temporary folder rather than the shared one. */
export function agentTempDirFits(tempDir: string, uid: number): boolean {
  return Buffer.byteLength(path.join(tempDir, `claude-${uid}`)) <= MAX_AGENT_TEMP_PATH_BYTES;
}

/** The `--settings` the contained profile passes: sandbox, network, files and the `Read` tool's rules. */
export function containedSettings(layout: ContainedLayout): Record<string, unknown> {
  // The CLI's shared temporary folder holds the person's other sessions'
  // files; the shell is given the run's own folder instead.
  // The sign-in token file is denied by name too, since a configured one may sit outside every denied folder (#246).
  const denyRead = [layout.homeDir, layout.agentHome, layout.repoDir, layout.dataDir, ...sharedCliTempFolders(layout.uid), layout.tempRoot, ...layout.privateDirs, layout.signInTokenFile];
  // The login keychains are read inside the calling process, so the folder is
  // denied by name too, even though the home folder already covers it (#220).
  if (layout.platform === "darwin") denyRead.push(path.join(layout.homeDir, "Library", "Keychains"));
  return {
    autoMemoryEnabled: false,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: {
        strictAllowlist: true,
        // Always with the port: a portless entry opened every loopback port (#220).
        allowedDomains: [`localhost:${layout.listenerPort}`],
      },
      filesystem: {
        denyRead: unique(denyRead),
        // Each re-allows a folder inside a denied one: the conversation's and
        // its staged images in the agent folders' root, and the run's own
        // temporary folder in the per-user parent.
        allowRead: [layout.workDir, layout.stagingDir, layout.tempDir],
        denyWrite: [...sharedCliTempFolders(layout.uid), layout.stagingDir],
      },
    },
    permissions: {
      // The leading slash plus an absolute path is the CLI's absolute-path form.
      allow: [readRule(layout.workDir), readRule(layout.stagingDir)],
      // The sandbox does not govern the Read tool; anything not allowed above
      // needs approval, which a headless run refuses (the scrub forces the
      // `default` mode, see above), and these are refused by name as well.
      deny: unique([
        readRule(layout.repoDir),
        readRule(layout.dataDir),
        readRule(layout.tempRoot),
        readRule(layout.agentHome),
        readRule(path.join(layout.homeDir, ".claude")),
        `Read(/${path.join(layout.homeDir, ".claude.json")})`,
        `Read(/${layout.signInTokenFile})`,
        ...(layout.platform === "darwin" ? [readRule(path.join(layout.homeDir, "Library", "Keychains"))] : []),
      ]),
    },
  };
}

function readRule(dir: string): string {
  return `Read(/${dir}/**)`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function containedArgs(options: {
  taskMessage: string;
  systemPrompt: string;
  resumeSessionId: string | null;
  budgetUsd: number | null;
  layout: ContainedLayout;
}): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--append-system-prompt",
    options.systemPrompt,
    "--model",
    CONTAINED_PROFILE.model,
    "--effort",
    CONTAINED_PROFILE.effort,
    "--tools",
    ...CONTAINED_PROFILE.tools,
    "--allowedTools",
    "Bash",
    readRule(options.layout.workDir),
    readRule(options.layout.stagingDir),
    "--permission-mode",
    CONTAINED_PROFILE.permissionMode,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--settings",
    JSON.stringify(containedSettings(options.layout)),
    ...(options.budgetUsd === null ? [] : ["--max-budget-usd", String(options.budgetUsd)]),
    "--name",
    "creatorbrio-chat",
    ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : []),
    // The task comes last, after "--", so the CLI never reads it as an option (#127).
    "--",
    options.taskMessage,
  ];
}

/**
 * The variables the CLI process may inherit: what an operator's outbound proxy
 * and certificates, locale and `PATH` need. Everything else in the app's
 * environment, including its own secrets and settings, stays out of the
 * agent's process, and so does every credential: the contained CLI signs in
 * only with its own token (#246), never with an API key, sign-in token or
 * other credential the server happens to hold. `HOME` is replaced by the
 * server-owned home, and the CLI's configuration folder is never passed
 * (`containedEnv`).
 *
 * The model API address is deliberately not here: the server's own
 * `ANTHROPIC_BASE_URL` is whatever the person's own Claude Code uses, often a
 * gateway, and the contained CLI's dedicated token must not follow it. The
 * address reaches the CLI only from `MODEL_API_URL_ENV`.
 */
export const INHERITED_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const;

/**
 * The only way the contained CLI gets a model API address (#246): an
 * evaluation or operator setting, mapped to the CLI's `ANTHROPIC_BASE_URL`.
 * Unset, the CLI uses its own default address.
 */
export const MODEL_API_URL_ENV = "CREATORBRIO_DESIGN_AGENT_API_BASE_URL";

/** The model API address the contained CLI is given, or why the setting is refused; the refusal names the setting, never its value. */
export type ModelApiAddress = { ok: true; url: string | null } | { ok: false; reason: string; guidance: string };

/**
 * Reads `MODEL_API_URL_ENV`: unset or blank is no address, anything else must
 * be one absolute `http` or `https` address with no user name or password in
 * it, or it is refused and no CLI starts. The value is passed as written,
 * trimmed.
 */
export function containedModelApiAddress(env: Record<string, string | undefined> = process.env): ModelApiAddress {
  const raw = env[MODEL_API_URL_ENV]?.trim() ?? "";
  if (raw === "") return { ok: true, url: null };
  const refuse = (what: string): ModelApiAddress => ({
    ok: false,
    reason: `${MODEL_API_URL_ENV} ${what}.`,
    guidance: `Set it to one absolute http or https address with no user name or password in it, or remove it to use the CLI's own default address, then restart CreatorBrio.`,
  });
  // The address parser drops whitespace and control characters, so a value holding any would not be the address it was checked as.
  if (/[\s\x00-\x1f\x7f]/.test(raw)) return refuse("is not one address");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("is not an absolute address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return refuse("is not an http or https address");
  if (url.username !== "" || url.password !== "") return refuse("holds a user name or password");
  return { ok: true, url: raw };
}

/** A launch refused because the contained CLI's model API setting is invalid; its message names the setting only. */
export class ModelApiAddressError extends Error {
  readonly reason: string;
  readonly guidance: string;

  constructor(refusal: { reason: string; guidance: string }) {
    super(refusal.reason);
    this.name = "ModelApiAddressError";
    this.reason = refusal.reason;
    this.guidance = refusal.guidance;
  }
}

/** The CLI's documented variable for a long-lived sign-in token from `claude setup-token`, which it never refreshes or stores. */
export const SIGN_IN_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

export function containedEnv(
  source: Record<string, string | undefined>,
  run: { tempDir: string; token: string; home: string; signInToken: string }
): Record<string, string> {
  // Refused before any variable is built, so no caller can start a CLI with an address that was never checked.
  const api = containedModelApiAddress(source);
  if (!api.ok) throw new ModelApiAddressError(api);
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = source[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  // The CreatorBrio setting only: the server's own `ANTHROPIC_BASE_URL` is never inherited.
  if (api.url !== null) env.ANTHROPIC_BASE_URL = api.url;
  // The server-owned home: no shell startup file of the person's, and the CLI's own state kept apart from theirs.
  env.HOME = run.home;
  // Its own sign-in, read by the server from its file (#246); the CLI's own
  // order puts it after any API key or other credential, none of which is passed.
  env[SIGN_IN_TOKEN_ENV] = run.signInToken;
  env.CLAUDE_CODE_TMPDIR = run.tempDir;
  // The pinned CLI must not replace itself with an unqualified version.
  env.DISABLE_AUTOUPDATER = "1";
  // The CLI keeps its sign-in variables, this token included, out of the
  // agent's shell, which could otherwise copy one into slide text.
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  env[AGENT_TOKEN_ENV] = run.token;
  return env;
}

/** Compares dotted numeric versions; null when either is not one. */
export function compareCliVersions(a: string, b: string): number | null {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
