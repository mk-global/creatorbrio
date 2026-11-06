"use client";

/**
 * The lanes of the Studio timeline (#150): `@xzdarcy/react-timeline-editor`
 * as the interaction layer only (G7), with lane labels beside it.
 *
 * The widget is handed rows derived from the stored production and is never
 * the source of truth. What CreatorBrio adds to it:
 *   - each clip's free space as the widget's own bounds (`minStart`/`maxEnd`),
 *     so a drag stops flush against a neighbour instead of overlapping it, and
 *     a guard on every step (`canMove`/`canTrim`) for trims that reach the end
 *     of a clip's source or its last frame;
 *   - snapping only to the same lane's clip edges and the playhead;
 *   - one callback at the end of each gesture, which the timeline turns into
 *     one change set;
 *   - a focusable control per clip (`TimelineClip`).
 * The widget moves its element itself during a drag and mutates the row it
 * was given at the end; when the store does not take the result (refused, or
 * nothing to send) the parent bumps `epoch`, which remounts the widget on the
 * stored rows, so the clip is always drawn where the store says.
 */
import { Timeline as TimelineEditor, type TimelineEditor as TimelineEditorProps, type TimelineState } from "@xzdarcy/react-timeline-editor";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "@/lib/utils";
import { secondsToFrame } from "@/lib/video/studio/frames";
import { rulerLabel, rulerScale, type ClipTone, type LaneClipView, type LaneView } from "@/lib/video/studio/timeline-view";
import styles from "./Timeline.module.css";
import { TimelineClip } from "./TimelineClip";

type Row = TimelineEditorProps["editorData"][number];

/** Must match the heights in Timeline.module.css. */
export const RULER_HEIGHT = 28;
export const ROW_HEIGHT = 34;
const START_LEFT = 12;
const LABEL_WIDTH = 88;

const TONES: ClipTone[] = ["video", "image", "audio", "title", "captions", "graphic"];
const EFFECTS = Object.fromEntries(TONES.map((t) => [t, { id: t, name: t }]));

export interface TimelineLanesProps {
  lanes: LaneView[];
  fps: number;
  selectedClipId: string | null;
  busy: boolean;
  pixelsPerSecond: number;
  playheadFrame: number;
  /** Changes when the widget must be redrawn from the stored rows. */
  epoch: number;
  /** A hint over empty lanes, or null. */
  emptyHint: string | null;
  onSeek(frame: number): void;
  onSelect(clipId: string | null): void;
  canMove(clipId: string, startSeconds: number): boolean;
  canTrim(clipId: string, dir: "left" | "right", startSeconds: number, endSeconds: number): boolean;
  onMoveEnd(clipId: string, startSeconds: number): void;
  onTrimEnd(clipId: string, dir: "left" | "right", startSeconds: number, endSeconds: number): void;
  onClipKeyDown(clipId: string, event: KeyboardEvent<HTMLDivElement>): void;
}

