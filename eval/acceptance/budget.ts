import { parseSpendingCap } from "@/lib/spending-cap";
import { JUDGE_BUDGET_USD } from "./judge";
import { ledgerTotals, type LedgerEntry } from "./ledger";
import type { Scenario, ScenarioId } from "./scenarios";

/**
 * The paid-run preflight (#224): which scenarios run, in which order and how
 * often, the most every model call in that plan could cost under the
 * explicit per-call caps, and whether that fits what remains of the M1 cap.
 *
 * Worst case = Σ over planned items of
 *   Director calls × DIRECTOR_MAX_BUDGET_USD
 *   + Design Agent calls × DESIGN_AGENT_MAX_BUDGET_USD
 *   + judge calls × JUDGE_BUDGET_USD,
 * where an item is one scenario in one repetition, plus its comparison arm
 * (one Design Agent call and two judge calls) when EVAL_COMPARE is on.
 *
 * The CLI checks a cap between turns, so one call can end slightly above its
 * cap by the turn that crossed it; EVAL_M1_CAP_USD should keep headroom.
 */

export const MAX_REPEAT = 20;

export interface Caps {
  directorUsd: number;
  designUsd: number;
  judgeUsd: number;
}

export interface Calls {
  director: number;
  design: number;
  judge: number;
}

export interface PlanItem {
  /** The pairing key: scenario id and repetition, the same in every run of the same plan. */
  key: string;
  id: ScenarioId;
  repetition: number;
  calls: Calls;
  /** The Design-Agent-only arm and its two judge calls, when compared. */
  comparison: Calls | null;
  worstCaseUsd: number;
}

export interface RunPlan {
  scenarioIds: ScenarioId[];
  repeat: number;
  compare: boolean;
  caps: Caps;
  items: PlanItem[];
  calls: Calls;
  worstCaseUsd: number;
}

export interface Preflight {
  ok: boolean;
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  worstCaseUsd: number;
  unsettled: string[];
  message: string;
}

/** Both per-call caps, which a paid run requires. Throws naming what is missing or invalid. */
export function parseCaps(env: Record<string, string | undefined>): Caps {
  const read = (name: string) => {
    const cap = parseSpendingCap(env[name]);
    if (!cap.ok) throw new Error(`${name} must be a positive USD amount such as 2.50`);
    if (cap.usd === null) throw new Error(`${name} must be set: a paid evaluation run needs an explicit per-call cap`);
    return cap.usd;
  };
  return { directorUsd: read("DIRECTOR_MAX_BUDGET_USD"), designUsd: read("DESIGN_AGENT_MAX_BUDGET_USD"), judgeUsd: JUDGE_BUDGET_USD };
}

/** `EVAL_REPEAT`: a whole number from 1 to 20, 1 when unset. */
export function parseRepeat(raw: string | undefined): number {
  const value = raw?.trim() ?? "";
  if (value === "") return 1;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_REPEAT) throw new Error(`EVAL_REPEAT must be a whole number from 1 to ${MAX_REPEAT}`);
  return Number(value);
}

/**
 * The most model calls a scenario can make. Each chat plans once with the
 * Director; a blocked run designs only after its retry, so a scenario designs
 * at most once. Revisions are judged twice: the outcome and the revision.
 */
export function callsFor(scenario: Pick<Scenario, "kind" | "compare">, compare: boolean): { run: Calls; comparison: Calls | null } {
  const judge = { integration: 1, revision: 2, "image-service-unavailable": 0, cancel: 0, "restart-retry": 1 }[scenario.kind];
  return {
    run: { director: 1, design: 1, judge },
    comparison: compare && scenario.compare ? { director: 0, design: 1, judge: 2 } : null,
  };
}

const costOf = (c: Calls, caps: Caps) => c.director * caps.directorUsd + c.design * caps.designUsd + c.judge * caps.judgeUsd;
const round = (v: number) => Math.round(v * 1e6) / 1e6;

