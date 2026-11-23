import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { format, isDeepStrictEqual } from "node:util";

import { serverCosts, type ChatResult } from "../eval/acceptance/app";
import { archived, archiveDir, archiveRun } from "../eval/acceptance/archive";
import { designAgentOnlyCliPath, notJudgedReason, runArmProcess } from "../eval/acceptance/baseline";
import {
  checkCliPin,
  cliFileFacts,
  cliVersion,
  directorProof,
  END_OF_RUN,
  forgetPinnedCli,
  judgeProof,
  pinnedCli,
  pinCli,
  recheckCli,
  recordRecheck,
  resolveServerCli,
  versionNumber,
  type CliPin,
} from "../eval/acceptance/cli";
import {
  callBoundUsd,
  callsFor,
  parseCaps,
  parseHoldBack,
  parseOvershoot,
  parseRepeat,
  planRun,
  preflight,
  renderPlan,
  reserveRun,
  settleRun,
  settlementDetail,
  settlementUsd,
  type Caps,
  type RunIdentity,
} from "../eval/acceptance/budget";
import {
  assertLinkedWorktree,
  configFingerprint,
  harnessHashes,
  inheritedConfiguration,
  mcpServerNames,
  MODEL_ENV_NAME,
  memoryRoots,
  memoryTrees,
  modelEnvironment,
  redactPath,
  redactText,
  sessionVersions,
  TRANSCRIPT_UNREADABLE,
  transcriptModels,
  transcriptVersions,
  treeFingerprint,
  worktreeRefusal,
  type EnvironmentRecord,
  type InheritedConfiguration,
} from "../eval/acceptance/environment";
import {
  classifyLoaderFailure,
  envFileNames,
  isAllowedServerVariable,
  loadedFileVariables,
  loadServerEnv,
  NEXT_ADDED_TO_SERVER,
  printableMessage,
  recheckEnvFiles,
  recordEnvRecheck,
  SERVER_ENV_ALLOWLIST,
  serverSetting,
  splitAddedNames,
  unaccountedLines,
  type EnvMode,
  type LoadedServerEnv,
} from "../eval/acceptance/server-env";
import {
  countNamesByClass,
  describeNameClasses,
  ENDPOINT_LIKE_NAME,
  harnessEnvironmentRefusal,
  HARMLESS_HARNESS_NAMES,
  isHarmlessHarnessName,
  MODEL_PRICE_NOTE,
  modelPricing,
  receivedNames,
  REFUSED_HARNESS_NAMES,
  refusedHarnessNames,
  unreviewedHarnessNames,
} from "../eval/acceptance/harness-env";
import { accountHome, homeDiffersFromAccount, homeFolders, redactPath as redactPathFromModule } from "../eval/acceptance/redact";
import {
  describeSettingsFile,
  describeSettingsFiles,
  isNoteworthyKey,
  managedSettingsDir,
  presentSources,
  readSettingsFile,
  recordSettingsKeys,
  SETTINGS_KEYS_OF_NOTE,
  SETTINGS_LISTED_FOR_CLI,
  settingsBannerLines,
  settingsSources,
  type SettingsKeysRecord,
} from "../eval/acceptance/settings-keys";
import { classifyItemFailure, skippedComparisonReason, StartGate, startChanges } from "../eval/acceptance/start-gate";
import { JUDGE_BUDGET_USD, judgeCliPath, MIN_READ_TURNS, OUTCOME_DIMENSIONS, type JudgeCall, type OutcomeScores, type OutcomeVerdict } from "../eval/acceptance/judge";
import {
  appendLedger,
  ensurePrivateDir,
  ledgerPath,
  ledgerTotals,
  m1CapUsd,
  main as ledgerCli,
  readLedger,
  validEntry,
  withLedgerLock,
  type LedgerEntry,
} from "../eval/acceptance/ledger";
import { chatTimeoutMs, DEV_MODE_REFUSAL, designAgentLimits, designAgentOnlyRun, formatDuration, itemWorstCase, largestStageMs, refusalBeforeSpend, stageLimits } from "../eval/acceptance/limits";
import { completeness, excludedVerdicts, scenarioStatistics } from "../eval/acceptance/report-baseline";
import { comparabilityFlags, environmentBannerLines, renderSummary, serializeResults, type ChatRecord, type ComparisonRecord, type RunResults, type ScenarioRecord } from "../eval/acceptance/report";
import { SCENARIOS, SYNTHETIC_BRAND, type ScenarioId } from "../eval/acceptance/scenarios";
import { getClaudePath } from "@/lib/claude-path";
import { DESIGN_AGENT_BUDGET_ENV, DESIGN_AGENT_INACTIVITY_ENV, DESIGN_AGENT_TIMEOUT_ENV } from "@/lib/design-agent";
import { DIRECTOR_BUDGET_ENV } from "@/lib/visual-director";
import { cleanEnv, nextBin, ROOT, ServerStartRefused, serverEnvironment, serverLaunch, startServer } from "../eval/acceptance/server";
import { requestMs, spread } from "../eval/acceptance/stats";
import { addUsage, modelsFromResult, usageFromCli } from "../eval/acceptance/usage";

// startServer's spawn is observed, not run: every other spawn passes through.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// The M1 baseline additions to the acceptance harness (#224), exercised with
// synthetic data in a temporary folder: no model, no network, no server.

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-baseline-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const mode = async (p: string) => (await stat(p)).mode & 0o777;
/** What Next.js's own loader leaves a server in `workdir`, given `env` as the server's own environment. */
const loadedEnv = (env: Record<string, string | undefined> = {}, mode: EnvMode = "prod", root?: string): LoadedServerEnv => loadServerEnv({ root: root ?? workdir, mode, env });
const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;
/** No overshoot allowance, so the arithmetic below is a plain sum of caps; it is not obtainable from `parseCaps`, which refuses 0. */
const caps: Caps = { directorUsd: 0.5, designUsd: 3, judgeUsd: JUDGE_BUDGET_USD, overshootFraction: 0 };
/** The default allowance: 25% of every cap. */
const capsDefault: Caps = { ...caps, overshootFraction: 0.25 };

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return { at: "2026-01-01T00:00:00.000Z", kind: "spend", ticket: "#221", runId: "run-a", commit: "abc1234", costUsd: 1, note: "synthetic", ...overrides };
}

describe("acceptance baseline: token usage from the server log", () => {
  it("sums the Design Agent's usage from multi-line and one-line run-finished entries, for one carousel only", async () => {
    const log = path.join(workdir, "server.log");
    // Exactly what the server's console.info prints.
    const lines = [
      format("[creative-run] planned", { carouselId: "c-1", runId: "r-1", outcome: "ready", durationMs: 4200, costUsd: 0.21, turns: 2 }),
      format("[chat] run finished", {
        carouselId: "c-1",
        runId: "r-1",
        stage: "design",
        outcome: "completed",
        designDurationMs: 300_000,
        designCostUsd: 1.25,
        designUsage: { input_tokens: 40, output_tokens: 9000, cache_creation_input_tokens: 50_000, cache_read_input_tokens: 700_000 },
        designTurns: 18,
        toolErrors: 0,
      }),
      format("[chat] run finished", { carouselId: "c-1", stage: "design", designCostUsd: 0.5, designUsage: { input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 }, designTurns: 3 }),
      format("[chat] run finished", { carouselId: "c-1", stage: "design", designCostUsd: null, designUsage: null, designTurns: null }),
      // A blocked run never designed: no usage expected and none counted missing.
      format("[chat] run finished", { carouselId: "c-1", outcome: "blocked", blockedCode: "image_failed" }),
      format("[chat] run finished", { carouselId: "c-2", stage: "design", designUsage: { input_tokens: 999, output_tokens: 999 }, designTurns: 99 }),
    ];
    expect(lines[1]).toContain("\n"); // the multi-line inspect form
    await writeFile(log, lines.join("\n") + "\n");

    const costs = await serverCosts(log, "c-1");
    expect(costs.designUsage).toEqual({ inputTokens: 42, outputTokens: 9100, cacheReadTokens: 700_010, cacheCreationTokens: 50_000 });
    expect(costs.designTurns).toBe(21);
    expect(costs.designRunsWithoutUsage).toBe(1);
    expect(costs.designCostUsd).toBe(1.75);
    expect(costs.directorCostUsd).toBe(0.21);
    expect(costs.directorTurns).toBe(2);
  });

  it("reports no usage when no design run logged any", async () => {
    const log = path.join(workdir, "server.log");
    await writeFile(log, format("[chat] run finished", { carouselId: "c-1", outcome: "stopped" }) + "\n");
    const costs = await serverCosts(log, "c-1");
    expect(costs.designUsage).toBeNull();
    expect(costs.designTurns).toBeNull();
    expect(costs.designRunsWithoutUsage).toBe(0);
  });

  it("maps the CLI's usage keys, adds usages and lists models", () => {
    expect(usageFromCli({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, service_tier: "standard" })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
    });
    expect(usageFromCli({})).toBeNull();
    expect(usageFromCli(null)).toBeNull();
    expect(addUsage([null, undefined])).toBeNull();
    expect(addUsage([usageFromCli({ input_tokens: 1 }), usageFromCli({ output_tokens: 5 })])).toEqual({ inputTokens: 1, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(modelsFromResult({ modelUsage: { "model-b": {}, "model-a": {} } })).toEqual(["model-a", "model-b"]);
    expect(modelsFromResult({})).toEqual([]);
  });
});

describe("acceptance baseline: statistics", () => {
  it("gives n, median and range, ignoring missing values", () => {
    expect(spread([3, 1, 2])).toEqual({ n: 3, median: 2, min: 1, max: 3 });
    expect(spread([4, null, 1, 3, undefined, 2])).toEqual({ n: 4, median: 2.5, min: 1, max: 4 });
    expect(spread([null])).toEqual({ n: 0, median: null, min: null, max: null });
  });

  it("summarises each scenario over its repetitions, per arm, saying which runs each metric uses", () => {
    const scores = (n: number) => Object.fromEntries(OUTCOME_DIMENSIONS.map((d) => [d, { score: n, evidence: "" }])) as OutcomeScores;
    const runs = [3, 4, 5].map((score, i) => ({
      ...record("S1", i + 1),
      outcome: "completed",
      wallMs: (i + 1) * 10_000,
      chats: [chatRecord((i + 2) * 10_000, { planning: (i + 1) * 1000, designing: (i + 1) * 5000 })],
      judge: judgeCall(scores(score)),
      costs: costs({ designCostUsd: i + 1, designUsage: { inputTokens: 10, outputTokens: 100 * (i + 1), cacheReadTokens: 0, cacheCreationTokens: 0 } }),
    }));
    const rows = scenarioStatistics({ scenarios: runs, comparisons: [comparison("S1", 1, 2.5)] });
    const row = (scenarioName: string, metric: string) => rows.find((r) => r.scenario === scenarioName && r.metric === metric);
    expect(row("S1", "Judge mean (1 to 5)")?.stats).toEqual({ n: 3, median: 4, min: 3, max: 5 });
    expect(row("S1", "Design output tokens")?.stats).toEqual({ n: 3, median: 200, min: 100, max: 300 });
    expect(row("S1", "Run cost (Director, design, judges)")?.stats.median).toBeCloseTo(2.2); // 0.10 Director + 2 design + 0.10 judge
    expect(row("S1 Design Agent only", "Design cost")?.stats).toEqual({ n: 1, median: 2.5, min: 2.5, max: 2.5 });
    // A metric no run has is left out rather than shown as n = 0.
    expect(row("S1", "Revision: brief kept")).toBeUndefined();

    // Request latency is the sum of the chat requests' own durations; harness wall time is labelled as such.
    expect(row("S1", "Request latency s (sum of chat requests)")?.stats).toEqual({ n: 3, median: 30, min: 20, max: 40 });
    expect(row("S1", "Planning stage s")?.stats).toEqual({ n: 3, median: 2, min: 1, max: 3 });
    expect(row("S1", "Design stage s")?.stats).toEqual({ n: 3, median: 10, min: 5, max: 15 });
    expect(row("S1", "Harness wall time s (includes judging, export, waits, checks)")?.stats).toEqual({ n: 3, median: 20, min: 10, max: 30 });
    expect(row("S1", "Wall time s (completed runs)")).toBeUndefined();
    expect(row("S1 Design Agent only", "Request latency s (the Design Agent's run)")?.stats.median).toBe(1);
    expect(requestMs(runs[0])).toBe(20_000);
    expect(requestMs(record("S1", 9))).toBeNull();

    // Each metric says which runs it uses: completed only, or every run that has a value.
    expect(row("S1", "Judge mean (1 to 5)")?.runs).toBe("completed");
    expect(row("S1", "Request latency s (sum of chat requests)")?.runs).toBe("completed");
    expect(row("S1", "Design output tokens")?.runs).toBe("all");
    expect(row("S1", "Design cost")?.runs).toBe("all");
    expect(row("S1 Design Agent only", "Design output tokens")).toBeUndefined();
  });

  it("takes latency from completed runs only, and tokens and cost from every run", () => {
    const done = { ...record("S1", 1), outcome: "completed", chats: [chatRecord(10_000)], costs: costs({ designCostUsd: 1 }) };
    const blocked = { ...record("S1", 2), outcome: "blocked: image_failed", chats: [chatRecord(90_000)], costs: costs({ designCostUsd: 3 }) };
    const rows = scenarioStatistics({ scenarios: [done, blocked], comparisons: [] });
    const row = (metric: string) => rows.find((r) => r.metric === metric)?.stats;
    expect(row("Request latency s (sum of chat requests)")).toEqual({ n: 1, median: 10, min: 10, max: 10 });
    expect(row("Design cost")).toEqual({ n: 2, median: 2, min: 1, max: 3 });
  });

  it("leaves a judge verdict that did not verifiably read the slides out of every median, and counts it", () => {
    const scores = (n: number) => Object.fromEntries(OUTCOME_DIMENSIONS.map((d) => [d, { score: n, evidence: "" }])) as OutcomeScores;
    const runs = [
      { ...record("S1", 1), outcome: "completed", judge: judgeCall(scores(4)) },
      { ...record("S1", 2), outcome: "completed", judge: judgeCall(scores(1), MIN_READ_TURNS - 1) },
      { ...record("S1", 3), outcome: "completed", judge: judgeCall(scores(2), null) },
    ];
    const comparisons = [{ ...comparison("S1", 1, 1), baselineJudge: judgeCall(scores(5), 1) }];
    const rows = scenarioStatistics({ scenarios: runs, comparisons });
    expect(rows.find((r) => r.scenario === "S1" && r.metric === "Judge mean (1 to 5)")?.stats).toEqual({ n: 1, median: 4, min: 4, max: 4 });
    expect(rows.find((r) => r.scenario === "S1 Design Agent only" && r.metric === "Judge mean (1 to 5)")).toBeUndefined();
    expect(excludedVerdicts({ scenarios: runs, comparisons })).toEqual([
      { scenario: "S1", returned: 3, excluded: 2 },
      { scenario: "S1 Design Agent only", returned: 1, excluded: 1 },
    ]);
    const md = renderSummary({ ...summaryResults(), scenarios: runs, comparisons });
    expect(md).toContain(`S1: 2 of 3 judge verdict(s) left out of these statistics, because the judge made fewer than ${MIN_READ_TURNS} turns`);
  });

  it("reports runs completed out of those made and checks passed out of those run, per scenario", () => {
    const check = (pass: boolean) => ({ name: "c", pass, evidence: "" });
    const scenarios = [
      { ...record("S1", 1), outcome: "completed", costs: costs({}), checks: [check(true), check(true), check(true)] },
      { ...record("S1", 2), outcome: "completed", checks: [check(true), check(false), check(true)] },
      { ...record("S1", 3), outcome: "blocked: image_failed", checks: [check(false)], harnessError: "boom" },
    ];
    const comparisons = [comparison("S1", 1, 1), { ...comparison("S1", 2, 1), baseline: null }];
    expect(completeness({ scenarios, comparisons })).toEqual([
      { scenario: "S1", runs: 3, completed: 2, checksPassed: 5, checksTotal: 7, harnessErrors: 1 },
      { scenario: "S1 Design Agent only", runs: 2, completed: 1, checksPassed: 0, checksTotal: 0, harnessErrors: 0 },
    ]);
    const md = renderSummary({ ...summaryResults(), scenarios, comparisons });
    expect(md).toContain("| S1 | 2 of 3 | 5 of 7 | 1 |");
    expect(md).toContain("| S1 Design Agent only | 1 of 2 | - | 0 |");
    expect(md).toContain("| Scenario | Metric | Runs | n | Median | Min | Max |");
  });
});

describe("acceptance baseline: ledger", () => {
  it("creates the ledger mode 600 in a mode-700 folder, reads it back and sums it", async () => {
    const file = path.join(workdir, "private", "ledger.jsonl");
    appendLedger(file, entry({ kind: "spend", runId: "manual-1", costUsd: 3.42 }));
    appendLedger(file, entry({ kind: "reservation", runId: "run-a", costUsd: 13 }));
    expect(await mode(path.dirname(file))).toBe(0o700);
    expect(await mode(file)).toBe(0o600);
    expect(readLedger(file)).toHaveLength(2);
    // An unsettled reservation counts in full.
    expect(ledgerTotals(readLedger(file))).toMatchObject({ settledUsd: 3.42, outstandingUsd: 13, unsettled: ["run-a"] });
    appendLedger(file, entry({ kind: "spend", runId: "run-a", costUsd: 4.1 }));
    const t = ledgerTotals(readLedger(file));
    expect(t.totalUsd).toBeCloseTo(7.52);
    expect(t.unsettled).toEqual([]);
  });

  it("refuses a damaged ledger and an invalid entry rather than under-count", async () => {
    const file = path.join(workdir, "ledger.jsonl");
    expect(readLedger(file)).toEqual([]);
    await writeFile(file, JSON.stringify(entry({})) + "\nnot json\n");
    expect(() => readLedger(file)).toThrow(/line 2/);
    await writeFile(file, JSON.stringify({ ...entry({}), costUsd: -1 }) + "\n");
    expect(() => readLedger(file)).toThrow(/line 1/);
    expect(() => appendLedger(path.join(workdir, "other.jsonl"), entry({ note: "two\nlines" }))).toThrow();
  });

  it("resolves its path and the M1 cap from the environment", () => {
    expect(ledgerPath({}, "/home/synthetic")).toBe("/home/synthetic/.local/share/creatorbrio-m1-eval/ledger.jsonl");
    expect(ledgerPath({ EVAL_LEDGER: "~/x/l.jsonl" }, "/home/synthetic")).toBe("/home/synthetic/x/l.jsonl");
    expect(() => ledgerPath({ EVAL_LEDGER: "relative.jsonl" })).toThrow();
    expect(m1CapUsd({})).toBe(50);
    expect(m1CapUsd({ EVAL_M1_CAP_USD: "20" })).toBe(20);
    expect(() => m1CapUsd({ EVAL_M1_CAP_USD: "-5" })).toThrow();
  });

  it("records manual spend through the CLI and shows the remaining allowance", () => {
    const env = { EVAL_LEDGER: path.join(workdir, "cli", "ledger.jsonl"), EVAL_M1_CAP_USD: "50" };
    const out = ledgerCli(["add", "--usd", "6.5", "--note", "earlier pilot", "--run", "pilot-1", "--commit", "abc1234"], env);
    expect(out).toContain("Recorded $6.50 as pilot-1");
    expect(ledgerCli(["show"], env)).toContain("remaining $43.50");
    expect(() => ledgerCli(["add", "--usd", "x", "--note", "n"], env)).toThrow(/--usd/);
    expect(() => ledgerCli(["add", "--usd", "1"], env)).toThrow(/--note/);
  });
});

describe("acceptance baseline: preflight", () => {
  it("requires both per-call caps and a sane repeat count", () => {
    expect(() => parseCaps({ DIRECTOR_MAX_BUDGET_USD: "0.5" })).toThrow(/DESIGN_AGENT_MAX_BUDGET_USD must be set/);
    expect(() => parseCaps({ DESIGN_AGENT_MAX_BUDGET_USD: "3" })).toThrow(/DIRECTOR_MAX_BUDGET_USD must be set/);
    expect(() => parseCaps({ DIRECTOR_MAX_BUDGET_USD: "abc", DESIGN_AGENT_MAX_BUDGET_USD: "3" })).toThrow(/positive USD/);
    expect(parseCaps({ DIRECTOR_MAX_BUDGET_USD: "0.5", DESIGN_AGENT_MAX_BUDGET_USD: "3" })).toEqual(capsDefault);
    expect(parseCaps({ DIRECTOR_MAX_BUDGET_USD: "0.5", DESIGN_AGENT_MAX_BUDGET_USD: "3", EVAL_OVERSHOOT_FRACTION: "0.1" }).overshootFraction).toBe(0.1);
    expect(parseRepeat(undefined)).toBe(1);
    expect(parseRepeat("3")).toBe(3);
    for (const bad of ["0", "1.5", "21", "two"]) expect(() => parseRepeat(bad)).toThrow();
  });

  it("counts the most calls each scenario kind can make", () => {
    expect(callsFor(scenario("S1"), true)).toEqual({ run: { director: 1, design: 1, judge: 1 }, comparison: { director: 0, design: 1, judge: 2 } });
    expect(callsFor(scenario("S1"), false).comparison).toBeNull();
    expect(callsFor(scenario("S10"), true)).toEqual({ run: { director: 1, design: 1, judge: 2 }, comparison: null });
    expect(callsFor(scenario("S7"), true).run.judge).toBe(0);
  });

  it("computes the worst case from the caps over repetitions, comparisons and resumes, in a paired order", () => {
    const plan = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 2, compare: true, caps });
    expect(plan.items.map((i) => i.key)).toEqual(["S1#1", "S10#1", "S1#2", "S10#2"]);
    // S1: 0.5 + 3 + 0.6, plus its comparison 3 + 2 x 0.6 = 8.30; S10 (a resume): 0.5 + 3 + 2 x 0.6 = 4.70.
    expect(plan.items.map((i) => i.worstCaseUsd)).toEqual([8.3, 4.7, 8.3, 4.7]);
    expect(plan.worstCaseUsd).toBe(26);
    expect(plan.calls).toEqual({ director: 4, design: 6, judge: 10 });
    expect(planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 1, compare: false, caps }).worstCaseUsd).toBe(8.8);
    expect(() => planRun({ scenarios: [scenario("S10")], repeat: 1, compare: false, caps })).toThrow(/EVAL_ONLY=S1,S10/);
  });

  it("refuses a run whose worst case exceeds what remains of the M1 cap", () => {
    const plan = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 1, compare: true, caps }); // 13.00
    expect(preflight(plan, [], 50)).toMatchObject({ ok: true, spentUsd: 0, remainingUsd: 50 });
    expect(preflight(plan, [entry({ costUsd: 37 })], 50)).toMatchObject({ ok: true, remainingUsd: 13 });
    const refused = preflight(plan, [entry({ costUsd: 30 }), entry({ kind: "reservation", runId: "killed", costUsd: 8 })], 50);
    expect(refused).toMatchObject({ ok: false, spentUsd: 38, remainingUsd: 12, unsettled: ["killed"] });
    expect(refused.message).toMatch(/^Refused/);
  });

  it("prints the dry-run plan with the worst case and the remaining allowance", () => {
    const plan = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 1, compare: true, caps });
    const text = renderPlan(plan, preflight(plan, [entry({ costUsd: 10 })], 50), "~/.local/share/creatorbrio-m1-eval/ledger.jsonl");
    expect(text).toContain("Order: S1#1, S10#1");
    expect(text).toContain("Worst case $13.00.");
    expect(text).toContain("remaining $40.00 of $50.00");
    expect(text).toContain("Planned calls at most: 2 Director, 3 Design Agent, 5 judge.");
    expect(renderPlan(plan, preflight(plan, [entry({ costUsd: 45 })], 50), "ledger")).toContain("Refused");
  });
});

describe("acceptance baseline: environment record", () => {
  const SECRET = "synthetic-secret-value-do-not-record";

  it("fingerprints inherited configuration by redacted label, size and hash, never content or home path", async () => {
    const home = path.join(workdir, "home");
    const project = path.join(home, "work", "checkout");
    await mkdir(path.join(home, ".claude", "rules"), { recursive: true });
    await mkdir(path.join(project, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "settings.json"), `{"env":{"TOKEN":"${SECRET}"}}`);
    await writeFile(path.join(home, ".claude", "rules", "00-core.md"), `rules ${SECRET}`);
    await writeFile(path.join(project, "CLAUDE.md"), "project instructions");
    await writeFile(path.join(project, ".claude", "settings.local.json"), "{}");
    await writeFile(path.join(home, "work", "CLAUDE.md"), "parent instructions");

    const prints = configFingerprint({ home, project, platform: "win32" });
    const serialized = JSON.stringify(prints);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(workdir);
    const byLabel = Object.fromEntries(prints.map((p) => [p.label, p]));
    const settings = `{"env":{"TOKEN":"${SECRET}"}}`;
    expect(byLabel["~/.claude/settings.json"]).toEqual({
      label: "~/.claude/settings.json",
      exists: true,
      size: settings.length,
      sha256: createHash("sha256").update(settings).digest("hex"),
    });
    expect(byLabel["~/.claude/CLAUDE.md"]).toMatchObject({ exists: false, size: null, sha256: null });
    expect(byLabel["~/.claude/rules/00-core.md"].exists).toBe(true);
    expect(byLabel["<project>/CLAUDE.md"].exists).toBe(true);
    expect(byLabel["<project>/.claude/settings.local.json"].exists).toBe(true);
    expect(byLabel["<project>/.claude/settings.json"].exists).toBe(false);
    expect(byLabel["<project>/../CLAUDE.md"].exists).toBe(true);

    const custom = configFingerprint({ home, project, configDir: path.join(home, ".claude"), platform: "win32" });
    expect(custom.map((p) => p.label)).toContain("$CLAUDE_CONFIG_DIR/settings.json");
  });

  it("redacts the home folder from paths it records", () => {
    expect(redactPath("/home/synthetic/.local/bin/claude", "/home/synthetic")).toBe("~/.local/bin/claude");
    expect(redactPath("/opt/tools/claude", "/home/synthetic")).toBe("/opt/tools/claude");
  });

  it("hashes every harness file and reads a server setting from the environment, then the .env files in Next.js's order", async () => {
    await writeFile(path.join(workdir, "a.ts"), "a");
    expect(harnessHashes(workdir).find((h) => h.file === "a.ts")?.sha256).toBe(createHash("sha256").update("a").digest("hex"));
    const read = (mode: EnvMode, env: Record<string, string> = {}) => serverSetting(loadedEnv(env, mode), "CLAUDE_CLI_PATH");
    expect(read("prod")).toBeNull();
    await writeFile(path.join(workdir, ".env"), "CLAUDE_CLI_PATH=/opt/base/claude\n");
    expect(read("prod")).toEqual({ value: "/opt/base/claude", source: "<project>/.env" });
    await writeFile(path.join(workdir, ".env.local"), `OTHER=1\nCLAUDE_CLI_PATH="/opt/tools/claude"\n`);
    expect(read("prod")).toEqual({ value: "/opt/tools/claude", source: "<project>/.env.local" });
    await writeFile(path.join(workdir, ".env.development.local"), "CLAUDE_CLI_PATH=/opt/dev/claude\n");
    expect(read("prod")?.value).toBe("/opt/tools/claude");
    expect(read("dev")).toEqual({ value: "/opt/dev/claude", source: "<project>/.env.development.local" });
    expect(read("prod", { CLAUDE_CLI_PATH: "/opt/shell/claude" })).toEqual({ value: "/opt/shell/claude", source: "the harness's environment" });
  });

  it("ends the search at a defined name even when its value is empty, as Next.js does", async () => {
    await writeFile(path.join(workdir, ".env.local"), "DESIGN_AGENT_TIMEOUT_SECONDS=900\n");
    const read = (env: Record<string, string>) => serverSetting(loadedEnv(env), "DESIGN_AGENT_TIMEOUT_SECONDS");
    // An empty or blank value in the environment is the product's default, not the file's 900.
    expect(read({ DESIGN_AGENT_TIMEOUT_SECONDS: "" })).toEqual({ value: "", source: "the harness's environment" });
    expect(read({ DESIGN_AGENT_TIMEOUT_SECONDS: " " })).toEqual({ value: " ", source: "the harness's environment" });
    // So is an empty assignment in a file with higher precedence than another file's value.
    await writeFile(path.join(workdir, ".env.production.local"), "DESIGN_AGENT_TIMEOUT_SECONDS=\n");
    expect(read({})).toEqual({ value: "", source: "<project>/.env.production.local" });
  });

  it("resolves the one CLI to its real path: the harness's, else the .env files', else the app's discovery, which is never explicit", async () => {
    const real = path.join(workdir, "claude-real");
    await writeFile(real, "#!/bin/sh\n");
    const link = path.join(workdir, "claude-link");
    symlinkSync(real, link);
    const other = path.join(workdir, "claude-other");
    await writeFile(other, "#!/bin/sh\n");
    const discovered = path.join(workdir, "claude-discovered");
    await writeFile(discovered, "#!/bin/sh\n");
    const resolve = (env: Record<string, string>) => resolveServerCli({ root: workdir, loaded: loadedEnv(env), discover: () => discovered });

    // Nothing names a CLI: whatever discovery finds, which is not a pin.
    expect(resolve({})).toEqual({ path: realpathSync(discovered), source: "the app's discovery (no CLAUDE_CLI_PATH is set)", explicit: false });
    // A .env file names one; a link is resolved, so a re-pointed install cannot change it mid-run.
    await writeFile(path.join(workdir, ".env.local"), `CLAUDE_CLI_PATH=${link}\n`);
    expect(resolve({})).toEqual({ path: realpathSync(real), source: "CLAUDE_CLI_PATH from <project>/.env.local", explicit: true });
    // The harness's own setting comes first.
    expect(resolve({ CLAUDE_CLI_PATH: other })).toEqual({ path: realpathSync(other), source: "CLAUDE_CLI_PATH from the harness's environment", explicit: true });
    // A relative path is the checkout's, as for the app's servers.
    expect(resolve({ CLAUDE_CLI_PATH: "claude-other" }).path).toBe(realpathSync(other));
    // A blank value names nothing, as in the app, so discovery decides and the run is not pinned.
    expect(resolve({ CLAUDE_CLI_PATH: "  " })).toMatchObject({ path: realpathSync(discovered), explicit: false });
    // A configured path that does not exist stays as configured, so the pin check refuses it instead of falling back to discovery.
    expect(resolve({ CLAUDE_CLI_PATH: "/opt/absent/claude" })).toEqual({ path: "/opt/absent/claude", source: "CLAUDE_CLI_PATH from the harness's environment", explicit: true });
  });

  it("reads only model names from a session transcript", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    await mkdir(path.join(workdir, "projects", "-synthetic-project"), { recursive: true });
    await writeFile(
      path.join(workdir, "projects", "-synthetic-project", `${id}.jsonl`),
      [
        JSON.stringify({ type: "user", message: { content: SECRET } }),
        JSON.stringify({ type: "assistant", message: { model: "model-x", content: [{ type: "text", text: SECRET }] } }),
        JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }),
        "{partial",
      ].join("\n")
    );
    expect(transcriptModels([id, "not-a-session"], workdir)).toEqual(["model-x"]);
    expect(transcriptModels([id], path.join(workdir, "missing"))).toEqual([]);
  });
});

