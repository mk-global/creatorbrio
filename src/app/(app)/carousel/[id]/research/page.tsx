"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useApp } from "@/components/app/AppContext";
import { PageNotice } from "@/components/app/PageNotice";
import { useAppStatus } from "@/components/app/useAppStatus";
import { DirectionForm } from "@/components/research/DirectionForm";
import { ResearchFindings } from "@/components/research/ResearchFindings";
import { ResearchProgress } from "@/components/research/ResearchProgress";
import { ResearchStart } from "@/components/research/ResearchStart";
import { useResearch } from "@/components/research/useResearch";
import { brandDisplayName } from "@/lib/brand-display";
import { FORMATS, formatOf } from "@/lib/formats";
import { clearResearchRequest, handOffDesignStart, readResearchRequest } from "@/lib/new-project-handoff";
import type { Carousel } from "@/types/carousel";
import type { CarouselResearch, ResearchDirection } from "@/types/research";

/** Failures that the same request may get past, so "Try again" is offered first. */
const RETRYABLE = new Set(["search_rate_limited", "search_unavailable", "synthesis_failed", "synthesis_timed_out", "interrupted", "cancelled", "research_failed"]);

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * A project's research (#253): ask, follow progress, read what the pages
 * say, and confirm the direction the design is built on. Confirming opens
 * the editor and starts the design; nothing is designed before that.
 */
