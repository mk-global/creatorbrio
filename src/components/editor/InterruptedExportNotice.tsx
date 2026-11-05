"use client";

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InterruptionReason } from "@/lib/generation-status";

const HEADLINE: Record<InterruptionReason, string> = {
  stopped: "Generation was stopped before it finished",
  failed: "Generation failed before it finished",
  "timed-out": "Generation timed out before it finished",
  "server-stopped": "The server stopped while slides were being generated",
};

interface InterruptedExportNoticeProps {
  reason: InterruptionReason;
  slideCount: number;
  /** Confirms the slides as they are; export opens once it resolves. */
  onAccept: () => Promise<void>;
}

/**
 * Shown instead of the export choices when the last generation did not
 * finish, so a half-made carousel is never exported as though it were done.
 * The slides are kept either way; the user continues in the chat or confirms
 * them as they are.
 */
export function InterruptedExportNotice({
  reason,
  slideCount,
  onAccept,
}: InterruptedExportNoticeProps) {
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setAccepting(true);
    setError(null);
    try {
      await onAccept();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm the slides.");
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div role="dialog" aria-label="Generation did not finish" className="p-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground">{HEADLINE[reason]}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {slideCount === 0
              ? "No slides were saved."
              : `The ${slideCount} slide${slideCount === 1 ? " is" : "s are"} saved, but the carousel may be incomplete.`}{" "}
            Select Continue in the chat to make only the missing slides, or use the slides as they are.
          </p>
          {error && (
            <p role="alert" className="text-xs text-destructive mt-1 break-words">
              {error}
            </p>
          )}
          <Button
            onClick={accept}
            disabled={accepting || slideCount === 0}
            variant="accent"
            size="sm"
            className="mt-2"
          >
            {accepting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Use these slides
          </Button>
        </div>
      </div>
    </div>
  );
}
