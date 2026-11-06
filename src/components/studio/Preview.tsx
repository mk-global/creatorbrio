"use client";

/**
 * The Studio preview (#150): the current revision's compiled plan played
 * against the workspace playhead, with its transport. It reads the stored
 * production's preview on every render and keeps no timeline state; when the
 * revision cannot be compiled it says why, with a way to each clip at fault.
 *
 * `data-studio-preview` and `data-frame` (the frame shown) are measurement
 * hooks for the end-to-end test, as are each media element's
 * `data-studio-media`, `data-clip-id` and `data-drift-ms`.
 */
import { timelineEndFrame } from "@/lib/video/studio/frames";
import { PreviewIssues } from "./PreviewIssues";
import { PreviewStage } from "./PreviewStage";
import { PreviewTransport } from "./PreviewTransport";
import { useWorkspace } from "./workspace";

export function Preview() {
  const { state, playhead, playheadState, media, select } = useWorkspace();
  const { preview } = state.preview;
  const production = state.view.production;
  const fps = preview.ok ? preview.plan.canvas.fps : production.format.fps;
  const durationFrames = preview.ok ? preview.plan.durationFrames : timelineEndFrame(production);

  return (
    <section aria-label="Preview" data-studio-preview="" data-frame={playheadState.frame} className="flex min-h-0 min-w-0 flex-col bg-muted">
      <div className="relative min-h-0 flex-1">
        {preview.ok ? (
          <PreviewStage plan={preview.plan} overlay={preview.overlay} playhead={playhead} playheadState={playheadState} media={media} />
        ) : (
          <PreviewIssues issues={preview.issues} onSelectClip={select} />
        )}
      </div>
      <PreviewTransport playhead={playhead} state={playheadState} fps={fps} durationFrames={durationFrames} canPlay={preview.ok} />
    </section>
  );
}
