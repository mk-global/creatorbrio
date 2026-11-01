"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatMessage } from "./ChatMessage";
import { ChatInput } from "./ChatInput";
import { ReferenceImages } from "./ReferenceImages";
import { AlertCircle, Plug } from "lucide-react";
import type { ReferenceImage } from "@/types/carousel";
import {
  createChatStreamParser,
  INITIAL_CHAT_RUN,
  reduceChatRun,
  sessionAfterRun,
} from "@/lib/chat-stream";
import { readChatSession, writeChatSession } from "@/lib/chat-session";

/** Shown when the stream closes without the run reporting how it ended. */
const CONNECTION_LOST =
  "The connection to the design agent was lost before it finished. Send your message again to retry.";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  carouselId: string;
  referenceImages?: ReferenceImage[];
  claudeAvailable: boolean;
  onStreamStart?: () => void;
  onStreamEnd?: () => void;
  chatInputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function ChatPanel({
  carouselId,
  claudeAvailable,
  referenceImages = [],
  onStreamStart,
  onStreamEnd,
  chatInputRef,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load this carousel's session and chat history. Both are replaced, not
  // merged, so nothing from a previously shown carousel carries over.
  useEffect(() => {
    setSessionId(readChatSession(localStorage, carouselId));
    setError(null);
    let stored: Message[] = [];
    try {
      const storedMessages = localStorage.getItem(`chat-messages-${carouselId}`);
      if (storedMessages) stored = JSON.parse(storedMessages);
    } catch {
      // ignore corrupted data
    }
    setMessages(Array.isArray(stored) ? stored : []);
  }, [carouselId]);

  // Persist messages to localStorage
  const persistMessages = useCallback(
    (msgs: Message[]) => {
      try {
        localStorage.setItem(`chat-messages-${carouselId}`, JSON.stringify(msgs));
      } catch {
        // ignore quota errors
      }
    },
    [carouselId]
  );

  const handleClearChat = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setError(null);
    localStorage.removeItem(`chat-messages-${carouselId}`);
    writeChatSession(localStorage, carouselId, null);
  }, [carouselId]);

  const handleStopGenerating = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(
    async (message: string) => {
      if (isStreaming) return;
      setError(null);
      setIsStreaming(true);
      onStreamStart?.();

      // Add user message
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: message,
      };
      setMessages((prev) => [...prev, userMsg]);

      // Add empty assistant message for streaming
      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "" },
      ]);

      abortRef.current = new AbortController();

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            sessionId,
            carouselId,
          }),
          signal: abortRef.current.signal,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(
            (err as { error?: string }).error || "Failed to connect to AI"
          );
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response stream");

        const decoder = new TextDecoder();
        const parser = createChatStreamParser();
        let run = INITIAL_CHAT_RUN;
        const apply = (events: ReturnType<typeof parser.push>) => {
          const before = run.content;
          for (const event of events) run = reduceChatRun(run, event);
          if (run.content !== before) {
            const content = run.content;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content } : m))
            );
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          apply(parser.push(decoder.decode(value, { stream: true })));
        }
        apply(parser.end());

        // Resume the session the run reported next time, keep the one it was
        // sent with if it reported none, or drop one the CLI could not resume.
        const next = sessionAfterRun(run, sessionId);
        if (next !== sessionId) {
          setSessionId(next);
          writeChatSession(localStorage, carouselId, next);
        }

        const failure = run.error?.message ?? (run.finished ? null : CONNECTION_LOST);
        if (failure) {
          // Any reply text already streamed stays visible above the error.
          setError(failure);
          setMessages((prev) =>
            prev.filter((m) => m.id !== assistantId || m.content.length > 0)
          );
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "An unexpected error occurred";
        setError(message);
        // Remove empty assistant message on error
        setMessages((prev) =>
          prev.filter(
            (m) => m.id !== assistantId || m.content.length > 0
          )
        );
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        // Persist messages after stream completes
        setMessages((prev) => {
          persistMessages(prev);
          return prev;
        });
        onStreamEnd?.();
      }
    },
    [isStreaming, sessionId, carouselId, onStreamStart, onStreamEnd, persistMessages]
  );

  if (!claudeAvailable) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <Plug className="h-10 w-10 text-muted-foreground mb-3" />
        <h3 className="font-semibold text-sm mb-1">Connect Claude CLI</h3>
        <p className="text-xs text-muted-foreground max-w-[200px]">
          Install Claude CLI to enable AI-powered carousel creation.{" "}
          <a
            href="https://docs.anthropic.com/en/docs/claude-code"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline"
          >
            Install guide
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold">AI Assistant</h2>
          <p className="text-xs text-muted-foreground">
            Describe the carousel you want to create
          </p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClearChat}
            className="text-[10px] text-muted-foreground hover:text-destructive transition-colors px-1.5 py-0.5 rounded"
          >
            Clear
          </button>
        )}
      </div>

      <ReferenceImages
        carouselId={carouselId}
        images={referenceImages}
        onImagesChange={() => onStreamEnd?.()}
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 && (
          <div className="p-6 text-center text-muted-foreground">
            <p className="text-sm mb-1">No messages yet</p>
            <p className="text-xs">
              Tell me what carousel you&apos;d like to create
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            role={msg.role}
            content={msg.content}
            isStreaming={
              isStreaming &&
              msg.role === "assistant" &&
              msg.id === messages[messages.length - 1]?.id
            }
          />
        ))}
        {error && (
          <div className="mx-4 my-2 flex items-center gap-2 text-destructive text-xs bg-destructive/10 rounded-lg p-3">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
      </div>

      <ChatInput
        onSend={handleSend}
        isStreaming={isStreaming}
        textareaRef={chatInputRef}
        onStop={handleStopGenerating}
      />
    </div>
  );
}