// Each load runs Next.js's own loader in a child process, and some tests make a dozen: far more than the default 5 s would leave a loaded runner.
describe("acceptance baseline: the servers' environment (#232)", { timeout: 60_000 }, () => {
  /** What Next.js's own loader leaves in a server's environment, in a child process so this one is untouched. */
  const loaded = (env: NodeJS.ProcessEnv, mode: "prod" | "dev") =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `const { loadEnvConfig } = require("@next/env");
           loadEnvConfig(process.argv[1], process.argv[2] === "dev", { info() {}, error() {} });
           console.log(JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, setting: process.env.SYNTHETIC_SETTING ?? null, cli: process.env.CLAUDE_CLI_PATH ?? null }));`,
          workdir,
          mode,
        ],
        { cwd: ROOT, env }
      ).toString()
    ) as { nodeEnv: string | null; setting: string | null; cli: string | null };

  /** The test runner's environment, as the harness inherits it: NODE_ENV test and a shell CLI path. */
  const runner = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", CLAUDE_CLI_PATH: "/opt/shell/claude", CLAUDE_CODE_SYNTHETIC: "1" });

  beforeEach(async () => {
    await writeFile(path.join(workdir, ".env.local"), "SYNTHETIC_SETTING=from-env-local\nCLAUDE_CLI_PATH=/opt/env-local/claude\n");
  });

  it("starts each mode with its own NODE_ENV, so Next.js loads .env.local, and with the pinned CLI over any .env file", () => {
    for (const [mode, nodeEnv] of [["prod", "production"], ["dev", "development"]] as const) {
      const env = serverEnvironment({ mode, cliPath: "/opt/pinned/claude", extra: { IMAGE_SERVICE_URL: "http://127.0.0.1:8791", NODE_ENV: "test" }, base: runner() });
      expect(env).toMatchObject({ NODE_ENV: nodeEnv, CLAUDE_CLI_PATH: "/opt/pinned/claude", IMAGE_SERVICE_URL: "http://127.0.0.1:8791" });
      expect(env.CLAUDE_CODE_SYNTHETIC).toBeUndefined();
      expect(loaded(env, mode)).toEqual({ nodeEnv, setting: "from-env-local", cli: "/opt/pinned/claude" });
    }
  });

  it("leaves out CLAUDE_CLI_PATH when no CLI is given, for the environment the CLI is resolved from before it is pinned", () => {
    const env = serverEnvironment({ mode: "prod", extra: { IMAGE_SERVICE_URL: "http://127.0.0.1:8791" }, base: runner() });
    expect(env.CLAUDE_CLI_PATH).toBeUndefined();
    expect("CLAUDE_CLI_PATH" in env).toBe(false);
    expect(env).toMatchObject({ NODE_ENV: "production", IMAGE_SERVICE_URL: "http://127.0.0.1:8791" });
  });

  it("was what skipped .env.local: the runner's NODE_ENV test without an explicit CLI path loads neither", () => {
    const before = runner();
    delete before.CLAUDE_CLI_PATH; // what cleanEnv removed
    expect(loaded(before, "prod")).toEqual({ nodeEnv: "test", setting: null, cli: null });
  });

  it("starts a server with the server environment, not the clean one, and with Node.js and Next.js's own script, not npx", async () => {
    // The server is never run: the fake process exits at once, and its spawn call is what is read.
    const process_ = Object.assign(new EventEmitter(), { stdout: null, stderr: null, pid: undefined });
    vi.mocked(spawn).mockImplementationOnce((() => {
      setImmediate(() => process_.emit("exit", 1, null));
      return process_;
    }) as unknown as typeof spawn);
    await expect(
      // A port of the harness's own that its scenarios do not use. `NODE_ENV: "test"` here is what cleanEnv would have passed on.
      startServer({ mode: "dev", port: 3420, cliPath: "/opt/pinned/claude", env: { IMAGE_SERVICE_URL: "http://127.0.0.1:8791", NODE_ENV: "test" }, logPath: path.join(workdir, "server.log") })
    ).rejects.toThrow(/exited before it was ready/);
    const [command, args, options] = vi.mocked(spawn).mock.calls.at(-1) as unknown as [string, string[], { cwd: string; env: NodeJS.ProcessEnv }];
    // The Node.js that runs the harness runs Next.js's own script from the checkout: no npx, no npm, so no npm setting reaches the server.
    expect(command).toBe(process.execPath);
    expect(args).toEqual([path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "-H", "127.0.0.1", "-p", "3420"]);
    expect(args[0]).toBe(nextBin());
    expect(command).not.toMatch(/npx|npm/);
    expect(options.cwd).toBe(ROOT);
    // What a revert to cleanEnv(env) would change: the mode's NODE_ENV and the explicit CLI path.
    expect(options.env).toMatchObject({ NODE_ENV: "development", CLAUDE_CLI_PATH: "/opt/pinned/claude", IMAGE_SERVICE_URL: "http://127.0.0.1:8791" });
    expect(options.env.CLAUDE_CODE_SYNTHETIC).toBeUndefined();
    // The loader is given this same function's result, so the loader's input and the server's spawn environment are one.
    // That environment holds the whole inherited one, so it is compared by its names and by one boolean for the values: a failure never prints an inherited variable's value (#246).
    const expected = serverEnvironment({ mode: "dev", cliPath: "/opt/pinned/claude", extra: { IMAGE_SERVICE_URL: "http://127.0.0.1:8791", NODE_ENV: "test" } });
    expect(Object.keys(options.env).sort()).toEqual(Object.keys(expected).sort());
    expect(isDeepStrictEqual(options.env, expected), "the server's spawn environment is the one serverEnvironment gives").toBe(true);
  });

  it("launches a server as Node.js running Next.js's own script from the checkout, so an .npmrc node-options reaches nothing", async () => {
    // A scratch checkout whose .npmrc sets node-options and whose Next.js script only reports what it was started with.
    const root = path.join(workdir, "checkout");
    const bin = path.join(root, "node_modules", "next", "dist", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(root, ".npmrc"), "node-options=--require /nonexistent/preload.js\nloglevel=silent\n");
    await writeFile(
      path.join(bin, "next"),
      `require("node:fs").writeFileSync(process.env.REPORT_TO, JSON.stringify({
         argv: process.argv.slice(1),
         nodeOptions: process.env.NODE_OPTIONS ?? null,
         npm: Object.keys(process.env).filter((n) => /^npm_/i.test(n) || n === "INIT_CWD"),
         cwd: process.cwd(),
       }));`
    );
    const report = path.join(workdir, "report.json");
    const env = serverEnvironment({ mode: "prod", cliPath: "/opt/pinned/claude", extra: { REPORT_TO: report }, base: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
    const launch = serverLaunch({ mode: "prod", port: 3417, env, root });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", "3417"]);
    expect(serverLaunch({ mode: "dev", port: 3418, env, root }).args.slice(1)).toEqual(["dev", "-H", "127.0.0.1", "-p", "3418"]);
    // Run as startServer runs it: the server's own environment, in the checkout. The checkout's .npmrc changes nothing it sees.
    const run = spawnSync(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const seen = JSON.parse(await readFile(report, "utf8")) as { argv: string[]; nodeOptions: string | null; npm: string[]; cwd: string };
    expect(seen.argv[0]).toBe(launch.args[0]);
    expect(seen.nodeOptions).toBeNull();
    expect(seen.npm).toEqual([]);
    expect(realpathSync(seen.cwd)).toBe(realpathSync(root));
    // A checkout without Next.js is refused with a plain instruction, not a spawn error.
    expect(() => nextBin(path.join(workdir, "empty"))).toThrow("Next.js is not installed in this checkout: run `npm ci` first");
  });

  it("gives getClaudePath, which the server's Director and Design Agent spawn, the CLI in the server's environment", async () => {
    const cli = path.join(workdir, "claude");
    await writeFile(cli, "#!/bin/sh\n");
    const saved = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = serverEnvironment({ mode: "prod", cliPath: cli, base: runner() }).CLAUDE_CLI_PATH;
    try {
      // Both spawn getClaudePath() (src/lib/visual-director.ts, src/app/api/chat), which follows CLAUDE_CLI_PATH.
      expect(getClaudePath()).toBe(cli);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = saved;
    }
  });

  /** What Next.js's own loader leaves in a process given `env`, run directly in a child: the oracle the harness's loaded environment must equal. */
  const oracle = (env: Record<string, string | undefined>, mode: EnvMode, names: string[]): (string | null)[] =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", `const { loadEnvConfig } = require("@next/env"); loadEnvConfig(process.argv[1], process.argv[2] === "dev", { info() {}, error() {} }); console.log(JSON.stringify(process.argv.slice(3).map((n) => process.env[n] ?? null)));`, workdir, mode, ...names],
        { cwd: ROOT, env: env as NodeJS.ProcessEnv }
      ).toString()
    );

  it("takes names and values from Next.js's own loader in both modes, with expansion and with the environment winning even when empty", async () => {
    await writeFile(
      path.join(workdir, ".env"),
      ["# a comment", "export A=1", "B: two", 'C="three # kept"', "D='four'", "E=five # dropped", "F=", "G.H=six", "I = seven", 'J="multi', 'line"', "A=again", "P=${Q}-x", "R=$Q", "S=\\$Q"].join("\n")
    );
    await writeFile(path.join(workdir, ".env.local"), "B=from-local\nK=\nM=from-file\n");
    await writeFile(path.join(workdir, ".env.production"), "L=prod\n");
    await writeFile(path.join(workdir, ".env.development"), "L=dev\n");
    const names = ["A", "B", "C", "D", "E", "F", "G.H", "I", "J", "K", "L", "M", "P", "R", "S", "not"];
    const own: Record<string, string | undefined> = { PATH: process.env.PATH, M: "", Q: "q-value" };
    for (const mode of ["prod", "dev"] as const) {
      const env = { ...own, NODE_ENV: mode === "prod" ? "production" : "development" };
      const mine = loadedEnv(env, mode).env;
      // Every name and value is what Next.js leaves, so a parser of the harness's own cannot differ from it.
      expect(names.map((n) => mine[n] ?? null), mode).toEqual(oracle(env, mode, names));
    }
    // M is defined but empty in the environment: its value, not the file's, stays. Expansion reads the environment.
    expect(names.map((n) => loadedEnv({ ...own, NODE_ENV: "production" }).env[n] ?? null)).toEqual(["again", "from-local", "three # kept", "four", "five", "", "six", "seven", "multi\nline", "", "prod", "", "q-value-x", "q-value", "$Q", null]);
    expect(loadedEnv({ ...own, NODE_ENV: "development" }, "dev").env.L).toBe("dev");
  });

  it("gives the Design-Agent-only arm exactly the values the servers see, in both modes, and the deadline and cap they imply", async () => {
    await writeFile(path.join(workdir, ".env.local"), ["DESIGN_AGENT_TIMEOUT_SECONDS=${BASE_SECONDS}", "DESIGN_AGENT_INACTIVITY_SECONDS=120", "DESIGN_AGENT_MAX_BUDGET_USD=9", "ANTHROPIC_MODEL=synthetic-model"].join("\n"));
    for (const mode of ["prod", "dev"] as const) {
      const env = serverEnvironment({ mode, cliPath: "/opt/pinned/claude", extra: { DESIGN_AGENT_MAX_BUDGET_USD: "4", DIRECTOR_MAX_BUDGET_USD: "1", BASE_SECONDS: "900" }, base: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
      const servers = loadedEnv(env, mode);
      const arm = designAgentOnlyRun(servers);
      // The arm's environment is the server's, value for value: what a fresh Next.js loader leaves, minus its private markers.
      expect(arm.env).toEqual(servers.env);
      expect(Object.keys(arm.env).filter((n) => n.startsWith("__NEXT_"))).toEqual([]);
      const names = Object.keys(servers.env).sort();
      expect(names.map((n) => arm.env[n] ?? null)).toEqual(oracle(env, mode, names));
      expect(arm.env).toMatchObject({ ANTHROPIC_MODEL: "synthetic-model", CLAUDE_CLI_PATH: "/opt/pinned/claude", NODE_ENV: mode === "prod" ? "production" : "development", DESIGN_AGENT_TIMEOUT_SECONDS: "900" });
      // The harness's cap wins over the file's, for the arm as for the servers.
      expect(arm.settings).toEqual({ ok: true, budgetUsd: 4, timeoutMs: 900_000, inactivityMs: 120_000 });
      expect(designAgentLimits(servers)).toEqual({
        ok: true,
        problem: null,
        timeoutMs: 900_000,
        timeoutSource: "DESIGN_AGENT_TIMEOUT_SECONDS from <project>/.env.local",
        inactivityMs: 120_000,
        inactivitySource: "DESIGN_AGENT_INACTIVITY_SECONDS from <project>/.env.local",
      });
      expect(arm.limits).toEqual({ timeoutMs: 900_000, timeoutSource: "DESIGN_AGENT_TIMEOUT_SECONDS from <project>/.env.local", inactivityMs: 120_000, inactivitySource: "DESIGN_AGENT_INACTIVITY_SECONDS from <project>/.env.local" });
    }
    // With no file the arm and the servers share the product's defaults.
    await rm(path.join(workdir, ".env.local"));
    const env = serverEnvironment({ mode: "prod", cliPath: "/opt/pinned/claude", extra: { DESIGN_AGENT_MAX_BUDGET_USD: "4" }, base: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
    const none = loadedEnv(env);
    expect(designAgentLimits(none)).toMatchObject({ ok: true, timeoutMs: 1_800_000, timeoutSource: "the product's default", inactivityMs: 300_000, inactivitySource: "the product's default" });
    expect(designAgentOnlyRun(none).limits).toMatchObject({ timeoutMs: 1_800_000, inactivityMs: 300_000 });
  });

  it("allows only an exact list of names, each documented, and accepts every one of them", async () => {
    const VALUE = "synthetic-secret-value";
    expect(SERVER_ENV_ALLOWLIST.map((a) => a.name)).toEqual([
      "CLAUDE_CLI_PATH",
      "DISABLE_AUTOUPDATER",
      "DESIGN_AGENT_MAX_BUDGET_USD",
      "DESIGN_AGENT_TIMEOUT_SECONDS",
      "DESIGN_AGENT_INACTIVITY_SECONDS",
      "DIRECTOR_MAX_BUDGET_USD",
      "IMAGE_SERVICE_URL",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]);
    for (const entry of SERVER_ENV_ALLOWLIST) expect(entry.why.length, entry.name).toBeGreaterThan(20);
    // The DESIGN_AGENT_* and DIRECTOR_* names are the ones src/ reads, not a prefix.
    const names = new Set(SERVER_ENV_ALLOWLIST.map((a) => a.name));
    for (const fromSrc of [DESIGN_AGENT_BUDGET_ENV, DESIGN_AGENT_TIMEOUT_ENV, DESIGN_AGENT_INACTIVITY_ENV, DIRECTOR_BUDGET_ENV]) expect(names.has(fromSrc), fromSrc).toBe(true);
    expect([...names].filter((n) => /^(DESIGN_AGENT|DIRECTOR)_/.test(n))).toHaveLength(4);
    // The record fingerprints every allowed model name too.
    for (const name of names) if (/MODEL/.test(name)) expect(MODEL_ENV_NAME.test(name), name).toBe(true);
    // The effort level is not allowed: src/ never reads it and it can raise a turn's thinking past the overshoot allowance.
    expect(names.has("CLAUDE_CODE_EFFORT_LEVEL")).toBe(false);
    // A file's CLAUDE_CLI_PATH is resolved and pinned by the harness; the servers never read its value directly.
    expect(SERVER_ENV_ALLOWLIST.find((a) => a.name === "CLAUDE_CLI_PATH")!.why).toContain("a file's value is resolved to a real path and pinned by the harness");
    expect(SERVER_ENV_ALLOWLIST.find((a) => a.name === "CLAUDE_CLI_PATH")!.why).toContain("they never read the file's value directly");

    await writeFile(path.join(workdir, ".env.local"), [...names].map((name) => `${name}=${VALUE}`).join("\n"));
    const ok = loadedEnv().record;
    expect(ok.ok).toBe(true);
    expect(ok.refused).toEqual([]);
    expect(ok.unaccounted).toEqual([]);
    expect(ok.added.map((v) => v.name)).toEqual([...names].sort());
    expect(ok.added.every((v) => v.file === "<project>/.env.local")).toBe(true);
    expect(ok.allowlist).toEqual(SERVER_ENV_ALLOWLIST.map((a) => a.name));
    expect(JSON.stringify(ok)).not.toContain(VALUE);
    for (const name of names) expect(isAllowedServerVariable(name), name).toBe(true);
  });

  it("refuses every other name, by name and never by pattern, including URL, socket, gateway, catalogue, session and token-limit variables", async () => {
    const VALUE = "synthetic-secret-value";
    // Each could change what a model call is, where it goes, or how far one call can run past what the run reserved.
    const refused = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "ANTHROPIC_UNIX_SOCKET",
      "ANTHROPIC_GATEWAY_URL",
      "CLAUDE_CODE_MODEL_CATALOG_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_SKIP_AUTH",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "CLAUDE_CODE_EFFORT_LEVEL",
      "MAX_THINKING_TOKENS",
      "CLAUDE_EFFORT",
      "CLAUDE_CONFIG_DIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "NODE_OPTIONS",
      "AWS_ACCESS_KEY_ID",
      // What the old pattern rules allowed: a prefix or a word in the name.
      "ANTHROPIC_CUSTOM_MODEL_OPTION",
      "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
      "CLAUDE_CODE_EXTRA_THINK_BUDGET",
      "DESIGN_AGENT_EXTRA",
      "DESIGN_AGENT_MAX_BUDGET_USD_2",
      "DIRECTOR_ENDPOINT",
      "SOMETHING_NOBODY_LISTED",
      "lowercase_name",
    ];
    for (const name of refused) expect(isAllowedServerVariable(name), name).toBe(false);
    // One file with all of them: each is named, and the record never holds a value.
    await writeFile(path.join(workdir, ".env.local"), refused.map((name) => `${name}=${VALUE}`).join("\n"));
    const all = loadedEnv().record;
    expect(all.ok).toBe(false);
    expect(all.refused).toEqual([...refused].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(all.message).toMatch(/^Refusing a paid run before any spend: .*variables the harness does not allow/);
    expect(JSON.stringify(all)).not.toContain(VALUE);
    // Alone, a few of them: the refusal names exactly that one.
    for (const name of ["ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_MODEL_CATALOG_URL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_EFFORT_LEVEL", "MAX_THINKING_TOKENS", "NODE_OPTIONS"]) {
      await writeFile(path.join(workdir, ".env.local"), `${name}=${VALUE}\n`);
      const check = loadedEnv().record;
      expect(check.ok, name).toBe(false);
      expect(check.refused, name).toEqual([name]);
      expect(check.message, name).toMatch(new RegExp(`^Refusing a paid run before any spend: .*${name}`));
      expect(JSON.stringify(check), name).not.toContain(VALUE);
    }
  });

  it("says only what is true about the harness's own environment in the refusal", async () => {
    await writeFile(path.join(workdir, ".env.local"), "HTTPS_PROXY=http://proxy.example\n");
    const { message } = loadedEnv().record;
    // Nothing there claims a variable of the harness's environment is recorded unless it is.
    expect(message).not.toMatch(/where it is recorded/);
    expect(message).not.toContain("only proxy, endpoint, credential");
    expect(message).toContain(
      "that environment is recorded separately, in results.json under harnessEnvironment: by name only, every variable it passes on that is not reviewed as harmless (HARMLESS_HARNESS_NAMES in eval/acceptance/harness-env.ts), and the model variables by name and value hash. summary.md shows only counts of those names by class."
    );
    expect(message).toContain("or add the name to SERVER_ENV_ALLOWLIST in eval/acceptance/server-env.ts after review");
  });

  it("records by name, never by value, every variable the harness passes on that is not reviewed as harmless, whatever its name", () => {
    const VALUE = "synthetic-secret-value";
    // Names the CLI or a library reads that no deny pattern lists, and the names it did list.
    const recorded = [
      "ANTHROPIC_UNIX_SOCKET",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_CONFIG_DIR",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      "AGENT_PROXY_URL",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "CLAUDE_TRUSTED_DEVICE_TOKEN",
      "USE_LOCAL_OAUTH",
      "AN_ARBITRARY_UNKNOWN_NAME",
      "HTTPS_PROXY",
      "https_proxy",
      "NODE_OPTIONS",
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "AWS_PROFILE",
      "MY_SERVICE_API_KEY",
      "npm_config_node_options",
      "npm_config_user_agent",
      "npm_execpath",
      "INIT_CWD",
      "SSH_AUTH_SOCK",
      "AI_AGENT",
    ];
    const harmless = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "PWD", "SHLVL", "EVAL_ONLY", "EVAL_MODE", "DESIGN_AGENT_MAX_BUDGET_USD", "DIRECTOR_MAX_BUDGET_USD", "CI", "GITHUB_ACTIONS", "RUNNER_OS", "VITEST", "VITEST_WORKER_ID"];
    const models = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "MAX_THINKING_TOKENS"];
    const env: Record<string, string | undefined> = Object.fromEntries([...recorded, ...harmless, ...models].map((n) => [n, VALUE]));
    const names = unreviewedHarnessNames(env, (name) => MODEL_ENV_NAME.test(name));
    expect(names).toEqual([...recorded].sort());
    expect(JSON.stringify(names)).not.toContain(VALUE);
    for (const name of harmless) expect(names, name).not.toContain(name);
    // The model, effort and thinking variables are fingerprinted by name and value hash instead.
    for (const name of models) expect(names, name).not.toContain(name);
    expect(modelEnvironment(env as NodeJS.ProcessEnv).map((v) => v.name)).toEqual(["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_MODEL", "MAX_THINKING_TOKENS"]);
    // An undefined variable is not set; an empty one is.
    expect(unreviewedHarnessNames({ HTTPS_PROXY: undefined, ALL_PROXY: "", PATH: "/usr/bin" }, () => false)).toEqual(["ALL_PROXY"]);
    // The family LC_* is the one pattern; a name that merely contains it is not covered.
    expect(isHarmlessHarnessName("LC_MESSAGES")).toBe(true);
    expect(isHarmlessHarnessName("MY_LC_MESSAGES")).toBe(false);
    expect(isHarmlessHarnessName("lc_all")).toBe(false);
  });

  it("reviews each harmless group with a reason, and lists every EVAL_ variable the harness reads", async () => {
    for (const group of HARMLESS_HARNESS_NAMES) expect(group.why.length, group.names.join()).toBeGreaterThan(20);
    // No name that could carry a credential, endpoint or configuration is harmless.
    // (The harness's own EVAL_ settings are its own, including the loopback address of the image service it asks.)
    for (const name of HARMLESS_HARNESS_NAMES.flatMap((g) => g.names).filter((n) => !n.startsWith("EVAL_"))) {
      expect(name, name).not.toMatch(/PROXY|TOKEN|KEY|SECRET|SOCKET|URL|ENDPOINT|HEADERS|CONFIG_DIR|NODE_OPTIONS|^npm_|^ANTHROPIC_|^CLAUDE_|^OTEL_|^AWS_/);
    }
    // Every name the harness's own source reads with an EVAL_ prefix is reviewed, so a new setting cannot be recorded as unknown by accident or pass as harmless unreviewed.
    const sources = readdirSync(path.join(ROOT, "eval", "acceptance")).filter((f) => f.endsWith(".ts"));
    const read = new Set(sources.flatMap((f) => [...readFileSync(path.join(ROOT, "eval", "acceptance", f), "utf8").matchAll(/\bEVAL_[A-Z0-9_]+\b/g)].map((m) => m[0])));
    expect(read.size).toBeGreaterThan(10);
    for (const name of read) expect(isHarmlessHarnessName(name), name).toBe(true);
    // The tokens a CI runner adds are not reviewed as harmless.
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) expect(isHarmlessHarnessName(name), name).toBe(false);
  });

  it("refuses a paid run for a token or effort limit in the harness's own environment, whether the harness strips the name or passes it on", () => {
    expect([...REFUSED_HARNESS_NAMES]).toEqual(["MAX_THINKING_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_EFFORT_LEVEL"]);
    expect(refusedHarnessNames({ PATH: "/usr/bin", ANTHROPIC_MODEL: "x", CLAUDE_EFFORT: "high" })).toEqual([]);
    expect(refusedHarnessNames({ MAX_THINKING_TOKENS: "1", CLAUDE_CODE_EFFORT_LEVEL: "high", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "9", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "9", PATH: "/usr/bin" })).toEqual([
      "CLAUDE_CODE_EFFORT_LEVEL",
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
      "MAX_THINKING_TOKENS",
    ]);
    // An empty value is set, and undefined is not.
    expect(refusedHarnessNames({ MAX_THINKING_TOKENS: "", CLAUDE_CODE_EFFORT_LEVEL: undefined })).toEqual(["MAX_THINKING_TOKENS"]);
    expect(harnessEnvironmentRefusal([])).toBeNull();
    const text = harnessEnvironmentRefusal(["CLAUDE_CODE_EFFORT_LEVEL", "MAX_THINKING_TOKENS"])!;
    expect(text).toMatch(/^Refusing a paid run before any spend: the harness's own environment sets CLAUDE_CODE_EFFORT_LEVEL, MAX_THINKING_TOKENS,/);
    expect(text).toContain("Unset them and run the harness again");
    // The harness strips the CLAUDE_CODE_* ones from what it gives the servers, so the refusal is not about a value they would see.
    expect(cleanEnv().CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it("flags a run whose model was chosen by a variable, by name only, because the CLI costs a model its table lacks at another model's rate", () => {
    expect(modelPricing([])).toEqual({ selectionVariables: [], unverified: false, note: MODEL_PRICE_NOTE });
    // Effort, thinking and token variables are fingerprinted, but choose no model.
    expect(modelPricing(["MAX_THINKING_TOKENS", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"])).toMatchObject({ selectionVariables: [], unverified: false });
    const flagged = modelPricing(["ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]);
    expect(flagged).toMatchObject({ selectionVariables: ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"], unverified: true });
    expect(MODEL_PRICE_NOTE).toContain("costs a model its price table lacks at the rate of its main model");
    expect(MODEL_PRICE_NOTE).toContain("cannot see the CLI's table");
  });

  it("reads the forms Next.js reads, takes the highest-precedence file for each name, and counts only what the harness's environment lacks", async () => {
    await rm(path.join(workdir, ".env.local")); // the one the describe's other tests share
    await writeFile(path.join(workdir, ".env"), ["export HTTPS_PROXY=http://proxy.example", "ANTHROPIC_API_KEY: synthetic", 'CLAUDE_CONFIG_DIR = "/elsewhere"', "DESIGN_AGENT_TIMEOUT_SECONDS=900"].join("\n"));
    await writeFile(path.join(workdir, ".env.production.local"), "DESIGN_AGENT_TIMEOUT_SECONDS=1200\n");
    await writeFile(path.join(workdir, ".env.development.local"), "NODE_OPTIONS=--require ./x.js\n");
    const prod = loadedEnv().record;
    expect(prod.added).toEqual([
      { name: "ANTHROPIC_API_KEY", file: "<project>/.env" },
      { name: "CLAUDE_CONFIG_DIR", file: "<project>/.env" },
      { name: "DESIGN_AGENT_TIMEOUT_SECONDS", file: "<project>/.env.production.local" },
      { name: "HTTPS_PROXY", file: "<project>/.env" },
    ]);
    expect(prod.refused).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY"]);
    expect(prod.files.map((f) => [f.file, f.state])).toEqual([
      ["<project>/.env.production.local", "file"],
      ["<project>/.env.local", "absent"],
      ["<project>/.env.production", "absent"],
      ["<project>/.env", "file"],
    ]);
    // A server in dev mode reads another file set.
    expect(loadedEnv({}, "dev").record.refused).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "NODE_OPTIONS"]);
    // What the harness's own environment defines is not added by a file: Next.js leaves the environment's value, and an empty one counts.
    const inherited = loadedEnv({ HTTPS_PROXY: "", ANTHROPIC_API_KEY: "x", CLAUDE_CONFIG_DIR: "/mine" });
    expect(inherited.record.ok).toBe(true);
    expect(inherited.record.added.map((v) => v.name)).toEqual(["DESIGN_AGENT_TIMEOUT_SECONDS"]);
    expect(inherited.env).toMatchObject({ HTTPS_PROXY: "", ANTHROPIC_API_KEY: "x", CLAUDE_CONFIG_DIR: "/mine", DESIGN_AGENT_TIMEOUT_SECONDS: "1200" });
    expect(loadedEnv({}, "prod", path.join(workdir, "none")).record).toMatchObject({ ok: true, added: [], unaccounted: [], message: "The servers' .env files add these variables beyond the harness's environment, all allowed: none." });
  });

  it("reads the files the loader reads: the test set and no .env.local under NODE_ENV test, and the names it lists match what it loaded", async () => {
    for (const name of [".env.local", ".env.test", ".env.test.local", ".env.production", ".env.development"]) await writeFile(path.join(workdir, name), `DESIGN_AGENT_TIMEOUT_SECONDS=${name.length}\nFROM_${name.replace(/\W/g, "_").toUpperCase()}=1\n`);
    expect(envFileNames("prod", "production")).toEqual([".env.production.local", ".env.local", ".env.production", ".env"]);
    expect(envFileNames("dev", "development")).toEqual([".env.development.local", ".env.local", ".env.development", ".env"]);
    expect(envFileNames("prod", "test")).toEqual([".env.test.local", ".env.test", ".env"]);
    for (const [mode, nodeEnv] of [["prod", "production"], ["dev", "development"], ["prod", "test"]] as const) {
      const record = loadedEnv({ NODE_ENV: nodeEnv }, mode).record;
      expect(record.files.map((f) => f.file), `${mode} ${nodeEnv}`).toEqual(envFileNames(mode, nodeEnv).map((n) => `<project>/${n}`));
      // The files Next.js loaded are the files that exist among them: here every one of the set but `.env`.
      expect(record.added.map((v) => v.name).filter((n) => n.startsWith("FROM_")).length, `${mode} ${nodeEnv}`).toBe(record.files.filter((f) => f.state === "file").length);
    }
    expect(loadedEnv({ NODE_ENV: "test" }).record.added.some((v) => v.name === "FROM__ENV_LOCAL")).toBe(false);
  });

  it("refuses a file it cannot account for line by line: a byte-order mark, split name and =, the NAME: form, a swallowing quote and an expansion are each loaded and checked by name, or refused", async () => {
    const BOM = "\uFEFF";
    const load = async (body: string, env: Record<string, string> = {}) => {
      await writeFile(path.join(workdir, ".env.local"), body);
      return loadedEnv(env);
    };
    // A byte-order mark is whitespace to the loader: the first line is loaded, so its name is checked and refused.
    const bom = await load(`${BOM}HTTPS_PROXY=http://proxy.example\nDESIGN_AGENT_TIMEOUT_SECONDS=900\n`);
    expect(bom.record.added.map((v) => v.name)).toEqual(["DESIGN_AGENT_TIMEOUT_SECONDS", "HTTPS_PROXY"]);
    expect(bom.record.refused).toEqual(["HTTPS_PROXY"]);
    expect(bom.record.unaccounted).toEqual([]);
    expect(bom.record.ok).toBe(false);
    // The same mark before an allowed first line loads and is accepted, and before a comment it is nothing.
    const allowed = await load(`${BOM}DESIGN_AGENT_TIMEOUT_SECONDS=900\n`);
    expect(allowed.record).toMatchObject({ ok: true, refused: [], unaccounted: [] });
    expect(allowed.env.DESIGN_AGENT_TIMEOUT_SECONDS).toBe("900");
    expect((await load(`${BOM}# only a comment\n`)).record).toMatchObject({ ok: true, added: [], unaccounted: [] });

    // A name and its = on separate lines is one assignment to the loader: loaded by name, and refused when the name is not allowed.
    const split = await load("DISABLE_AUTOUPDATER\n=1\n");
    expect(split.record).toMatchObject({ ok: true, refused: [], unaccounted: [] });
    expect(split.env.DISABLE_AUTOUPDATER).toBe("1");
    const splitProxy = await load("HTTPS_PROXY\n= http://proxy.example\n");
    expect(splitProxy.record.refused).toEqual(["HTTPS_PROXY"]);

    // NAME: value is read; NAME:value (no space) is not, so its line is not accounted for and the run is refused.
    const colon = await load("DESIGN_AGENT_TIMEOUT_SECONDS: 600\n");
    expect(colon.record).toMatchObject({ ok: true, refused: [] });
    expect(colon.env.DESIGN_AGENT_TIMEOUT_SECONDS).toBe("600");
    const tight = await load("DESIGN_AGENT_TIMEOUT_SECONDS: 600\nNODE_OPTIONS:--require ./x.js\n");
    expect(tight.record.unaccounted).toEqual([{ file: "<project>/.env.local", line: 2, reason: "not an assignment the loader reads" }]);
    expect(tight.record.ok).toBe(false);
    expect(tight.env.NODE_OPTIONS).toBeUndefined();
    expect(tight.record.message).toContain("<project>/.env.local line 2");
    expect(JSON.stringify(tight.record)).not.toContain("--require");

    // A quoted value that ends in a backslash swallows the next lines up to a closing quote: a NODE_OPTIONS line inside it sets nothing, and is reported.
    const swallowed = await load('DESIGN_AGENT_TIMEOUT_SECONDS="600\\"\nNODE_OPTIONS=--require ./x.js\n"\n');
    expect(swallowed.record.added.map((v) => v.name)).toEqual(["DESIGN_AGENT_TIMEOUT_SECONDS"]);
    expect(swallowed.record.unaccounted).toEqual([{ file: "<project>/.env.local", line: 2, reason: "inside a multi-line value, but reads like an assignment that was not made" }]);
    expect(swallowed.record.ok).toBe(false);
    expect(swallowed.env.NODE_OPTIONS).toBeUndefined();
    // A multi-line value whose lines read as no assignment is fine.
    expect((await load('DESIGN_AGENT_TIMEOUT_SECONDS="6\n0\n0"\n')).record).toMatchObject({ ok: true, unaccounted: [] });

    // An expansion is the loader's: the harness's environment fills it in, and the arm sees the same value.
    const expanded = await load("DESIGN_AGENT_TIMEOUT_SECONDS=$BASE_SECONDS\nDESIGN_AGENT_INACTIVITY_SECONDS=${BASE_SECONDS}\n", { BASE_SECONDS: "700" });
    expect(expanded.record).toMatchObject({ ok: true, unaccounted: [] });
    expect(expanded.env).toMatchObject({ DESIGN_AGENT_TIMEOUT_SECONDS: "700", DESIGN_AGENT_INACTIVITY_SECONDS: "700" });
    expect(designAgentOnlyRun(expanded).env).toEqual(expanded.env);
    // An expansion cannot smuggle a refused name in: the name is what the file sets.
    const smuggle = await load("HTTPS_PROXY=$BASE_SECONDS\n", { BASE_SECONDS: "700" });
    expect(smuggle.record.refused).toEqual(["HTTPS_PROXY"]);

    // Lines of no meaning are refused, blank lines, comments, CRLF endings and `export` are not.
    const junk = await load("# comment\n\nthis is not an assignment\nexport\nDIRECTOR_MAX_BUDGET_USD=1\n");
    expect(junk.record.unaccounted.map((u) => u.line)).toEqual([3, 4]);
    expect(junk.record.ok).toBe(false);
    const tidy = await load("# comment\r\n\r\nexport DIRECTOR_MAX_BUDGET_USD=1\r\n  DESIGN_AGENT_TIMEOUT_SECONDS = 900 # why\r\n");
    expect(tidy.record).toMatchObject({ ok: true, refused: [], unaccounted: [] });
    expect(tidy.env).toMatchObject({ DIRECTOR_MAX_BUDGET_USD: "1", DESIGN_AGENT_TIMEOUT_SECONDS: "900" });
  });

  it("fails closed: lines the loader did not report stay unaccounted, and files that cannot be loaded as Next.js loads them are not ok", async () => {
    // The loader reported nothing for this file, so nothing in it is accounted for, whatever the assignment pattern finds.
    expect(unaccountedLines("A=1\n# c\n\nB: 2\n", new Set())).toEqual([
      { line: 1, reason: "not an assignment the loader reads" },
      { line: 4, reason: "not an assignment the loader reads" },
    ]);
    // It reported only A: B's line is not accounted for.
    expect(unaccountedLines("A=1\nB=2\n", new Set(["A"]))).toEqual([{ line: 2, reason: "not an assignment the loader reads" }]);
    expect(unaccountedLines("A=1\nB=2\n", new Set(["A", "B"]))).toEqual([]);
    await rm(path.join(workdir, ".env.local")); // the one the describe's other tests share
    // A folder where a file should be is skipped, as Next.js skips it.
    await mkdir(path.join(workdir, ".env.local"));
    expect(loadedEnv().record).toMatchObject({ ok: true, files: expect.arrayContaining([{ file: "<project>/.env.local", state: "directory", sha256: null }]) });
    await rm(path.join(workdir, ".env.local"), { recursive: true });
    // A pipe where a file should be is refused without being read, so it cannot hang the check.
    execFileSync("mkfifo", [path.join(workdir, ".env.local")]);
    const pipe = loadedEnv().record;
    expect(pipe).toMatchObject({ ok: false, loaderError: "<project>/.env.local is not a readable plain file", added: [] });
    expect(pipe.message).toContain("could not be loaded as Next.js loads them");
  });

  it("reports a loader failure as a fixed class, never any text of the failure", async () => {
    const LEAK = "/home/synthetic/secret-folder: stderr text with a name";
    const fail = (fields: Record<string, unknown>) => Object.assign(new Error(LEAK), fields);
    expect(classifyLoaderFailure(fail({ code: "ETIMEDOUT", signal: "SIGTERM" }))).toBe("the loader timed out");
    expect(classifyLoaderFailure(fail({ status: 3, stderr: Buffer.from(LEAK) }))).toBe("the loader exited with code 3");
    expect(classifyLoaderFailure(fail({ code: "MODULE_NOT_FOUND" }))).toBe("the loader's module (@next/env) was not found");
    expect(classifyLoaderFailure(new SyntaxError(LEAK))).toBe("the loader's output was not valid");
    expect(classifyLoaderFailure(fail({ code: "ENOBUFS" }))).toBe("the loader did not run");
    expect(classifyLoaderFailure(LEAK)).toBe("the loader did not run");
    expect(classifyLoaderFailure(undefined)).toBe("the loader did not run");
    for (const err of [fail({ code: "ETIMEDOUT" }), fail({ status: 1 }), fail({ code: "MODULE_NOT_FOUND" }), new SyntaxError(LEAK), fail({})]) expect(classifyLoaderFailure(err)).not.toContain("synthetic");

    // A real failure: a child that cannot start under the given NODE_OPTIONS exits with a code, and its text goes nowhere.
    const broken = loadedEnv({ PATH: process.env.PATH, NODE_OPTIONS: `--require ${path.join(workdir, "absent-preload.js")}` }).record;
    expect(broken.ok).toBe(false);
    expect(broken.loaderError).toBe("the loader exited with code 1");
    expect(broken.message).toContain("(the loader exited with code 1)");
    expect(JSON.stringify(broken)).not.toContain(workdir);
    expect(JSON.stringify(broken)).not.toContain("absent-preload");
  });

  it("hashes the loaded files at check time, and flags a file that changed, appeared or was removed at a re-check, as the CLI pin does", async () => {
    const VALUE = "synthetic-secret-value";
    await writeFile(path.join(workdir, ".env.local"), `DIRECTOR_MAX_BUDGET_USD=${VALUE}\n`);
    const checked = loadedEnv();
    const local = checked.record.files.find((f) => f.file === "<project>/.env.local")!;
    expect(local).toEqual({ file: "<project>/.env.local", state: "file", sha256: createHash("sha256").update(`DIRECTOR_MAX_BUDGET_USD=${VALUE}\n`).digest("hex") });
    expect(checked.record).toMatchObject({ rechecks: [], changed: false });

    const same = recheckEnvFiles(checked, workdir, "server start on port 3417");
    expect(same).toEqual({ at: "server start on port 3417", ok: true, changes: [] });
    expect(recordEnvRecheck(checked.record, same)).toBe(same);
    expect(checked.record).toMatchObject({ changed: false, rechecks: [same] });

    await writeFile(path.join(workdir, ".env.local"), `DIRECTOR_MAX_BUDGET_USD=${VALUE}-2\n`);
    const changed = recheckEnvFiles(checked, workdir, "server start on port 3418");
    expect(changed).toEqual({ at: "server start on port 3418", ok: false, changes: ["<project>/.env.local changed"] });
    await writeFile(path.join(workdir, ".env"), "DIRECTOR_MAX_BUDGET_USD=1\n");
    await rm(path.join(workdir, ".env.local"));
    expect(recheckEnvFiles(checked, workdir, END_OF_RUN).changes).toEqual(["<project>/.env.local was removed", "<project>/.env appeared"]);
    // A change marks the run as not comparable, and a later clean re-check does not clear it.
    recordEnvRecheck(checked.record, changed);
    recordEnvRecheck(checked.record, same);
    expect(checked.record.changed).toBe(true);
    expect(checked.record.rechecks).toHaveLength(3);
    // Only names and states are recorded, never a value.
    expect(JSON.stringify(checked.record)).not.toContain(VALUE);
  });

  it("records the model variables the files add by name and value hash, from the loader's values", async () => {
    await writeFile(path.join(workdir, ".env.local"), "ANTHROPIC_MODEL=model-a\nCLAUDE_CODE_MAX_OUTPUT_TOKENS=8000\nDESIGN_AGENT_TIMEOUT_SECONDS=900\n");
    const vars = loadedFileVariables(loadedEnv(), (name) => MODEL_ENV_NAME.test(name));
    expect(vars).toEqual([
      { name: "ANTHROPIC_MODEL", sha256: createHash("sha256").update("model-a").digest("hex"), file: "<project>/.env.local" },
      { name: "CLAUDE_CODE_MAX_OUTPUT_TOKENS", sha256: createHash("sha256").update("8000").digest("hex"), file: "<project>/.env.local" },
    ]);
    expect(JSON.stringify(vars)).not.toContain("model-a");
  });

  it("reads an empty setting in the environment as the product's default, with a source that says so, and refuses what the product refuses", async () => {
    await writeFile(path.join(workdir, ".env.local"), "DESIGN_AGENT_TIMEOUT_SECONDS=900\nDESIGN_AGENT_INACTIVITY_SECONDS=120\n");
    const base = { DESIGN_AGENT_MAX_BUDGET_USD: "4" };
    const emptied = designAgentLimits(loadedEnv({ ...base, DESIGN_AGENT_TIMEOUT_SECONDS: "", DESIGN_AGENT_INACTIVITY_SECONDS: " " }));
    expect(emptied).toMatchObject({ ok: true, timeoutMs: 1_800_000, inactivityMs: 300_000 });
    expect(emptied.timeoutSource).toBe("the product's default (DESIGN_AGENT_TIMEOUT_SECONDS is empty in the harness's environment)");
    expect(designAgentOnlyRun(loadedEnv({ ...base, DESIGN_AGENT_TIMEOUT_SECONDS: "" })).limits.timeoutMs).toBe(1_800_000);
    // An empty assignment in a file with higher precedence ends the search too.
    await writeFile(path.join(workdir, ".env.production.local"), "DESIGN_AGENT_TIMEOUT_SECONDS=\n");
    expect(designAgentLimits(loadedEnv(base)).timeoutSource).toBe("the product's default (DESIGN_AGENT_TIMEOUT_SECONDS is empty in <project>/.env.production.local)");
    await rm(path.join(workdir, ".env.production.local"));

    const soon = designAgentLimits(loadedEnv({ ...base, DESIGN_AGENT_TIMEOUT_SECONDS: "soon" }));
    expect(soon).toMatchObject({ ok: false, problem: "timeout_setting_invalid", timeoutMs: 3_600_000, inactivityMs: null });
    expect(designAgentOnlyRun(loadedEnv({ ...base, DESIGN_AGENT_TIMEOUT_SECONDS: "soon" })).settings).toEqual({ ok: false, code: "timeout_setting_invalid" });
    // An inactivity limit that does not undercut the deadline is refused by the product too.
    expect(designAgentLimits(loadedEnv({ ...base, DESIGN_AGENT_TIMEOUT_SECONDS: "600", DESIGN_AGENT_INACTIVITY_SECONDS: "600" }))).toMatchObject({ ok: false, problem: "inactivity_setting_invalid" });
    expect(designAgentLimits(loadedEnv({ DESIGN_AGENT_MAX_BUDGET_USD: "free" }))).toMatchObject({ ok: false, problem: "budget_setting_invalid" });
  });
});

describe("acceptance baseline: CLI pin (#232)", () => {
  async function fakeCli(name: string, version: string | null, comment = "") {
    const file = path.join(workdir, name);
    await writeFile(file, version ? `#!/bin/sh\n${comment}echo "${version} (Claude Code)"\n` : "#!/bin/sh\nexit 1\n");
    chmodSync(file, 0o755);
    return file;
  }
  const use = (role: string, cli: string | null) => ({ role, path: cli, version: cliVersion(cli, process.env) });
  const FILE = { size: 12, sha256: "a".repeat(64) };
  const named = () => ({ explicit: true, source: "CLAUDE_CLI_PATH from the harness's environment", file: FILE, home: workdir });
  const REFUSED = /^Refusing a paid run before any spend: the CLI is not pinned/;

  it("passes only when the servers, the Design-Agent-only arm and the judge run one CLI at one version, named by CLAUDE_CLI_PATH", async () => {
    const pinned = await fakeCli("claude-pinned", "2.0.1");
    const link = path.join(workdir, "claude-link");
    symlinkSync(pinned, link);
    const pin = checkCliPin([use("servers", pinned), use("Design-Agent-only arm", link), use("judge", pinned)], named());
    expect(pin).toMatchObject({ ok: true, explicit: true, file: FILE, rechecks: [], changed: false });
    expect(pin.message).toBe("CLI pinned: every model call uses ~/claude-pinned (2.0.1 (Claude Code)), named by CLAUDE_CLI_PATH from the harness's environment.");
    expect(JSON.stringify(pin)).not.toContain(workdir);
  });

  it("refuses different versions, different installs of one version, a missing CLI and one whose version is unknown", async () => {
    const pinned = await fakeCli("claude-pinned", "2.0.1");
    const newer = await fakeCli("claude-newer", "2.0.9");
    const copy = await fakeCli("claude-copy", "2.0.1");
    const broken = await fakeCli("claude-broken", null);
    for (const servers of [newer, copy, null, broken, path.join(workdir, "absent")]) {
      const pin = checkCliPin([use("servers (Director and Design Agent)", servers), use("Design-Agent-only arm", pinned), use("judge", pinned)], named());
      expect(pin.ok, String(servers)).toBe(false);
      expect(pin.message).toMatch(REFUSED);
      expect(pin.message).toContain("Design-Agent-only arm ~/claude-pinned (2.0.1 (Claude Code)); judge ~/claude-pinned (2.0.1 (Claude Code))");
      // The way out: one CLI, set in the harness's own environment.
      expect(pin.message).toContain("Run the harness with CLAUDE_CLI_PATH=<one installed CLI> in its environment.");
      expect(pin.message).not.toContain(workdir);
    }
    const judgeDiffers = checkCliPin([use("servers", pinned), use("Design-Agent-only arm", pinned), use("judge", newer)], named());
    expect(judgeDiffers.ok).toBe(false);
    expect(judgeDiffers.message).toContain("judge ~/claude-newer (2.0.9 (Claude Code))");
  });

  it("refuses a CLI that only discovery found, however well the uses agree, and never calls it pinned", async () => {
    const found = await fakeCli("claude-found", "2.0.1");
    const pin = checkCliPin([use("servers", found), use("Design-Agent-only arm", found), use("judge", found)], { ...named(), explicit: false, source: "the app's discovery (no CLAUDE_CLI_PATH is set)" });
    expect(pin).toMatchObject({ ok: false, explicit: false, source: "the app's discovery (no CLAUDE_CLI_PATH is set)" });
    expect(pin.message).toMatch(REFUSED);
    expect(pin.message).toContain("a discovered CLI is not pinned");
    expect(pin.message).not.toMatch(/CLI pinned:/);
    expect(pin.message).toContain("Run the harness with CLAUDE_CLI_PATH=<one installed CLI> in its environment.");
  });

  it("refuses a CLI file that could not be read for its size and SHA-256", async () => {
    const pinned = await fakeCli("claude-pinned", "2.0.1");
    const pin = checkCliPin([use("servers", pinned), use("judge", pinned)], { ...named(), file: null });
    expect(pin.ok).toBe(false);
    expect(pin.message).toContain("could not be read for its size and SHA-256");
  });

  it("reads a CLI file's size and SHA-256 in chunks, and nothing for a folder or a missing file", async () => {
    const file = path.join(workdir, "big");
    const bytes = Buffer.alloc(9 * 1024 * 1024, 7); // more than two read chunks
    await writeFile(file, bytes);
    expect(cliFileFacts(file)).toEqual({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(cliFileFacts(workdir)).toBeNull();
    expect(cliFileFacts(path.join(workdir, "absent"))).toBeNull();
  });

  it("re-checks the pinned file's existence, size, SHA-256 and --version, and flags any change on the pin", async () => {
    const cli = await fakeCli("claude-pinned", "2.0.1", "# a\n");
    const file = cliFileFacts(cli)!;
    const version = cliVersion(cli, process.env)!;
    const pin = () => ({ path: cli, file, version });
    const pinRecord = checkCliPin([use("servers", cli)], { ...named(), file });

    const same = recheckCli(pin(), "server start on port 3417", process.env);
    expect(same).toEqual({ at: "server start on port 3417", ok: true, changes: [] });
    expect(recordRecheck(pinRecord, same)).toBe(same);
    expect(pinRecord).toMatchObject({ changed: false, rechecks: [same] });

    // The same bytes in length and version output, but not the same file: only the hash differs.
    await fakeCli("claude-pinned", "2.0.1", "# b\n");
    expect(recheckCli(pin(), "server start on port 3418", process.env)).toEqual({ at: "server start on port 3418", ok: false, changes: ["SHA-256 changed"] });
    // An update: another size, another hash, another version.
    await fakeCli("claude-pinned", "2.0.99", "# longer comment\n");
    const updated = recheckCli(pin(), END_OF_RUN, process.env);
    expect(updated.ok).toBe(false);
    expect(updated.changes).toEqual([`size changed from ${file.size} to ${cliFileFacts(cli)!.size} bytes`, "SHA-256 changed", '--version changed from "2.0.1 (Claude Code)" to "2.0.99 (Claude Code)"']);
    // Gone.
    await rm(cli);
    const gone = recheckCli(pin(), END_OF_RUN, process.env);
    expect(gone.changes).toEqual(["the file no longer exists or cannot be read", '--version changed from "2.0.1 (Claude Code)" to unknown']);

    // A change marks the run as not comparable, and a later clean re-check does not clear it.
    recordRecheck(pinRecord, updated);
    recordRecheck(pinRecord, same);
    expect(pinRecord.changed).toBe(true);
    expect(pinRecord.rechecks).toHaveLength(3);
    expect(JSON.stringify(pinRecord)).not.toContain(workdir);
  });

  it("pins one real path for the servers, the judge and the Design-Agent-only arm, and never falls back to discovery", async () => {
    const cli = path.join(workdir, "claude-pinned");
    await writeFile(cli, "#!/bin/sh\n");
    const saved = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = "/opt/shell/claude";
    try {
      expect(judgeCliPath()).toBeNull();
      expect(designAgentOnlyCliPath()).toBeNull();
      expect(() => pinnedCli()).toThrow(/No CLI is pinned/);
      expect(() => pinCli("relative/claude")).toThrow(/absolute/);
      pinCli(cli);
      // The same checked value for every spawn, and the harness's own CLAUDE_CLI_PATH follows it.
      expect([judgeCliPath(), designAgentOnlyCliPath(), pinnedCli()]).toEqual([cli, cli, cli]);
      expect(process.env.CLAUDE_CLI_PATH).toBe(cli);
      expect(getClaudePath()).toBe(cli);
      forgetPinnedCli();
      expect(judgeCliPath()).toBeNull();
      expect(process.env.CLAUDE_CLI_PATH).toBe("/opt/shell/claude");
    } finally {
      forgetPinnedCli();
      if (saved === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = saved;
    }
  });

  it("refuses a paid run before any spend for the first of: dev mode, an unpinned CLI, a variable that is not allowed, a token limit in the harness's environment, a setting the product refuses", async () => {
    const cli = await fakeCli("claude-pinned", "2.0.1");
    const good = checkCliPin([use("servers", cli), use("judge", cli)], named());
    const envFiles = (body: string) => {
      writeFileSync(path.join(workdir, ".env.local"), body);
      return loadedEnv().record;
    };
    const settings = (timeout: string) => {
      const env = loadedEnv({ DESIGN_AGENT_MAX_BUDGET_USD: "4", DESIGN_AGENT_TIMEOUT_SECONDS: timeout });
      return { limits: designAgentLimits(env), armSettings: designAgentOnlyRun(env).settings };
    };
    const fine = { mode: "prod", harnessRefusal: null } as const;
    expect(refusalBeforeSpend({ ...fine, pin: good, envFiles: envFiles("DISABLE_AUTOUPDATER=1\n"), ...settings("900") })).toBeNull();
    const unpinned = checkCliPin([use("servers", cli), use("judge", cli)], { ...named(), explicit: false });
    expect(refusalBeforeSpend({ ...fine, pin: unpinned, envFiles: envFiles("HTTPS_PROXY=x\n"), ...settings("soon") })).toBe(unpinned.message);
    const bad = envFiles("HTTPS_PROXY=x\n");
    expect(refusalBeforeSpend({ ...fine, pin: good, envFiles: bad, ...settings("soon") })).toBe(bad.message);
    const tokens = harnessEnvironmentRefusal(["MAX_THINKING_TOKENS"]);
    expect(refusalBeforeSpend({ ...fine, pin: good, envFiles: envFiles("\n"), harnessRefusal: tokens, ...settings("soon") })).toBe(tokens);
    const refused = refusalBeforeSpend({ ...fine, pin: good, envFiles: envFiles("\n"), ...settings("soon") });
    expect(refused).toMatch(/^Refusing a paid run before any spend: the product does not accept the Design Agent settings the servers would load \(timeout_setting_invalid\)/);
    // A paid dev run comes first: next dev reloads the .env files into a running server, so a mid-run edit would reach later calls unchecked.
    expect(refusalBeforeSpend({ mode: "dev", harnessRefusal: tokens, pin: unpinned, envFiles: bad, ...settings("soon") })).toBe(DEV_MODE_REFUSAL);
    expect(refusalBeforeSpend({ mode: "dev", harnessRefusal: null, pin: good, envFiles: envFiles("\n"), ...settings("900") })).toBe(DEV_MODE_REFUSAL);
    expect(DEV_MODE_REFUSAL).toMatch(/^Refusing a paid run before any spend: EVAL_MODE=dev runs the servers under `next dev`, which reloads the checkout's \.env files into a server that is already running/);
    expect(DEV_MODE_REFUSAL).toContain("A dry run in dev mode prints the plan.");
  });
});

describe("acceptance baseline: CLI version per session (#232)", () => {
  const ids = ["123e4567-e89b-42d3-a456-426614174001", "123e4567-e89b-42d3-a456-426614174002", "123e4567-e89b-42d3-a456-426614174003", "123e4567-e89b-42d3-a456-426614174004"];
  const SECRET = "synthetic-transcript-content";
  const LINE = "2.0.1 (Claude Code)";

  async function transcript(id: string, versions: string[]) {
    await mkdir(path.join(workdir, "projects", "-synthetic-project"), { recursive: true });
    const lines = versions.flatMap((version) => [
      JSON.stringify({ type: "user", version, message: { content: SECRET } }),
      JSON.stringify({ type: "assistant", version, message: { model: "model-x", content: [{ type: "text", text: SECRET }] } }),
    ]);
    lines.push(JSON.stringify({ type: "summary", version: `not a version ${SECRET}` }), '{"version":"2.0.1', "");
    await writeFile(path.join(workdir, "projects", "-synthetic-project", `${id}.jsonl`), lines.join("\n"));
  }
  const pinWith = (rechecks: { at: string; ok: boolean }[], over: Partial<CliPin> = {}): CliPin => ({
    ok: true,
    explicit: true,
    source: "CLAUDE_CLI_PATH from the harness's environment",
    uses: [],
    file: { size: 1, sha256: "a".repeat(64) },
    message: "CLI pinned",
    rechecks: rechecks.map((r) => ({ at: r.at, ok: r.ok, changes: r.ok ? [] : ["SHA-256 changed"] })),
    changed: rechecks.some((r) => !r.ok),
    ...over,
  });
  const held = pinWith([{ at: "server start on port 3417", ok: true }, { at: END_OF_RUN, ok: true }]);
  const proof = directorProof(held, LINE);
  const record = (sessions: { id: string; role: "design-agent" | "design-agent-only" }[], withoutSession = 0) =>
    sessionVersions({ sessions, withoutSession, configDir: workdir, configured: versionNumber(LINE), director: proof, judge: judgeProof(held, LINE) });

  it("reads only the version field from each session's transcript", async () => {
    await transcript(ids[0], ["2.0.1"]);
    await transcript(ids[1], ["2.0.1", "2.0.9"]); // a resumed session
    const read = transcriptVersions([ids[0], ids[1], ids[2], "not-a-session", ids[0]], workdir);
    expect(read).toEqual([
      { sessionId: ids[0], found: true, versions: ["2.0.1"], error: null },
      { sessionId: ids[1], found: true, versions: ["2.0.1", "2.0.9"], error: null },
      { sessionId: ids[2], found: false, versions: [], error: null },
    ]);
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(versionNumber("2.0.1 (Claude Code)")).toBe("2.0.1");
    expect(versionNumber(null)).toBeNull();
  });

  it("records an unreadable transcript as a fixed string, for that file only, with no folder name or path", async () => {
    await transcript(ids[0], ["2.0.1"]);
    // A folder where the transcript file should be: it exists, and reading it fails, whoever runs the test.
    await mkdir(path.join(workdir, "projects", "-synthetic-project", `${ids[1]}.jsonl`));
    expect(() => transcriptModels([ids[1], ids[0]], workdir)).not.toThrow();
    expect(transcriptModels([ids[1], ids[0]], workdir)).toEqual(["model-x"]);
    const read = transcriptVersions([ids[1], ids[0]], workdir);
    expect(read).toEqual([
      { sessionId: ids[1], found: true, versions: [], error: TRANSCRIPT_UNREADABLE },
      { sessionId: ids[0], found: true, versions: ["2.0.1"], error: null },
    ]);
    expect(TRANSCRIPT_UNREADABLE).toBe("transcript unreadable");
    const recorded = record([{ id: ids[1], role: "design-agent" }, { id: ids[0], role: "design-agent" }]);
    expect(recorded.sessions).toEqual([
      { sessionId: ids[1], role: "design-agent", versions: [], status: "unknown", error: "transcript unreadable" },
      { sessionId: ids[0], role: "design-agent", versions: ["2.0.1"], status: "matches", error: null },
    ]);
    expect(recorded.unverified).toBe(true);
    const text = JSON.stringify(recorded);
    expect(text).not.toContain("synthetic-project");
    expect(text).not.toContain(workdir);
  });

  it("records each session's version and role, flags a run when one differs from the configured CLI, and does not read a mismatch-free run as verified when a version is unknown", async () => {
    await transcript(ids[0], ["2.0.1"]);
    await transcript(ids[1], ["2.0.9"]);
    await transcript(ids[3], ["2.0.1", "2.0.9"]);
    const mixed = record(
      [
        { id: ids[0], role: "design-agent" },
        { id: ids[1], role: "design-agent-only" },
        { id: ids[2], role: "design-agent" },
        { id: ids[3], role: "design-agent" },
      ],
      1
    );
    expect(mixed).toMatchObject({ configured: "2.0.1", withoutSession: 1, mismatch: true, unverified: true });
    expect(mixed.sessions).toEqual([
      { sessionId: ids[0], role: "design-agent", versions: ["2.0.1"], status: "matches", error: null },
      { sessionId: ids[1], role: "design-agent-only", versions: ["2.0.9"], status: "differs", error: null },
      { sessionId: ids[2], role: "design-agent", versions: [], status: "unknown", error: null },
      { sessionId: ids[3], role: "design-agent", versions: ["2.0.1", "2.0.9"], status: "differs", error: null },
    ]);
    expect(JSON.stringify(mixed)).not.toContain(SECRET);

    // Verified: every session matches and none is missing.
    expect(record([{ id: ids[0], role: "design-agent" }])).toMatchObject({ mismatch: false, unverified: false, withoutSession: 0 });
    // Unverified without a mismatch: an unknown version, or a run with no session id, each on its own.
    expect(record([{ id: ids[0], role: "design-agent" }, { id: ids[2], role: "design-agent-only" }])).toMatchObject({ mismatch: false, unverified: true });
    expect(record([{ id: ids[0], role: "design-agent" }], 1)).toMatchObject({ mismatch: false, unverified: true, withoutSession: 1 });
    // An id that names no transcript counts as a run without a session id.
    expect(record([{ id: "not-a-session", role: "design-agent-only" }])).toMatchObject({ unverified: true, withoutSession: 1, sessions: [] });
  });

  it("shows the Director's version by the resolved pin and the end-of-run file check, not by a transcript", () => {
    expect(proof).toMatchObject({ version: "2.0.1", proven: true });
    expect(proof.method).toMatch(/^not read from a transcript: the Director runs with --no-session-persistence/);
    expect(proof.method).toContain("re-checked by size, SHA-256 and --version at every server start and at the end of the run");
    const at = (rechecks: { at: string; ok: boolean }[], over: Partial<CliPin> = {}) => directorProof(pinWith(rechecks, over), LINE).proven;
    const start = { at: "server start on port 3417", ok: true };
    expect(at([start, { at: END_OF_RUN, ok: true }])).toBe(true);
    // No check at the end of the run (a killed run), a change at any check, a discovered CLI or a failed pin proves nothing.
    expect(at([start])).toBe(false);
    expect(at([{ at: "server start on port 3417", ok: false }, { at: END_OF_RUN, ok: true }])).toBe(false);
    expect(at([start, { at: END_OF_RUN, ok: true }], { explicit: false })).toBe(false);
    expect(at([start, { at: END_OF_RUN, ok: true }], { ok: false })).toBe(false);
    expect(directorProof(pinWith([{ at: END_OF_RUN, ok: true }]), null).version).toBeNull();
  });

  it("shows the judge's version the same way: it keeps no transcript either, so only the pin shows it, and results.json says so", () => {
    const judge = judgeProof(held, LINE);
    expect(judge).toMatchObject({ version: "2.0.1", proven: true });
    expect(judge.method).toMatch(/^not read from a transcript: the judge runs with --no-session-persistence, so its CLI keeps none; its version is shown by the resolved pin/);
    expect(judgeProof(pinWith([{ at: "server start on port 3417", ok: true }]), LINE).proven).toBe(false);
    expect(judgeProof(pinWith([{ at: END_OF_RUN, ok: false }]), LINE).proven).toBe(false);
    expect(record([{ id: ids[0], role: "design-agent" }]).judge).toEqual(judge);
    expect(JSON.stringify(record([]))).toContain("the judge runs with --no-session-persistence");
  });
});

describe("acceptance baseline: the Design-Agent-only arm's process (#232)", () => {
  async function fakeCli(body: string) {
    const file = path.join(workdir, `fake-claude-${Math.random().toString(36).slice(2)}`);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }
  const run = (cliPath: string, settings: { timeoutMs: number; inactivityMs: number | null }, env: Record<string, string | undefined> = { PATH: process.env.PATH }) =>
    runArmProcess({ cliPath, args: [], env: env as NodeJS.ProcessEnv, cwd: workdir, settings, forceKillAfterMs: 200 });
  const RESULT = '{"type":"result","subtype":"success","is_error":false,"session_id":"123e4567-e89b-42d3-a456-426614174000","total_cost_usd":0.5,"num_turns":3,"result":"%s"}';

  it("spawns the CLI it is given with the environment it is given, and records the session id from its result", async () => {
    const cli = await fakeCli(`printf '${RESULT}\\n' "$ANTHROPIC_MODEL"`);
    const result = await run(cli, { timeoutMs: 20_000, inactivityMs: 10_000 }, { PATH: process.env.PATH, ANTHROPIC_MODEL: "synthetic-model" });
    expect(result).toMatchObject({ ok: true, error: null, costUsd: 0.5, turns: 3, subtype: "success", sessionId: "123e4567-e89b-42d3-a456-426614174000", resultText: "synthetic-model" });
  });

  it("records no session id when the CLI reported none", async () => {
    const cli = await fakeCli(`echo '{"type":"result","subtype":"success","is_error":false}'`);
    expect(await run(cli, { timeoutMs: 20_000, inactivityMs: null })).toMatchObject({ ok: true, sessionId: null });
  });

  it("takes the session id from the system init event too, so a run that was stopped before its result is still version-checked", { timeout: 60_000 }, async () => {
    const INIT = '{"type":"system","subtype":"init","session_id":"123e4567-e89b-42d3-a456-426614174111","model":"model-x"}';
    // Stopped by the inactivity limit after the init event and before any result.
    const stalled = await fakeCli(`echo '${INIT}'; exec sleep 30`);
    expect(await run(stalled, { timeoutMs: 60_000, inactivityMs: 2_000 })).toMatchObject({ ok: false, error: "stalled", sessionId: "123e4567-e89b-42d3-a456-426614174111" });
    // The result event's id wins when both are there, and an init event that is not a session's names none.
    const both = await fakeCli(`echo '${INIT}'; printf '${RESULT}\\n' x`);
    expect(await run(both, { timeoutMs: 20_000, inactivityMs: null })).toMatchObject({ ok: true, sessionId: "123e4567-e89b-42d3-a456-426614174000" });
    const other = await fakeCli(`echo '{"type":"system","subtype":"hook_started","session_id":"123e4567-e89b-42d3-a456-426614174222"}'; echo '{"type":"result","is_error":false}'`);
    expect(await run(other, { timeoutMs: 20_000, inactivityMs: null })).toMatchObject({ ok: true, sessionId: null });
  });

  // The limits below are real time, so they are far wider than the output and scheduling gaps a loaded runner can produce.
  it("stops a CLI that writes nothing for the inactivity limit, as stalled, though the deadline is far off", { timeout: 60_000 }, async () => {
    const cli = await fakeCli("exec sleep 60");
    const started = Date.now();
    const result = await run(cli, { timeoutMs: 120_000, inactivityMs: 1_500 });
    expect(result).toMatchObject({ ok: false, error: "stalled", sessionId: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("lets output reset the inactivity limit, and never lets it move the deadline", { timeout: 60_000 }, async () => {
    // Writes every 100 ms for about 1 s, then finishes: never quiet for the 3 s limit, however loaded the runner.
    const talkative = await fakeCli(`i=0; while [ $i -lt 10 ]; do echo '{"type":"system"}'; sleep 0.1; i=$((i+1)); done; printf '${RESULT}\\n' x`);
    expect(await run(talkative, { timeoutMs: 60_000, inactivityMs: 3_000 })).toMatchObject({ ok: true, error: null });
    // Writes for ever: the inactivity limit never fires, and the deadline still stops it.
    const endless = await fakeCli(`while true; do echo '{"type":"system"}'; sleep 0.1; done`);
    expect(await run(endless, { timeoutMs: 4_000, inactivityMs: 3_000 })).toMatchObject({ ok: false, error: "timed out" });
  });

  it("kills a CLI that ignores the stop", { timeout: 60_000 }, async () => {
    const stubborn = await fakeCli(`trap '' TERM; while true; do sleep 0.1; done`);
    const started = Date.now();
    // The limit leaves the shell time to install its trap before the stop arrives.
    expect(await run(stubborn, { timeoutMs: 120_000, inactivityMs: 2_000 })).toMatchObject({ ok: false, error: "stalled" });
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe("acceptance baseline: time limits (#232)", () => {
  const STAGES = stageLimits({ designMs: 1_800_000, designArmMs: 1_800_000, admissionWaitMs: 600_000 });
  const plan = () => planRun({ scenarios: SCENARIOS, repeat: 1, compare: true, caps: capsDefault });
  const shape = (item: ReturnType<typeof plan>["items"][number]) => ({ kind: scenario(item.id).kind, needsImages: !!scenario(item.id).needsImages, calls: item.calls, comparison: item.comparison });

  it("takes each stage's limit from the product, the judge and the effective settings", () => {
    expect(STAGES).toEqual({
      serverReadyMs: 190_000,
      admissionWaitMs: 600_000,
      observeMs: 60_000,
      directorMs: 120_000,
      sourcesMs: 30_000,
      imageStageMs: 12 * 60 * 1000,
      designMs: 1_800_000,
      designArmMs: 1_800_000,
      judgeMs: 360_000,
      stopMs: 10_000,
      marginMs: 600_000,
    });
  });

  it("gives an item the sum of its stage limits plus a margin as its test timeout, far above the 60 minutes it had", () => {
    // S1 in the default plan: the Design Agent and the arm alone are an hour.
    const s1 = plan().items.find((i) => i.id === "S1")!;
    const worst = itemWorstCase(shape(s1), STAGES);
    expect(worst.ms).toBe(7_880_000);
    expect(worst.ms).toBe(worst.parts.reduce((a, p) => a + p.ms, 0));
    expect(Object.fromEntries(worst.parts.map((p) => [p.name, p.ms]))).toEqual({
      "server start": 380_000,
      "waits for the image service": 600_000,
      Director: 160_000,
      "image stage": 1_440_000,
      "Design Agent": 1_810_000,
      judges: 360_000,
      "Design-Agent-only arm": 1_810_000,
      "comparison judges": 720_000,
      "export, checks and waits without a limit of their own": 600_000,
    });
    expect(formatDuration(worst.ms)).toBe("2 h 12 min");
    expect(worst.ms).toBeGreaterThan(60 * 60 * 1000);
  });

  it("covers the Design Agent's deadline and the arm's at the product's maximum of an hour", () => {
    const limits = stageLimits({ designMs: 3_600_000, designArmMs: 3_600_000, admissionWaitMs: 600_000 });
    for (const item of plan().items) {
      const worst = itemWorstCase(shape(item), limits);
      const designs = item.calls.design + (item.comparison?.design ?? 0);
      expect(worst.ms, item.key).toBeGreaterThan(designs * 3_600_000);
      expect(worst.ms, item.key).toBeLessThan(2 ** 31 - 1);
    }
  });

  it("counts a restart's second server start, a cancel's observation and a plan without comparison", () => {
    const by = (id: string, compare: boolean) => {
      const item = planRun({ scenarios: SCENARIOS, repeat: 1, compare, caps: capsDefault }).items.find((i) => i.id === id)!;
      return Object.fromEntries(itemWorstCase(shape(item), STAGES).parts.map((p) => [p.name, p.ms]));
    };
    expect(by("S9", false)["server start"]).toBe(2 * 190_000);
    expect(by("S9", false)["observing the image service"]).toBe(60_000);
    expect(by("S8", false)["observing the image service"]).toBe(60_000);
    expect(by("S7", false)["image stage"]).toBeUndefined();
    expect(by("S1", false)["Design-Agent-only arm"]).toBeUndefined();
    expect(by("S1", true)["server start"]).toBe(2 * 190_000);
  });

  it("refuses an item that could take longer than a Node timer can wait", () => {
    const huge = stageLimits({ designMs: 3_600_000, designArmMs: 3_600_000, admissionWaitMs: 2 ** 31 });
    expect(() => itemWorstCase(shape(plan().items[0]), huge)).toThrow(/cannot be given a test timeout/);
  });

  it("sizes the chat stream's idle limit from the largest stage limit, the image stage included, plus the margin", () => {
    // The default: the Design Agent's 30 minutes are the largest stage.
    expect(largestStageMs(STAGES)).toBe(1_800_000);
    expect(chatTimeoutMs(largestStageMs(STAGES))).toBe(35 * 60 * 1000);
    // A short deadline (the product's minimum is 60 s) leaves the image stage's 12 minutes the largest: the idle limit must not be the deadline's.
    const short = stageLimits({ designMs: 60_000, designArmMs: 60_000, admissionWaitMs: 600_000 });
    expect(largestStageMs(short)).toBe(12 * 60 * 1000);
    expect(chatTimeoutMs(largestStageMs(short))).toBe(17 * 60 * 1000);
    expect(chatTimeoutMs(largestStageMs(short))).toBeGreaterThan(60_000 + 5 * 60 * 1000);
  });
});

describe("acceptance baseline: durable copy", () => {
  it("copies results, summary, server logs and exported PNGs only, owner-only", async () => {
    const run = path.join(workdir, "run");
    await mkdir(path.join(run, "S1-r1-director"), { recursive: true });
    for (const f of ["results.json", "summary.md", "server-3417.log", "S1-r1-director/slide-1.png", "S1-r1-director/export.zip", "notes.txt"]) {
      await writeFile(path.join(run, f), f);
    }
    const dest = archiveDir("acceptance-2026-01-01T00-00-00-000Z", { EVAL_ARCHIVE_DIR: path.join(workdir, "archive") });
    expect(archiveRun(run, dest)).toEqual(["S1-r1-director/slide-1.png", "results.json", "server-3417.log", "summary.md"]);
    expect(await mode(dest)).toBe(0o700);
    expect(await mode(path.join(dest, "results.json"))).toBe(0o600);
    expect(await readFile(path.join(dest, "S1-r1-director", "slide-1.png"), "utf8")).toBe("S1-r1-director/slide-1.png");
    expect(archived("../escape.png")).toBe(false);
    expect(() => archiveDir("../x", {})).toThrow();
    expect(() => archiveDir("..", {})).toThrow();
  });
});

describe("acceptance baseline: summary", () => {
  it("states the synthetic brand, the plan, token usage and the environment", () => {
    const plan = planRun({ scenarios: [scenario("S1")], repeat: 2, compare: false, caps });
    const results: RunResults = {
      runId: "acceptance-synthetic",
      startedAt: "2026-01-01T00:00:00.000Z",
      mode: "prod",
      commit: "abc1234",
      plan,
      spend: { ledger: "~/ledger.jsonl", preflight: preflight(plan, [], 50), reservation: null, spend: null, settlement: null, error: null },
      brand: { id: "b-1", name: SYNTHETIC_BRAND.name },
      environment: {
        commit: "abc1234",
        commitDirty: false,
        node: "v0",
        platform: "test",
        cli: {
          server: { path: "~/bin/claude", version: "1.0.0 (Claude Code)", source: "CLAUDE_CLI_PATH from <project>/.env.local" },
          harness: { path: "~/bin/claude", version: "1.0.0 (Claude Code)" },
          pin: {
            ok: true,
            explicit: true,
            source: "CLAUDE_CLI_PATH from <project>/.env.local",
            uses: [],
            file: { size: 1234, sha256: "f".repeat(64) },
            message: "CLI pinned: every model call uses ~/bin/claude (1.0.0 (Claude Code)).",
            rechecks: [
              { at: "server start on port 3417", ok: true, changes: [] },
              { at: END_OF_RUN, ok: false, changes: ["SHA-256 changed"] },
            ],
            changed: true,
          },
          sessions: {
            configured: "1.0.0",
            sessions: [
              { sessionId: "s-1", role: "design-agent", versions: ["1.0.0"], status: "matches", error: null },
              { sessionId: "s-2", role: "design-agent-only", versions: ["1.0.9"], status: "differs", error: null },
              { sessionId: "s-3", role: "design-agent", versions: [], status: "unknown", error: "transcript unreadable" },
            ],
            withoutSession: 2,
            mismatch: true,
            unverified: true,
            director: { method: "not read from a transcript: synthetic", version: "1.0.0", proven: false },
            judge: { method: "not read from a transcript: synthetic judge", version: "1.0.0", proven: true },
          },
        },
        serverEnvFiles: {
          files: [
            { file: "<project>/.env.local", state: "file", sha256: "d".repeat(64) },
            { file: "<project>/.env", state: "absent", sha256: null },
          ],
          added: [{ name: "DESIGN_AGENT_TIMEOUT_SECONDS", file: "<project>/.env.local" }, { name: "HTTPS_PROXY", file: "<project>/.env.local" }],
          refused: ["HTTPS_PROXY"],
          unaccounted: [{ file: "<project>/.env.local", line: 4, reason: "not an assignment the loader reads" }],
          loaderError: null,
          allowlist: ["CLAUDE_CLI_PATH"],
          ok: false,
          message: "refused",
          rechecks: [
            { at: "server start on port 3417", ok: true, changes: [] },
            { at: END_OF_RUN, ok: false, changes: ["<project>/.env.local changed"] },
          ],
          changed: true,
        },
        harnessEnvironment: { unreviewedNames: ["ACME_BUILD_FLAG", "HTTPS_PROXY", "NODE_OPTIONS", "npm_config_node_options"] },
        modelPricing: modelPricing(["ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]),
        settingsKeys: {
          listedForCli: SETTINGS_LISTED_FOR_CLI,
          listedForPinnedCli: true,
          files: [
            { label: "user", exists: true, state: "ok", sha256: "1".repeat(64), keys: ["env", "model", "permissions"], envKeys: ["ANTHROPIC_BASE_URL"], unrecordedNames: 0 },
            { label: "project", exists: false, state: "absent", sha256: null, keys: [], envKeys: [], unrecordedNames: 0 },
            { label: "managed", exists: true, state: "ok", sha256: "2".repeat(64), keys: ["modelPricing"], envKeys: [], unrecordedNames: 0 },
          ],
        },
        homeDiffersFromAccount: true,
        limits: {
          designAgent: { timeoutMs: 900_000, timeoutSource: "DESIGN_AGENT_TIMEOUT_SECONDS from <project>/.env.local", inactivityMs: 120_000, inactivitySource: "the product's default" },
          designAgentOnly: { timeoutMs: 900_000, timeoutSource: "DESIGN_AGENT_TIMEOUT_SECONDS from <project>/.env.local", inactivityMs: 120_000, inactivitySource: "the product's default" },
          chatIdleMs: 1_200_000,
          itemTimeoutsMs: { "S1#1": 7_880_000 },
        },
        models: { designAgent: { models: ["model-x"], source: "transcripts" }, director: { models: [], source: "not recorded" }, designAgentOnly: [], judge: [] },
        inheritedConfiguration: syntheticConfiguration(),
        harnessFiles: [{ file: "budget.ts", sha256: "e".repeat(64) }],
      },
      archive: null,
      scenarios: [{ ...record("S1", 1), costs: costs({ designUsage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 } }) }],
      comparisons: [],
      wallMs: 1000,
    };
    const md = renderSummary(results);
    const BANNER_CLASSES =
      "**Of the 4 variable(s) of the harness's own environment that are not reviewed as harmless, 2 with a name that looks like an endpoint, socket, token or proxy variable, or is NODE_OPTIONS, and 0 with a name that contains MODEL (such a variable can point a call elsewhere, change how its process starts or choose a model); the names are in results.json only, never committed.**";
    expect(md).toContain(`synthetic brand "${SYNTHETIC_BRAND.name}"`);
    expect(md).toContain("in this order: S1#1, S1#2");
    expect(md).toContain("| S1#1 with Director | 1 | 2 | 3 | 4 | 10 |");
    // Only the count and the combined hash are shown; the per-file table stays in results.json.
    expect(md).toContain("2 item(s) fingerprinted, combined SHA-256 `" + "c".repeat(64) + "`");
    expect(md).not.toContain("~/.claude/settings.json");
    expect(md).not.toContain("| File | Exists |");
    expect(md).toContain("Limitation: The harness strips CLAUDE_CODE_*");
    expect(md).toContain("model-x");
    expect(md).toContain("CLI pin: CLI pinned: every model call uses ~/bin/claude (1.0.0 (Claude Code)).");
    expect(md).toContain(`Pinned file: 1234 bytes, SHA-256 \`${"f".repeat(64)}\`; checked again 2 time(s), at each server start and at the end of the run.`);
    expect(md).toContain("**Not comparable: the pinned CLI changed during the run** (end of the run: SHA-256 changed).");
    expect(md).toContain(
      "**CLI version mismatch:** **CLI version unverified:** Design Agent sessions (the Director arm's and the Design-Agent-only arm's) on the configured version 1.0.0, from their transcripts: 1 match, 1 differ, 1 unknown, 2 without a session id."
    );
    expect(md).toContain("**Director version not shown:** the pin did not hold or no re-check was made at the end of the run");
    expect(md).toContain("Judge: version 1.0.0, shown by the resolved pin and the file re-checks, the last at the end of the run (not read from a transcript: synthetic judge).");
    // The allowlist's names are fixed strings of the harness's source and are named; a name that is not on it is counted.
    expect(md).toContain(
      "Variables the servers' .env files add beyond the harness's environment, as Next.js's loader leaves them (the allowlist's names are named, any other is counted): `DESIGN_AGENT_TIMEOUT_SECONDS`; **not allowed: 1 variable(s), named in results.json only**."
    );
    expect(md).not.toContain("HTTPS_PROXY");
    expect(md).toContain("**Lines the loader's result does not account for:** <project>/.env.local line 4.");
    expect(md).toContain("Those 1 file(s) were hashed when checked and 2 time(s) again, at each server start and at the end of the run.");
    expect(md).toContain("**Not comparable: the servers' .env files changed during the run** (end of the run: <project>/.env.local changed).");
    // Only counts of the unreviewed names are shown, by class; no name from the machine reaches the summary.
    expect(md).toContain(
      "4 variable(s) of the harness's own environment that reach every server, judge and arm are not reviewed as harmless (2 with a name that looks like an endpoint, socket, token or proxy variable, or is NODE_OPTIONS, and 0 with a name that contains MODEL); their names, never values, are in results.json under harnessEnvironment, which is never committed (the model, effort and thinking variables are fingerprinted by name and value hash instead)."
    );
    expect(md).not.toContain("ACME_BUILD_FLAG");
    expect(md).not.toContain("npm_config_node_options");
    expect(md).not.toContain("NODE_OPTIONS`");
    expect(md).toContain(BANNER_CLASSES);
    expect(md).toContain(
      "**Model price not shown:** 2 variable(s) whose name contains MODEL reached the run (their names are in results.json under modelPricing, never committed). " + MODEL_PRICE_NOTE
    );
    expect(md).not.toContain("`ANTHROPIC_MODEL`");
    expect(md).toContain("**Settings keys present that can change a model call (the CLI's own key names, never values; any other key is counted): user: env, model; managed: modelPricing.**");
    expect(md).toContain("2 present of 3 looked for (`user`, `managed`); their key names, the names under env and the drop-in files' names are in results.json under settingsKeys, which is never committed, and no value is read into any record.");
    expect(md).toContain("This summary names only the CLI's own settings key names from a fixed list (model, effortLevel, alwaysThinkingEnabled, env, apiKeyHelper, modelPricing) and counts every other name.");
    expect(md).toContain("HOME differs from the account's home folder; both are redacted as `~` in every stored path, and neither is recorded.");
    // A key name under env is in results.json only.
    expect(md).not.toContain("ANTHROPIC_BASE_URL");
    // One banner line under the commit line names every reason the run is not comparable or not fully verified.
    const lines = md.split("\n");
    const at = lines.findIndex((l) => l.startsWith("Run started "));
    expect(lines[at + 1]).toBe(
      "**Not comparable or not fully verified:** the pinned CLI changed during the run; the servers' .env files changed during the run; a variable whose name contains MODEL reached the run, so a model it chose may not be in the CLI's price table; a session ran a CLI version other than the configured one; a session's CLI version is unknown or a run has no session id; the Director's CLI version is not shown by the pin. The Environment section says which."
    );
    // The environment banners follow it, one line each.
    expect(lines[at + 2]).toBe(BANNER_CLASSES);
    expect(lines[at + 3]).toBe("**Settings keys present that can change a model call (the CLI's own key names, never values; any other key is counted): user: env, model; managed: modelPricing.**");
    expect(md).toContain("deadline 900 s (DESIGN_AGENT_TIMEOUT_SECONDS from <project>/.env.local), inactivity 120 s (the product's default); the arm ran under deadline 900 s, inactivity 120 s. The chat stream may stay quiet for 1200 s.");
    expect(md).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("acceptance baseline: an arm that did not complete is not judged (#232)", () => {
  it("names the stop and judges only an arm that completed", () => {
    expect(notJudgedReason({ ok: true, error: null, subtype: "success" })).toBeNull();
    expect(notJudgedReason({ ok: false, error: "timed out", subtype: null })).toBe("the Design-Agent-only arm did not complete (timed out), so its set is neither scored nor compared");
    expect(notJudgedReason({ ok: false, error: "stalled", subtype: null })).toContain("(stalled)");
    expect(notJudgedReason({ ok: false, error: null, subtype: "error_max_budget_usd" })).toContain("(error_max_budget_usd)");
    expect(notJudgedReason({ ok: false, error: null, subtype: null })).toContain("(no result)");
  });

  it("marks the pairwise row with the stop, and still charges the arm", () => {
    const plan = planRun({ scenarios: [scenario("S1")], repeat: 1, compare: true, caps: capsDefault });
    const stopped: ComparisonRecord = {
      ...comparison("S1", 1, 1.5),
      baselineCarouselId: "c-2",
      baseline: { ...comparison("S1", 1, 1.5).baseline!, ok: false, error: "stalled" },
      baselineExport: { ok: true, pngs: 2 },
      notJudged: "the Design-Agent-only arm did not complete (stalled), so its set is neither scored nor compared",
    };
    const md = renderSummary(summaryResults({ comparisons: [stopped] }));
    expect(md).toContain("| S1#1 | - | NOT JUDGED | - | - | - | 2 | $1.500 | - | the Design-Agent-only arm did not complete (stalled), so its set is neither scored nor compared |");
    expect(md).not.toContain("| S1#1 | A=");
    // It ran, so what it measured is charged, and it is not counted as a completed run.
    expect(settlementDetail({ scenarios: [record("S1", 1)], comparisons: [stopped] }, plan, capsDefault).items[0].costUsd).toBeGreaterThanOrEqual(1.5);
    expect(completeness({ scenarios: [], comparisons: [stopped] })).toEqual([{ scenario: "S1 Design Agent only", runs: 1, completed: 0, checksPassed: 0, checksTotal: 0, harnessErrors: 0 }]);
  });
});

describe("acceptance baseline: the eval config refuses a paid run before any spend (#232)", () => {
  const RESULTS = path.join(ROOT, "eval", "results");
  const resultFolders = () => (existsSync(RESULTS) ? readdirSync(RESULTS).sort() : []);

  /** The eval config as a subprocess without EVAL_DRY: a paid run as far as its refusal. No server and no real CLI is ever started. */
  async function paidRun(env: Record<string, string>) {
    const home = path.join(workdir, "home");
    await mkdir(home, { recursive: true });
    const ledger = path.join(workdir, "ledger-folder", "ledger.jsonl");
    const archive = path.join(workdir, "archive");
    const before = resultFolders();
    const result = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.eval.config.ts", "eval/acceptance/acceptance.eval.ts"], {
      cwd: ROOT,
      // The caps are valid and the plan fits, so only the check under test refuses it.
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        EVAL_LEDGER: ledger,
        EVAL_ARCHIVE_DIR: archive,
        EVAL_ONLY: "S1",
        EVAL_COMPARE: "0",
        DIRECTOR_MAX_BUDGET_USD: "0.5",
        DESIGN_AGENT_MAX_BUDGET_USD: "3",
        ...env,
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 200_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    // Refused: non-zero, and nothing ran, was reserved, was archived or was started.
    expect(result.status, output).not.toBe(0);
    // No reservation: not even the ledger's folder was made, and nothing was archived.
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(path.dirname(ledger))).toBe(false);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
    expect(existsSync(archive)).toBe(false);
    // No server and no test: a started server or a run creates this run's results folder (its logs, results.json and summary.md go there).
    expect(resultFolders()).toEqual(before);
    expect(output).not.toMatch(/\d+ passed/);
    return output;
  }

  it("exits non-zero with the refusal text, writes no ledger file and no reservation, and starts no server and no real CLI", { timeout: 240_000 }, async () => {
    // An explicit CLI that is not there: the pin check refuses it, and nothing is ever spawned for it.
    const output = await paidRun({ CLAUDE_CLI_PATH: path.join(workdir, "absent-claude") });
    expect(output).toContain("Refusing a paid run before any spend: the CLI is not pinned");
    expect(output).toContain("a CLI is missing or its version is unknown");
    expect(output).toContain("Run the harness with CLAUDE_CLI_PATH=<one installed CLI> in its environment.");
  });

  it("refuses a paid dev run before the reservation, because next dev reloads the .env files into a running server", { timeout: 240_000 }, async () => {
    const output = await paidRun({ EVAL_MODE: "dev", CLAUDE_CLI_PATH: path.join(workdir, "absent-claude") });
    expect(output).toContain(DEV_MODE_REFUSAL);
    // The dev refusal comes first, so the CLI check does not speak for it.
    expect(output).not.toContain("the CLI is not pinned");
  });

  it("refuses a paid run when the harness's own environment sets a token limit, and names it", { timeout: 240_000 }, async () => {
    // A CLI that only answers --version, so the pin check passes and the next check speaks. It is never run for a model.
    const cli = path.join(workdir, "claude-pinned");
    await writeFile(cli, '#!/bin/sh\necho "2.0.1 (Claude Code)"\n');
    chmodSync(cli, 0o755);
    const output = await paidRun({ CLAUDE_CLI_PATH: cli, MAX_THINKING_TOKENS: "1000", ANTHROPIC_UNIX_SOCKET: "/nonexistent" });
    expect(output).toContain("Refusing a paid run before any spend: the harness's own environment sets MAX_THINKING_TOKENS,");
    // The socket is recorded by name, not refused, so it is not what stopped the run.
    expect(output).not.toContain("sets MAX_THINKING_TOKENS, ANTHROPIC_UNIX_SOCKET");
  });
});

describe("acceptance baseline: a dry run prints the plan, what it records and what a paid run would refuse (#232)", () => {
  it("prints the unreviewed harness variables and the model selection variables as counts, never by name, with the dev-mode refusal, starting nothing", { timeout: 240_000 }, async () => {
    const home = path.join(workdir, "home");
    await mkdir(home);
    const VALUE = "synthetic-secret-value";
    const run = (mode: string) =>
      spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.eval.config.ts", "eval/acceptance/acceptance.eval.ts"], {
        cwd: ROOT,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          LANG: "C",
          EVAL_DRY: "1",
          EVAL_MODE: mode,
          EVAL_LEDGER: path.join(workdir, "ledger.jsonl"),
          EVAL_ARCHIVE_DIR: path.join(workdir, "archive"),
          EVAL_ONLY: "S1",
          EVAL_COMPARE: "0",
          DIRECTOR_MAX_BUDGET_USD: "0.5",
          DESIGN_AGENT_MAX_BUDGET_USD: "3",
          CLAUDE_CLI_PATH: path.join(workdir, "absent-claude"),
          ANTHROPIC_UNIX_SOCKET: VALUE,
          ANTHROPIC_CUSTOM_HEADERS: VALUE,
          OTEL_EXPORTER_OTLP_ENDPOINT: VALUE,
          GITHUB_TOKEN: VALUE,
          ANTHROPIC_MODEL: VALUE,
          npm_config_node_options: VALUE,
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 200_000,
      });
    const before = existsSync(path.join(ROOT, "eval", "results")) ? readdirSync(path.join(ROOT, "eval", "results")).sort() : [];
    const dev = run("dev");
    const output = `${dev.stdout}\n${dev.stderr}`;
    expect(dev.status, output).toBe(0);
    const line = output.split("\n").find((l) => l.includes("not reviewed as harmless")) ?? "";
    // No name is printed, by class or otherwise: the counts are what summary.md shows of these names.
    for (const name of ["ANTHROPIC_UNIX_SOCKET", "ANTHROPIC_CUSTOM_HEADERS", "OTEL_EXPORTER_OTLP_ENDPOINT", "GITHUB_TOKEN", "npm_config_node_options", "ANTHROPIC_MODEL"]) expect(output, name).not.toContain(name);
    // Of the variables set here besides the model one (which is fingerprinted instead), the socket, the endpoint and the token look like one of those; the headers and the npm name do not.
    expect(line).toMatch(
      /\[acceptance\] [1-9]\d* variable\(s\) in the harness's own environment that reach every server, judge and arm are not reviewed as harmless \([3-9] with a name that looks like an endpoint, socket, token or proxy variable, or is NODE_OPTIONS, and 0 with a name that contains MODEL\); counts only here and in summary\.md/
    );
    // Reviewed names are not listed, the model variable is fingerprinted instead, and no value is ever printed.
    expect(line).not.toMatch(/\bPATH\b|\bHOME\b|\bEVAL_/);
    expect(output).not.toContain(VALUE);
    expect(output).toContain("[acceptance] 1 variable(s) whose name contains MODEL among those the servers, arm and judges receive (counted, not named; the names are in results.json); the run is flagged");
    expect(output).toContain(`[acceptance] A paid run would be refused: ${DEV_MODE_REFUSAL}`);
    expect(output).toContain("1 passed");
    // A dry run starts nothing, so it leaves no results folder either.
    expect(existsSync(path.join(ROOT, "eval", "results")) ? readdirSync(path.join(ROOT, "eval", "results")).sort() : []).toEqual(before);
  });
});

describe("acceptance baseline: the server start gate and what a refusal means for an item (#232)", () => {
  const scrubbed = (text: string) => text.replace(/\/home\/synthetic/g, "~");

  it("names the pinned CLI's differences first and the .env files' after, one entry each", () => {
    expect(startChanges([], [])).toEqual([]);
    expect(startChanges(["SHA-256 changed", "size changed from 1 to 2 bytes"], ["<project>/.env.local changed"])).toEqual([
      "the pinned CLI: SHA-256 changed",
      "the pinned CLI: size changed from 1 to 2 bytes",
      "<project>/.env.local changed",
    ]);
  });

  it("admits a start with no difference, refuses the first with one, and stays closed for every later start", () => {
    const gate = new StartGate();
    expect(gate.refusal).toBeNull();
    gate.assertOpen();
    expect(() => gate.admit([])).not.toThrow();
    const changes = startChanges(["SHA-256 changed"], ["<project>/.env.local changed"]);
    expect(() => gate.admit(changes)).toThrow(ServerStartRefused);
    const refusal = gate.refusal!;
    expect(refusal).toBe("The pinned CLI or the servers' .env files changed since the run began (the pinned CLI: SHA-256 changed; <project>/.env.local changed), so no further model call is made");
    // Closed for good: a later clean check does not reopen it, and a later start gets the first refusal's text.
    expect(() => gate.admit([])).toThrow(refusal);
    expect(() => gate.assertOpen()).toThrow(ServerStartRefused);
    expect(() => gate.admit(["something else"])).toThrow(refusal);
    expect(gate.refusal).toBe(refusal);
    // Another run's gate is its own.
    expect(() => new StartGate().admit([])).not.toThrow();
  });

  it("classifies an item's error: a refusal before any chat is not run, every other error, a refusal after a chat included, is a harness error", () => {
    const refusal = new ServerStartRefused("changed under /home/synthetic/checkout");
    expect(classifyItemFailure(refusal, 0, scrubbed)).toEqual({ kind: "not-run", reason: "changed under ~/checkout" });
    // After the item's own chats the model was called: charged in full, and a failure.
    const after = classifyItemFailure(refusal, 2, scrubbed);
    expect(after.kind).toBe("harness-error");
    expect((after as { message: string }).message).toContain("changed under ~/checkout");
    expect((after as { message: string }).message).not.toContain("/home/synthetic");
    const other = classifyItemFailure(new Error("port 3417 is in /home/synthetic/use"), 0, scrubbed);
    expect(other.kind).toBe("harness-error");
    expect((other as { message: string }).message).toContain("port 3417 is in ~/use");
    expect(classifyItemFailure("not an error object", 0, scrubbed)).toEqual({ kind: "harness-error", message: "not an error object" });
    expect(classifyItemFailure(undefined, 1, scrubbed)).toEqual({ kind: "harness-error", message: "undefined" });
  });

  it("gives a skipped comparison the refusal's text for an item that was not run, and 'no export' only when the item ran", () => {
    expect(skippedComparisonReason({ notRun: null, directorExport: true })).toBeNull();
    expect(skippedComparisonReason({ notRun: null, directorExport: false })).toBe("the Director arm produced no export to compare");
    const notRun = "The pinned CLI or the servers' .env files changed since the run began (the pinned CLI: SHA-256 changed), so no further model call is made";
    for (const directorExport of [false, true]) {
      const reason = skippedComparisonReason({ notRun, directorExport })!;
      expect(reason).toBe(`the item was not run: ${notRun}`);
      expect(reason).not.toContain("produced no export");
    }
  });
});

describe("acceptance baseline: modules without an import cycle (#232)", () => {
  /** The local modules a harness file imports, with or without `type`. */
  const imports = (file: string) => [...readFileSync(path.join(ROOT, "eval", "acceptance", `${file}.ts`), "utf8").matchAll(/^(?:import|export)\s[^;]*?from\s+"\.\/([\w-]+)"/gm)].map((m) => m[1]);

  it("keeps cli.ts and environment.ts apart: redactPath lives in a module that imports nothing local", () => {
    expect(imports("redact")).toEqual([]);
    expect(imports("cli")).not.toContain("environment");
    expect(imports("harness-env")).toEqual([]);
    expect(imports("server-env")).toEqual([]);
    // Same function, found where it always was.
    expect(redactPath).toBe(redactPathFromModule);
    expect(redactPathFromModule("/home/synthetic/.local/bin/claude", "/home/synthetic")).toBe("~/.local/bin/claude");
  });
});

describe("acceptance baseline: the comparability banner (#232)", () => {
  const withEnvironment = (change: (e: EnvironmentRecord) => void): RunResults => {
    const environment = cleanEnvironment();
    change(environment);
    return summaryResults({ environment });
  };
  const banner = (results: RunResults) => renderSummary(results).split("\n").filter((l) => l.startsWith("**Not comparable or not fully verified:**"));

  it("is absent when the pin held, the files did not change and every version is shown", () => {
    expect(comparabilityFlags(null)).toEqual([]);
    expect(comparabilityFlags(cleanEnvironment())).toEqual([]);
    expect(banner(withEnvironment(() => {}))).toEqual([]);
    expect(renderSummary(withEnvironment(() => {}))).toContain("Variables whose name contains MODEL: none among those the servers, the arm and the judges receive.");
  });

  it("names each reason on one line under the commit line", () => {
    const one = (change: (e: EnvironmentRecord) => void) => comparabilityFlags(withEnvironment(change).environment);
    expect(one((e) => (e.cli.pin.changed = true))).toEqual(["the pinned CLI changed during the run"]);
    expect(one((e) => (e.serverEnvFiles.changed = true))).toEqual(["the servers' .env files changed during the run"]);
    expect(one((e) => (e.modelPricing = modelPricing(["ANTHROPIC_MODEL"])))).toEqual(["a variable whose name contains MODEL reached the run, so a model it chose may not be in the CLI's price table"]);
    expect(one((e) => (e.cli.sessions!.mismatch = true))).toEqual(["a session ran a CLI version other than the configured one"]);
    expect(one((e) => (e.cli.sessions!.unverified = true))).toEqual(["a session's CLI version is unknown or a run has no session id"]);
    expect(one((e) => (e.cli.sessions!.director.proven = false))).toEqual(["the Director's CLI version is not shown by the pin"]);
    expect(one((e) => (e.cli.sessions!.judge.proven = false))).toEqual(["the judge's CLI version is not shown by the pin"]);
    // A run killed before its versions were recorded is not verified either.
    expect(one((e) => (e.cli.sessions = null))).toEqual(["the CLI versions of the sessions were not recorded"]);
    const lines = renderSummary(withEnvironment((e) => (e.serverEnvFiles.changed = true))).split("\n");
    const at = lines.findIndex((l) => l.startsWith("Run started "));
    expect(lines[at + 1]).toBe("**Not comparable or not fully verified:** the servers' .env files changed during the run. The Environment section says which.");
    expect(banner(withEnvironment((e) => { e.cli.pin.changed = true; e.cli.sessions!.mismatch = true; }))).toHaveLength(1);
  });
});

describe("acceptance baseline: worst case is an upper bound", () => {
  it("limits every call to its cap plus the overshoot allowance", () => {
    expect(callBoundUsd(2, capsDefault)).toBe(2.5);
    expect(callBoundUsd(2, caps)).toBe(2);
    const one = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 1, compare: true, caps: capsDefault });
    // S1: 0.625 + 3.75 + 0.75, plus its comparison 3.75 + 2 x 0.75 = 10.375; S10: 0.625 + 3.75 + 2 x 0.75 = 5.875.
    expect(one.items.map((i) => i.worstCaseUsd)).toEqual([10.375, 5.875]);
    expect(one.worstCaseUsd).toBe(16.25);
    expect(planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 3, compare: true, caps: capsDefault }).worstCaseUsd).toBe(48.75);
  });

  it("reads EVAL_OVERSHOOT_FRACTION as a number above 0 and at most 1, 0.25 by default", () => {
    expect(parseOvershoot(undefined)).toBe(0.25);
    expect(parseOvershoot("  ")).toBe(0.25);
    expect(parseOvershoot("0.01")).toBe(0.01);
    expect(parseOvershoot("1")).toBe(1);
    // Zero would claim a call never ends above its cap, which the turn that crosses a cap disproves.
    for (const bad of ["0", "0.0", "-0.1", "1.5", "abc", "25%"]) expect(() => parseOvershoot(bad)).toThrow(/EVAL_OVERSHOOT_FRACTION must be a number above 0/);
    expect(() => parseCaps({ DIRECTOR_MAX_BUDGET_USD: "0.5", DESIGN_AGENT_MAX_BUDGET_USD: "3", EVAL_OVERSHOOT_FRACTION: "0" })).toThrow(/above 0/);
  });

  it("makes the preflight refuse a plan that only fits without the allowance", () => {
    const withAllowance = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 1, compare: true, caps: capsDefault }); // 16.25
    const without = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 1, compare: true, caps }); // 13.00
    const ledger = [entry({ costUsd: 35 })]; // 15 remaining of 50
    expect(preflight(without, ledger, 50).ok).toBe(true);
    expect(preflight(withAllowance, ledger, 50)).toMatchObject({ ok: false, worstCaseUsd: 16.25, remainingUsd: 15 });
    expect(renderPlan(withAllowance, preflight(withAllowance, [], 50), "ledger")).toContain("Overshoot allowance 25% of each cap");
  });
});

describe("acceptance baseline: hold-back for the post-containment rerun", () => {
  it("reads EVAL_HOLD_BACK_USD as USD 0 or more, 0 by default", () => {
    expect(parseHoldBack(undefined)).toBe(0);
    expect(parseHoldBack("")).toBe(0);
    expect(parseHoldBack("0")).toBe(0);
    expect(parseHoldBack("15.5")).toBe(15.5);
    for (const bad of ["-1", "abc", "1e3"]) expect(() => parseHoldBack(bad)).toThrow(/EVAL_HOLD_BACK_USD/);
  });

  it("requires the worst case to fit the remaining allowance less the hold-back", () => {
    const plan = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 1, compare: true, caps }); // 13.00
    expect(preflight(plan, [entry({ costUsd: 30 })], 50, 7)).toMatchObject({ ok: true, remainingUsd: 20, holdBackUsd: 7 });
    const refused = preflight(plan, [entry({ costUsd: 30 })], 50, 8);
    expect(refused).toMatchObject({ ok: false, holdBackUsd: 8 });
    expect(refused.message).toContain("less the $8.00 hold-back (usable $12.00)");
    // No hold-back is the plain preflight.
    expect(preflight(plan, [entry({ costUsd: 30 })], 50)).toMatchObject({ ok: true, holdBackUsd: 0 });
  });

  it("prints the hold-back in the dry run and says the rerun must fit in the same cap", () => {
    const plan = planRun({ scenarios: [scenario("S1")], repeat: 1, compare: false, caps });
    const text = renderPlan(plan, preflight(plan, [entry({ costUsd: 10 })], 50, 25), "ledger");
    expect(text).toContain("Hold-back for the post-containment rerun (EVAL_HOLD_BACK_USD): $25.00; usable by this run $15.00. The rerun must fit in the same cap.");
  });
});

describe("acceptance baseline: settlement", () => {
  // S1 (with its comparison) and S10, at the default allowance: bounds Director 0.625, design 3.75, judge 0.75.
  const plan = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 1, compare: true, caps: capsDefault });
  /** One scenario without a comparison arm, for the tests of the run arm alone. */
  const solo = planRun({ scenarios: [scenario("S1")], repeat: 1, compare: false, caps: capsDefault });
  const settle = (results: Pick<RunResults, "scenarios" | "comparisons">) => settlementDetail(results, plan, capsDefault);
  const item = (results: Pick<RunResults, "scenarios" | "comparisons">, key: string) => settle(results).items.find((i) => i.key === key)!;

  it("charges the measured cost when every call reported one, and nothing for an item that never began", () => {
    const results = { scenarios: [ranS1()], comparisons: [comparedS1()] };
    // 0.2 + 1.5 + 0.3 for the Director arm, 1.2 + 0.25 + 0.35 for the Design-Agent-only arm.
    expect(settlementUsd(results, plan, capsDefault)).toBe(3.8);
    expect(settle(results)).toMatchObject({ costUsd: 3.8, atBoundCalls: 0 });
    expect(item(results, "S10#1")).toMatchObject({ costUsd: 0, atBoundCalls: 0 });
  });

  it("charges a judge that timed out or was killed at its per-call limit", () => {
    const results = { scenarios: [ranS1({ judge: failedJudge("timed out") })], comparisons: [comparedS1()] };
    expect(settlementUsd(results, plan, capsDefault)).toBeCloseTo(3.8 - 0.3 + 0.75);
    expect(item(results, "S1#1")).toMatchObject({ atBoundCalls: 1 });
    expect(item(results, "S1#1").reasons).toEqual(["1 judge call(s) without a measured cost"]);
  });

  it("charges a Design Agent run that logged no cost at its bound, but not one that only lacked usage", () => {
    const noCost = ranS1({ costs: costs({ directorCostUsd: 0.2, designCostUsd: null, designUsage: null, designRunsWithoutUsage: 1 }) });
    expect(settlementUsd({ scenarios: [noCost], comparisons: [comparedS1()] }, plan, capsDefault)).toBe(3.8 - 1.5 + 3.75);
    // The cost and the usage are separate fields: a run with a cost and no usage is measured.
    const noUsage = ranS1({ costs: costs({ directorCostUsd: 0.2, designCostUsd: 1.5, designUsage: null, designRunsWithoutUsage: 1 }) });
    expect(settlementUsd({ scenarios: [noUsage], comparisons: [comparedS1()] }, plan, capsDefault)).toBe(3.8);
  });

  it("charges the design run that has no cost when two ran and only one reported one", () => {
    const two = ranS1({
      chats: [designed(), chatRecord(1000, {}, { events: [stageEvent("designing")] }, { retryRunId: "r-1" })],
      costs: costs({ directorCostUsd: 0.2, designCostUsd: 1, designRuns: 2 }),
    });
    // The sums read 1.0 and would hide the second run: 0.2 + 1.0 + 3.75 + 0.3, plus the comparison's 1.8.
    expect(settlementUsd({ scenarios: [two], comparisons: [comparedS1()] }, plan, capsDefault)).toBeCloseTo(5.25 + 1.8);
    expect(item({ scenarios: [two], comparisons: [comparedS1()] }, "S1#1").atBoundCalls).toBe(1);
  });

  it("charges a design run the stream started even when the server logged no line for it", () => {
    // A server killed mid-design writes no "run finished" line, so only the stream shows it started.
    const killed = ranS1({ costs: costs({ directorCostUsd: 0.2, designCostUsd: null, designUsage: null, designRuns: 0 }) });
    expect(settlementUsd({ scenarios: [killed], comparisons: [comparedS1()] }, plan, capsDefault)).toBeCloseTo(0.2 + 3.75 + 0.3 + 1.8);
    // And a Director that planned but whose cost was never logged.
    const noPlan = ranS1({ costs: costs({ directorCostUsd: null, designCostUsd: 1.5, directorRuns: 0 }) });
    expect(settlementUsd({ scenarios: [noPlan], comparisons: [comparedS1()] }, plan, capsDefault)).toBeCloseTo(0.625 + 1.5 + 0.3 + 1.8);
  });

  it("charges a Design-Agent-only arm that timed out at the design bound", () => {
    const timedOut = comparedS1({
      baseline: { ok: false, durationMs: 1, costUsd: null, usage: null, turns: null, models: [], subtype: null, resultText: null, sessionId: null, error: "timed out" },
      baselineExport: { ok: false, pngs: 0, error: "no slides" },
      baselineJudge: null,
      pairwise: null,
    });
    expect(settlementUsd({ scenarios: [ranS1()], comparisons: [timedOut] }, plan, capsDefault)).toBeCloseTo(2 + 3.75);
  });

  it("keeps what a comparison measured before it threw, and charges the judge it may have started", () => {
    // The record is filled in place and kept, not replaced by an empty one: the paid arm and its judge are charged.
    const threw = comparedS1({ pairwise: null, harnessError: "Error: boom", baselineJudge: judgeCall(scores(3), 4, 0.25) });
    const detail = settle({ scenarios: [ranS1()], comparisons: [threw] });
    expect(detail.costUsd).toBeCloseTo(2 + 1.2 + 0.25 + 0.75);
    expect(detail.items[0].reasons).toContain("1 unrecorded comparison judge call(s) after a harness error");
    // Had it been replaced by an empty record, the paid arm would have counted as nothing.
    expect(settlementUsd({ scenarios: [ranS1()], comparisons: [{ ...comparison("S1", 1, 1.2), baseline: null, finished: true, harnessError: "Error: boom" }] }, plan, capsDefault)).toBeCloseTo(2);
    // A comparison that threw before its set was exported started no judge.
    const early = comparedS1({ pairwise: null, baselineJudge: null, baselineExport: null, harnessError: "Error: boom" });
    expect(settlementUsd({ scenarios: [ranS1()], comparisons: [early] }, plan, capsDefault)).toBeCloseTo(2 + 1.2);
  });

  it("charges an item recorded as not run after a refused server start nothing, and its skipped comparison nothing; one refused after its chats stays a harness error, charged in full", () => {
    // What the harness records once a server start is refused: no chat, no error, finished, and a comparison skipped for want of an export.
    const notRun = { ...record("S1", 1), outcome: "not run: the pinned CLI changed since the run began", chats: [] };
    const skipped = { ...comparison("S1", 1, 0), baseline: null, skipped: "the Director arm produced no export to compare" };
    const refused = settlementDetail({ scenarios: [notRun], comparisons: [skipped] }, plan, capsDefault);
    expect(refused.items.find((i) => i.key === "S1#1")).toMatchObject({ costUsd: 0, measuredUsd: 0, atBoundCalls: 0 });
    expect(refused.costUsd).toBeCloseTo(0, 9);
    // The same item as a harness error (refused after its own chats, so what had started is unknown) is charged every planned call.
    const failed = settlementDetail({ scenarios: [{ ...notRun, harnessError: "Error: refused" }], comparisons: [] }, plan, capsDefault);
    expect(failed.items.find((i) => i.key === "S1#1")!.costUsd).toBeGreaterThan(0);
    expect(failed.items.find((i) => i.key === "S1#1")!.reasons.join(" ")).toContain("harness error: what had started is unknown");
  });

  it("charges a skipped comparison nothing", () => {
    const skipped = { ...comparison("S1", 1, 0), baseline: null, skipped: "the Director arm produced no export to compare" };
    expect(settlementUsd({ scenarios: [ranS1()], comparisons: [skipped] }, plan, capsDefault)).toBeCloseTo(2);
  });

  it("charges every planned call of a run arm that failed before it recorded anything", () => {
    const failed: ScenarioRecord = { ...record("S1", 1), chats: [designed()], harnessError: "Error: boom", costs: null };
    const detail = settle({ scenarios: [failed], comparisons: [] });
    // The Director, design and judge at their bounds: 0.625 + 3.75 + 0.75. The comparison never began.
    expect(detail.costUsd).toBe(5.125);
    expect(detail.atBoundCalls).toBe(3);
  });

  it("charges a test that timed out at its full worst case, whatever was measured", () => {
    const cutOff: ScenarioRecord = { ...ranS1(), finished: false, outcome: "not run", judge: null, costs: costs({ directorCostUsd: 0.2, designCostUsd: null }) };
    const detail = settle({ scenarios: [cutOff], comparisons: [] });
    expect(detail.items[0].costUsd).toBe(plan.items[0].worstCaseUsd); // 10.375, the comparison included
    expect(detail.items[1].costUsd).toBe(0);
    // Measured cost above its limit is charged as measured, never lowered to it; the other planned calls stay at their limits.
    const over: ScenarioRecord = { ...cutOff, costs: costs({ directorCostUsd: 0.2, designCostUsd: 9 }) };
    expect(settle({ scenarios: [over], comparisons: [] }).items[0].costUsd).toBeCloseTo(0.625 + 9 + 0.75 + 5.25);
  });

  it("charges each planned call of an unfinished item at the larger of what it measured and its limit", () => {
    // The probe: a Director that measured 0.2, a design run that measured 4.5 (above its 3.75 limit) and a judge that was never recorded.
    const probe: ScenarioRecord = { ...ranS1(), finished: false, judge: null, costs: costs({ directorCostUsd: 0.2, designCostUsd: 4.5 }) };
    const detail = settlementDetail({ scenarios: [probe], comparisons: [] }, solo, capsDefault);
    expect(detail.costUsd).toBeGreaterThanOrEqual(0.2 + 4.5 + 0.75);
    // 0.625 (Director at its limit, since 0.2 is below it) + 4.5 (design as measured) + 0.75 (judge at its limit).
    expect(detail.costUsd).toBe(5.875);
    expect(detail.items[0]).toMatchObject({ atBoundCalls: 2, overLimitCalls: 1, measuredUsd: 4.7 });
    // The same arm after a harness error is charged the same way.
    const failed: ScenarioRecord = { ...probe, finished: true, harnessError: "Error: boom" };
    expect(settlementUsd({ scenarios: [failed], comparisons: [] }, solo, capsDefault)).toBe(5.875);
    // Measured calls beyond the plan are charged as measured, and an unfinished comparison does the same for its calls.
    const extra: ScenarioRecord = { ...probe, costs: costs({ designCostUsd: 3, designCallCosts: [3, 2.5] }) };
    expect(settlementDetail({ scenarios: [extra], comparisons: [] }, solo, capsDefault).items[0]).toMatchObject({ costUsd: 0.625 + 3.75 + 2.5 + 0.75, beyondPlanCalls: 1 });
    const cutOffComparison = comparedS1({ finished: false, baseline: { ...comparison("S1", 1, 4.5).baseline!, costUsd: 4.5 }, baselineJudge: null, pairwise: null });
    expect(settlementUsd({ scenarios: [ranS1()], comparisons: [cutOffComparison] }, plan, capsDefault)).toBeCloseTo(2 + 4.5 + 1.5);
  });

  it("counts a call measured above its limit, and one that ran beyond the plan", () => {
    const over = ranS1({ costs: costs({ directorCostUsd: 0.2, designCostUsd: 4.5 }) });
    const detail = settlementDetail({ scenarios: [over], comparisons: [] }, solo, capsDefault);
    // Charged as measured, and the allowance that was too small for it is counted.
    expect(detail).toMatchObject({ costUsd: 0.2 + 4.5 + 0.3, overLimitCalls: 1, atBoundCalls: 0, beyondPlanCalls: 0 });
    // A graceful restart in a production build can let the retry design a second time: the killed first run logs no line.
    const twice = ranS1({
      chats: [designed(), chatRecord(1000, {}, { events: [stageEvent("designing")] }, { retryRunId: "r-1" })],
      costs: costs({ directorCostUsd: 0.2, designCostUsd: 1.5, designRuns: 1 }),
    });
    const second = settlementDetail({ scenarios: [twice], comparisons: [] }, solo, capsDefault);
    expect(second.items[0]).toMatchObject({ beyondPlanCalls: 1, atBoundCalls: 1 });
    expect(second.items[0].reasons).toEqual(["1 Design Agent run(s) without a measured cost", "1 Design Agent run(s) beyond the plan"]);
    expect(second.costUsd).toBeCloseTo(0.2 + 1.5 + 3.75 + 0.3);
  });

  it("charges a comparison that did not finish at its full bound", () => {
    const cutOff = comparedS1({ finished: false, pairwise: null });
    expect(settlementUsd({ scenarios: [ranS1()], comparisons: [cutOff] }, plan, capsDefault)).toBeCloseTo(2 + 5.25);
  });

  it("charges the comparison in full when the test ended right after the run arm", () => {
    expect(settlementUsd({ scenarios: [ranS1()], comparisons: [] }, plan, capsDefault)).toBeCloseTo(2 + 5.25);
  });

  it("collects the restart scenario's early-return costs from the log, and charges the Director if they were not collected", async () => {
    const restart = planRun({ scenarios: [scenario("S9")], repeat: 1, compare: false, caps: capsDefault });
    const log = path.join(workdir, "server.log");
    await writeFile(log, format("[creative-run] planned", { carouselId: "c-1", runId: "r-1", outcome: "ready", durationMs: 4200, costUsd: 0.2, turns: 2 }) + "\n");
    const { entries, ...collected } = await serverCosts(log, "c-1");
    expect(entries).toHaveLength(1);
    const stopped = chatRecord(1000, {}, { events: [stageEvent("planning"), stageEvent("preparing-images")], streamError: "terminated" });
    const base: ScenarioRecord = {
      ...record("S9", 1),
      chats: [stopped],
      outcome: "not exercised: the graceful stop cancelled the run",
      afterStop: { signal: "SIGINT", ended: null, tasks: [], staging: {} as never },
    };
    // The Director ran and the stop came during images: only its measured cost is owed.
    expect(settlementDetail({ scenarios: [{ ...base, costs: collected }], comparisons: [] }, restart, capsDefault).costUsd).toBe(0.2);
    // Without the collection the Director would have been charged at its bound.
    expect(settlementDetail({ scenarios: [base], comparisons: [] }, restart, capsDefault).costUsd).toBe(0.625);
  });

  it("treats a stream that broke while the server was up as no evidence that nothing started", () => {
    const broke: ScenarioRecord = { ...record("S1", 1), chats: [chatRecord(1000, {}, { events: [], streamError: "terminated" })], costs: null };
    expect(settlementDetail({ scenarios: [broke], comparisons: [] }, solo, capsDefault).items[0]).toMatchObject({ costUsd: 4.375, atBoundCalls: 2 }); // Director and design bounds
    // A non-200 answer started nothing.
    const refused: ScenarioRecord = { ...record("S1", 1), chats: [chatRecord(10, {}, { httpStatus: 409, httpError: "busy" })], costs: null };
    expect(settlementDetail({ scenarios: [refused], comparisons: [] }, solo, capsDefault).items[0].costUsd).toBe(0);
  });

  it("rounds up to the micro-dollar and never lowers a measured cost to the cap", () => {
    const fractional = ranS1({ costs: costs({ directorCostUsd: 0.1, designCostUsd: 0.2 }), judge: judgeCall(scores(4), 4, 0.0000004) });
    expect(settlementUsd({ scenarios: [fractional], comparisons: [] }, solo, capsDefault)).toBe(0.300001);
    const exact = ranS1({ costs: costs({ directorCostUsd: 0.1, designCostUsd: 0.2 }), judge: judgeCall(scores(4), 4, 0) });
    expect(settlementUsd({ scenarios: [exact], comparisons: [] }, solo, capsDefault)).toBe(0.3);
    // A call that reported more than its bound is charged what it reported.
    const over = ranS1({ costs: costs({ directorCostUsd: 2, designCostUsd: 1 }), judge: judgeCall(scores(4), 4, 0.1) });
    expect(settlementUsd({ scenarios: [over], comparisons: [] }, solo, capsDefault)).toBe(3.1);
  });
});

describe("acceptance baseline: reserve and settle", () => {
  const plan = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 1, compare: true, caps: capsDefault }); // 16.25
  const RUN: RunIdentity = { runId: "acceptance-synthetic", commit: "abc1234", ticket: "#221" };
  const LABEL = "acceptance S1,S10 x1, compare on, prod";
  let ledger: string;
  beforeEach(() => {
    ledger = path.join(workdir, "led", "ledger.jsonl");
  });
  const reserve = () => reserveRun({ ledger, plan, capUsd: 50, run: RUN, note: `${LABEL}: worst case reserved before the run` });
  const settle = (results: Pick<RunResults, "scenarios" | "comparisons">) => settleRun({ ledger, results, plan, reservedUsd: plan.worstCaseUsd, run: RUN, label: LABEL });

  it("reserves the worst case before anything is spent, and counts it in full until settled", () => {
    const { check, reservation } = reserve();
    expect(check).toMatchObject({ ok: true, spentUsd: 0 });
    expect(reservation).toMatchObject({ kind: "reservation", runId: RUN.runId, costUsd: 16.25 });
    expect(ledgerTotals(readLedger(ledger))).toMatchObject({ outstandingUsd: 16.25, settledUsd: 0, unsettled: [RUN.runId] });
  });

  it("refuses a reservation that does not fit and appends nothing", () => {
    appendLedger(ledger, entry({ costUsd: 40 }));
    expect(() => reserve()).toThrow(/^Refused/);
    expect(readLedger(ledger)).toHaveLength(1);
  });

  it("counts each reservation against the next", () => {
    const reserveAs = (n: number) => reserveRun({ ledger, plan, capUsd: 50, run: { ...RUN, runId: `run-${n}` }, note: "n" });
    reserveAs(1);
    reserveAs(2);
    reserveAs(3);
    expect(() => reserveAs(4)).toThrow(/^Refused/); // 3 x 16.25 = 48.75 reserved of 50
    expect(readLedger(ledger)).toHaveLength(3);
  });

  it("keeps the hold-back out of the run's reach", () => {
    appendLedger(ledger, entry({ costUsd: 30 })); // 20 remaining, worst case 16.25
    expect(() => reserveRun({ ledger, plan, capUsd: 50, holdBackUsd: 5, run: RUN, note: "n" })).toThrow(/hold-back/);
    expect(reserveRun({ ledger, plan, capUsd: 50, holdBackUsd: 3, run: RUN, note: "n" }).check.ok).toBe(true);
  });

  it("settles a complete run at its measured cost", () => {
    reserve();
    const { spend, settlement } = settle({ scenarios: [ranS1()], comparisons: [comparedS1()] });
    expect(spend).toMatchObject({ kind: "spend", runId: RUN.runId, costUsd: 3.8 });
    expect(spend.note).toBe(`${LABEL}: 1 of 2 completed, measured cost`);
    expect(settlement.atBoundCalls).toBe(0);
    expect(ledgerTotals(readLedger(ledger))).toMatchObject({ settledUsd: 3.8, outstandingUsd: 0, totalUsd: 3.8, unsettled: [] });
  });

  it("settles after a harness failure at the planned calls' bounds and says the measurement is incomplete", () => {
    reserve();
    const failed: ScenarioRecord = { ...record("S1", 1), chats: [designed()], harnessError: "Error: boom", costs: null };
    const { spend } = settle({ scenarios: [failed], comparisons: [] });
    expect(spend.costUsd).toBe(5.125);
    expect(spend.note).toContain("1 harness failure(s)");
    expect(spend.note).toContain("incomplete measurement: 3 call(s) charged at the per-call limit in 1 item(s) (S1#1); measured $0.00");
  });

  it("settles after a test timeout at the item's full worst case", () => {
    reserve();
    const cutOff: ScenarioRecord = { ...ranS1(), finished: false };
    const { spend, settlement } = settle({ scenarios: [cutOff], comparisons: [] });
    expect(spend.costUsd).toBe(10.375);
    expect(settlement.atBoundCalls).toBe(6);
    expect(spend.note).toContain("incomplete measurement: 6 call(s) charged at the per-call limit in 1 item(s) (S1#1)");
  });

  it("settles a judge without a cost, a design run without usage and a comparison that threw, each noted", () => {
    reserve();
    const judgeless = settle({ scenarios: [ranS1({ judge: failedJudge("timed out") })], comparisons: [comparedS1()] }).spend;
    expect(judgeless.costUsd).toBe(4.25);
    expect(judgeless.note).toContain("incomplete measurement: 1 call(s)");

    ledger = path.join(workdir, "led2", "ledger.jsonl");
    reserve();
    const designless = settle({ scenarios: [ranS1({ costs: costs({ designCostUsd: null, designUsage: null, designRuns: 1 }) })], comparisons: [comparedS1()] }).spend;
    expect(designless.note).toContain("incomplete measurement: 1 call(s)");
    expect(designless.costUsd).toBeCloseTo(0.1 + 3.75 + 0.3 + 1.8);

    ledger = path.join(workdir, "led3", "ledger.jsonl");
    reserve();
    const threw = settle({ scenarios: [ranS1()], comparisons: [comparedS1({ pairwise: null, harnessError: "Error: boom" })] }).spend;
    expect(threw.note).toContain("1 harness failure(s)");
    expect(threw.note).toContain("incomplete measurement: 1 call(s)");
  });

  it("notes when the charge exceeds what was reserved, and keeps the note within the ledger's limits", () => {
    reserve();
    const over = ranS1({ costs: costs({ directorCostUsd: 2, designCostUsd: 20 }) });
    expect(settle({ scenarios: [over], comparisons: [] }).spend.note).toContain("exceeds the reserved worst case $16.25");

    const big = planRun({ scenarios: [scenario("S1"), scenario("S10")], repeat: 20, compare: true, caps: capsDefault });
    const all = big.items.map((i) => ({ ...record(i.id, i.repetition), finished: false }));
    const note = settleRun({ ledger: path.join(workdir, "led4", "ledger.jsonl"), results: { scenarios: all, comparisons: [] }, plan: big, reservedUsd: big.worstCaseUsd, run: RUN, label: LABEL }).spend;
    expect(note.note.length).toBeLessThanOrEqual(500);
    expect(note.note).toContain("+34 more");
    expect(note.note).toContain("measured $0.00");
    expect(validEntry(note)).toBe(true);
  });

  it("names in the ledger note the calls measured above their limit and the calls beyond the plan", () => {
    reserve();
    const over = ranS1({ costs: costs({ directorCostUsd: 0.2, designCostUsd: 4.5 }) });
    const note = settle({ scenarios: [over], comparisons: [comparedS1()] }).spend.note;
    expect(note).toContain("1 call(s) measured above their per-call limit (S1#1): the overshoot allowance was too small");
    expect(note).toContain("measured cost");
    expect(note).not.toContain("beyond the plan");

    ledger = path.join(workdir, "led6", "ledger.jsonl");
    reserve();
    const twice = ranS1({ chats: [designed(), chatRecord(1000, {}, { events: [stageEvent("designing")] }, { retryRunId: "r-1" })] });
    const second = settle({ scenarios: [twice], comparisons: [comparedS1()] }).spend;
    expect(second.note).toContain("incomplete measurement: 1 call(s)");
    expect(second.note).toContain("1 call(s) beyond the plan");
    expect(validEntry(second)).toBe(true);
  });

  it("settles a run once, and a failing settlement leaves the reservation counting in full", () => {
    reserve();
    settle({ scenarios: [ranS1()], comparisons: [comparedS1()] });
    expect(() => settle({ scenarios: [], comparisons: [] })).toThrow(/already settled/);

    ledger = path.join(workdir, "led5", "ledger.jsonl");
    reserve();
    const broken = { ...ranS1(), chats: undefined as never };
    expect(() => settle({ scenarios: [broken], comparisons: [] })).toThrow();
    expect(readLedger(ledger)).toHaveLength(1);
    expect(ledgerTotals(readLedger(ledger))).toMatchObject({ outstandingUsd: 16.25, unsettled: [RUN.runId] });
  });
});

describe("acceptance baseline: ledger lock", () => {
  const lockOf = (file: string) => `${file}.lock`;

  it("holds an exclusive lock file for the step and always releases it", () => {
    const file = path.join(workdir, "lk", "ledger.jsonl");
    let held = false;
    expect(withLedgerLock(file, () => {
      held = existsSync(lockOf(file));
      return 7;
    })).toBe(7);
    expect(held).toBe(true);
    expect(existsSync(lockOf(file))).toBe(false);
    expect(() => withLedgerLock(file, () => { throw new Error("inside"); })).toThrow("inside");
    expect(existsSync(lockOf(file))).toBe(false);
  });

  it("refuses with a clear error while another process holds a fresh lock, and does not run the step or append", () => {
    const file = path.join(workdir, "lk2", "ledger.jsonl");
    ensurePrivateDir(path.dirname(file));
    writeFileSync(lockOf(file), "999 held", { flag: "wx", mode: 0o600 });
    let ran = false;
    expect(() => withLedgerLock(file, () => { ran = true; }, { waitMs: 150 })).toThrow(/locked by another evaluation process.*ledger\.jsonl\.lock/);
    expect(ran).toBe(false);
    const plan = planRun({ scenarios: [scenario("S1")], repeat: 1, compare: false, caps });
    expect(() => reserveRun({ ledger: file, plan, capUsd: 50, run: { runId: "r", commit: "c", ticket: "#221" }, note: "n", lock: { waitMs: 100 } })).toThrow(/locked/);
    expect(readLedger(file)).toEqual([]);
    // The other process's lock is left alone.
    expect(existsSync(lockOf(file))).toBe(true);
  });

  it("removes a lock older than the stale age, left by a process that died", () => {
    const file = path.join(workdir, "lk3", "ledger.jsonl");
    ensurePrivateDir(path.dirname(file));
    writeFileSync(lockOf(file), "999 dead", { flag: "wx", mode: 0o600 });
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockOf(file), old, old);
    let ran = false;
    withLedgerLock(file, () => { ran = true; }, { waitMs: 150 });
    expect(ran).toBe(true);
    expect(existsSync(lockOf(file))).toBe(false);
  });

  it("serialises the ledger command's append under the same lock", () => {
    const env = { EVAL_LEDGER: path.join(workdir, "lk4", "ledger.jsonl"), EVAL_M1_CAP_USD: "50" };
    ensurePrivateDir(path.dirname(env.EVAL_LEDGER));
    writeFileSync(lockOf(env.EVAL_LEDGER), "999 held", { flag: "wx", mode: 0o600 });
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockOf(env.EVAL_LEDGER), old, old);
    expect(ledgerCli(["add", "--usd", "1", "--note", "n", "--run", "m1", "--commit", "abc1234"], env)).toContain("Recorded $1.00");
    expect(existsSync(lockOf(env.EVAL_LEDGER))).toBe(false);
  });
});

describe("acceptance baseline: private folders and paths outside the checkout", () => {
  it("makes the folders it creates mode 700 and leaves the existing ones above them alone", async () => {
    const existing = path.join(workdir, "shared");
    mkdirSync(existing, { mode: 0o755 });
    chmodSync(existing, 0o755);
    ensurePrivateDir(path.join(existing, "a", "b"));
    expect([await mode(path.join(existing, "a")), await mode(path.join(existing, "a", "b")), await mode(existing)]).toEqual([0o700, 0o700, 0o755]);
  });

  it("refuses an existing folder that is not owner-only rather than changing it", async () => {
    for (const bits of [0o755, 0o750, 0o701]) {
      const dir = path.join(workdir, `existing-${bits.toString(8)}`);
      mkdirSync(dir, { mode: bits });
      chmodSync(dir, bits);
      expect(() => ensurePrivateDir(dir)).toThrow(/not private to this user/);
      expect(await mode(dir)).toBe(bits);
    }
    const private700 = path.join(workdir, "existing-700");
    mkdirSync(private700, { mode: 0o700 });
    expect(() => ensurePrivateDir(private700)).not.toThrow();
    const link = path.join(workdir, "link");
    symlinkSync(private700, link);
    expect(() => ensurePrivateDir(link)).toThrow(/symbolic link/);
    writeFileSync(path.join(workdir, "a-file"), "x");
    expect(() => ensurePrivateDir(path.join(workdir, "a-file"))).toThrow();
  });

  it("refuses a ledger folder or archive folder it did not create and cannot trust, and a ledger file group-readable", async () => {
    const shared = path.join(workdir, "shared-ledger");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    expect(() => appendLedger(path.join(shared, "ledger.jsonl"), entry({}))).toThrow(/not private/);
    expect(await mode(shared)).toBe(0o755);

    const run = path.join(workdir, "run");
    await mkdir(run);
    await writeFile(path.join(run, "results.json"), "{}");
    expect(() => archiveRun(run, shared)).toThrow(/not private/);
    expect(await mode(shared)).toBe(0o755);

    const file = path.join(workdir, "own", "ledger.jsonl");
    appendLedger(file, entry({}));
    chmodSync(file, 0o644);
    expect(() => appendLedger(file, entry({}))).toThrow(/not owner-only/);
    expect(await mode(file)).toBe(0o644);
  });

  it("refuses a ledger or archive path inside the checkout, through a symbolic link too", async () => {
    const root = path.join(workdir, "checkout");
    await mkdir(root);
    const home = path.join(workdir, "home");
    expect(() => ledgerPath({ EVAL_LEDGER: path.join(root, "x", "ledger.jsonl") }, home, root)).toThrow(/outside the repository checkout/);
    expect(() => ledgerPath({ EVAL_LEDGER: root }, home, root)).toThrow(/outside the repository checkout/);
    symlinkSync(root, path.join(workdir, "into-checkout"));
    expect(() => ledgerPath({ EVAL_LEDGER: path.join(workdir, "into-checkout", "ledger.jsonl") }, home, root)).toThrow(/outside the repository checkout/);
    expect(() => archiveDir("acceptance-1", { EVAL_ARCHIVE_DIR: path.join(root, "archive") }, home, root)).toThrow(/outside the repository checkout/);
    expect(() => archiveDir("acceptance-1", { EVAL_ARCHIVE_DIR: path.join(workdir, "into-checkout") }, home, root)).toThrow(/outside the repository checkout/);
    // Outside is fine, including a sibling whose name merely starts with the checkout's.
    expect(ledgerPath({ EVAL_LEDGER: path.join(workdir, "checkout-notes", "ledger.jsonl") }, home, root)).toContain("checkout-notes");
    expect(archiveDir("acceptance-1", { EVAL_ARCHIVE_DIR: path.join(workdir, "archive") }, home, root)).toBe(path.join(workdir, "archive", "acceptance-1"));
  });
});

const gitEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return env;
})();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", ...args], { cwd, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });

/** A temporary repository and one linked worktree of it. */
async function worktrees(base: string): Promise<{ primary: string; linked: string }> {
  const primary = path.join(base, "primary");
  const linked = path.join(base, "linked");
  await mkdir(primary);
  git(primary, "init", "-q", "-b", "main");
  git(primary, "commit", "-q", "--allow-empty", "--no-verify", "-m", "initial");
  git(primary, "worktree", "add", "-q", linked, "-b", "work");
  return { primary, linked };
}

describe("acceptance baseline: live data guard", () => {
  it("refuses the primary worktree and accepts a dedicated linked worktree", async () => {
    const { primary, linked } = await worktrees(workdir);
    expect(() => assertLinkedWorktree(primary)).toThrow(/primary worktree[\s\S]*linked worktree/);
    expect(() => assertLinkedWorktree(linked)).not.toThrow();
  });

  it("refuses a folder whose worktree cannot be determined", async () => {
    const plain = path.join(workdir, "plain");
    await mkdir(plain);
    expect(() => assertLinkedWorktree(plain)).toThrow(/could not be determined/);
  });

  it("accepts a linked worktree whose data/ and public/uploads are its own folders, or absent", async () => {
    const { linked } = await worktrees(workdir);
    expect(() => assertLinkedWorktree(linked)).not.toThrow(); // neither exists yet: the server makes them
    await mkdir(path.join(linked, "data"));
    await mkdir(path.join(linked, "public", "uploads"), { recursive: true });
    expect(() => assertLinkedWorktree(linked)).not.toThrow();
  });

  it("refuses a linked worktree whose data/ or public/uploads resolves outside it", async () => {
    const { primary, linked } = await worktrees(workdir);
    const live = path.join(primary, "data");
    await mkdir(live);

    // data/ as a link to the primary worktree's live folder.
    symlinkSync(live, path.join(linked, "data"));
    expect(() => assertLinkedWorktree(linked)).toThrow(/data\/ in this checkout resolves outside it/);
    await rm(path.join(linked, "data"));
    // A link whose target is missing would have the server make the target.
    symlinkSync(path.join(workdir, "not-there"), path.join(linked, "data"));
    expect(() => assertLinkedWorktree(linked)).toThrow(/data\/ in this checkout resolves outside it/);
    await rm(path.join(linked, "data"));

    // public/uploads as a link, and public itself as a link with uploads absent.
    await mkdir(path.join(linked, "public"));
    symlinkSync(live, path.join(linked, "public", "uploads"));
    expect(() => assertLinkedWorktree(linked)).toThrow(/public\/uploads\/ in this checkout resolves outside it/);
    await rm(path.join(linked, "public"), { recursive: true });
    symlinkSync(primary, path.join(linked, "public"));
    expect(() => assertLinkedWorktree(linked)).toThrow(/public\/uploads\/ in this checkout resolves outside it/);
    await rm(path.join(linked, "public"));

    // A link that stays inside the worktree is fine, and the message names no absolute path.
    await mkdir(path.join(linked, "store"));
    symlinkSync(path.join(linked, "store"), path.join(linked, "data"));
    expect(() => assertLinkedWorktree(linked)).not.toThrow();
    await rm(path.join(linked, "data"));
    symlinkSync(live, path.join(linked, "data"));
    expect(() => assertLinkedWorktree(linked)).toThrow(/^(?![\s\S]*\/(tmp|var|private|Users|home)\/)/);
  });

  it("names the repository's main worktree as well as the working directory for auto-memory", async () => {
    const { primary, linked } = await worktrees(workdir);
    const real = (p: string) => realpathSync(p);
    expect(memoryRoots(linked)).toEqual([
      { label: "working directory", path: linked },
      { label: "main worktree", path: real(primary) },
    ]);
    expect(memoryRoots(primary)).toEqual([{ label: "working directory", path: primary }]);
    expect(memoryRoots(path.join(workdir, "not-a-repo"))).toEqual([{ label: "working directory", path: path.join(workdir, "not-a-repo") }]);
  });
});

describe("acceptance baseline: inherited configuration fingerprint", () => {
  const SECRET = "synthetic-secret-value-do-not-record";
  let home: string;
  let project: string;

  beforeEach(async () => {
    home = path.join(workdir, "home");
    project = path.join(home, "work", "checkout");
    const put = async (rel: string, text: string) => {
      await mkdir(path.dirname(path.join(home, rel)), { recursive: true });
      await writeFile(path.join(home, rel), text);
    };
    await put(".claude/skills/alpha/SKILL.md", `alpha ${SECRET}`);
    await put(".claude/skills/beta/node_modules/dep/index.js", "skipped");
    await put(".claude/skills/beta/.git/config", "skipped");
    await put(".claude/skills/.DS_Store", "skipped");
    await put(".claude/skills/beta/SKILL.md", "beta");
    await put(".claude/agents/reviewer.md", "agent");
    await put(".claude/commands/ship.md", "command");
    await put(".claude/plugins/p/plugin.json", `{"name":"p"}`);
    await put(".claude/hooks/pre.sh", "hook");
    await put(".claude/output-styles/terse.md", "style");
    // Auto-memory for the project, and a session transcript beside it that must never be read.
    const projectFolder = project.replace(/[^a-zA-Z0-9]/g, "-");
    await put(`.claude/projects/${projectFolder}/memory/MEMORY.md`, `remembered ${SECRET}`);
    await put(`.claude/projects/${projectFolder}/memory/notes/topic.md`, "topic");
    await put(`.claude/projects/${projectFolder}/0123.jsonl`, `transcript ${SECRET}`);
    await put("work/checkout/.claude/skills/local/SKILL.md", "local skill");
    await put("work/checkout/.claude/commands/run.md", "run");
    await put("work/checkout/.env.local", `ANTHROPIC_MODEL=${SECRET}\nOTHER=${SECRET}\nCLAUDE_CLI_PATH=/opt/claude\n`);
    await put(
      ".claude.json",
      JSON.stringify({
        mcpServers: { github: { command: "synthetic-mcp-launcher", args: ["--token", SECRET], env: { TOKEN: SECRET }, url: `https://example.invalid/${SECRET}` } },
        projects: { [project]: { mcpServers: { local: { command: SECRET } } }, "/somewhere/else": { mcpServers: { other: {} } } },
      })
    );
  });

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("fingerprints a tree by relative name, size and hash with one combined hash, skipping what the CLI cannot be affected by", () => {
    const tree = treeFingerprint(path.join(home, ".claude", "skills"), "~/.claude/skills");
    expect(tree.exists).toBe(true);
    expect(tree.files).toEqual([
      { path: "alpha/SKILL.md", size: `alpha ${SECRET}`.length, sha256: sha(`alpha ${SECRET}`) },
      { path: "beta/SKILL.md", size: 4, sha256: sha("beta") },
    ]);
    expect(tree).toMatchObject({ count: 2, truncated: false, bytes: `alpha ${SECRET}`.length + 4 });
    const combined = createHash("sha256");
    for (const f of tree.files) combined.update(`${f.path}\0${f.size}\0${f.sha256}\n`);
    expect(tree.sha256).toBe(combined.digest("hex"));
    expect(JSON.stringify(tree)).not.toContain(SECRET);
    expect(JSON.stringify(tree)).not.toContain(workdir);
    // A change to one file changes the combined hash; the same tree gives the same one.
    expect(treeFingerprint(path.join(home, ".claude", "skills"), "x").sha256).toBe(tree.sha256);
    writeFileSync(path.join(home, ".claude", "skills", "beta", "SKILL.md"), "BETA");
    expect(treeFingerprint(path.join(home, ".claude", "skills"), "x").sha256).not.toBe(tree.sha256);
    expect(treeFingerprint(path.join(home, "nothing"), "gone")).toMatchObject({ exists: false, files: [], sha256: null });
  });

  it("follows symbolic links without looping, leaves an oversized file unhashed and marks a truncated walk", () => {
    const skills = path.join(home, ".claude", "skills");
    symlinkSync(path.join(home, ".claude", "agents"), path.join(skills, "linked"));
    symlinkSync(skills, path.join(skills, "loop"));
    symlinkSync(path.join(workdir, "missing-target"), path.join(skills, "broken"));
    const tree = treeFingerprint(skills, "s");
    const names = tree.files.map((f) => f.path);
    expect(names).toContain("linked/reviewer.md");
    expect(names).toContain("broken");
    expect(tree.files.find((f) => f.path === "broken")).toEqual({ path: "broken", size: 0, sha256: null });
    expect(names.filter((n) => n.startsWith("loop/"))).toEqual([]);
    const small = treeFingerprint(skills, "s", { files: 20_000, fileBytes: 5, depth: 16 });
    expect(small.files.find((f) => f.path === "beta/SKILL.md")?.sha256).toBe(sha("beta"));
    expect(small.files.find((f) => f.path === "alpha/SKILL.md")).toMatchObject({ size: `alpha ${SECRET}`.length, sha256: null });
    expect(treeFingerprint(skills, "s", { files: 2, fileBytes: 1e6, depth: 16 })).toMatchObject({ count: 2, truncated: true });
  });

  it("records MCP server names only, from the user scope and this project's entry", () => {
    const servers = mcpServerNames({ home, project });
    expect(servers).toEqual({ source: "~/.claude.json", found: true, user: ["github"], project: ["local"], error: null });
    expect(JSON.stringify(servers)).not.toContain(SECRET);
    expect(mcpServerNames({ home, project: "/somewhere/else" }).project).toEqual(["other"]);
    expect(mcpServerNames({ home, project: path.join(home, "no-entry") }).project).toBeNull();
    expect(mcpServerNames({ home: path.join(workdir, "no-home"), project })).toMatchObject({ found: false, user: [], project: null });
    writeFileSync(path.join(home, ".claude.json"), `{"mcpServers": ${SECRET}`);
    expect(mcpServerNames({ home, project })).toEqual({ source: "~/.claude.json", found: true, user: [], project: null, error: "not readable as JSON" });
    const custom = path.join(workdir, "custom-config");
    mkdirSync(custom);
    writeFileSync(path.join(custom, ".claude.json"), JSON.stringify({ mcpServers: { figma: {} } }));
    expect(mcpServerNames({ home, project, configDir: custom })).toMatchObject({ source: "$CLAUDE_CONFIG_DIR/.claude.json", user: ["figma"] });
  });

  it("records model, effort and thinking variables by name and value hash only", () => {
    const vars = modelEnvironment({
      ANTHROPIC_MODEL: "model-a",
      ANTHROPIC_SMALL_FAST_MODEL: "model-b",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
      MAX_THINKING_TOKENS: "4000",
      CLAUDE_EFFORT: "high",
      CLAUDE_CODE_SUBAGENT_MODEL: "model-c",
      ANTHROPIC_API_KEY: SECRET,
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: SECRET,
    });
    expect(vars.map((v) => v.name)).toEqual(["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_EFFORT", "MAX_THINKING_TOKENS"]);
    expect(vars[0]).toEqual({ name: "ANTHROPIC_MODEL", sha256: sha("model-a") });
    expect(JSON.stringify(vars)).not.toContain("model-a");
    expect(JSON.stringify(vars)).not.toContain(SECRET);
  });

  it("finds the auto-memory of the working directory and of the main worktree by the CLI's naming, and records an absent one", async () => {
    const userDir = path.join(home, ".claude");
    const put = async (folder: string, name: string) => {
      await mkdir(path.join(userDir, "projects", folder, "memory"), { recursive: true });
      await writeFile(path.join(userDir, "projects", folder, "memory", name), "memory");
    };
    await put("-synthetic-main-worktree", "MEMORY.md");
    await put("-synthetic-with space", "OLD.md"); // the older form of the name only replaced separators and dots
    const roots = [
      { label: "working directory", path: "/synthetic/work" },
      { label: "main worktree", path: "/synthetic/main.worktree" },
    ];
    const trees = memoryTrees({ userDir, userLabel: "~/.claude", roots });
    expect(trees.map((t) => [t.label, t.exists, t.files.map((f) => f.path)])).toEqual([
      ["~/.claude/projects/<working directory>/memory", false, []],
      ["~/.claude/projects/<main worktree>/memory", true, ["MEMORY.md"]],
    ]);
    expect(JSON.stringify(trees)).not.toContain("synthetic");
    // The same folder reached by two roots is listed once.
    expect(memoryTrees({ userDir, userLabel: "~/.claude", roots: [roots[1], { label: "working directory", path: "/synthetic/main.worktree" }] })).toHaveLength(1);
    expect(memoryTrees({ userDir, userLabel: "~/.claude", roots: [{ label: "working directory", path: "/synthetic/with space" }] })[0].files.map((f) => f.path)).toEqual(["OLD.md"]);
    // A change to the memory changes the combined fingerprint.
    const options = { home, project, platform: "win32" as const, serverEnv: {}, harnessEnv: {}, envFileVariables: [] };
    const before = inheritedConfiguration(options).sha256;
    const folder = project.replace(/[^a-zA-Z0-9]/g, "-");
    writeFileSync(path.join(userDir, "projects", folder, "memory", "MEMORY.md"), "changed memory");
    expect(inheritedConfiguration(options).sha256).not.toBe(before);
  });

  it("combines files, trees, MCP names and the environment into one count and hash, and states what the harness strips", () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_MODEL = "model-a";
    process.env.CLAUDE_EFFORT = "high";
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "tokens-9000";
    try {
      // What the checkout's .env.local adds, as Next.js's loader leaves it for a server given the clean environment.
      const options = {
        home,
        project,
        platform: "win32" as const,
        serverEnv: cleanEnv(),
        harnessEnv: process.env,
        // For a server whose environment does not define the variable itself: Next.js leaves the environment's value over a file's.
        envFileVariables: loadedFileVariables(loadServerEnv({ root: project, mode: "prod", env: { PATH: process.env.PATH } }), (name) => MODEL_ENV_NAME.test(name)),
      };
      const config = inheritedConfiguration(options);
      expect(config.trees.map((t) => t.label)).toEqual([
        "~/.claude/skills",
        "~/.claude/agents",
        "~/.claude/commands",
        "~/.claude/plugins",
        "~/.claude/hooks",
        "~/.claude/output-styles",
        "<project>/.claude/skills",
        "<project>/.claude/agents",
        "<project>/.claude/commands",
        "~/.claude/projects/<working directory>/memory",
      ]);
      expect(config.trees.find((t) => t.label === "<project>/.claude/agents")?.exists).toBe(false);
      expect(config.trees.find((t) => t.label === "~/.claude/plugins")?.files.map((f) => f.path)).toEqual(["p/plugin.json"]);
      expect(config.trees.find((t) => t.label === "~/.claude/hooks")?.files).toEqual([{ path: "pre.sh", size: 4, sha256: sha("hook") }]);
      expect(config.trees.find((t) => t.label === "~/.claude/output-styles")?.files.map((f) => f.path)).toEqual(["terse.md"]);
      // The memory folder is read by file name, size and hash; the transcript beside it is not read at all.
      const memory = config.trees.find((t) => t.label === "~/.claude/projects/<working directory>/memory");
      expect(memory?.files).toEqual([
        { path: "MEMORY.md", size: `remembered ${SECRET}`.length, sha256: sha(`remembered ${SECRET}`) },
        { path: "notes/topic.md", size: 5, sha256: sha("topic") },
      ]);
      expect(config.limitations.join(" ")).toMatch(/does not disable auto-memory \(the Director does, with autoMemoryEnabled false\)/);
      expect(config.limitations.join(" ")).toMatch(/located by the CLI's project-folder naming convention/);
      expect(config.mcpServers).toMatchObject({ user: ["github"], project: ["local"] });
      // The servers receive ANTHROPIC_MODEL; the harness removes the Claude Code and effort variables that /start passes through.
      expect(config.environment.received.map((v) => v.name)).toContain("ANTHROPIC_MODEL");
      expect(config.environment.received.map((v) => v.name)).not.toContain("CLAUDE_EFFORT");
      expect(config.environment.strippedByHarness.map((v) => v.name)).toEqual(expect.arrayContaining(["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_EFFORT"]));
      expect(config.environment.strippedByHarness.map((v) => v.name)).not.toContain("ANTHROPIC_MODEL");
      expect(config.environment.envFiles).toEqual([{ file: "<project>/.env.local", name: "ANTHROPIC_MODEL", sha256: sha(SECRET) }]);
      expect(config.limitations.join(" ")).toMatch(/strips CLAUDE_CODE_\*, CLAUDE_EFFORT.*\/start passes them through.*differ from the app's normal launch/);
      expect(config.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(config.count).toBeGreaterThan(8);

      const json = JSON.stringify(config);
      for (const forbidden of [SECRET, "model-a", "tokens-9000", workdir, "synthetic-mcp-launcher", "example.invalid"]) expect(json).not.toContain(forbidden);

      // Anything that would change what the CLI loads changes the hash; nothing else does.
      expect(inheritedConfiguration(options).sha256).toBe(config.sha256);
      writeFileSync(path.join(home, ".claude", "agents", "reviewer.md"), "changed agent");
      expect(inheritedConfiguration(options).sha256).not.toBe(config.sha256);
      process.env.ANTHROPIC_MODEL = "model-b";
      const afterEnv = inheritedConfiguration({ ...options, serverEnv: cleanEnv() });
      expect(afterEnv.environment.received.find((v) => v.name === "ANTHROPIC_MODEL")?.sha256).toBe(sha("model-b"));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("acceptance baseline: summary safety", () => {
  const redaction = { home: "/home/synthetic", root: "/home/synthetic/work/checkout" };
  const stack = "Error: boom\n    at run (/home/synthetic/work/checkout/eval/acceptance/app.ts:1:1)\n    at load (/home/synthetic/.nvm/versions/x.js:2:2)";

  function leaky(): RunResults {
    const plan = planRun({ scenarios: [scenario("S1")], repeat: 1, compare: true, caps });
    return summaryResults({
      spend: { ledger: "~/ledger.jsonl", preflight: preflight(plan, [], 50), reservation: null, spend: null, settlement: null, error: "settling the ledger: EACCES /home/synthetic/.local/share/creatorbrio-m1-eval/ledger.jsonl" },
      archive: { dir: "~/archive", files: 0, error: "EACCES: permission denied, mkdir '/home/synthetic/.local/share/creatorbrio-m1-eval/acceptance'" },
      scenarios: [{ ...record("S1", 1), harnessError: stack }],
      comparisons: [{ ...comparison("S1", 1, 1), harnessError: "ENOENT /home/synthetic/work/checkout/data/carousels.json" }],
    });
  }

  it("redacts the home folder and the checkout from errors in summary.md", () => {
    const md = renderSummary(leaky(), redaction);
    expect(md).not.toContain("/home/synthetic");
    expect(md).toContain("<checkout>/eval/acceptance/app.ts:1:1");
    expect(md).toContain("~/.nvm/versions/x.js:2:2");
    expect(md).toContain("~/.local/share/creatorbrio-m1-eval/ledger.jsonl");
    expect(md).toContain("<checkout>/data/carousels.json");
    expect(md).not.toMatch(/[\u2013\u2014]/);
  });

  it("redacts them in results.json too, which stays valid JSON", () => {
    const json = serializeResults(leaky(), redaction);
    expect(json).not.toContain("/home/synthetic");
    const parsed = JSON.parse(json) as RunResults;
    expect(parsed.scenarios[0].harnessError).toContain("<checkout>/eval/acceptance/app.ts:1:1");
    expect(parsed.spend?.error).toContain("~/.local/share/creatorbrio-m1-eval/ledger.jsonl");
    expect(parsed.archive?.error).toContain("'~/.local/share/creatorbrio-m1-eval/acceptance'");
  });

  it("replaces whole folders only, the checkout before the home folder", () => {
    expect(redactText("/home/synthetic2/x and /home/synthetic.", redaction)).toBe("/home/synthetic2/x and ~.");
    // A sibling folder that merely starts with the checkout's name is not the checkout, though it is under the home folder.
    expect(redactText("in /home/synthetic/work/checkout, not /home/synthetic/work/checkout-old", redaction)).toBe("in <checkout>, not ~/work/checkout-old");
    expect(redactText("nothing here", redaction)).toBe("nothing here");
  });
});

// ---------------------------------------------------------------------------
// Synthetic records.

/**
 * Synthetic server costs. The per-call cost lists follow the sums unless given:
 * one call per sum, and none when the sum is null, as for a run whose log line carried no cost.
 */
function costs(overrides: Partial<NonNullable<ScenarioRecord["costs"]>>): NonNullable<ScenarioRecord["costs"]> {
  const merged = {
    directorCostUsd: 0.1 as number | null,
    directorMs: 1000,
    directorTurns: 2,
    directorRuns: 1,
    directorPlan: null,
    designCostUsd: 1 as number | null,
    designMs: 2000,
    designUsage: null,
    designTurns: 5,
    designRunsWithoutUsage: 0,
    designRuns: 1,
    imagesStaged: 0,
    imageMs: [],
    imageFailures: [],
    retries: [],
    ...overrides,
  };
  return {
    ...merged,
    directorCallCosts: overrides.directorCallCosts ?? (merged.directorCostUsd === null ? [] : [merged.directorCostUsd]),
    designCallCosts: overrides.designCallCosts ?? (merged.designCostUsd === null ? [] : [merged.designCostUsd]),
  };
}

function record(id: ScenarioId, repetition: number): ScenarioRecord {
  return {
    id,
    repetition,
    key: `${id}#${repetition}`,
    title: "synthetic",
    kind: "integration",
    server: { port: 0, mode: "prod", readyMs: 0 },
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
    finished: true,
  };
}

function comparison(id: "S1", repetition: number, costUsd: number): ComparisonRecord {
  return {
    id,
    repetition,
    key: `${id}#${repetition}`,
    baselineCarouselId: null,
    baseline: { ok: true, durationMs: 1000, costUsd, usage: null, turns: 3, models: [], subtype: "success", resultText: null, sessionId: null, error: null },
    baselineExport: null,
    baselineJudge: null,
    pairwise: null,
    skipped: null,
    notJudged: null,
    harnessError: null,
    finished: true,
  };
}

function scores(n: number): OutcomeScores {
  return Object.fromEntries(OUTCOME_DIMENSIONS.map((d) => [d, { score: n, evidence: "" }])) as OutcomeScores;
}

function judgeCall(s: OutcomeScores, turns: number | null = 4, costUsd: number | null = 0.1): JudgeCall<OutcomeVerdict> {
  return { ok: true, verdict: { scores: s, flags: {} as never, summary: "" }, costUsd, durationMs: 1, turns };
}

const failedJudge = (error: string, costUsd: number | null = null): JudgeCall<OutcomeVerdict> => ({ ok: false, error, costUsd, durationMs: 1, turns: null });

const stageEvent = (stage: string, at = 0) => ({ at, event: { type: "stage" as const, stage: stage as never } });

function chatResult(overrides: Partial<ChatResult> = {}): ChatResult {
  return { events: [], tokens: { count: 0, firstAt: null, lastAt: null }, sessionId: null, durationMs: 1000, aborted: false, streamError: null, httpStatus: 200, httpError: null, ...overrides };
}

function chatRecord(durationMs: number, stages: ChatRecord["stages"] = {}, result: Partial<ChatResult> = {}, extra: Partial<ChatRecord> = {}): ChatRecord {
  return { label: "request", message: "synthetic", sessionId: null, result: chatResult({ durationMs, ...result }), stages, planAtDesign: null, ...extra };
}

/** A chat in which the Director planned and the Design Agent designed. */
const designed = (extra: Partial<ChatRecord> = {}) => chatRecord(1000, {}, { events: [stageEvent("planning"), stageEvent("designing")] }, extra);

/** S1's Director arm, measured in full: Director 0.2, design 1.5, judge 0.3. */
function ranS1(overrides: Partial<ScenarioRecord> = {}): ScenarioRecord {
  return { ...record("S1", 1), outcome: "completed", chats: [designed()], costs: costs({ directorCostUsd: 0.2, designCostUsd: 1.5 }), judge: judgeCall(scores(4), 4, 0.3), ...overrides };
}

/** S1's Design-Agent-only arm, measured in full: baseline 1.2, its judge 0.25, the pairwise judge 0.35. */
function comparedS1(overrides: Partial<ComparisonRecord> = {}): ComparisonRecord {
  return {
    ...comparison("S1", 1, 1.2),
    baselineCarouselId: "c-baseline",
    baselineExport: { ok: true, pngs: 3 },
    baselineJudge: judgeCall(scores(3), 4, 0.25),
    pairwise: {
      mapping: { A: "director", B: "baseline" },
      winner: "tie",
      result: { ok: true, verdict: { preference: "tie", confidence: "low", reasons: ["synthetic"], setA: scores(3), setB: scores(3) }, costUsd: 0.35, durationMs: 1, turns: 4 },
    },
    ...overrides,
  };
}

function syntheticConfiguration(): InheritedConfiguration {
  return {
    files: [{ label: "~/.claude/settings.json", exists: true, size: 2, sha256: "f".repeat(64) }],
    trees: [{ label: "~/.claude/skills", exists: true, files: [{ path: "a/SKILL.md", size: 1, sha256: "a".repeat(64) }], count: 1, bytes: 1, sha256: "b".repeat(64), truncated: false }],
    mcpServers: { source: "~/.claude.json", found: true, user: [], project: null, error: null },
    environment: { received: [], strippedByHarness: [], envFiles: [] },
    limitations: ["The harness strips CLAUDE_CODE_* and CLAUDE_EFFORT, which /start passes through."],
    count: 2,
    sha256: "c".repeat(64),
  };
}

/** A settings record in which no file is present and the list was read for the pinned CLI. */
function cleanSettingsKeys(): SettingsKeysRecord {
  const absent = (label: string) => ({ label, exists: false, state: "absent" as const, sha256: null, keys: [], envKeys: [], unrecordedNames: 0 });
  return { listedForCli: SETTINGS_LISTED_FOR_CLI, listedForPinnedCli: true, files: ["user", "project", "project-local", "managed"].map(absent) };
}

/** An environment record in which everything held: the pin and its re-checks, the files, every session and both proofs. */
function cleanEnvironment(): EnvironmentRecord {
  const proof = (who: string) => ({ method: `not read from a transcript: synthetic ${who}`, version: "1.0.0", proven: true });
  return {
    commit: "abc1234",
    commitDirty: false,
    node: "v0",
    platform: "test",
    cli: {
      server: { path: "~/bin/claude", version: "1.0.0 (Claude Code)", source: "CLAUDE_CLI_PATH from the harness's environment" },
      harness: { path: "~/bin/claude", version: "1.0.0 (Claude Code)" },
      pin: {
        ok: true,
        explicit: true,
        source: "CLAUDE_CLI_PATH from the harness's environment",
        uses: [],
        file: { size: 1234, sha256: "f".repeat(64) },
        message: "CLI pinned: every model call uses ~/bin/claude (1.0.0 (Claude Code)).",
        rechecks: [
          { at: "server start on port 3417", ok: true, changes: [] },
          { at: END_OF_RUN, ok: true, changes: [] },
        ],
        changed: false,
      },
      sessions: {
        configured: "1.0.0",
        sessions: [{ sessionId: "s-1", role: "design-agent", versions: ["1.0.0"], status: "matches", error: null }],
        withoutSession: 0,
        mismatch: false,
        unverified: false,
        director: proof("director"),
        judge: proof("judge"),
      },
    },
    serverEnvFiles: { files: [], added: [], refused: [], unaccounted: [], loaderError: null, allowlist: [], ok: true, message: "all allowed: none", rechecks: [], changed: false },
    harnessEnvironment: { unreviewedNames: [] },
    modelPricing: modelPricing([]),
    settingsKeys: cleanSettingsKeys(),
    homeDiffersFromAccount: false,
    limits: {
      designAgent: { timeoutMs: 1_800_000, timeoutSource: "the product's default", inactivityMs: 300_000, inactivitySource: "the product's default" },
      designAgentOnly: { timeoutMs: 1_800_000, timeoutSource: "the product's default", inactivityMs: 300_000, inactivitySource: "the product's default" },
      chatIdleMs: 2_100_000,
      itemTimeoutsMs: { "S1#1": 7_880_000 },
    },
    models: { designAgent: { models: [], source: "none" }, director: { models: [], source: "not recorded" }, designAgentOnly: [], judge: [] },
    inheritedConfiguration: syntheticConfiguration(),
    harnessFiles: [],
  };
}

function summaryResults(overrides: Partial<RunResults> = {}): RunResults {
  const plan = planRun({ scenarios: [scenario("S1")], repeat: 1, compare: false, caps });
  return {
    runId: "acceptance-synthetic",
    startedAt: "2026-01-01T00:00:00.000Z",
    mode: "prod",
    commit: "abc1234",
    plan,
    spend: { ledger: "~/ledger.jsonl", preflight: preflight(plan, [], 50), reservation: null, spend: null, settlement: null, error: null },
    brand: null,
    environment: null,
    archive: null,
    scenarios: [],
    comparisons: [],
    wallMs: 0,
    ...overrides,
  };
}

describe("acceptance baseline: the key names of the CLI's settings files (#232)", () => {
  const VALUE = "synthetic-secret-value";
  let home: string;
  let project: string;
  let managed: string;

  beforeEach(async () => {
    home = path.join(workdir, "home");
    project = path.join(workdir, "checkout");
    managed = path.join(workdir, "managed");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(project, ".claude"), { recursive: true });
    await mkdir(managed, { recursive: true });
  });

  const options = (extra: Record<string, unknown> = {}) => ({ home, project, platform: "linux" as const, managedDir: managed, username: "synthetic-user", ...extra });
  const record = (extra: Record<string, unknown> = {}) => recordSettingsKeys({ ...options(extra), cliVersion: SETTINGS_LISTED_FOR_CLI });
  const file = (r: SettingsKeysRecord, label: string) => r.files.find((f) => f.label === label)!;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("records the top-level key names and the names under env, never a value, and hashes the bytes the keys came from", async () => {
    const user = JSON.stringify({
      model: VALUE,
      effortLevel: VALUE,
      alwaysThinkingEnabled: true,
      apiKeyHelper: VALUE,
      permissions: { allow: [VALUE] },
      env: { ANTHROPIC_BASE_URL: VALUE, MAX_THINKING_TOKENS: VALUE, ANTHROPIC_BETAS: VALUE },
    });
    await writeFile(path.join(home, ".claude", "settings.json"), user);
    await writeFile(path.join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [VALUE] } }));
    await writeFile(path.join(project, ".claude", "settings.local.json"), JSON.stringify({ statusLine: VALUE }));
    await writeFile(path.join(managed, "managed-settings.json"), JSON.stringify({ modelPricing: { [VALUE]: { multiplier: 2 } } }));
    const r = record();
    expect(r.files.map((f) => f.label)).toEqual(["user", "project", "project-local", "managed"]);
    expect(file(r, "user")).toEqual({
      label: "user",
      exists: true,
      state: "ok",
      sha256: sha(user),
      keys: ["alwaysThinkingEnabled", "apiKeyHelper", "effortLevel", "env", "model", "permissions"],
      envKeys: ["ANTHROPIC_BASE_URL", "ANTHROPIC_BETAS", "MAX_THINKING_TOKENS"],
      unrecordedNames: 0,
    });
    expect(file(r, "project")).toMatchObject({ state: "ok", keys: ["hooks"], envKeys: [] });
    expect(file(r, "project-local")).toMatchObject({ state: "ok", keys: ["statusLine"] });
    expect(file(r, "managed")).toMatchObject({ state: "ok", keys: ["modelPricing"] });
    // No value anywhere in the record, and no path: labels only.
    expect(JSON.stringify(r)).not.toContain(VALUE);
    for (const f of r.files) {
      expect(f.label.startsWith("/"), f.label).toBe(false);
      expect(f.label).not.toContain(workdir);
    }
    expect(r).toMatchObject({ listedForCli: SETTINGS_LISTED_FOR_CLI, listedForPinnedCli: true });
  });

  it("records an absent file as absent, and an unparseable, non-object, folder or oversized one without its content", async () => {
    // Nothing is there: every file is absent.
    for (const f of record().files) expect(f, f.label).toEqual({ label: f.label, exists: false, state: "absent", sha256: null, keys: [], envKeys: [], unrecordedNames: 0 });
    const broken = `{ "model": "${VALUE}", `;
    await writeFile(path.join(project, ".claude", "settings.json"), broken);
    await writeFile(path.join(project, ".claude", "settings.local.json"), JSON.stringify([VALUE]));
    await mkdir(path.join(managed, "managed-settings.json")); // a folder where the file should be
    await writeFile(path.join(home, ".claude", "settings.json"), "\uFEFF" + JSON.stringify({ model: VALUE })); // a byte-order mark is skipped
    const r = record();
    expect(file(r, "project")).toEqual({ label: "project", exists: true, state: "unparseable", sha256: sha(broken), keys: [], envKeys: [], unrecordedNames: 0 });
    expect(file(r, "project-local")).toMatchObject({ exists: true, state: "unparseable", sha256: sha(JSON.stringify([VALUE])), keys: [] });
    expect(file(r, "managed")).toEqual({ label: "managed", exists: true, state: "unreadable", sha256: null, keys: [], envKeys: [], unrecordedNames: 0 });
    expect(file(r, "user")).toMatchObject({ state: "ok", keys: ["model"] });
    expect(JSON.stringify(r)).not.toContain(VALUE);
    // Over 4 MB is not read.
    await writeFile(path.join(project, ".claude", "settings.json"), Buffer.alloc(4 * 1024 * 1024 + 1, 32));
    expect(file(record(), "project")).toMatchObject({ exists: true, state: "unreadable", sha256: null });
  });

  it("leaves out, and only counts, a name that is not a plain name", async () => {
    await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "x", [`has space ${VALUE}`]: 1, env: { GOOD_NAME: "1", [`bad name ${VALUE}`]: "2" } }));
    const user = file(record(), "user");
    expect(user).toMatchObject({ keys: ["env", "model"], envKeys: ["GOOD_NAME"], unrecordedNames: 2 });
    expect(JSON.stringify(user)).not.toContain(VALUE);
  });

  it("lists the files the pinned CLI reads by platform, in a linked worktree, with a drop-in folder and a configuration folder", async () => {
    expect(managedSettingsDir("darwin")).toBe("/Library/Application Support/ClaudeCode");
    expect(managedSettingsDir("linux")).toBe("/etc/claude-code");
    expect(managedSettingsDir("win32")).toBe("C:\\Program Files\\ClaudeCode");
    const labels = (extra: Record<string, unknown> = {}) => settingsSources(options(extra)).map((s) => s.label);
    // Linux: the user, project, project-local and managed files, and no settings.local.json in the user folder.
    expect(labels()).toEqual(["user", "project", "project-local", "managed"]);
    expect(settingsSources(options()).map((s) => path.relative(home, s.file)).slice(0, 1)).toEqual([path.join(".claude", "settings.json")]);
    expect(settingsSources(options()).some((s) => s.file === path.join(home, ".claude", "settings.local.json"))).toBe(false);
    // macOS adds the managed preferences property lists, which are never parsed; without a user name only the device one.
    const darwin = settingsSources(options({ platform: "darwin" }));
    expect(darwin.map((s) => [s.label, s.parsed])).toEqual([
      ["user", true],
      ["project", true],
      ["project-local", true],
      ["managed", true],
      ["managed-mdm-user", false],
      ["managed-mdm-device", false],
    ]);
    expect(darwin.find((s) => s.label === "managed-mdm-user")!.file).toBe("/Library/Managed Preferences/synthetic-user/com.anthropic.claudecode.plist");
    expect(darwin.find((s) => s.label === "managed-mdm-device")!.file).toBe("/Library/Managed Preferences/com.anthropic.claudecode.plist");
    expect(settingsSources(options({ platform: "darwin", username: null })).map((s) => s.label)).toEqual(["user", "project", "project-local", "managed", "managed-mdm-device"]);
    // The managed folder's drop-in files, sorted, without hidden or non-JSON files; an unusual name gets an index, never its text.
    await mkdir(path.join(managed, "managed-settings.d"));
    for (const name of ["20-b.json", "10-a.json", ".hidden.json", "notes.txt", "odd name!.json"]) await writeFile(path.join(managed, "managed-settings.d", name), "{}");
    expect(labels()).toEqual(["user", "project", "project-local", "managed", "managed-drop-in/10-a.json", "managed-drop-in/20-b.json", "managed-drop-in/(unusual name 3)"]);
    expect(labels().join()).not.toContain("odd name");
    // A linked worktree also takes local settings from the main worktree; the same folder is not listed twice.
    const main = path.join(workdir, "main-worktree");
    await mkdir(path.join(main, ".claude"), { recursive: true });
    await writeFile(path.join(main, ".claude", "settings.local.json"), JSON.stringify({ effortLevel: "high" }));
    expect(labels({ mainWorktree: main })).toContain("project-local-main");
    expect(file(record({ mainWorktree: main }), "project-local-main")).toMatchObject({ state: "ok", keys: ["effortLevel"] });
    expect(labels({ mainWorktree: project })).not.toContain("project-local-main");
    expect(labels({ mainWorktree: null })).not.toContain("project-local-main");
    // CLAUDE_CONFIG_DIR replaces ~/.claude, and a relative one is taken from the checkout.
    const config = path.join(workdir, "config");
    await mkdir(config);
    await writeFile(path.join(config, "settings.json"), JSON.stringify({ model: "x" }));
    expect(file(record({ configDir: config }), "user")).toMatchObject({ state: "ok", keys: ["model"] });
    expect(settingsSources(options({ configDir: "../config" }))[0].file).toBe(path.join(config, "settings.json"));
    // No managed folder at all.
    expect(labels({ managedDir: null })).toEqual(["user", "project", "project-local"]);
  });

  it("records a property list by existence and hash, never its keys", async () => {
    const plist = path.join(workdir, "managed.plist");
    await writeFile(plist, `<plist><dict><key>${VALUE}</key></dict></plist>`);
    const r = readSettingsFile({ label: "managed-mdm-device", file: plist, parsed: false });
    expect(r).toEqual({ label: "managed-mdm-device", exists: true, state: "not-parsed", sha256: sha(`<plist><dict><key>${VALUE}</key></dict></plist>`), keys: [], envKeys: [], unrecordedNames: 0 });
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(readSettingsFile({ label: "managed-mdm-device", file: path.join(workdir, "absent.plist"), parsed: false })).toMatchObject({ exists: false, state: "absent" });
  });

  it("marks the list as possibly incomplete when the pinned CLI is not the version it was read from", () => {
    expect(recordSettingsKeys({ ...options(), cliVersion: SETTINGS_LISTED_FOR_CLI }).listedForPinnedCli).toBe(true);
    expect(recordSettingsKeys({ ...options(), cliVersion: "2.9.9" })).toMatchObject({ listedForCli: SETTINGS_LISTED_FOR_CLI, listedForPinnedCli: false });
    expect(recordSettingsKeys({ ...options(), cliVersion: null }).listedForPinnedCli).toBe(false);
    const lines = settingsBannerLines(recordSettingsKeys({ ...options(), cliVersion: "2.9.9" }));
    expect(lines).toEqual([`Settings sources whose keys are not shown: the list of files, read from CLI ${SETTINGS_LISTED_FOR_CLI} and not from the pinned CLI, which may read others.`]);
  });

  it("flags the keys that can change a model call, by file label, naming only the CLI's own keys and counting the rest, and the sources whose keys are not shown", async () => {
    for (const key of ["model", "effortLevel", "alwaysThinkingEnabled", "env", "apiKeyHelper", "modelPricing", "fallbackModel", "advisorModel", "MaxThinkingTokensX", "thinkingBudget", "EFFORT", "outputTokenLimit", "Token"]) expect(isNoteworthyKey(key), key).toBe(true);
    for (const key of ["permissions", "hooks", "statusLine", "enabledPlugins", "autoMemoryEnabled", "includeCoAuthoredBy"]) expect(isNoteworthyKey(key), key).toBe(false);
    await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: VALUE, env: { A: VALUE }, permissions: {} }));
    await writeFile(path.join(project, ".claude", "settings.local.json"), JSON.stringify({ thinkingBudget: VALUE, hooks: {} }));
    await writeFile(path.join(project, ".claude", "settings.json"), "{ not json");
    await writeFile(path.join(managed, "managed-settings.json"), JSON.stringify({ modelPricing: VALUE }));
    const lines = settingsBannerLines(record());
    expect(lines).toEqual([
      "Settings keys present that can change a model call (the CLI's own key names, never values; any other key is counted): user: env, model; project-local: 1 other key(s) whose name contains model, effort, think or token; managed: modelPricing.",
      "Settings sources whose keys are not shown: project (not a JSON object).",
    ]);
    // Neither the values, the names under env nor a key that is not the CLI's own are in the banner.
    expect(lines.join("\n")).not.toContain(VALUE);
    expect(lines.join("\n")).not.toContain("thinkingBudget");
    expect(settingsBannerLines(record({ mainWorktree: null }))).toHaveLength(2);
    // Nothing present: nothing to say.
    expect(settingsBannerLines(cleanSettingsKeys())).toEqual([]);
    // An unreadable file and a property list are named as not shown.
    const r = cleanSettingsKeys();
    r.files.push({ label: "managed", exists: true, state: "unreadable", sha256: null, keys: [], envKeys: [], unrecordedNames: 0 });
    r.files.push({ label: "managed-mdm-device", exists: true, state: "not-parsed", sha256: "a".repeat(64), keys: [], envKeys: [], unrecordedNames: 0 });
    expect(settingsBannerLines(r)).toEqual(["Settings sources whose keys are not shown: managed (could not be read); managed-mdm-device (a property list, keys not read)."]);
  });

  it("describes a file for a dry run by state, hash, the CLI's own key names and counts, never a value or another name", async () => {
    await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: VALUE, env: { ANTHROPIC_BASE_URL: VALUE }, acmeCustomKey: VALUE }));
    await writeFile(path.join(project, ".claude", "settings.json"), "nope");
    const r = record();
    expect(describeSettingsFile(file(r, "user"))).toBe(
      `present, SHA-256 ${file(r, "user").sha256!.slice(0, 12)}, 3 top-level key(s), of which env, model named by the CLI's own key list and 1 other(s) counted only; 1 name(s) under env, counted only`
    );
    expect(describeSettingsFile(file(r, "user"))).not.toContain("ANTHROPIC_BASE_URL");
    expect(describeSettingsFile(file(r, "user"))).not.toContain("acmeCustomKey");
    expect(describeSettingsFile(file(r, "project"))).toMatch(/^present but not a JSON object, SHA-256 [0-9a-f]{12}, keys not shown$/);
    expect(describeSettingsFile(file(r, "project-local"))).toBe("absent");
    expect(describeSettingsFile({ label: "x", exists: true, state: "unreadable", sha256: null, keys: [], envKeys: [], unrecordedNames: 0 })).toBe("present but could not be read, keys not shown");
    for (const f of r.files) expect(describeSettingsFile(f)).not.toContain(VALUE);
  });

  it("shows the banner under the commit line of summary.md and keeps every value out of results.json and summary.md", async () => {
    await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: VALUE, env: { HTTPS_PROXY: VALUE } }));
    await writeFile(path.join(managed, "managed-settings.json"), JSON.stringify({ modelPricing: VALUE }));
    const environment = cleanEnvironment();
    environment.settingsKeys = record();
    const results = summaryResults({ environment });
    const md = renderSummary(results);
    const lines = md.split("\n");
    const at = lines.findIndex((l) => l.startsWith("Run started "));
    expect(lines[at + 1]).toBe("**Settings keys present that can change a model call (the CLI's own key names, never values; any other key is counted): user: env, model; managed: modelPricing.**");
    expect(environmentBannerLines(environment)).toEqual(["**Settings keys present that can change a model call (the CLI's own key names, never values; any other key is counted): user: env, model; managed: modelPricing.**"]);
    expect(md).toContain("2 present of 4 looked for (`user`, `managed`)");
    // The names under env are in results.json, which is not committed, and the values are nowhere.
    expect(serializeResults(results)).toContain('"HTTPS_PROXY"');
    expect(md).not.toContain("HTTPS_PROXY");
    expect(`${serializeResults(results)}\n${md}`).not.toContain(VALUE);
    // Nothing flagged, no banner.
    expect(environmentBannerLines(cleanEnvironment())).toEqual([]);
    expect(environmentBannerLines(null)).toEqual([]);
  });

  it("prints the settings files in a dry run by the CLI's own key names and counts, with the banner, and never a value or a name from the machine", { timeout: 240_000 }, async () => {
    const config = path.join(workdir, "dry-home");
    await mkdir(path.join(config, ".claude"), { recursive: true });
    await writeFile(path.join(config, ".claude", "settings.json"), JSON.stringify({ model: VALUE, env: { ANTHROPIC_BASE_URL: VALUE }, permissions: {}, acmeCustomKey: VALUE }));
    const run = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.eval.config.ts", "eval/acceptance/acceptance.eval.ts"], {
      cwd: ROOT,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: config,
        LANG: "C",
        EVAL_DRY: "1",
        EVAL_LEDGER: path.join(workdir, "ledger.jsonl"),
        EVAL_ARCHIVE_DIR: path.join(workdir, "archive"),
        EVAL_ONLY: "S1",
        EVAL_COMPARE: "0",
        DIRECTOR_MAX_BUDGET_USD: "0.5",
        DESIGN_AGENT_MAX_BUDGET_USD: "3",
        CLAUDE_CLI_PATH: path.join(workdir, "absent-claude"),
        // Names from the operator's machine: none of them may reach the output.
        ACME_MODEL_X: "1",
        ACMECORP_DEPLOY_TOKEN: VALUE,
        EMPLOYER_HTTP_PROXY: VALUE,
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 200_000,
    });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).toBe(0);
    expect(output).toContain("[acceptance] Settings files the pinned CLI reads (never values; the CLI's own key names are named, any other name is counted;");
    expect(output).toMatch(
      /\[acceptance\] {3}user: present, SHA-256 [0-9a-f]{12}, 4 top-level key\(s\), of which env, model named by the CLI's own key list and 2 other\(s\) counted only; 1 name\(s\) under env, counted only\./
    );
    expect(output).toMatch(/\[acceptance\] {3}project: /);
    expect(output).toContain("[acceptance] Settings keys present that can change a model call (the CLI's own key names, never values; any other key is counted): user: env, model.");
    // The classes of the harness's own environment and the MODEL names are counted, never named (the run's own variables are counted too, hence at least).
    const classes = /\[acceptance\] (\d+) variable\(s\) in the harness's own environment that reach every server, judge and arm are not reviewed as harmless \((\d+) with a name that looks like an endpoint, socket, token or proxy variable, or is NODE_OPTIONS, and (\d+) with a name that contains MODEL\)/.exec(output);
    expect(classes, output).not.toBeNull();
    expect(Number(classes![1])).toBeGreaterThanOrEqual(3);
    expect(Number(classes![2])).toBeGreaterThanOrEqual(2);
    expect(Number(classes![3])).toBeGreaterThanOrEqual(1);
    expect(Number(/\[acceptance\] (\d+) variable\(s\) whose name contains MODEL among those the servers, arm and judges receive \(counted, not named/.exec(output)![1])).toBeGreaterThanOrEqual(1);
    for (const name of ["ACME_MODEL_X", "ACMECORP_DEPLOY_TOKEN", "EMPLOYER_HTTP_PROXY", "acmeCustomKey", "ANTHROPIC_BASE_URL"]) expect(output, name).not.toContain(name);
    expect(output).toMatch(/\[acceptance\] HOME (differs from|could not be compared with|is) the account's home folder; both are redacted in every stored path, and neither is printed\./);
    expect(output).not.toContain(VALUE);
    expect(output).toContain("1 passed");
  });
});

