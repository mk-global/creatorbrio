import type { ChatResult, ServerCosts } from "./app";
import type { BaselineResult } from "./baseline";
import { MIN_READ_TURNS, OUTCOME_DIMENSIONS, type Arm, type JudgeCall, type OutcomeVerdict, type PairwiseVerdict } from "./judge";
import type { ScenarioId } from "./scenarios";

/** The recorded evidence of one harness run, and its Markdown summary. */

export const STAGE_KEYS = ["reading-sources", "planning", "preparing-images", "designing"] as const;
export type StageDurations = Partial<Record<(typeof STAGE_KEYS)[number], number>>;

export interface Check {
  name: string;
  pass: boolean;
  evidence: string;
}

export interface ChatRecord {
  label: string;
  message: string;
  retryRunId?: string;
  sessionId?: string | null;
  result: ChatResult;
  stages: StageDurations;
}

export interface ScenarioRecord {
  id: ScenarioId;
  title: string;
  kind: string;
  server: { port: number; mode: string; readyMs: number };
  carouselId: string | null;
  chats: ChatRecord[];
  outcome: string;
  blocked: { code: string; message: string; retryRunId: string | null } | null;
  deviations: string[];
  slides: number | null;
  generatedThisRun: number | null;
  runRecord: Record<string, unknown> | null;
  costs: Omit<ServerCosts, "entries"> | null;
  logEntries: number;
  export: { ok: boolean; pngs: number; error?: string; durationMs: number } | null;
  judge: JudgeCall<OutcomeVerdict> | null;
  checks: Check[];
  observations: string[];
  wallMs: number;
  harnessError: string | null;
}

export interface ComparisonRecord {
  id: ScenarioId;
  baselineCarouselId: string | null;
  baseline: BaselineResult | null;
  baselineExport: { ok: boolean; pngs: number; error?: string } | null;
  baselineJudge: JudgeCall<OutcomeVerdict> | null;
  pairwise: { mapping: { A: Arm; B: Arm }; winner: Arm | "tie" | null; result: JudgeCall<PairwiseVerdict> } | null;
  /** Why no comparison was made when that is a legitimate outcome, such as a blocked Director arm. */
  skipped: string | null;
  harnessError: string | null;
}

export interface RunResults {
  startedAt: string;
  mode: string;
  commit: string;
  scenarios: ScenarioRecord[];
  comparisons: ComparisonRecord[];
  wallMs: number;
}

export function stageDurations(result: ChatResult): StageDurations {
  const out: StageDurations = {};
  let current: { stage: (typeof STAGE_KEYS)[number]; at: number } | null = null;
  const close = (at: number) => {
    if (current) out[current.stage] = (out[current.stage] ?? 0) + (at - current.at);
    current = null;
  };
  for (const { at, event } of result.events) {
    if (event.type === "stage") {
      if (current && (current as { stage: string }).stage === event.stage) continue; // progress detail
      close(at);
      current = { stage: event.stage, at };
    } else if (event.type === "blocked" || event.type === "done" || event.type === "error") {
      close(at);
    }
  }
  close(result.durationMs);
  return out;
}

