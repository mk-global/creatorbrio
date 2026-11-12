import { parseSpendingCap } from "./spending-cap";

/**
 * How the Design Agent's Claude CLI is run: its arguments, shared by the chat
 * route and the acceptance harness's Design-Agent-only comparison so both run
 * the agent exactly the same way, and its two operator settings.
 *
 * The task message is the user's message, followed by the visual plan when
 * there is one; the system prompt never carries the plan.
 *
 * Limits (#127, #187). There is no spending cap unless the operator sets
 * `DESIGN_AGENT_MAX_BUDGET_USD`: a fixed USD 1.00 cap stopped legitimate
 * 8-to-10-slide carousels part-way, because the CLI's cost estimate grows with
 * every slide's tool call. A run is bounded by two execution limits, Stop, and
 * the account's own provider limits:
 *
 * - the deadline (`DESIGN_AGENT_TIMEOUT_SECONDS`, 30 minutes by default), an
 *   absolute bound that no amount of output extends;
 * - the inactivity limit (`DESIGN_AGENT_INACTIVITY_SECONDS`, 5 minutes by
 *   default), which stops a run whose CLI has written nothing to its standard
 *   output for that long, so a stuck run ends long before the deadline.
 *
 * Real runs reached 437 to 1,062 seconds, so the 15-minute deadline stopped
 * one that was still working (#185). The inactivity default was checked
 * against a proxy, the gaps between recorded events in 71 design sessions
 * (longest 159 seconds); standard output itself was not recorded, so the run
 * log's `longestQuietMs` measures it from now on. These settings are
 * independent of the Visual Director's
 * (`DIRECTOR_MAX_BUDGET_USD` and its fixed 120-second timeout).
 */

/** The optional operator setting that caps one design run's Claude usage, in US dollars. */
export const DESIGN_AGENT_BUDGET_ENV = "DESIGN_AGENT_MAX_BUDGET_USD";
/** The optional operator setting for one design run's execution deadline, in whole seconds. */
export const DESIGN_AGENT_TIMEOUT_ENV = "DESIGN_AGENT_TIMEOUT_SECONDS";
/** The optional operator setting for how long a design run may go without output, in whole seconds. */
export const DESIGN_AGENT_INACTIVITY_ENV = "DESIGN_AGENT_INACTIVITY_SECONDS";
/**
 * The default deadline, for a complete 8-to-10-slide design run that renders
 * and reviews its own slides: about 1.7 times the longest real session
 * measured for #185. It replaced 15 minutes, which replaced a fixed 8.
 */
export const DEFAULT_DESIGN_AGENT_TIMEOUT_SECONDS = 30 * 60;
/** The deadline an operator may set, in seconds: at least one minute, at most one hour. */
export const MIN_DESIGN_AGENT_TIMEOUT_SECONDS = 60;
export const MAX_DESIGN_AGENT_TIMEOUT_SECONDS = 60 * 60;
/** The default inactivity limit: almost twice the longest gap between recorded session events (#187). */
export const DEFAULT_DESIGN_AGENT_INACTIVITY_SECONDS = 5 * 60;
/**
 * The inactivity limit an operator may set, in seconds. The upper bound stays
 * well above the CLI's own 10-minute maximum for a single command.
 */
export const MIN_DESIGN_AGENT_INACTIVITY_SECONDS = 60;
export const MAX_DESIGN_AGENT_INACTIVITY_SECONDS = 15 * 60;

export type DesignAgentSettings =
  | {
      ok: true;
      budgetUsd: number | null;
      timeoutMs: number;
      /** Null when no inactivity limit applies: the default is not shorter than the deadline. */
      inactivityMs: number | null;
    }
  | { ok: false; code: "budget_setting_invalid" | "timeout_setting_invalid" | "inactivity_setting_invalid" };

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

/**
 * Reads the inactivity setting against the deadline it must undercut. Unset
 * or blank means the default, which applies only when the deadline is longer
 * (a shorter deadline already stops the run first). A set value must be a
 * whole number of seconds within the allowed range and shorter than the
 * deadline; anything else is refused, never replaced by the default.
 */
export function designAgentInactivity(
  raw: string | undefined,
  timeoutMs: number
): { ok: true; ms: number | null } | { ok: false } {
  const value = raw?.trim() ?? "";
  if (value === "") {
    const ms = DEFAULT_DESIGN_AGENT_INACTIVITY_SECONDS * 1000;
    return { ok: true, ms: ms < timeoutMs ? ms : null };
  }
  if (!/^\d+$/.test(value)) return { ok: false };
  const seconds = Number(value);
  return seconds >= MIN_DESIGN_AGENT_INACTIVITY_SECONDS &&
    seconds <= MAX_DESIGN_AGENT_INACTIVITY_SECONDS &&
    seconds * 1000 < timeoutMs
    ? { ok: true, ms: seconds * 1000 }
    : { ok: false };
}

/** The Design Agent's settings, read per request like the app's other `.env.local` settings. */
export function designAgentSettings(env: Record<string, string | undefined> = process.env): DesignAgentSettings {
  const cap = parseSpendingCap(env[DESIGN_AGENT_BUDGET_ENV]);
  if (!cap.ok) return { ok: false, code: "budget_setting_invalid" };
  const timeout = designAgentTimeout(env[DESIGN_AGENT_TIMEOUT_ENV]);
  if (!timeout.ok) return { ok: false, code: "timeout_setting_invalid" };
  const inactivity = designAgentInactivity(env[DESIGN_AGENT_INACTIVITY_ENV], timeout.ms);
  if (!inactivity.ok) return { ok: false, code: "inactivity_setting_invalid" };
  return { ok: true, budgetUsd: cap.usd, timeoutMs: timeout.ms, inactivityMs: inactivity.ms };
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
