import type { AspectRatio } from "@/types/carousel";

/**
 * Export formats offered by `POST /api/carousels/[id]/export`.
 *
 * Every format renders the same slide documents: `png` zips one PNG per slide,
 * `single-png` answers with the one PNG of a one-slide carousel as it is, and
 * `pdf` prints each slide natively to a page with real text. This module has no
 * server dependencies so the editor can import it too.
 */
export type ExportFormat = "png" | "pdf" | "single-png";

/** What a request without `?format=` gets. Kept as the original ZIP export. */
export const DEFAULT_EXPORT_FORMAT: ExportFormat = "png";

export interface ExportFormatOption {
  format: ExportFormat;
  platform: string;
  label: string;
  description: string;
  extension: "zip" | "pdf" | "png";
}

export const EXPORT_FORMATS: readonly ExportFormatOption[] = [
  {
    format: "png",
    platform: "Instagram",
    label: "PNG ZIP",
    description: "Download individual carousel images.",
    extension: "zip",
  },
  {
    format: "pdf",
    platform: "LinkedIn",
    label: "PDF",
    description: "Download one multi-page PDF.",
    extension: "pdf",
  },
];

/** Offered only for a carousel with exactly one slide, such as a reel cover. */
export const SINGLE_PNG_FORMAT: ExportFormatOption = {
  format: "single-png",
  platform: "Instagram",
  label: "PNG",
  description: "Download this slide as one PNG image, no ZIP.",
  extension: "png",
};

/**
 * The formats the Export menu offers for a carousel with this many slides: the
 * usual two, followed by the single PNG when there is only one slide.
 */
export function exportFormatsFor(slideCount: number): ExportFormatOption[] {
  return slideCount === 1
    ? [...EXPORT_FORMATS, SINGLE_PNG_FORMAT]
    : [...EXPORT_FORMATS];
}

/**
 * Reads the `format` query parameter. A missing or empty value is the default
 * ZIP export, so callers written before PDF existed keep their behaviour.
 * Anything unrecognised returns null rather than silently falling back.
 */
export function parseExportFormat(value: string | null): ExportFormat | null {
  if (value === null || value === "") return DEFAULT_EXPORT_FORMAT;
  return [...EXPORT_FORMATS, SINGLE_PNG_FORMAT].some(
    (option) => option.format === value
  )
    ? (value as ExportFormat)
    : null;
}

/**
 * Advice shown next to the LinkedIn option, or null when there is none.
 *
 * LinkedIn accepts any page size, so a 9:16 carousel still exports as-is. The
 * advisory only informs; it never changes the carousel or its dimensions.
 */
export function linkedInAdvisory(aspectRatio: AspectRatio): string | null {
  if (aspectRatio === "9:16") {
    return "9:16 pages export as-is. 4:5 generally displays better in LinkedIn's feed.";
  }
  return null;
}

/**
 * The filename from a `Content-Disposition: attachment; filename="..."` header,
 * or null when there is none. Path separators are dropped so the value can only
 * ever name a file, not a location.
 */
export function filenameFromDisposition(header: string | null): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  if (!match) return null;
  const name = match[1].replace(/[\\/]/g, "_").trim();
  return name || null;
}
