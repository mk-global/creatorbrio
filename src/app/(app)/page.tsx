"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useApp } from "@/components/app/AppContext";
import { Swatches } from "@/components/app/BrandSwitcher";
import { BrandsUnavailable, PageNotice } from "@/components/app/PageNotice";
import { useAppStatus } from "@/components/app/useAppStatus";
import { BrandPanel } from "@/components/home/BrandPanel";
import { FormatStage } from "@/components/home/FormatStage";
import { StudioPanel } from "@/components/home/StudioPanel";
import { ProjectFrame } from "@/components/library/ProjectFrame";
import { HOME_GRID, LARGE_FH, ProjectTile, SMALL_FH } from "@/components/library/ProjectTile";
import { templateBrandId, templateFirstSlide, useProjects, useTemplates } from "@/components/library/useLibrary";
import { brandDisplayName, brandIsSetUp } from "@/lib/brand-display";
import { countLabel, FORMATS, formatOf, PROJECT_FORMATS, type ProjectFormat } from "@/lib/formats";
import { handOffIdea } from "@/lib/new-project-handoff";

const linkCls =
  "inline-flex min-h-8 shrink-0 items-center text-[14px] font-semibold underline decoration-rule-strong underline-offset-4 hover:decoration-ink";

function SectionHead({ id, title, link }: { id: string; title: string; link?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <h2 id={id} className="type-section">
        {title}
      </h2>
      {link}
    </div>
  );
}

