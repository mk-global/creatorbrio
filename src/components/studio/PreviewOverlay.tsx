"use client";

/**
 * The graphics overlay over the preview picture (#150): the preview overlay
 * document from the preview route, shown at one frame through
 * `previewOverlayAt()` in an `<iframe sandbox="">` the size of the canvas,
 * scaled with a CSS transform. It has no markup of its own.
 *
 * A sandboxed frame can only be re-seeked by loading a new `srcdoc`, so two
 * frames take turns: the next frame loads into the hidden one, and the two
 * swap when it has loaded, so the picture never shows a frame mid-load.
 * While playing it is re-seeked at a fixed cadence; on pause, seek or a new
 * revision, at exactly the frame shown. Outside the overlay's active ranges
 * it is hidden, holding the first frame of the next range.
 */
import { useCallback, useEffect, useRef } from "react";

import { previewOverlayAt } from "@/lib/video/render/overlay-time";
import type { Playhead } from "@/lib/video/studio/playhead";
import { OVERLAY_RESEEK_MS, overlayFrameToLoad, overlayVisible, type FrameRange } from "@/lib/video/studio/preview-overlay";

interface Props {
  overlay: { html: string; activeRanges: FrameRange[] };
  fps: number;
  canvas: { width: number; height: number };
  scale: number;
  playhead: Playhead;
  frame: number;
  playing: boolean;
}

interface Buffers {
  /** The frame each iframe holds (or is loading), for the current document. */
  frames: [number | null, number | null];
  front: 0 | 1;
  /** The back iframe is loading this frame. */
  loading: number | null;
  /** A frame asked for while the back iframe was still loading. */
  wanted: number | null;
  html: string;
}

export function PreviewOverlay({ overlay, fps, canvas, scale, playhead, frame, playing }: Props) {
  const frames = useRef<[HTMLIFrameElement | null, HTMLIFrameElement | null]>([null, null]);
  const buffers = useRef<Buffers>({ frames: [null, null], front: 0, loading: null, wanted: null, html: "" });

  const load = useCallback(
    (target: number | null) => {
      const b = buffers.current;
      if (b.html !== overlay.html) {
        // A new revision's document: nothing either iframe holds is current.
        b.html = overlay.html;
        b.frames = [null, null];
        b.loading = null;
      }
      if (target === null || b.frames[b.front] === target) return;
      if (b.loading !== null) {
        b.wanted = target;
        return;
      }
      const back = b.front === 0 ? 1 : 0;
      const iframe = frames.current[back];
      if (!iframe) return;
      let srcdoc: string;
      try {
        srcdoc = previewOverlayAt(overlay, target, fps);
      } catch {
        // Not a preview document: the route broke its contract, so show no graphics rather than wrong ones.
        return;
      }
      b.loading = target;
      b.frames[back] = target;
      iframe.srcdoc = srcdoc;
    },
    [overlay, fps]
  );

  const onLoad = useCallback(
    (index: 0 | 1) => {
      const b = buffers.current;
      const front = b.front === 0 ? 1 : 0;
      if (b.loading === null || index !== front) return;
      b.loading = null;
      b.front = index;
      frames.current[index]?.style.setProperty("visibility", "visible");
      frames.current[index === 0 ? 1 : 0]?.style.setProperty("visibility", "hidden");
      const wanted = b.wanted;
      b.wanted = null;
      if (wanted !== null) load(wanted);
    },
    [load]
  );

  // Paused, or a new document: exactly the frame shown.
  useEffect(() => {
    if (!playing) load(overlayFrameToLoad(overlay.activeRanges, frame));
  }, [playing, frame, overlay, load]);

  // Playing: re-seeked at a fixed cadence from the playhead's own clock.
  useEffect(() => {
    if (!playing) return;
    const tick = () => load(overlayFrameToLoad(overlay.activeRanges, playhead.currentFrame()));
    tick();
    const timer = setInterval(tick, OVERLAY_RESEEK_MS);
    return () => clearInterval(timer);
  }, [playing, overlay, playhead, load]);

  const shown = overlayVisible(overlay.activeRanges, frame);
  const style = { width: canvas.width, height: canvas.height, transform: `scale(${scale})` } as const;
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 1000, visibility: shown ? "visible" : "hidden" }} data-studio-overlay="">
      {([0, 1] as const).map((i) => (
        <iframe
          key={i}
          ref={(node) => {
            frames.current[i] = node;
          }}
          sandbox=""
          title="Captions and graphics"
          aria-hidden
          tabIndex={-1}
          width={canvas.width}
          height={canvas.height}
          onLoad={() => onLoad(i)}
          style={{ ...style, visibility: "hidden" }}
          className="absolute left-0 top-0 block origin-top-left border-0 bg-transparent"
        />
      ))}
    </div>
  );
}
