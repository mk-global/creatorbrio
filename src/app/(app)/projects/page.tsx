"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Grid2x2, Rows3, Search } from "lucide-react";
import { useApp } from "@/components/app/AppContext";
import { PageNotice } from "@/components/app/PageNotice";
import { FormatTabs } from "@/components/library/FormatTabs";
import { ProjectFrame } from "@/components/library/ProjectFrame";
import { ProjectTile, SHEET_GRID } from "@/components/library/ProjectTile";
import { useProjects } from "@/components/library/useLibrary";
import { brandDisplayName } from "@/lib/brand-display";
import { countLabel, FORMATS, PROJECT_FORMATS, type ProjectFormat } from "@/lib/formats";
import { editedPhrase } from "@/lib/relative-time";

type Filter = ProjectFormat | "all";

/** Every project, for this brand or all of them, by format, name and last edit (#175). */
export default function ProjectsPage() {
  const { brands, selectedBrand } = useApp();
  const projects = useProjects();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"brand" | "all">("brand");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<"edited" | "name">("edited");
  const [view, setView] = useState<"sheet" | "list">("sheet");

  const all = useMemo(() => (projects.state.status === "ready" ? projects.state.items : []), [projects.state]);
  const scoped = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((p) => scope === "all" || p.brandId === selectedBrand?.id)
      .filter((p) => !needle || p.name.toLowerCase().includes(needle));
  }, [all, scope, selectedBrand, q]);
  const shown = scoped
    .filter((p) => filter === "all" || p.format === filter)
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : 0));
  const brandName = (id: string) => brandDisplayName(brands.find((b) => b.id === id));
  const tabs = [
    { id: "all" as Filter, label: "All", count: scoped.length },
    ...PROJECT_FORMATS.map((f) => ({ id: f as Filter, label: FORMATS[f].plural, count: scoped.filter((p) => p.format === f).length })),
  ];
  const tileEvents = {
    onDuplicated: projects.reload,
    onDeleted: (id: string) => projects.update((items) => items.filter((x) => x.id !== id)),
  };

  return (
    <div>
      <h1 className="display text-[44px] lg:text-[56px]">Projects</h1>
      <p className="mt-2 text-graphite">
        {scope === "brand" ? <>Everything made for {brandDisplayName(selectedBrand)}.</> : <>Everything, across all brands.</>}
      </p>

      <div className="mt-8 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1 lg:max-w-[360px]">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-graphite" aria-hidden="true" />
          <label htmlFor="search" className="sr-only">
            Search projects
          </label>
          <input id="search" type="search" className="field pl-10" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <div role="radiogroup" aria-label="Which brands" className="inline-flex rounded-lg bg-hover p-1">
            {(["brand", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                onClick={() => setScope(s)}
                className={`h-8 rounded-md px-3 text-[13.5px] font-medium ${scope === s ? "bg-sheet shadow-[0_1px_2px_rgb(28_27_41/0.15)]" : "text-graphite"}`}
              >
                {s === "brand" ? "This brand" : "All brands"}
              </button>
            ))}
          </div>
          <label htmlFor="sort" className="sr-only">
            Sort
          </label>
          <select id="sort" className="field h-10 w-auto pr-8 text-[14px]" value={sort} onChange={(e) => setSort(e.target.value as "edited" | "name")}>
            <option value="edited">Last edited</option>
            <option value="name">Name</option>
          </select>
          <div className="hidden gap-1 sm:flex" role="radiogroup" aria-label="Layout">
            <button type="button" role="radio" aria-checked={view === "sheet"} aria-label="Contact sheet" onClick={() => setView("sheet")} className={`btn btn-ghost btn-icon ${view === "sheet" ? "bg-hover" : ""}`}>
              <Grid2x2 className="size-[18px]" aria-hidden="true" />
            </button>
            <button type="button" role="radio" aria-checked={view === "list"} aria-label="List" onClick={() => setView("list")} className={`btn btn-ghost btn-icon ${view === "list" ? "bg-hover" : ""}`}>
              <Rows3 className="size-[18px]" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div className="mt-5">
        <FormatTabs tabs={tabs} value={filter} onChange={setFilter} />
      </div>

      <div className="mt-8">
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
            {projects.state.message} Nothing was deleted. Your search and filters are kept.
          </PageNotice>
        ) : projects.state.status === "loading" ? (
          <p className="text-graphite" aria-busy="true">
            Reading your projects…
          </p>
        ) : all.length === 0 ? (
          <div className="max-w-[56ch] py-10">
            <h2 className="display-md text-[26px]">No projects yet</h2>
            <p className="mt-2 text-graphite">A project is one carousel, document or Reel cover, with its slides, chat and exports. Start one and it appears here.</p>
            <Link href="/create" className="btn btn-primary mt-5">
              Start a project
            </Link>
          </div>
        ) : shown.length === 0 ? (
          <div className="max-w-[56ch] py-10">
            <h2 className="display-md text-[26px]">No projects match</h2>
            <p className="mt-2 text-graphite">{scope === "brand" ? "Try all brands, another format or a shorter search." : "Try another format or a shorter search."}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setQ("");
                  setFilter("all");
                }}
              >
                Clear filters
              </button>
              {scope === "brand" && (
                <button type="button" className="btn btn-ghost" onClick={() => setScope("all")}>
                  Search all brands
                </button>
              )}
            </div>
          </div>
        ) : view === "sheet" ? (
          <ul className={SHEET_GRID}>
            {shown.map((p) => (
              <li key={p.id}>
                <ProjectTile project={p} showBrand={scope === "all"} {...tileEvents} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto rounded-[14px] bg-sheet shadow-[inset_0_0_0_1px_var(--color-rule)]">
            <table className="w-full text-left text-[14px]">
              <thead className="text-[13px] text-graphite">
                <tr className="border-b border-rule">
                  <th className="py-3 pr-3 pl-5 font-medium">Name</th>
                  <th className="px-3 font-medium">Format</th>
                  <th className="px-3 font-medium">Length</th>
                  <th className="px-3 font-medium">Brand</th>
                  <th className="py-3 pr-5 pl-3 font-medium">Edited</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className="border-b border-rule last:border-0 hover:bg-ground">
                    <td className="py-2.5 pr-3 pl-5">
                      <Link href={`/carousel/${encodeURIComponent(p.id)}`} className="flex items-center gap-3 font-semibold">
                        <span className="flex h-11 w-12 items-end">
                          <ProjectFrame html={p.firstSlideHtml} slideCount={1} aspectRatio={p.aspectRatio} format="reel-cover" heightClass="[--fh:44px]" emptyLabel="" />
                        </span>
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-3 whitespace-nowrap">{FORMATS[p.format].name}</td>
                    <td className="num px-3 whitespace-nowrap">{countLabel(p.format, p.slideCount)}</td>
                    <td className="px-3 whitespace-nowrap">{brandName(p.brandId)}</td>
                    <td className="num py-2.5 pr-5 pl-3 whitespace-nowrap text-graphite">{editedPhrase(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
