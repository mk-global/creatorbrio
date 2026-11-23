import type { Carousel } from "@/types/carousel";
import type {
  CarouselResearch,
  CarouselResearchSource,
  ConfirmedResearch,
  ResearchFailureCode,
  ResearchPageOrigin,
  ResearchStage,
  SearchFailureCode,
  UnreadablePage,
} from "@/types/research";
import { getCarousel, updateCarouselResearch } from "../carousels";
import { resolveBrandForCarousel, isBrandConfigured } from "../brand";
import { isClaudeAvailable } from "../claude-path";
import { isBoundedText } from "../creative-brief";
import { FORMATS, formatOf } from "../formats";
import { isIP } from "node:net";
import { bareHost, isPublicAddress, parseSourceUrl } from "../source-address";
import { retrieveLinks, type SourceOutcome } from "../source-retrieval";
import { parseSpendingCap } from "../spending-cap";
import { now } from "../utils";
import { configuredSearchProvider, searchQuery, type SearchProvider } from "./search";
import {
  RESEARCH_BUDGET_ENV,
  runSynthesis,
  textHash,
  validateDirection,
  type SynthesisFailureCode,
  type SynthesisPage,
  type SynthesisRequest,
  type SynthesisResult,
} from "./synthesis";

/**
 * Topic research for one carousel (#252), run on the server: search (when
 * the person has set a key), read pages through the source-retrieval
 * boundary, synthesize, and store the result on the carousel.
 *
 * A run is a lifecycle the carousel records: running, then ready or failed
 * with a reason the person can act on. One run per carousel at a time, held
 * in this process; a record left "running" by a server that stopped is
 * reported as interrupted the next time it is read, never left running.
 * Every write names the run's revision, so a stale run can never overwrite a
 * newer one. Research never changes slides, the brief or the confirmed
 * direction; only the person's confirm does that.
 */

export const MAX_TOPIC_CHARS = 500;
/** The person's own links per research run, as for a chat message. */
export const MAX_RESEARCH_LINKS = 3;
/** Pages read for one run, the person's links first. */
export const MAX_RESEARCH_PAGES = 5;
/** Search results tried, so a few unreadable ones still leave enough pages. */
export const MAX_SEARCH_CANDIDATES = 8;
/** Search pages kept from one host, so one site cannot be the whole research. */
export const MAX_PAGES_PER_HOST = 2;
/** Characters of each page the model reads; the quote check reads the same text. */
export const RESEARCH_PAGE_CHARS = 12_000;

/** Replaced by tests to script search, retrieval and the model without a network. */
export const researchDeps = {
  searchProvider: (): SearchProvider | null => configuredSearchProvider(),
  retrieveLinks: (links: string[]): Promise<SourceOutcome[]> => retrieveLinks(links),
  synthesize: (request: SynthesisRequest, options: { signal: AbortSignal; carouselId?: string }): Promise<SynthesisResult> =>
    runSynthesis(request, options),
  claudeAvailable: (): boolean => isClaudeAvailable(),
};

export const RESEARCH_FAILURE_MESSAGES: Record<ResearchFailureCode, string> = {
  search_key_refused:
    "Brave Search refused the API key. Check BRAVE_SEARCH_API_KEY in .env.local and restart CreatorBrio, or research from your own links.",
  search_rate_limited:
    "Brave Search is limiting requests, or the key's monthly allowance is used up. Try again in a minute, or research from your own links.",
  search_unavailable: "Brave Search could not be reached. Try again, or research from your own links.",
  no_results: "The search found no pages for this topic. Try a more specific topic, or add links to pages you trust.",
  no_readable_pages:
    "None of the pages could be read, so there is nothing to research from. Try again, or add links to public pages that show their text without a sign-in.",
  claude_unavailable: "Research needs Claude Code on this computer, signed in. Connect it in Settings, then try again.",
  synthesis_failed: "Claude could not turn the pages into findings this time. Try again; your slides and any direction you confirmed are unchanged.",
  synthesis_timed_out: "Reading the pages took longer than the 3-minute limit. Try again, or use fewer or shorter links.",
  budget_exceeded:
    "Research stopped at the spending limit set in RESEARCH_MAX_BUDGET_USD. Raise the limit or use fewer links, then try again.",
  budget_setting_invalid:
    "RESEARCH_MAX_BUDGET_USD in .env.local is not a valid amount. Set a positive number such as 0.50, or remove it, then restart CreatorBrio.",
  cancelled: "You stopped the research. Your slides and any direction you confirmed are unchanged.",
  interrupted: "Research stopped because CreatorBrio was restarted. Start it again.",
  research_failed: "Research failed unexpectedly. Try again; your slides and any direction you confirmed are unchanged.",
};

