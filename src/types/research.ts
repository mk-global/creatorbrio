/**
 * Research types shared by Video Studio productions and carousels (#252).
 *
 * The dossier types below were lifted unchanged from Production v2
 * (`./production` re-exports them). Carousel research reuses the source type
 * and adds what a carousel needs: where each page came from, findings whose
 * check the server made itself, a suggested content direction, and the
 * snapshot the person confirmed. Its rules live in `src/lib/research/`.
 */

// ---------------------------------------------------------------------------
// The research dossier (Production v2)

export const SOURCE_KINDS = ["url", "document", "user-note"] as const;
export const SOURCE_RELIABILITY = ["primary", "reputable-secondary", "unverified"] as const;
export const CLAIM_STATUSES = ["supported", "unsupported", "disputed", "user-asserted"] as const;

export interface ResearchDossier {
  questions: string[];
  sources: ResearchSource[];
  claims: Claim[];
  status: "draft" | "reviewed";
}

export interface ResearchSource {
  id: string;
  kind: (typeof SOURCE_KINDS)[number];
  url?: string;
  title: string;
  publisher?: string;
  retrievedAt: string;
  /**
   * SHA-256 of the text extracted from the source. A production keeps that
   * text as a side file; carousel research stores only the hash.
   */
  blob: string;
  reliability: (typeof SOURCE_RELIABILITY)[number];
  retrievedBy: "user" | "source-retrieval";
}

export interface Claim {
  id: string;
  text: string;
  sourceIds: string[];
  status: (typeof CLAIM_STATUSES)[number];
  /** Health, finance or legal: needs care on screen. */
  sensitive: boolean;
}

// ---------------------------------------------------------------------------
// Carousel research (#252)

/** Who chose a page: the person, as one of their links, or the search. */
export type ResearchPageOrigin = "link" | "search";

/**
 * A page CreatorBrio read itself. Search results are never stored (Brave's
 * terms); only pages the server fetched are. `kind` is always "url",
 * `retrievedBy` always "source-retrieval" and `reliability` always
 * "unverified": CreatorBrio does not rate a source.
 */
export interface CarouselResearchSource extends ResearchSource {
  url: string;
  host: string;
  origin: ResearchPageOrigin;
}

/**
 * "quoted": the server found the finding's quoted words in the text it gave
 * the model for each named source. That shows the words are on the page, not
 * that the finding follows from them, so it is never called verified.
 * "unchecked": anything else; it never reaches a design run as a fact.
 */
export const FINDING_CHECKS = ["quoted", "unchecked"] as const;
export type FindingCheck = (typeof FINDING_CHECKS)[number];

export interface ResearchFinding {
  id: string;
  text: string;
  check: FindingCheck;
  /** For a quoted finding, each source and the exact words found in it; empty when unchecked. */
  evidence: { sourceId: string; quote: string }[];
  /** Health, finance or legal: needs care on screen. */
  sensitive: boolean;
}

/** The suggested content direction, which the person may edit before confirming. */
export interface ResearchDirection {
  angle: string;
  audience: string;
  centralMessage: string;
  keyPoints: string[];
  /** Empty when there is none. */
  callToAction: string;
}

export interface UnreadablePage {
  host: string;
  origin: ResearchPageOrigin;
  /**
   * Why it could not be read: a `SourceUnavailableReason` of
   * `src/lib/source-retrieval.ts`. Typed as a string so this types module
   * stays free of library imports.
   */
  reason: string;
}

export interface ResearchResult {
  sources: CarouselResearchSource[];
  findings: ResearchFinding[];
  /** What the research could not establish from the pages it read. */
  gaps: string[];
  direction: ResearchDirection;
  /** Pages that could not be read; the run went on without them. */
  unreadable: UnreadablePage[];
  /**
   * Why web search failed when the run went on with the person's own links
   * alone; absent when search worked or was not set up.
   */
  searchFailure?: SearchFailureCode;
}

export type SearchFailureCode = "search_key_refused" | "search_rate_limited" | "search_unavailable";

export const RESEARCH_STAGES = ["searching", "reading", "synthesizing"] as const;
export type ResearchStage = (typeof RESEARCH_STAGES)[number];

export type ResearchFailureCode =
  | "search_key_refused"
  | "search_rate_limited"
  | "search_unavailable"
  | "no_results"
  | "no_readable_pages"
  | "claude_unavailable"
  | "synthesis_failed"
  | "synthesis_timed_out"
  | "budget_exceeded"
  | "budget_setting_invalid"
  | "cancelled"
  | "interrupted"
  | "research_failed";

export interface ResearchUsage {
  /** The model's estimated cost for synthesis, as the CLI reports it. */
  costUsd: number | null;
  durationMs: number;
  searchRequests: number;
  pagesRead: number;
}

/** What the person confirmed: kept apart, so researching again never changes it. */
export interface ConfirmedResearch {
  revision: number;
  confirmedAt: string;
  topic: string;
  direction: ResearchDirection;
  /** Whether the person changed the suggested direction before confirming. */
  edited: boolean;
  sources: CarouselResearchSource[];
  findings: ResearchFinding[];
}

/** A carousel's research. Server-owned: no request body writes it directly. */
export interface CarouselResearch {
  /** Increases with every research run on this carousel. */
  revision: number;
  topic: string;
  links: string[];
  state: "running" | "ready" | "failed";
  stage?: ResearchStage;
  /** The search provider this run used, or null for the person's links only. */
  searchProvider: "brave" | null;
  startedAt: string;
  finishedAt?: string;
  result?: ResearchResult;
  failure?: { code: ResearchFailureCode; message: string };
  usage?: ResearchUsage;
  confirmed?: ConfirmedResearch;
  /** The confirmed revision the carousel's latest design run worked from, and that run. */
  lastDesign?: { revision: number; runId: string; at: string };
}