const s = (ms: number | null | undefined) => (typeof ms === "number" ? (ms / 1000).toFixed(1) : "-");
const usd = (v: number | null | undefined) => (typeof v === "number" ? `$${v.toFixed(3)}` : "-");
/** The judge's turn count, marked when it is too low to have read any slide. */
const turnsCell = (turns: number | null) => (turns === null ? "-" : turns < MIN_READ_TURNS ? `${turns} (read unverified)` : String(turns));
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function meanScore(verdict: { scores: Record<string, { score: number | null }> } | Record<string, { score: number | null }>): number | null {
  const scores = ("scores" in verdict ? verdict.scores : verdict) as Record<string, { score: number | null }>;
  const values = OUTCOME_DIMENSIONS.map((d) => scores[d]?.score).filter((v): v is number => typeof v === "number");
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function totals(results: RunResults) {
  const add = (v: number | null | undefined) => (typeof v === "number" ? v : 0);
  let director = 0;
  let design = 0;
  let judges = 0;
  let baseline = 0;
  for (const r of results.scenarios) {
    director += add(r.costs?.directorCostUsd);
    design += add(r.costs?.designCostUsd);
    judges += add(r.judge?.costUsd);
  }
  for (const c of results.comparisons) {
    baseline += add(c.baseline?.costUsd);
    judges += add(c.baselineJudge?.costUsd) + add(c.pairwise?.result.costUsd);
  }
  return { director, design, baseline, judges, all: director + design + baseline + judges };
}

export function renderSummary(results: RunResults): string {
  const lines: string[] = [];
  const t = totals(results);
  lines.push(`# Creative run acceptance results`);
  lines.push("");
  lines.push(`Run started ${results.startedAt} against commit \`${results.commit}\` in ${results.mode} mode.`);
  lines.push(`Wall time ${s(results.wallMs)} s; model spend ${usd(t.all)} (Director ${usd(t.director)}, design ${usd(t.design)}, Design-Agent-only baseline ${usd(t.baseline)}, judges ${usd(t.judges)}).`);
  lines.push(`Costs come from the server log and the CLI result events; image generation is local and has no API cost.`);
  lines.push("");

  lines.push(`## Runs, stage timings and costs`);
  lines.push("");
  lines.push(`| Scenario | Outcome | Slides | Generated | Wall s | Sources s | Planning s | Images s | Design s | Director | Design | Judge |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of results.scenarios) {
    const stages = r.chats.reduce<StageDurations>((acc, c) => {
      for (const [k, v] of Object.entries(c.stages)) acc[k as keyof StageDurations] = (acc[k as keyof StageDurations] ?? 0) + (v ?? 0);
      return acc;
    }, {});
    lines.push(
      `| ${r.id} ${cell(r.title)} | ${cell(r.outcome)} | ${r.slides ?? "-"} | ${r.generatedThisRun ?? "-"} | ${s(r.wallMs)} | ${s(stages["reading-sources"])} | ${s(stages.planning)} | ${s(stages["preparing-images"])} | ${s(stages.designing)} | ${usd(r.costs?.directorCostUsd)} | ${usd(r.costs?.designCostUsd)} | ${usd(r.judge?.costUsd)} |`
    );
  }
  lines.push("");

  lines.push(`## Acceptance checks`);
  lines.push("");
  lines.push(`| Scenario | Check | Result | Evidence |`);
  lines.push(`|---|---|---|---|`);
  for (const r of results.scenarios) {
    if (r.harnessError) lines.push(`| ${r.id} | harness | ERROR | ${cell(r.harnessError)} |`);
    for (const c of r.checks) lines.push(`| ${r.id} | ${cell(c.name)} | ${c.pass ? "pass" : "FAIL"} | ${cell(c.evidence)} |`);
  }
  const observations = results.scenarios.flatMap((r) => r.observations.map((o) => `- ${r.id}: ${o}`));
  if (observations.length) {
    lines.push("");
    lines.push(`Observations:`);
    lines.push("");
    lines.push(...observations);
  }
  lines.push("");

  lines.push(`## Creative outcome scores (judge, 1 to 5)`);
  lines.push("");
  lines.push(`| Scenario | ${OUTCOME_DIMENSIONS.join(" | ")} | Mean | Judge turns | Flags |`);
  lines.push(`|---|${OUTCOME_DIMENSIONS.map(() => "---").join("|")}|---|---|---|`);
  const scoreRow = (label: string, judge: JudgeCall<OutcomeVerdict> | null) => {
    if (!judge) return;
    if (!judge.ok) {
      lines.push(`| ${label} | judge failed: ${cell(judge.error)} |${OUTCOME_DIMENSIONS.map(() => "").join("|")}| ${turnsCell(judge.turns)} | |`);
      return;
    }
    const v = judge.verdict;
    const flags = Object.entries(v.flags)
      .filter(([, f]) => f.flag)
      .map(([k, f]) => `${k}: ${f.evidence}`)
      .join("; ");
    const mean = meanScore(v);
    lines.push(`| ${label} | ${OUTCOME_DIMENSIONS.map((d) => v.scores[d].score ?? "n/a").join(" | ")} | ${mean === null ? "-" : mean.toFixed(2)} | ${turnsCell(judge.turns)} | ${cell(flags || "none")} |`);
  };
  for (const r of results.scenarios) scoreRow(`${r.id} with Director`, r.judge);
  for (const c of results.comparisons) scoreRow(`${c.id} Design Agent only`, c.baselineJudge);
  lines.push("");
  for (const r of results.scenarios) {
    if (!r.judge?.ok) continue;
    lines.push(`${r.id} judge summary:`);
    lines.push("");
    // One sentence per line, as the repository's Markdown convention asks.
    for (const sentence of r.judge.verdict.summary.split(/(?<=[.!?])\s+/)) if (sentence.trim()) lines.push(sentence.trim());
    lines.push("");
  }

  if (results.comparisons.length) {
    lines.push(`## With and without the Director (blind pairwise judge)`);
    lines.push("");
    lines.push(`| Scenario | Labels (un-blinded) | Preferred | Confidence | Director mean | Baseline mean | Baseline slides | Baseline cost | Judge turns | Reasons |`);
    lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
    for (const c of results.comparisons) {
      if (c.skipped) {
        lines.push(`| ${c.id} | - | SKIPPED | - | - | - | - | - | - | ${cell(c.skipped)} |`);
        continue;
      }
      if (c.harnessError) {
        lines.push(`| ${c.id} | - | ERROR | - | - | - | - | - | - | ${cell(c.harnessError)} |`);
        continue;
      }
      const p = c.pairwise;
      if (!p) continue;
      if (!p.result.ok) {
        lines.push(`| ${c.id} | A=${p.mapping.A}, B=${p.mapping.B} | judge failed | - | - | - | ${c.baselineExport?.pngs ?? "-"} | ${usd(c.baseline?.costUsd)} | ${turnsCell(p.result.turns)} | ${cell(p.result.error)} |`);
        continue;
      }
      const v = p.result.verdict;
      const scoresOf = (arm: Arm) => (p.mapping.A === arm ? v.setA : v.setB);
      const dm = meanScore(scoresOf("director"));
      const bm = meanScore(scoresOf("baseline"));
      lines.push(
        `| ${c.id} | A=${p.mapping.A}, B=${p.mapping.B} | ${p.winner} | ${v.confidence} | ${dm?.toFixed(2) ?? "-"} | ${bm?.toFixed(2) ?? "-"} | ${c.baselineExport?.pngs ?? "-"} | ${usd(c.baseline?.costUsd)} | ${turnsCell(p.result.turns)} | ${cell(v.reasons.join(" "))} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
