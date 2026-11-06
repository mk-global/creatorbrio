"use client";

/**
 * The Studio timeline (#150): one lane per track of the stored production,
 * the ruler with the playhead, and the edits a person makes with the pointer,
 * the keyboard or the toolbar. Everything drawn is derived from
 * `state.view.production` on every render; the only local state is the zoom
 * and the widget's mount (`epoch`). Every edit is one change set through
 * `session.apply`, built by the pure commands in `src/lib/video/studio/edits.ts`.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { CommandOutcome } from "@/lib/video/studio/production-session";
import { findClip, neighbours, overlaps, planMoveGesture, planTrimGesture, trimRange, type Edit } from "@/lib/video/studio/edits";
import { secondsToFrame, timelineEndFrame } from "@/lib/video/studio/frames";
import { commandEdit, keyCommand, type TimelineCommand } from "@/lib/video/studio/timeline-keys";
import { fitZoomIndex, laneViews, ZOOM_STEPS } from "@/lib/video/studio/timeline-view";
import { TimelineLanes } from "./TimelineLanes";
import { TimelineToolbar } from "./TimelineToolbar";
import { useWorkspace } from "./workspace";

/** The width the lanes have beside their labels, for fitting the production on first open. */
const fitWidth = () => (typeof window === "undefined" ? 1200 : window.innerWidth - 88 - 48);

export function Timeline() {
  const { session, state, playhead, playheadState, selectedClipId, select, media } = useWorkspace();
  const production = state.view.production;
  const fps = production.format.fps;
  const busy = state.busy;
  const root = useRef<HTMLElement>(null);
  const editStartedAt = useRef<number | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [zoom, setZoom] = useState(() => fitZoomIndex(timelineEndFrame(production) / fps, fitWidth()));

  const lanes = useMemo(() => laneViews(production, media), [production, media]);
  const selected = selectedClipId ? findClip(production, selectedClipId) : null;
  const selectedView = selectedClipId ? lanes.flatMap((l) => l.clips).find((c) => c.clip.id === selectedClipId) ?? null : null;

  // Per-edit cost in the browser: from the end of the gesture (or the key press) to the redrawn timeline.
  useLayoutEffect(() => {
    const started = editStartedAt.current;
    if (started === null) return;
    editStartedAt.current = null;
    requestAnimationFrame(() => {
      if (root.current) root.current.dataset.lastEditMs = String(Math.round(performance.now() - started));
    });
  }, [production]);

  const mediaDurationUs = useCallback(
    (clipId: string): number | undefined => {
      const clip = findClip(production, clipId)?.clip;
      if (!clip || (clip.kind !== "video" && clip.kind !== "audio")) return undefined;
      return media.find((m) => m.mediaId === clip.source.mediaId)?.facts.durationUs;
    },
    [production, media]
  );

  const focusClip = (clipId: string | null) => {
    if (!clipId) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(clipId)}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  };

  /** Commits one edit; nothing is sent when there is nothing to change or a command is in flight. */
  const commit = (edit: Edit | null): Promise<CommandOutcome | null> => {
    if (!edit || state.busy) return Promise.resolve(null);
    editStartedAt.current = performance.now();
    return session.apply(edit.summary, edit.ops);
  };

  /** A pointer gesture the store did not take: draw the stored rows again. */
  const settleGesture = (outcome: CommandOutcome | null) => {
    if (outcome !== "applied") setEpoch((e) => e + 1);
  };

  const runCommand = (clipId: string, command: TimelineCommand, fromKeyboard: boolean) => {
    if (command.kind === "select") return select(clipId);
    if (command.kind === "deselect") return select(null);
    const found = findClip(production, clipId);
    if (!found) return;
    select(clipId);
    const around = neighbours(found.track, clipId);
    const edit = commandEdit(production, clipId, command, { playheadFrame: playhead.currentFrame(), mediaDurationUs: mediaDurationUs(clipId) });
    void commit(edit).then((outcome) => {
      let next: string | null = clipId;
      if (command.kind === "delete" && outcome === "applied") {
        next = around.next?.id ?? around.prev?.id ?? null;
        select(next);
      }
      // A reorder or delete re-renders the lane; keep the keyboard where the person was working.
      if (fromKeyboard) requestAnimationFrame(() => focusClip(next));
    });
  };

  const onClipKeyDown = (clipId: string, event: KeyboardEvent<HTMLDivElement>) => {
    const command = keyCommand(event);
    if (!command) return;
    // Handled here: the browser and the workspace's own shortcuts ignore it.
    event.preventDefault();
    if (busy && command.kind !== "select" && command.kind !== "deselect") return;
    runCommand(clipId, command, true);
  };

  const canMove = (clipId: string, startSeconds: number) => {
    const found = findClip(production, clipId);
    return !!found && !overlaps(found.track, clipId, secondsToFrame(startSeconds, fps), found.clip.duration);
  };

  const canTrim = (clipId: string, dir: "left" | "right", startSeconds: number, endSeconds: number) => {
    const range = trimRange(production, clipId, dir === "left" ? "in" : "out", mediaDurationUs(clipId));
    const frame = secondsToFrame(dir === "left" ? startSeconds : endSeconds, fps);
    return !!range && frame >= range.min && frame <= range.max;
  };

  const frame = playheadState.frame;
  const around = selected ? neighbours(selected.track, selected.clip.id) : null;
  const can = {
    split: !!selected && frame > selected.clip.start && frame < selected.clip.start + selected.clip.duration,
    earlier: !!around?.prev,
    later: !!around?.next,
    delete: !!selected,
  };
  const empty = lanes.every((l) => l.clips.length === 0);

  return (
    <section ref={root} aria-label="Timeline" className="flex h-60 shrink-0 flex-col border-t border-border bg-surface">
      <TimelineToolbar
        can={can}
        busy={busy}
        selectedLabel={selectedView?.label ?? null}
        onCommand={(command) => selectedClipId && runCommand(selectedClipId, command, false)}
        zoom={{
          canIn: zoom < ZOOM_STEPS.length - 1,
          canOut: zoom > 0,
          onIn: () => setZoom((z) => Math.min(ZOOM_STEPS.length - 1, z + 1)),
          onOut: () => setZoom((z) => Math.max(0, z - 1)),
        }}
      />
      <TimelineLanes
        lanes={lanes}
        fps={fps}
        selectedClipId={selectedClipId}
        busy={busy}
        pixelsPerSecond={ZOOM_STEPS[zoom]}
        playheadFrame={frame}
        epoch={epoch}
        emptyHint={empty ? "Add media from the library, or a title or captions from the Inspector." : null}
        onSeek={(f) => playhead.seek(f)}
        onSelect={select}
        canMove={canMove}
        canTrim={canTrim}
        onMoveEnd={(clipId, startSeconds) => {
          select(clipId);
          void commit(planMoveGesture(production, clipId, startSeconds)).then(settleGesture);
        }}
        onTrimEnd={(clipId, dir, startSeconds, endSeconds) => {
          select(clipId);
          void commit(planTrimGesture(production, clipId, dir, startSeconds, endSeconds, mediaDurationUs(clipId))).then(settleGesture);
        }}
        onClipKeyDown={onClipKeyDown}
      />
    </section>
  );
}
