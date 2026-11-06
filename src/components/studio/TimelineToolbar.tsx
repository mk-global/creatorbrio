"use client";

/**
 * The timeline's toolbar (#150): commands on the selected clip (split at the
 * playhead, swap with a neighbour, delete), zoom, the keyboard help and a
 * quiet sign while a command is in flight. The buttons commit the same edits
 * as the keys; each is one change set.
 */
import { ArrowLeftToLine, ArrowRightToLine, Loader2, Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { TimelineCommand } from "@/lib/video/studio/timeline-keys";
import { TimelineKeyboardHelp } from "./TimelineKeyboardHelp";

export interface TimelineToolbarProps {
  /** Which commands the selected clip allows; all false with nothing selected. */
  can: { split: boolean; earlier: boolean; later: boolean; delete: boolean };
  busy: boolean;
  /** The selected clip's label, or null. */
  selectedLabel: string | null;
  onCommand(command: TimelineCommand): void;
  zoom: { canIn: boolean; canOut: boolean; onIn(): void; onOut(): void };
}

function ToolButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick(): void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

export function TimelineToolbar({ can, busy, selectedLabel, onCommand, zoom }: TimelineToolbarProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <h2 className="px-1 text-xs font-semibold text-foreground">Timeline</h2>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <ToolButton label="Split at the playhead" disabled={busy || !can.split} onClick={() => onCommand({ kind: "split" })}>
        <Scissors className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Swap with the clip before" disabled={busy || !can.earlier} onClick={() => onCommand({ kind: "reorder", direction: "earlier" })}>
        <ArrowLeftToLine className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Swap with the clip after" disabled={busy || !can.later} onClick={() => onCommand({ kind: "reorder", direction: "later" })}>
        <ArrowRightToLine className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Delete clip" disabled={busy || !can.delete} onClick={() => onCommand({ kind: "delete" })}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <span className="ml-1 min-w-0 truncate text-xs text-muted-foreground" aria-live="polite">
        {selectedLabel ? `Selected: ${selectedLabel}` : "Select a clip to edit it"}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <span className="flex w-16 items-center justify-end gap-1 text-xs text-muted-foreground" role="status" aria-live="polite">
          {busy && (
            <>
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Saving
            </>
          )}
        </span>
        <ToolButton label="Zoom out" disabled={!zoom.canOut} onClick={zoom.onOut}>
          <ZoomOut className="h-3.5 w-3.5" aria-hidden />
        </ToolButton>
        <ToolButton label="Zoom in" disabled={!zoom.canIn} onClick={zoom.onIn}>
          <ZoomIn className="h-3.5 w-3.5" aria-hidden />
        </ToolButton>
        <TimelineKeyboardHelp />
      </div>
    </div>
  );
}
