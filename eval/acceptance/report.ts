import type { ChatResult, ServerCosts } from "./app";
import type { BaselineResult } from "./baseline";
import type { Preflight, RunPlan, Settlement } from "./budget";
import { redactText, type EnvironmentRecord, type Redaction } from "./environment";
import { countNamesByClass, describeNameClasses } from "./harness-env";
import type { AdmissionResult, BusyObservation, HealthSample } from "./image-service";
import type { LedgerEntry } from "./ledger";
import type { PlannedAsset, PlanSummary, StagedSnapshot } from "./verify";
import { MIN_READ_TURNS, OUTCOME_DIMENSIONS, type Arm, type JudgeCall, type OutcomeVerdict, type PairwiseVerdict, type RevisionVerdict } from "./judge";
import { renderBaselineSections } from "./report-baseline";
import { settingsBannerLines } from "./settings-keys";
import { requestMs } from "./stats";
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
  /**
   * The run's stored plan, read when design began: the only time it exists,
   * and only for plans with generated images. Null when design never began.
   */
  planAtDesign: { assets: PlannedAsset[] | null; summary: PlanSummary | null } | null;
}

/**
 * What the image service reported around a scenario. Its reason codes are
 * kept here, in results.json, and never written to summary.md.
 */
export interface ImageServiceEvidence {
  /** The wait for admission before the scenario. */
  admission?: AdmissionResult;
  /** Health taken at once after an image failed. */
  afterFailure?: HealthSample[];
  /** The "image failed" log entries' key, code and refusal reason. */
  failureReasons?: { key: string | null; code: string | null; reason: string | null }[];
  /** Health polled after a cancellation, to see whether the service finished an image already started. */
  afterCancel?: BusyObservation;
  /** Health polled after the restart scenario stopped the server, for the same question. */
  afterServerStop?: BusyObservation;
  /** The wait for admission before an explicit retry. */
  retryAdmission?: AdmissionResult;
  /** The wait for the service to admit work again after the scenario. */
  cooldown?: AdmissionResult;
}

export interface ScenarioRecord {
  id: ScenarioId;
  /** Which repetition of the plan this is, from 1. */
  repetition: number;
  /** The pairing key, `<id>#<repetition>`: the same in every run of the same plan. */
  key: string;
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
  export: { ok: boolean; pngs: number; files?: string[]; error?: string; durationMs: number } | null;
  judge: JudgeCall<OutcomeVerdict> | null;
  /** For a revision: the judge's comparison of the set before with the set after. */
  revisionJudge: JudgeCall<RevisionVerdict> | null;
  /** The image service's health and refusal codes around this scenario; results.json only. */
  imageService: ImageServiceEvidence | null;
  /** For a completed run: the stored Creative Brief and the Director's plan, for the founder's review. */
  review: { creativeBrief: unknown; plan: PlanSummary | null; planNote: string | null; directorPlan: Record<string, unknown> | null } | null;
  /** The staged images a retry was expected to reuse, as recorded before it. */
  reuse: { snapshot: StagedSnapshot; attempted: boolean } | null;
  /** The restart scenario's state right after the server stopped. */
  afterStop: { signal: string; ended: unknown; tasks: { key: string; state: string; sha256: string | null }[]; staging: StagedSnapshot } | null;
  checks: Check[];
  observations: string[];
  /** Harness wall time for this run: everything the test did, including judging, export, waits and checks. Not request latency. */
  wallMs: number;
  harnessError: string | null;
  /**
   * The driver returned or failed. False while it runs and after a test
   * timeout, when what had started is unknown and settlement charges the
   * item's full worst case.
   */
  finished: boolean;
}

export interface ComparisonRecord {
  id: ScenarioId;
  repetition: number;
  key: string;
  baselineCarouselId: string | null;
  baseline: BaselineResult | null;
  baselineExport: { ok: boolean; pngs: number; error?: string } | null;
  baselineJudge: JudgeCall<OutcomeVerdict> | null;
  pairwise: { mapping: { A: Arm; B: Arm }; winner: Arm | "tie" | null; result: JudgeCall<PairwiseVerdict> } | null;
  /** Why no comparison was made when that is a legitimate outcome, such as a blocked Director arm. */
  skipped: string | null;
  /**
   * Why the Design-Agent-only arm's set was exported but not judged: the arm
   * did not complete (it timed out or stalled), so its set is not a finished
   * design and a pairwise judgment of it would compare a stop with a design.
   * Unlike `skipped`, the arm ran and is charged.
   */
  notJudged: string | null;
  harnessError: string | null;
  /** The comparison returned or failed; false while it runs and after a test timeout. */
  finished: boolean;
}

