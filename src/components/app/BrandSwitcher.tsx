"use client";

import { useRouter } from "next/navigation";
import { ChevronsUpDown, Palette } from "lucide-react";
import { brandDisplayName } from "@/lib/brand-display";
import type { Brand } from "@/types/brand";
import { useApp } from "./AppContext";
import { Menu } from "./Menu";

/** Three of a brand's colours, overlapped: how a brand is recognised at a glance. */
export function Swatches({ brand, size = 10 }: { brand: Pick<Brand, "colors">; size?: number }) {
  const c = brand.colors;
  return (
    <span className="inline-flex shrink-0" aria-hidden="true">
      {[c.primary, c.accent, c.secondary].map((col, i) => (
        <span
          key={i}
          className="rounded-full ring-2 ring-sheet"
          style={{ width: size, height: size, background: col, marginLeft: i ? -size * 0.3 : 0 }}
        />
      ))}
    </span>
  );
}

/**
 * The brand new work uses (#175). Choosing one is a view preference kept in
 * this browser; it never moves an existing project to another brand. In the
 * sidebar it is a full-width control (a swatch button in the rail); in the
 * phone header it is a chip that names the brand.
 */
export function BrandSwitcher({ variant }: { variant: "side" | "header" }) {
  const { brands, selectedBrand, select } = useApp();
  const router = useRouter();
  if (!selectedBrand) {
    // Until the brands load there is nothing to choose; keep the space so nothing jumps.
    return <div className={variant === "side" ? "min-h-12" : "h-10"} aria-hidden="true" />;
  }
  const name = brandDisplayName(selectedBrand);
  const items = [
    ...brands.map((b) => ({
      label: brandDisplayName(b),
      hint: `${b.fonts.heading}${b.styleKeywords.length ? `, ${b.styleKeywords.slice(0, 2).join(", ")}` : ", not described yet"}`,
      icon: <Swatches brand={b} size={11} />,
      checked: b.id === selectedBrand.id,
      onSelect: () => b.id !== selectedBrand.id && select(b.id),
    })),
    { label: "Manage brands", icon: <Palette />, onSelect: () => router.push("/brands") },
  ];
  const common = {
    label: `Brand for new work: ${name}. Change brand`,
    width: 280,
    align: "start" as const,
    header: "New projects use this brand.",
    items,
  };

  if (variant === "header") {
    return (
      <Menu
        {...common}
        wrapperClassName="relative flex min-w-0"
        triggerClassName="flex h-10 min-w-0 items-center gap-2 rounded-lg bg-sheet px-2.5 shadow-[inset_0_0_0_1px_var(--color-rule)]"
        trigger={
          <>
            <Swatches brand={selectedBrand} size={11} />
            <span className="min-w-0 truncate text-[14px] font-semibold">{name}</span>
            <ChevronsUpDown className="size-4 shrink-0 text-graphite" aria-hidden="true" />
          </>
        }
      />
    );
  }

  return (
    <>
      <Menu
        {...common}
        wrapperClassName="wide-only relative flex"
        triggerClassName="flex min-h-12 w-full min-w-0 items-center gap-2.5 rounded-[10px] bg-sheet px-3 py-1.5 text-left shadow-[inset_0_0_0_1px_var(--color-rule)] hover:shadow-[inset_0_0_0_1px_var(--color-rule-strong)]"
        trigger={
          <>
            <Swatches brand={selectedBrand} size={12} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] leading-tight text-graphite">Brand for new work</span>
              <span className="block truncate text-[14px] leading-tight font-semibold">{name}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-graphite" aria-hidden="true" />
          </>
        }
      />
      <Menu
        {...common}
        wrapperClassName="rail-only relative flex justify-center"
        triggerClassName="flex size-11 items-center justify-center rounded-[10px] bg-sheet shadow-[inset_0_0_0_1px_var(--color-rule)]"
        trigger={<Swatches brand={selectedBrand} size={12} />}
      />
    </>
  );
}
