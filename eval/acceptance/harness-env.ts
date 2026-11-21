/**
 * What the harness's own environment hands to the processes it starts (#232):
 * the servers, the judges and the Design-Agent-only arm all receive it, minus
 * what `cleanEnv` strips (server.ts). Nothing in it is allowed to pass
 * unrecorded on the strength of a pattern that happens to miss a name the CLI
 * reads, so the rule is the reverse of a deny list: an exact, reviewed list of
 * harmless names, and every other name that is passed on is recorded, by name
 * and never by value.
 *
 * This module imports nothing from the harness, so any module can use it
 * without an import cycle.
 */

/** A reviewed group of names that are not recorded, with the reason each group is harmless. */
export interface ReviewedNames {
  names: readonly string[];
  /** A pattern for a family of names (`LC_*`), when the group has one. */
  pattern?: RegExp;
  why: string;
}

/**
 * The names of the harness's own environment that are reviewed as harmless
 * and so not recorded. Nothing else is: not a proxy, endpoint, socket,
 * credential, configuration folder, `NODE_OPTIONS` or `npm_config_*` name, and
 * not an unknown one. The model, effort and thinking variables are not on it
 * either: they are fingerprinted by name and the hash of their value
 * (environment.ts `modelEnvironment`), which records more than a name.
 */
export const HARMLESS_HARNESS_NAMES: readonly ReviewedNames[] = [
  { names: ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TMPDIR"], why: "who runs the harness, where, and where programs and temporary files are; the configuration the CLI reads from the home folder is fingerprinted separately" },
  { names: ["LANG", "LANGUAGE", "TZ"], pattern: /^LC_[A-Z_]+$/, why: "locale and time zone, which change formatting and not what a model call is or where it goes" },
  { names: ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"], why: "terminal and shell bookkeeping" },
  {
    names: ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "DEV", "MODE", "PROD", "SSR", "TEST"],
    why: "set by vitest itself, which runs the harness, in every worker it starts (and Vite's import.meta.env keys it mirrors), not settings an operator chose",
  },
  {
    names: [
      "EVAL_ADMISSION_WAIT_MS",
      "EVAL_ARCHIVE_DIR",
      "EVAL_COMPARE",
      "EVAL_DRY",
      "EVAL_HOLD_BACK_USD",
      "EVAL_IMAGE_SERVICE_URL",
      "EVAL_LEDGER",
      "EVAL_M1_CAP_USD",
      "EVAL_MODE",
      "EVAL_ONLY",
      "EVAL_OVERSHOOT_FRACTION",
      "EVAL_REPEAT",
      "EVAL_RESTART_SIGNAL",
      "EVAL_TICKET",
    ],
    why: "the harness's own settings, each read by eval/acceptance/ and recorded in its plan, ledger or limits",
  },
  {
    names: ["DESIGN_AGENT_MAX_BUDGET_USD", "DESIGN_AGENT_TIMEOUT_SECONDS", "DESIGN_AGENT_INACTIVITY_SECONDS", "DIRECTOR_MAX_BUDGET_USD", "DISABLE_AUTOUPDATER"],
    why: "the caps and limits the harness sets or reads and records under environment.limits, and the switch that keeps the CLI from replacing itself",
  },
  {
    names: ["CI", "GITHUB_ACTIONS", "GITHUB_WORKFLOW", "GITHUB_JOB", "GITHUB_RUN_ID", "GITHUB_RUN_NUMBER", "GITHUB_RUN_ATTEMPT", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "GITHUB_REF_NAME", "GITHUB_EVENT_NAME", "GITHUB_ACTOR", "GITHUB_WORKSPACE", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "RUNNER_TOOL_CACHE", "RUNNER_WORKSPACE"],
    why: "what a GitHub Actions runner sets to say where and for what it runs; the CLI reads GITHUB_ACTIONS and others for its subprocess environment scrubbing and its telemetry, but none of them carries an endpoint, credential, proxy, configuration folder, preload or token limit, and the tokens a workflow adds (GITHUB_TOKEN, GH_TOKEN) are not on this list",
  },
];

const HARMLESS = new Set(HARMLESS_HARNESS_NAMES.flatMap((g) => g.names));
const HARMLESS_PATTERNS = HARMLESS_HARNESS_NAMES.flatMap((g) => (g.pattern ? [g.pattern] : []));

/** Whether `name` is reviewed as harmless. */
export const isHarmlessHarnessName = (name: string): boolean => HARMLESS.has(name) || HARMLESS_PATTERNS.some((p) => p.test(name));

/**
 * The names of every variable in `env` that is set, that is not reviewed as
 * harmless and that `recordedElsewhere` does not already record (the model
 * variables, which are recorded by name and value hash). Sorted, names only,
 * never a value. `env` is what the harness passes on, so it is what `cleanEnv`
 * leaves of the harness's own environment.
 */
export function unreviewedHarnessNames(env: Record<string, string | undefined>, recordedElsewhere: (name: string) => boolean): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && !isHarmlessHarnessName(name) && !recordedElsewhere(name))
    .sort();
}

/** What the record holds of the harness's own environment. */
export interface HarnessEnvironment {
  /**
   * Variables the harness passes to servers, the arm and the judges that are not reviewed as harmless and not fingerprinted as model variables:
   * names only, never values. The full list is in results.json only (never committed). summary.md and a dry run show only counts of it by
   * class (`countNamesByClass`), because a name can carry an organization, project or machine detail.
   */
  unreviewedNames: string[];
}

/**
 * Names so generic that a variable of that kind can point a model call
 * somewhere else or change how its process starts: an endpoint, socket, token
 * or proxy variable, or `NODE_OPTIONS`. summary.md and a dry run count them
 * and never name them, since the name of a variable can carry an
 * organization, project or machine detail.
 */
