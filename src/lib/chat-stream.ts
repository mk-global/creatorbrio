/**
 * The chat stream contract between `POST /api/chat` and the chat panel.
 *
 * This first version is a faithful port of the parsing loop the chat panel
 * used to contain, kept only to prove the regression tests fail on it.
 */

export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "result"; text: string }
  | { type: "error"; code: string; message: string }
  | { type: "done"; sessionId: string | null };

export interface ChatStreamParser {
  /** Feeds raw decoded text and returns the events completed by it. */
  push(chunk: string): ChatStreamEvent[];
  /** Ends the stream and returns any event still held in the buffer. */
  end(): ChatStreamEvent[];
}

export function createChatStreamParser(): ChatStreamParser {
  let buffer = "";
  return {
    push(chunk) {
      const events: ChatStreamEvent[] = [];
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "token" && typeof data.text === "string") {
              events.push({ type: "token", text: data.text });
            } else if (data.type === "result" && typeof data.text === "string") {
              events.push({ type: "result", text: data.text });
            }
          } catch {
            // skip unparseable
          }
        } else if (line.startsWith("event: done")) {
          // Next line has the done data
        } else if (line.startsWith("data: ") && line.includes("sessionId")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.sessionId) events.push({ type: "done", sessionId: data.sessionId });
          } catch {
            // skip
          }
        }
      }
      return events;
    },
    end() {
      const events: ChatStreamEvent[] = [];
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.sessionId) events.push({ type: "done", sessionId: data.sessionId });
            } catch {
              // skip
            }
          }
        }
      }
      buffer = "";
      return events;
    },
  };
}
