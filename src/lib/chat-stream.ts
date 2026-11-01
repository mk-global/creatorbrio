/**
 * The chat stream contract between `POST /api/chat` and the chat panel.
 *
 * Every frame is a standard server-sent event whose `data:` payload is one
 * JSON object with a `type`. The route writes frames only through
 * `encodeChatEvent`, and the panel reads them only through
 * `createChatStreamParser`, so the two cannot drift apart. A client ignores
 * types it does not know, which lets later work add events (for example,
 * stage progress) without breaking older clients.
 */

export type ChatErrorCode =
  | "start_failed"
  | "agent_failed"
  | "timed_out"
  | "budget_exceeded"
  | "session_not_found";

export type ChatStreamEvent =
  /** A piece of the agent's reply text, appended as it arrives. */
  | { type: "token"; text: string }
  /** The agent's complete final reply, replacing the streamed tokens. */
  | { type: "result"; text: string }
  /** A failure after streaming started: a stable code and user-facing text. */
  | { type: "error"; code: ChatErrorCode; message: string }
  /** The run ended; `sessionId` is the Claude session to resume next, if any. */
  | { type: "done"; sessionId: string | null };

/**
 * What the user is told for each failure. Diagnostics (stderr, paths, exit
 * codes) stay in the server log and never reach the stream.
 */
export const CHAT_ERROR_MESSAGES: Record<ChatErrorCode, string> = {
  start_failed:
    "The design agent could not be started. Check that Claude Code is installed and working, then try again.",
  agent_failed:
    "The design agent stopped unexpectedly before finishing. Send your message again to retry.",
  timed_out:
    "The design agent ran out of time and was stopped. Slides it already saved are kept; ask it to continue.",
  budget_exceeded:
    "The design agent reached its spending limit for this message and stopped. Slides it already saved are kept; ask it to continue.",
  session_not_found:
    "The previous conversation could not be resumed, so it has been reset. Send your message again to start a new conversation.",
};

const ERROR_CODES = new Set<string>(Object.keys(CHAT_ERROR_MESSAGES));

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude session IDs are UUIDs; nothing else is stored, sent or resumed. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** Serializes one event as a complete server-sent event frame. */
export function encodeChatEvent(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Validates a decoded payload against the contract; anything else is dropped. */
function toEvent(payload: unknown): ChatStreamEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  switch (p.type) {
    case "token":
    case "result":
      return typeof p.text === "string" ? { type: p.type, text: p.text } : null;
    case "error":
      return typeof p.code === "string" && ERROR_CODES.has(p.code) && typeof p.message === "string" && p.message
        ? { type: "error", code: p.code as ChatErrorCode, message: p.message }
        : null;
    case "done":
      return { type: "done", sessionId: isSessionId(p.sessionId) ? p.sessionId : null };
    default:
      return null;
  }
}

export interface ChatStreamParser {
  /** Feeds decoded text, in chunks of any size, and returns the events it completes. */
  push(chunk: string): ChatStreamEvent[];
  /** Ends the stream. A frame left without its closing blank line is discarded. */
  end(): ChatStreamEvent[];
}

/**
 * An incremental server-sent events parser for the chat stream. It accepts
 * LF, CRLF and CR line endings, frames split anywhere across chunks and
 * several frames in one chunk; comments, unknown types and malformed
 * payloads are skipped without affecting the frames around them.
 */
export function createChatStreamParser(): ChatStreamParser {
  let buffer = "";
  let dataLines: string[] = [];

  const dispatch = (events: ChatStreamEvent[]) => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    try {
      const event = toEvent(JSON.parse(data));
      if (event) events.push(event);
    } catch {
      // A malformed payload is skipped; the next frame is unaffected.
    }
  };

  const processLine = (line: string, events: ChatStreamEvent[]) => {
    if (line === "") return dispatch(events);
    if (line.startsWith(":")) return; // comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    // The payload's own `type` is authoritative, so the `event:` field is not needed.
    if (field === "data") dataLines.push(value);
  };

  return {
    push(chunk) {
      const events: ChatStreamEvent[] = [];
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c !== "\n" && c !== "\r") continue;
        // A trailing CR may be the first half of a CRLF split across chunks.
        if (c === "\r" && i + 1 === buffer.length) break;
        processLine(buffer.slice(start, i), events);
        if (c === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return events;
    },
    end() {
      const events: ChatStreamEvent[] = [];
      if (buffer.endsWith("\r")) processLine(buffer.slice(0, -1), events);
      buffer = "";
      dataLines = [];
      return events;
    },
  };
}

/** What one chat run has produced so far, as the chat panel shows it. */
export interface ChatRunState {
  content: string;
  error: { code: ChatErrorCode; message: string } | null;
  /** The session the run reported in its `done` frame, if any. */
  sessionId: string | null;
  finished: boolean;
}

export const INITIAL_CHAT_RUN: ChatRunState = {
  content: "",
  error: null,
  sessionId: null,
  finished: false,
};

export function reduceChatRun(state: ChatRunState, event: ChatStreamEvent): ChatRunState {
  switch (event.type) {
    case "token":
      return { ...state, content: state.content + event.text };
    case "result":
      return event.text ? { ...state, content: event.text } : state;
    case "error":
      // The first failure is the cause; later ones are its consequences.
      return state.error ? state : { ...state, error: { code: event.code, message: event.message } };
    case "done":
      return { ...state, sessionId: event.sessionId, finished: true };
  }
}

/**
 * The session the carousel's next message should resume, given the one the
 * run was sent with. A session the CLI could not resume is dropped, so the
 * next message starts a new conversation instead of failing again; a run
 * that never reported a session (stopped, or failed to start) keeps the one
 * it was sent with.
 */
export function sessionAfterRun(state: ChatRunState, sentWith: string | null): string | null {
  if (state.error?.code === "session_not_found") return null;
  return state.sessionId ?? sentWith;
}
