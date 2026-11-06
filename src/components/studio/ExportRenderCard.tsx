"use client";

/**
 * One render in the Export panel (#150): its revision and state, the stage
 * and progress while it runs, why it failed, what the verifier found, Cancel
 * or Retry, and for a succeeded render its MP4 inline and its downloads.
 */
import { useState } from "react";
import { CircleCheck, CircleX, Download, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { renderFileUrl } from "@/lib/video/studio/api";
import { RENDER_DOWNLOADS, renderStatus, type RenderTone } from "@/lib/video/studio/render-status";
import type { RenderView } from "@/lib/video/studio/types";
import { cn } from "@/lib/utils";

const TONES: Record<RenderTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  progress: "bg-accent/10 text-accent",
  success: "bg-emerald-500/10 text-emerald-700",
  danger: "bg-destructive/10 text-destructive",
};

interface Props {
  render: RenderView;
  currentRevision: number;
  /** Whether this card shows its video at first: the newest succeeded render does. */
  showVideo: boolean;
  act(renderId: string, action: "cancel" | "retry"): Promise<string | null>;
}

export function ExportRenderCard({ render, currentRevision, showVideo, act }: Props) {
  const status = renderStatus(render, currentRevision);
  const [pending, setPending] = useState<"cancel" | "retry" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [videoOpen, setVideoOpen] = useState(showVideo);
  const requested = new Date(render.requestedAt);

  const run = async (action: "cancel" | "retry") => {
    setPending(action);
    setProblem(await act(render.renderId, action));
    setPending(null);
  };

  return (
    <li className="rounded-xl border border-border bg-surface p-3" aria-label={`Render of revision ${render.revision}, ${status.label}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium tabular-nums">Revision {render.revision}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", TONES[status.tone])}>{status.label}</span>
        {status.olderRevision && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">Older revision</span>}
        <time dateTime={render.requestedAt} className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground" title={requested.toLocaleString()}>
          {requested.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>

      {(status.stage || status.progress) && (
        <div className="mt-2">
          <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
            <span>{status.stage}</span>
            {status.progress && (
              <span className="tabular-nums">
                {status.progress.done} / {status.progress.total}
              </span>
            )}
          </div>
          {status.progress && (
            <div
              role="progressbar"
              aria-label={`${status.stage ?? "Progress"}, revision ${render.revision}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={status.progress.percent}
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className={cn("h-full rounded-full transition-[width] duration-500", status.tone === "danger" ? "bg-destructive" : status.tone === "progress" ? "bg-accent" : "bg-muted-foreground/40")} style={{ width: `${status.progress.percent}%` }} />
            </div>
          )}
        </div>
      )}

      {status.failure && <p className="mt-2 text-xs text-destructive">{status.failure}</p>}
      {status.verification && (
        <p className={cn("mt-2 flex items-center gap-1.5 text-xs", status.verification.ok ? "text-emerald-700" : "text-destructive")}>
          {status.verification.ok ? <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <CircleX className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          {status.verification.text}
        </p>
      )}

      {status.files.includes("video.mp4") && (
        <div className="mt-3">
          {videoOpen ? (
            <video controls preload="metadata" src={renderFileUrl(render.productionId, render.renderId, "video.mp4")} className="mx-auto block max-h-80 rounded-lg bg-black" aria-label={`Exported video, revision ${render.revision}`} />
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setVideoOpen(true)}>
              Play here
            </Button>
          )}
        </div>
      )}

      {status.files.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] text-muted-foreground">Download</span>
          {RENDER_DOWNLOADS.filter((d) => status.files.includes(d.name)).map((d) => (
            <a
              key={d.name}
              href={renderFileUrl(render.productionId, render.renderId, d.name)}
              download
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Download ${d.label}, revision ${render.revision}`}
            >
              <Download className="h-3 w-3" aria-hidden />
              {d.label}
            </a>
          ))}
        </div>
      )}

      {(status.canCancel || status.canRetry) && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {problem && <p className="mr-auto text-xs text-destructive">{problem}</p>}
          {status.canCancel && (
            <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => void run("cancel")}>
              <X className="h-3.5 w-3.5" aria-hidden />
              {pending === "cancel" ? "Cancelling" : "Cancel"}
            </Button>
          )}
          {status.canRetry && (
            <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => void run("retry")}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {pending === "retry" ? "Retrying" : "Retry"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
