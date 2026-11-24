import { SEARCH_KEY_ENV, braveSearch, type Fetch, type SearchProvider } from "./search";
import { claudeWebSearch } from "./web-search";

/**
 * The web searches research tries, in order (#256): Brave Search when the
 * person has set a key, then Claude's own web search when Claude Code is
 * available. Research moves to the next one only when a search fails, never
 * when it finds nothing. An empty list means research can read only the
 * person's links. There is no setting: the configuration decides.
 */
export function configuredSearchProviders(options: {
  claudeAvailable: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: Fetch;
}): SearchProvider[] {
  const key = (options.env ?? process.env)[SEARCH_KEY_ENV]?.trim() ?? "";
  return [...(key ? [braveSearch(key, options.fetchImpl ?? fetch)] : []), ...(options.claudeAvailable ? [claudeWebSearch()] : [])];
}
