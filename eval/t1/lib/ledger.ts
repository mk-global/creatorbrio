/**
 * T1's spend accounting on the cumulative M1 ledger that #224 owns
 * (`eval/acceptance/ledger.ts` and `eval/acceptance/budget.ts`): the same file,
 * format and lock, and the same variables (`EVAL_LEDGER`, `EVAL_M1_CAP_USD`,
 * `EVAL_HOLD_BACK_USD`, `EVAL_OVERSHOOT_FRACTION`, both per-call caps). Only
 * the plan and the settlement are T1's own.
 *
 * Plan: each model message is one `/api/chat` call on a carousel, which runs
 * the Visual Director once and then the Design Agent once
 * (`prepareCreativeRun` in src/lib/creative-run.ts; the harness never asks for
 * a retry or a continuation, the only paths without a Director call). Each
 * call is bounded at its cap times (1 + overshoot).
 *
 * Settlement is conservative by design: the subject runs as the same user as
 * the app, so the app's cost log lines are subject-writable and never set the
 * spend. Every started message is charged at its full bound; the app-reported
 * cost goes into the note only, marked untrusted.
 */
import { callBoundUsd, parseCaps, parseHoldBack, preflight, reserveRun, type Caps, type Preflight, type RunIdentity, type RunPlan } from "../../acceptance/budget";
import { appendLedger, ledgerPath, m1CapUsd, readLedger, withLedgerLock, type LedgerEntry } from "../../acceptance/ledger";

/** The model messages a T1 run sends: the hostile message and the follow-up. */
export const T1_MESSAGES = 2;
/** Visual Director calls per message (one plan per `/api/chat` call on a carousel). */
export const DIRECTOR_CALLS_PER_MESSAGE = 1;

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const money = (v: number) => `$${v.toFixed(2)}`;

/** The most one started message can cost: its Design Agent call and its Director call(s), each at its cap plus the overshoot allowance. */
export const messageBoundUsd = (caps: Caps) => round(callBoundUsd(caps.designUsd, caps) + DIRECTOR_CALLS_PER_MESSAGE * callBoundUsd(caps.directorUsd, caps));

/** A T1 run as the shared preflight and reservation see it: no scenarios, only calls and a worst case. */
export function t1Plan(caps: Caps, messages = T1_MESSAGES): RunPlan {
  return {
    scenarioIds: [],
    repeat: 1,
    compare: false,
    caps,
    items: [],
    calls: { director: messages * DIRECTOR_CALLS_PER_MESSAGE, design: messages, judge: 0 },
    worstCaseUsd: round(messages * messageBoundUsd(caps)),
  };
}

export interface T1Budget {
  ledger: string;
  caps: Caps;
  capUsd: number;
  holdBackUsd: number;
  plan: RunPlan;
}

/** Reads every setting a paid T1 run needs; throws naming what is missing or invalid. */
export function t1Budget(env: Record<string, string | undefined> = process.env): T1Budget {
  const caps = parseCaps(env);
  return { ledger: ledgerPath(env), caps, capUsd: m1CapUsd(env), holdBackUsd: parseHoldBack(env.EVAL_HOLD_BACK_USD), plan: t1Plan(caps) };
}

/** The read-only check made before anything is built; the binding check is the reservation's, under the lock. */
export const checkT1 = (b: T1Budget): Preflight => preflight(b.plan, readLedger(b.ledger), b.capUsd, b.holdBackUsd);

/** Checks and appends the reservation as one step under the ledger lock, before the first model message. Throws the refusal. */
export function reserveT1(b: T1Budget, run: RunIdentity, note: string, options: { now?: Date; lock?: { staleMs?: number; waitMs?: number } } = {}) {
  return reserveRun({ ledger: b.ledger, plan: b.plan, capUsd: b.capUsd, holdBackUsd: b.holdBackUsd, run, note, ...options });
}

/** What a run is charged: every started message at its full bound, whatever anything inside the subject reported. */
export function t1SettlementUsd(caps: Caps, startedMessages: number): number {
  if (!Number.isInteger(startedMessages) || startedMessages < 0 || startedMessages > T1_MESSAGES) throw new Error(`started messages must be 0 to ${T1_MESSAGES}`);
  return round(startedMessages * messageBoundUsd(caps));
}

export function t1SettlementNote(label: string, startedMessages: number, reportedUsd: number | null): string {
  const reported = reportedUsd === null ? "the app reported no cost" : `the app reported ${money(reportedUsd)}, untrusted (subject-writable) and not used`;
  return `${label}: ${startedMessages} of ${T1_MESSAGES} model message(s) started, each charged at its full limit (Design Agent and Director cap x (1 + overshoot)); ${reported}`.replace(/[\n\r]+/g, " ").slice(0, 500);
}

/** Appends the spend entry that settles this run's reservation, under the lock; refuses to settle a run twice. */
export function settleT1(options: {
  ledger: string;
  caps: Caps;
  run: RunIdentity;
  startedMessages: number;
  reportedUsd: number | null;
  label: string;
  now?: Date;
  lock?: { staleMs?: number; waitMs?: number };
}): LedgerEntry {
  const costUsd = t1SettlementUsd(options.caps, options.startedMessages);
  const note = t1SettlementNote(options.label, options.startedMessages, options.reportedUsd);
  return withLedgerLock(options.ledger, () => {
    if (readLedger(options.ledger).some((e) => e.kind === "spend" && e.runId === options.run.runId)) throw new Error(`Run ${options.run.runId} is already settled in the ledger`);
    const spend: LedgerEntry = {
      at: (options.now ?? new Date()).toISOString(),
      kind: "spend",
      ticket: options.run.ticket,
      runId: options.run.runId,
      commit: options.run.commit,
      costUsd,
      note,
    };
    appendLedger(options.ledger, spend);
    return spend;
  }, options.lock);
}
