"use client";

/**
 * Export (#150): the header's Export button and its panel. A person requests
 * an Instagram Reel render of the current revision, sees why a revision
 * cannot be exported (with the clip to fix), and follows, cancels, retries,
 * plays and downloads this production's renders.
 */
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Clapperboard, Film, LoaderCircle, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { activeSummary, describeCompileIssue } from "@/lib/video/studio/render-status";
import { ExportRenderCard } from "./ExportRenderCard";
import { useRenders, type RequestOutcome } from "./ExportRenders";
import { useWorkspace } from "./workspace";

export function ExportPanel() {
  const { api, state, select } = useWorkspace();
  const { view } = state;
  const [open, setOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [outcome, setOutcome] = useState<RequestOutcome | null>(null);
  const { renders, error, request, act } = useRenders(api, view.productionId, open);
  const summary = activeSummary(renders ?? []);
  const newestSucceeded = renders?.find((r) => r.state === "succeeded")?.renderId ?? null;
  // A refusal is about the revision it was given for; after an edit the next request decides again.
  const shown = outcome && (outcome.kind !== "refused" || outcome.revision === null || outcome.revision === view.revision) ? outcome : null;

  const requestRender = async () => {
    setRequesting(true);
    setOutcome(await request());
    setRequesting(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="accent" size="sm" aria-label={summary ? `Export, ${summary}` : "Export"}>
          {summary ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Film className="h-3.5 w-3.5" aria-hidden />}
          Export
          {summary && <span className="tabular-nums opacity-90">· {summary}</span>}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay data-oc-overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          data-oc-dialog
          className="fixed right-4 top-4 bottom-4 z-50 flex w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        >
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold">Export</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-muted-foreground">
                An Instagram Reel MP4 of revision {view.revision}, verified before you can download it, with SRT and WebVTT captions.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" className="-mr-2 h-7 w-7" aria-label="Close export">
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <Button variant="accent" className="w-full" disabled={requesting} onClick={() => void requestRender()}>
              {requesting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Clapperboard className="h-4 w-4" aria-hidden />}
              Export Instagram Reel
            </Button>

            <div aria-live="polite">
              {shown?.kind === "existing" && <p className="mt-2 text-xs text-muted-foreground">Revision {shown.render.revision} already has this render; it is listed below.</p>}
              {shown?.kind === "error" && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {shown.message}
                </p>
              )}
              {shown?.kind === "refused" && (
                <ExportRefusal
                  issues={shown.issues}
                  onSelect={(clipId) => {
                    select(clipId);
                    setOpen(false);
                  }}
                />
              )}
            </div>

            <h3 className="mt-6 text-xs font-medium text-muted-foreground">Renders</h3>
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
            {renders === null && !error && <p className="mt-2 text-xs text-muted-foreground">Loading renders…</p>}
            {renders?.length === 0 && <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No renders of this production yet.</p>}
            {renders && renders.length > 0 && (
              <ul className="mt-2 space-y-2">
                {renders.map((render) => (
                  <ExportRenderCard key={render.renderId} render={render} currentRevision={view.revision} showVideo={render.renderId === newestSucceeded} act={act} />
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ExportRefusal({ issues, onSelect }: { issues: Parameters<typeof describeCompileIssue>[0][]; onSelect(clipId: string): void }) {
  return (
    <div role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
        This revision cannot be exported yet. Nothing was queued.
      </p>
      <ul className="mt-2 space-y-1.5">
        {issues.map((issue, i) => {
          const { text, clipId } = describeCompileIssue(issue);
          return (
            <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1">{text}</span>
              {clipId && (
                <Button variant="outline" size="sm" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => onSelect(clipId)}>
                  Select clip
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
