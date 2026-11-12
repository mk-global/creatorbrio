/**
 * The brand for new work, chosen in the sidebar (#175).
 *
 * It is a view preference of this browser, nothing more: it chooses what Home
 * and the library show for "this brand" and preselects the brand of a new
 * project. It is never sent to the chat and never stored on a carousel, so
 * changing it cannot alter an existing project or the brand its generations
 * use.
 */

// Keeps the product's former name: renaming the key would reset every saved selection.
export const SELECTED_BRAND_KEY = "framewoven:selected-brand";

/** The stored choice while that brand still exists, otherwise the default brand. */
export function chooseSelectedBrandId(
  brands: readonly { id: string }[],
  stored: string | null,
  defaultBrandId: string
): string {
  return stored !== null && brands.some((b) => b.id === stored) ? stored : defaultBrandId;
}

/** Storage can be unavailable (private windows, blocked site data); that only loses the preference. */
export function readStoredBrandId(storage: Pick<Storage, "getItem"> | undefined): string | null {
  try {
    return storage?.getItem(SELECTED_BRAND_KEY) ?? null;
  } catch {
    return null;
  }
}

export function storeBrandId(storage: Pick<Storage, "setItem"> | undefined, brandId: string): void {
  try {
    storage?.setItem(SELECTED_BRAND_KEY, brandId);
  } catch {
    // Only the preference is lost; the dashboard falls back to the default brand.
  }
}