describe("acceptance baseline: summary.md and a dry run name nothing that came from the operator's machine (#232)", () => {
  const VALUE = "synthetic-secret-value";
  // Names an operator's machine could hold: an employer's own variables, key and drop-in file.
  const MACHINE_NAMES = ["ACME_MODEL_X", "ACMECORP_DEPLOY_TOKEN", "EMPLOYER_HTTP_PROXY", "acmeCustomKey", "acme-corp.json", "acme-corp", "ACME_ENV_NAME", "ACME_REFUSED_VAR"];

  it("counts the unreviewed variable names by class and never names one", () => {
    const names = ["ACME_BUILD_FLAG", "ANTHROPIC_UNIX_SOCKET", "GH_TOKEN", "HTTPS_PROXY", "NODE_OPTIONS", "OTEL_EXPORTER_OTLP_ENDPOINT", "https_proxy", "npm_config_node_options", "SECRET_PROJECT_NAME", "my_model_x"];
    expect(countNamesByClass(names)).toEqual({ total: 10, endpointLike: 6, namesModel: 1 });
    expect(countNamesByClass([])).toEqual({ total: 0, endpointLike: 0, namesModel: 0 });
    // A name can be in both classes.
    expect(countNamesByClass(["MODEL_ENDPOINT"])).toEqual({ total: 1, endpointLike: 1, namesModel: 1 });
    expect(describeNameClasses(countNamesByClass(names))).toBe("6 with a name that looks like an endpoint, socket, token or proxy variable, or is NODE_OPTIONS, and 1 with a name that contains MODEL");
    expect(ENDPOINT_LIKE_NAME.test("npm_config_node_options")).toBe(false);
    expect(ENDPOINT_LIKE_NAME.test("NODE_OPTIONS")).toBe(true);
  });

  it("keeps ACME_MODEL_X, ACMECORP_DEPLOY_TOKEN, EMPLOYER_HTTP_PROXY, an unlisted settings key, a drop-in file and its env names out of summary.md and the dry run's lines, counts them right, and keeps them in results.json", async () => {
    const home = path.join(workdir, "machine-home");
    const project = path.join(workdir, "machine-checkout");
    const managed = path.join(workdir, "machine-managed");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(project, ".claude"), { recursive: true });
    await mkdir(path.join(managed, "managed-settings.d"), { recursive: true });
    await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: VALUE, acmeCustomKey: VALUE, acmeTokenLimit: 1, permissions: {} }));
    await writeFile(path.join(managed, "managed-settings.json"), JSON.stringify({ modelPricing: VALUE }));
    await writeFile(path.join(managed, "managed-settings.d", "acme-corp.json"), JSON.stringify({ env: { ACME_ENV_NAME: VALUE }, fallbackModel: VALUE, acmeCustomKey: VALUE }));
    await writeFile(path.join(managed, "managed-settings.d", "acme-corp-b.json"), "{ not json");
    const settingsKeys = recordSettingsKeys({ home, project, platform: "linux", managedDir: managed, username: null, cliVersion: SETTINGS_LISTED_FOR_CLI });
    // The drop-in files' names, the unlisted key and the names under env are recorded: in results.json.
    expect(settingsKeys.files.map((f) => f.label)).toEqual(["user", "project", "project-local", "managed", "managed-drop-in/acme-corp-b.json", "managed-drop-in/acme-corp.json"]);

    // A real run's variables: the harness's environment, and a .env file that adds a name that is not on the allowlist.
    const harnessEnv = { PATH: "/usr/bin", ACME_MODEL_X: "1", ACMECORP_DEPLOY_TOKEN: VALUE, EMPLOYER_HTTP_PROXY: VALUE };
    const unreviewed = unreviewedHarnessNames(harnessEnv, () => false);
    expect(unreviewed).toEqual(["ACMECORP_DEPLOY_TOKEN", "ACME_MODEL_X", "EMPLOYER_HTTP_PROXY"]);
    await writeFile(path.join(workdir, ".env.local"), `ACME_REFUSED_VAR=${VALUE}\nDESIGN_AGENT_TIMEOUT_SECONDS=900\n`);
    const loaded = loadedEnv(harnessEnv);
    expect(loaded.record.refused).toEqual(["ACME_REFUSED_VAR"]);
    // The allowlist's own name is named, with its file; the other is only counted.
    expect(splitAddedNames(loaded.record)).toEqual({ named: [{ name: "DESIGN_AGENT_TIMEOUT_SECONDS", file: "<project>/.env.local" }], notAllowed: 1 });
    const environment = cleanEnvironment();
    environment.settingsKeys = settingsKeys;
    environment.harnessEnvironment = { unreviewedNames: unreviewed };
    environment.modelPricing = modelPricing(receivedNames(loaded.env, harnessEnv));
    environment.serverEnvFiles = loaded.record;
    expect(environment.modelPricing.selectionVariables).toEqual(["ACME_MODEL_X"]);
    const results = summaryResults({ environment });
    const md = renderSummary(results);
    const json = serializeResults(results);

    // None of the machine's names is in summary.md or its banners; the values are nowhere.
    for (const name of MACHINE_NAMES) expect(md, name).not.toContain(name);
    expect(`${json}\n${md}`).not.toContain(VALUE);
    // The counts are right: 3 unreviewed, 2 endpoint-like (the token and the proxy) and 1 naming a model.
    expect(md).toContain(
      "3 variable(s) of the harness's own environment that reach every server, judge and arm are not reviewed as harmless (2 with a name that looks like an endpoint, socket, token or proxy variable, or is NODE_OPTIONS, and 1 with a name that contains MODEL)"
    );
    expect(md).toContain("1 variable(s) whose name contains MODEL reached the run (their names are in results.json under modelPricing, never committed).");
    expect(md).toContain("`DESIGN_AGENT_TIMEOUT_SECONDS`; **not allowed: 1 variable(s), named in results.json only**.");
    // user: model named, and 1 other key (acmeTokenLimit) counted; the drop-in files are counted and one of them is not JSON.
    expect(md).toContain(
      "(the CLI's own key names, never values; any other key is counted): user: model, and 1 other key(s) whose name contains model, effort, think or token; managed: modelPricing; 2 managed drop-in files: env, and 1 other key(s) whose name contains model, effort, think or token."
    );
    expect(md).toContain("Settings sources whose keys are not shown: 1 managed drop-in file (not a JSON object).");
    expect(md).toContain("4 present of 6 looked for (`user`, `managed`, 2 managed drop-in files)");
    // The banner lines carry the same counts.
    const banner = environmentBannerLines(environment).join("\n");
    expect(banner).toContain("Of the 3 variable(s) of the harness's own environment that are not reviewed as harmless, 2 with a name that looks like an endpoint");
    for (const name of MACHINE_NAMES) expect(banner, name).not.toContain(name);

    // results.json keeps the names, for the operator and never for a commit.
    for (const name of ["ACME_MODEL_X", "ACMECORP_DEPLOY_TOKEN", "EMPLOYER_HTTP_PROXY", "acmeCustomKey", "acme-corp.json", "ACME_ENV_NAME", "ACME_REFUSED_VAR"]) expect(json, name).toContain(name);

    // A dry run prints the same thing: the .env message, the classes, the settings lines.
    const printed = [
      printableMessage(loaded.record),
      ...describeSettingsFiles(settingsKeys),
      ...settingsBannerLines(settingsKeys),
      describeNameClasses(countNamesByClass(unreviewed)),
    ].join("\n");
    for (const name of MACHINE_NAMES) expect(printed, name).not.toContain(name);
    expect(printed).not.toContain(VALUE);
    expect(printableMessage(loaded.record)).toContain("1 variable(s) the harness does not allow, not named here");
    expect(printableMessage(loaded.record)).toContain("DESIGN_AGENT_TIMEOUT_SECONDS; 1 not on the allowlist, counted and not named");
    // The operator's own terminal gets the full refusal, naming what to remove.
    expect(loaded.record.message).toContain("variables the harness does not allow: ACME_REFUSED_VAR");
    expect(refusalBeforeSpend({ mode: "prod", harnessRefusal: null, pin: { ok: true, message: "pinned" } as never, envFiles: loaded.record, limits: { ok: true } as never, armSettings: { ok: true } as never })).toBe(loaded.record.message);
    expect(refusalBeforeSpend({ mode: "prod", harnessRefusal: null, pin: { ok: true, message: "pinned" } as never, envFiles: loaded.record, limits: { ok: true } as never, armSettings: { ok: true } as never }, { printable: true })).toBe(loaded.record.printable);
    const lines = describeSettingsFiles(settingsKeys);
    expect(lines).toEqual([
      expect.stringMatching(/^user: present, SHA-256 [0-9a-f]{12}, 4 top-level key\(s\), of which model named by the CLI's own key list and 3 other\(s\) counted only; 0 name\(s\) under env, counted only$/),
      "project: absent",
      "project-local: absent",
      expect.stringMatching(/^managed: present, SHA-256 [0-9a-f]{12}, 1 top-level key\(s\), of which modelPricing named/),
      "2 managed drop-in files: 3 top-level key(s) in all, of which env named by the CLI's own key list and 2 other(s) counted only; 1 name(s) under env, counted only; 1 file(s) whose keys are not shown",
    ]);
  });

  it("names only the fixed labels and the CLI's own key names, and counts everything else", async () => {
    expect([...SETTINGS_KEYS_OF_NOTE]).toEqual(["model", "effortLevel", "alwaysThinkingEnabled", "env", "apiKeyHelper", "modelPricing"]);
    const record: SettingsKeysRecord = {
      listedForCli: SETTINGS_LISTED_FOR_CLI,
      listedForPinnedCli: true,
      files: [
        { label: "managed-drop-in/acme-corp.json", exists: true, state: "ok", sha256: "a".repeat(64), keys: ["model"], envKeys: [], unrecordedNames: 0 },
        { label: "managed-drop-in/(unusual name 2)", exists: true, state: "unreadable", sha256: null, keys: [], envKeys: [], unrecordedNames: 0 },
        { label: "user", exists: false, state: "absent", sha256: null, keys: [], envKeys: [], unrecordedNames: 0 },
      ],
    };
    expect(presentSources(record)).toEqual([{ text: "2 managed drop-in files", counted: true }]);
    const text = [...settingsBannerLines(record), ...describeSettingsFiles(record)].join("\n");
    expect(text).not.toContain("acme-corp");
    expect(text).not.toContain("unusual name");
    expect(text).toContain("2 managed drop-in files: model");
    expect(text).toContain("1 managed drop-in file (could not be read)");
  });
});

