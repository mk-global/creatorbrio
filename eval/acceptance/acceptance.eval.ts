import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBrandForCarousel } from "@/lib/brand";
import { findClaudePath } from "@/lib/claude-path";
import type { Carousel } from "@/types/carousel";
import { AppClient, logEntries, logOffset, readRunRecord, serverCosts, type ChatOptions, type ChatResult } from "./app";
import { archiveDir, archiveRun } from "./archive";
import { designAgentOnlyCliPath, notJudgedReason, runDesignAgentOnly } from "./baseline";
import {
  checkCliPin,
  cliFileFacts,
  cliVersion,
  directorProof,
  END_OF_RUN,
  judgeProof,
  pinCli,
  recheckCli,
  recordRecheck,
  resolveServerCli,
  versionNumber,
} from "./cli";
import { parseCaps, parseHoldBack, parseRepeat, planRun, preflight, renderPlan, reserveRun, settleRun, type PlanItem } from "./budget";
import {
  gitState,
  harnessHashes,
  inheritedConfiguration,
  MODEL_ENV_NAME,
  memoryRoots,
  redactPath,
  redactText,
  sessionVersions,
  transcriptModels,
  worktreeRefusal,
  type DesignLimitsRecord,
  type EnvironmentRecord,
} from "./environment";
import { countNamesByClass, describeNameClasses, harnessEnvironmentRefusal, modelPricing, receivedNames, refusedHarnessNames, unreviewedHarnessNames, type HarnessEnvironment } from "./harness-env";
import { admissionWaitMs, health, imageServiceUrl, observeBusy, waitForAdmission, type BusyObservation } from "./image-service";
import { judgeCliPath, judgeOutcome, judgePairwise, judgeRevision, type JudgeContext } from "./judge";
import { DEFAULT_TICKET, ledgerPath, m1CapUsd, readLedger } from "./ledger";
import { chatTimeoutMs, designAgentLimits, designAgentOnlyRun, formatDuration, itemWorstCase, largestStageMs, refusalBeforeSpend, stageLimits, type ItemShape } from "./limits";
import {
  renderSummary,
  serializeResults,
  stageDurations,
  type Check,
  type ComparisonRecord,
  type ImageServiceEvidence,
  type RunResults,
  type ScenarioRecord,
} from "./report";
import { accountHome, homeDiffersFromAccount, homeFolders } from "./redact";
import { founderPhoto, SCENARIOS, SYNTHETIC_BRAND, type Scenario } from "./scenarios";
import { cleanEnv, ROOT, runDir, runId, serverEnvironment, startServer, type HarnessPort, type RunningServer } from "./server";
import { loadedFileVariables, loadServerEnv, printableMessage, recheckEnvFiles, recordEnvRecheck, splitAddedNames } from "./server-env";
import { describeSettingsFiles, recordSettingsKeys, settingsBannerLines } from "./settings-keys";
import { classifyItemFailure, skippedComparisonReason, StartGate, startChanges } from "./start-gate";
import {
  checkExportFiles,
  checkFileHashes,
  checkPlacement,
  checkPreview,
  checkTasks,
  checkUnavailableServiceStop,
  plannedAssets,
  planSummary,
  runTasks,
  snapshotStaged,
  stagingDir,
  verifyReuse,
  type StagedSnapshot,
} from "./verify";

/**
 * The creative-run acceptance harness (#40). It drives real CreatorBrio
 * servers it starts itself, through the public API, with the real Claude CLI
 * and whatever local image service is running. It costs money and is not
 * deterministic, so it only runs when invoked explicitly:
 *
 *   npm run build
 *   DIRECTOR_MAX_BUDGET_USD=0.50 DESIGN_AGENT_MAX_BUDGET_USD=3.00 EVAL_ONLY=S1,S10 EVAL_REPEAT=3 \
 *     npx vitest run --config vitest.eval.config.ts eval/acceptance/acceptance.eval.ts
 *
 * EVAL_MODE=dev uses `next dev` instead of a production build, for a dry run
 * only: a paid dev run is refused, because `next dev` reloads the .env files
 * into a running server. EVAL_COMPARE=0 skips the Design-Agent-only
 * comparison. A test fails only on a harness error; quality misses are
 * recorded in results.json and summary.md.
 *
 * Spending (#224): both per-call caps are required and are given to every
 * server and to the Design-Agent-only arm. Before anything starts, the
 * preflight (budget.ts) computes the plan's worst case from those caps and
 * the judge's own cap and refuses the run when it exceeds what remains of
 * EVAL_M1_CAP_USD (50 by default) after the ledger at EVAL_LEDGER
 * (ledger.ts). The run reserves its worst case in the ledger before it
 * spends anything and records what it measured when it ends. EVAL_DRY=1
 * prints the plan, the worst case and the remaining allowance and stops
 * there, starting no server and no model. EVAL_REPEAT=n runs every selected
 * scenario n times, repetition by repetition, in the same order. EVAL_TICKET
 * names the ticket the ledger entries are for (#221 by default). After the
 * run, results.json, summary.md, the server logs and the exported PNGs are
 * copied to <EVAL_ARCHIVE_DIR>/<run id> (EVAL_ARCHIVE_DIR is
 * ~/.local/share/creatorbrio-m1-eval/acceptance by default), owner-only.
 *
 * Every call is bounded by its cap plus an overshoot allowance,
 * EVAL_OVERSHOOT_FRACTION of the cap (0.25 by default; the CLI checks a cap
 * between turns), an assumption rather than a guarantee: a call measured above
 * its limit is charged as measured and flagged. EVAL_HOLD_BACK_USD
 * (0 by default) keeps part of the remaining allowance out of the run's
 * reach: #221's post-containment rerun must fit in the same cap. When the run
 * ends, the ledger is charged what it spent (budget.ts, settleRun): the
 * measured cost of every call that reported one and the per-call limit of
 * every call that started without one, so a judge that timed out, a Design
 * Agent run that logged no cost, a harness failure or a test timeout never
 * lowers the figure. The ledger is locked while a run reserves and settles.
 *
 * A non-dry run refuses to start in the repository's primary worktree, whose
 * data/ folder holds real carousels, brands and uploads the servers would
 * read and write; run it from a dedicated linked worktree.
 *
 * The CLI is pinned (#232). It is resolved once, to a real path, from the
 * harness's CLAUDE_CLI_PATH or the checkout's .env files, and that path is
 * given to every server as CLAUDE_CLI_PATH and spawned directly by the judges
 * and the Design-Agent-only arm. A paid run whose CLI was only found by the
 * app's discovery is refused, as is one whose servers', arm's and judge's
 * paths or versions differ, before anything is reserved or spent. The file's
 * size, SHA-256 and --version are checked again at each server start and at
 * the end of the run, and any change marks the run as not comparable. Each
 * server gets NODE_ENV for its mode, so it loads the checkout's .env files.
 * What those files add is taken from Next.js's own loader (server-env.ts): a
 * paid run is refused when a name is not on the exact allowlist or a line of
 * a file is not accounted for by the loader's result, the files are hashed and
 * checked again at each server start and at the end of the run, and the
 * Design-Agent-only arm gets the environment the loader leaves a server, with
 * the same deadline, inactivity limit and cap as the Design Agent a server
 * spawns. The servers are started with Node.js and Next.js's own script, never
 * through npx or npm, so npm adds nothing to a server's environment at its
 * start. The harness's own environment reaches every process unchanged apart
 * from what it strips, and every variable in it that is not reviewed as
 * harmless is recorded by name in results.json (harness-env.ts), which is never
 * committed; summary.md and a dry run show only counts of them by class, and
 * name no variable, settings key or settings file that came from the
 * operator's machine (only fixed strings of the harness's own source: the
 * refused names, the .env allowlist, the settings file labels and the CLI's
 * own settings key names). A paid run is refused for exactly four names in it
 * (MAX_THINKING_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS,
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS and CLAUDE_CODE_EFFORT_LEVEL) and for a .env
 * name that is not on the allowlist; the CLI's other variables are recorded by
 * name only. The Design Agent and the Design-Agent-only arm load the CLI's
 * settings files (they run without --setting-sources), which can set model,
 * effort, thinking, env and apiKeyHelper, and managed settings apply to every
 * role; their key names, never values, are recorded in results.json before
 * the reservation (settings-keys.ts) and neither refused nor overridden. After a refused
 * server start no later item starts: each is recorded as not run, before any
 * stage, and charged nothing. EVAL_DRY=1 prints all of these checks instead of
 * refusing.
 *
 * Time (#232): the chat request waits for the largest stage limit plus five
 * minutes for each chunk, and each plan item's test is given the sum of its
 * stage limits plus a margin (limits.ts), so only the product's own limits
 * stop a design.
 *
 * Scenarios that need generated images first wait, for up to
 * EVAL_ADMISSION_WAIT_MS (10 minutes by default), for the image service's
 * read-only health check to say it admits work; one that is not admitted is
 * recorded as not run and costs nothing. EVAL_IMAGE_SERVICE_URL (loopback,
 * http://127.0.0.1:8791 by default) is the service the harness asks and the
 * address it gives every server it starts (but the unavailable-service one),
 * so `.env.local` cannot point the app elsewhere. EVAL_RESTART_SIGNAL (SIGKILL, the default, SIGINT or
 * SIGTERM) is how the restart scenario stops the server. SIGKILL is a crash,
 * which tests restart recovery. A paid run uses a production build (a paid
 * `next dev` run is refused), which keeps the request open after a graceful
 * signal until the harness kills the process 5 s later.
 */