export default function Home() {
  const { selectedBrand, defaultBrandId, error: brandError, reload: reloadBrands } = useApp();
  const status = useAppStatus();
  const projects = useProjects();
  const templates = useTemplates();
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [ideaFormat, setIdeaFormat] = useState<ProjectFormat>("instagram-carousel");

  const all = useMemo(() => (projects.state.status === "ready" ? projects.state.items : []), [projects.state]);
  const mine = selectedBrand ? all.filter((p) => p.brandId === selectedBrand.id) : [];
  const myTemplates =
    selectedBrand && templates.state.status === "ready"
      ? templates.state.items.filter((t) => templateBrandId(t, defaultBrandId) === selectedBrand.id)
      : [];

  if (brandError) return <BrandsUnavailable message={brandError} onRetry={() => void reloadBrands()} />;

  return (
    <div className="space-y-14 lg:space-y-20">
      {status && !status.claude.available && (
        <PageNotice
          tone="alert"
          title="Claude Code isn't connected"
          action={
            <Link href="/settings#claude" className="btn btn-quiet btn-sm">
              How to connect
            </Link>
          }
        >
          You can still open, arrange and export existing work. Designing new slides needs Claude Code on this computer.
        </PageNotice>
      )}

      <section aria-labelledby="make">
        <p className="flex min-h-6 flex-wrap items-center gap-2 text-[14px] text-graphite">
          {selectedBrand && (
            <>
              Creating for
              <span className="inline-flex items-center gap-2 font-semibold text-ink">
                <Swatches brand={selectedBrand} size={11} />
                {brandDisplayName(selectedBrand)}
              </span>
            </>
          )}
        </p>
        <h1 id="make" className="type-hero mt-2">
          What do you want to make?
        </h1>

        {selectedBrand && !brandIsSetUp(selectedBrand) && (
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4 rounded-[14px] bg-sheet p-5 shadow-[inset_0_0_0_1px_var(--color-rule)] sm:p-6">
            <div className="min-w-0 flex-[1_1_320px]">
              <h2 className="type-section">Set up your brand first</h2>
              <p className="mt-1 max-w-[60ch] text-graphite">
                A name, five colours, two fonts and a few words about your style. It takes about a minute, and every design uses it.
              </p>
            </div>
            <Link href={`/brands/${encodeURIComponent(selectedBrand.id)}`} className="btn btn-primary">
              Set up brand
            </Link>
          </div>
        )}

        <div className="mt-10 min-h-[300px] lg:mt-12">{selectedBrand && <FormatStage brand={selectedBrand} projects={all} />}</div>

        <form
          className="mt-12 flex max-w-[860px] flex-col gap-2 rounded-[14px] bg-sheet p-2 shadow-[inset_0_0_0_1px_var(--color-field)] sm:flex-row sm:items-center"
          onSubmit={(e) => {
            e.preventDefault();
            handOffIdea(idea.trim());
            router.push(`/create?format=${ideaFormat}&from=idea`);
          }}
        >
          <label htmlFor="idea" className="sr-only">
            Describe an idea
          </label>
          <input
            id="idea"
            className="h-11 w-full min-w-0 shrink-0 rounded-lg px-3 text-[15px] outline-none placeholder:text-placeholder focus-visible:shadow-[inset_0_0_0_2px_var(--color-ink)] sm:w-auto sm:flex-1"
            placeholder="Or start from an idea: three small habits for a calmer morning"
            value={idea}
            maxLength={2000}
            onChange={(e) => setIdea(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <label htmlFor="idea-format" className="sr-only">
              Format
            </label>
            <select
              id="idea-format"
              className="field h-11 w-auto min-w-0 flex-[1_1_150px] pr-8 text-[14px] sm:flex-none"
              value={ideaFormat}
              onChange={(e) => setIdeaFormat(e.target.value as ProjectFormat)}
            >
              {PROJECT_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FORMATS[f].name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-create h-11 flex-[1_1_auto] sm:flex-none" disabled={!idea.trim()}>
              Set up project
            </button>
          </div>
        </form>
        <p className="mt-2 pl-1 text-[13px] text-graphite">Nothing is designed until you press Send in the editor.</p>
      </section>

      <section aria-labelledby="recent">
        <SectionHead
          id="recent"
          title="Continue creating"
          link={
            mine.length > 0 ? (
              <Link href="/projects" className={linkCls}>
                All {mine.length} {mine.length === 1 ? "project" : "projects"}
              </Link>
            ) : undefined
          }
        />
        <div className="mt-6">
          {projects.state.status === "error" ? (
            <PageNotice
              tone="alert"
              title="Your projects couldn't be loaded"
              action={
                <button type="button" className="btn btn-quiet btn-sm" onClick={projects.reload}>
                  Try again
                </button>
              }
            >
              {projects.state.message} Nothing was deleted, and you can still start something new above.
            </PageNotice>
          ) : projects.state.status === "loading" || !selectedBrand ? (
            <p className="text-graphite" aria-busy="true">
              Reading your projects…
            </p>
          ) : mine.length === 0 ? (
            <p className="max-w-[60ch] text-graphite">
              Projects you make for {brandDisplayName(selectedBrand)} appear here. Pick a format above to start the first one.
            </p>
          ) : (
            <ul className={HOME_GRID}>
              {mine.slice(0, 4).map((p) => (
                <li key={p.id} className="min-w-0">
                  <ProjectTile
                    project={p}
                    size={LARGE_FH}
                    onDuplicated={projects.reload}
                    onDeleted={(id) => projects.update((items) => items.filter((x) => x.id !== id))}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {myTemplates.length > 0 && (
        <section aria-labelledby="home-templates">
          <SectionHead
            id="home-templates"
            title="Start from a template"
            link={
              <Link href="/templates" className={linkCls}>
                All templates
              </Link>
            }
          />
          <ul className={`mt-6 ${HOME_GRID}`}>
            {myTemplates.slice(0, 4).map((t) => {
              const format = formatOf(t);
              return (
                <li key={t.id} className={`@container min-w-0 ${SMALL_FH}`}>
                  <Link href={`/create?template=${encodeURIComponent(t.id)}`} className="crop-hover block rounded-md outline-offset-6">
                    <ProjectFrame
                      html={templateFirstSlide(t)}
                      slideCount={t.slides.length}
                      aspectRatio={t.aspectRatio}
                      format={format}
                      heightClass={SMALL_FH}
                      paperColors={selectedBrand ? [selectedBrand.colors.surface, selectedBrand.colors.background] : undefined}
                    />
                    <span className="mt-3 block text-[14.5px] leading-snug font-semibold break-words">{t.name}</span>
                    <span className="mt-0.5 block text-[13px] text-graphite">
                      {FORMATS[format].name}, {countLabel(format, t.slides.length)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {selectedBrand && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <BrandPanel brand={selectedBrand} />
          <StudioPanel />
        </div>
      )}
    </div>
  );
}