describe("acceptance baseline: what is refused and what is only recorded (#232)", () => {
  it("says in the refusal exactly which four names are refused, and that nothing else is, without a claim about the CLI's own defaults", () => {
    const text = harnessEnvironmentRefusal(["MAX_THINKING_TOKENS"])!;
    expect(text).toContain("Only MAX_THINKING_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_CODE_MAX_CONTEXT_TOKENS, CLAUDE_CODE_EFFORT_LEVEL are refused here");
    expect(text).toContain("the CLI's other variables are recorded by name, and its settings files by key name, and are not refused");
    expect(text).not.toMatch(/own defaults/);
    expect(text).toContain("Unset it and run the harness again.");
  });

  it("records the CLI's other variables by name only, and does not refuse them", () => {
    const env = { ANTHROPIC_BETAS: "x", MAX_MCP_OUTPUT_TOKENS: "9", BASH_MAX_OUTPUT_LENGTH: "9", PATH: "/usr/bin" };
    expect(unreviewedHarnessNames(env, (name) => MODEL_ENV_NAME.test(name))).toEqual(["ANTHROPIC_BETAS", "BASH_MAX_OUTPUT_LENGTH", "MAX_MCP_OUTPUT_TOKENS"]);
    expect(refusedHarnessNames(env)).toEqual([]);
  });

  it("states the settings files and the managed settings in the limitation of every run's record", () => {
    const text = inheritedConfiguration({ home: workdir, project: workdir, serverEnv: {}, harnessEnv: {}, envFileVariables: [] }).limitations.join("\n");
    expect(text).toContain("The Design Agent and the Design-Agent-only arm run without --setting-sources, so they load the CLI's settings files, which can set model, effort, thinking, env and apiKeyHelper; managed settings apply to every role, the Director and the judge included.");
    expect(text).toContain("other CLI variables (for example ANTHROPIC_BETAS, MAX_MCP_OUTPUT_TOKENS and BASH_MAX_OUTPUT_LENGTH) are recorded by name only, not refused");
    expect(text).toContain("A paid run is refused for exactly the four names MAX_THINKING_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_CODE_MAX_CONTEXT_TOKENS and CLAUDE_CODE_EFFORT_LEVEL");
  });
});

