/**
 * The M1 evaluation spend ledger (#221: USD 50 for M1's baseline and quality
 * evaluation), shared by every paid M1 run. One JSON object per line in
 * `~/.local/share/creatorbrio-m1-eval/ledger.jsonl`, outside the repository.
 *
 * A run appends a `reserve` entry with its worst case before it spends
 * anything and a `settle` entry with its actual cost afterwards. A run that
 * never settled (it crashed) counts at its reservation, so an interrupted run
 * can never make the remaining allowance look larger than it is.
 *
 * #224 plans the acceptance harness's ledger (`eval/acceptance/ledger.ts`),
 * not merged when this was written; this reader and writer use the same file
 * and should be consolidated into one module once it lands.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const M1_CAP_USD = 50;

export const defaultLedgerPath = () => process.env.CREATORBRIO_M1_LEDGER ?? path.join(homedir(), ".local", "share", "creatorbrio-m1-eval", "ledger.jsonl");

export interface LedgerEntry {
  version: 1;
  at: string;
  harness: string;
  runId: string;
  kind: "reserve" | "settle";
  usd: number;
  note?: string;
}

/** Parses the ledger; a line that is not a valid entry is reported, never skipped silently. */
export function parseLedger(text: string): { entries: LedgerEntry[]; invalidLines: number[] } {
  const entries: LedgerEntry[] = [];
  const invalidLines: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const v = JSON.parse(line) as Partial<LedgerEntry>;
      if (v.version === 1 && (v.kind === "reserve" || v.kind === "settle") && typeof v.runId === "string" && typeof v.usd === "number" && Number.isFinite(v.usd) && v.usd >= 0) {
        entries.push(v as LedgerEntry);
      } else invalidLines.push(i + 1);
    } catch {
      invalidLines.push(i + 1);
    }
  });
  return { entries, invalidLines };
}

/** Spent so far: each run's settled cost, or its reservation while unsettled. */
export function spentUsd(entries: LedgerEntry[]): number {
  const runs = new Map<string, { reserved: number; settled: number | null }>();
  for (const e of entries) {
    const key = `${e.harness}/${e.runId}`;
    const r = runs.get(key) ?? { reserved: 0, settled: null };
    if (e.kind === "reserve") r.reserved += e.usd;
    else r.settled = (r.settled ?? 0) + e.usd;
    runs.set(key, r);
  }
  let total = 0;
  for (const r of runs.values()) total += r.settled ?? r.reserved;
  return Math.round(total * 1e6) / 1e6;
}

export interface SpendPlan {
  /** Per message: the Design Agent's cap and the Visual Director's cap, in USD. */
  designCapUsd: number | null;
  directorCapUsd: number | null;
  messages: number;
  /** Extra allowance for the CLI finishing the turn in which it crossed its cap. */
  overrunFactor: number;
}

/** Parses an operator cap the way the app does: a positive amount in US dollars, or nothing. */
export function parseCap(raw: string | undefined): number | null {
  const v = raw?.trim() ?? "";
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

export function worstCaseUsd(plan: SpendPlan): number | null {
  if (plan.designCapUsd === null || plan.directorCapUsd === null) return null;
  return Math.round(plan.messages * (plan.designCapUsd + plan.directorCapUsd) * plan.overrunFactor * 1e6) / 1e6;
}

export type SpendCheck = { ok: true; worstCaseUsd: number; spentUsd: number; remainingUsd: number } | { ok: false; problem: string };

/**
 * A paid run may start only when both caps are set (each message runs the
 * Visual Director and then the Design Agent) and its worst case fits what is
 * left of the M1 allowance.
 */
export function checkSpend(plan: SpendPlan, entries: LedgerEntry[], capUsd = M1_CAP_USD): SpendCheck {
  if (plan.designCapUsd === null) return { ok: false, problem: "DESIGN_AGENT_MAX_BUDGET_USD must be set to a positive amount" };
  if (plan.directorCapUsd === null) return { ok: false, problem: "DIRECTOR_MAX_BUDGET_USD must be set to a positive amount" };
  const worst = worstCaseUsd(plan) as number;
  const spent = spentUsd(entries);
  const remaining = Math.round((capUsd - spent) * 1e6) / 1e6;
  if (worst > remaining) return { ok: false, problem: `the run's worst case, USD ${worst}, exceeds the remaining M1 allowance, USD ${remaining}` };
  return { ok: true, worstCaseUsd: worst, spentUsd: spent, remainingUsd: remaining };
}

export function readLedger(file = defaultLedgerPath()): { entries: LedgerEntry[]; invalidLines: number[] } {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return parseLedger(text);
}

export function appendLedger(entry: Omit<LedgerEntry, "version" | "at">, file = defaultLedgerPath(), now = new Date()) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify({ version: 1, at: now.toISOString(), ...entry })}\n`, { mode: 0o600 });
}
