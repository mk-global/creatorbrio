import { afterAll, beforeAll, describe, it } from "vitest";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runDirector, type DirectorRequest, type DirectorResult } from "@/lib/visual-director";
import type { ReadyPlan } from "@/lib/director-plan";
import { enterWorkspace, scenarioRequest } from "./workspace";
import { SCENARIOS, type Outcome, type Scenario } from "./scenarios";
import { DIMENSIONS, DIMENSION_LABELS, judge, type Dimension, type JudgeResult } from "./judge";

/**
 * The Visual Director intelligence evaluation (RUBRIC.md). Runs every
 * scenario through the real Director, sequentially, applies the deterministic
 * checks, asks the judge for scores, and writes raw results plus a summary to
 * eval/results/<run>/ (gitignored).
 *
 *   npx vitest run --config vitest.eval.config.ts eval/director/suite.eval.ts
 *
 * EVAL_ONLY=id,id limits the scenarios; EVAL_TRIALS=n overrides every
 * scenario's trial count. Threshold misses are reported, not thrown; only a
 * harness error fails a test.
 */

// Captured before any workspace changes the working directory.
const ROOT = process.cwd();
const RUBRIC = readFileSync(path.join(ROOT, "eval", "director", "RUBRIC.md"), "utf8");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.join(ROOT, "eval", "results", RUN_ID);

const only = process.env.EVAL_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const trialOverride = process.env.EVAL_TRIALS ? Number(process.env.EVAL_TRIALS) : undefined;
if (trialOverride !== undefined && !(Number.isInteger(trialOverride) && trialOverride >= 1)) {
  throw new Error("EVAL_TRIALS must be a positive integer");
}
const unknown = only?.filter((id) => !SCENARIOS.some((s) => s.id === id)) ?? [];
if (unknown.length > 0) throw new Error(`EVAL_ONLY names unknown scenarios: ${unknown.join(", ")}`);
const selected = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
const trialsOf = (s: Scenario) => trialOverride ?? s.trials ?? 1;

// ---------------------------------------------------------------------------
// Deterministic checks.

type TrialOutcome = Outcome | `failed:${string}`;

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

interface TrialRecord {
  scenario: string;
  category: string;
  trial: number;
  outcome: TrialOutcome;
  director: { ok: boolean; code?: string; errors?: string[]; costUsd: number | null; durationMs: number; turns: number | null; deniedReads: number };
  plan: unknown;
  referenceIds: Record<string, string>;
  checks: Check[];
  deterministicPass: boolean;
  patternFabrication: string[];
  judge: JudgeResult | null;
  judgedMean: number | null;
}

function classify(result: DirectorResult): TrialOutcome {
  if (result.ok) return result.plan.status;
  if (result.code === "capability_unavailable" && result.unavailable?.includes("image-editing")) return "edit-refused";
  return `failed:${result.code}`;
}

const lower = (value: unknown) => JSON.stringify(value ?? "").toLowerCase();

/** The text the Director was given, against which numbers in its plan are checked. */
function inputText(scenario: Scenario): string {
  return [
    scenario.message,
    JSON.stringify(scenario.setup.brief ?? ""),
    ...(scenario.setup.slides ?? []).map((s) => `${s.html} ${s.notes ?? ""}`),
    ...(scenario.setup.sources ?? []).map((s) => `${s.title} ${s.text}`),
  ].join(" ");
}

const CLAIM_PATTERNS: RegExp[] = [
  /\b(studies|research|data|surveys?) (show|shows|suggest|suggests|prove|proves|found)\b/i,
  /\baccording to (a |an |the )?(study|survey|report|research)\b/i,
  /\bwill (increase|boost|drive|double|improve) (engagement|reach|conversions?|followers|saves|shares|clicks)\b/i,
  /\b\d+(\.\d+)?x (more|higher|better)\b/i,
  /\bengagement rates?\b/i,
];