describe("acceptance baseline: statements that were false are corrected (#232)", () => {
  const docs = readFileSync(path.join(ROOT, "docs", "architecture", "creative-workflow.md"), "utf8");
  const harnessSources = () => readdirSync(path.join(ROOT, "eval", "acceptance")).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(path.join(ROOT, "eval", "acceptance", f), "utf8")] as const);

  it("says that npm adds nothing at a server's start, and that what npm put in the harness's environment is recorded by name", () => {
    for (const [name, text] of [["creative-workflow.md", docs], ...harnessSources()]) expect(text, name).not.toMatch(/no npm setting reaches/i);
    expect(docs).toContain("Npm therefore adds nothing to a server's environment at its start.");
    expect(docs).toContain("What npm put in the harness's own environment, when the harness was itself started through `npx` or `npm`, passes on like any other variable of it and is recorded by name.");
    const limitation = inheritedConfiguration({ home: workdir, project: workdir, serverEnv: {}, harnessEnv: {}, envFileVariables: [] }).limitations.join("\n");
    expect(limitation).toContain("npm adds nothing to a server's environment at its start; what npm put in the harness's own environment, when the harness was started through npx or npm, is recorded by name in harnessEnvironment.unreviewedNames like any other variable");
  });

  it("says of summary.md and a dry run exactly what they show: counts, and only strings fixed in the harness's source by name", () => {
    // No claim that summary.md names the generic endpoint, socket, token, proxy or NODE_OPTIONS variables, or prints a recorded name.
    for (const [name, text] of [["creative-workflow.md", docs], ...harnessSources()]) {
      expect(text, name).not.toMatch(/by name, the generic/);
      expect(text, name).not.toMatch(/and the generic endpoint, socket, token, proxy and NODE_OPTIONS names/);
      expect(text, name).not.toMatch(/shows only (its|the) count of those names and, by name/);
    }
    expect(docs).toContain("summary.md and a dry run name none of them.");
    expect(docs).toContain("They show the count of those names, and how many of them have a name that looks like an endpoint, socket, token or proxy variable (or is `NODE_OPTIONS`) and how many have a name that contains `MODEL`, in either case.");
    expect(docs).toContain("summary.md and a dry run name no settings file, key or variable that came from the operator's machine.");
    expect(docs).toContain("Every other name is counted:");
    expect(docs).toContain("each file in the managed `managed-settings.d` folder, which is reported as a number of managed drop-in files and never by its file name.");
    expect(docs).toContain("The names are in results.json under `modelPricing.selectionVariables`, which is never committed, and are not printed anywhere else.");
    // The fixed strings it may print are the ones the source defines.
    for (const key of SETTINGS_KEYS_OF_NOTE) expect(docs, key).toContain(`\`${key}\``);
    const limitation = inheritedConfiguration({ home: workdir, project: workdir, serverEnv: {}, harnessEnv: {}, envFileVariables: [] }).limitations.join("\n");
    expect(limitation).toContain("summary.md and a dry run show only counts of those names by class and name no variable that came from the machine");
    expect(limitation).toContain("summary.md and a dry run name only the CLI's own key names from a fixed list and the fixed file labels, and count every other name");
  });

  it("describes no paid run under next dev, because it is refused", () => {
    expect(docs).not.toContain("under both `next dev` and a production build");
    expect(docs).not.toContain("A graceful signal under `next dev` closes open requests");
    expect(docs).toContain("A paid run always uses a production build, because a paid run under `next dev` is refused");
    const eval_ = readFileSync(path.join(ROOT, "eval", "acceptance", "acceptance.eval.ts"), "utf8");
    expect(eval_).not.toContain("tests restart recovery in both modes");
    expect(eval_).not.toContain("A graceful signal under\n * `next dev` closes open requests");
  });

  it("gives the CI variables a reason that matches what the CLI does with them", () => {
    const ci = HARMLESS_HARNESS_NAMES.find((g) => g.names.includes("GITHUB_ACTIONS"))!;
    expect(ci.why).not.toMatch(/neither the CLI nor Next\.js reads them/);
    expect(ci.why).toContain("the CLI reads GITHUB_ACTIONS and others for its subprocess environment scrubbing and its telemetry");
    expect(ci.why).toContain("none of them carries an endpoint, credential, proxy, configuration folder, preload or token limit");
    expect(docs).toContain("The CLI reads `GITHUB_ACTIONS` and some of the other runner variables for its subprocess environment scrubbing and its telemetry, but none of them carries an endpoint, credential, proxy, configuration folder, preload or token limit.");
  });

  it("applies the model test to every name the servers, the arm and the judges receive, and says that managed modelPricing is not priced by the table", () => {
    // Names no list chose in advance, in either case, from any of the environments.
    expect(receivedNames({ PATH: "/usr/bin", FOO_MODEL_X: "1", UNSET: undefined }, { my_model: "1", PATH: "/bin" })).toEqual(["FOO_MODEL_X", "PATH", "my_model"]);
    expect(modelPricing(receivedNames({ PATH: "/usr/bin", FOO_MODEL_X: "1" }, { my_model: "1" }))).toMatchObject({ selectionVariables: ["FOO_MODEL_X", "my_model"], unverified: true });
    expect(modelPricing(receivedNames({ PATH: "/usr/bin" }, { HOME: "/home/x" }))).toMatchObject({ selectionVariables: [], unverified: false });
    expect(MODEL_PRICE_NOTE).toContain("any variable whose name contains MODEL (in either case)");
    expect(MODEL_PRICE_NOTE).toContain("Managed settings can also set `modelPricing`");
    expect(MODEL_PRICE_NOTE).toContain("the record names a `modelPricing` key in a managed file and never its value");
    expect(docs).toContain("Managed settings can also set `modelPricing`, which replaces the price the CLI uses for a model and scales the cost it reports, for every role.");
    expect(docs).toContain("The test is applied to every name those processes receive, not to a list of names chosen in advance.");
  });

  it("lists the names Next.js adds to a server, `__NEXT_PROCESSED_ENV` among them, and does not claim that is all", () => {
    expect(NEXT_ADDED_TO_SERVER).toEqual([
      "NEXT_DEPLOYMENT_ID",
      "NEXT_PRIVATE_START_TIME",
      "NEXT_RUNTIME",
      "PORT",
      "RUST_MIN_STACK",
      "TURBOPACK",
      "__NEXT_PRIVATE_ORIGIN",
      "__NEXT_PROCESSED_ENV",
    ]);
    for (const name of NEXT_ADDED_TO_SERVER) expect(docs, name).toContain(`\`${name}\``);
    expect(docs).toContain("The arm's environment differs from a running server's by what Next.js itself adds to the server");
    expect(docs).not.toContain("differs from a running server's only by");
    const limitation = inheritedConfiguration({ home: workdir, project: workdir, serverEnv: {}, harnessEnv: {}, envFileVariables: [] }).limitations.join("\n");
    for (const name of NEXT_ADDED_TO_SERVER) expect(limitation, name).toContain(name);
    expect(limitation).not.toContain("only by what Next.js itself adds");
    // The loader's result leaves every such marker out of the arm's environment.
    expect(Object.keys(loadServerEnv({ root: workdir, mode: "prod", env: { PATH: process.env.PATH } }).env).filter((n) => n.startsWith("__NEXT_"))).toEqual([]);
  });

  it("says to reinstall the dependencies for a loader that did not run, and to correct a file for a file problem, never to remove a variable then", async () => {
    // The loader could not start under this NODE_OPTIONS.
    const broken = loadServerEnv({ root: workdir, mode: "prod", env: { PATH: process.env.PATH, NODE_OPTIONS: `--require ${path.join(workdir, "absent-preload.js")}` } }).record;
    expect(broken.ok).toBe(false);
    expect(broken.message).toContain("Reinstall the dependencies (npm ci) so that Next.js's loader runs, then run the harness again.");
    expect(broken.message).not.toContain("Remove it from the .env files");
    // A file that cannot be read: correct or remove the file.
    execFileSync("mkfifo", [path.join(workdir, ".env.local")]);
    const pipe = loadServerEnv({ root: workdir, mode: "prod", env: { PATH: process.env.PATH } }).record;
    expect(pipe.message).toContain("Correct or remove the .env file the problem names, then run the harness again.");
    expect(pipe.message).not.toContain("Reinstall");
    expect(pipe.message).not.toContain("Remove it from the .env files");
    await rm(path.join(workdir, ".env.local"));
    // An unknown variable: remove it, or allow its name after review.
    await writeFile(path.join(workdir, ".env.local"), "HTTPS_PROXY=http://proxy.example\n");
    const refused = loadServerEnv({ root: workdir, mode: "prod", env: { PATH: process.env.PATH } }).record;
    expect(refused.message).toContain("Remove it from the .env files, or add the name to SERVER_ENV_ALLOWLIST in eval/acceptance/server-env.ts after review.");
    expect(refused.message).not.toContain("Reinstall");
    // A line the loader does not read: correct or remove the line.
    await writeFile(path.join(workdir, ".env.local"), "DISABLE_AUTOUPDATER=1\nNAME_ONLY\n");
    const lines = loadServerEnv({ root: workdir, mode: "prod", env: { PATH: process.env.PATH } }).record;
    expect(lines.ok).toBe(false);
    expect(lines.message).toContain("Correct or remove those lines so that the loader reads them as assignments.");
    expect(lines.message).not.toContain("Reinstall");
    expect(docs).toContain("The refusal then says to reinstall the dependencies (`npm ci`), and for a file the loader could not read it says to correct or remove that file, and not to remove a variable.");
  });

  it("splits the sentences that were one very long line into one readable sentence per line", () => {
    expect(docs).not.toContain("The parts are the server starts (each waits");
    expect(docs).toContain("The parts are:\n- the server starts (each waits up to its ready limit and two stop graces);");
    expect(docs).not.toContain("so a stop for another reason fails it; and it passes");
    expect(docs).toContain("The reason names image generation or editing, in the stop message or in the Director's list of what is unavailable, so a stop for another reason fails it.\nIt passes \"nothing changed\" only when no slide or asset changed.");
    for (const line of docs.split("\n").filter((l) => l.startsWith("The parts are") || l.startsWith("When the run stops, it passes") || l.startsWith("The code is `capability_unavailable`"))) expect(line.length, line).toBeLessThan(300);
  });
});

