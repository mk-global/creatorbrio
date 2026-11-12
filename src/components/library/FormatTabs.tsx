"use client";

/** A row of filters with counts, underlined when chosen (#175). */
export function FormatTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; count: number }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="group" aria-label="Filter by format" className="-mx-4 flex gap-1 overflow-x-auto border-b border-rule px-4 sm:mx-0 sm:px-0">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-pressed={value === t.id}
          onClick={() => onChange(t.id)}
          className={`relative flex h-11 shrink-0 items-center gap-2 px-3 text-[14px] font-medium whitespace-nowrap ${value === t.id ? "text-ink" : "text-graphite hover:text-ink"}`}
        >
          {t.label}
          <span className="num text-[12.5px] text-graphite">{t.count}</span>
          {value === t.id && <span className="absolute inset-x-3 -bottom-px h-[2px] bg-ink" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