/** Pattern-level fabrication check on the advisory strategy (RUBRIC.md check 6). */
function patternFabrication(scenario: Scenario, plan: ReadyPlan): string[] {
  const text = JSON.stringify(plan.strategy);
  const source = inputText(scenario);
  const hits: string[] = [];
  for (const pattern of CLAIM_PATTERNS) {
    const match = text.match(pattern);
    if (match) hits.push(match[0]);
  }
  for (const pct of text.match(/\d+(\.\d+)?\s?%/g) ?? []) {
    if (!source.includes(pct.replace(/\s/g, ""))) hits.push(pct);
  }
  return hits;
}

function deterministicChecks(scenario: Scenario, request: DirectorRequest, result: DirectorResult, outcome: TrialOutcome): Check[] {
  const expect = scenario.expect;
  const checks: Check[] = [
    {
      name: "outcome",
      pass: (expect.accept as string[]).includes(outcome),
      detail: `got ${outcome}; accepts ${expect.accept.join(" or ")}${!result.ok && result.errors ? `; errors: ${result.errors.slice(0, 3).join(" | ")}` : ""}`,
    },
  ];
  if (!(result.ok && result.plan.status === "ready")) return checks;
  const plan = result.plan;

  if (expect.basis) {
    checks.push({
      name: "basis",
      pass: plan.execution.slideCountBasis === expect.basis,
      detail: `got ${plan.execution.slideCountBasis} (${plan.execution.slideCount} slides); expected ${expect.basis}`,
    });
  }
  if (expect.imageUse) {
    const generated = plan.execution.assets.filter((a) => a.operation === "generate").length;
    checks.push({
      name: "imageUse",
      pass: generated >= expect.imageUse.min && generated <= expect.imageUse.max,
      detail: `${generated} generated; expected ${expect.imageUse.min} to ${expect.imageUse.max}`,
    });
  }
  for (const [index, role] of Object.entries(expect.referenceRoles ?? {})) {
    const id = request.references[Number(index)]?.id;
    const placed = plan.execution.slides.some((s) => s.assetRefs.includes(id));
    const styled = plan.execution.slides.some((s) => s.styleReferenceIds.includes(id));
    const pass = role === "placement" ? placed && !styled : styled && !placed;
    checks.push({ name: `referenceRole[${index}]`, pass, detail: `expected ${role}; placed ${placed}, style ${styled}` });
  }
  if (expect.mustKeep?.length) {
    const kept = lower([plan.strategy, plan.execution.slides, plan.execution.assets, plan.briefUpdate.fields, plan.briefUpdate.addConstraints, plan.briefUpdate.addVisualDecisions]);
    const retired = lower([plan.briefUpdate.retireConstraints, plan.briefUpdate.retireVisualDecisions]);
    for (const keyword of expect.mustKeep) {
      const k = keyword.toLowerCase();
      checks.push({
        name: `mustKeep:${keyword}`,
        pass: kept.includes(k) && !retired.includes(k),
        detail: `present ${kept.includes(k)}, retired ${retired.includes(k)}`,
      });
    }
  }
  const fabricated = patternFabrication(scenario, plan);
  checks.push({ name: "noFabrication", pass: fabricated.length === 0, detail: fabricated.length ? fabricated.join("; ") : "none" });
  return checks;
}

// ---------------------------------------------------------------------------
// Judge input.

function depicts(svg: string): string {
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  return texts[texts.length - 1] ?? "an image";
}

