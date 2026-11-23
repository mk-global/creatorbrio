"use client";

import type { ConfirmedResearch } from "@/types/research";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * The direction in use (#253): what the person confirmed from earlier
 * research, with the quoted findings and the sources the design was given.
 * Shown whenever the screen shows a different run, so the references behind
 * the slides are never out of sight.
 */
export function ConfirmedSummary({ confirmed }: { confirmed: ConfirmedResearch }) {
  const quoted = confirmed.findings.filter((f) => f.check === "quoted");
  const cited = new Set(quoted.flatMap((f) => f.evidence.map((e) => e.sourceId)));
  const sources = confirmed.sources.filter((s) => cited.has(s.id));
  return (
    <details className="mt-6 max-w-[760px] rounded-[14px] bg-sheet p-4 shadow-[inset_0_0_0_1px_var(--color-rule)] sm:px-5">
      <summary className="cursor-pointer font-semibold">
        Direction in use, confirmed {when(confirmed.confirmedAt)}: <span className="font-normal break-words">{confirmed.direction.angle}</span>
      </summary>
      <div className="mt-4 space-y-4 text-[14.5px]">
        <p>
          <span className="text-graphite">Central message: </span>
          <span className="break-words">{confirmed.direction.centralMessage}</span>
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          {confirmed.direction.keyPoints.map((p, i) => (
            <li key={i} className="break-words">
              {p}
            </li>
          ))}
        </ol>
        {quoted.length > 0 && (
          <div>
            <p className="text-graphite">Findings the design was given</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {quoted.map((f) => (
                <li key={f.id} className="break-words">
                  {f.text} <span className="text-graphite">({f.evidence.map((e) => e.sourceId).join(", ")})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {sources.length > 0 && (
          <ul className="space-y-1">
            {sources.map((s) => (
              <li key={s.id} className="break-words">
                <span className="num mr-2 text-[13px] font-semibold text-graphite">{s.id}</span>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
                  {s.title}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>{" "}
                <span className="text-[13px] text-graphite">{s.host}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
