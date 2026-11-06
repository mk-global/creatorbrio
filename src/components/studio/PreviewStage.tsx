"use client";

/**
 * The preview canvas (#150): the compiled plan's canvas fitted into the panel
 * with letterboxing, black wherever no picture covers it, the picture layers
 * bottom to top, and the graphics overlay over them. Elements of clips not on
 * the playhead's frame are hidden and paused; the next clip's element is
 * already in the page, waiting at its first frame, so a cut does not stall.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { RenderPlan } from "@/lib/video/render/plan";
import type { Playhead, PlayheadState } from "@/lib/video/studio/playhead";
import { fitCanvas, type Size } from "@/lib/video/studio/preview-layout";
import { activeAt, mountedAt, previewElements } from "@/lib/video/studio/preview-plan";
import { mediaReadiness } from "@/lib/video/studio/preview-status";
import type { MediaView } from "@/lib/video/studio/types";
import { PreviewMedia } from "./PreviewMedia";
import { PreviewOverlay } from "./PreviewOverlay";
import { usePreviewSync } from "./PreviewSync";

interface Props {
  plan: RenderPlan;
  overlay: { html: string; activeRanges: { startFrame: number; endFrame: number }[] };
  playhead: Playhead;
  playheadState: PlayheadState;
  media: MediaView[];
}

/** Space kept around the canvas inside the panel, in CSS pixels. */
const GUTTER = 16;

function usePanelSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

export function PreviewStage({ plan, overlay, playhead, playheadState, media }: Props) {
  const { ref, size } = usePanelSize();
  const { canvas } = plan;
  const fit = fitCanvas({ width: Math.max(0, size.width - 2 * GUTTER), height: Math.max(0, size.height - 2 * GUTTER) }, canvas);
  const elements = useMemo(() => previewElements(plan), [plan]);
  const register = usePreviewSync(playhead, elements, canvas.fps);
  const frame = playheadState.frame;
  const mounted = mountedAt(elements, frame, canvas.fps);

  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden">
      {fit.scale > 0 && (
        <div
          className="absolute overflow-hidden bg-black shadow-sm ring-1 ring-border"
          style={{ left: GUTTER + fit.left, top: GUTTER + fit.top, width: fit.width, height: fit.height }}
          role="group"
          aria-label={`Preview canvas, ${canvas.width} by ${canvas.height}`}
        >
          {mounted.map((element) => (
            <PreviewMedia
              key={element.clipId}
              element={element}
              readiness={mediaReadiness(media, element.mediaId, element.file)}
              scale={fit.scale}
              visible={activeAt(element, frame)}
              register={register}
            />
          ))}
          <PreviewOverlay overlay={overlay} fps={canvas.fps} canvas={canvas} scale={fit.scale} playhead={playhead} frame={frame} playing={playheadState.playing} />
        </div>
      )}
    </div>
  );
}