const SYNTHESIS_FAILURES: Record<Exclude<SynthesisFailureCode, "cancelled">, ResearchFailureCode> = {
  timed_out: "synthesis_timed_out",
  budget_exceeded: "budget_exceeded",
  budget_setting_invalid: "budget_setting_invalid",
  start_failed: "claude_unavailable",
  agent_failed: "synthesis_failed",
  invalid_output: "synthesis_failed",
  // Not a spawn failure: it must never tell the person to sign in to Claude.
  unexpected: "research_failed",
};

// ---------------------------------------------------------------------------
// The process's active runs.

const REGISTRY_KEY = Symbol.for("creatorbrio.research-runs");

interface ActiveRun {
  revision: number;
  controller: AbortController;
  done: Promise<void>;
  /**
   * Set while the "ready" result is being committed. A stop that arrives after
   * that point is answered as "nothing is running" instead of 202, so a stop
   * the person was told was accepted never ends as a finished run. It lives on
   * the registry entry, which every copy of this module shares, as the run does.
   */
  sealed: boolean;
}

function active(): Map<string, ActiveRun> {
  const store = globalThis as typeof globalThis & { [REGISTRY_KEY]?: ReturnType<typeof active> };
  store[REGISTRY_KEY] ??= new Map();
  return store[REGISTRY_KEY];
}

/** Whether this process is researching for the carousel. */
export const isResearching = (carouselId: string) => active().has(carouselId);

/** Resolves when the carousel's current run, if any, has stored its outcome. For tests and shutdown. */
export async function researchSettled(carouselId: string): Promise<void> {
  await active().get(carouselId)?.done;
}

// ---------------------------------------------------------------------------
// Start, read, cancel, confirm.

export type ResearchResponse =
  | { ok: true; research: CarouselResearch | null }
  | { ok: false; status: 400 | 404 | 409; error: string };

class ResearchRequestError extends Error {}

function parseStart(body: unknown): { topic: string; links: string[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ResearchRequestError("Send a topic to research.");
  const { topic, links = [] } = body as Record<string, unknown>;
  if (!isBoundedText(topic, MAX_TOPIC_CHARS) || topic.trim().length < 3) {
    throw new ResearchRequestError(`Describe the topic in 3 to ${MAX_TOPIC_CHARS} characters.`);
  }
  if (!Array.isArray(links) || links.length > MAX_RESEARCH_LINKS) {
    throw new ResearchRequestError(`Give at most ${MAX_RESEARCH_LINKS} links.`);
  }
  const cleaned: string[] = [];
  for (const link of links) {
    if (typeof link !== "string" || link.length > 2048) throw new ResearchRequestError("Each link must be a web address.");
    const parsed = parseSourceUrl(link.trim());
    // An address that is plainly private is refused now; a name is checked when the page is read.
    const literal = parsed.ok ? bareHost(parsed.url) : "";
    if (!parsed.ok || (isIP(literal) !== 0 && !isPublicAddress(literal))) {
      throw new ResearchRequestError(`This link cannot be read: ${link.trim().slice(0, 80)}. Use a public http or https address.`);
    }
    if (!cleaned.includes(parsed.url.href)) cleaned.push(parsed.url.href);
  }
  return { topic: topic.trim().replace(/\s+/g, " "), links: cleaned };
}

/**
 * Starts a research run and returns its "running" record at once; the run
 * goes on in this process. Refused while one runs for the carousel.
 */
export async function startResearch(carouselId: string, body: unknown): Promise<ResearchResponse> {
  let input: { topic: string; links: string[] };
  try {
    input = parseStart(body);
  } catch (err) {
    if (err instanceof ResearchRequestError) return { ok: false, status: 400, error: err.message };
    throw err;
  }
  const provider = researchDeps.searchProvider();
  if (!provider && input.links.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Web search is not set up, so research needs at least one link. Add links to pages about the topic, or set up Brave Search (see Settings).",
    };
  }
  if (!researchDeps.claudeAvailable()) return { ok: false, status: 400, error: RESEARCH_FAILURE_MESSAGES.claude_unavailable };
  // An invalid cap is refused before search or retrieval run, not after the pages were read; synthesis checks it again.
  if (!parseSpendingCap(process.env[RESEARCH_BUDGET_ENV]).ok) {
    return { ok: false, status: 400, error: RESEARCH_FAILURE_MESSAGES.budget_setting_invalid };
  }
  const carousel = await getCarousel(carouselId);
  if (!carousel || carousel.isTemplate) return { ok: false, status: 404, error: "Project not found." };

  // The check and the reservation happen together, so two requests cannot both start.
  const runs = active();
  if (runs.has(carouselId)) return { ok: false, status: 409, error: "Research is already running for this project. Wait for it, or stop it." };
  const controller = new AbortController();
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const entry: ActiveRun = { revision: -1, controller, done, sealed: false };
  runs.set(carouselId, entry);

  try {
    const stored = await updateCarouselResearch(carouselId, (current) => ({
      revision: (current?.revision ?? 0) + 1,
      topic: input.topic,
      links: input.links,
      state: "running",
      stage: provider ? "searching" : "reading",
      searchProvider: provider ? provider.name : null,
      startedAt: now(),
      // The confirmed direction and the latest design are kept: a new run changes neither.
      ...(current?.confirmed ? { confirmed: current.confirmed } : {}),
      ...(current?.lastDesign ? { lastDesign: current.lastDesign } : {}),
    }));
    if (!stored?.research) {
      runs.delete(carouselId);
      release();
      return { ok: false, status: 404, error: "Project not found." };
    }
    const revision = stored.research.revision;
    entry.revision = revision;
    console.info("[research] started", { carouselId, revision, provider: provider?.name ?? null, links: input.links.length });
    void execute(carousel, revision, input, provider, entry).finally(() => {
      if (runs.get(carouselId)?.controller === controller) runs.delete(carouselId);
      release();
    });
    return { ok: true, research: stored.research };
  } catch (err) {
    runs.delete(carouselId);
    release();
    throw err;
  }
}

