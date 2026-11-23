"use client";

import { ExternalLink, Quote } from "lucide-react";
import type { CarouselResearchSource, ResearchFinding, ResearchResult } from "@/types/research";

/** Why a page could not be read, in words a person can act on. */
const UNREADABLE: Record<string, string> = {
  http_status: "the site answered with an error",
  unsupported_content_type: "it is not a web page",
  too_large: "it is too large",
  timed_out: "it took too long",
  stage_timed_out: "reading ran out of time",
  too_little_text: "it has too little text",
  network_error: "it could not be reached",
  unresolvable_host: "the site could not be found",
  non_public_address: "it is not on the public web",
  too_many_redirects: "it redirects too many times",
};

function SourceLabel({ source }: { source: CarouselResearchSource | undefined }) {
  if (!source) return null;
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-6 items-center gap-1 text-[13px] font-semibold text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
    >
      {source.id} · {source.host}
      <ExternalLink className="size-3.5" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function FindingItem({ finding, sources }: { finding: ResearchFinding; sources: Map<string, CarouselResearchSource> }) {
  return (
    <li className="rounded-[12px] bg-sheet p-4 shadow-[inset_0_0_0_1px_var(--color-rule)]">
      <p className="text-[15px] leading-snug font-semibold break-words">
        {finding.text}
        {finding.sensitive && (
          <span className="ml-2 inline-block rounded-full bg-hover px-2 py-0.5 align-middle text-[12px] font-semibold text-graphite">
            Health, money, law or safety
          </span>
        )}
      </p>
      {finding.evidence.map((e) => (
        <figure key={e.sourceId} className="mt-3">
          <blockquote className="flex gap-2 text-[14px] text-ink/80">
            <Quote className="mt-0.5 size-4 shrink-0 text-graphite" aria-hidden="true" />
            <span className="break-words">{e.quote}</span>
          </blockquote>
          <figcaption className="mt-1 pl-6">
            <SourceLabel source={sources.get(e.sourceId)} />
          </figcaption>
        </figure>
      ))}
    </li>
  );
}

/** What research found (#253): findings with their quotes, what it could not establish, and every page it read. */
export function ResearchFindings({ result }: { result: ResearchResult }) {
  const sources = new Map(result.sources.map((s) => [s.id, s]));
  const quoted = result.findings.filter((f) => f.check === "quoted");
  const unchecked = result.findings.filter((f) => f.check !== "quoted");
  return (
    <div className="space-y-10">
      <section aria-labelledby="findings">
        <h2 id="findings" className="type-section">
          Findings quoted in a source
        </h2>
        <p className="mt-1 max-w-[70ch] text-[14px] text-graphite">
          CreatorBrio found each quote word for word in the page it names. That shows the words are there, not that the finding is true: open the
          source when it matters.
        </p>
        {quoted.length > 0 ? (
          <ul className="mt-4 grid gap-3">
            {quoted.map((f) => (
              <FindingItem key={f.id} finding={f} sources={sources} />
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-graphite">None of the findings could be matched to a quote. Try other links or a more specific topic.</p>
        )}
      </section>

      {unchecked.length > 0 && (
        <section aria-labelledby="unchecked">
          <h2 id="unchecked" className="type-section">
            Not checked
          </h2>
          <p className="mt-1 max-w-[70ch] text-[14px] text-graphite">
            Their quotes were not found in the pages, so they are left out of the design. Check them yourself before using them.
          </p>
          <ul className="mt-4 grid list-disc gap-1.5 pl-5 text-[14.5px]">
            {unchecked.map((f) => (
              <li key={f.id} className="break-words">
                {f.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.gaps.length > 0 && (
        <section aria-labelledby="gaps">
          <h2 id="gaps" className="type-section">
            What the pages don&apos;t establish
          </h2>
          <ul className="mt-3 grid list-disc gap-1.5 pl-5 text-[14.5px]">
            {result.gaps.map((g, i) => (
              <li key={i} className="break-words">
                {g}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="sources">
        <h2 id="sources" className="type-section">
          Sources
        </h2>
        <ol className="mt-3 grid gap-2.5">
          {result.sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="num w-7 shrink-0 text-[13px] font-semibold text-graphite">{s.id}</span>
              <span className="min-w-0 flex-[1_1_320px]">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold break-words underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
                >
                  {s.title}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <span className="block text-[13px] text-graphite">
                  {s.host} · {s.origin === "link" ? "your link" : "found by search"}
                </span>
              </span>
            </li>
          ))}
        </ol>
        {result.unreadable.length > 0 && (
          <p className="mt-4 max-w-[70ch] text-[13px] text-graphite">
            Not read:{" "}
            {result.unreadable.map((u, i) => (
              <span key={i}>
                {i > 0 && "; "}
                {/* The host of a search result is not kept (Brave's terms), only that one could not be read. */}
                {u.origin === "link" && u.host
                  ? `${u.host} (your link, ${UNREADABLE[u.reason] ?? "it could not be read"})`
                  : `a search result (${UNREADABLE[u.reason] ?? "it could not be read"})`}
              </span>
            ))}
            .
          </p>
        )}
      </section>
    </div>
  );
}
