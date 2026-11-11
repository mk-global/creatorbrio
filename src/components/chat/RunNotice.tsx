"use client";

import { AlertCircle, AlertTriangle, ListChecks, Play, RotateCcw } from "lucide-react";
import { CHAT_STAGE_LABELS, type ChatStage } from "@/lib/chat-stream";
import { Notice, NoticeAction } from "@/components/ui/notice";

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
    <Notice
      tone="warning"
      icon={AlertTriangle}
      title="Stopped before designing"
      className="mt-2"
      action={
        notice.retryRunId && onRetry ? (
          <NoticeAction tone="warning" onClick={() => onRetry(notice.retryRunId!)} disabled={retryDisabled}>
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Retry
          </NoticeAction>
        ) : undefined
      }
    >
      {notice.message}
    </Notice>
  );
}

/**
 * An unfinished design (#127): how many of the planned slides are saved, and
 * a Continue that makes only the missing ones from the stored plan. Shown
 * until the design completes, the slides are accepted as they are, or a new
 * request replaces it.
 */
export function ContinueBar({
  saved,
  expected,
  onContinue,
  disabled,
}: {
  saved: number;
  expected: number;
  onContinue: () => void;
  disabled?: boolean;
}) {
  return (
    <Notice
      tone="warning"
      icon={AlertTriangle}
      title="Design unfinished"
      role="status"
      className="mx-4 my-2"
      action={
        <NoticeAction tone="warning" onClick={onContinue} disabled={disabled}>
          <Play className="h-3 w-3" aria-hidden="true" />
          Continue
        </NoticeAction>
      }
    >
      {Math.min(saved, expected)} of {expected} planned slides saved. Continue makes only the
      {saved >= expected ? " remaining changes" : " missing slides"}; saved slides are kept as they are.
    </Notice>
  );
}

/** A run that failed or could not start: the design agent's failures, timeouts, spending caps and refused messages. */
export function RunError({ message }: { message: string }) {
  return (
    <Notice tone="error" icon={AlertCircle} role="alert" className="mx-4 my-2">
      {message}
    </Notice>
  );
}
