/**
 * Reads an optional operator spending cap in US dollars, such as
 * `DIRECTOR_MAX_BUDGET_USD` or `DESIGN_AGENT_MAX_BUDGET_USD`. Unset or blank
 * means no cap; otherwise it must be a plain positive decimal such as `0.75`.
 * Anything else is refused rather than ignored, so a cap the operator asked
 * for is never silently dropped, and no default is ever substituted.
 *
 * A cap is passed to the Claude CLI as `--max-budget-usd`, which the CLI
 * enforces against its own reported cost: a list-price estimate, not an
 * invoiced charge.
 */
export function parseSpendingCap(raw: string | undefined): { ok: true; usd: number | null } | { ok: false } {
  const value = raw?.trim() ?? "";
  if (value === "") return { ok: true, usd: null };
  if (!/^\d+(\.\d+)?$/.test(value)) return { ok: false };
  const usd = Number(value);
  return Number.isFinite(usd) && usd > 0 ? { ok: true, usd } : { ok: false };
}
