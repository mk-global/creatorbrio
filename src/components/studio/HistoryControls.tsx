"use client";

/**
 * Undo and Redo in the Studio header (#150), through the production session
 * and so through the API. Each names the step it would apply; both are off
 * while a command is in flight, which a small indicator shows. A refused
 * undo or redo appears in the workspace's refusal banner.
 */
import { Loader2, Redo2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { historyActions } from "@/lib/video/studio/history-labels";
import { useWorkspace } from "./workspace";

export function HistoryControls() {
  const { session, state } = useWorkspace();
  const { undo, redo } = historyActions(state.view, state.busy);
  return (
    <div role="group" aria-label="History" className="flex items-center gap-1">
      <span className="flex h-8 w-6 items-center justify-center" aria-live="polite">
        {state.busy && (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />
            <span className="sr-only">Saving the change</span>
          </>
        )}
      </span>
      <Button variant="ghost" size="sm" className="h-8 w-8 px-0" disabled={!undo.enabled} title={undo.title} aria-label={undo.title} aria-keyshortcuts="Meta+Z Control+Z" onClick={() => void session.undo()}>
        <Undo2 className="h-4 w-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 px-0"
        disabled={!redo.enabled}
        title={redo.title}
        aria-label={redo.title}
        aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z Control+Y"
        onClick={() => void session.redo()}
      >
        <Redo2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
