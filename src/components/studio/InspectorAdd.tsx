"use client";

/**
 * The Inspector with nothing selected (#150): add a title card, a lower third
 * or timed captions at the playhead, each as one change set, then select it.
 */
import { useState } from "react";
import { Captions, Heading, IdCard, type LucideIcon } from "lucide-react";

import { formatTimecode } from "@/lib/video/studio/frames";
import { GRAPHIC_KINDS, type GraphicKind } from "@/lib/video/studio/capability-forms";
import { freshClipId, insertGraphic, trackLabel } from "@/lib/video/studio/clip-placement";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./workspace";

const ICONS: Record<GraphicKind, LucideIcon> = { "title-card": Heading, "lower-third": IdCard, captions: Captions };

export function InspectorAdd() {
  const { session, state, playheadState, select } = useWorkspace();
  const production = state.view.production;
  const fps = production.format.fps;
  const [problem, setProblem] = useState<string | null>(null);

  async function add(kind: GraphicKind) {
    const placed = insertGraphic(production, kind, playheadState.frame, freshClipId(production));
    if (!placed.ok) {
      setProblem(placed.reason);
      return;
    }
    setProblem(null);
    const label = GRAPHIC_KINDS.find((k) => k.kind === kind)!.label;
    if ((await session.apply(`Add ${label.toLowerCase()}`, [placed.op])) === "applied") select(placed.clipId);
  }

  return (
    <div className="p-4">
      <h2 className="text-sm font-semibold">Add</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        At the playhead, {formatTimecode(playheadState.frame, fps)}, or the next free spot on its track.
      </p>
      <ul className="mt-3 space-y-2">
        {GRAPHIC_KINDS.map((info) => {
          const Icon = ICONS[info.kind];
          return (
            <li key={info.kind}>
              <button
                type="button"
                disabled={state.busy}
                onClick={() => void add(info.kind)}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left transition-colors",
                  "hover:border-foreground/20 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                )}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover:bg-surface group-hover:text-foreground">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-foreground">{info.label}</span>
                  <span className="block text-[11px] leading-4 text-muted-foreground">{info.hint}</span>
                  <span className="block text-[11px] leading-4 text-muted-foreground/80">
                    {info.seconds} s on the {trackLabel(info.trackId).toLowerCase()} track
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {problem && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {problem}
        </p>
      )}
      <p className="mt-6 text-xs text-muted-foreground">Select a clip on the timeline to see and edit it here.</p>
    </div>
  );
}
