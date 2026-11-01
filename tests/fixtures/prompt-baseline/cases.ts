import type { BrandConfig } from "@/types/brand";
import type { Carousel, Slide } from "@/types/carousel";
import type { StylePreset } from "@/types/style-preset";
import type { SystemPromptContext } from "@/lib/chat-system-prompt";

/**
 * Five fixed, synthetic inputs to the Design Agent's system prompt that
 * together reach every conditional section of it. Their outputs were
 * generated once from afbeefe (the commit before #28) and committed beside
 * this file; they must never be regenerated from the current code.
 */

const TIME = "2026-01-01T00:00:00.000Z";

const configuredBrand: BrandConfig = {
  name: "Northwind Studio",
  colors: { primary: "#14213d", secondary: "#fca311", accent: "#e63946", background: "#fafafa", surface: "#e5e5e5" },
  fonts: { heading: "Playfair Display", body: "Inter" },
  customFonts: [],
  logoPath: "/uploads/northwind-logo.png",
  styleKeywords: ["editorial", "bold", "warm"],
  createdAt: TIME,
  updatedAt: TIME,
};

const plainBrand: BrandConfig = {
  ...configuredBrand,
  name: "Plain Goods",
  fonts: { heading: "Space Grotesk", body: "DM Sans" },
  logoPath: null,
  styleKeywords: [],
};

const unconfiguredBrand: BrandConfig = { ...plainBrand, name: "" };

const slide = (id: string, order: number, notes: string): Slide => ({
  id,
  html: `<div>Slide ${order + 1}</div>`,
  previousVersions: [],
  order,
  notes,
});

const carousel = (overrides: Partial<Carousel>): Carousel => ({
  id: "c0ffee00-0000-4000-8000-000000000001",
  name: "Five habits of calm teams",
  aspectRatio: "4:5",
  slides: [],
  referenceImages: [],
  chatSessionId: null,
  isTemplate: false,
  tags: [],
  createdAt: TIME,
  updatedAt: TIME,
  ...overrides,
});

const references = [
  {
    id: "ref-1",
    url: "/uploads/11111111-2222-4333-8444-555555555555.png",
    absPath: "/srv/creatorbrio/public/uploads/11111111-2222-4333-8444-555555555555.png",
    name: "moodboard.png",
    addedAt: TIME,
  },
  {
    id: "ref-2",
    url: "/uploads/66666666-7777-4888-9999-000000000000.png",
    absPath: "/srv/creatorbrio/public/uploads/66666666-7777-4888-9999-000000000000.png",
    name: "competitor cover",
    addedAt: TIME,
  },
];

const preset = (overrides: Partial<StylePreset>): StylePreset => ({
  id: "preset-1",
  name: "Swiss grid",
  description: "Strict grid, oversized numerals",
  brand: configuredBrand,
  designRules: "Use a 12-column grid.\nOversized numerals in the accent color.\nNo drop shadows.",
  exampleSlideHtml: "",
  aspectRatio: "4:5",
  tags: [],
  createdAt: TIME,
  ...overrides,
});

export const PROMPT_BASELINE_CASES: Record<string, SystemPromptContext> = {
  "1-unconfigured-brand-no-carousel": {
    baseUrl: "http://127.0.0.1:3000",
    brand: unconfiguredBrand,
    carousel: null,
    stylePreset: null,
  },
  "2-configured-brand-portrait-slides": {
    baseUrl: "http://127.0.0.1:3000",
    brand: configuredBrand,
    carousel: carousel({
      slides: [
        slide("s-1", 0, "Hook: the calm-team paradox"),
        slide("s-2", 1, ""),
        slide("s-3", 2, "Takeaway and call to action"),
      ],
    }),
    stylePreset: null,
  },
  "3-plain-brand-story-references": {
    baseUrl: "http://localhost:3101",
    brand: plainBrand,
    carousel: carousel({ id: "c0ffee00-0000-4000-8000-000000000003", aspectRatio: "9:16", referenceImages: references }),
    stylePreset: null,
  },
  "4-square-preset-with-long-example": {
    baseUrl: "http://127.0.0.1:3000",
    brand: configuredBrand,
    carousel: carousel({
      id: "c0ffee00-0000-4000-8000-000000000004",
      name: "Pricing explained",
      aspectRatio: "1:1",
      slides: [slide("s-1", 0, "Cover")],
    }),
    stylePreset: preset({
      exampleSlideHtml: `<div style="display:grid;grid-template-columns:repeat(12,1fr)">${"<span>01</span>".repeat(60)}</div>`,
    }),
  },
  "5-portrait-preset-references-slides": {
    baseUrl: "http://127.0.0.1:43210",
    brand: plainBrand,
    carousel: carousel({
      id: "c0ffee00-0000-4000-8000-000000000005",
      slides: [slide("s-1", 0, "Cover"), slide("s-2", 1, "Proof")],
      referenceImages: references.slice(0, 1),
    }),
    stylePreset: preset({ name: "Quiet serif", exampleSlideHtml: "" }),
  },
};