const MODE = process.env.EVAL_MODE === "dev" ? "dev" : "prod";
const ONLY = process.env.EVAL_ONLY ? new Set(process.env.EVAL_ONLY.split(",").map((s) => s.trim())) : null;
const COMPARE = process.env.EVAL_COMPARE !== "0";
const RESTART_SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL"] as const;
const RESTART_SIGNAL = restartSignal(process.env.EVAL_RESTART_SIGNAL);

function restartSignal(value: string | undefined): (typeof RESTART_SIGNALS)[number] {
  if (!value) return "SIGKILL";
  const signal = RESTART_SIGNALS.find((s) => s === value);
  if (!signal) throw new Error(`EVAL_RESTART_SIGNAL must be one of ${RESTART_SIGNALS.join(", ")}, not ${value}`);
  return signal;
}

const PORTS: Record<"main" | "no-images" | "own", HarnessPort> = { main: 3417, "no-images": 3418, own: 3419 };
/** The conformance message for an optional image replaced by the plan's alternative. */
const OPTIONAL_UNAVAILABLE = /^An optional image for slide \d+ could not be made/;
/** An unused loopback port, so the image client sees "not running". */
const NO_IMAGE_SERVICE_URL = "http://127.0.0.1:8799";

const DRY = process.env.EVAL_DRY === "1";
const TICKET = process.env.EVAL_TICKET?.trim() || DEFAULT_TICKET;
/** Stored messages and the summary name neither the home folder (HOME's and the account's own, which can differ) nor this checkout. */
const HOMES = homeFolders();
const REDACTION = { home: os.homedir(), accountHome: accountHome(), root: ROOT };
const scrub = (text: string) => redactText(text, REDACTION);
const selected = SCENARIOS.filter((s) => !ONLY || ONLY.has(s.id));
// The preflight runs before anything else; a missing cap, a bad setting or a
// worst case over the remaining allowance stops the run here, before any spend.
const CAPS = parseCaps(process.env);
const PLAN = planRun({ scenarios: selected, repeat: parseRepeat(process.env.EVAL_REPEAT), compare: COMPARE, caps: CAPS });
const LEDGER = ledgerPath();
const LEDGER_LABEL = redactPath(LEDGER, HOMES);
const M1_CAP_USD = m1CapUsd();
const HOLD_BACK_USD = parseHoldBack(process.env.EVAL_HOLD_BACK_USD);
const PREFLIGHT = preflight(PLAN, readLedger(LEDGER), M1_CAP_USD, HOLD_BACK_USD);
if (!DRY && !PREFLIGHT.ok) throw new Error(PREFLIGHT.message);
/** Where the durable copy goes; resolved now so a bad EVAL_ARCHIVE_DIR stops the run before any spend. */
const ARCHIVE_DIR = archiveDir(runId());
/** Given to every server and read by the Design-Agent-only arm, so every paid call is capped. */
const CAP_ENV = {
  DIRECTOR_MAX_BUDGET_USD: process.env.DIRECTOR_MAX_BUDGET_USD!.trim(),
  DESIGN_AGENT_MAX_BUDGET_USD: process.env.DESIGN_AGENT_MAX_BUDGET_USD!.trim(),
};

// ---------------------------------------------------------------------------
// The one CLI, the servers' environment and the limits (#232): all resolved
// before the ledger reservation, so a refusal costs nothing.

/** The address the harness polls, so the app cannot be pointed elsewhere by `.env.local`, and the explicit per-call caps, which take precedence over it. */
const serverEnvExtra = (imageUrl: string) => ({ IMAGE_SERVICE_URL: imageUrl, ...CAP_ENV });
/**
 * What a server is given before the CLI is pinned: without `CLAUDE_CLI_PATH`,
 * but with the harness's own, so Next.js's loader shows which CLI the
 * harness's environment and then the `.env` files name.
 */
const UNPINNED_ENV = {
  ...serverEnvironment({ mode: MODE, extra: serverEnvExtra(imageServiceUrl()) }),
  ...(process.env.CLAUDE_CLI_PATH === undefined ? {} : { CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH }),
};
/** The CLI every model call uses: the harness's CLAUDE_CLI_PATH, else the checkout's .env files', else the app's discovery, as a real path. */
const SERVER_CLI = resolveServerCli({ root: ROOT, loaded: loadServerEnv({ root: ROOT, mode: MODE, env: UNPINNED_ENV }), discover: findClaudePath });
// The servers get it as CLAUDE_CLI_PATH; the judges and the arm spawn exactly it.
if (SERVER_CLI.path) pinCli(SERVER_CLI.path);
const CLI_FILE = SERVER_CLI.path ? cliFileFacts(SERVER_CLI.path) : null;
const versions = new Map<string | null, string | null>();
const versionOf = (cli: string | null) => {
  if (!versions.has(cli)) versions.set(cli, cliVersion(cli, cleanEnv()));
  return versions.get(cli)!;
};
const CLI_VERSION = versionOf(SERVER_CLI.path);
/** What each server's process environment holds before Next.js loads the .env files under it. */
const SERVER_ENV = serverEnvironment({ mode: MODE, cliPath: SERVER_CLI.path ?? "", extra: serverEnvExtra(imageServiceUrl()) });
/**
 * What Next.js's own loader leaves a server (the .env files under that
 * environment): the one source of the Design Agent's settings, the Design-Agent-only
 * arm's environment and the names of what the files add. One that is not on the allowlist, or a
 * line the loader's result does not account for, refuses a paid run.
 */
const LOADED = loadServerEnv({ root: ROOT, mode: MODE, env: SERVER_ENV });
const ENV_FILES = LOADED.record;
/**
 * Every variable the harness passes to the servers, the arm and the judges
 * that is not reviewed as harmless (harness-env.ts), by name only. The model
 * variables are fingerprinted by name and value hash instead.
 */
const HARNESS_ENVIRONMENT: HarnessEnvironment = { unreviewedNames: unreviewedHarnessNames(cleanEnv(), (name) => MODEL_ENV_NAME.test(name)) };
/**
 * Every name the servers and the arm (the loader's result, files included) and
 * the judges (the cleaned environment) receive is tested for MODEL, so the run
 * is flagged when one chose a model whose price the CLI's table may lack.
 */
const MODEL_PRICING = modelPricing(receivedNames(LOADED.env, cleanEnv()));
/** The checkout's own folder and its main worktree: the CLI's local settings may come from either. */
const MEMORY_ROOTS = memoryRoots(ROOT);
/**
 * The key names, never values, of the settings files the pinned CLI reads
 * (settings-keys.ts), taken before the reservation. They are neither refused
 * nor overridden.
 */