describe("acceptance baseline: the worktree check is part of what a dry run reports (#232)", () => {
  it("returns the reason a primary or undeterminable worktree is refused, and null for a linked one", async () => {
    const { primary, linked } = await worktrees(workdir);
    expect(worktreeRefusal(primary)).toMatch(/^Refusing to run in the repository's primary worktree/);
    expect(worktreeRefusal(linked)).toBeNull();
    const plain = path.join(workdir, "plain");
    await mkdir(plain);
    expect(worktreeRefusal(plain)).toMatch(/could not be determined/);
    // The refusal names no absolute path.
    expect(worktreeRefusal(primary)).not.toContain(workdir);
  });

  it("puts the worktree's refusal last among the checks, so a dry run never reports that nothing would refuse a primary worktree", () => {
    const cli = path.join(workdir, "claude");
    const refusal = "Refusing to run in the repository's primary worktree: synthetic";
    const pin = checkCliPin([{ role: "servers", path: cli, version: "1.0.0" }], { explicit: true, source: "synthetic", file: { size: 1, sha256: "a".repeat(64) } });
    const envFiles = loadedEnv({ PATH: process.env.PATH }).record;
    const settings = (value: string) => ({ limits: designAgentLimits(loadedEnv({ DESIGN_AGENT_MAX_BUDGET_USD: "4", DESIGN_AGENT_TIMEOUT_SECONDS: value })), armSettings: designAgentOnlyRun(loadedEnv({ DESIGN_AGENT_MAX_BUDGET_USD: "4", DESIGN_AGENT_TIMEOUT_SECONDS: value })).settings });
    const fine = { mode: "prod", harnessRefusal: null, pin, envFiles } as const;
    // Everything else holds: the worktree is what refuses.
    expect(refusalBeforeSpend({ ...fine, ...settings("900"), worktree: refusal })).toBe(refusal);
    expect(refusalBeforeSpend({ ...fine, ...settings("900"), worktree: null })).toBeNull();
    expect(refusalBeforeSpend({ ...fine, ...settings("900") })).toBeNull();
    // Any earlier check speaks first.
    const earlier = refusalBeforeSpend({ ...fine, ...settings("soon"), worktree: refusal })!;
    expect(earlier).toMatch(/does not accept the Design Agent settings/);
    expect(refusalBeforeSpend({ ...fine, mode: "dev", ...settings("900"), worktree: refusal })).toBe(DEV_MODE_REFUSAL);
  });
});

describe("acceptance baseline: both home folders are redacted, and only whether they differ is recorded (#232)", () => {
  const root = "/work/checkout";

  it("redacts a path under either folder, and the shortest result when one lies under the other", () => {
    expect(redactPathFromModule("/home/synthetic/.local/bin/claude", ["/tmp/scratch-home", "/home/synthetic"])).toBe("~/.local/bin/claude");
    expect(redactPathFromModule("/tmp/scratch-home/.claude/skills", ["/tmp/scratch-home", "/home/synthetic"])).toBe("~/.claude/skills");
    expect(redactPathFromModule("/home/synthetic", ["/tmp/scratch-home", "/home/synthetic"])).toBe("~");
    // One home inside the other: the more specific folder gives the shorter result.
    expect(redactPathFromModule("/home/synthetic/scratch/x", ["/home/synthetic", "/home/synthetic/scratch"])).toBe("~/x");
    // Under neither: unchanged. A single folder still works as before.
    expect(redactPathFromModule("/elsewhere/claude", ["/tmp/scratch-home", "/home/synthetic"])).toBe("/elsewhere/claude");
    expect(redactPathFromModule("/home/synthetic/.local/bin/claude", "/home/synthetic")).toBe("~/.local/bin/claude");
    expect(redactPathFromModule("/home/synthetic-two/claude", ["/home/synthetic"])).toBe("/home/synthetic-two/claude");
  });

  it("lists each home folder once, and compares HOME with the account's home folder without recording either path", () => {
    expect(homeFolders("/tmp/scratch-home", "/home/synthetic")).toEqual(["/tmp/scratch-home", "/home/synthetic"]);
    expect(homeFolders("/home/synthetic", "/home/synthetic")).toEqual(["/home/synthetic"]);
    expect(homeFolders("/tmp/scratch-home", null)).toEqual(["/tmp/scratch-home"]);
    expect(homeDiffersFromAccount("/tmp/scratch-home", "/home/synthetic")).toBe(true);
    expect(homeDiffersFromAccount("/home/synthetic", "/home/synthetic")).toBe(false);
    expect(homeDiffersFromAccount("/home/synthetic/", "/home/synthetic")).toBe(false);
    // The account's home cannot be read: nothing can be said.
    expect(homeDiffersFromAccount("/home/synthetic", null)).toBeNull();
    for (const answer of [homeDiffersFromAccount("/tmp/scratch-home", "/home/synthetic"), homeDiffersFromAccount("/home/synthetic", null)]) expect(typeof answer === "boolean" || answer === null).toBe(true);
    // The real one: a string or null, the same the system lists.
    const real = accountHome();
    expect(real === null || typeof real === "string").toBe(true);
    expect(homeDiffersFromAccount(real ?? "/x", real)).toBe(real === null ? null : false);
  });

  it("removes the account's home folder from stored text and from results.json and summary.md, even when HOME names another folder", () => {
    const redaction = { home: "/tmp/scratch-home", accountHome: "/home/synthetic", root };
    const text = "failed at /home/synthetic/.local/bin/claude, cwd /tmp/scratch-home/work, checkout /work/checkout/data, and /home/synthetic-two/keep";
    const out = redactText(text, redaction);
    expect(out).toBe("failed at ~/.local/bin/claude, cwd ~/work, checkout <checkout>/data, and /home/synthetic-two/keep");
    // The longer folder goes first when one lies under the other.
    expect(redactText("/home/synthetic/scratch/x and /home/synthetic/y", { home: "/home/synthetic/scratch", accountHome: "/home/synthetic", root })).toBe("~/x and ~/y");
    // Without an account home, as before.
    expect(redactText(text, { home: "/tmp/scratch-home", root })).toContain("/home/synthetic/.local/bin/claude");
    const results = summaryResults({ scenarios: [{ ...record("S1", 1), harnessError: "stack at /home/synthetic/work/x.ts" }] });
    expect(serializeResults(results, redaction)).not.toContain("/home/synthetic/");
    expect(renderSummary(results, redaction)).not.toContain("/home/synthetic/");
    expect(serializeResults(results, redaction)).toContain("~/work/x.ts");
  });

  it("redacts a CLI path under either folder in the pin check", () => {
    const pin = checkCliPin([{ role: "servers", path: "/home/synthetic/bin/claude", version: "1.0.0" }], { explicit: true, source: "synthetic", file: { size: 1, sha256: "a".repeat(64) }, home: ["/tmp/scratch-home", "/home/synthetic"] });
    expect(pin.uses[0].path).toBe("~/bin/claude");
    expect(pin.message).not.toContain("/home/synthetic");
  });

  it("records the boolean on the environment record and shows it in summary.md without either path", () => {
    const environment = cleanEnvironment();
    environment.homeDiffersFromAccount = true;
    expect(renderSummary(summaryResults({ environment }))).toContain("HOME differs from the account's home folder; both are redacted as `~` in every stored path, and neither is recorded.");
    environment.homeDiffersFromAccount = false;
    expect(renderSummary(summaryResults({ environment }))).toContain("HOME is the account's home folder; both are redacted");
    environment.homeDiffersFromAccount = null;
    expect(renderSummary(summaryResults({ environment }))).toContain("HOME could not be compared with the account's home folder");
    expect(JSON.stringify(environment)).not.toMatch(/\/home\/|\/Users\//);
  });
});
