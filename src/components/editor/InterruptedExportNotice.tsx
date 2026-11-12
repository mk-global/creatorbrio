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

/**
 * What the notice says about the slides: how many of the planned ones exist
 * when the plan is known, so a carousel with every planned slide is never
 * said to be missing any (#187).
 */
export function interruptedNoticeText(slideCount: number, plannedSlides: number | null): string {
  if (plannedSlides !== null && plannedSlides > 0) {
    if (slideCount >= plannedSlides) {
      return plannedSlides === 1
        ? "The planned slide is saved, but the design agent stopped before it finished working on it. Select Continue in the chat to let it finish, or use the slide as it is."
        : `All ${plannedSlides} planned slides are saved, but the design agent stopped before it finished working on them. Select Continue in the chat to let it finish, or use the slides as they are.`;
    }
    if (slideCount === 0) {
      return plannedSlides === 1
        ? "The planned slide was not saved. Select Continue in the chat to make it."
        : `None of the ${plannedSlides} planned slides were saved. Select Continue in the chat to make them.`;
    }
    const missing = plannedSlides - slideCount;
    return `${slideCount} of ${plannedSlides} planned slides are saved. Select Continue in the chat to make only the ${missing} missing ${missing === 1 ? "slide" : "slides"}, or use the slides as they are.`;
  }
  if (slideCount === 0) return "No slides were saved. Select Continue in the chat to make them.";
  return `The ${slideCount === 1 ? "slide is" : `${slideCount} slides are`} saved, but the carousel may be incomplete. Select Continue in the chat to finish it, or use the slides as they are.`;
}

interface InterruptedExportNoticeProps {
  reason: InterruptionReason;
  slideCount: number;
  /** How many slides the unfinished design planned, when its Continue offer says; null when unknown. */
  plannedSlides?: number | null;
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
  plannedSlides = null,
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
          <p className="text-xs text-muted-foreground mt-1">{interruptedNoticeText(slideCount, plannedSlides)}</p>
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
