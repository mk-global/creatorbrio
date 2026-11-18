import { OUTCOME_DIMENSIONS, OUTCOME_LABELS, type JudgeCall, type OutcomeScores } from "./judge";
import type { ComparisonRecord, RunResults, ScenarioRecord } from "./report";
import { groupBy, spread, type Spread } from "./stats";
import { totalTokens, USAGE_KEYS, type TokenUsage } from "./usage";

/**
 * The baseline sections of summary.md (#224): the plan and its spend, model
 * token usage per run, the revision judge, per-scenario statistics over the
 * repetitions, and the environment a comparable run must match.
 */

type Format = "score" | "seconds" | "tokens" | "usd";

export interface MetricRow {
  scenario: string;
  metric: string;
  format: Format;
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

const verdict = <T>(j: JudgeCall<T> | null | undefined): T | null => (j?.ok ? j.verdict : null);

const USAGE_LABELS: Record<(typeof USAGE_KEYS)[number] | "total", string> = {
  inputTokens: "input tokens",
  outputTokens: "output tokens",
  cacheReadTokens: "cache read tokens",
  cacheCreationTokens: "cache write tokens",
  total: "total tokens",
};

/** Per-scenario statistics over every repetition, Director arm first, then the Design-Agent-only arm. */
export function scenarioStatistics(results: Pick<RunResults, "scenarios" | "comparisons">): MetricRow[] {
  const rows: MetricRow[] = [];
  const push = (scenario: string, metric: string, format: Format, values: (number | null | undefined)[]) => {
    const stats = spread(values);
    if (stats.n > 0) rows.push({ scenario, metric, format, stats });
  };
  for (const [id, runs] of groupBy<ScenarioRecord>(results.scenarios, (r) => r.id)) {
    const outcome = runs.map((r) => verdict(r.judge));
    const revision = runs.map((r) => verdict(r.revisionJudge));
    push(id, "Judge mean (1 to 5)", "score", outcome.map((v) => meanOf(v?.scores)));
    for (const d of OUTCOME_DIMENSIONS) push(id, OUTCOME_LABELS[d], "score", outcome.map((v) => v?.scores[d]?.score));
    push(id, "Revision: brief kept", "score", revision.map((v) => v?.briefKept.score));
    push(id, "Revision: change made", "score", revision.map((v) => v?.requestedChangeMade.score));
    const completed = runs.filter((r) => r.outcome === "completed");
    push(id, "Wall time s (completed runs)", "seconds", completed.map((r) => sec(r.wallMs)));
    push(id, "Director time s", "seconds", runs.map((r) => sec(r.costs?.directorMs)));
    push(id, "Design time s", "seconds", runs.map((r) => sec(r.costs?.designMs)));
    for (const key of [...USAGE_KEYS, "total"] as const) push(id, `Design ${USAGE_LABELS[key]}`, "tokens", runs.map((r) => usageOf(r.costs?.designUsage, key)));
    push(id, "Director cost", "usd", runs.map((r) => r.costs?.directorCostUsd));
    push(id, "Design cost", "usd", runs.map((r) => r.costs?.designCostUsd));
    push(id, "Judge cost", "usd", runs.map((r) => add(r.judge?.costUsd, r.revisionJudge?.costUsd)));
    push(id, "Run cost (Director, design, judges)", "usd", runs.map((r) => add(r.costs?.directorCostUsd, r.costs?.designCostUsd, r.judge?.costUsd, r.revisionJudge?.costUsd)));
  }
  for (const [id, runs] of groupBy<ComparisonRecord>(results.comparisons, (c) => c.id)) {
    const label = `${id} Design Agent only`;
    push(label, "Judge mean (1 to 5)", "score", runs.map((c) => meanOf(verdict(c.baselineJudge)?.scores)));
    push(label, "Design time s", "seconds", runs.map((c) => sec(c.baseline?.durationMs)));
    for (const key of [...USAGE_KEYS, "total"] as const) push(label, `Design ${USAGE_LABELS[key]}`, "tokens", runs.map((c) => usageOf(c.baseline?.usage, key)));
    push(label, "Design cost", "usd", runs.map((c) => c.baseline?.costUsd));
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
    lines.push(`Per-call caps: Director ${money(plan.caps.directorUsd)}, Design Agent ${money(plan.caps.designUsd)}, judge ${money(plan.caps.judgeUsd)}; worst case ${money(plan.worstCaseUsd)}.`);
  }
  const spend = results.spend;
  if (spend) {
    lines.push(`Ledger \`${spend.ledger}\`: ${money(spend.preflight.spentUsd)} counted before this run, ${money(spend.preflight.remainingUsd)} of ${money(spend.preflight.capUsd)} remaining.`);
    lines.push(spend.spend ? `Recorded spend for this run: ${money(spend.spend.costUsd)} (${cell(spend.spend.note)}).` : `No spend entry recorded yet${spend.error ? `: ${cell(spend.error)}` : ""}.`);
  }
  if (results.brand) lines.push(`Every carousel uses the synthetic brand "${cell(results.brand.name)}", created through the public API.`);
  lines.push("");

  lines.push(`## Model token usage per run`);
  lines.push("");
  lines.push(`From the server's "run finished" lines (Design Agent) and the CLI's result events (Design Agent only). The Director's token counts are not in the server's records; its cost and turns are. Streamed chunks count the stream's text events, not tokens.`);
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

  const stats = scenarioStatistics(results);
  if (stats.length) {
    lines.push(`## Per-scenario statistics over repetitions`);
    lines.push("");
    lines.push(`n is the number of runs with a value; the spread is the minimum and maximum.`);
    lines.push("");
    lines.push(`| Scenario | Metric | n | Median | Min | Max |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const row of stats) {
      lines.push(`| ${row.scenario} | ${row.metric} | ${row.stats.n} | ${fmt(row.stats.median, row.format)} | ${fmt(row.stats.min, row.format)} | ${fmt(row.stats.max, row.format)} |`);
    }
    const pairs = groupBy<ComparisonRecord>(
      results.comparisons.filter((c) => c.pairwise?.winner),
      (c) => c.id
    );
    for (const [id, runs] of pairs) {
      const tally = (w: string) => runs.filter((c) => c.pairwise?.winner === w).length;
      lines.push("");
      lines.push(`${id} blind pairwise preference over ${runs.length} run(s): Director ${tally("director")}, Design Agent only ${tally("baseline")}, tie ${tally("tie")}.`);
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
    lines.push(`Configuration the Design Agent inherits (names, sizes and hashes only):`);
    lines.push("");
    lines.push(`| File | Exists | Size | SHA-256 |`);
    lines.push(`|---|---|---|---|`);
    for (const f of env.inheritedConfiguration) lines.push(`| \`${cell(f.label)}\` | ${f.exists ? "yes" : "no"} | ${f.size ?? "-"} | ${f.sha256 ? `\`${f.sha256.slice(0, 16)}\`` : "-"} |`);
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
