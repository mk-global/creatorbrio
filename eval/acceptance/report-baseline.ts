import { MIN_READ_TURNS, OUTCOME_DIMENSIONS, OUTCOME_LABELS, type JudgeCall, type OutcomeScores } from "./judge";
import type { ComparisonRecord, RunResults, ScenarioRecord } from "./report";
import { groupBy, requestMs, spread, type Spread } from "./stats";
import { totalTokens, USAGE_KEYS, type TokenUsage } from "./usage";

/**
 * The baseline sections of summary.md (#224): the plan and its spend, model
 * token usage per run, the revision judge, per-scenario completeness and
 * statistics over the repetitions, and the environment a comparable run must
 * match.
 */

type Format = "score" | "seconds" | "tokens" | "usd";

/** Which runs a metric is taken over: the completed ones only, or every run that has a value. */
export type RunsUsed = "completed" | "all";

export interface MetricRow {
  scenario: string;
  metric: string;
  format: Format;
  /** Which runs the metric uses; a latency or a score from a run that did not complete says little. */
  runs: RunsUsed;
  stats: Spread;
}

const add = (...v: (number | null | undefined)[]) => (v.some((x) => typeof x === "number") ? v.reduce<number>((a, x) => a + (x ?? 0), 0) : null);
const sec = (ms: number | null | undefined) => (typeof ms === "number" ? ms / 1000 : null);
const usageOf = (u: TokenUsage | null | undefined, key: (typeof USAGE_KEYS)[number] | "total") => (u ? (key === "total" ? totalTokens(u) : u[key]) : null);