function setupSummary(scenario: Scenario, request: DirectorRequest): string {
  const { setup } = scenario;
  const lines = [
    `Aspect ratio: ${setup.aspectRatio}.`,
    `Brand: ${request.brand.name}; style keywords: ${request.brand.styleKeywords.join(", ") || "none"}; colours: ${Object.values(request.brand.colors).join(", ")}; fonts: heading ${request.brand.fonts.heading}, body ${request.brand.fonts.body}.`,
    `Image generation available: ${setup.imageGeneration ?? true ? "yes" : "no"}. Image editing available: no.`,
    `Existing slides: ${setup.slides?.length ?? 0}${setup.slides?.length ? ` (${setup.slides.map((s, i) => `${i + 1}: ${s.notes ?? ""}`).join("; ")})` : ""}.`,
  ];
  if (setup.references?.length) {
    lines.push("Uploaded reference images:");
    setup.references.forEach((ref, i) => lines.push(`- ID ${request.references[i]?.id}: file ${ref.name}, a simple synthetic drawing of ${depicts(ref.svg)}, with that caption printed along its bottom edge`));
  } else lines.push("Uploaded reference images: none.");
  lines.push(`Stored Creative Brief: ${setup.brief ? JSON.stringify(setup.brief, null, 2) : "none (new request)."}`);
  for (const source of setup.sources ?? []) lines.push(`Linked page ${source.url} ("${source.title}"):\n${source.text}`);
  return lines.join("\n");
}

