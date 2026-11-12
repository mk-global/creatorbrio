"use client";

import Link from "next/link";
import { Pencil } from "lucide-react";
import { useGoogleFonts } from "@/components/app/useGoogleFonts";
import { brandDisplayName, brandIsSetUp, capitalise, COLOR_ROLES, fontStack } from "@/lib/brand-display";
import type { Brand } from "@/types/brand";

/** The brand's five colours as one continuous strip, named for screen readers and, from 640 px, on screen. */
export function BrandPalette({ brand, height = "h-16" }: { brand: Pick<Brand, "colors">; height?: string }) {
  return (
    <div>
      <ul aria-label="Colours" className={`flex overflow-hidden rounded-[10px] border border-field ${height}`}>
        {COLOR_ROLES.map((r, i) => (
          <li
            key={r.key}
            className="relative flex-1"
            style={{ background: brand.colors[r.key], boxShadow: i ? "inset 1px 0 0 rgb(28 27 41 / 0.1)" : undefined }}
            title={`${r.label} ${brand.colors[r.key].toUpperCase()}`}
          >
            <span className="sr-only">
              {r.label} {brand.colors[r.key].toUpperCase()}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 hidden grid-cols-5 text-[12px] leading-tight sm:grid" aria-hidden="true">
        {COLOR_ROLES.map((r) => (
          <span key={r.key} className="min-w-0 truncate pr-1">
            <span className="block font-medium">{r.label}</span>
            <span className="num block text-graphite">{brand.colors[r.key].toUpperCase()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function FontSpecimen({ role, font }: { role: string; font: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-graphite">{role}</dt>
      {/* On phones the sample sits above the name, so the name always has the full column. */}
      <dd className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2.5">
        <span className="text-[30px] leading-none" style={{ fontFamily: fontStack(font), fontWeight: 600 }} aria-hidden="true">
          Aa
        </span>
        <span className="min-w-0 text-[15px] leading-snug font-semibold break-words">{font}</span>
      </dd>
    </div>
  );
}

export function Personality({ words }: { words: string[] }) {
  if (!words.length) return <span className="text-[14px] text-graphite">Not described yet</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Personality">
      {words.map((w) => (
        <li key={w} className="inline-flex h-7 items-center rounded-full bg-ground px-2.5 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--color-rule)]">
          {capitalise(w)}
        </li>
      ))}
    </ul>
  );
}

/** Home's brand panel: what new work will look like, without leaving the page. */
export function BrandPanel({ brand }: { brand: Brand }) {
  useGoogleFonts([brand.fonts.heading, brand.fonts.body]);
  const unset = !brandIsSetUp(brand);
  return (
    <section aria-labelledby="home-brand" className="panel p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2
            id="home-brand"
            className="text-[28px] leading-[1.1] break-words sm:text-[32px]"
            style={{ fontFamily: fontStack(brand.fonts.heading), fontWeight: 700 }}
          >
            {brandDisplayName(brand)}
          </h2>
          <p className="mt-1 text-[14px] text-graphite">
            {unset ? "Not set up yet. New projects use these defaults." : "Every new project uses this brand."}
          </p>
        </div>
        <Link href={`/brands/${encodeURIComponent(brand.id)}`} className={`btn btn-sm shrink-0 ${unset ? "btn-primary" : "btn-quiet"}`}>
          <Pencil className="size-3.5" aria-hidden="true" />
          {unset ? "Set up brand" : "Edit brand"}
        </Link>
      </div>
      <div className="mt-6">
        <BrandPalette brand={brand} />
      </div>
      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-[minmax(0,auto)_minmax(0,auto)_minmax(0,1fr)]">
        <FontSpecimen role="Headlines" font={brand.fonts.heading} />
        <FontSpecimen role="Body text" font={brand.fonts.body} />
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <dt className="text-[13px] text-graphite">Personality</dt>
          <dd className="mt-1.5">
            <Personality words={brand.styleKeywords} />
          </dd>
        </div>
      </dl>
    </section>
  );
}
