"use client";

/**
 * The editing workspace for one production (#150): media bin, preview and
 * inspector over the timeline, with history and export in the header. It
 * owns the shared workspace (session, playhead, selection, media) and the
 * global shortcuts; every panel reads the workspace and changes the
 * production only through the session.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { timelineEndFrame } from "@/lib/video/studio/frames";
import { ExportPanel } from "./ExportPanel";
import { HistoryControls } from "./HistoryControls";
import { Inspector } from "./Inspector";
import { MediaBin } from "./MediaBin";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { useMediaLibrary, usePlayhead, useProductionSession, useStudioApi, WorkspaceProvider, type Workspace } from "./workspace";

/** True when a key press belongs to a text field rather than to the Studio. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export function StudioWorkspace({ productionId, onClose }: { productionId: string; onClose: () => void }) {
  const api = useStudioApi();
  const { session, state } = useProductionSession(api, productionId);
  const { media, mediaLoaded, refreshMedia } = useMediaLibrary(api);
  const [chosenClipId, select] = useState<string | null>(null);

  const production = state.view?.production;
  const fps = production?.format.fps ?? 30;
  const plan = state.preview?.preview.ok ? state.preview.preview.plan : null;
  const durationFrames = plan ? plan.durationFrames : production ? timelineEndFrame(production) : 0;
  const { playhead, playheadState } = usePlayhead(fps, durationFrames);

  // A clip that an undo or another writer removed is no longer selected.
  const selectedClipId = chosenClipId && production?.timeline.tracks.some((t) => t.clips.some((c) => c.id === chosenClipId)) ? chosenClipId : null;

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (typing(event.target) || event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? session.redo() : session.undo());
      } else if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        void session.redo();
      } else if (event.key === " " && !mod) {
        event.preventDefault();
        playhead.toggle();
      }
    },
    [session, playhead]
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const workspace = useMemo<Workspace | null>(() => {
    if (!state.view || !state.preview) return null;
    return { api, session, state: state as Workspace["state"], playhead, playheadState, selectedClipId, select, media, mediaLoaded, refreshMedia };
  }, [api, session, state, playhead, playheadState, selectedClipId, media, mediaLoaded, refreshMedia]);

  if (!workspace) {
    return (
      <div className="m-auto flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">{state.status === "error" ? state.error?.message : "Opening the production…"}</p>
        {state.status === "error" && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void session.load()}>
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              All productions
            </Button>
          </div>
        )}
      </div>
    );
  }

  const { view, refusal } = workspace.state;
  return (
    <WorkspaceProvider value={workspace}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
          <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5 text-muted-foreground">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Productions
          </Button>
          <span className="h-4 w-px bg-border" aria-hidden />
          <h1 className="truncate text-sm font-semibold">{view.production.name}</h1>
          <span className="text-xs text-muted-foreground tabular-nums">Revision {view.revision}</span>
          <div className="ml-auto flex items-center gap-2">
            <HistoryControls />
            <ExportPanel />
          </div>
        </div>
        {refusal && (
          <div role="alert" className="flex shrink-0 items-start gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{refusal.summary} was not applied: {refusal.message}</p>
              {refusal.issues.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                  {refusal.issues.slice(0, 5).map((issue, i) => (
                    <li key={i}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => session.dismissRefusal()} aria-label="Dismiss">
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_320px]">
          <MediaBin />
          <Preview />
          <Inspector />
        </div>
        <Timeline />
      </div>
    </WorkspaceProvider>
  );
}
