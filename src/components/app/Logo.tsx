/** The mark: an ink sheet with coral crop marks, the same mark the interface uses for "selected". */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      <rect x="7" y="5" width="16" height="20" rx="1.5" fill="#1c1b29" />
      <path d="M2 7V2h5M23 2h5v5M28 23v5h-5M7 28H2v-5" fill="none" stroke="#e94560" strokeWidth="2" />
    </svg>
  );
}
