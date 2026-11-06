"use client";

/**
 * One selected clip in the Inspector (#150): its kind, track and timing, then
 * the editor its kind has. Media clips show their source range read-only;
 * graphics clips of a capability the Studio has no form for show their
 * parameters read-only.
 */
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { graphicKindOf } from "@/lib/video/studio/capability-forms";
import { trackLabel, type ClipFacts } from "@/lib/video/studio/clip-placement";
import { formatTimecode } from "@/lib/video/studio/frames";
import { Fact } from "./InspectorFields";
import { InspectorGraphic, type DraftEntry } from "./InspectorGraphic";
import { useWorkspace } from "./workspace";

interface Props {
  facts: ClipFacts;
  draft: DraftEntry | null;
  updateDraft(clipId: string, update: (previous: DraftEntry | null) => DraftEntry | null): void;
}

export function InspectorClip({ facts, draft, updateDraft }: Props) {
  const { state, select } = useWorkspace();
  const fps = state.view.production.format.fps;
  const { clip } = facts;
  const tc = (frame: number) => formatTimecode(frame, fps);
  const kind = clip.kind === "graphics" ? graphicKindOf(clip.capability.id, clip.capability.version) : null;

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{facts.kindLabel}</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {facts.mediaLabel ?? (clip.kind === "graphics" ? `${clip.capability.id} ${clip.capability.version}` : clip.id)}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="-mr-1 h-7 w-7 shrink-0" onClick={() => select(null)} aria-label="Deselect clip">
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-b border-border px-4 py-3 text-xs">
        <Fact label="Track" value={trackLabel(facts.track.id)} />
        <Fact label="Start" value={tc(facts.start)} />
        <Fact label="End" value={tc(facts.end)} />
        <Fact label="Length" value={`${tc(facts.length)} (${facts.length} frames)`} />
        {facts.source && (
          <>
            <Fact label="Source in" value={tc(facts.source.inFrame)} />
            <Fact label="Source out" value={tc(facts.source.outFrame)} />
          </>
        )}
      </dl>

      {clip.kind === "graphics" && kind && (
        <InspectorGraphic
          key={clip.id}
          clip={clip}
          info={kind}
          entry={draft}
          update={(fn) => updateDraft(clip.id, fn)}
        />
      )}
      {clip.kind === "graphics" && !kind && <ReadOnlyParams params={clip.capability.params} note="The Studio has no form for this capability, so its parameters are shown as stored." />}
      {clip.kind !== "graphics" && (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Trim and move this clip on the timeline. Its source range is shown in the production&apos;s timecode.
        </p>
      )}
    </div>
  );
}

export function ReadOnlyParams({ params, note }: { params: unknown; note: string }) {
  return (
    <div className="px-4 py-3">
      <p className="text-xs text-muted-foreground">{note}</p>
      <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border bg-muted p-2 font-mono text-[11px] leading-4 text-foreground">
        {JSON.stringify(params, null, 2)}
      </pre>
    </div>
  );
}
