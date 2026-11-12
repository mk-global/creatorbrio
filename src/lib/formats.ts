import { MAX_SLIDES, type AspectRatio, type Carousel } from "@/types/carousel";
import type { ExportFormat } from "@/lib/export-formats";

/**
 * What a project is for (#175). Every format is a carousel: the same slides,
 * editor, design agent and exporter. The format only sets defaults and limits
 * (sizes, slide count, the main export) and the words the creation flow
 * prefills, so one engine serves all of them.
 *
 * The field is optional on stored carousels and templates; absent means an
 * Instagram carousel, which is what every project made before formats was.
 * No stored record is rewritten. This module has no server dependencies, so
 * the screens import it too.
 */
export type ProjectFormat = "instagram-carousel" | "linkedin-document" | "reel-cover";

export const PROJECT_FORMATS: readonly ProjectFormat[] = ["instagram-carousel", "linkedin-document", "reel-cover"];

export const DEFAULT_FORMAT: ProjectFormat = "instagram-carousel";

export interface FormatDefinition {
  id: ProjectFormat;
  /** Sentence case, as people read it: "Instagram carousel". */
  name: string;
  /** What it makes, in a few words. */
  makes: string;
  /** What it exports, in a few words. */
  exports: string;
  /** Sizes this format allows, in the order offered. */
  sizes: readonly AspectRatio[];
  defaultSize: AspectRatio;
  maxSlides: number;
  /** The Export button's main action. */
  defaultExport: ExportFormat;
  /** A slide, or a page: what the editor calls one. */
  unit: { one: string; many: string };
  /**
   * Visible words put at the start of the person's first message, which they
   * can read and edit before sending. The design agent's prompt is frozen, so
   * this is how the format reaches it (decision D5).
   */
  composerPrefix: string;
}

export const FORMATS: Record<ProjectFormat, FormatDefinition> = {
  "instagram-carousel": {
    id: "instagram-carousel",
    name: "Instagram carousel",
    makes: "Swipeable slides for the feed",
    exports: "PNG images, or one PDF",
    sizes: ["4:5", "1:1", "9:16"],
    defaultSize: "4:5",
    maxSlides: MAX_SLIDES,
    defaultExport: "png",
    unit: { one: "slide", many: "slides" },
    composerPrefix: "",
  },
  "linkedin-document": {
    id: "linkedin-document",
    name: "LinkedIn document",
    makes: "Pages LinkedIn shows as a document",
    exports: "One searchable PDF",
    sizes: ["4:5", "1:1"],
    defaultSize: "4:5",
    maxSlides: MAX_SLIDES,
    defaultExport: "pdf",
    unit: { one: "page", many: "pages" },
    composerPrefix: "A LinkedIn document. ",
  },
  "reel-cover": {
    id: "reel-cover",
    name: "Reel cover",
    makes: "The still image in front of a Reel",
    exports: "One PNG, 1080 × 1920",
    sizes: ["9:16"],
    defaultSize: "9:16",
    maxSlides: 1,
    defaultExport: "single-png",
    unit: { one: "slide", many: "slides" },
    composerPrefix: "A one-slide Reel cover. ",
  },
};

export function isProjectFormat(value: unknown): value is ProjectFormat {
  return typeof value === "string" && (PROJECT_FORMATS as readonly string[]).includes(value);
}

/** A stored project's format; a project made before formats existed is an Instagram carousel. */
export function formatOf(project: Pick<Carousel, "format"> | { format?: unknown }): ProjectFormat {
  return isProjectFormat(project.format) ? project.format : DEFAULT_FORMAT;
}

/** Whether this format allows this size. */
export function formatAllowsSize(format: ProjectFormat, size: AspectRatio): boolean {
  return FORMATS[format].sizes.includes(size);
}

/** "An Instagram carousel", "A Reel cover". */
export function withArticle(name: string): string {
  return `${/^[aeiou]/i.test(name) ? "An" : "A"} ${name}`;
}

/** Why a size is refused for a format, in words a person reads. */
export function sizeRefusal(format: ProjectFormat): string {
  const def = FORMATS[format];
  return def.sizes.length === 1
    ? `${withArticle(def.name)} is always ${def.sizes[0]}.`
    : `${withArticle(def.name)} can be ${def.sizes.join(" or ")}.`;
}

/** The slide limit of a project. */
export function slideLimitOf(project: Pick<Carousel, "format"> | { format?: unknown }): number {
  return FORMATS[formatOf(project)].maxSlides;
}

/** Why a slide cannot be added once a project is at its format's limit. */
export function slideLimitRefusal(project: Pick<Carousel, "format"> | { format?: unknown }): string {
  const def = FORMATS[formatOf(project)];
  return def.maxSlides === 1
    ? `${withArticle(def.name)} has one slide. Change the slide that is there instead of adding another.`
    : `${withArticle(def.name)} can have at most ${def.maxSlides} ${def.unit.many}.`;
}

/**
 * The export the editor's main button makes: the format's default, except a
 * single PNG needs exactly one slide, so a cover that somehow has more falls
 * back to the ZIP the export route has always offered.
 */
export function primaryExportFor(format: ProjectFormat, slideCount: number): ExportFormat {
  const preferred = FORMATS[format].defaultExport;
  if (preferred === "single-png" && slideCount !== 1) return "png";
  return preferred;
}
