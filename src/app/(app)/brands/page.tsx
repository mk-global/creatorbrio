"use client";

import Link from "next/link";
import { useApp } from "@/components/app/AppContext";
import { PageNotice } from "@/components/app/PageNotice";
import { useGoogleFonts } from "@/components/app/useGoogleFonts";
import { BrandPalette, FontSpecimen, Personality } from "@/components/home/BrandPanel";
import { useProjects } from "@/components/library/useLibrary";
import { brandDisplayName, fontStack } from "@/lib/brand-display";

/** Every brand, the one new work uses, and how many projects each has (#175). */
export default function BrandsPage() {
  const { brands, selectedBrandId, defaultBrandId, select, error, toast } = useApp();
  const projects = useProjects();
  useGoogleFonts(brands.flatMap((b) => [b.fonts.heading, b.fonts.body]));
  const counts = projects.state.status === "ready" ? projects.state.items : null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="type-title">Brands</h1>
          <p className="mt-2 max-w-[62ch] text-graphite">
            A brand is the colours, fonts and style Claude designs with. New projects use the brand you choose here; a project keeps its brand for life.
          </p>
          <p className="mt-1 text-[14px] text-graphite">Brands can&apos;t be deleted yet.</p>
        </div>
        <Link href="/brands/new" className="btn btn-create">
          New brand
        </Link>
      </div>

      {error ? (
        <div className="mt-10">
          <PageNotice tone="alert" title="Your brands couldn't be loaded">
            {error} Nothing was deleted.
          </PageNotice>
        </div>
      ) : (
        <ul className="mt-10 grid gap-5 lg:grid-cols-2">
          {brands.map((b) => {
            const active = b.id === selectedBrandId;
            const count = counts?.filter((p) => p.brandId === b.id).length;
            return (
              <li key={b.id} className={`panel flex min-w-0 flex-col p-6 ${active ? "shadow-[inset_0_0_0_2px_var(--color-crop)]" : ""}`}>
                <div className="flex flex-wrap items-center gap-2">
                  {active && <span className="tag tag-neutral">Used for new work</span>}
                  {b.id === defaultBrandId && <span className="tag tag-neutral">Default</span>}
                  {count !== undefined && (
                    <span className="num text-[13px] text-graphite">
                      {count} {count === 1 ? "project" : "projects"}
                    </span>
                  )}
                </div>
                <h2 className="mt-3 text-[32px] leading-[1.05] break-words" style={{ fontFamily: fontStack(b.fonts.heading), fontWeight: 700 }}>
                  {brandDisplayName(b)}
                </h2>
                <div className="mt-5">
                  <BrandPalette brand={b} height="h-14" />
                </div>
                <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
                  <FontSpecimen role="Headlines" font={b.fonts.heading} />
                  <FontSpecimen role="Body text" font={b.fonts.body} />
                  <div className="col-span-2 min-w-0">
                    <dt className="text-[13px] text-graphite">Personality</dt>
                    <dd className="mt-1.5">
                      <Personality words={b.styleKeywords} />
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="sr-only">Logo</dt>
                    <dd className="text-[13px] text-graphite">{b.logoPath ? "Logo added" : "No logo yet"}</dd>
                  </div>
                </dl>
                <div className="mt-auto flex flex-wrap gap-2 pt-6">
                  {!active && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        select(b.id);
                        toast(`New projects now use ${brandDisplayName(b)}.`);
                      }}
                    >
                      Use for new work
                    </button>
                  )}
                  <Link href={`/brands/${encodeURIComponent(b.id)}`} className="btn btn-quiet btn-sm">
                    {b.name.trim() ? "Edit brand" : "Set up brand"}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
