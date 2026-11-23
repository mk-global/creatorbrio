"use client";

import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { CarouselResearch, ResearchStage } from "@/types/research";

const STEPS: { stage: ResearchStage; label: string }[] = [
  { stage: "searching", label: "Searching the web" },
  { stage: "reading", label: "Reading the pages" },
  { stage: "synthesizing", label: "Finding what the pages say" },
];

function elapsed(since: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Research in progress (#253): its steps, how long it has run, and Stop. */
export function ResearchProgress({ research, onStop }: { research: CarouselResearch; onStop: () => Promise<void> }) {
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const steps = research.searchProvider ? STEPS : STEPS.filter((s) => s.stage !== "searching");
  const current = steps.findIndex((s) => s.stage === research.stage);

  return (
    <section aria-labelledby="progress" className="mt-8 max-w-[640px] rounded-[14px] bg-sheet p-5 shadow-[inset_0_0_0_1px_var(--color-rule)] sm:p-6">
      <h2 id="progress" className="type-section">
        Researching
      </h2>
      <p className="mt-1 text-[14px] text-graphite">
        Usually one to three minutes. You can leave this page; research goes on, and you can come back to it from the project.
      </p>
      {/* The steps are what change as the run moves on, so they are the live region. Each step is atomic, so a change is announced as its name with its state. */}
      <ol className="mt-5 grid gap-3" aria-live="polite">
        {steps.map((step, i) => {
          const done = current > i;
          const active = current === i;
          return (
            <li key={step.stage} aria-atomic="true" className={`flex items-center gap-3 text-[15px] ${done || active ? "text-ink" : "text-graphite"}`}>
              {done ? (
                <Check className="size-5 text-ink" aria-hidden="true" />
              ) : active ? (
                <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                <span className="size-5 rounded-full shadow-[inset_0_0_0_1.5px_var(--color-rule-strong)]" aria-hidden="true" />
              )}
              <span className={active ? "font-semibold" : undefined}>{step.label}</span>
              <span className="sr-only">{done ? "(done)" : active ? "(in progress)" : "(waiting)"}</span>
            </li>
          );
        })}
      </ol>
      <div className="mt-6 flex items-center justify-between gap-4">
        <span className="num text-[13px] text-graphite">{elapsed(research.startedAt, now)}</span>
        <button
          type="button"
          className="btn btn-quiet btn-sm"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            void onStop().finally(() => setStopping(false));
          }}
        >
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
    </section>
  );
}
