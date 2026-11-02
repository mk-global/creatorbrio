import type { CreativeBrief } from "./creative-brief";

export type AspectRatio = "1:1" | "4:5" | "9:16";

export interface Slide {
  id: string;
  html: string;
  previousVersions: string[];
  order: number;
  notes: string;
}

export interface ReferenceImage {
  id: string;
  url: string;       // e.g. "/uploads/abc.png"
  absPath: string;    // absolute path for Claude to Read
  name: string;       // original filename or description
  addedAt: string;
}

/**
 * An image the creative pipeline prepared for this carousel, placed on slides
 * as content. Unlike a reference image it is never a style source. Every
 * field is server-generated: records are appended only by the asset module's
 * attach protocol, never taken from a request body.
 */
export interface CarouselAsset {
  id: string;
  /** Always `/uploads/<id>.png`. */
  url: string;
  origin: "generated" | "edited";
  /** For edited assets, the reference image or asset IDs it was made from. */
  sourceIds: string[];
  width: number;
  height: number;
  /** Hex SHA-256 of the file's bytes, checked before any reuse. */
  sha256: string;
  /** The creative run that produced it. */
  runId: string;
  createdAt: string;
}

export interface Carousel {
  id: string;
  name: string;
  aspectRatio: AspectRatio;
  slides: Slide[];
  referenceImages: ReferenceImage[];
  /** Absent on carousels created before assets existed; read it as empty. */
  assets?: CarouselAsset[];
  /**
   * What this carousel is for, kept across revisions. Server-owned: written
   * only from a validated Visual Director update, never from a request body.
   */
  creativeBrief?: CreativeBrief;
  caption?: string;
  hashtags?: string[];
  chatSessionId: string | null;
  /**
   * The brand this carousel was created in. Fixed at creation. Carousels made
   * before brands existed have none and belong to the default brand.
   */
  brandId?: string;
  isTemplate: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CarouselsData {
  carousels: Carousel[];
}

export const DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
};

export const MAX_SLIDES = 20;
export const MAX_VERSIONS = 5;
