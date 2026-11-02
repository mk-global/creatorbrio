"use client";

import { cn } from "@/lib/utils";
import { Bot, User } from "lucide-react";
import type { ChatStage } from "@/lib/chat-stream";
import { RunNotice, StageLine, type RunNoticeData } from "./RunNotice";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  /** The creative stage in progress, while this reply is streaming. */
  stage?: { stage: ChatStage; detail?: string } | null;
  notice?: RunNoticeData;
  onRetry?: (runId: string) => void;
  retryDisabled?: boolean;
}

export function ChatMessage({ role, content, isStreaming, stage, notice, onRetry, retryDisabled }: ChatMessageProps) {
  return (
    <div
      className={cn(
        "oc-enter flex gap-3 px-4 py-3",
        role === "user" ? "bg-transparent" : "bg-muted/50"
      )}
    >
      <div
        className={cn(
          "h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-0.5",
          role === "user"
            ? "bg-foreground text-background"
            : "bg-accent text-accent-foreground"
        )}
      >
        {role === "user" ? (
          <User className="h-3.5 w-3.5" />
        ) : (
          <Bot className="h-3.5 w-3.5" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-muted-foreground mb-1">
          {role === "user" ? "You" : "CreatorBrio AI"}
        </div>
        <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {content}
          {isStreaming && (
            <span className="oc-caret inline-block w-1.5 h-4 bg-accent ml-0.5 align-text-bottom" />
          )}
        </div>
        {isStreaming && stage && <StageLine stage={stage.stage} detail={stage.detail} />}
        {notice && <RunNotice notice={notice} onRetry={onRetry} retryDisabled={retryDisabled} />}
      </div>
    </div>
  );
}
