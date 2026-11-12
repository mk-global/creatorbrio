import type { BrandColors, BrandConfig } from "@/types/brand";

/**
 * How a brand is named and described on screen (#175). A brand that was never
 * set up has an empty name; it still works, with the default look, and is
 * shown as "Your brand" until it is named.
 */
export function brandDisplayName(brand: Pick<BrandConfig, "name"> | null | undefined): string {
  return brand?.name.trim() || "Your brand";
}

/** Whether the brand has been named, which is what "set up" means to a person. */
export function brandIsSetUp(brand: Pick<BrandConfig, "name"> | null | undefined): boolean {
  return !!brand?.name.trim();
}

/** The five colours in the order the palette shows them, with the words people read. */
export const COLOR_ROLES: readonly { key: keyof BrandColors; label: string }[] = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
  { key: "background", label: "Background" },
  { key: "surface", label: "Surface" },
];

/** A CSS font stack for a brand font, with a neutral fallback while it loads. */
export function fontStack(family: string): string {
  return `"${family.replace(/["\\]/g, "")}", ui-sans-serif, system-ui, sans-serif`;
}

/** "Calm" from "calm": personality words are stored as typed, shown capitalised. */
export function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