export const ENDPOINT_LIKE_NAME = /^NODE_OPTIONS$|ENDPOINT|SOCKET|TOKEN|PROXY/i;

/** A name that contains MODEL in either case: the same test as `modelPricing` applies to every name a process receives. */
export const MODEL_LIKE_NAME = /MODEL/i;

/** How many names there are, by class; a name can be in both classes. */
export interface NameClassCounts {
  total: number;
  /** Names that look like an endpoint, socket, token or proxy variable, or are `NODE_OPTIONS`. */
  endpointLike: number;
  /** Names that contain MODEL in either case. */
  namesModel: number;
}

/** Counts of `names` by class, which is all that summary.md and a dry run say of them. */
export function countNamesByClass(names: readonly string[]): NameClassCounts {
  return {
    total: names.length,
    endpointLike: names.filter((n) => ENDPOINT_LIKE_NAME.test(n)).length,
    namesModel: names.filter((n) => MODEL_LIKE_NAME.test(n)).length,
  };
}

/** The classes as a phrase for text that may be committed or pasted: counts only, never a name. */
export const describeNameClasses = (c: NameClassCounts): string =>
  `${c.endpointLike} with a name that looks like an endpoint, socket, token or proxy variable, or is NODE_OPTIONS, and ${c.namesModel} with a name that contains MODEL`;

/**
 * The names set in any of `envs`, sorted and once each: what the servers, the
 * Design-Agent-only arm and the judges receive between them (the loader's
 * result for the servers and the arm, the cleaned environment for the judges).
 */
export function receivedNames(...envs: Record<string, string | undefined>[]): string[] {
  return [...new Set(envs.flatMap((env) => Object.keys(env).filter((name) => env[name] !== undefined)))].sort();
}

/**
 * The four names that a paid run is refused for when they are set in the
 * harness's own environment, whether the harness would strip the name (the
 * `CLAUDE_CODE_*` ones, which `cleanEnv` removes) or pass it on
 * (`MAX_THINKING_TOKENS`). They can raise what one model call thinks, writes
 * or reads past the allowance the run reserved. This is the whole of what is
 * refused here, with the `.env` files' allowlist (`SERVER_ENV_ALLOWLIST`,
 * server-env.ts). It does not make every run safe from other settings that
 * can do the same: the CLI's other variables (`ANTHROPIC_BETAS`,
 * `MAX_MCP_OUTPUT_TOKENS`, `BASH_MAX_OUTPUT_LENGTH` and the like) are recorded
 * by name only, and the settings files the Design Agent and the
 * Design-Agent-only arm load, and the managed settings every role loads, can
 * set model, effort, thinking, `env` and `apiKeyHelper` (settings-keys.ts
 * records their key names, never their values).
 */
export const REFUSED_HARNESS_NAMES: readonly string[] = ["MAX_THINKING_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_EFFORT_LEVEL"];

/** The refused names set in `env`, sorted. A variable that is set but empty counts: the CLI may read an empty value. */
export function refusedHarnessNames(env: Record<string, string | undefined>): string[] {
  return REFUSED_HARNESS_NAMES.filter((name) => env[name] !== undefined).sort();
}

/** Why a paid run is refused for `names`, or null when there are none. */
export function harnessEnvironmentRefusal(names: string[]): string | null {
  if (names.length === 0) return null;
  return `Refusing a paid run before any spend: the harness's own environment sets ${names.join(", ")}, which can raise what one model call thinks, writes or reads past the allowance the run reserved. Unset ${names.length === 1 ? "it" : "them"} and run the harness again. Only ${REFUSED_HARNESS_NAMES.join(", ")} are refused here: the CLI's other variables are recorded by name, and its settings files by key name, and are not refused.`;
}

/**
 * What the pinned CLI does with a model its price table lacks, taken from its
 * own code (2.1.328): it costs the call at the rate of its main model, notes
 * the fact in an analytics event and in a flag of its cost state, and reports
 * the cost as any other. The flag is not in the result event the harness
 * reads, and the table is not visible from outside, so the harness cannot see
 * a model the table lacks. It can see that a variable chose the model.
 */
export const MODEL_PRICE_NOTE =
  "The pinned CLI costs a model its price table lacks at the rate of its main model and reports that cost like any other, and the per-call caps follow the cost it reports. The harness cannot see the CLI's table, so a run is flagged when any variable whose name contains MODEL (in either case) reaches the servers, the arm or the judges. A model chosen in a settings file is not seen as a model: the files are fingerprinted by hash and their key names are recorded, so a `model` key is shown but not its value. Managed settings can also set `modelPricing`, which replaces the price the CLI uses for a model and scales the cost it reports, for every role; the record names a `modelPricing` key in a managed file and never its value.";

export interface ModelPricing {
  /**
   * Every variable whose name contains MODEL (names only, either case) among those the servers, the Design-Agent-only arm and the judges receive,
   * from the environment or the `.env` files. The names are in results.json only (never committed); summary.md and a dry run show their count.
   */
  selectionVariables: string[];
  /** A variable chose a model, so its price cannot be shown to be in the CLI's table. */
  unverified: boolean;
  note: string;
}

/** The names among `names` that contain MODEL in either case, sorted and once each: the test is applied to every name a process receives, not to a list of names chosen in advance. */
export function modelPricing(names: string[]): ModelPricing {
  const selectionVariables = [...new Set(names.filter((n) => MODEL_LIKE_NAME.test(n)))].sort();
  return { selectionVariables, unverified: selectionVariables.length > 0, note: MODEL_PRICE_NOTE };
}
