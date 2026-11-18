import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { format } from "node:util";

import { serverCosts, type ChatResult } from "../eval/acceptance/app";
import { archived, archiveDir, archiveRun } from "../eval/acceptance/archive";
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
  envLocalCliPath,
  harnessHashes,
  inheritedConfiguration,
  mcpServerNames,
  memoryRoots,
  memoryTrees,
  modelEnvironment,
  redactPath,
  redactText,
  transcriptModels,
  treeFingerprint,
  type InheritedConfiguration,
} from "../eval/acceptance/environment";
import { JUDGE_BUDGET_USD, MIN_READ_TURNS, OUTCOME_DIMENSIONS, type JudgeCall, type OutcomeScores, type OutcomeVerdict } from "../eval/acceptance/judge";
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
import { completeness, excludedVerdicts, scenarioStatistics } from "../eval/acceptance/report-baseline";
import { renderSummary, serializeResults, type ChatRecord, type ComparisonRecord, type RunResults, type ScenarioRecord } from "../eval/acceptance/report";
import { SCENARIOS, SYNTHETIC_BRAND, type ScenarioId } from "../eval/acceptance/scenarios";
import { cleanEnv } from "../eval/acceptance/server";
import { requestMs, spread } from "../eval/acceptance/stats";
import { addUsage, modelsFromResult, usageFromCli } from "../eval/acceptance/usage";

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

  it("hashes every harness file and reads the servers' CLI path from .env.local", async () => {
    await writeFile(path.join(workdir, "a.ts"), "a");
    await writeFile(path.join(workdir, ".env.local"), `OTHER=1\nCLAUDE_CLI_PATH="/opt/tools/claude"\n`);
    expect(harnessHashes(workdir).find((h) => h.file === "a.ts")?.sha256).toBe(createHash("sha256").update("a").digest("hex"));
    expect(envLocalCliPath(workdir)).toBe("/opt/tools/claude");
    expect(envLocalCliPath(path.join(workdir, "none"))).toBeNull();
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
        cli: { server: { path: "~/bin/claude", version: "1.0.0 (Claude Code)" }, harness: { path: null, version: null } },
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
    expect(md).toContain(`synthetic brand "${SYNTHETIC_BRAND.name}"`);
    expect(md).toContain("in this order: S1#1, S1#2");
    expect(md).toContain("| S1#1 with Director | 1 | 2 | 3 | 4 | 10 |");
    // Only the count and the combined hash are shown; the per-file table stays in results.json.
    expect(md).toContain("2 item(s) fingerprinted, combined SHA-256 `" + "c".repeat(64) + "`");
    expect(md).not.toContain("~/.claude/settings.json");
    expect(md).not.toContain("| File | Exists |");
    expect(md).toContain("Limitation: The harness strips CLAUDE_CODE_*");
    expect(md).toContain("model-x");
    expect(md).not.toMatch(/[\u2013\u2014]/);
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
      baseline: { ok: false, durationMs: 1, costUsd: null, usage: null, turns: null, models: [], subtype: null, resultText: null, error: "timed out" },
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
        mcpServers: { github: { command: "npx", args: ["--token", SECRET], env: { TOKEN: SECRET }, url: `https://example.invalid/${SECRET}` } },
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
    const options = { home, project, platform: "win32" as const, serverEnv: {}, harnessEnv: {} };
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
      const options = { home, project, platform: "win32" as const, mode: "prod" as const, serverEnv: cleanEnv(), harnessEnv: process.env };
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
      for (const forbidden of [SECRET, "model-a", "tokens-9000", workdir, "npx", "example.invalid"]) expect(json).not.toContain(forbidden);

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
    baseline: { ok: true, durationMs: 1000, costUsd, usage: null, turns: 3, models: [], subtype: "success", resultText: null, error: null },
    baselineExport: null,
    baselineJudge: null,
    pairwise: null,
    skipped: null,
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