export interface SpendRecord {
  /** Redacted path of the ledger. */
  ledger: string;
  preflight: Preflight;
  /** The reservation appended before the run, and the spend entry appended after it. */
  reservation: LedgerEntry | null;
  spend: LedgerEntry | null;
  /** How the spend entry was worked out, per plan item: measured costs, and calls charged at their bound. */
  settlement: Settlement | null;
  error: string | null;
}

export interface RunResults {
  /** The run folder's name; the ledger and the archive use it too. */
  runId: string;
  startedAt: string;
  mode: string;
  commit: string;
  /** Which scenarios ran, in which order and how often; a paired run uses the same plan. */
  plan: RunPlan | null;
  spend: SpendRecord | null;
  /** The synthetic brand every carousel was created in. */
  brand: { id: string; name: string } | null;
  environment: EnvironmentRecord | null;
  /** The durable private copy, by redacted path. */
  archive: { dir: string; files: number; error: string | null } | null;
  scenarios: ScenarioRecord[];
  comparisons: ComparisonRecord[];
  /** Harness wall time for the whole run, not request latency. */
  wallMs: number;
}

/** results.json as written: pretty JSON with the home folder and the checkout replaced, so no path to either is stored. */
export function serializeResults(results: RunResults, redaction?: Redaction): string {
  return redactText(JSON.stringify(results, null, 2), redaction);
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
    judges += add(r.judge?.costUsd) + add(r.revisionJudge?.costUsd);
  }
  for (const c of results.comparisons) {
    baseline += add(c.baseline?.costUsd);
    judges += add(c.baselineJudge?.costUsd) + add(c.pairwise?.result.costUsd);
  }
  return { director, design, baseline, judges, all: director + design + baseline + judges };
}

/**
 * What makes a run's evidence not comparable or not fully verified, in words,
 * for the banner under summary.md's commit line: the pinned CLI or the `.env`
 * files changed during the run, a variable chose a model whose price the CLI's
 * table may lack, a session ran another CLI version or one cannot be shown, or
 * the Director's or judge's version is not shown by the pin. Nothing before
 * the environment is recorded, and an empty list when everything held.
 */
export function comparabilityFlags(env: EnvironmentRecord | null): string[] {
  if (!env) return [];
  const flags: string[] = [];
  if (env.cli.pin.changed) flags.push("the pinned CLI changed during the run");
  if (env.serverEnvFiles.changed) flags.push("the servers' .env files changed during the run");
  if (env.modelPricing.unverified) flags.push("a variable whose name contains MODEL reached the run, so a model it chose may not be in the CLI's price table");
  const sv = env.cli.sessions;
  if (!sv) flags.push("the CLI versions of the sessions were not recorded");
  else {
    if (sv.mismatch) flags.push("a session ran a CLI version other than the configured one");
    if (sv.unverified) flags.push("a session's CLI version is unknown or a run has no session id");
    if (!sv.director.proven) flags.push("the Director's CLI version is not shown by the pin");
    if (!sv.judge.proven) flags.push("the judge's CLI version is not shown by the pin");
  }
  return flags;
}

/**
 * The banner lines of what a reader of summary.md should see about the
 * environment, each on its own line under the commit line and none holding a
 * value or a name from the operator's machine: the counts, by class, of the
 * harness's own environment's variables that can point a call elsewhere,
 * change how its process starts or choose a model (a name can carry an
 * organization or machine detail, so none is printed), and the settings keys
 * that can change a model call or could not be read (the CLI's own key names
 * from a fixed list, and counts; the file names of managed drop-in files are
 * counted too). `results.json` holds the names.
 */
export function environmentBannerLines(env: EnvironmentRecord | null): string[] {
  if (!env) return [];
  const lines: string[] = [];
  const classes = countNamesByClass(env.harnessEnvironment.unreviewedNames);
  if (classes.endpointLike > 0 || classes.namesModel > 0) {
    lines.push(
      `**Of the ${classes.total} variable(s) of the harness's own environment that are not reviewed as harmless, ${describeNameClasses(classes)} (such a variable can point a call elsewhere, change how its process starts or choose a model); the names are in results.json only, never committed.**`
    );
  }
  for (const line of settingsBannerLines(env.settingsKeys)) lines.push(`**${line}**`);
  return lines;
}

