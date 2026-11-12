"use client";

import Link from "next/link";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useApp } from "@/components/app/AppContext";
import { BrandsUnavailable, PageNotice } from "@/components/app/PageNotice";
import { FormatTabs } from "@/components/library/FormatTabs";
import { ProjectFrame } from "@/components/library/ProjectFrame";
import { SHEET_FH, SHEET_GRID } from "@/components/library/ProjectTile";
import { deleteTemplate, templateBrandId, templateFirstSlide, useTemplates } from "@/components/library/useLibrary";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { brandDisplayName } from "@/lib/brand-display";
import { countLabel, FORMATS, formatOf, PROJECT_FORMATS, type ProjectFormat } from "@/lib/formats";
import type { Brand } from "@/types/brand";
import type { Template } from "@/types/template";

function TemplateTile({ t, brand, onDeleted }: { t: Template; brand: Brand | undefined; onDeleted: (id: string) => void }) {
  const { toast } = useApp();
  const [confirm, setConfirm] = useState(false);
  const format = formatOf(t);
  const href = `/create?template=${encodeURIComponent(t.id)}`;
  return (
    <div className={`@container relative min-w-0 ${SHEET_FH}`}>
      <Link href={href} className="crop-hover block rounded-md outline-offset-6" aria-label={`Use the template ${t.name}`}>
        <ProjectFrame
          html={templateFirstSlide(t)}
          slideCount={t.slides.length}
          aspectRatio={t.aspectRatio}
          format={format}
          heightClass={SHEET_FH}
          paperColors={brand ? [brand.colors.surface, brand.colors.background] : undefined}
        />
      </Link>
      <p className="mt-3 text-[15px] leading-snug font-semibold break-words">{t.name}</p>
      <p className="mt-0.5 text-[13px] text-graphite">
        {FORMATS[format].name}, {countLabel(format, t.slides.length)}
      </p>
      <div className="mt-3 flex gap-1.5">
        <Link href={href} className="btn btn-quiet btn-sm">
          Use template
        </Link>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Delete template ${t.name}`} onClick={() => setConfirm(true)}>
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete the template "${t.name}"?`}
        description="Projects already started from it are not affected."
        confirmLabel="Delete template"
        cancelLabel="Keep it"
        variant="destructive"
        onConfirm={() =>
          void deleteTemplate(t.id).then(
            () => {
              onDeleted(t.id);
              toast(`Deleted the template "${t.name}".`);
            },
            (err: unknown) => toast(`Couldn't delete the template: ${err instanceof Error ? err.message : "the app did not answer."}`)
          )
        }
      />
    </div>
  );
}

/** The brand's templates by format (#175); using one opens New project with it chosen. */
export default function TemplatesPage() {
  const { brands, selectedBrand, defaultBrandId, error: brandError, reload: reloadBrands } = useApp();
  const templates = useTemplates();
  const [filter, setFilter] = useState<ProjectFormat | "all">("all");
  const mine =
    templates.state.status === "ready" && selectedBrand
      ? templates.state.items.filter((t) => templateBrandId(t, defaultBrandId) === selectedBrand.id)
      : [];
  const shown = mine.filter((t) => filter === "all" || formatOf(t) === filter);
  const name = brandDisplayName(selectedBrand);
  const tabs = [
    { id: "all" as const, label: "All", count: mine.length },
    ...PROJECT_FORMATS.map((f) => ({ id: f, label: FORMATS[f].plural, count: mine.filter((t) => formatOf(t) === f).length })),
  ];

  if (brandError) return <BrandsUnavailable message={brandError} onRetry={() => void reloadBrands()} />;

  return (
    <div>
      <h1 className="display text-[44px] lg:text-[56px]">Templates</h1>
      <p className="mt-2 max-w-[62ch] text-graphite">Layouts {name} has used before. Starting from one gives Claude the slides to work from.</p>

      <div className="mt-8">
        <FormatTabs<ProjectFormat | "all"> tabs={tabs} value={filter} onChange={setFilter} />
      </div>

      <div className="mt-8">
        {templates.state.status === "error" ? (
          <PageNotice
            tone="alert"
            title="Templates couldn't be loaded"
            action={
              <button type="button" className="btn btn-quiet btn-sm" onClick={templates.reload}>
                Try again
              </button>
            }
          >
            {templates.state.message} Nothing was deleted. You can still start a project from a description.
          </PageNotice>
        ) : templates.state.status === "loading" || !selectedBrand ? (
          <p className="text-graphite" aria-busy="true">
            Reading your templates…
          </p>
        ) : mine.length === 0 ? (
          <div className="max-w-[58ch] py-6">
            <h2 className="display-md text-[26px]">No templates for {name} yet</h2>
            <p className="mt-2 text-graphite">A template is a project you liked enough to start from again. Open any project and choose Save as template from its menu.</p>
            <Link href="/projects" className="btn btn-quiet mt-5">
              Go to projects
            </Link>
          </div>
        ) : shown.length === 0 ? (
          <div className="py-6">
            <p className="text-graphite">
              No {filter === "all" ? "" : FORMATS[filter].name} templates for {name}.
            </p>
            <button type="button" className="btn btn-quiet mt-4" onClick={() => setFilter("all")}>
              Show all formats
            </button>
          </div>
        ) : (
          <ul className={SHEET_GRID}>
            {shown.map((t) => (
              <li key={t.id}>
                <TemplateTile
                  t={t}
                  brand={brands.find((b) => b.id === templateBrandId(t, defaultBrandId))}
                  onDeleted={(id) => templates.update((items) => items.filter((x) => x.id !== id))}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
