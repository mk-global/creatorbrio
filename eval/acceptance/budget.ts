import { parseSpendingCap } from "@/lib/spending-cap";
import { JUDGE_BUDGET_USD } from "./judge";
import { appendLedger, ledgerTotals, parseNonNegativeUsd, readLedger, withLedgerLock, type LedgerEntry } from "./ledger";
import type { ComparisonRecord, RunResults, ScenarioRecord } from "./report";
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
 * The CLI checks a cap between turns, so one call can end above its cap by
 * the turn that crossed it. Every call is therefore limited to its cap plus an
 * explicit overshoot allowance, `EVAL_OVERSHOOT_FRACTION` of the cap (0.25 by
 * default, always above 0). The allowance is an assumption about how far one
 * turn can carry a call past its cap, not a guarantee: the worst case is an
 * upper bound only while no call exceeds its limit. A call that is measured
 * above its limit is charged as measured and counted in the settlement and the
 * ledger note, so the assumption is checked against every run.
 * `EVAL_HOLD_BACK_USD` keeps part of the remaining allowance out of this run's
 * reach, for the post-containment rerun that must fit in the same cap (#221).
 *
 * Settlement (below) is the other half: when the run ends, every paid call
 * that started is charged to the ledger, at its measured cost when it reported
 * one and otherwise at its limit, so a run is never under-counted.
 */

export const MAX_REPEAT = 20;
export const DEFAULT_OVERSHOOT_FRACTION = 0.25;

export interface Caps {
  directorUsd: number;
  designUsd: number;
  judgeUsd: number;
  /**
   * Allowance above a call's cap, as a fraction of it, always above 0: the turn
   * that crosses a cap finishes before the CLI checks it. An assumption, not a guarantee.
   */
  overshootFraction: number;
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
  /** Kept out of this run's reach for the post-containment rerun. */
  holdBackUsd: number;
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
  return {
    directorUsd: read("DIRECTOR_MAX_BUDGET_USD"),
    designUsd: read("DESIGN_AGENT_MAX_BUDGET_USD"),
    judgeUsd: JUDGE_BUDGET_USD,
    overshootFraction: parseOvershoot(env.EVAL_OVERSHOOT_FRACTION),
  };
}

/**
 * `EVAL_OVERSHOOT_FRACTION`: a number above 0 and at most 1, 0.25 when unset.
 * Zero is refused: a call can always end above its cap by the turn that crossed it.
 */
export function parseOvershoot(raw: string | undefined): number {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_OVERSHOOT_FRACTION;
  if (!/^\d+(\.\d+)?$/.test(value) || !(Number(value) > 0) || Number(value) > 1) {
    throw new Error("EVAL_OVERSHOOT_FRACTION must be a number above 0 and at most 1, such as 0.25: a call can always end above its cap by the turn that crossed it");
  }
  return Number(value);
}

/** `EVAL_HOLD_BACK_USD`: USD 0 or more, 0 when unset. */
export const parseHoldBack = (raw: string | undefined) => parseNonNegativeUsd(raw, "EVAL_HOLD_BACK_USD", 0);

/** The most one call with this cap is assumed to cost: the cap plus the overshoot allowance. */
export const callBoundUsd = (capUsd: number, caps: Pick<Caps, "overshootFraction">) => capUsd * (1 + caps.overshootFraction);

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

/** The most these calls are assumed to cost, each at its cap plus the overshoot allowance. */
export const costOf = (c: Calls, caps: Caps) =>
  c.director * callBoundUsd(caps.directorUsd, caps) + c.design * callBoundUsd(caps.designUsd, caps) + c.judge * callBoundUsd(caps.judgeUsd, caps);
const round = (v: number) => Math.round(v * 1e6) / 1e6;
/** Rounded up to the micro-dollar, so a settlement never rounds below what was spent. */
const ceil6 = (v: number) => Math.ceil(v * 1e6 - 1e-6) / 1e6;

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

/** Whether the plan's worst case fits what remains of the M1 cap, less the hold-back, after everything in the ledger. */
export function preflight(plan: RunPlan, entries: LedgerEntry[], capUsd: number, holdBackUsd = 0): Preflight {
  const t = ledgerTotals(entries);
  const spentUsd = round(t.totalUsd);
  const remainingUsd = round(Math.max(0, capUsd - spentUsd));
  const usableUsd = round(Math.max(0, remainingUsd - holdBackUsd));
  const ok = plan.worstCaseUsd <= usableUsd + 1e-9;
  const holdBack = holdBackUsd > 0 ? `, less the ${money(holdBackUsd)} hold-back (usable ${money(usableUsd)})` : "";
  const message = ok
    ? `Worst case ${money(plan.worstCaseUsd)} fits the remaining ${money(remainingUsd)} of the ${money(capUsd)} M1 cap${holdBack}.`
    : `Refused: the worst case ${money(plan.worstCaseUsd)} exceeds the remaining ${money(remainingUsd)} of the ${money(capUsd)} M1 cap${holdBack} (${money(spentUsd)} counted in the ledger). Select fewer scenarios or repetitions, lower the per-call caps, or settle reservations with ledger.ts add --run.`;
  return { ok, capUsd, spentUsd, remainingUsd, holdBackUsd, worstCaseUsd: plan.worstCaseUsd, unsettled: t.unsettled, message };
}

/** The plan as the dry run prints it. */
export function renderPlan(plan: RunPlan, check: Preflight, ledgerLabel: string): string {
  const c = plan.caps;
  const lines = [
    `Acceptance plan: ${plan.scenarioIds.join(", ")} x ${plan.repeat} repetition(s), comparison ${plan.compare ? "on" : "off"}.`,
    `Order: ${plan.items.map((i) => i.key).join(", ")}`,
    `Per-call caps: Director ${money(c.directorUsd)}, Design Agent ${money(c.designUsd)}, judge ${money(c.judgeUsd)}.`,
    `Overshoot allowance ${Math.round(c.overshootFraction * 100)}% of each cap, an assumption for the CLI checking the cap between turns, not a guarantee: per-call limits Director ${money(callBoundUsd(c.directorUsd, c))}, Design Agent ${money(callBoundUsd(c.designUsd, c))}, judge ${money(callBoundUsd(c.judgeUsd, c))}.`,
    `Planned calls at most: ${plan.calls.director} Director, ${plan.calls.design} Design Agent, ${plan.calls.judge} judge.`,
    ...plan.items.map(
      (i) =>
        `  ${i.key}: ${i.calls.director} Director, ${i.calls.design} design, ${i.calls.judge} judge${i.comparison ? `; comparison ${i.comparison.design} design, ${i.comparison.judge} judge` : ""}; worst case ${money(i.worstCaseUsd)}`
    ),
    `Worst case ${money(plan.worstCaseUsd)}.`,
    `Ledger ${ledgerLabel}: ${money(check.spentUsd)} counted${check.unsettled.length ? ` (unsettled: ${check.unsettled.join(", ")})` : ""}; remaining ${money(check.remainingUsd)} of ${money(check.capUsd)}.`,
    `Hold-back for the post-containment rerun (EVAL_HOLD_BACK_USD): ${money(check.holdBackUsd)}; usable by this run ${money(Math.max(0, check.remainingUsd - check.holdBackUsd))}. The rerun must fit in the same cap.`,
    check.message,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Settlement: what a finished (or failed, or timed-out) run is charged.

export interface ItemSettlement {
  key: string;
  /** What the item is charged. */
  costUsd: number;
  /** The part of it that calls reported themselves; informational. */
  measuredUsd: number;
  /** Calls charged at their limit because they started without a measured cost, or the item could not say what had started. */
  atBoundCalls: number;
  /** Calls whose measured cost was above their limit: the overshoot allowance was too small for them. */
  overLimitCalls: number;
  /** Calls that ran beyond the plan, for example a retry that designed a second time. */
  beyondPlanCalls: number;
  /** Why the item was not measured, when it was not: a timeout, a harness error, a call without a cost. */
  reasons: string[];
}

export interface Settlement {
  costUsd: number;
  measuredUsd: number;
  /** Calls charged at their limit across the run; any above 0 makes the measurement incomplete. */
  atBoundCalls: number;
  overLimitCalls: number;
  beyondPlanCalls: number;
  items: ItemSettlement[];
}

type ArmCharge = Omit<ItemSettlement, "key">;

const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const numbers = (values: (number | null | undefined)[]): number[] => values.map(num).filter((v): v is number => v !== null);
const noCharge = (): ArmCharge => ({ costUsd: 0, measuredUsd: 0, atBoundCalls: 0, overLimitCalls: 0, beyondPlanCalls: 0, reasons: [] });

/** The limit of one call: its cap plus the overshoot allowance. */
const limits = (caps: Caps) => ({ director: callBoundUsd(caps.directorUsd, caps), design: callBoundUsd(caps.designUsd, caps), judge: callBoundUsd(caps.judgeUsd, caps) });

/** Adds up what an arm is charged: calls at what they measured, and calls without a measurement at their limit. */
function accumulator() {
  const out = noCharge();
  return {
    out,
    /** A call that reported its cost: charged as reported, which is never lowered to the limit. */
    measured(costUsd: number, limitUsd: number) {
      out.costUsd += costUsd;
      out.measuredUsd += costUsd;
      if (costUsd > limitUsd) out.overLimitCalls++;
    },
    /** Calls that started without a measured cost: charged at their limit. */
    atLimit(calls: number, limitUsd: number, why: string) {
      if (calls <= 0) return;
      out.costUsd += calls * limitUsd;
      out.atBoundCalls += calls;
      out.reasons.push(`${calls} ${why}`);
    },
    beyond(calls: number, why: string) {
      if (calls <= 0) return;
      out.beyondPlanCalls += calls;
      out.reasons.push(`${calls} ${why}`);
    },
  };
}

/**
 * The paid calls a scenario's chats started, from the harness's side of the
 * stream: a "planning" stage means the Director was started (a retry never
 * re-plans), "designing" means the Design Agent was. A stream that broke
 * while the server was still up is no evidence that nothing started, so it
 * counts as both. The server's own log cannot be the evidence: a server
 * killed mid-call writes no line for it.
 */
function startedCalls(record: ScenarioRecord): { director: number; design: number } {
  let director = 0;
  let design = 0;
  for (const chat of record.chats) {
    const stages = new Set(chat.result.events.flatMap((e) => (e.event.type === "stage" ? [e.event.stage as string] : [])));
    const broken = chat.result.httpStatus === 200 && !!chat.result.streamError && !record.afterStop;
    if (!chat.retryRunId && (stages.has("planning") || broken)) director++;
    if (stages.has("designing") || broken) design++;
  }
  return { director, design };
}

/**
 * An arm that did not finish cleanly, so what had started cannot be known:
 * every planned call is charged max(measured, limit), the calls that did
 * report a cost filling the planned slots largest first. A measured call
 * above its limit counts at its measured cost, a planned call without a
 * measurement at its limit, and a measured call beyond the plan as measured.
 */
function arm(planned: Calls, measured: { director: number[]; design: number[]; judge: number[] }, caps: Caps, reason: string): ArmCharge {
  const out = noCharge();
  out.reasons.push(reason);
  const lim = limits(caps);
  for (const kind of ["director", "design", "judge"] as const) {
    const costs = [...measured[kind]].sort((a, b) => b - a);
    for (let i = 0; i < Math.max(planned[kind], costs.length); i++) {
      const m = costs[i];
      if (m !== undefined) out.measuredUsd += m;
      if (i >= planned[kind]) {
        out.costUsd += m;
        out.beyondPlanCalls++;
      } else {
        out.costUsd += Math.max(m ?? 0, lim[kind]);
        if (m !== undefined && m > lim[kind]) out.overLimitCalls++;
        else out.atBoundCalls++;
      }
    }
  }
  return out;
}

function settleRunArm(item: PlanItem, record: ScenarioRecord, caps: Caps): ArmCharge {
  const c = record.costs;
  const lim = limits(caps);
  const judges = numbers([record.judge, record.revisionJudge].map((j) => (j ? j.costUsd : undefined)));
  if (!record.finished) return arm(item.calls, { director: c?.directorCallCosts ?? [], design: c?.designCallCosts ?? [], judge: judges }, caps, "the test did not finish (timed out or was cut off)");
  if (record.harnessError) return arm(item.calls, { director: c?.directorCallCosts ?? [], design: c?.designCallCosts ?? [], judge: judges }, caps, "harness error: what had started is unknown");

  const acc = accumulator();
  const started = startedCalls(record);
  // A call counts as started when the stream says so or the log shows its line, and as measured when its line carried a cost.
  const directorStarted = Math.max(started.director, c?.directorRuns ?? 0);
  const designStarted = Math.max(started.design, c?.designRuns ?? 0);
  for (const cost of c?.directorCallCosts ?? []) acc.measured(cost, lim.director);
  for (const cost of c?.designCallCosts ?? []) acc.measured(cost, lim.design);
  acc.atLimit(directorStarted - (c?.directorCallCosts.length ?? 0), lim.director, "Director call(s) without a measured cost");
  acc.atLimit(designStarted - (c?.designCallCosts.length ?? 0), lim.design, "Design Agent run(s) without a measured cost");
  acc.beyond(directorStarted - item.calls.director, "Director call(s) beyond the plan");
  acc.beyond(designStarted - item.calls.design, "Design Agent run(s) beyond the plan");
  for (const judge of [record.judge, record.revisionJudge]) {
    if (!judge) continue;
    const cost = num(judge.costUsd);
    if (cost === null) acc.atLimit(1, lim.judge, "judge call(s) without a measured cost");
    else acc.measured(cost, lim.judge);
  }
  return acc.out;
}

function settleComparisonArm(item: PlanItem, run: ScenarioRecord | undefined, record: ComparisonRecord | undefined, caps: Caps): ArmCharge | null {
  const planned = item.comparison!;
  const lim = limits(caps);
  const measured = {
    director: [],
    design: numbers([record?.baseline?.costUsd]),
    judge: numbers([record?.baselineJudge?.costUsd, record?.pairwise?.result.costUsd]),
  };
  if (!record) {
    // Nothing was reached when the run arm failed, so the comparison never began; when it finished cleanly the comparison was about to.
    if (!run || run.harnessError) return null;
    return arm(planned, measured, caps, "the comparison did not begin or was cut off");
  }
  if (!record.finished) return arm(planned, measured, caps, "the comparison did not finish (timed out or was cut off)");
  if (record.skipped) return noCharge();

  const acc = accumulator();
  // The Design-Agent-only arm started once its carousel was made, whether or not its result was recorded.
  if (record.baselineCarouselId !== null) {
    const cost = num(record.baseline?.costUsd);
    if (cost === null) acc.atLimit(1, lim.design, "Design-Agent-only run(s) without a measured cost");
    else acc.measured(cost, lim.design);
  }
  const judges = [record.baselineJudge, record.pairwise?.result];
  for (const judge of judges) {
    if (!judge) continue;
    const cost = num(judge.costUsd);
    if (cost === null) acc.atLimit(1, lim.judge, "comparison judge call(s) without a measured cost");
    else acc.measured(cost, lim.judge);
  }
  // A comparison that threw after its set was exported may have started a judge it never recorded.
  if (record.harnessError && record.baselineExport?.ok) {
    acc.atLimit(planned.judge - judges.filter((j) => !!j).length, lim.judge, "unrecorded comparison judge call(s) after a harness error");
  }
  return acc.out;
}

/**
 * What the run is charged in the ledger, per plan item and in all.
 *
 * Every paid call that started is charged: at its measured cost when it
 * reported one, and otherwise at its per-call cap plus the overshoot
 * allowance. That covers a judge that timed out or was killed, a Design Agent
 * run that logged no cost, a Design-Agent-only arm that timed out, and a
 * comparison that threw after its paid arm ran. An item whose test timed out
 * or never finished, or whose driver failed with a harness error, is charged
 * every call it planned, each at max(measured, limit), since what had started
 * cannot be known; an item that never began is charged nothing. Measured costs
 * are never lowered to the limit, and a measured call above its limit is
 * counted and noted, because the allowance is an assumption, not a guarantee.
 */
export function settlementDetail(results: Pick<RunResults, "scenarios" | "comparisons">, plan: RunPlan, caps: Caps): Settlement {
  const items: ItemSettlement[] = [];
  for (const item of plan.items) {
    const run = results.scenarios.find((r) => r.key === item.key);
    const comparison = results.comparisons.find((c) => c.key === item.key);
    if (!run && !comparison) {
      items.push({ key: item.key, ...noCharge() });
      continue;
    }
    const parts: ArmCharge[] = [];
    if (run) parts.push(settleRunArm(item, run, caps));
    // A comparison record without its run arm cannot happen; if it did, it is charged in full.
    else parts.push(arm(item.calls, { director: [], design: [], judge: [] }, caps, "no record of the scenario"));
    if (item.comparison) {
      const c = settleComparisonArm(item, run, comparison, caps);
      if (c) parts.push(c);
    }
    const sum = (pick: (p: ArmCharge) => number) => parts.reduce((a, p) => a + pick(p), 0);
    items.push({
      key: item.key,
      costUsd: sum((p) => p.costUsd),
      measuredUsd: sum((p) => p.measuredUsd),
      atBoundCalls: sum((p) => p.atBoundCalls),
      overLimitCalls: sum((p) => p.overLimitCalls),
      beyondPlanCalls: sum((p) => p.beyondPlanCalls),
      reasons: parts.flatMap((p) => p.reasons),
    });
  }
  const total = (pick: (i: ItemSettlement) => number) => items.reduce((a, i) => a + pick(i), 0);
  return {
    costUsd: ceil6(total((i) => i.costUsd)),
    measuredUsd: round(total((i) => i.measuredUsd)),
    atBoundCalls: total((i) => i.atBoundCalls),
    overLimitCalls: total((i) => i.overLimitCalls),
    beyondPlanCalls: total((i) => i.beyondPlanCalls),
    items,
  };
}

/** What the run is charged in the ledger, in USD, never below what it spent. */
export const settlementUsd = (results: Pick<RunResults, "scenarios" | "comparisons">, plan: RunPlan, caps: Caps): number => settlementDetail(results, plan, caps).costUsd;

// ---------------------------------------------------------------------------
// The reserve and settle sequence, each one step under the ledger lock.

export interface RunIdentity {
  runId: string;
  commit: string;
  ticket: string;
}

/**
 * Checks the plan against the ledger and appends its reservation as one step,
 * so two runs cannot both pass the preflight against the same allowance.
 * Throws the preflight's refusal when the worst case does not fit.
 */
export function reserveRun(options: {
  ledger: string;
  plan: RunPlan;
  capUsd: number;
  holdBackUsd?: number;
  run: RunIdentity;
  note: string;
  now?: Date;
  lock?: { staleMs?: number; waitMs?: number };
}): { check: Preflight; reservation: LedgerEntry } {
  return withLedgerLock(options.ledger, () => {
    const check = preflight(options.plan, readLedger(options.ledger), options.capUsd, options.holdBackUsd ?? 0);
    if (!check.ok) throw new Error(check.message);
    const reservation: LedgerEntry = {
      at: (options.now ?? new Date()).toISOString(),
      kind: "reservation",
      ticket: options.run.ticket,
      runId: options.run.runId,
      commit: options.run.commit,
      costUsd: options.plan.worstCaseUsd,
      note: options.note.slice(0, 500),
    };
    appendLedger(options.ledger, reservation);
    return { check, reservation };
  }, options.lock);
}

/**
 * The ledger note for a settlement: outcome counts, "incomplete measurement"
 * with counts when any call was charged at its limit, any call measured above
 * its limit (the overshoot allowance was too small for it), and any call
 * beyond the plan.
 */
export function settlementNote(label: string, results: Pick<RunResults, "scenarios" | "comparisons">, plan: RunPlan, settlement: Settlement, reservedUsd: number): string {
  const completed = results.scenarios.filter((r) => r.outcome === "completed").length;
  const errors = results.scenarios.filter((r) => r.harnessError).length + results.comparisons.filter((c) => c.harnessError).length;
  const bound = settlement.items.filter((i) => i.atBoundCalls > 0);
  // A few keys, so the note stays within the ledger's length limit and keeps its tail.
  const keys = bound.slice(0, 6).map((i) => i.key).join(", ") + (bound.length > 6 ? `, +${bound.length - 6} more` : "");
  const parts = [`${completed} of ${plan.items.length} completed`];
  if (errors) parts.push(`${errors} harness failure(s)`);
  if (settlement.atBoundCalls > 0) {
    parts.push(`incomplete measurement: ${settlement.atBoundCalls} call(s) charged at the per-call limit in ${bound.length} item(s) (${keys}); measured ${money(settlement.measuredUsd)}`);
  } else parts.push("measured cost");
  const over = settlement.items.filter((i) => i.overLimitCalls > 0).map((i) => i.key);
  if (settlement.overLimitCalls > 0) parts.push(`${settlement.overLimitCalls} call(s) measured above their per-call limit (${over.slice(0, 4).join(", ")}${over.length > 4 ? ", ..." : ""}): the overshoot allowance was too small`);
  if (settlement.beyondPlanCalls > 0) parts.push(`${settlement.beyondPlanCalls} call(s) beyond the plan`);
  if (settlement.costUsd > reservedUsd + 1e-9) parts.push(`exceeds the reserved worst case ${money(reservedUsd)}`);
  return `${label}: ${parts.join(", ")}`.replace(/[\n\r]+/g, " ").slice(0, 500);
}

/**
 * Computes the settlement, then appends the spend entry that settles the
 * reservation, as one step under the ledger lock. The settlement is computed
 * first and nothing is appended if it throws, so a failure leaves the
 * reservation unsettled, which counts in full: never a smaller fallback.
 */
export function settleRun(options: {
  ledger: string;
  results: Pick<RunResults, "scenarios" | "comparisons">;
  plan: RunPlan;
  reservedUsd: number;
  run: RunIdentity;
  /** The start of every note: which plan and mode. */
  label: string;
  now?: Date;
  lock?: { staleMs?: number; waitMs?: number };
}): { spend: LedgerEntry; settlement: Settlement } {
  const settlement = settlementDetail(options.results, options.plan, options.plan.caps);
  const note = settlementNote(options.label, options.results, options.plan, settlement, options.reservedUsd);
  return withLedgerLock(options.ledger, () => {
    const entries = readLedger(options.ledger);
    if (entries.some((e) => e.kind === "spend" && e.runId === options.run.runId)) throw new Error(`Run ${options.run.runId} is already settled in the ledger`);
    const spend: LedgerEntry = {
      at: (options.now ?? new Date()).toISOString(),
      kind: "spend",
      ticket: options.run.ticket,
      runId: options.run.runId,
      commit: options.run.commit,
      costUsd: settlement.costUsd,
      note,
    };
    appendLedger(options.ledger, spend);
    return { spend, settlement };
  }, options.lock);
}
