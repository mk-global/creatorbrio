"use client";

import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { formatPreview } from "@/components/home/FormatStage";
import { ProjectFrame } from "@/components/library/ProjectFrame";
import { FORMATS, PROJECT_FORMATS, SIZE_NAMES, sizePixels, withArticle, type ProjectFormat } from "@/lib/formats";
import type { ProjectSummary } from "@/lib/project-summary";
import type { Brand } from "@/types/brand";
import type { AspectRatio } from "@/types/carousel";

/** Step 1 of New project: the three formats as radio buttons, drawn at their true shapes. */
export function FormatChoice({
  format,
  brand,
  projects,
  onPick,
}: {
  format: ProjectFormat;
  brand: Brand;
  projects: readonly ProjectSummary[];
  onPick: (format: ProjectFormat) => void;
}) {
  return (
    <>
      <div className="mt-5 flex flex-wrap items-start gap-x-10 gap-y-6">
        {PROJECT_FORMATS.map((id) => {
          const def = FORMATS[id];
          const checked = format === id;
          const preview = formatPreview(id, brand, projects);
          return (
            <label key={id} className="crop-hover group flex cursor-pointer flex-col">
              <input type="radio" name="format" value={id} checked={checked} onChange={() => onPick(id)} className="peer sr-only" />
              <span className="flex h-[96px] items-end rounded-sm peer-focus-visible:outline-2 sm:h-[124px] peer-focus-visible:outline-offset-8 peer-focus-visible:outline-ink">
                <ProjectFrame
                  html={preview.html}
                  slideCount={preview.slideCount}
                  aspectRatio={preview.aspectRatio}
                  format={id}
                  heightClass="[--fh:96px] sm:[--fh:124px]"
                  selected={checked}
                  paperColors={[brand.colors.surface, brand.colors.background]}
                />
              </span>
              {/* Selection is never shown by the crop marks alone: the name gets a check and the word "Selected".
                  Every card reserves both, hidden unless chosen, so the previews keep one baseline. */}
              <span className={`mt-3 flex items-center gap-1.5 text-[15px] font-semibold ${checked ? "text-ink" : "text-ink/80"}`}>
                <CircleCheck className={`size-4 shrink-0 ${checked ? "" : "hidden"}`} aria-hidden="true" />
                {def.name}
              </span>
              <span className={`text-[12.5px] font-semibold text-ink ${checked ? "" : "invisible"}`}>Selected</span>
              <span className="max-w-[24ch] text-[13px] leading-snug text-graphite">{def.makes}</span>
            </label>
          );
        })}
      </div>
      <p className="mt-5 text-[14px] text-graphite">
        Editing a video? That happens in the{" "}
        <Link href="/studio" className="font-semibold text-ink underline underline-offset-4">
          Video Studio
        </Link>
        .
      </p>
    </>
  );
}

/** The sizes a format allows, or the one fixed size it has. */
export function SizeChoice({
  format,
  size,
  locked,
  onPick,
}: {
  format: ProjectFormat;
  size: AspectRatio;
  /** A template keeps its own size. */
  locked: boolean;
  onPick: (size: AspectRatio) => void;
}) {
  const sizes = FORMATS[format].sizes;
  if (sizes.length === 1) {
    return (
      <div>
        <p className="mb-1.5 text-[14px] font-semibold">Size</p>
        <p className="flex h-11 items-center gap-3 text-[15px]">
          <span className="h-7 w-4 rounded-[2px] bg-ink/80" aria-hidden="true" />
          <span>
            {SIZE_NAMES[sizes[0]]} {sizes[0]}, <span className="meta">{sizePixels(sizes[0])}</span>
          </span>
        </p>
        <p className="text-[13px] text-graphite">{withArticle(FORMATS[format].name)} is always one {sizes[0]} image.</p>
      </div>
    );
  }
  return (
    <fieldset>
      <legend className="mb-1.5 text-[14px] font-semibold">Size</legend>
      <div className="flex flex-wrap gap-2">
        {sizes.map((r) => {
          const [w, h] = r.split(":").map(Number);
          return (
            <label
              key={r}
              className="flex cursor-pointer items-center gap-3 rounded-[10px] bg-sheet py-2 pr-4 pl-3 shadow-[inset_0_0_0_1px_var(--color-rule)] has-[:checked]:shadow-[inset_0_0_0_2px_var(--color-crop)] has-[:disabled]:cursor-not-allowed has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink"
            >
              <input type="radio" name="size" className="sr-only" checked={size === r} onChange={() => onPick(r)} disabled={locked} />
              <span className="flex h-8 w-8 items-end justify-center" aria-hidden="true">
                <span className="rounded-[2px] bg-ink/80" style={{ height: w > h ? (28 * h) / w : 28, width: Math.min(28, (28 * w) / h) }} />
              </span>
              <span>
                <span className="block text-[14px] font-semibold">
                  {SIZE_NAMES[r]} {r}
                </span>
                <span className="meta block text-graphite">{sizePixels(r)}</span>
              </span>
            </label>
          );
        })}
      </div>
      {locked && <p className="mt-1.5 text-[13px] text-graphite">A template keeps its own size.</p>}
    </fieldset>
  );
}