/** The carousel's research, with a run this process no longer holds reported as interrupted. */
export async function readResearch(carouselId: string): Promise<ResearchResponse> {
  const carousel = await getCarousel(carouselId);
  if (!carousel || carousel.isTemplate) return { ok: false, status: 404, error: "Project not found." };
  const research = carousel.research;
  if (research?.state !== "running" || isResearching(carouselId)) return { ok: true, research: research ?? null };
  const stored = await updateCarouselResearch(carouselId, (current) =>
    current?.state === "running" && current.revision === research.revision && !isResearching(carouselId)
      ? failed(current, "interrupted")
      : undefined
  );
  if (stored?.research?.state === "failed") console.info("[research] interrupted", { carouselId, revision: research.revision });
  return { ok: true, research: stored?.research ?? null };
}

/** Stops the carousel's running research. Returns false when none was running here, or when it is already committing its result. */
export function cancelResearch(carouselId: string): boolean {
  const run = active().get(carouselId);
  if (!run || run.sealed) return false;
  run.controller.abort();
  return true;
}

/**
 * The person confirms a direction (their edit of the suggestion, or the
 * suggestion as it is) for the latest ready revision. A workflow step, not a
 * binding approval (FQ-11). The snapshot is what every later design works
 * from, until the person confirms another.
 */
export async function confirmResearch(carouselId: string, body: unknown): Promise<ResearchResponse> {
  const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const revision = fields.revision;
  const direction = validateDirection(fields.direction);
  if (!Number.isInteger(revision)) return { ok: false, status: 400, error: "Say which research revision you are confirming." };
  if (!direction) {
    return {
      ok: false,
      status: 400,
      error: "Fill in the angle, audience and central message (up to 300 characters each) and one to eight key points (up to 200 characters each).",
    };
  }
  let refusal = null as ResearchResponse | null;
  const stored = await updateCarouselResearch(carouselId, (current) => {
    if (!current || current.revision !== revision || current.state !== "ready" || !current.result) {
      refusal = {
        ok: false,
        status: 409,
        error: "This research has changed since you opened it. Review the latest research, then confirm again.",
      };
      return undefined;
    }
    const suggested = current.result.direction;
    const confirmed: ConfirmedResearch = {
      revision: current.revision,
      confirmedAt: now(),
      topic: current.topic,
      direction,
      edited: JSON.stringify(direction) !== JSON.stringify(suggested),
      sources: current.result.sources,
      findings: current.result.findings,
    };
    return { ...current, confirmed };
  });
  if (!stored) return { ok: false, status: 404, error: "Project not found." };
  if (refusal) return refusal;
  console.info("[research] confirmed", { carouselId, revision, edited: stored.research?.confirmed?.edited ?? false });
  return { ok: true, research: stored.research ?? null };
}