function meanOf(scores: OutcomeScores | null | undefined): number | null {
  if (!scores) return null;
  const v = OUTCOME_DIMENSIONS.map((d) => scores[d]?.score).filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * A judge verdict counts only when the judge made enough turns to have opened
 * the slides (the summary marks the others "read unverified"); a verdict whose
 * turn count is missing cannot be shown to have read them either. Anything
 * else is left out of every median and tally, and counted as excluded.
 */
export const isTrusted = <T>(j: JudgeCall<T> | null | undefined): boolean => !!j?.ok && typeof j.turns === "number" && j.turns >= MIN_READ_TURNS;
const verdict = <T>(j: JudgeCall<T> | null | undefined): T | null => (j?.ok && isTrusted(j) ? j.verdict : null);

export interface ExcludedVerdicts {
  scenario: string;
  /** Verdicts returned, of those, how many were left out as unverified. */
  returned: number;
  excluded: number;
}

/** Per scenario and arm, how many judge verdicts were left out of the statistics because the judge did not verifiably read the slides. */
export function excludedVerdicts(results: Pick<RunResults, "scenarios" | "comparisons">): ExcludedVerdicts[] {
  const out: ExcludedVerdicts[] = [];
  const tally = (scenario: string, judges: (JudgeCall<unknown> | null | undefined)[]) => {
    const returned = judges.filter((j) => j?.ok);
    const excluded = returned.filter((j) => !isTrusted(j)).length;
    if (excluded > 0) out.push({ scenario, returned: returned.length, excluded });
  };
  for (const [id, runs] of groupBy<ScenarioRecord>(results.scenarios, (r) => r.id)) tally(id, runs.flatMap((r) => [r.judge, r.revisionJudge]));
  for (const [id, runs] of groupBy<ComparisonRecord>(results.comparisons, (c) => c.id)) tally(`${id} Design Agent only`, runs.flatMap((c) => [c.baselineJudge, c.pairwise?.result]));
  return out;
}

export interface CompletenessRow {
  scenario: string;
  runs: number;
  completed: number;
  checksPassed: number;
  checksTotal: number;
  harnessErrors: number;
}

/** Per scenario: the runs that completed out of those made, and the checks passed out of those run. */
export function completeness(results: Pick<RunResults, "scenarios" | "comparisons">): CompletenessRow[] {
  const rows: CompletenessRow[] = [];
  for (const [id, runs] of groupBy<ScenarioRecord>(results.scenarios, (r) => r.id)) {
    const checks = runs.flatMap((r) => r.checks);
    rows.push({
      scenario: id,
      runs: runs.length,
      completed: runs.filter((r) => r.outcome === "completed").length,
      checksPassed: checks.filter((c) => c.pass).length,
      checksTotal: checks.length,
      harnessErrors: runs.filter((r) => r.harnessError).length,
    });
  }
  for (const [id, runs] of groupBy<ComparisonRecord>(results.comparisons.filter((c) => !c.skipped), (c) => c.id)) {
    rows.push({
      scenario: `${id} Design Agent only`,
      runs: runs.length,
      completed: runs.filter((c) => c.baseline?.ok).length,
      checksPassed: 0,
      checksTotal: 0,
      harnessErrors: runs.filter((c) => c.harnessError).length,
    });
  }
  return rows;
}

const USAGE_LABELS: Record<(typeof USAGE_KEYS)[number] | "total", string> = {
  inputTokens: "input tokens",
  outputTokens: "output tokens",
  cacheReadTokens: "cache read tokens",
  cacheCreationTokens: "cache write tokens",
  total: "total tokens",
};

/**
 * Per-scenario statistics over every repetition, Director arm first, then the
 * Design-Agent-only arm. Each row says which runs it uses: scores come from
 * judged completed runs with a verified read, latencies from completed runs
 * (a run that stopped early says nothing about how long a design takes), and
 * tokens and costs from every run that has them, since a failed run still
 * spends.
 */
export function scenarioStatistics(results: Pick<RunResults, "scenarios" | "comparisons">): MetricRow[] {
  const rows: MetricRow[] = [];
  const push = (scenario: string, metric: string, format: Format, used: RunsUsed, values: (number | null | undefined)[]) => {
    const stats = spread(values);
    if (stats.n > 0) rows.push({ scenario, metric, format, runs: used, stats });
  };
  const stageSum = (r: ScenarioRecord, stage: "planning" | "preparing-images" | "designing") => {
    const parts = r.chats.map((c) => c.stages[stage]).filter((v): v is number => typeof v === "number");
    return parts.length ? sec(parts.reduce((a, b) => a + b, 0)) : null;
  };
  for (const [id, runs] of groupBy<ScenarioRecord>(results.scenarios, (r) => r.id)) {
    const outcome = runs.map((r) => verdict(r.judge));
    const revision = runs.map((r) => verdict(r.revisionJudge));
    push(id, "Judge mean (1 to 5)", "score", "completed", outcome.map((v) => meanOf(v?.scores)));
    for (const d of OUTCOME_DIMENSIONS) push(id, OUTCOME_LABELS[d], "score", "completed", outcome.map((v) => v?.scores[d]?.score));
    push(id, "Revision: brief kept", "score", "completed", revision.map((v) => v?.briefKept.score));
    push(id, "Revision: change made", "score", "completed", revision.map((v) => v?.requestedChangeMade.score));
    const completed = runs.filter((r) => r.outcome === "completed");
    // Request latency: the sum of the chat requests' own durations, which is what a user waits; the stages and the server's own timings break it down.
    push(id, "Request latency s (sum of chat requests)", "seconds", "completed", completed.map((r) => sec(requestMs(r))));
    push(id, "Planning stage s", "seconds", "completed", completed.map((r) => stageSum(r, "planning")));
    push(id, "Images stage s", "seconds", "completed", completed.map((r) => stageSum(r, "preparing-images")));
    push(id, "Design stage s", "seconds", "completed", completed.map((r) => stageSum(r, "designing")));
    push(id, "Harness wall time s (includes judging, export, waits, checks)", "seconds", "completed", completed.map((r) => sec(r.wallMs)));
    push(id, "Director time s (server log)", "seconds", "all", runs.map((r) => sec(r.costs?.directorMs)));
    push(id, "Design time s (server log)", "seconds", "all", runs.map((r) => sec(r.costs?.designMs)));
    for (const key of [...USAGE_KEYS, "total"] as const) push(id, `Design ${USAGE_LABELS[key]}`, "tokens", "all", runs.map((r) => usageOf(r.costs?.designUsage, key)));
    push(id, "Director cost", "usd", "all", runs.map((r) => r.costs?.directorCostUsd));
    push(id, "Design cost", "usd", "all", runs.map((r) => r.costs?.designCostUsd));
    push(id, "Judge cost", "usd", "all", runs.map((r) => add(r.judge?.costUsd, r.revisionJudge?.costUsd)));
    push(id, "Run cost (Director, design, judges)", "usd", "all", runs.map((r) => add(r.costs?.directorCostUsd, r.costs?.designCostUsd, r.judge?.costUsd, r.revisionJudge?.costUsd)));
  }
  for (const [id, runs] of groupBy<ComparisonRecord>(results.comparisons, (c) => c.id)) {
    const label = `${id} Design Agent only`;
    const done = runs.filter((c) => c.baseline?.ok);
    push(label, "Judge mean (1 to 5)", "score", "completed", runs.map((c) => meanOf(verdict(c.baselineJudge)?.scores)));
    push(label, "Request latency s (the Design Agent's run)", "seconds", "completed", done.map((c) => sec(c.baseline?.durationMs)));
    for (const key of [...USAGE_KEYS, "total"] as const) push(label, `Design ${USAGE_LABELS[key]}`, "tokens", "all", runs.map((c) => usageOf(c.baseline?.usage, key)));
    push(label, "Design cost", "usd", "all", runs.map((c) => c.baseline?.costUsd));
  }
  return rows;
}

function fmt(v: number | null, f: Format): string {
  if (v === null) return "-";
  if (f === "score") return v.toFixed(2);
  if (f === "seconds") return v.toFixed(1);
  if (f === "usd") return `$${v.toFixed(3)}`;
  return String(Math.round(v));
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const money = (v: number | null | undefined) => (typeof v === "number" ? `$${v.toFixed(2)}` : "-");
const count = (v: number | null | undefined) => (typeof v === "number" ? String(v) : "-");

export function renderBaselineSections(results: RunResults): string[] {
  const lines: string[] = [];
  const plan = results.plan;
  lines.push(`## Plan, pairing and spend`);
  lines.push("");
  if (plan) {
    lines.push(`Scenarios ${plan.scenarioIds.join(", ")}, ${plan.repeat} repetition(s) each, comparison ${plan.compare ? "on" : "off"}.`);
    lines.push(`Runs are paired by key (scenario and repetition) in this order: ${plan.items.map((i) => i.key).join(", ")}.`);
    lines.push(
      `Per-call caps: Director ${money(plan.caps.directorUsd)}, Design Agent ${money(plan.caps.designUsd)}, judge ${money(plan.caps.judgeUsd)}, each with an overshoot allowance of ${Math.round(plan.caps.overshootFraction * 100)}% of the cap; worst case ${money(plan.worstCaseUsd)}.`
    );
  }
  const spend = results.spend;
  if (spend) {
    const hold = spend.preflight.holdBackUsd > 0 ? `, ${money(spend.preflight.holdBackUsd)} of it held back for the post-containment rerun` : "";
    lines.push(`Ledger \`${spend.ledger}\`: ${money(spend.preflight.spentUsd)} counted before this run, ${money(spend.preflight.remainingUsd)} of ${money(spend.preflight.capUsd)} remaining${hold}.`);
    lines.push(spend.spend ? `Charged to the ledger for this run: ${money(spend.spend.costUsd)} (${cell(spend.spend.note)}).` : `No spend entry recorded yet${spend.error ? `: ${cell(spend.error)}` : ""}.`);
    if (spend.spend && spend.error) lines.push(`Problems while finishing the run: ${cell(spend.error)}.`);
    const incomplete = spend.settlement?.items.filter((i) => i.atBoundCalls > 0) ?? [];
    if (incomplete.length) {
      lines.push(`Incomplete measurement: ${spend.settlement!.atBoundCalls} call(s) had no measured cost and were charged at their per-call limit.`);
      for (const i of incomplete) lines.push(`- ${i.key}: ${cell(i.reasons.join("; "))}`);
    }
    const over = spend.settlement?.items.filter((i) => i.overLimitCalls > 0) ?? [];
    if (over.length) lines.push(`${spend.settlement!.overLimitCalls} call(s) were measured above their per-call limit (${over.map((i) => i.key).join(", ")}): the overshoot allowance is an assumption and was too small for them.`);
    if (spend.settlement?.beyondPlanCalls) lines.push(`${spend.settlement.beyondPlanCalls} call(s) ran beyond the plan and were charged.`);
  }
  if (results.brand) lines.push(`Every carousel uses the synthetic brand "${cell(results.brand.name)}", created through the public API.`);
  lines.push("");

  lines.push(`## Model token usage per run`);
  lines.push("");
  lines.push(`From the server's "run finished" lines (Design Agent) and the CLI's result events (Design Agent only). The Director's token counts and model are not in the server's records, and recording them needs a product logging change that is out of scope here; its cost and turns are. Streamed chunks count the stream's text events, not tokens.`);
  lines.push("");
  lines.push(`| Run | Input | Output | Cache read | Cache write | Total | Design turns | Director turns | Director tokens | Streamed chunks |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of results.scenarios) {
    const u = r.costs?.designUsage ?? null;
    const chunks = r.chats.reduce((a, c) => a + c.result.tokens.count, 0);
    const missing = r.costs?.designRunsWithoutUsage ? ` (${r.costs.designRunsWithoutUsage} run(s) without usage)` : "";
    lines.push(
      `| ${r.key} with Director | ${count(u?.inputTokens)} | ${count(u?.outputTokens)} | ${count(u?.cacheReadTokens)} | ${count(u?.cacheCreationTokens)} | ${u ? totalTokens(u) : "-"}${missing} | ${count(r.costs?.designTurns)} | ${count(r.costs?.directorTurns)} | not recorded | ${r.chats.length ? chunks : "-"} |`
    );
  }
  for (const c of results.comparisons) {
    const u = c.baseline?.usage ?? null;
    if (!c.baseline) continue;
    lines.push(`| ${c.key} Design Agent only | ${count(u?.inputTokens)} | ${count(u?.outputTokens)} | ${count(u?.cacheReadTokens)} | ${count(u?.cacheCreationTokens)} | ${u ? totalTokens(u) : "-"} | ${count(c.baseline.turns)} | - | - | - |`);
  }
  lines.push("");

  const revisions = results.scenarios.filter((r) => r.revisionJudge);
  if (revisions.length) {
    lines.push(`## Revision judge (before and after, 1 to 5)`);
    lines.push("");
    lines.push(`| Run | Brief kept | Change made | Unrequested changes | Summary |`);
    lines.push(`|---|---|---|---|---|`);
    for (const r of revisions) {
      const j = r.revisionJudge!;
      if (!j.ok) {
        lines.push(`| ${r.key} | judge failed: ${cell(j.error)} | | | |`);
        continue;
      }
      const v = j.verdict;
      lines.push(
        `| ${r.key} | ${v.briefKept.score ?? "n/a"} | ${v.requestedChangeMade.score ?? "n/a"} | ${v.unrequestedChanges.flag ? `yes: ${cell(v.unrequestedChanges.evidence)}` : "none"} | ${cell(v.summary)} |`
      );
    }
    lines.push("");
  }

  const done = completeness(results);
  if (done.length) {
    lines.push(`## Completeness per scenario`);
    lines.push("");
    lines.push(`| Scenario | Runs completed | Checks passed | Harness errors |`);
    lines.push(`|---|---|---|---|`);
    for (const d of done) {
      lines.push(`| ${d.scenario} | ${d.completed} of ${d.runs} | ${d.checksTotal ? `${d.checksPassed} of ${d.checksTotal}` : "-"} | ${d.harnessErrors} |`);
    }
    lines.push("");
  }

  const stats = scenarioStatistics(results);
  if (stats.length) {
    lines.push(`## Per-scenario statistics over repetitions`);
    lines.push("");
    lines.push(`n is the number of runs with a value; the spread is the minimum and maximum.`);
    lines.push(`Runs says which runs a metric uses: completed (a score or latency from a run that did not complete says little) or all (tokens and costs count every run, since a failed run still spends).`);
    lines.push("");
    lines.push(`| Scenario | Metric | Runs | n | Median | Min | Max |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const row of stats) {
      lines.push(`| ${row.scenario} | ${row.metric} | ${row.runs} | ${row.stats.n} | ${fmt(row.stats.median, row.format)} | ${fmt(row.stats.min, row.format)} | ${fmt(row.stats.max, row.format)} |`);
    }
    for (const x of excludedVerdicts(results)) {
      lines.push("");
      lines.push(`${x.scenario}: ${x.excluded} of ${x.returned} judge verdict(s) left out of these statistics, because the judge made fewer than ${MIN_READ_TURNS} turns and so did not verifiably read the slides.`);
    }
    const pairs = groupBy<ComparisonRecord>(
      results.comparisons.filter((c) => verdict(c.pairwise?.result) && c.pairwise?.winner),
      (c) => c.id
    );
    for (const [id, runs] of pairs) {
      const tally = (w: string) => runs.filter((c) => c.pairwise?.winner === w).length;
      lines.push("");
      lines.push(`${id} blind pairwise preference over ${runs.length} verified run(s): Director ${tally("director")}, Design Agent only ${tally("baseline")}, tie ${tally("tie")}.`);
    }
    lines.push("");
  }

  const env = results.environment;
  if (env) {
    lines.push(`## Environment`);
    lines.push("");
    lines.push(`Commit \`${env.commit}\`${env.commitDirty ? " with uncommitted tracked changes" : ""}; Node ${env.node} on ${env.platform}.`);
    lines.push(`CLI used by the servers: ${env.cli.server.version ?? "unknown"}; by the harness (judges, Design Agent only): ${env.cli.harness.version ?? "unknown"}.`);
    lines.push(`Models: Design Agent ${env.models.designAgent.models.join(", ") || "none seen"} (${cell(env.models.designAgent.source)}); Director ${env.models.director.models.join(", ") || "none seen"} (${cell(env.models.director.source)}); Design Agent only ${env.models.designAgentOnly.join(", ") || "none seen"}; judge ${env.models.judge.join(", ") || "none seen"}.`);
    lines.push("");
    const cfg = env.inheritedConfiguration;
    lines.push(`Configuration the Design Agent inherits: ${cfg.count} item(s) fingerprinted, combined SHA-256 \`${cfg.sha256}\`.`);
    lines.push(`Two runs are comparable only when this hash matches; the per-file, per-tree, MCP server name and environment table is in results.json (names and hashes only, never contents).`);
    for (const t of cfg.trees.filter((x) => x.truncated)) lines.push(`Note: \`${cell(t.label)}\` was only partly fingerprinted (file limit reached).`);
    for (const limitation of cfg.limitations) lines.push(`Limitation: ${cell(limitation)}`);
    lines.push("");
    lines.push(`Harness files: ${env.harnessFiles.map((h) => `\`${h.file}\` ${h.sha256.slice(0, 12)}`).join(", ")}.`);
    lines.push("");
  }
  if (results.archive) {
    lines.push(results.archive.error ? `Archive copy failed: ${cell(results.archive.error)}.` : `Archived ${results.archive.files} file(s) to \`${results.archive.dir}\`.`);
    lines.push("");
  }
  return lines;
}
