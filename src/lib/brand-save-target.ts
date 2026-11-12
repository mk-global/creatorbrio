/** `setup` names the default brand on first run, `edit` changes one brand, `create` adds a brand. */
export type BrandSetupMode = "setup" | "edit" | "create";

/**
 * Where the brand editor saves (#175; before it, the brand settings dialog).
 * Editing always names its brand: with no id there is nothing safe to save
 * to, and falling back to the default brand would overwrite it with whatever
 * the editor was showing.
 */
export function brandSaveTarget(
  mode: BrandSetupMode,
  brandId: string | undefined
): { url: string; method: "PUT" | "POST" } | null {
  if (mode === "create") return { url: "/api/brands", method: "POST" };
  if (mode === "setup") return { url: "/api/brand", method: "PUT" };
  return brandId ? { url: `/api/brands/${encodeURIComponent(brandId)}`, method: "PUT" } : null;
}
