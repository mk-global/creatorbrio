"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowLeft, BookmarkPlus, ChevronDown, CopyPlus, Ellipsis, Maximize2, MessageSquare, Ratio as RatioIcon, ScanLine, Trash2 } from "lucide-react";
import { Swatches } from "@/components/app/BrandSwitcher";
import { Menu } from "@/components/app/Menu";
import { brandDisplayName } from "@/lib/brand-display";
import { FORMATS, SIZE_NAMES, sizePixels, type ProjectFormat } from "@/lib/formats";
import type { Brand } from "@/types/brand";
import type { AspectRatio, Carousel } from "@/types/carousel";

/**
 * The editor's header (#175, Design C): the project's name (rename in place),
 * its format and brand, the More menu and Export on the first row; the size,
 * safe zones, full-screen preview and the chat on the second; and on phones
 * a Preview or Chat switch, because both do not fit side by side.
 */
export function EditorHeader({
  carousel,
  format,
  brand,
  exportButton,
  onRename,
  onSize,
  safeZones,
  onSafeZones,
  onFullscreen,
  chatOpen,
  onChatOpen,
  pane,
  onPane,
  onDuplicate,
  onSaveTemplate,
  onDelete,
}: {
  carousel: Carousel;
  format: ProjectFormat;
  brand: Brand | undefined;
  exportButton: React.ReactNode;
  /** Saves the name; false when it was not saved, so the field shows the stored name again. */
  onRename: (name: string) => Promise<boolean>;
  onSize: (size: AspectRatio) => void;
  safeZones: boolean;
  onSafeZones: (on: boolean) => void;
  onFullscreen: () => void;
  chatOpen: boolean;
  onChatOpen: (open: boolean) => void;
  pane: "preview" | "chat";
  onPane: (pane: "preview" | "chat") => void;
  onDuplicate: () => void;
  onSaveTemplate: () => void;
  onDelete: () => void;
}) {
  const def = FORMATS[format];
  const [name, setName] = useState(carousel.name);
  const [shownName, setShownName] = useState(carousel.name);
  // A rename from elsewhere (another tab, a reload) replaces what is shown, unless it is being edited.
  if (carousel.name !== shownName) {
    setShownName(carousel.name);
    setName(carousel.name);
  }
  const empty = carousel.slides.length === 0;
  // Escape cancels: the blur it causes must not save. State set in the same
  // key event is not visible to the blur handler yet, so a ref carries it.
  const cancelling = useRef(false);
  const commitName = async () => {
    const v = name.trim();
    if (cancelling.current || !v || v === carousel.name) {
      cancelling.current = false;
      setName(carousel.name);
      return;
    }
    if (!(await onRename(v))) setName(carousel.name);
  };

  return (
    <header className="shrink-0 border-b border-rule bg-sheet">
      <div className="flex h-14 items-center gap-2 px-2 sm:px-4">
        {/* On phones the editor has no navigation, so it offers a way back; wider screens have the rail. */}
        <Link href="/projects" className="btn btn-ghost btn-icon shrink-0 md:hidden" aria-label="Back to projects">
          <ArrowLeft className="size-[18px]" aria-hidden="true" />
        </Link>
        <div className="min-w-0 flex-1">
          <label htmlFor="project-name" className="sr-only">
            Project name
          </label>
          <input
            id="project-name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancelling.current = true;
                e.currentTarget.blur();
              }
            }}
            className="w-full truncate rounded-md bg-transparent px-2 py-1 text-[16px] font-semibold outline-none hover:bg-ground focus-visible:shadow-[inset_0_0_0_2px_var(--color-ink)]"
          />
        </div>
        <div className="hidden items-center gap-2 text-[13px] md:flex">
          <span className="tag tag-neutral h-6">{def.name}</span>
          {brand && (
            <span className="inline-flex h-6 max-w-[200px] items-center gap-1.5 rounded-full bg-hover px-2 font-semibold" title="A project keeps its brand for life">
              <Swatches brand={brand} size={9} />
              <span className="truncate">{brandDisplayName(brand)}</span>
            </span>
          )}
        </div>
        <Menu
          label="More actions"
          trigger={<Ellipsis className="size-[18px]" aria-hidden="true" />}
          items={[
            { label: "Duplicate", icon: <CopyPlus />, onSelect: onDuplicate },
            {
              label: "Save as template",
              hint: empty ? "Design the slides first" : `For ${brandDisplayName(brand)}`,
              icon: <BookmarkPlus />,
              onSelect: onSaveTemplate,
              disabled: empty,
            },
            { label: "Delete", icon: <Trash2 />, danger: true, onSelect: onDelete },
          ]}
        />
        {exportButton}
      </div>
      <div className="flex items-center gap-1 overflow-x-auto border-t border-rule px-2 py-1.5 sm:px-4">
        {def.sizes.length > 1 ? (
          <Menu
            label={`Size: ${SIZE_NAMES[carousel.aspectRatio]} ${carousel.aspectRatio}. Change size`}
            align="start"
            width={260}
            triggerClassName="btn btn-ghost btn-sm shrink-0"
            trigger={
              <>
                <RatioIcon className="size-4" aria-hidden="true" /> Size {carousel.aspectRatio} <ChevronDown className="size-3.5 opacity-70" aria-hidden="true" />
              </>
            }
            items={def.sizes.map((r) => ({
              label: `${SIZE_NAMES[r]} ${r}`,
              hint: sizePixels(r),
              checked: r === carousel.aspectRatio,
              onSelect: () => r !== carousel.aspectRatio && onSize(r),
            }))}
          />
        ) : (
          <span className="inline-flex h-8 shrink-0 items-center gap-2 px-3 text-[13px] font-semibold text-graphite">
            <RatioIcon className="size-4" aria-hidden="true" /> Size {def.sizes[0]}, fixed
          </span>
        )}
        <button type="button" aria-pressed={safeZones} onClick={() => onSafeZones(!safeZones)} className={`btn btn-ghost btn-sm shrink-0 ${safeZones ? "bg-hover" : ""}`}>
          <ScanLine className="size-4" aria-hidden="true" /> Safe zones
        </button>
        <button type="button" onClick={onFullscreen} className="btn btn-ghost btn-sm shrink-0" disabled={empty}>
          <Maximize2 className="size-4" aria-hidden="true" /> Full screen
        </button>
        <button
          type="button"
          aria-pressed={chatOpen}
          onClick={() => onChatOpen(!chatOpen)}
          className={`btn btn-ghost btn-sm hidden shrink-0 lg:inline-flex ${chatOpen ? "bg-hover" : ""}`}
        >
          <MessageSquare className="size-4" aria-hidden="true" /> Chat
        </button>
        <span className="num ml-auto hidden shrink-0 px-2 text-[13px] text-graphite sm:inline">
          {sizePixels(carousel.aspectRatio)}, {carousel.slides.length} of {def.maxSlides} {def.maxSlides === 1 ? def.unit.one : def.unit.many}
        </span>
      </div>
      <div className="grid grid-cols-2 border-t border-rule lg:hidden" role="group" aria-label="Show">
        {(["preview", "chat"] as const).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={pane === p}
            onClick={() => onPane(p)}
            className={`relative h-11 text-[14px] font-semibold ${pane === p ? "text-ink" : "text-graphite"}`}
          >
            {p === "preview" ? "Preview" : "Chat"}
            {pane === p && <span className="absolute inset-x-6 bottom-0 h-[2px] bg-ink" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </header>
  );
}
