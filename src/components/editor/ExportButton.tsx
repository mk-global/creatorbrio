"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Download,
  Loader2,
  Check,
  AlertTriangle,
  ChevronDown,
  Hourglass,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  exportFormatsFor,
  filenameFromDisposition,
  linkedInAdvisory,
  type ExportFormat,
  type ExportFormatOption,
} from "@/lib/export-formats";
import type { AspectRatio } from "@/types/carousel";
import type { Interruption } from "@/lib/generation-status";
import { InterruptedExportNotice } from "./InterruptedExportNotice";
import { ExportErrorCard } from "./ExportErrorCard";

interface ExportButtonProps {
  carouselId: string;
  slideCount: number;
  aspectRatio: AspectRatio;
  /**
   * True while the design agent may still be adding or changing slides. Export
   * is unavailable until it ends, so a download never captures a half-made
   * carousel.
   */
  generating?: boolean;
  /**
   * Set when the last generation stopped, failed or timed out after changing
   * slides. The export choices are then replaced by a notice until the user
   * confirms the slides through `onAcceptInterrupted` or a later run completes.
   */
  interrupted?: Interruption | null;
  /** How many slides the interrupted design planned, from its Continue offer; null when unknown. */
  plannedSlides?: number | null;
  onAcceptInterrupted?: () => Promise<void>;
  /** The project format's main export, offered first (#175). */
  primary?: ExportFormat;
}

const GENERATING_HINT =
  "Export becomes available when the AI finishes generating slides.";

/**
 * The name the browser saves the download under. The ZIP keeps the name it has
 * always had; the PDF and the single PNG take the carousel-based name the
 * server sends, because LinkedIn offers the file name as the document's title.
 */
function downloadName(
  option: ExportFormatOption,
  carouselId: string,
  response: Response
): string {
  const fallback = `carousel-${carouselId}.${option.extension}`;
  if (option.format === "png") return fallback;
  return (
    filenameFromDisposition(response.headers.get("Content-Disposition")) ??
    fallback
  );
}

export function ExportButton({
  carouselId,
  slideCount,
  aspectRatio,
  generating = false,
  interrupted = null,
  plannedSlides = null,
  onAcceptInterrupted,
  primary,
}: ExportButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const advisory = linkedInAdvisory(aspectRatio);
  const disabled = exporting !== null || slideCount === 0 || generating;

  // Generation starting closes the menu instead of leaving its choices open.
  if (generating && menuOpen) setMenuOpen(false);

  // Close the menu on an outside click or Escape, and move focus into it when
  // it opens so the keyboard can pick a format straight away. Focus returns to
  // the trigger only if it was still in the menu, never from elsewhere.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"], button')
      ?.focus();

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const focusInMenu = menuRef.current?.contains(document.activeElement);
      setMenuOpen(false);
      if (focusInMenu) triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // Arrow keys move between items, which stay out of the tab order. Tab leaves
  // the menu, so it closes rather than staying open behind the focus.
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      setMenuOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]'
      ) ?? []
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length]?.focus();
  };

  const handleExport = async (option: ExportFormatOption) => {
    setMenuOpen(false);
    if (disabled || interrupted) return;
    setExporting(option.format);
    setDone(false);
    setError(null);

    try {
      const response = await fetch(
        `/api/carousels/${carouselId}/export?format=${option.format}`,
        { method: "POST" }
      );

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ||
            `The export failed with status ${response.status}.`
        );
      }

      // The route renders every slide and answers with the finished file in one
      // response. There is no progress stream to read, so the button reports an
      // indeterminate state rather than a slide counter that never moves.
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadName(option, carouselId, response);
      a.click();
      URL.revokeObjectURL(url);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The export failed. See the server console for details."
      );
    } finally {
      setExporting(null);
    }
  };

  return (
    // The hint sits on the wrapper because a disabled button shows no tooltip.
    <div
      ref={rootRef}
      className="relative"
      title={generating ? GENERATING_HINT : undefined}
    >
      <Button
        ref={triggerRef}
        onClick={() => {
          // The menu and the error card share a position; opening one clears
          // the other.
          setError(null);
          setMenuOpen((open) => !open);
        }}
        disabled={disabled}
        variant="accent"
        size="sm"
        aria-haspopup={interrupted ? "dialog" : "menu"}
        aria-expanded={menuOpen}
        aria-label={
          generating
            ? `Export unavailable. ${GENERATING_HINT}`
            : interrupted
              ? "Export: the last generation did not finish"
              : undefined
        }
      >
        <span
          key={
            exporting
              ? "exporting"
              : generating
                ? "generating"
                : done
                  ? "done"
                  : "idle"
          }
          className="oc-enter-pop inline-flex items-center gap-2"
        >
          {exporting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                Exporting {exporting === "pdf" ? "PDF · " : ""}
                {slideCount} slide{slideCount === 1 ? "" : "s"}…
              </span>
            </>
          ) : generating ? (
            <>
              <Hourglass className="h-4 w-4" />
              <span>Waiting for slides…</span>
            </>
          ) : interrupted ? (
            <>
              <AlertTriangle className="h-4 w-4" />
              <span>Incomplete</span>
              <ChevronDown className="h-3.5 w-3.5 -ml-1" />
            </>
          ) : done ? (
            <>
              <Check className="h-4 w-4" />
              <span>Downloaded!</span>
            </>
          ) : (
            <>
              <Download className="h-4 w-4" />
              <span>Export</span>
              <ChevronDown className="h-3.5 w-3.5 -ml-1" />
            </>
          )}
        </span>
      </Button>

      {menuOpen && interrupted && (
        <div
          ref={menuRef}
          className="oc-enter-pop absolute right-0 top-full mt-2 z-30 w-80 rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          <InterruptedExportNotice
            reason={interrupted.reason}
            slideCount={slideCount}
            plannedSlides={plannedSlides}
            onAccept={async () => {
              await onAcceptInterrupted?.();
            }}
          />
        </div>
      )}

      {menuOpen && !interrupted && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Export format"
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
              setMenuOpen(false);
            }
          }}
          className="oc-enter-pop absolute right-0 top-full mt-2 z-30 w-72 rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {exportFormatsFor(slideCount, primary).map((option) => {
            const note = option.format === "pdf" ? advisory : null;
            return (
              <button
                key={option.format}
                role="menuitem"
                tabIndex={-1}
                onClick={() => handleExport(option)}
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left transition-colors",
                  "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                )}
              >
                <span className="block text-xs font-semibold text-foreground">
                  {option.platform} · {option.label}
                </span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  {option.description}
                </span>
                {note && (
                  <span className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
                    <Info className="h-3 w-3 shrink-0 mt-px" />
                    <span>{note}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <ExportErrorCard message={error} onDismiss={() => setError(null)} />
      )}
    </div>
  );
}
