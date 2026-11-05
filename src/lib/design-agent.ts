import { parseSpendingCap } from "./spending-cap";

/**
 * How the Design Agent's Claude CLI is run: its arguments, shared by the chat
 * route and the acceptance harness's Design-Agent-only comparison so both run
 * the agent exactly the same way, and its two operator settings.
 *
 * The task message is the user's message, followed by the visual plan when
 * there is one; the system prompt never carries the plan.
 *
 * Limits (#127). There is no spending cap unless the operator sets
 * `DESIGN_AGENT_MAX_BUDGET_USD`: a fixed USD 1.00 cap stopped legitimate
 * 8-to-10-slide carousels part-way, because the CLI's cost estimate grows with
 * every slide's tool call. A run is bounded by its execution deadline
 * (`DESIGN_AGENT_TIMEOUT_SECONDS`, 15 minutes by default), Stop, and the
 * account's own provider limits, none of which this changes. Both settings are
 * independent of the Visual Director's (`DIRECTOR_MAX_BUDGET_USD` and its
 * fixed 120-second timeout).
 */

/** The optional operator setting that caps one design run's Claude usage, in US dollars. */
export const DESIGN_AGENT_BUDGET_ENV = "DESIGN_AGENT_MAX_BUDGET_USD";
/** The optional operator setting for one design run's execution deadline, in whole seconds. */
export const DESIGN_AGENT_TIMEOUT_ENV = "DESIGN_AGENT_TIMEOUT_SECONDS";
/**
 * The default deadline, for a complete 8-to-10-slide design run with its
 * tool calls. It replaces a fixed 8 minutes; see the pull request for #127
 * for the measured runs it was checked against.
 */
export const DEFAULT_DESIGN_AGENT_TIMEOUT_SECONDS = 15 * 60;
/** The deadline an operator may set, in seconds: at least one minute, at most one hour. */
export const MIN_DESIGN_AGENT_TIMEOUT_SECONDS = 60;
export const MAX_DESIGN_AGENT_TIMEOUT_SECONDS = 60 * 60;

export type DesignAgentSettings =
  | { ok: true; budgetUsd: number | null; timeoutMs: number }
  | { ok: false; code: "budget_setting_invalid" | "timeout_setting_invalid" };

/**
 * Reads the timeout setting. Unset or blank means the default; otherwise a
 * whole number of seconds within the allowed range. Anything else is refused,
 * never replaced by the default, so an operator's intent is never ignored.
 */
export function designAgentTimeout(raw: string | undefined): { ok: true; ms: number } | { ok: false } {
  const value = raw?.trim() ?? "";
  if (value === "") return { ok: true, ms: DEFAULT_DESIGN_AGENT_TIMEOUT_SECONDS * 1000 };
  if (!/^\d+$/.test(value)) return { ok: false };
  const seconds = Number(value);
  return seconds >= MIN_DESIGN_AGENT_TIMEOUT_SECONDS && seconds <= MAX_DESIGN_AGENT_TIMEOUT_SECONDS
    ? { ok: true, ms: seconds * 1000 }
    : { ok: false };
}

/** The Design Agent's settings, read per request like the app's other `.env.local` settings. */
export function designAgentSettings(env: Record<string, string | undefined> = process.env): DesignAgentSettings {
  const cap = parseSpendingCap(env[DESIGN_AGENT_BUDGET_ENV]);
  if (!cap.ok) return { ok: false, code: "budget_setting_invalid" };
  const timeout = designAgentTimeout(env[DESIGN_AGENT_TIMEOUT_ENV]);
  if (!timeout.ok) return { ok: false, code: "timeout_setting_invalid" };
  return { ok: true, budgetUsd: cap.usd, timeoutMs: timeout.ms };
}

export function designAgentArgs(options: {
  taskMessage: string;
  systemPrompt: string;
  resumeSessionId: string | null;
  /** The operator's cap; null passes none, so only the account's own limits apply. */
  budgetUsd: number | null;
}): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--append-system-prompt",
    options.systemPrompt,
    "--allowedTools",
    "Bash",
    "--allowedTools",
    "WebFetch",
    "--allowedTools",
    "Read",
    ...(options.budgetUsd === null ? [] : ["--max-budget-usd", String(options.budgetUsd)]),
    "--name",
    "creatorbrio-chat",
    ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : []),
    // The task comes last, after "--", so the CLI never reads it as an option:
    // a task beginning with "-" (a Markdown list, or a continuation's marker)
    // was refused as "unknown option" before the agent ever ran (#127).
    "--",
    options.taskMessage,
  ];
}