const SETTINGS_KEYS = recordSettingsKeys({
  home: os.homedir(),
  configDir: LOADED.env.CLAUDE_CONFIG_DIR || undefined,
  project: ROOT,
  mainWorktree: MEMORY_ROOTS.find((r) => r.label === "main worktree")?.path ?? null,
  username: (() => {
    try {
      return os.userInfo().username;
    } catch {
      return null;
    }
  })(),
  cliVersion: versionNumber(CLI_VERSION),
});
/** Set in the harness's own environment: a token or effort limit refuses a paid run. */
const HARNESS_REFUSAL = harnessEnvironmentRefusal(refusedHarnessNames(process.env));
// Refused before any spend unless the servers, the Design-Agent-only arm and
// the judge all run one CLI that CLAUDE_CLI_PATH named; a dry run prints it.
const CLI_PIN = checkCliPin(
  [
    { role: "servers (Director and Design Agent)", path: SERVER_ENV.CLAUDE_CLI_PATH || null, version: CLI_VERSION },
    { role: "Design-Agent-only arm", path: designAgentOnlyCliPath(), version: versionOf(designAgentOnlyCliPath()) },
    { role: "judge", path: judgeCliPath(), version: versionOf(judgeCliPath()) },
  ],
  { explicit: SERVER_CLI.explicit, source: SERVER_CLI.source, file: CLI_FILE }
);
/** The Design Agent's deadline and inactivity limit as the servers see them, and what the Design-Agent-only arm runs under: the same. */
const LIMITS = designAgentLimits(LOADED);
const ARM = designAgentOnlyRun(LOADED);
// The servers share this checkout's data/ folder: the last check refuses a primary worktree, whose live data they would read and write. All of them come before anything is reserved or spent.
const BEFORE_SPEND_CHECKS: Parameters<typeof refusalBeforeSpend>[0] = {
  mode: MODE,
  pin: CLI_PIN,
  envFiles: ENV_FILES,
  harnessRefusal: HARNESS_REFUSAL,
  limits: LIMITS,
  armSettings: ARM.settings,
  worktree: worktreeRefusal(ROOT),
};
const REFUSAL_BEFORE_SPEND = refusalBeforeSpend(BEFORE_SPEND_CHECKS);
/** The same refusal without any `.env` variable name that is not on the allowlist, for a dry run's output. */
const REFUSAL_PRINTABLE = refusalBeforeSpend(BEFORE_SPEND_CHECKS, { printable: true });
if (!DRY && REFUSAL_BEFORE_SPEND) throw new Error(REFUSAL_BEFORE_SPEND);
const STAGES = stageLimits({ designMs: LIMITS.timeoutMs, designArmMs: ARM.limits.timeoutMs, admissionWaitMs: admissionWaitMs() });
/** How long the chat stream may stay quiet: the largest stage limit, the image stage included, plus a margin. */
const CHAT_TIMEOUT_MS = chatTimeoutMs(largestStageMs(STAGES));
const itemShape = (item: PlanItem): ItemShape => {
  const scenario = selected.find((s) => s.id === item.id)!;
  return { kind: scenario.kind, needsImages: !!scenario.needsImages, calls: item.calls, comparison: item.comparison };
};
/** Each item's worst-case duration, the sum of its stage limits plus a margin: its test timeout. A plan no timer can wait for is refused here. */
const ITEM_DURATIONS = new Map(PLAN.items.map((item) => [item.key, itemWorstCase(itemShape(item), STAGES)]));
const limitsRecord = (l: DesignLimitsRecord): DesignLimitsRecord => ({ timeoutMs: l.timeoutMs, timeoutSource: l.timeoutSource, inactivityMs: l.inactivityMs, inactivitySource: l.inactivitySource });
const appClient = (server: RunningServer) => new AppClient(server.origin, { chatTimeoutMs: CHAT_TIMEOUT_MS });

const started = Date.now();
const results: RunResults = {
  runId: runId(),
  startedAt: new Date(started).toISOString(),
  mode: MODE,
  commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim(),
  plan: PLAN,
  spend: { ledger: LEDGER_LABEL, preflight: PREFLIGHT, reservation: null, spend: null, settlement: null, error: null },
  brand: null,
  environment: null,
  archive: null,
  scenarios: [],
  comparisons: [],
  wallMs: 0,
};
/** Exported PNGs of each run's Director arm by pairing key, for the comparison and the revision judge. */
const directorPngs = new Map<string, string[]>();
const sessions = new Map<string, { carouselId: string; sessionId: string | null }>();
/** The pairing key of the run a revision resumes: its source in the same repetition. */
const sourceKey = (scenario: Scenario, record: { repetition: number }) => `${scenario.revisionOf}#${record.repetition}`;

// ---------------------------------------------------------------------------
// One server at a time: they share this checkout's data files.

let current: { key: keyof typeof PORTS; server: RunningServer } | null = null;

/** Checks the pinned file and its version against the pin, and records the result on it; a difference marks the run as not comparable. */
function recheckPinnedCli(at: string) {
  if (!SERVER_CLI.path || !CLI_FILE || !CLI_VERSION) throw new Error("No pinned CLI to check");
  return recordRecheck(CLI_PIN, recheckCli({ path: SERVER_CLI.path, file: CLI_FILE, version: CLI_VERSION }, at, cleanEnv()));
}

/** Checks the loaded .env files against their hashes from check time, records the result, and flags the run as not comparable on a difference. */
const recheckEnvironmentFiles = (at: string) => recordEnvRecheck(ENV_FILES, recheckEnvFiles(LOADED, ROOT, at));

/**
 * The gate every server start passes (start-gate.ts). Once a start is
 * refused, no later item starts a server or a model call: each is recorded as
 * not run when its test begins, before any stage, so settlement charges it
 * nothing. What had started is still charged in full (the ledger never
 * under-counts).
 */
const GATE = new StartGate();

async function serverFor(key: keyof typeof PORTS): Promise<RunningServer> {
  if (current?.key === key) return current.server;
  GATE.assertOpen();
  await stopServer();
  if (!SERVER_CLI.path) throw new Error("No Claude CLI found for the servers");
  // A server must not start on a CLI or .env files that are no longer what the run was checked against.
  const at = `server start on port ${PORTS[key]}`;
  GATE.admit(startChanges(recheckPinnedCli(at).changes, recheckEnvironmentFiles(at).changes));
  const server = await startServer({
    mode: MODE,
    port: PORTS[key],
    cliPath: SERVER_CLI.path,
    env: serverEnvExtra(key === "no-images" ? NO_IMAGE_SERVICE_URL : imageServiceUrl()),
  });
  current = { key, server };
  if (!results.brand) {
    const brand = await appClient(server).ensureBrand(SYNTHETIC_BRAND);
    results.brand = { id: brand.id, name: brand.name };
  }
  return server;
}

/** The synthetic brand's id; every harness carousel is created in it. */
function brandId(): string {
  if (!results.brand) throw new Error("The synthetic brand was not created");
  return results.brand.id;
}

async function stopServer(signal?: NodeJS.Signals) {
  if (!current) return;
  const { server } = current;
  current = null;
  await server.stop(signal);
}

async function save() {
  results.wallMs = Date.now() - started;
  await writeFile(path.join(runDir(), "results.json"), serializeResults(results, REDACTION));
  await writeFile(path.join(runDir(), "summary.md"), renderSummary(results, REDACTION));
}

// ---------------------------------------------------------------------------
// The environment record, the ledger and the durable copy.

/** Where the CLI keeps its session transcripts: the servers' effective CLAUDE_CONFIG_DIR, which the allowlist leaves only the harness's own. */
const CONFIG_DIR = LOADED.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

function environmentRecord(): EnvironmentRecord {
  const home = HOMES;
  const git = gitState(ROOT);
  const serverCli = SERVER_CLI.path;
  const harnessCli = judgeCliPath();
  return {
    commit: git.commit,
    commitDirty: git.dirty,
    node: process.version,
    platform: process.platform,
    cli: {
      server: { path: serverCli ? redactPath(serverCli, home) : null, version: CLI_VERSION, source: SERVER_CLI.source },
      harness: { path: harnessCli ? redactPath(harnessCli, home) : null, version: versionOf(harnessCli) },
      pin: CLI_PIN,
      sessions: null,
    },
    serverEnvFiles: ENV_FILES,
    harnessEnvironment: HARNESS_ENVIRONMENT,
    limits: {
      designAgent: limitsRecord(LIMITS),
      designAgentOnly: ARM.limits,
      chatIdleMs: CHAT_TIMEOUT_MS,
      itemTimeoutsMs: Object.fromEntries([...ITEM_DURATIONS].map(([key, d]) => [key, d.ms])),
    },
    models: {
      designAgent: { models: [], source: "filled in after the run" },
      director: { models: [], source: "not recorded: the server logs the Director's cost and turns only, and its CLI keeps no session" },
      designAgentOnly: [],
      judge: [],
    },
    modelPricing: MODEL_PRICING,
    settingsKeys: SETTINGS_KEYS,
    homeDiffersFromAccount: homeDiffersFromAccount(),
    inheritedConfiguration: inheritedConfiguration({
      home: os.homedir(),
      project: ROOT,
      configDir: LOADED.env.CLAUDE_CONFIG_DIR || undefined,
      memoryRoots: MEMORY_ROOTS,
      // What the servers receive: the harness's cleaned environment, with the explicit settings; the shell's own is compared with it.
      serverEnv: SERVER_ENV,
      harnessEnv: process.env,
      // What the .env files add, from Next.js's own loader.
      envFileVariables: loadedFileVariables(LOADED, (name) => MODEL_ENV_NAME.test(name)),
    }),
    harnessFiles: harnessHashes(path.join(ROOT, "eval", "acceptance")),
  };
}

