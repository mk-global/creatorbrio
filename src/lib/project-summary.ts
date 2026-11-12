import type { AspectRatio, Carousel } from "@/types/carousel";
import { formatOf, type ProjectFormat } from "@/lib/formats";

/**
 * What the library shows for a project (#175): enough for a card with a live
 * first-slide preview, and nothing else. No slide after the first and no undo
 * history leave the server, so a library of hundreds of projects stays light.
 * Served by `GET /api/carousels?view=summary`; the list without `view` is
 * unchanged for existing callers.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  /** The brand it belongs to; a project from before brands belongs to the default brand. */
  brandId: string;
  format: ProjectFormat;
  aspectRatio: AspectRatio;
  slideCount: number;
  /** The first slide's body HTML, or null for a project with no slides yet. */
  firstSlideHtml: string | null;
  createdAt: string;
  updatedAt: string;
}

export function summarizeProject(carousel: Carousel, defaultBrandId: string): ProjectSummary {
  const first = [...carousel.slides].sort((a, b) => a.order - b.order)[0];
  return {
    id: carousel.id,
    name: carousel.name,
    brandId: carousel.brandId ?? defaultBrandId,
    format: formatOf(carousel),
    aspectRatio: carousel.aspectRatio,
    slideCount: carousel.slides.length,
    firstSlideHtml: first ? first.html : null,
    createdAt: carousel.createdAt,
    updatedAt: carousel.updatedAt,
  };
}

/** Most recently edited first; ties keep a stable order by id. */
export function byRecentEdit(a: ProjectSummary, b: ProjectSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}
