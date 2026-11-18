/**
 * Model token usage, as the Claude CLI reports it in a result event's
 * `usage` (snake_case counts) and `modelUsage` (keyed by model name). The
 * server logs the Design Agent's counts as `designUsage` on its "run finished"
 * line; the harness's own CLI calls (the judge and the Design-Agent-only arm)
 * read them from their result events.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;

const CLI_KEYS: Record<keyof TokenUsage, string> = {
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_input_tokens",
  cacheCreationTokens: "cache_creation_input_tokens",
};

/** The four counts from a CLI `usage` object; null when it carries none of them. */
export function usageFromCli(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  let seen = false;
  const out: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const key of USAGE_KEYS) {
    const v = u[CLI_KEYS[key]];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = v;
      seen = true;
    }
  }
  return seen ? out : null;
}

/** The sum of the usages present; null when none is. */
export function addUsage(values: (TokenUsage | null | undefined)[]): TokenUsage | null {
  const present = values.filter((v): v is TokenUsage => !!v);
  if (!present.length) return null;
  const out: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const v of present) for (const key of USAGE_KEYS) out[key] += v[key];
  return out;
}

/** Every token counted, input of all kinds plus output. */
export const totalTokens = (u: TokenUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;

/** The model names in a CLI result's `modelUsage`, sorted. */
export function modelsFromResult(result: unknown): string[] {
  const mu = result && typeof result === "object" ? (result as Record<string, unknown>).modelUsage : null;
  if (!mu || typeof mu !== "object" || Array.isArray(mu)) return [];
  return Object.keys(mu).filter((k) => /^[\w.:@/-]{1,128}$/.test(k)).sort();
}
