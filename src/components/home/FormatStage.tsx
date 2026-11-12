"use client";

import Link from "next/link";
import { Download, Film } from "lucide-react";
import { ProjectFrame } from "@/components/library/ProjectFrame";
import { sampleSlideHtml } from "@/lib/format-samples";
import { FORMATS, PROJECT_FORMATS, type ProjectFormat } from "@/lib/formats";
import type { ProjectSummary } from "@/lib/project-summary";
import type { Brand } from "@/types/brand";
import { DIMENSIONS } from "@/types/carousel";

/**
 * What a format looks like for this brand: its most recent project of that
 * format with a slide, or a sample in the brand's colours and fonts.
 */
export function formatPreview(format: ProjectFormat, brand: Brand, projects: readonly ProjectSummary[]) {
  const own = projects.find((p) => p.brandId === brand.id && p.format === format && p.firstSlideHtml !== null);
  return own
    ? { html: own.firstSlideHtml, slideCount: own.slideCount, aspectRatio: own.aspectRatio }
    : { html: sampleSlideHtml(format, brand), slideCount: format === "reel-cover" ? 1 : 3, aspectRatio: FORMATS[format].defaultSize };
}

/** The stage's height from the column's width; the Video Studio picture (9:16) uses it as it is. */
const H = "[--fh:min(268px,96cqw)]";

/**
 * A preview's height from its column: at most 268 px, and never so tall that
 * its widest point (a fanned square carousel is 1.11 × its height) passes the
 * column's inner edge. Set as a custom property, which the frame inherits.
 */
function stageHeight(format: ProjectFormat, aspectRatio: keyof typeof DIMENSIONS, slideCount: number): React.CSSProperties {
  const { width, height } = DIMENSIONS[aspectRatio];
  const stack = format === "reel-cover" ? 0 : Math.min(2, Math.max(0, slideCount - 1));
  const shape = width / height;
  const widest =
    format === "instagram-carousel" ? shape + stack * 0.055 : format === "linkedin-document" ? shape * (1 - stack * 0.055) : shape;
  return { "--fh": `min(268px, 96cqw, calc((100cqw - 32px) / ${widest.toFixed(3)}))` } as React.CSSProperties;
}

/** CreatorBrio's own drawing of a Reel being edited, in the product palette: footage, a coral title, sound. */
function VideoArt() {
  return (
    <div className={`crop relative ${H}`} style={{ height: "var(--fh)", width: "calc(var(--fh) * 9 / 16)" }} aria-hidden="true">
      <div className="paper absolute inset-0 bg-ink">
        <div className="absolute inset-0 bg-[radial-gradient(120%_70%_at_30%_25%,var(--color-ink-soft)_0%,var(--color-ink)_70%)]" />
        <div className="absolute top-[38%] left-1/2 flex aspect-square w-[34%] -translate-x-1/2 items-center justify-center rounded-full bg-white/14 ring-1 ring-white/25">
          <svg viewBox="0 0 10 10" className="ml-[8%] w-[38%] fill-white">
            <path d="M2 1l7 4-7 4z" />
          </svg>
        </div>
        <div className="absolute inset-x-[8%] bottom-[7%] space-y-[3px]">
          <div className="flex gap-[2px]">
            <span className="h-[5px] flex-[3] rounded-[1px] bg-white/60" />
            <span className="h-[5px] flex-[2] rounded-[1px] bg-white/40" />
            <span className="h-[5px] flex-[4] rounded-[1px] bg-white/60" />
          </div>
          <div className="flex gap-[2px]">
            <span className="h-[4px] flex-[5] rounded-[1px] bg-crop" />
            <span className="h-[4px] flex-[2] rounded-[1px] bg-transparent" />
          </div>
          <div className="h-[4px] w-full rounded-[1px] bg-white/25" />
        </div>
      </div>
    </div>
  );
}

const STAGE: { id: ProjectFormat | "video"; name: string; line: string; exports: string; href: string }[] = [
  ...PROJECT_FORMATS.map((f) => ({ id: f, name: FORMATS[f].name, line: FORMATS[f].makes, exports: FORMATS[f].exports, href: `/create?format=${f}` })),
  { id: "video", name: "Video Studio", line: "Edit a Reel by hand from your footage", exports: "MP4 checked for Reels", href: "/studio" },
];

/**
 * Home's hero (#175): the four things CreatorBrio makes, drawn at their real
 * proportions in four equal columns that stand on one continuous baseline.
 */
export function FormatStage({ brand, projects }: { brand: Brand; projects: readonly ProjectSummary[] }) {
  return (
    <ul className="grid grid-cols-2 gap-y-10 lg:grid-cols-4" aria-label="Formats">
      {STAGE.map((f, i) => {
        const preview = f.id === "video" ? null : formatPreview(f.id, brand, projects);
        return (
          <li key={f.id} className="settle @container min-w-0" style={{ animationDelay: `${80 + i * 70}ms` }}>
            <Link href={f.href} className="crop-hover group flex flex-col rounded-md outline-offset-4" aria-describedby={`fmt-${f.id}`}>
              {/* Every column's baseline sits at the same depth, whatever the shape above it. */}
              <span className={`flex items-end border-b-2 border-ink/80 pr-4 pb-4 sm:pr-8 ${H}`} style={{ height: "calc(var(--fh) + 18px)" }}>
                {f.id === "video" || !preview ? (
                  <VideoArt />
                ) : (
                  <span className="flex" style={stageHeight(f.id, preview.aspectRatio, preview.slideCount)}>
                    <ProjectFrame
                      html={preview.html}
                      slideCount={preview.slideCount}
                      aspectRatio={preview.aspectRatio}
                      format={f.id}
                      heightClass=""
                      paperColors={[brand.colors.surface, brand.colors.background]}
                    />
                  </span>
                )}
              </span>
              <span className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 pr-4 text-[16px] leading-tight font-semibold sm:pr-8 sm:text-[18px]">
                {f.name}
                {f.id === "video" && <span className="tag tag-early">Early</span>}
              </span>
              <span id={`fmt-${f.id}`} className="mt-1.5 block pr-4 text-[13.5px] leading-snug text-graphite sm:pr-8 sm:text-[14px]">
                {f.line}
                <span className="mt-1 flex items-start gap-1.5 text-ink/80">
                  {f.id === "video" ? (
                    <Film className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <Download className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span>
                    <span className="sr-only">Exports </span>
                    {f.exports}
                  </span>
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
