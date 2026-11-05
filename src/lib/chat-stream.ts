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
  /** The operator's own `DESIGN_AGENT_MAX_BUDGET_USD` cap was reached. */
  | "budget_exceeded"
  /** Claude refused to continue for a usage, rate or spending limit outside CreatorBrio. */
  | "usage_limited"
  | "budget_setting_invalid"
  | "timeout_setting_invalid"
  | "session_not_found"
  | "run_failed";

export type ChatStreamEvent =
  /** A piece of the agent's reply text, appended as it arrives. */
  | { type: "token"; text: string }
  /** The agent's complete final reply, replacing the streamed tokens. */
  | { type: "result"; text: string }
  /** A failure after streaming started: a stable code and user-facing text. */
  | { type: "error"; code: ChatErrorCode; message: string }
  /** The run ended; `sessionId` is the Claude session to resume next, if any. */
  | { type: "done"; sessionId: string | null }
  /** The creative run entered a stage; `detail` is short progress text such as "2 of 5". */
  | { type: "stage"; stage: ChatStage; detail?: string }
  /**
   * The run stopped before design. Nothing was changed. `retryRunId` is set
   * when the user can retry this attempt from its stored plan.
   */
  | { type: "blocked"; code: BlockedCode; message: string; retryRunId: string | null }
  /** The design finished with differences from the visual plan. */
  | { type: "deviations"; items: string[] };

/** The stages a creative run shows in the chat panel, in order. */
export const CHAT_STAGES = ["reading-sources", "planning", "preparing-images", "designing"] as const;
export type ChatStage = (typeof CHAT_STAGES)[number];

export const CHAT_STAGE_LABELS: Record<ChatStage, string> = {
  "reading-sources": "Reading linked pages",
  planning: "Planning visuals",
  "preparing-images": "Preparing images",
  designing: "Creating the design",
};

/** Why a run stopped before design; the message carries the user-facing reason. */
export const BLOCKED_CODES = [
  "too_many_slides",
  "too_many_sources",
  "source_unavailable",
  "source_required",
  "plan_failed",
  "capability_unavailable",
  "image_failed",
  "image_stage_timed_out",
  "storage_failed",
  "retry_refused",
  "continue_refused",
] as const;
export type BlockedCode = (typeof BLOCKED_CODES)[number];
const BLOCKED_CODE_SET = new Set<string>(BLOCKED_CODES);
const STAGE_SET = new Set<string>(CHAT_STAGES);

/**
 * What the user is told for each failure. Diagnostics (stderr, paths, exit
 * codes) stay in the server log and never reach the stream.
 */
export const CHAT_ERROR_MESSAGES: Record<ChatErrorCode, string> = {
  start_failed:
    "The design agent could not be started. Check that Claude Code is installed and working, then try again.",
  agent_failed:
    "The design agent stopped unexpectedly before finishing. Slides it already saved are kept; select Continue to make only the missing ones, or send your message again.",
  timed_out:
    "The design agent reached its time limit and was stopped. Slides it already saved are kept; select Continue to make only the missing ones. To allow longer runs, raise DESIGN_AGENT_TIMEOUT_SECONDS in .env.local and restart CreatorBrio.",
  budget_exceeded:
    "The design agent reached the spending cap set by DESIGN_AGENT_MAX_BUDGET_USD and stopped. Slides it already saved are kept; raise or remove that cap in .env.local, restart CreatorBrio, then select Continue to make only the missing ones.",
  usage_limited:
    "Claude stopped the design agent because a usage limit on your Claude account was reached; this is not a CreatorBrio limit. Slides it already saved are kept; select Continue once your Claude usage is available again.",
  budget_setting_invalid:
    "The design agent's spending cap, DESIGN_AGENT_MAX_BUDGET_USD, is not a positive amount in US dollars, such as 2.50. Nothing was changed; correct or remove it in .env.local, restart CreatorBrio and send your message again.",
  timeout_setting_invalid:
    "The design agent's time limit, DESIGN_AGENT_TIMEOUT_SECONDS, is not a whole number of seconds from 60 to 3600. Nothing was changed; correct or remove it in .env.local, restart CreatorBrio and send your message again.",
  session_not_found:
    "The previous conversation could not be resumed, so it has been reset. Send your message again, or select Continue, to carry on in a new conversation.",
  run_failed: "Something went wrong before the design started. Nothing was changed; send your message again.",
};