/** The models and CLI versions seen in this run's usage records and session transcripts. */
function recordModels(env: EnvironmentRecord) {
  const chats = results.scenarios.flatMap((r) => r.chats);
  const arms = results.comparisons.flatMap((c) => (c.baseline ? [c.baseline] : []));
  const designIds = chats.map((c) => c.result.sessionId).filter((id): id is string => !!id);
  const armIds = arms.map((b) => b.sessionId).filter((id): id is string => !!id);
  env.cli.sessions = sessionVersions({
    sessions: [...designIds.map((id) => ({ id, role: "design-agent" as const })), ...armIds.map((id) => ({ id, role: "design-agent-only" as const }))],
    withoutSession: chats.filter((c) => !c.result.sessionId && sawStage(c.result, "designing")).length + arms.filter((b) => !b.sessionId).length,
    configDir: CONFIG_DIR,
    configured: versionNumber(env.cli.server.version),
    director: directorProof(env.cli.pin, env.cli.server.version),
    judge: judgeProof(env.cli.pin, env.cli.server.version),
  });
  const unreadable = env.cli.sessions.sessions.filter((x) => x.error).length;
  const design = transcriptModels(designIds, CONFIG_DIR);
  env.models.designAgent = design.length
    ? { models: design, source: `the CLI's session transcripts; the server log does not record the model${unreadable ? `; ${unreadable} transcript(s) unreadable` : ""}` }
    : { models: [], source: `not found: the server log does not record the model and no session transcript was found${unreadable ? `; ${unreadable} transcript(s) unreadable` : ""}` };
  const union = (lists: (string[] | undefined)[]) => [...new Set(lists.flatMap((l) => l ?? []))].sort();
  env.models.designAgentOnly = union(results.comparisons.map((c) => c.baseline?.models));
  env.models.judge = union([
    ...results.scenarios.flatMap((r) => [r.judge?.models, r.revisionJudge?.models]),
    ...results.comparisons.flatMap((c) => [c.baselineJudge?.models, c.pairwise?.result.models]),
  ]);
}

const RUN = { runId: results.runId, commit: results.commit, ticket: TICKET };
const ledgerLabel = `acceptance ${PLAN.scenarioIds.join(",")} x${PLAN.repeat}, compare ${PLAN.compare ? "on" : "off"}, ${MODE}`;

if (!DRY) {
  beforeAll(() => {
    // The preflight is checked again against the ledger as it is now and the
    // reservation appended, as one step under the ledger lock.
    const { check, reservation } = reserveRun({
      ledger: LEDGER,
      plan: PLAN,
      capUsd: M1_CAP_USD,
      holdBackUsd: HOLD_BACK_USD,
      run: RUN,
      note: `${ledgerLabel}: worst case reserved before the run`,
    });
    results.spend = { ledger: LEDGER_LABEL, preflight: check, reservation, spend: null, settlement: null, error: null };
    results.environment = environmentRecord();
  });

  afterAll(async () => {
    const problems: string[] = [];
    // Each step is tried on its own: none may stop the settlement below.
    const attempt = async (what: string, step: () => unknown) => {
      try {
        await step();
      } catch (err) {
        problems.push(`${what}: ${scrub((err as Error).message)}`);
      }
    };
    await attempt("stopping the server", () => stopServer());
    // The Director's and the judge's versions are shown by this check (neither keeps a transcript), so it comes before the models are recorded.
    await attempt("checking the pinned CLI again", () => recheckPinnedCli(END_OF_RUN));
    await attempt("checking the .env files again", () => recheckEnvironmentFiles(END_OF_RUN));
    await attempt("recording models", () => results.environment && recordModels(results.environment));
    await attempt("saving results", save);
    // The settlement charges every call that started (budget.ts), also when the
    // harness failed or a test timed out. If it cannot be recorded the
    // reservation stands, and counts in full.
    if (results.spend?.reservation) {
      try {
        const { spend, settlement } = settleRun({ ledger: LEDGER, results, plan: PLAN, reservedUsd: results.spend.reservation.costUsd, run: RUN, label: ledgerLabel });
        results.spend.spend = spend;
        results.spend.settlement = settlement;
      } catch (err) {
        problems.push(`settling the ledger: ${scrub((err as Error).message)}`);
      }
    }
    if (results.spend && problems.length) results.spend.error = problems.join("; ");
    await attempt("saving results", save);
    try {
      const files = archiveRun(runDir(), ARCHIVE_DIR);
      results.archive = { dir: redactPath(ARCHIVE_DIR, HOMES), files: files.length, error: null };
    } catch (err) {
      results.archive = { dir: redactPath(ARCHIVE_DIR, HOMES), files: 0, error: scrub((err as Error).message) };
    }
    await attempt("saving results", save);
    console.info(`[acceptance] results in ${redactPath(runDir(), HOMES)}; archived to ${redactPath(ARCHIVE_DIR, HOMES)}`);
  }, 120_000);
}

// ---------------------------------------------------------------------------
// Evidence helpers.

const lastOf = <T extends ChatResult["events"][number]["event"]["type"]>(chat: ChatResult, type: T) =>
  chat.events.filter((e) => e.event.type === type).at(-1)?.event as Extract<ChatResult["events"][number]["event"], { type: T }> | undefined;

function runAssets(carousel: Carousel, runIds: string[]) {
  return (carousel.assets ?? []).filter((a) => runIds.includes(a.runId));
}

function placed(carousel: Carousel, url: string): boolean {
  return carousel.slides.some((slide) => slide.html.includes(url));
}

function imageEvidence(record: ScenarioRecord): ImageServiceEvidence {
  record.imageService ??= {};
  return record.imageService;
}

const sawStage = (chat: ChatResult, stage: string) => chat.events.some((e) => e.event.type === "stage" && e.event.stage === stage);
const endedOf = (runRecord: Record<string, unknown> | null) => (runRecord?.ended as { outcome?: string; reason?: string } | null | undefined) ?? null;

async function judgeContext(scenario: Scenario, carousel: Carousel): Promise<JudgeContext> {
  const brand = await resolveBrandForCarousel(carousel);
  return {
    scenarioId: scenario.id,
    message: scenario.message,
    aspectRatio: scenario.aspectRatio,
    objective: scenario.objective,
    audience: scenario.audience,
    constraints: scenario.constraints,
    brand: brand.name
      ? `${brand.name}; colours ${Object.entries(brand.colors)
          .map(([role, hex]) => `${role} ${hex}`)
          .join(", ")}; heading font ${brand.fonts.heading}, body font ${brand.fonts.body}; style and voice: ${brand.styleKeywords.join(", ") || "none stated"}. Judge brandCoherent against this brand.`
      : "No brand configured; the studio's professional defaults apply, so judge internal consistency.",
    notes: scenario.notes,
  };
}

function newRecord(scenario: Scenario, item: PlanItem): ScenarioRecord {
  return {
    id: scenario.id,
    repetition: item.repetition,
    key: item.key,
    title: scenario.title,
    kind: scenario.kind,
    server: { port: 0, mode: MODE, readyMs: 0 },
    carouselId: null,
    chats: [],
    outcome: "not run",
    blocked: null,
    deviations: [],
    slides: null,
    generatedThisRun: null,
    runRecord: null,
    costs: null,
    logEntries: 0,
    export: null,
    judge: null,
    revisionJudge: null,
    imageService: null,
    review: null,
    reuse: null,
    afterStop: null,
    checks: [],
    observations: [],
    wallMs: 0,
    harnessError: null,
    finished: false,
  };
}

