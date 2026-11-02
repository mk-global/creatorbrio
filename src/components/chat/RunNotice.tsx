"use client";

import { AlertTriangle, ListChecks, RotateCcw } from "lucide-react";
import { CHAT_STAGE_LABELS, type ChatStage } from "@/lib/chat-stream";

/** How a creative run ended, kept with the chat history so a reload shows it. */
export type RunNoticeData =
  | { kind: "blocked"; message: string; retryRunId: string | null }
  | { kind: "deviations"; items: string[] };

/** The creative stage in progress, shown under the reply while a run works. */
export function StageLine({ stage, detail }: { stage: ChatStage; detail?: string }) {
  return (
    <div className="mt-1 text-xs text-muted-foreground" role="status" aria-live="polite">
      {CHAT_STAGE_LABELS[stage]}
      {detail ? ` (${detail})` : ""}…
    </div>
  );
}

export function RunNotice({
  notice,
  onRetry,
  retryDisabled,
}: {
  notice: RunNoticeData;
  onRetry?: (runId: string) => void;
  retryDisabled?: boolean;
}) {
  if (notice.kind === "deviations") {
    return (
      <div className="mt-2 rounded-lg border border-border bg-background p-3 text-xs">
        <div className="mb-1 flex items-center gap-1.5 font-medium">
          <ListChecks className="h-3.5 w-3.5 shrink-0" />
          Done, with differences from the visual plan
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
          {notice.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium">Stopped before designing</div>
          <p className="mt-0.5">{notice.message}</p>
        </div>
      </div>
      {notice.retryRunId && onRetry && (
        <button
          type="button"
          onClick={() => onRetry(notice.retryRunId!)}
          disabled={retryDisabled}
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-amber-600/40 px-2 py-1 font-medium hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" />
          Retry
        </button>
      )}
    </div>
  );
}
