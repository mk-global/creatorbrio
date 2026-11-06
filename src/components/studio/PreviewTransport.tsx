"use client";

/**
 * The preview's transport (#150): play and pause (Space through the
 * workspace), a frame back and forward, the start and the end, and the
 * timecode of the frame shown against the production's length. It only
 * drives the workspace playhead.
 */
import { Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatTimecode } from "@/lib/video/studio/frames";
import type { Playhead, PlayheadState } from "@/lib/video/studio/playhead";

interface Props {
  playhead: Playhead;
  state: PlayheadState;
  fps: number;
  durationFrames: number;
  /** False while the revision cannot be previewed: there is nothing to play. */
  canPlay: boolean;
}

export function PreviewTransport({ playhead, state, fps, durationFrames, canPlay }: Props) {
  const empty = durationFrames <= 0;
  const last = Math.max(0, durationFrames - 1);
  // Buttons stepping or jumping pause first, so the frame they land on is the one shown.
  const go = (frame: number) => {
    playhead.pause();
    playhead.seek(frame);
  };
  const button = "h-8 w-8 text-foreground disabled:opacity-40";
  return (
    <div role="toolbar" aria-label="Playback" className="flex h-11 shrink-0 items-center justify-center gap-1 border-t border-border bg-surface px-3">
      <Button variant="ghost" size="icon" className={button} aria-label="Go to start" disabled={empty} onClick={() => go(0)}>
        <SkipBack className="h-4 w-4" aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label="Previous frame" disabled={empty || state.frame <= 0} onClick={() => go(playhead.currentFrame() - 1)}>
        <StepBack className="h-4 w-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={button}
        aria-label={state.playing ? "Pause" : "Play"}
        aria-keyshortcuts="Space"
        disabled={empty || !canPlay}
        onClick={() => playhead.toggle()}
      >
        {state.playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label="Next frame" disabled={empty || state.frame >= last} onClick={() => go(playhead.currentFrame() + 1)}>
        <StepForward className="h-4 w-4" aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" className={button} aria-label="Go to end" disabled={empty} onClick={() => go(last)}>
        <SkipForward className="h-4 w-4" aria-hidden />
      </Button>
      <p className="ml-3 min-w-[8.5rem] font-mono text-xs tabular-nums text-muted-foreground" aria-label="Timecode">
        <span className="text-foreground">{formatTimecode(state.frame, fps)}</span>
        <span aria-hidden> / </span>
        <span className="sr-only"> of </span>
        {formatTimecode(durationFrames, fps)}
      </p>
    </div>
  );
}
