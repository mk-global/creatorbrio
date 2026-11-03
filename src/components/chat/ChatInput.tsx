"use client";

import { useState, useRef } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { checkChatMessage, MAX_CHAT_MESSAGE_LENGTH } from "@/lib/chat-stream";
import { cn } from "@/lib/utils";

/** The counter appears once a draft is this close to the limit. */
export const COUNTER_FROM = Math.floor(MAX_CHAT_MESSAGE_LENGTH * 0.8);

const count = (n: number) => n.toLocaleString("en-US");

/**
 * What the composer does with a draft: the text it would send (trimmed,
 * measured exactly as the server measures it), whether it may be sent, and
 * the length line to show near or over the limit (null below it).
 */
export function draftStatus(draft: string): { text: string; canSend: boolean; tooLong: boolean; notice: string | null } {
  const text = draft.trim();
  const check = checkChatMessage(text);
  const tooLong = !check.ok && check.reason === "too_long";
  const notice =
    text.length < COUNTER_FROM
      ? null
      : `${count(text.length)} / ${count(MAX_CHAT_MESSAGE_LENGTH)} characters` +
        (tooLong ? `. Shorten it by ${count(text.length - MAX_CHAT_MESSAGE_LENGTH)} to send it.` : "");
  return { text, canSend: check.ok, tooLong, notice };
}

interface ChatInputProps {
  onSend: (message: string) => void;
  isStreaming: boolean;
  disabled?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onStop?: () => void;
}

const SUGGESTIONS = [
  "Create a 5-slide carousel about...",
  "Make the design more minimal",
  "Change the accent color to blue",
  "Add a call-to-action slide",
  "Make the headings bigger",
];

export function ChatInput({ onSend, isStreaming, disabled, textareaRef: externalRef, onStop }: ChatInputProps) {
  const [value, setValue] = useState("");
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef || internalRef;

  const draft = draftStatus(value);

  const handleSubmit = () => {
    // A draft over the limit stays in the box, so nothing the user wrote is lost.
    if (!draft.canSend || isStreaming) return;
    onSend(draft.text);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    }
  };

  return (
    <div className="border-t border-border p-3">
      {value.length === 0 && !isStreaming && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {SUGGESTIONS.slice(0, 3).map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => setValue(suggestion)}
              className="text-xs px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={
            isStreaming ? "AI is working..." : "Describe your carousel..."
          }
          disabled={isStreaming || disabled}
          rows={1}
          className="flex-1 resize-none bg-muted rounded-lg px-3 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          aria-label="Chat message input"
          aria-invalid={draft.tooLong || undefined}
          aria-describedby={draft.notice ? "chat-message-length" : undefined}
        />
        {isStreaming ? (
          <Button
            size="icon"
            variant="destructive"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={handleSubmit}
            disabled={!draft.canSend || disabled}
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
      {draft.notice && (
        <p
          id="chat-message-length"
          aria-live="polite"
          className={cn("mt-1.5 text-[11px] tabular-nums", draft.tooLong ? "text-destructive" : "text-muted-foreground")}
        >
          {draft.notice}
        </p>
      )}
    </div>
  );
}