function judgedMean(result: JudgeResult | null): number | null {
  if (!result?.ok) return null;
  const scores = DIMENSIONS.map((d) => result.verdict.scores[d].score).filter((s): s is number => s !== null);
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

// ---------------------------------------------------------------------------
// Running.

const records: TrialRecord[] = [];

async function runTrial(scenario: Scenario, trial: number): Promise<TrialRecord> {
  const workspace = await enterWorkspace(scenario.brand);
  try {
    const request = await scenarioRequest(scenario.setup, scenario.message);
    const result = await runDirector(request);
    const outcome = classify(result);
    const checks = deterministicChecks(scenario, request, result, outcome);
    const plan = result.ok ? result.plan : null;
    const judged = plan
      ? await judge(RUBRIC, {
          scenarioId: scenario.id,
          message: scenario.message,
          setupSummary: setupSummary(scenario, request),
          whatGoodLooksLike: scenario.whatGoodLooksLike,
          outcome: plan,
        })
      : null;
    return {
      scenario: scenario.id,
      category: scenario.category,
      trial,
      outcome,
      director: {
        ok: result.ok,
        code: result.ok ? undefined : result.code,
        errors: result.ok ? undefined : result.errors,
        ...result.usage,
      },
      plan,
      referenceIds: Object.fromEntries(request.references.map((r, i) => [r.id, scenario.setup.references?.[i]?.name ?? ""])),
      checks,
      deterministicPass: checks.every((c) => c.pass),
      patternFabrication: plan?.status === "ready" ? patternFabrication(scenario, plan) : [],
      judge: judged,
      judgedMean: judgedMean(judged),
    };
  } finally {
    process.chdir(ROOT);
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

describe("Visual Director evaluation", () => {
  beforeAll(async () => {
    await mkdir(OUT, { recursive: true });
    console.log(`[eval] ${selected.length} scenarios, ${selected.reduce((n, s) => n + trialsOf(s), 0)} trials -> ${OUT}`);
  });

  for (const scenario of selected) {
    it(
      scenario.id,
      async () => {
        for (let trial = 1; trial <= trialsOf(scenario); trial++) {
          const record = await runTrial(scenario, trial);
          records.push(record);
          await appendFile(path.join(OUT, "trials.jsonl"), JSON.stringify(record) + "\n");
          console.log(
            `[eval] ${scenario.id}#${trial} ${record.outcome} det=${record.deterministicPass ? "pass" : "FAIL"} judged=${record.judgedMean?.toFixed(2) ?? "-"} $${((record.director.costUsd ?? 0) + (record.judge?.costUsd ?? 0)).toFixed(3)}`
          );
        }
      },
      trialsOf(scenario) * 8 * 60_000
    );
  }

  afterAll(async () => {
    await writeFile(path.join(OUT, "results.json"), JSON.stringify({ runId: RUN_ID, records }, null, 2));
    await writeFile(path.join(OUT, "summary.md"), summarize(records));
    console.log(`[eval] summary written to ${path.join(OUT, "summary.md")}`);
  });
});

// ---------------------------------------------------------------------------
// Summary.

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x: number | null, digits = 2) => (x === null ? "n/a" : x.toFixed(digits));
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const percentile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

function summarize(all: TrialRecord[]): string {
  const total = all.length;
  const accepted = all.filter((r) => r.checks[0]?.pass).length;
  const detPass = all.filter((r) => r.deterministicPass).length;
  const judgedOk = all.filter((r) => r.judge?.ok);
  const judgeFailures = all.filter((r) => r.judge && !r.judge.ok);

  const dimensionMeans = Object.fromEntries(
    DIMENSIONS.map((d) => [
      d,
      mean(judgedOk.map((r) => (r.judge as Extract<JudgeResult, { ok: true }>).verdict.scores[d].score).filter((s): s is number => s !== null)),
    ])
  ) as Record<Dimension, number | null>;
  const allScores = judgedOk.flatMap((r) =>
    DIMENSIONS.map((d) => (r.judge as Extract<JudgeResult, { ok: true }>).verdict.scores[d].score).filter((s): s is number => s !== null)
  );
  const overall = mean(allScores);

  const scenarioIds = [...new Set(all.map((r) => r.scenario))];
  const perScenario = scenarioIds.map((id) => {
    const trials = all.filter((r) => r.scenario === id);
    const means = trials.map((r) => r.judgedMean).filter((m): m is number => m !== null);
    const outcomes = new Set(trials.map((r) => `${r.outcome}/${r.deterministicPass}`));
    return {
      id,
      category: trials[0].category,
      trials: trials.length,
      outcomes: [...new Set(trials.map((r) => r.outcome))].join(", "),
      detPass: trials.filter((r) => r.deterministicPass).length,
      mean: mean(means),
      spread: means.length > 1 ? Math.max(...means) - Math.min(...means) : null,
      consistent: outcomes.size === 1,
      failing: [...new Set(trials.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => c.name)))],
    };
  });

  const honestyBoth = all.filter((r) => r.patternFabrication.length > 0 && r.judge?.ok && r.judge.verdict.fabricatedClaims.flag);
  const flagged = all.filter((r) => r.judge?.ok && (r.judge.verdict.fabricatedClaims.flag || r.judge.verdict.ignoredConstraint.flag));

  const dims = DIMENSIONS.filter((d) => dimensionMeans[d] !== null);
  const weakScenarios = perScenario.filter((s) => s.mean !== null && s.mean < 3.0);
  const thresholds: [string, boolean, string][] = [
    ["Plan validity >= 95%", total > 0 && accepted / total >= 0.95, pct(accepted, total)],
    ["Deterministic expectations >= 90%", total > 0 && detPass / total >= 0.9, pct(detPass, total)],
    ["Mean judged score >= 4.0", overall !== null && overall >= 4.0, fmt(overall)],
    ["Every dimension mean >= 3.5", dims.length > 0 && dims.every((d) => (dimensionMeans[d] as number) >= 3.5), dims.map((d) => `${d} ${fmt(dimensionMeans[d])}`).join(", ")],
    ["No scenario mean below 3.0", weakScenarios.length === 0, weakScenarios.map((s) => s.id).join(", ") || "none"],
    ["No fabrication flagged by both pattern and judge", honestyBoth.length === 0, `${honestyBoth.length} trials`],
  ];

  const directorCosts = all.map((r) => r.director.costUsd ?? 0);
  const judgeCosts = all.map((r) => r.judge?.costUsd ?? 0);
  const directorTimes = all.map((r) => r.director.durationMs);

  const worst = [...all]
    .sort((a, b) => (a.judgedMean ?? (a.deterministicPass ? 2.5 : 0)) - (b.judgedMean ?? (b.deterministicPass ? 2.5 : 0)))
    .slice(0, 5);

  const lines: string[] = [];
  lines.push(`# Visual Director evaluation run ${RUN_ID}`, "");
  lines.push(`Scenarios: ${scenarioIds.length}.`, `Trials: ${total}.`, `Judge failures: ${judgeFailures.length}.`);
  if (only) lines.push(`Filtered run (EVAL_ONLY): this is not a full-suite result and thresholds do not apply to it.`);
  lines.push("", "## Thresholds (RUBRIC.md)", "", "| Threshold | Result | Value |", "| --- | --- | --- |");
  for (const [name, pass, valueText] of thresholds) lines.push(`| ${name} | ${pass ? "pass" : "MISS"} | ${valueText} |`);
  lines.push("", "## Judged dimensions", "", "| Dimension | Mean |", "| --- | --- |");
  for (const d of DIMENSIONS) lines.push(`| ${DIMENSION_LABELS[d]} | ${fmt(dimensionMeans[d])} |`);
  lines.push(`| Overall | ${fmt(overall)} |`);
  lines.push("", "## Scenarios", "", "| Scenario | Category | Trials | Outcomes | Deterministic pass | Judged mean | Spread | Consistent | Failing checks |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of perScenario) {
    lines.push(
      `| ${s.id} | ${s.category} | ${s.trials} | ${s.outcomes} | ${s.detPass}/${s.trials} | ${fmt(s.mean)} | ${fmt(s.spread)} | ${s.trials > 1 ? (s.consistent ? "yes" : "NO") : "-"} | ${s.failing.join(", ") || "-"} |`
    );
  }
  const unstable = perScenario.filter((s) => s.trials > 1 && ((s.spread ?? 0) > 1.0 || !s.consistent));
  lines.push("", "## Variance", "");
  lines.push(unstable.length ? `Unstable repeated scenarios: ${unstable.map((s) => s.id).join(", ")}.` : "No repeated scenario exceeded a spread of 1.0 or changed its deterministic result.");
  lines.push("", "## Cost and latency", "");
  lines.push(`Director cost: $${directorCosts.reduce((a, b) => a + b, 0).toFixed(3)} total, $${fmt(mean(directorCosts), 3)} per trial.`);
  lines.push(`Judge cost: $${judgeCosts.reduce((a, b) => a + b, 0).toFixed(3)} total.`);
  lines.push(`Director latency: median ${fmt((percentile(directorTimes, 0.5) ?? 0) / 1000, 1)} s, p90 ${fmt((percentile(directorTimes, 0.9) ?? 0) / 1000, 1)} s, max ${fmt(Math.max(0, ...directorTimes) / 1000, 1)} s.`);
  lines.push(`Director denied reads: ${all.reduce((n, r) => n + r.director.deniedReads, 0)}.`);
  lines.push("", "## Flags", "");
  if (!flagged.length) lines.push("The judge flagged no trial.");
  for (const r of flagged) {
    const v = (r.judge as Extract<JudgeResult, { ok: true }>).verdict;
    if (v.fabricatedClaims.flag) lines.push(`- ${r.scenario}#${r.trial} fabricated claims: ${v.fabricatedClaims.evidence}`);
    if (v.ignoredConstraint.flag) lines.push(`- ${r.scenario}#${r.trial} ignored constraint: ${v.ignoredConstraint.evidence}`);
  }
  lines.push("", "## Worst five trials", "");
  for (const r of worst) {
    lines.push(`### ${r.scenario}#${r.trial} (${r.outcome}, judged ${fmt(r.judgedMean)})`, "");
    const failing = r.checks.filter((c) => !c.pass);
    lines.push(failing.length ? `Failing checks: ${failing.map((c) => `${c.name} (${c.detail})`).join("; ")}.` : "All deterministic checks passed.");
    if (r.judge?.ok) {
      lines.push(`Judge: ${r.judge.verdict.summary}`);
      for (const d of DIMENSIONS) {
        const s = r.judge.verdict.scores[d];
        if (s.score !== null && s.score <= 3) lines.push(`- ${DIMENSION_LABELS[d]} ${s.score}: ${s.why}`);
      }
    } else if (r.judge) lines.push(`Judge failed: ${r.judge.error}.`);
    lines.push("");
  }
  lines.push("## Human spot-check", "", "Record agreement per RUBRIC.md here: trial, dimension, agree / higher / lower, one sentence.", "");
  return lines.join("\n");
}