export function TimelineLanes(props: TimelineLanesProps) {
  const { lanes, fps, selectedClipId, busy, pixelsPerSecond, playheadFrame, epoch, emptyHint } = props;
  const editor = useRef<TimelineState>(null);
  const labels = useRef<HTMLDivElement>(null);
  const scroll = useRef({ left: 0, top: 0 });
  const scrubbing = useRef<number | null>(null);
  const ruler = rulerScale(pixelsPerSecond);

  const views = useMemo(() => new Map<string, LaneClipView>(lanes.flatMap((l) => l.clips.map((c) => [c.clip.id, c] as const))), [lanes]);

  // Fresh rows from the store whenever it or the selection changes, never on a playhead tick, and for every
  // mount of the widget: `epoch` remounts it on rows it has not mutated after a gesture the store did not take.
  const mount = useMemo<{ epoch: number; rows: Row[] }>(
    () => ({
      epoch,
      rows: lanes.map((lane) => ({
        id: lane.track.id,
        actions: lane.clips.map((view, i) => {
          const prev = lane.clips[i - 1]?.clip;
          const next = lane.clips[i + 1]?.clip;
          return {
            id: view.clip.id,
            start: view.clip.start / fps,
            end: (view.clip.start + view.clip.duration) / fps,
            effectId: view.tone,
            selected: view.clip.id === selectedClipId,
            minStart: prev ? (prev.start + prev.duration) / fps : 0,
            ...(next ? { maxEnd: next.start / fps } : {}),
          };
        }),
      })),
    }),
    [lanes, fps, selectedClipId, epoch]
  );

  // The widget's cursor shows the master playhead; it never keeps a time of its own.
  useEffect(() => {
    editor.current?.setTime(playheadFrame / fps);
  }, [playheadFrame, fps, epoch]);

  // After a remount, return to where the person had scrolled.
  useEffect(() => {
    editor.current?.setScrollLeft(scroll.current.left);
    editor.current?.setScrollTop(scroll.current.top);
  }, [epoch]);

  /** Seeks to the ruler position under the pointer: a click or a drag along the ruler scrubs. */
  const seekAt = (event: PointerEvent<HTMLDivElement>, area: Element) => {
    const rect = area.getBoundingClientRect();
    const seconds = ((event.clientX - rect.left + scroll.current.left - START_LEFT) / ruler.scaleWidth) * ruler.scale;
    props.onSeek(secondsToFrame(seconds, fps));
  };

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="w-[88px] shrink-0 border-r border-border bg-surface" style={{ width: LABEL_WIDTH }}>
        <div className="border-b border-border bg-muted" style={{ height: RULER_HEIGHT }} />
        <div className="relative overflow-hidden" style={{ height: `calc(100% - ${RULER_HEIGHT}px)` }}>
          <div ref={labels}>
            {lanes.map((lane) => (
              <div key={lane.track.id} className="flex items-center border-b border-border px-3 text-xs font-medium text-muted-foreground" style={{ height: ROW_HEIGHT }}>
                <span className="truncate">{lane.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div
        className={cn("relative min-w-0 flex-1", styles.widget, busy && styles.busy)}
        aria-busy={busy}
        onPointerDown={(event) => {
          const area = (event.target as Element).closest(".timeline-editor-time-area");
          if (!area || event.button !== 0) return;
          scrubbing.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          seekAt(event, area);
        }}
        onPointerMove={(event) => {
          if (scrubbing.current !== event.pointerId) return;
          const area = event.currentTarget.querySelector(".timeline-editor-time-area");
          if (area) seekAt(event, area);
        }}
        onPointerUp={(event) => {
          if (scrubbing.current === event.pointerId) scrubbing.current = null;
        }}
        onPointerCancel={() => {
          scrubbing.current = null;
        }}
      >
        <TimelineEditor
          key={mount.epoch}
          ref={editor}
          editorData={mount.rows}
          effects={EFFECTS}
          scale={ruler.scale}
          scaleWidth={ruler.scaleWidth}
          scaleSplitCount={ruler.split}
          startLeft={START_LEFT}
          rowHeight={ROW_HEIGHT}
          autoScroll
          dragLine
          disableDrag={busy}
          getScaleRender={(seconds) => rulerLabel(seconds)}
          getAssistDragLineActionIds={({ action, row }) => row.actions.filter((a) => a.id !== action.id).map((a) => a.id)}
          onChange={() => false}
          onActionMoving={({ action, start }) => props.canMove(action.id, start)}
          onActionMoveEnd={({ action, start }) => props.onMoveEnd(action.id, start)}
          onActionResizing={({ action, start, end, dir }) => props.canTrim(action.id, dir, start, end)}
          onActionResizeEnd={({ action, start, end, dir }) => props.onTrimEnd(action.id, dir, start, end)}
          onClickActionOnly={(event, { action }) => {
            props.onSelect(action.id);
            (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-clip-id]")?.focus({ preventScroll: true });
          }}
          onClickRow={(event) => {
            if (!(event.target as Element).closest(".timeline-editor-action")) props.onSelect(null);
          }}
          onClickTimeArea={() => false}
          onCursorDrag={(seconds) => props.onSeek(secondsToFrame(seconds, fps))}
          onCursorDragEnd={(seconds) => props.onSeek(secondsToFrame(seconds, fps))}
          onScroll={({ scrollLeft, scrollTop }) => {
            scroll.current = { left: scrollLeft, top: scrollTop };
            if (labels.current) labels.current.style.transform = `translateY(${-scrollTop}px)`;
          }}
          getActionRender={(action) => {
            const view = views.get(action.id);
            return view ? <TimelineClip view={view} selected={action.id === selectedClipId} onKeyDown={props.onClipKeyDown} /> : null;
          }}
        />
        {emptyHint && (
          <p className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center text-xs text-muted-foreground" style={{ top: RULER_HEIGHT }}>
            {emptyHint}
          </p>
        )}
      </div>
    </div>
  );
}