/** Records the confirmed revision a design run worked from (the creative run calls it as design starts). */
export async function recordResearchDesign(carouselId: string, revision: number, runId: string): Promise<void> {
  await updateCarouselResearch(carouselId, (current) =>
    current?.confirmed?.revision === revision ? { ...current, lastDesign: { revision, runId, at: now() } } : undefined
  );
}

// ---------------------------------------------------------------------------
// The run.

class Failure extends Error {
  readonly code: ResearchFailureCode;
  constructor(code: ResearchFailureCode) {
    super(code);
    this.code = code;
  }
}

/** The record without a run's in-progress or outcome fields, ready for its next state. */
function settledFields(current: CarouselResearch): CarouselResearch {
  const next = { ...current };
  delete next.stage;
  delete next.result;
  delete next.failure;
  return next;
}

function failed(current: CarouselResearch, code: ResearchFailureCode): CarouselResearch {
  return { ...settledFields(current), state: "failed", finishedAt: now(), failure: { code, message: RESEARCH_FAILURE_MESSAGES[code] } };
}

/** Writes only while the record is still this run's, so a stale run never overwrites a newer one. */
function writeIfCurrent(carouselId: string, revision: number, change: (current: CarouselResearch) => CarouselResearch) {
  return updateCarouselResearch(carouselId, (current) =>
    current && current.revision === revision && current.state === "running" ? change(current) : undefined
  );
}

const setStage = (carouselId: string, revision: number, stage: ResearchStage) =>
  writeIfCurrent(carouselId, revision, (current) => ({ ...current, stage }));

/** The pages to read: the person's links first, then search results, without repeats. */
export function candidatePages(links: string[], searchUrls: string[]): { url: string; origin: ResearchPageOrigin }[] {
  const seen = new Set<string>();
  const pages: { url: string; origin: ResearchPageOrigin }[] = [];
  for (const url of links) {
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push({ url, origin: "link" });
  }
  let fromSearch = 0;
  for (const url of searchUrls) {
    if (fromSearch === MAX_SEARCH_CANDIDATES) break;
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push({ url, origin: "search" });
    fromSearch++;
  }
  return pages;
}

/** The readable pages to research from, in order, within the page and per-host limits. */
export function selectPages(
  candidates: { url: string; origin: ResearchPageOrigin }[],
  outcomes: SourceOutcome[]
): { pages: SynthesisPage[]; unreadable: UnreadablePage[] } {
  const pages: SynthesisPage[] = [];
  const unreadable: UnreadablePage[] = [];
  const perHost = new Map<string, number>();
  candidates.forEach((candidate, i) => {
    const outcome = outcomes[i];
    if (!outcome) return;
    if (!outcome.ok) {
      // Brave's terms forbid keeping search results: the host of a search page that failed is not stored.
      unreadable.push({ host: candidate.origin === "link" ? outcome.host : "", origin: candidate.origin, reason: outcome.reason });
      return;
    }
    if (pages.length === MAX_RESEARCH_PAGES) return;
    const host = outcome.host.replace(/^www\./, "");
    if (candidate.origin === "search" && (perHost.get(host) ?? 0) >= MAX_PAGES_PER_HOST) return;
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    const chars = Array.from(outcome.text);
    const cut = chars.length > RESEARCH_PAGE_CHARS;
    pages.push({
      id: `S${pages.length + 1}`,
      url: outcome.url,
      host: outcome.host,
      title: outcome.title.slice(0, 200),
      text: cut ? chars.slice(0, RESEARCH_PAGE_CHARS).join("") : outcome.text,
      truncated: outcome.truncated || cut,
      origin: candidate.origin,
    });
  });
  return { pages, unreadable };
}

