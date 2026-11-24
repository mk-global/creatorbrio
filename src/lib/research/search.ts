import type { SearchFailureCode, WebSearchMethod } from "@/types/research";

/**
 * Web search for topic research: one small provider interface (#252) and two
 * adapters. Claude's own web search, through the person's Claude Code
 * sign-in, needs no other account and is the default (#256; founder decision
 * of 2026-11-24). Brave Search, with the person's own key, is an optional
 * enhancement: when a key is set it searches first, and Claude's web search
 * stands in when Brave refuses the key, limits requests or cannot be reached.
 * Either way a search only finds page addresses; research reads every page
 * itself through the source-retrieval boundary.
 *
 * Results are used transiently and only for their page addresses: Brave's
 * terms forbid storing search results, so nothing from a result (title,
 * description, ranking) is kept or shown. Research reads each page itself
 * through the source-retrieval boundary and stores only what it read.
 *
 * The key comes from the server's environment, is sent only in Brave's
 * request header, and never appears in a response, a log line or stored data.
 */

export const SEARCH_KEY_ENV = "BRAVE_SEARCH_API_KEY";
export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const SEARCH_TIMEOUT_MS = 10_000;
/** How many results one search asks for. */
export const SEARCH_RESULT_COUNT = 10;
/** Brave's query limit is 400 characters and 50 words. */
const MAX_QUERY_CHARS = 400;
const MAX_QUERY_WORDS = 50;
/** A result page is small; anything past this is not one. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * What one search returned. `costUsd` is the model's estimated cost of a
 * Claude web search, as the CLI reports it; Brave reports none. A search
 * stopped at the run's spending cap fails as `budget_exceeded`, which ends the
 * run rather than falling through to the next method.
 */
export type SearchOutcome =
  | { ok: true; urls: string[]; costUsd?: number | null }
  | { ok: false; code: SearchFailureCode | "budget_exceeded"; costUsd?: number | null };

export interface SearchOptions {
  /** What this search may spend, in US dollars, or null for no cap. Only a Claude web search spends. */
  budgetUsd?: number | null;
}

export interface SearchProvider {
  readonly name: WebSearchMethod;
  search(query: string, signal: AbortSignal, options?: SearchOptions): Promise<SearchOutcome>;
}

export type Fetch = typeof fetch;

/** Whether a Brave Search key is set. Never the key or anything derived from it. */
export function braveKeyConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env[SEARCH_KEY_ENV]?.trim() ?? "") !== "";
}

/** The query as Brave accepts it: single-spaced, within its character and word limits. */
export function searchQuery(topic: string): string {
  const words = topic.replace(/\s+/g, " ").trim().split(" ").slice(0, MAX_QUERY_WORDS).join(" ");
  return Array.from(words).slice(0, MAX_QUERY_CHARS).join("").trim();
}

/** The Brave Search adapter for one key. */
export function braveSearch(key: string, fetchImpl: Fetch): SearchProvider {
  return {
    name: "brave",
    async search(query, signal) {
      const started = Date.now();
      const outcome = await braveRequest(key, query, signal, fetchImpl);
      // Never the query, the key or a result: the outcome, a status class and counts.
      console.info("[research] search", {
        provider: "brave",
        outcome: outcome.result.ok ? "results" : outcome.result.code,
        status: outcome.status,
        results: outcome.result.ok ? outcome.result.urls.length : 0,
        durationMs: Date.now() - started,
      });
      return outcome.result;
    },
  };
}

async function braveRequest(
  key: string,
  query: string,
  signal: AbortSignal,
  fetchImpl: Fetch
): Promise<{ result: SearchOutcome; status: number | null }> {
  // A key a header cannot carry would fail inside fetch; it is refused as a key instead.
  if (!/^[\x21-\x7e]{1,512}$/.test(key)) return { result: { ok: false, code: "search_key_refused" }, status: null };
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(SEARCH_RESULT_COUNT));
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]),
    });
  } catch {
    return { result: { ok: false, code: "search_unavailable" }, status: null };
  }
  // Brave answers an invalid subscription token with 422 (SUBSCRIPTION_TOKEN_INVALID). The query and
  // count this adapter sends are always valid, so a 422 is the token, not the request.
  if (res.status === 401 || res.status === 403 || res.status === 422) {
    return { result: { ok: false, code: "search_key_refused" }, status: res.status };
  }
  if (res.status === 429) return { result: { ok: false, code: "search_rate_limited" }, status: res.status };
  if (res.status !== 200) return { result: { ok: false, code: "search_unavailable" }, status: res.status };
  let body: unknown;
  try {
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return { result: { ok: false, code: "search_unavailable" }, status: res.status };
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { result: { ok: false, code: "search_unavailable" }, status: res.status };
  }
  return { result: { ok: true, urls: resultUrls(body) }, status: res.status };
}

/** The distinct http(s) addresses of the web results, in order; everything else in the reply is ignored. */
export function resultUrls(body: unknown): string[] {
  const results = (body as { web?: { results?: unknown } } | null)?.web?.results;
  if (!Array.isArray(results)) return [];
  return pageUrls(results.map((result) => (result as { url?: unknown } | null)?.url));
}

/**
 * The distinct, well-formed http(s) addresses among `candidates`, in order,
 * at most `SEARCH_RESULT_COUNT`; anything else is dropped. Both search
 * methods' addresses pass through it before research reads a page.
 */
export function pageUrls(candidates: readonly unknown[]): string[] {
  const urls: string[] = [];
  for (const raw of candidates) {
    if (typeof raw !== "string" || raw.length > 2048) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    if (!urls.includes(parsed.href)) urls.push(parsed.href);
    if (urls.length === SEARCH_RESULT_COUNT) break;
  }
  return urls;
}