export function renderSummary(results: RunResults, redaction?: Redaction): string {
  const lines: string[] = [];
  const t = totals(results);
  lines.push(`# Creative run acceptance results`);
  lines.push("");
  lines.push(`Run started ${results.startedAt} against commit \`${results.commit}\` in ${results.mode} mode.`);
  const flags = comparabilityFlags(results.environment);
  if (flags.length) lines.push(`**Not comparable or not fully verified:** ${flags.join("; ")}. The Environment section says which.`);
  lines.push(...environmentBannerLines(results.environment));
  lines.push(`Harness wall time ${s(results.wallMs)} s (everything the harness did, including judging, export and waits; request latency is reported separately).`);
  lines.push(`Measured model spend ${usd(t.all)} from calls that reported a cost (Director ${usd(t.director)}, design ${usd(t.design)}, Design-Agent-only baseline ${usd(t.baseline)}, judges ${usd(t.judges)}); a call that reported none is counted as 0 here and charged at its per-call limit in the ledger settlement below.`);
  lines.push(`Costs come from the server log and the CLI result events; image generation is local and has no API cost.`);
  lines.push("");
  lines.push(...renderBaselineSections(results));

  lines.push(`## Runs, stage timings and costs`);
  lines.push("");
  lines.push(`Request s is the sum of the chat requests' own durations; Harness wall s also includes judging, export, waits and checks.`);
  lines.push("");
  lines.push(`| Scenario | Outcome | Slides | Generated | Request s | Harness wall s | Sources s | Planning s | Images s | Design s | Director | Design | Judge |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of results.scenarios) {
    const label = `${r.key} ${r.title}`;
    const stages = r.chats.reduce<StageDurations>((acc, c) => {
      for (const [k, v] of Object.entries(c.stages)) acc[k as keyof StageDurations] = (acc[k as keyof StageDurations] ?? 0) + (v ?? 0);
      return acc;
    }, {});
    lines.push(
      `| ${cell(label)} | ${cell(r.outcome)} | ${r.slides ?? "-"} | ${r.generatedThisRun ?? "-"} | ${s(requestMs(r))} | ${s(r.wallMs)} | ${s(stages["reading-sources"])} | ${s(stages.planning)} | ${s(stages["preparing-images"])} | ${s(stages.designing)} | ${usd(r.costs?.directorCostUsd)} | ${usd(r.costs?.designCostUsd)} | ${usd(r.judge?.costUsd)} |`
    );
  }
  lines.push("");

  lines.push(`## Acceptance checks`);
  lines.push("");
  lines.push(`| Scenario | Check | Result | Evidence |`);
  lines.push(`|---|---|---|---|`);
  for (const r of results.scenarios) {
    if (r.harnessError) lines.push(`| ${r.key} | harness | ERROR | ${cell(r.harnessError)} |`);
    for (const c of r.checks) lines.push(`| ${r.key} | ${cell(c.name)} | ${c.pass ? "pass" : "FAIL"} | ${cell(c.evidence)} |`);
  }
  const observations = results.scenarios.flatMap((r) => r.observations.map((o) => `- ${r.key}: ${o}`));
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
  for (const r of results.scenarios) scoreRow(`${r.key} with Director`, r.judge);
  for (const c of results.comparisons) scoreRow(`${c.key} Design Agent only`, c.baselineJudge);
  lines.push("");
  for (const r of results.scenarios) {
    if (!r.judge?.ok) continue;
    lines.push(`${r.key} judge summary:`);
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
        lines.push(`| ${c.key} | - | SKIPPED | - | - | - | - | - | - | ${cell(c.skipped)} |`);
        continue;
      }
      if (c.harnessError) {
        lines.push(`| ${c.key} | - | ERROR | - | - | - | - | - | - | ${cell(c.harnessError)} |`);
        continue;
      }
      if (c.notJudged) {
        lines.push(`| ${c.key} | - | NOT JUDGED | - | - | - | ${c.baselineExport?.pngs ?? "-"} | ${usd(c.baseline?.costUsd)} | - | ${cell(c.notJudged)} |`);
        continue;
      }
      const p = c.pairwise;
      if (!p) continue;
      if (!p.result.ok) {
        lines.push(`| ${c.key} | A=${p.mapping.A}, B=${p.mapping.B} | judge failed | - | - | - | ${c.baselineExport?.pngs ?? "-"} | ${usd(c.baseline?.costUsd)} | ${turnsCell(p.result.turns)} | ${cell(p.result.error)} |`);
        continue;
      }
      const v = p.result.verdict;
      const scoresOf = (arm: Arm) => (p.mapping.A === arm ? v.setA : v.setB);
      const dm = meanScore(scoresOf("director"));
      const bm = meanScore(scoresOf("baseline"));
      lines.push(
        `| ${c.key} | A=${p.mapping.A}, B=${p.mapping.B} | ${p.winner} | ${v.confidence} | ${dm?.toFixed(2) ?? "-"} | ${bm?.toFixed(2) ?? "-"} | ${c.baselineExport?.pngs ?? "-"} | ${usd(c.baseline?.costUsd)} | ${turnsCell(p.result.turns)} | ${cell(v.reasons.join(" "))} |`
      );
    }
    lines.push("");
  }
  return redactText(lines.join("\n") + "\n", redaction);
}
