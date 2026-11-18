import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { format } from "node:util";

import { serverCosts } from "../eval/acceptance/app";
import { archived, archiveDir, archiveRun } from "../eval/acceptance/archive";
import { callsFor, parseCaps, parseRepeat, planRun, preflight, renderPlan } from "../eval/acceptance/budget";
import { configFingerprint, envLocalCliPath, harnessHashes, redactPath, transcriptModels } from "../eval/acceptance/environment";
import { JUDGE_BUDGET_USD, OUTCOME_DIMENSIONS, type OutcomeScores } from "../eval/acceptance/judge";
import { appendLedger, ledgerPath, ledgerTotals, m1CapUsd, main as ledgerCli, readLedger, type LedgerEntry } from "../eval/acceptance/ledger";
import { scenarioStatistics } from "../eval/acceptance/report-baseline";
import { renderSummary, type ComparisonRecord, type RunResults, type ScenarioRecord } from "../eval/acceptance/report";
import { SCENARIOS, SYNTHETIC_BRAND } from "../eval/acceptance/scenarios";
import { spread } from "../eval/acceptance/stats";
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
const caps = { directorUsd: 0.5, designUsd: 3, judgeUsd: JUDGE_BUDGET_USD };

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

  it("summarises each scenario over its repetitions, per arm", () => {
    const scores = (n: number) => Object.fromEntries(OUTCOME_DIMENSIONS.map((d) => [d, { score: n, evidence: "" }])) as OutcomeScores;
    const runs = [3, 4, 5].map((score, i) => ({
      ...record("S1", i + 1),
      outcome: "completed",
      wallMs: (i + 1) * 10_000,
      judge: { ok: true as const, verdict: { scores: scores(score), flags: {} as never, summary: "" }, costUsd: 0.1, durationMs: 1, turns: 4 },
      costs: costs({ designCostUsd: i + 1, designUsage: { inputTokens: 10, outputTokens: 100 * (i + 1), cacheReadTokens: 0, cacheCreationTokens: 0 } }),
    }));
    const rows = scenarioStatistics({ scenarios: runs, comparisons: [comparison("S1", 1, 2.5)] });
    const row = (scenarioName: string, metric: string) => rows.find((r) => r.scenario === scenarioName && r.metric === metric)?.stats;
    expect(row("S1", "Judge mean (1 to 5)")).toEqual({ n: 3, median: 4, min: 3, max: 5 });
    expect(row("S1", "Design output tokens")).toEqual({ n: 3, median: 200, min: 100, max: 300 });
    expect(row("S1", "Wall time s (completed runs)")).toEqual({ n: 3, median: 20, min: 10, max: 30 });
    expect(row("S1", "Run cost (Director, design, judges)")?.median).toBeCloseTo(2.2); // 0.10 Director + 2 design + 0.10 judge
    expect(row("S1 Design Agent only", "Design cost")).toEqual({ n: 1, median: 2.5, min: 2.5, max: 2.5 });
    // A metric no run has is left out rather than shown as n = 0.
    expect(row("S1", "Revision: brief kept")).toBeUndefined();
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
    expect(parseCaps({ DIRECTOR_MAX_BUDGET_USD: "0.5", DESIGN_AGENT_MAX_BUDGET_USD: "3" })).toEqual(caps);
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
      spend: { ledger: "~/ledger.jsonl", preflight: preflight(plan, [], 50), reservation: null, spend: null, error: null },
      brand: { id: "b-1", name: SYNTHETIC_BRAND.name },
      environment: {
        commit: "abc1234",
        commitDirty: false,
        node: "v0",
        platform: "test",
        cli: { server: { path: "~/bin/claude", version: "1.0.0 (Claude Code)" }, harness: { path: null, version: null } },
        models: { designAgent: { models: ["model-x"], source: "transcripts" }, director: { models: [], source: "not recorded" }, designAgentOnly: [], judge: [] },
        inheritedConfiguration: [{ label: "~/.claude/settings.json", exists: true, size: 2, sha256: "f".repeat(64) }],
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
    expect(md).toContain("`~/.claude/settings.json`");
    expect(md).toContain("model-x");
    expect(md).not.toMatch(/[\u2013\u2014]/);
  });
});

// ---------------------------------------------------------------------------
// Synthetic records.

function costs(overrides: Partial<NonNullable<ScenarioRecord["costs"]>>): NonNullable<ScenarioRecord["costs"]> {
  return {
    directorCostUsd: 0.1,
    directorMs: 1000,
    directorTurns: 2,
    directorPlan: null,
    designCostUsd: 1,
    designMs: 2000,
    designUsage: null,
    designTurns: 5,
    designRunsWithoutUsage: 0,
    imagesStaged: 0,
    imageMs: [],
    imageFailures: [],
    retries: [],
    ...overrides,
  };
}

function record(id: "S1" | "S10", repetition: number): ScenarioRecord {
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
  };
}
