import type { AspectRatio, Carousel, Slide } from "@/types/carousel";
import type { BrandColors, BrandConfig, BrandFonts } from "@/types/brand";

/**
 * Field selection for the update endpoints.
 *
 * The data-layer mutators declare narrow contracts, but those are TypeScript
 * types: they are erased at runtime, and a parsed request body is `any`, so
 * nothing stopped a caller from merging arbitrary keys onto a stored entity.
 * These helpers turn an untrusted body into exactly the fields an endpoint
 * defines as mutable, and drop everything else.
 *
 * Unknown fields are ignored rather than rejected, which is how the rest of
 * this API already treats extra input.
 */

export const ASPECT_RATIOS: readonly AspectRatio[] = ["1:1", "4:5", "9:16"];

export function isAspectRatio(value: unknown): value is AspectRatio {
  return (
    typeof value === "string" &&
    (ASPECT_RATIOS as readonly string[]).includes(value)
  );
}

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object"
    ? (body as Record<string, unknown>)
    : {};
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Fields `PUT /api/carousels/[id]` may change. */
export type CarouselUpdate = Partial<
  Pick<
    Carousel,
    "name" | "aspectRatio" | "tags" | "chatSessionId" | "caption" | "hashtags"
  >
>;

/**
 * Server-owned and therefore never taken from the request: `id`, `slides`,
 * `referenceImages`, `assets`, `isTemplate`, `brandId`, `createdAt`, `updatedAt`.
 * `brandId` is set when the carousel is created and never changes.
 *
 * Overwriting `slides` deleted a carousel's entire contents, and flipping
 * `isTemplate` hid it from the dashboard while leaving the record on disk.
 */
export function pickCarouselUpdate(body: unknown): CarouselUpdate {
  const input = asRecord(body);
  const update: CarouselUpdate = {};

  if (typeof input.name === "string") update.name = input.name;

  // Validated the same way the create route validates it. An unsupported value
  // has no entry in DIMENSIONS, which the preview, the export viewport and the
  // safe-zone overlay all read.
  if (isAspectRatio(input.aspectRatio)) update.aspectRatio = input.aspectRatio;

  if (isStringArray(input.tags)) update.tags = input.tags;
  if (typeof input.chatSessionId === "string" || input.chatSessionId === null) {
    update.chatSessionId = input.chatSessionId;
  }
  if (typeof input.caption === "string") update.caption = input.caption;
  if (isStringArray(input.hashtags)) update.hashtags = input.hashtags;

  return update;
}

/** Fields `PUT /api/carousels/[id]/slides/[slideId]` may change. */
export type SlideUpdate = Partial<Pick<Slide, "html" | "notes">>;

/**
 * Server-owned and therefore never taken from the request: `id`, `order` and
 * `previousVersions`. `previousVersions` is the per-slide undo history, which a
 * caller could previously empty in the same request that changed the HTML.
 */
export function pickSlideUpdate(body: unknown): SlideUpdate {
  const input = asRecord(body);
  const update: SlideUpdate = {};

  if (typeof input.html === "string") update.html = input.html;
  if (typeof input.notes === "string") update.notes = input.notes;

  return update;
}

/** Fields `PUT /api/brand` may change. Timestamps stay server-owned. */
export type BrandUpdate = Partial<
  Omit<BrandConfig, "createdAt" | "updatedAt">
>;

const BRAND_COLOR_KEYS: (keyof BrandColors)[] = [
  "primary",
  "secondary",
  "accent",
  "background",
  "surface",
];

const BRAND_FONT_KEYS: (keyof BrandFonts)[] = ["heading", "body"];

export function pickBrandUpdate(body: unknown): BrandUpdate {
  const input = asRecord(body);
  const update: BrandUpdate = {};

  if (typeof input.name === "string") update.name = input.name;

  // Colours and fonts merge onto the stored values, so a partial object is
  // valid here. Only the known keys are carried across.
  const colors = asRecord(input.colors);
  const pickedColors: Partial<BrandColors> = {};
  for (const key of BRAND_COLOR_KEYS) {
    if (typeof colors[key] === "string") pickedColors[key] = colors[key];
  }
  if (Object.keys(pickedColors).length > 0) {
    update.colors = pickedColors as BrandColors;
  }

  const fonts = asRecord(input.fonts);
  const pickedFonts: Partial<BrandFonts> = {};
  for (const key of BRAND_FONT_KEYS) {
    if (typeof fonts[key] === "string") pickedFonts[key] = fonts[key];
  }
  if (Object.keys(pickedFonts).length > 0) {
    update.fonts = pickedFonts as BrandFonts;
  }

  if (
    Array.isArray(input.customFonts) &&
    input.customFonts.every(
      (f) =>
        f !== null &&
        typeof f === "object" &&
        typeof (f as { name?: unknown }).name === "string" &&
        typeof (f as { path?: unknown }).path === "string"
    )
  ) {
    update.customFonts = input.customFonts.map((f) => ({
      name: (f as { name: string }).name,
      path: (f as { path: string }).path,
    }));
  }

  if (typeof input.logoPath === "string" || input.logoPath === null) {
    update.logoPath = input.logoPath;
  }
  if (isStringArray(input.styleKeywords)) {
    update.styleKeywords = input.styleKeywords;
  }

  return update;
}
