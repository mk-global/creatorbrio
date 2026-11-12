/**
 * The CreatorBrio mark (Brand Identity v1.0, #189): an ink sheet inside four
 * coral crop corners, the same crop marks the interface draws around selected
 * work. Colours come from the brand tokens; the standalone files, lockups and
 * favicon are in docs/brand/assets and the rules in
 * docs/brand/CREATORBRIO-BRAND-GUIDELINES.md. Below 24 px use the favicon
 * drawing instead, whose corners are drawn for the pixel grid.
 */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      <rect x="7" y="5" width="16" height="20" rx="1.5" className="fill-ink" />
      <path d="M2 7V2h5M23 2h5v5M28 23v5h-5M7 28H2v-5" fill="none" className="stroke-crop" strokeWidth="2" />
    </svg>
  );
}