export default function ResearchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { brands } = useApp();
  const status = useAppStatus();
  const searchConfigured = status ? (status.research?.search.configured ?? false) : null;
  const { state, start, stop, confirm } = useResearch(id);
  const [carousel, setCarousel] = useState<Carousel | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const editorHref = `/carousel/${encodeURIComponent(id)}`;

  useEffect(() => {
    let current = true;
    fetch(`/api/carousels/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<Carousel>) : null))
      .then((c) => current && c && setCarousel(c))
      .catch(() => {
        // The name and brand are context only; research works without them.
      });
    return () => {
      current = false;
    };
  }, [id]);

  // What the New project form asked for: started once, on arrival, when nothing is running yet.
  const [request] = useState(() => readResearchRequest(id));
  useEffect(() => clearResearchRequest(id), [id]);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!request || autoStarted.current || state.status !== "ready" || state.research?.state === "running") return;
    autoStarted.current = true;
    void start(request.topic, request.links).then(setStartError);
  }, [request, state, start]);

  const begin = async (topic: string, links: string[]) => {
    const error = await start(topic, links);
    setStartError(error);
    if (!error) setEditing(false);
  };

  const accept = async (research: CarouselResearch, direction: ResearchDirection) => {
    setConfirming(true);
    setConfirmError(null);
    const result = await confirm(research.revision, direction);
    if (!result.ok) {
      setConfirmError(result.error);
      setConfirming(false);
      return;
    }
    const prefix = carousel ? FORMATS[formatOf(carousel)].composerPrefix : "";
    handOffDesignStart(id, `${prefix}Design it from the confirmed research.`);
    router.push(editorHref);
  };

  const brand = carousel ? brands.find((b) => b.id === carousel.brandId) : undefined;
  const research = state.status === "ready" ? state.research : null;

  return (
    <div className="max-w-[980px]">
      <Link href={editorHref} className="btn btn-ghost btn-sm -ml-2">
        <ArrowLeft className="size-4" aria-hidden="true" /> {carousel ? carousel.name : "Back to the project"}
      </Link>
      <h1 className="type-title mt-3">Research</h1>
      <p className="mt-2 max-w-[66ch] text-graphite">
        {carousel && brand ? (
          <>
            For <span className="font-semibold text-ink">{brandDisplayName(brand)}</span>.{" "}
          </>
        ) : null}
        CreatorBrio reads the pages, shows what they say with quotes, and suggests a direction. You confirm it before anything is designed.
      </p>

      {state.status === "loading" && (
        <p className="mt-8 text-graphite" aria-busy="true">
          Getting the research…
        </p>
      )}
      {state.status === "missing" && (
        <div className="mt-8">
          <PageNotice tone="alert" title="This project doesn't exist" action={<Link href="/projects" className="btn btn-primary btn-sm">Go to projects</Link>}>
            It may have been deleted.
          </PageNotice>
        </div>
      )}
      {state.status === "error" && (
        <div className="mt-8">
          <PageNotice tone="alert" title="The research couldn't be loaded">
            {state.message}
          </PageNotice>
        </div>
      )}

      {state.status === "ready" && (editing || !research || (research.state === "failed" && !research.result)) && !(research?.state === "running") ? (
        <>
          {research?.state === "failed" && !editing && (
            <div className="mt-8">
              <PageNotice
                tone="alert"
                title={research.failure?.code === "cancelled" ? "Research stopped" : "Research didn't finish"}
                action={
                  RETRYABLE.has(research.failure?.code ?? "") ? (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void begin(research.topic, research.links)}>
                      Try again
                    </button>
                  ) : undefined
                }
              >
                {research.failure?.message}
                {research.confirmed && " The direction you confirmed earlier is kept."}
              </PageNotice>
            </div>
          )}
          {(!request || research || startError) && (
            <ResearchStart
              key={research?.revision ?? 0}
              initialTopic={research?.topic ?? request?.topic ?? carousel?.name ?? ""}
              initialLinks={research?.links ?? request?.links ?? []}
              searchConfigured={searchConfigured}
              onStart={begin}
              onCancel={editing ? () => setEditing(false) : undefined}
              editorHref={editorHref}
              error={startError}
            />
          )}
        </>
      ) : null}

      {research?.state === "running" && <ResearchProgress research={research} onStop={stop} />}

      {research?.state === "ready" && research.result && !editing && (
        <ReadyView
          research={research}
          onAgain={() => setEditing(true)}
          onConfirm={(d) => void accept(research, d)}
          confirming={confirming}
          confirmError={confirmError}
        />
      )}
    </div>
  );
}

function ReadyView({
  research,
  onAgain,
  onConfirm,
  confirming,
  confirmError,
}: {
  research: CarouselResearch;
  onAgain: () => void;
  onConfirm: (direction: ResearchDirection) => void;
  confirming: boolean;
  confirmError: string | null;
}) {
  const result = research.result!;
  const confirmedHere = research.confirmed?.revision === research.revision ? research.confirmed : null;
  const designed = research.lastDesign?.revision === research.revision ? research.lastDesign : null;
  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] bg-sheet p-4 shadow-[inset_0_0_0_1px_var(--color-rule)] sm:pl-5">
        <div className="min-w-0">
          <p className="text-[13px] text-graphite">Topic</p>
          <p className="font-semibold break-words">{research.topic}</p>
          <p className="mt-0.5 text-[13px] text-graphite">
            {result.sources.length} {result.sources.length === 1 ? "page" : "pages"} read
            {research.finishedAt && <>, {when(research.finishedAt)}</>}
            {designed && <>. Designed from this direction {when(designed.at)}</>}
            {!designed && confirmedHere && <>. Direction confirmed {when(confirmedHere.confirmedAt)}</>}
          </p>
        </div>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onAgain}>
          Research again
        </button>
      </div>
      {research.confirmed && !confirmedHere && (
        <p className="mt-3 text-[13px] text-graphite">
          You confirmed a direction from earlier research. It stays in use until you confirm this one.
        </p>
      )}

      <div className="mt-10">
        <ResearchFindings result={result} />
      </div>

      <div className="mt-12 border-t border-rule pt-10">
        <DirectionForm
          key={research.revision}
          initial={confirmedHere?.direction ?? result.direction}
          onConfirm={onConfirm}
          confirmLabel={designed ? "Confirm and design again" : "Confirm and create design"}
          busy={confirming}
          error={confirmError}
        />
      </div>
    </div>
  );
}