export function planRun(options: { scenarios: Scenario[]; repeat: number; compare: boolean; caps: Caps }): RunPlan {
  const { scenarios, repeat, compare, caps } = options;
  const ids = new Set(scenarios.map((s) => s.id));
  for (const s of scenarios) {
    if (s.revisionOf && !ids.has(s.revisionOf)) throw new Error(`${s.id} revises ${s.revisionOf}'s design; select both (EVAL_ONLY=${s.revisionOf},${s.id})`);
  }
  const items: PlanItem[] = [];
  const calls: Calls = { director: 0, design: 0, judge: 0 };
  // Repetition-major, so a revision always follows its own source in the same repetition.
  for (let repetition = 1; repetition <= repeat; repetition++) {
    for (const s of scenarios) {
      const c = callsFor(s, compare);
      for (const k of ["director", "design", "judge"] as const) calls[k] += c.run[k] + (c.comparison?.[k] ?? 0);
      items.push({
        key: `${s.id}#${repetition}`,
        id: s.id,
        repetition,
        calls: c.run,
        comparison: c.comparison,
        worstCaseUsd: round(costOf(c.run, caps) + (c.comparison ? costOf(c.comparison, caps) : 0)),
      });
    }
  }
  return {
    scenarioIds: scenarios.map((s) => s.id),
    repeat,
    compare,
    caps,
    items,
    calls,
    worstCaseUsd: round(items.reduce((a, i) => a + i.worstCaseUsd, 0)),
  };
}

const money = (v: number) => `$${v.toFixed(2)}`;

/** Whether the plan's worst case fits what remains of the M1 cap after everything in the ledger. */
export function preflight(plan: RunPlan, entries: LedgerEntry[], capUsd: number): Preflight {
  const t = ledgerTotals(entries);
  const spentUsd = round(t.totalUsd);
  const remainingUsd = round(Math.max(0, capUsd - spentUsd));
  const ok = plan.worstCaseUsd <= remainingUsd + 1e-9;
  const message = ok
    ? `Worst case ${money(plan.worstCaseUsd)} fits the remaining ${money(remainingUsd)} of the ${money(capUsd)} M1 cap.`
    : `Refused: the worst case ${money(plan.worstCaseUsd)} exceeds the remaining ${money(remainingUsd)} of the ${money(capUsd)} M1 cap (${money(spentUsd)} counted in the ledger). Select fewer scenarios or repetitions, lower the per-call caps, or settle reservations with ledger.ts add --run.`;
  return { ok, capUsd, spentUsd, remainingUsd, worstCaseUsd: plan.worstCaseUsd, unsettled: t.unsettled, message };
}

/** The plan as the dry run prints it. */
export function renderPlan(plan: RunPlan, check: Preflight, ledgerLabel: string): string {
  const lines = [
    `Acceptance plan: ${plan.scenarioIds.join(", ")} x ${plan.repeat} repetition(s), comparison ${plan.compare ? "on" : "off"}.`,
    `Order: ${plan.items.map((i) => i.key).join(", ")}`,
    `Per-call caps: Director ${money(plan.caps.directorUsd)}, Design Agent ${money(plan.caps.designUsd)}, judge ${money(plan.caps.judgeUsd)}.`,
    `Planned calls at most: ${plan.calls.director} Director, ${plan.calls.design} Design Agent, ${plan.calls.judge} judge.`,
    ...plan.items.map(
      (i) =>
        `  ${i.key}: ${i.calls.director} Director, ${i.calls.design} design, ${i.calls.judge} judge${i.comparison ? `; comparison ${i.comparison.design} design, ${i.comparison.judge} judge` : ""}; worst case ${money(i.worstCaseUsd)}`
    ),
    `Worst case ${money(plan.worstCaseUsd)}.`,
    `Ledger ${ledgerLabel}: ${money(check.spentUsd)} counted${check.unsettled.length ? ` (unsettled: ${check.unsettled.join(", ")})` : ""}; remaining ${money(check.remainingUsd)} of ${money(check.capUsd)}.`,
    check.message,
  ];
  return lines.join("\n");
}