/** Settles with `work`, or throws "cancelled" as soon as the run is stopped; reading has its own stage limit. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Failure("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Failure("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => (signal.removeEventListener("abort", onAbort), resolve(value)),
      (err) => (signal.removeEventListener("abort", onAbort), reject(err))
    );
  });
}

async function execute(
  carousel: Carousel,
  revision: number,
  input: { topic: string; links: string[] },
  provider: SearchProvider | null,
  run: ActiveRun
): Promise<void> {
  const { signal } = run.controller;
  const carouselId = carousel.id;
  const started = Date.now();
  const usage = { costUsd: null as number | null, durationMs: 0, searchRequests: 0, pagesRead: 0 };
  const finish = () => ({ ...usage, durationMs: Date.now() - started });
  let outcome: ResearchFailureCode | "ready" = "research_failed";
  try {
    let searchUrls: string[] = [];
    let searchFailure: SearchFailureCode | undefined;
    if (provider) {
      usage.searchRequests++;
      const found = await provider.search(searchQuery(input.topic), signal);
      if (signal.aborted) throw new Failure("cancelled");
      // The person's own links are worth reading even when search fails; without them there is nothing to read.
      if (!found.ok && input.links.length === 0) throw new Failure(found.code);
      if (!found.ok) searchFailure = found.code;
      else searchUrls = found.urls;
      if (searchUrls.length === 0 && input.links.length === 0) throw new Failure("no_results");
      await setStage(carouselId, revision, "reading");
    }

    const candidates = candidatePages(input.links, searchUrls);
    const outcomes = await untilAborted(researchDeps.retrieveLinks(candidates.map((c) => c.url)), signal);
    const { pages, unreadable } = selectPages(candidates, outcomes);
    usage.pagesRead = pages.length;
    if (pages.length === 0) throw new Failure("no_readable_pages");

    await setStage(carouselId, revision, "synthesizing");
    const brand = await resolveBrandForCarousel(carousel).catch(() => null);
    // A stop that arrived while the pages were read or the stage was written must not start a paid call.
    if (signal.aborted) throw new Failure("cancelled");
    const synthesis = await researchDeps.synthesize(
      {
        topic: input.topic,
        formatName: FORMATS[formatOf(carousel)].name,
        brand: brand && isBrandConfigured(brand) ? { name: brand.name, styleKeywords: brand.styleKeywords.slice(0, 8) } : null,
        pages,
      },
      { signal, carouselId }
    );
    usage.costUsd = synthesis.usage.costUsd;
    if (!synthesis.ok) throw new Failure(synthesis.code === "cancelled" ? "cancelled" : SYNTHESIS_FAILURES[synthesis.code]);

    const retrievedAt = now();
    const sources: CarouselResearchSource[] = pages.map((page) => ({
      id: page.id,
      kind: "url",
      url: page.url,
      host: page.host,
      title: page.title || page.host,
      retrievedAt,
      blob: textHash(page.text),
      reliability: "unverified",
      retrievedBy: "source-retrieval",
      origin: page.origin,
    }));
    await writeIfCurrent(carouselId, revision, (current) => {
      // Checked inside the write, which nothing can interleave with: a stop answered before this point always wins.
      if (signal.aborted) throw new Failure("cancelled");
      run.sealed = true;
      return {
        ...settledFields(current),
        state: "ready",
        finishedAt: now(),
        result: {
          sources,
          findings: synthesis.output.findings,
          gaps: synthesis.output.gaps,
          direction: synthesis.output.direction,
          unreadable,
          ...(searchFailure ? { searchFailure } : {}),
        },
        usage: finish(),
      };
    });
    outcome = "ready";
    console.info("[research] finished", {
      carouselId,
      revision,
      outcome,
      ...finish(),
      unreadable: unreadable.length,
      searchFailure: searchFailure ?? null,
      findings: synthesis.output.findings.length,
      quoted: synthesis.output.findings.filter((f) => f.check === "quoted").length,
    });
  } catch (err) {
    outcome = err instanceof Failure ? err.code : signal.aborted ? "cancelled" : "research_failed";
    const code = outcome;
    await writeIfCurrent(carouselId, revision, (current) => ({ ...failed(current, code), usage: finish() })).catch((writeErr) => {
      console.error("[research] could not record the outcome", { carouselId, revision, outcome: code, err: writeErr instanceof Error ? writeErr.name : "unknown" });
    });
    // Expected outcomes are not system errors; an unexpected exception is. A research_failed that came from a synthesis
    // result is a Failure of ours here: synthesis already logged its real cause at error, so this line is information.
    const fields = { carouselId, revision, outcome: code, ...finish() };
    if (code === "research_failed" && !(err instanceof Failure)) {
      console.error("[research] finished", { ...fields, err: err instanceof Error ? err.name : "unknown" });
    } else console.info("[research] finished", fields);
  }
}