async function chat(
  record: ScenarioRecord,
  app: AppClient,
  label: string,
  body: { carouselId: string; message: string; sessionId?: string | null; retryRunId?: string },
  options: ChatOptions = {}
): Promise<ChatResult> {
  // The stored plan exists only while the run designs, so it is read as design begins.
  const atDesign: { run: Promise<Record<string, unknown> | null> | null } = { run: null };
  const result = await app.chat(body, {
    ...options,
    onEvent: (timed) => {
      if (!atDesign.run && timed.event.type === "stage" && timed.event.stage === "designing") atDesign.run = readRunRecord(body.carouselId);
      options.onEvent?.(timed);
    },
  });
  const run = atDesign.run ? await atDesign.run : null;
  record.chats.push({
    label,
    message: body.message,
    retryRunId: body.retryRunId,
    sessionId: body.sessionId ?? null,
    result,
    stages: stageDurations(result),
    planAtDesign: atDesign.run ? { assets: plannedAssets(run), summary: planSummary(run) } : null,
  });
  return result;
}

/**
 * Reads the carousel's costs and timings from the server log since `logFrom`
 * into the record. A read of the log file, so it also works after the server
 * has stopped, which the restart scenario's early returns need.
 */
async function collectCosts(record: ScenarioRecord, server: RunningServer, carouselId: string, logFrom: number) {
  const { entries, ...rest } = await serverCosts(server.logPath, carouselId, logFrom);
  record.costs = rest;
  record.logEntries = entries.length;
  return rest;
}

/** Fills in the outcome, assets, costs and export for a finished scenario; judges it when it completed. */
async function finish(
  record: ScenarioRecord,
  scenario: Scenario,
  app: AppClient,
  server: RunningServer,
  carouselId: string,
  last: ChatResult,
  logFrom: number,
  /** `chatFrom`: where the last chat's own log lines start, when `logFrom` also covers an earlier attempt. */
  options: { judge: boolean; sampleHealth?: boolean; chatFrom?: number }
) {
  const blocked = lastOf(last, "blocked");
  // A refusal is diagnosed best by what the service says right after it.
  const sampleHealth = options.sampleHealth !== false;
  if (sampleHealth && blocked?.code === "image_failed") (imageEvidence(record).afterFailure ??= []).push(await health());
  const deviations = lastOf(last, "deviations");
  const error = lastOf(last, "error");
  record.blocked = blocked ? { code: blocked.code, message: blocked.message, retryRunId: blocked.retryRunId } : null;
  record.deviations = deviations?.items ?? [];
  record.runRecord = await readRunRecord(carouselId);
  const ended = (record.runRecord?.ended as { outcome?: string } | null | undefined)?.outcome ?? "not ended";
  record.outcome = blocked ? `blocked: ${blocked.code}` : error ? `error: ${error.code}` : last.aborted ? `cancelled (${ended})` : ended;

  const carousel = await app.getCarousel(carouselId);
  record.slides = carousel.slides.length;
  record.generatedThisRun = runAssets(carousel, [String(record.runRecord?.runId ?? "")]).length;
  const rest = await collectCosts(record, server, carouselId, logFrom);
  if (rest.imageFailures.length > 0) {
    const evidence = imageEvidence(record);
    // Only a failure in this chat calls for a sample now; an earlier attempt's was sampled when it happened.
    const failedNow = options.chatFrom === undefined ? true : (await serverCosts(server.logPath, carouselId, options.chatFrom)).imageFailures.length > 0;
    if (sampleHealth && failedNow && blocked?.code !== "image_failed") (evidence.afterFailure ??= []).push(await health());
    evidence.failureReasons = rest.imageFailures.map((f) => ({
      key: typeof f.key === "string" ? f.key : null,
      code: typeof f.code === "string" ? f.code : null,
      reason: typeof f.reason === "string" ? f.reason : null,
    }));
  }

  if (ended === "completed" && carousel.slides.length > 0) {
    const exported = await app.exportPngs(carouselId, path.join(runDir(), `${scenario.id}-r${record.repetition}-director`));
    record.export = exported.ok
      ? { ok: true, pngs: exported.files.length, files: exported.files, durationMs: exported.durationMs }
      : { ok: false, pngs: 0, error: `${exported.status} ${exported.error}`, durationMs: exported.durationMs };
    if (exported.ok) {
      directorPngs.set(record.key, exported.files);
      if (options.judge) record.judge = await judgeOutcome(await judgeContext(scenario, carousel), exported.files);
    }
  }
  if (ended === "completed") {
    const plan = record.chats.at(-1)?.planAtDesign?.summary ?? null;
    record.review = {
      creativeBrief: carousel.creativeBrief ?? null,
      plan,
      planNote: plan ? null : "no stored plan: only a plan with generated images is stored, and only while its run lasts",
      directorPlan: record.costs?.directorPlan ?? null,
    };
  }
  return carousel;
}

function check(record: ScenarioRecord, name: string, pass: boolean, evidence: string) {
  record.checks.push({ name, pass, evidence: `${evidence} [server ${MODE}]` } satisfies Check);
}

