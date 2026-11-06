"use client";

/**
 * One clip on the Studio timeline (#150): the block the widget positions,
 * drawn in its kind's colour with its label, and the focusable control a
 * keyboard reaches it by. It is a `div` with `role="button"`, not a native
 * button, so Space keeps playing and pausing (the workspace's shortcut)
 * instead of also activating the clip. Its keys are handled by the timeline.
 */
import type { KeyboardEvent } from "react";

import { cn } from "@/lib/utils";
import type { ClipTone, LaneClipView } from "@/lib/video/studio/timeline-view";

const TONES: Record<ClipTone, string> = {
  video: "border-sky-300 bg-sky-100 text-sky-950",
  image: "border-pink-300 bg-pink-100 text-pink-950",
  audio: "border-emerald-300 bg-emerald-100 text-emerald-950",
  title: "border-violet-300 bg-violet-100 text-violet-950",
  captions: "border-amber-300 bg-amber-100 text-amber-950",
  graphic: "border-zinc-300 bg-zinc-100 text-zinc-900",
};

export interface TimelineClipProps {
  view: LaneClipView;
  selected: boolean;
  onKeyDown(clipId: string, event: KeyboardEvent<HTMLDivElement>): void;
}

export function TimelineClip({ view, selected, onKeyDown }: TimelineClipProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={view.name}
      aria-pressed={selected}
      aria-keyshortcuts="ArrowLeft ArrowRight [ ] , . S Delete Enter Escape"
      data-clip-id={view.clip.id}
      title={view.label}
      onKeyDown={(event) => onKeyDown(view.clip.id, event)}
      className={cn(
        "absolute inset-x-0 inset-y-[3px] flex cursor-grab select-none items-center overflow-hidden rounded-[5px] border px-2 text-[11px] font-medium leading-none outline-none active:cursor-grabbing",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        TONES[view.tone],
        selected && "border-accent shadow-[inset_0_0_0_1px_var(--accent)]"
      )}
    >
      <span className="truncate">{view.label}</span>
    </div>
  );
}
