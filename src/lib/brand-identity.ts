/**
 * CreatorBrio Brand Identity v1.0 (#189): the product's own palette, for the
 * few places CSS cannot reach, such as the browser theme colour in page
 * metadata. Components use the CSS tokens in src/app/globals.css instead.
 *
 * These values must equal the --brand-* variables in globals.css and the
 * tables in docs/brand/; tests/brand-identity.test.ts enforces it.
 *
 * This is CreatorBrio's identity, not a person's brand. Nothing that renders
 * slides, exports or design instructions may import it.
 */
export const PRODUCT_PALETTE = {
  coral: "#E94560",
  deepCoral: "#BF394F",
  ink: "#1C1B29",
  canvas: "#F1F2F4",
  paper: "#FFFFFF",
  blush: "#FFF0F3",
  graphite: "#585767",
  rule: "#D9DBE1",
} as const;

export type ProductColor = keyof typeof PRODUCT_PALETTE;