/** The deterministic checks shared by every scenario that should design. */
async function designChecks(record: ScenarioRecord, scenario: Scenario, carousel: Carousel, last: ChatResult, server: RunningServer) {
  const runId = String(record.runRecord?.runId ?? "");
  const assets = runAssets(carousel, [runId]);
  const tasks = runTasks(record.runRecord);
  const planned = record.chats.at(-1)?.planAtDesign?.assets ?? null;
  check(record, "run completed", record.outcome === "completed", `outcome ${record.outcome}; stream error ${last.streamError ?? "none"}`);
  if (scenario.expect.slides !== undefined)
    check(record, "slide count", carousel.slides.length === scenario.expect.slides, `${carousel.slides.length} slides, expected ${scenario.expect.slides}`);
  const g = scenario.expect.generated;
  if (g !== undefined) {
    const ok = g === "none" ? assets.length === 0 : g === "some" ? assets.length > 0 : assets.length === g;
    check(record, "generated images attached", ok, `${assets.length} attached by this run, expected ${g}`);
  }
  if (scenario.expect.generatedPlaced && assets.length && !planned) {
    // Without the plan's assignments only "somewhere in the carousel" can be checked.
    const missing = assets.filter((a) => !placed(carousel, a.url));
    check(record, "every generated image placed", missing.length === 0, missing.length ? `not placed: ${missing.map((a) => a.url).join(", ")}` : `${assets.length} of ${assets.length} placed somewhere; the plan was not captured`);
  }
  if (record.outcome === "completed" && tasks.length > 0) {
    const t = checkTasks(tasks);
    check(record, "image tasks committed", t.pass, t.evidence);
    const h = await checkFileHashes(ROOT, tasks, assets);
    check(record, "attached files match their hashes", h.pass, h.evidence);
    if (planned) {
      const p = checkPlacement(planned, tasks, carousel.slides);
      check(record, "each generated image on its planned slides", p.pass, p.evidence);
    } else {
      check(record, "each generated image on its planned slides", false, "the stored plan was not captured when design began");
    }
    const v = await checkPreview(server.origin, assets);
    check(record, "preview serves each image", v.pass, v.evidence);
  }
  if (scenario.expect.referencePlaced) {
    const refs = carousel.referenceImages ?? [];
    check(record, "uploaded photo placed", refs.some((r) => placed(carousel, r.url)), refs.map((r) => `${r.url}: ${placed(carousel, r.url) ? "placed" : "not placed"}`).join("; ") || "no reference");
  }
  if (scenario.expect.typographyOnly) {
    const withImages = carousel.slides.filter((sl) => /<img\b|\/uploads\//i.test(sl.html));
    check(record, "typography only", withImages.length === 0, withImages.length ? `${withImages.length} slide(s) contain an image` : "no slide contains an image");
  }
  if (scenario.expect.readsSources) {
    const read = record.chats.some((c) => c.result.events.some((e) => e.event.type === "stage" && e.event.stage === "reading-sources"));
    check(record, "linked page read", read, read ? "reading-sources stage shown" : "no reading-sources stage");
  }
  check(record, "export", !!record.export?.ok && record.export.pngs === carousel.slides.length, record.export ? `${record.export.pngs} PNG(s)${record.export.error ? `; ${record.export.error}` : ""}` : "not exported");
  if (record.export?.ok && record.export.files) {
    const e = await checkExportFiles(record.export.files, carousel.aspectRatio);
    check(record, "exported PNGs decode at the carousel's size", e.pass, e.evidence);
  }
  // An optional image the service could not make, replaced by the plan's own
  // alternative and reported to the user, is the designed outcome, not a miss.
  const disclosed = record.deviations.filter((d) => OPTIONAL_UNAVAILABLE.test(d));
  const unexpected = record.deviations.filter((d) => !OPTIONAL_UNAVAILABLE.test(d));
  if (disclosed.length) record.observations.push(`disclosed optional-image fallbacks: ${disclosed.join(" ")}`);
  check(record, "matches the plan", unexpected.length === 0, unexpected.length ? unexpected.join(" ") : disclosed.length ? "only disclosed optional-image fallbacks" : "no deviations reported");
}

// ---------------------------------------------------------------------------
// Scenario drivers.

/**
 * Sends an explicit retry of a blocked run and proves each image staged
 * before it was reused: no new image for its key, and the same hash and the
 * same file once attached. Waits for the image service to admit work first,
 * within the bound; returns the retry's result, or null when it was not sent.
 */
async function retryAndVerify(
  record: ScenarioRecord,
  scenario: Scenario,
  server: RunningServer,
  carouselId: string,
  runId: string,
  snapshot: StagedSnapshot,
  logFrom: number
): Promise<{ chat: ChatResult; carousel: Carousel } | null> {
  record.reuse = { snapshot, attempted: false };
  const admission = await waitForAdmission();
  imageEvidence(record).retryAdmission = admission;
  if (!admission.admitted) {
    record.observations.push("retry not attempted: the image service was not admitting");
    return null;
  }
  const app = appClient(server);
  const retryFrom = await logOffset(server.logPath);
  const retry = await chat(record, app, "explicit retry", { carouselId, message: "Retry", retryRunId: runId });
  record.reuse.attempted = true;
  const carousel = await finish(record, scenario, app, server, carouselId, retry, logFrom, { judge: true, chatFrom: retryFrom });
  const entries = await logEntries(server.logPath, carouselId, retryFrom);
  const line = entries.find((e) => e.tag === "[creative-run] retry")?.fields;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const checks = await verifyReuse(ROOT, snapshot, {
    runRecord: record.runRecord,
    assets: carousel.assets ?? [],
    stagedAfterRetry: entries.filter((e) => e.tag === "[creative-run] image staged").map((e) => String(e.fields.key)),
    retryLine: line ? { reused: num(line.reused), pending: num(line.pending) } : null,
  });
  for (const { name, verdict } of checks) check(record, name, verdict.pass, verdict.evidence);
  await designChecks(record, scenario, carousel, retry, server);
  return { chat: retry, carousel };
}

/**
 * For a run that blocked because an image could not be made after at least
 * one other was staged: retries it and verifies the reuse. Null when the run
 * is not such a partial run, or the retry was not sent.
 */
async function retryPartialRun(record: ScenarioRecord, scenario: Scenario, server: RunningServer, carouselId: string, logFrom: number) {
  const blocked = record.blocked;
  if (blocked?.code !== "image_failed" || !blocked.retryRunId) return null;
  const snapshot = await snapshotStaged(ROOT, await readRunRecord(carouselId));
  if (snapshot.items.length === 0) return null;
  record.observations.push(`partial run: ${snapshot.items.length} image(s) staged before it blocked (${record.outcome}); retrying it`);
  return retryAndVerify(record, scenario, server, carouselId, blocked.retryRunId, snapshot, logFrom);
}

async function runIntegration(scenario: Scenario, record: ScenarioRecord) {
  const server = await serverFor("main");
  const app = appClient(server);
  let carouselId: string;
  let sessionId: string | null = null;
  if (scenario.revisionOf) {
    const prior = sessions.get(sourceKey(scenario, record));
    if (!prior) {
      // A revision of a carousel whose first run did not complete tests something else.
      record.outcome = "skipped";
      record.observations.push(`needs ${sourceKey(scenario, record)} to complete in the same run`);
      return;
    }
    carouselId = prior.carouselId;
    sessionId = prior.sessionId;
  } else {
    carouselId = (await app.createCarousel(`Acceptance ${record.key}`, scenario.aspectRatio, brandId())).id;
    if (scenario.reference) await app.addReference(carouselId, await founderPhoto(), "founder-photo.png");
  }
  record.carouselId = carouselId;
  const before = await app.getCarousel(carouselId);
  const logFrom = await logOffset(server.logPath);
  let last = await chat(record, app, "request", { carouselId, message: scenario.message, sessionId });
  let carousel = await finish(record, scenario, app, server, carouselId, last, logFrom, { judge: true });
  const retried = await retryPartialRun(record, scenario, server, carouselId, logFrom);
  if (retried) ({ chat: last, carousel } = retried);
  else await designChecks(record, scenario, carousel, last, server);
  if (record.outcome === "completed") sessions.set(record.key, { carouselId, sessionId: last.sessionId });

  if (scenario.kind === "revision") {
    check(record, "session resumed", !!sessionId && !lastOf(last, "error"), `resumed ${sessionId ? "the earlier session" : "nothing"}; error ${lastOf(last, "error")?.code ?? "none"}`);
    const b = before.creativeBrief;
    const a = carousel.creativeBrief;
    check(record, "brief kept", !!b && !!a && !!a.objective && !!a.audience, `before: ${b?.objective?.value ?? "-"} / ${b?.audience?.value ?? "-"}; after: ${a?.objective?.value ?? "-"} / ${a?.audience?.value ?? "-"}`);
    record.observations.push(`central message before "${b?.centralMessage?.value ?? "-"}", after "${a?.centralMessage?.value ?? "-"}"`);
    const plan = record.costs?.directorPlan;
    if (plan) record.observations.push(`revision plan: requestType ${plan.requestType}, generate ${plan.generate}, reuse ${plan.reuse}`);
    // Whether the revision kept the brief and made the change, judged from the sets before and after.
    const beforePngs = directorPngs.get(sourceKey(scenario, record));
    const afterPngs = directorPngs.get(record.key);
    const source = SCENARIOS.find((s) => s.id === scenario.revisionOf);
    if (record.outcome === "completed" && beforePngs && afterPngs && source) {
      record.revisionJudge = await judgeRevision({ ...(await judgeContext(scenario, carousel)), originalMessage: source.message }, { before: beforePngs, after: afterPngs });
    } else {
      record.observations.push("revision not judged against the set before it: the revision did not complete with an export");
    }
  }
}

async function runImageServiceUnavailable(scenario: Scenario, record: ScenarioRecord) {
  const server = await serverFor("no-images");
  const app = appClient(server);
  const carouselId = (await app.createCarousel(`Acceptance ${record.key}`, scenario.aspectRatio, brandId())).id;
  record.carouselId = carouselId;
  const logFrom = await logOffset(server.logPath);
  const last = await chat(record, app, "request", { carouselId, message: scenario.message });
  // This server talks to an unused port, so the real service's health says nothing about it.
  const carousel = await finish(record, scenario, app, server, carouselId, last, logFrom, { judge: false, sampleHealth: false });
  const plan = record.costs?.directorPlan;
  const required = typeof plan?.required === "number" ? plan.required : null;
  const generate = typeof plan?.generate === "number" ? plan.generate : null;
  if (record.blocked) {
    // What the Director's plan needs that this machine lacks, from its log line: a reason besides the stop message.
    const director = (await logEntries(server.logPath, carouselId, logFrom)).filter((e) => e.tag === "[director] plan finished").at(-1);
    for (const { name, verdict } of checkUnavailableServiceStop(record.blocked, carousel, director?.lists?.unavailable ?? null)) check(record, name, verdict.pass, verdict.evidence);
    record.observations.push(`behaviour: blocked before design (plan asked for ${generate ?? "?"} image(s), ${required ?? "?"} required)`);
  } else {
    // Designing without the requested photo is only acceptable if no required image was planned.
    check(record, "no silent fallback", record.outcome === "completed" && required === 0, `outcome ${record.outcome}; plan generate ${generate ?? "?"}, required ${required ?? "?"}`);
    record.observations.push(`behaviour: designed without images (plan generate ${generate ?? "?"}, required ${required ?? "?"})`);
  }
}

/** Waits for the image service to admit work again, so the next scenario does not meet a job a stopped run left behind. */
async function cooldown(record: ScenarioRecord) {
  const admission = await waitForAdmission();
  imageEvidence(record).cooldown = admission;
  if (!admission.admitted) record.observations.push("the image service was still not admitting at the end of the scenario");
}

/** Whether the image service went on with an image after `after`, in plain words. */
function busyLine(after: string, busy: BusyObservation): string {
  return busy.busySeen
    ? `after ${after} the image service stayed busy for about ${((busy.busyForMs ?? 0) / 1000).toFixed(0)} s${busy.settled ? "" : " and was still busy when observation ended"}`
    : `after ${after} the image service was never seen busy`;
}

async function runCancel(scenario: Scenario, record: ScenarioRecord) {
  const server = await serverFor("main");
  const app = appClient(server);
  const carouselId = (await app.createCarousel(`Acceptance ${record.key}`, scenario.aspectRatio, brandId())).id;
  record.carouselId = carouselId;
  const logFrom = await logOffset(server.logPath);
  const stop: { logAt: Promise<number> | null } = { logAt: null };
  const last = await chat(
    record,
    app,
    "request, stopped during images",
    { carouselId, message: scenario.message },
    {
      abortWhen: ({ event }) => event.type === "stage" && event.stage === "preparing-images" && /^1 of /.test(event.detail ?? ""),
      // Long enough for the first image to be in flight.
      abortDelayMs: 5_000,
      onAbort: () => {
        stop.logAt = logOffset(server.logPath);
      },
    }
  );
  // Whether the service goes on with the image the cancelled request started.
  if (last.aborted) imageEvidence(record).afterCancel = await observeBusy();
  const idle = await app.waitUntilIdle(carouselId);
  const carousel = await finish(record, scenario, app, server, carouselId, last, logFrom, { judge: false });
  const nothingChanged = carousel.slides.length === 0 && (carousel.assets ?? []).length === 0;
  const changes = `${carousel.slides.length} slides, ${(carousel.assets ?? []).length} assets`;

  if (!last.aborted || !stop.logAt) {
    // For example, the first image was refused before the stop could happen.
    record.observations.push(`cancellation not exercised: the run ended (${record.outcome}) before the stop`);
    check(record, "nothing attached or changed", nothingChanged, changes);
    await cooldown(record);
    return;
  }
  const ended = endedOf(record.runRecord);
  const tasks = runTasks(record.runRecord);
  const runId = String(record.runRecord?.runId ?? "");
  check(record, "stopped during images", sawStage(last, "preparing-images"), `stages ${last.events.filter((e) => e.event.type === "stage").map((e) => (e.event as { stage: string }).stage).join(" > ")}`);
  check(record, "run recorded as stopped", ended?.outcome === "stopped" && ended.reason === "cancelled", `ended ${ended?.outcome ?? "-"} (${ended?.reason ?? "-"}); idle ${idle}`);
  check(
    record,
    "image in flight abandoned",
    tasks.some((t) => t.state === "abandoned") && !tasks.some((t) => t.state === "running"),
    tasks.map((t) => `${t.key}=${t.state}`).join(", ") || "no tasks"
  );
  check(record, "staging removed", !!runId && !existsSync(stagingDir(ROOT, runId)), runId ? `staging folder ${existsSync(stagingDir(ROOT, runId)) ? "still present" : "removed"}` : "no run");
  const after = (await logEntries(server.logPath, carouselId, await stop.logAt)).filter((e) => e.tag === "[creative-run] image staged");
  check(record, "no image staged after the stop", after.length === 0, after.length ? `staged after the stop: ${after.map((e) => e.fields.key).join(", ")}` : "none");
  check(record, "nothing attached or changed", nothingChanged, changes);
  const busy = imageEvidence(record).afterCancel;
  if (busy) record.observations.push(busyLine("the stop", busy));
  await cooldown(record);
}

async function runRestartRetry(scenario: Scenario, record: ScenarioRecord) {
  let server = await serverFor("own");
  const app = appClient(server);
  const carouselId = (await app.createCarousel(`Acceptance ${record.key}`, scenario.aspectRatio, brandId())).id;
  record.carouselId = carouselId;
  const logFrom = await logOffset(server.logPath);
  const stop: { promise: Promise<void> | null } = { promise: null };
  const first = await chat(record, app, `request, server stopped during images (${RESTART_SIGNAL})`, { carouselId, message: scenario.message }, {
    onEvent: ({ event }) => {
      if (stop.promise || event.type !== "stage" || event.stage !== "preparing-images") return;
      const m = (event.detail ?? "").match(/^(\d+) of (\d+)$/);
      // Stop as the third image (or the last, for fewer) starts.
      if (m && Number(m[1]) === Math.min(3, Number(m[2])) && Number(m[2]) > 0) stop.promise = stopServer(RESTART_SIGNAL);
    },
  });
  if (stop.promise) await stop.promise;
  else {
    await finish(record, scenario, app, server, carouselId, first, logFrom, { judge: false });
    if (sawStage(first, "preparing-images") && record.blocked) {
      record.observations.push(`blocked before the stop point: ${record.blocked.code}`);
      if (await retryPartialRun(record, scenario, server, carouselId, logFrom)) return;
    } else {
      record.observations.push(sawStage(first, "preparing-images") ? `the run ended (${record.outcome}) before the stop point` : "the server was never stopped: the run did not reach the image stage");
    }
    check(record, "reached the stop point", false, `outcome ${record.outcome}`);
    return;
  }

  // The state the stop left, before any recovery runs.
  const afterStop = await readRunRecord(carouselId);
  const runId = String(afterStop?.runId ?? "");
  const snapshot = await snapshotStaged(ROOT, afterStop);
  const ended = endedOf(afterStop);
  const tasks = runTasks(afterStop);
  record.afterStop = {
    signal: RESTART_SIGNAL,
    ended: afterStop?.ended ?? null,
    tasks: tasks.map((t) => ({ key: t.key, state: t.state, sha256: t.sha256 ?? null })),
    staging: snapshot,
  };
  record.observations.push(
    `after the stop (${RESTART_SIGNAL}): run ${ended?.outcome ?? "not settled"}; tasks ${tasks.map((t) => `${t.key}=${t.state}`).join(", ")}; staging folder ${snapshot.stagingDirExists ? "present" : "absent"}`
  );
  // Whether the service goes on with the image the stopped server had started.
  const busy = await observeBusy();
  imageEvidence(record).afterServerStop = busy;
  record.observations.push(busyLine("the server stopped", busy));
  if (ended?.outcome === "stopped" && RESTART_SIGNAL !== "SIGKILL") {
    // The route's cancellation ran before the process exited: staging is gone and the run cannot be retried.
    record.outcome = "not exercised: the graceful stop cancelled the run";
    record.observations.push(`${RESTART_SIGNAL} let the server cancel the run, so this exercised cancellation, not restart recovery; SIGKILL, the default, tests a crash`);
    await collectCosts(record, server, carouselId, logFrom); // the Director ran; its cost is in the log
    return;
  }
  if (snapshot.items.length === 0) record.observations.push("nothing was staged before the stop, so reuse cannot be shown");

  server = await serverFor("own");
  record.server.readyMs = server.readyMs;
  const status = await appClient(server).generation(carouselId);
  record.observations.push(`after the restart: generating ${status.generating}, interrupted ${status.interrupted}`);
  const retried = await retryAndVerify(record, scenario, server, carouselId, runId, snapshot, logFrom);
  if (!retried) {
    check(record, "retry after restart", false, "not attempted: the image service was not admitting");
    await collectCosts(record, server, carouselId, logFrom); // the first chat's Director cost is in the log
  }
}

// ---------------------------------------------------------------------------
// Comparison: the Design Agent alone on a fresh carousel, then a blind pairwise judgment.

function newComparison(scenario: Scenario, item: PlanItem): ComparisonRecord {
  return {
    id: scenario.id,
    repetition: item.repetition,
    key: item.key,
    baselineCarouselId: null,
    baseline: null,
    baselineExport: null,
    baselineJudge: null,
    pairwise: null,
    skipped: null,
    notJudged: null,
    harnessError: null,
    finished: false,
  };
}

/** Fills `record` in place, so what was measured before a throw or a timeout stays in it and is charged. */
async function runComparison(scenario: Scenario, item: PlanItem, record: ComparisonRecord, notRun: string | null): Promise<void> {
  const director = directorPngs.get(item.key);
  // An item that was not run says why; otherwise, for example, the Director arm was blocked because an image could not be made.
  const skipped = skippedComparisonReason({ notRun, directorExport: !!director });
  if (skipped || !director) {
    record.skipped = skipped ?? "the Director arm produced no export to compare";
    return;
  }
  const server = await serverFor("main");
  const app = appClient(server);
  const carousel = await app.createCarousel(`Acceptance ${item.key} baseline`, scenario.aspectRatio, brandId());
  record.baselineCarouselId = carousel.id;
  if (scenario.reference) await app.addReference(carousel.id, await founderPhoto(), "founder-photo.png");
  const cliPath = designAgentOnlyCliPath();
  if (!cliPath || !ARM.settings.ok) throw new Error("The Design-Agent-only arm has no pinned CLI or accepted settings");
  record.baseline = await runDesignAgentOnly({ origin: server.origin, carouselId: carousel.id, message: scenario.message, cliPath, env: ARM.env, settings: ARM.settings });
  const after = await app.getCarousel(carousel.id);
  if (after.slides.length === 0) {
    record.baselineExport = { ok: false, pngs: 0, error: "no slides" };
    return;
  }
  const exported = await app.exportPngs(carousel.id, path.join(runDir(), `${scenario.id}-r${item.repetition}-baseline`));
  record.baselineExport = exported.ok ? { ok: true, pngs: exported.files.length } : { ok: false, pngs: 0, error: `${exported.status} ${exported.error}` };
  if (!exported.ok) return;
  record.notJudged = notJudgedReason(record.baseline);
  if (record.notJudged) return; // an arm that was stopped or failed left an unfinished set
  const context = await judgeContext(scenario, after);
  record.baselineJudge = await judgeOutcome(context, exported.files);
  record.pairwise = await judgePairwise(context, { director, baseline: exported.files });
}

// ---------------------------------------------------------------------------

if (DRY) {
  // The plan only: no server, no model, no ledger entry.
  describe("creative run acceptance (dry run)", () => {
    it("fits the remaining M1 allowance", () => {
      console.info(renderPlan(PLAN, PREFLIGHT, LEDGER_LABEL));
      // What would refuse a paid run is printed instead, the check of the worktree included.
      // A dry run's output follows summary.md's rule: no variable, settings key or file name that came from the operator's machine; a paid run's refusal, in the operator's terminal, names them.
      console.info(`[acceptance] ${REFUSAL_PRINTABLE ? `A paid run would be refused: ${REFUSAL_PRINTABLE}` : "No check made before the ledger reservation would refuse a paid run."}`);
      console.info(`[acceptance] CLI check: ${CLI_PIN.message}`);
      console.info(
        `[acceptance] CLI: ${SERVER_CLI.explicit ? "named by" : "NOT pinned, found by"} ${SERVER_CLI.source}; file ${CLI_FILE ? `${CLI_FILE.size} bytes, SHA-256 ${CLI_FILE.sha256.slice(0, 12)}` : "not readable"}; version ${CLI_VERSION ?? "unknown"}.`
      );
      const addedNames = splitAddedNames(ENV_FILES);
      console.info(
        `[acceptance] Variables the servers' .env files add beyond the harness's environment, as Next.js's loader leaves them (the allowlist's names are named, any other is counted): ${addedNames.named.map((v) => `${v.name} (${v.file})`).join(", ") || "none"}${addedNames.notAllowed ? `; ${addedNames.notAllowed} not on the allowlist, not named` : ""}.`
      );
      console.info(`[acceptance] ${printableMessage(ENV_FILES)}`);
      const unreviewed = countNamesByClass(HARNESS_ENVIRONMENT.unreviewedNames);
      console.info(
        `[acceptance] ${unreviewed.total} variable(s) in the harness's own environment that reach every server, judge and arm are not reviewed as harmless (${describeNameClasses(unreviewed)}); counts only here and in summary.md: the names (never values; model variables are fingerprinted by name and value hash instead) are in results.json, which is never committed.`
      );
      console.info(
        `[acceptance] ${MODEL_PRICING.selectionVariables.length} variable(s) whose name contains MODEL among those the servers, arm and judges receive (counted, not named; the names are in results.json)${MODEL_PRICING.unverified ? "; the run is flagged, because the CLI's price for a model its table lacks is not shown" : ""}.`
      );
      // The settings files are recorded by key name in results.json and never refused: the Design Agent and the arm load the first three kinds, managed settings apply to every role.
      // Here, as in summary.md, only the CLI's own key names are named, and every other name, the names under env and the drop-in files' names are counted.
      console.info(
        `[acceptance] Settings files the pinned CLI reads (never values; the CLI's own key names are named, any other name is counted; the Design Agent and the Design-Agent-only arm load user, project and project-local; managed settings apply to every role):`
      );
      for (const line of describeSettingsFiles(SETTINGS_KEYS)) console.info(`[acceptance]   ${line}.`);
      const settingsBanner = settingsBannerLines(SETTINGS_KEYS);
      for (const line of settingsBanner) console.info(`[acceptance] ${line}`);
      if (settingsBanner.length === 0) console.info("[acceptance] No settings file holds a key that can change a model call, and every source could be read.");
      console.info(
        `[acceptance] HOME ${homeDiffersFromAccount() === null ? "could not be compared with" : homeDiffersFromAccount() ? "differs from" : "is"} the account's home folder; both are redacted in every stored path, and neither is printed.`
      );
      const sec = (ms: number | null) => (ms === null ? "none" : `${Math.round(ms / 1000)} s`);
      console.info(
        `[acceptance] Design Agent limits, servers: deadline ${sec(LIMITS.timeoutMs)} (${LIMITS.timeoutSource}), inactivity ${sec(LIMITS.inactivityMs)} (${LIMITS.inactivitySource})${LIMITS.ok ? "" : `; the product refuses a setting: ${LIMITS.problem}`}.`
      );
      console.info(`[acceptance] Design Agent limits, Design-Agent-only arm: deadline ${sec(ARM.limits.timeoutMs)}, inactivity ${sec(ARM.limits.inactivityMs)}; same environment as a server's Design Agent.`);
      console.info(`[acceptance] Chat stream timeout ${sec(CHAT_TIMEOUT_MS)} without data: the largest stage limit of ${sec(largestStageMs(STAGES))} plus a margin.`);
      for (const [key, d] of ITEM_DURATIONS) console.info(`[acceptance] Test timeout ${key}: ${formatDuration(d.ms)} (${d.parts.map((p) => `${p.name} ${formatDuration(p.ms)}`).join(", ")}).`);
      expect(PREFLIGHT.ok, PREFLIGHT.message).toBe(true);
    });
  });
} else describe.sequential(`creative run acceptance (${MODE})`, () => {
  for (const item of PLAN.items) {
    const scenario = selected.find((s) => s.id === item.id)!;
    it(`${item.key}: ${scenario.title}`, async () => {
      const t0 = Date.now();
      const record = newRecord(scenario, item);
      results.scenarios.push(record);
      let notRun: string | null = null;
      try {
        // After a refused server start nothing more starts: this item is recorded as not run, before any stage.
        GATE.assertOpen();
        // A revision whose first run did not complete is skipped by its driver, without waiting.
        const priorMissing = !!scenario.revisionOf && !sessions.has(sourceKey(scenario, record));
        let admitted = true;
        if (scenario.needsImages && !priorMissing) {
          const admission = await waitForAdmission();
          imageEvidence(record).admission = admission;
          admitted = admission.admitted;
        }
        // Not run, and nothing spent on planning; the service's reasons stay in results.json.
        if (!admitted) record.outcome = "skipped: image service not admitting";
        else if (scenario.kind === "integration" || scenario.kind === "revision") await runIntegration(scenario, record);
        else if (scenario.kind === "image-service-unavailable") await runImageServiceUnavailable(scenario, record);
        else if (scenario.kind === "cancel") await runCancel(scenario, record);
        else await runRestartRetry(scenario, record);
        if (current) record.server = { port: current.server.port, mode: current.server.mode, readyMs: record.server.readyMs || current.server.readyMs };
      } catch (err) {
        // A refusal before this item made any model call is not run, and charged nothing; a refusal after its chats is a harness error, charged in full.
        const failure = classifyItemFailure(err, record.chats.length, scrub);
        if (failure.kind === "not-run") {
          notRun = failure.reason;
          record.outcome = `not run: ${notRun}`;
        } else record.harnessError = failure.message;
      } finally {
        record.wallMs = Date.now() - t0;
        record.finished = true; // read at settlement: a test that times out never gets here
        await save();
      }
      expect(record.harnessError).toBeNull();

      if (item.comparison) {
        // Recorded before it runs and filled in place, so a throw or a timeout keeps what the paid arm measured.
        const comparison = newComparison(scenario, item);
        results.comparisons.push(comparison);
        try {
          await runComparison(scenario, item, comparison, notRun);
        } catch (err) {
          comparison.harnessError = scrub((err as Error).stack ?? String(err));
        } finally {
          comparison.finished = true;
        }
        await save();
        expect(comparison.harnessError).toBeNull();
      }
      // The refusal fails the test, after the item's comparison was recorded as skipped.
      expect(notRun, "the item was not run").toBeNull();
    }, ITEM_DURATIONS.get(item.key)!.ms);
  }
});