const ERROR_CODES = new Set<string>(Object.keys(CHAT_ERROR_MESSAGES));

/**
 * The longest chat message, as a JavaScript string length (UTF-16 code
 * units). The route refuses anything longer and the panel's counter measures
 * the same way, so the two always agree.
 *
 * Why this number: the Design Agent receives the message, followed by the
 * visual plan, as one command-line argument, and Linux allows at most 128 KiB
 * in a single argument. A code unit is at most 3 bytes of UTF-8, so even a
 * message in a non-Latin script stays under 96,000 bytes and leaves room for
 * the plan. It also fits the longest brief a carousel can use: `MAX_SLIDES`
 * fully specified slides of about 1,500 characters each, plus overall
 * instructions.
 */
export const MAX_CHAT_MESSAGE_LENGTH = 32_000;

export type ChatMessageCheck =
  | { ok: true; message: string }
  | { ok: false; reason: "empty" | "too_long"; length: number; error: string };

const count = (n: number) => n.toLocaleString("en-US");
const characters = (n: number) => `${count(n)} ${n === 1 ? "character" : "characters"}`;

/** Why a message cannot be sent, in the words the user sees; never truncates it. */
export function checkChatMessage(message: unknown): ChatMessageCheck {
  if (typeof message !== "string" || !message.trim()) {
    return { ok: false, reason: "empty", length: 0, error: "The message is empty. Type what you want, then send it." };
  }
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return {
      ok: false,
      reason: "too_long",
      length: message.length,
      error:
        `This message is ${characters(message.length)} long, and the limit is ${count(MAX_CHAT_MESSAGE_LENGTH)}. ` +
        `Nothing was sent or changed. Shorten it by ${characters(message.length - MAX_CHAT_MESSAGE_LENGTH)} and send it again.`,
    };
  }
  return { ok: true, message };
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Creative run IDs are UUIDs too. */
const RUN_ID_PATTERN = SESSION_ID_PATTERN;

/** Whether a value can be a creative run ID; anything else is refused before any lookup. */
export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

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
    case "stage":
      if (typeof p.stage !== "string" || !STAGE_SET.has(p.stage)) return null;
      return typeof p.detail === "string" && p.detail
        ? { type: "stage", stage: p.stage as ChatStage, detail: p.detail }
        : { type: "stage", stage: p.stage as ChatStage };
    case "blocked":
      return typeof p.code === "string" && BLOCKED_CODE_SET.has(p.code) && typeof p.message === "string" && p.message
        ? {
            type: "blocked",
            code: p.code as BlockedCode,
            message: p.message,
            retryRunId: typeof p.retryRunId === "string" && RUN_ID_PATTERN.test(p.retryRunId) ? p.retryRunId : null,
          }
        : null;
    case "deviations":
      return Array.isArray(p.items) && p.items.every((i) => typeof i === "string")
        ? { type: "deviations", items: p.items as string[] }
        : null;
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
  /** The creative stage in progress, until the run finishes. */
  stage: { stage: ChatStage; detail?: string } | null;
  /** Why the run stopped before design, if it did. */
  blocked: { code: BlockedCode; message: string; retryRunId: string | null } | null;
  /** Differences between the finished design and the visual plan. */
  deviations: string[];
}

export const INITIAL_CHAT_RUN: ChatRunState = {
  content: "",
  error: null,
  sessionId: null,
  finished: false,
  stage: null,
  blocked: null,
  deviations: [],
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
      return { ...state, sessionId: event.sessionId, finished: true, stage: null };
    case "stage":
      return { ...state, stage: event.detail ? { stage: event.stage, detail: event.detail } : { stage: event.stage } };
    case "blocked":
      return state.blocked ? state : { ...state, blocked: { code: event.code, message: event.message, retryRunId: event.retryRunId } };
    case "deviations":
      return { ...state, deviations: [...state.deviations, ...event.items] };
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
