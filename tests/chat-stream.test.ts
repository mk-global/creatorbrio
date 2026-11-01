import { describe, expect, it } from "vitest";
import {
  createChatStreamParser,
  encodeChatEvent,
  INITIAL_CHAT_RUN,
  reduceChatRun,
  sessionAfterRun,
  type ChatStreamEvent,
} from "@/lib/chat-stream";
import { readChatSession, writeChatSession, type KeyValueStorage } from "@/lib/chat-session";

const SESSION = "6c1f9a52-8d3e-4b7a-9f21-0e4d5c6b7a89";

/** A frame exactly as the chat route writes it. */
const frame = (event: Record<string, unknown> & { type: string }) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** A successful run as `POST /api/chat` streams it. */
const SUCCESS = [
  frame({ type: "token", text: "Designing your " }),
  frame({ type: "token", text: "carousel." }),
  frame({ type: "result", text: "Designed 3 slides." }),
  frame({ type: "done", sessionId: SESSION }),
];

/** A run that fails after streaming started. */
const FAILURE = [
  frame({ type: "token", text: "Starting your carousel. Designing slide 1" }),
  frame({
    type: "error",
    code: "agent_failed",
    message: "The design agent stopped unexpectedly before finishing. Send your message again to retry.",
  }),
  frame({ type: "done", sessionId: SESSION }),
];

function parseChunks(chunks: string[]): ChatStreamEvent[] {
  const parser = createChatStreamParser();
  return [...chunks.flatMap((c) => parser.push(c)), ...parser.end()];
}

/** Re-cuts a stream into chunks of the given size, splitting frames and JSON. */
function rechunk(stream: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < stream.length; i += size) out.push(stream.slice(i, i + size));
  return out;
}

const doneOf = (events: ChatStreamEvent[]) => events.filter((e) => e.type === "done");

describe("chat stream parser: session capture (#2)", () => {
  it("captures the session ID when the final frames arrive in one chunk", () => {
    const events = parseChunks([SUCCESS.slice(0, 2).join(""), SUCCESS.slice(2).join("")]);
    expect(doneOf(events)).toEqual([{ type: "done", sessionId: SESSION }]);
  });

  it("captures the session ID when every frame arrives in its own chunk", () => {
    expect(doneOf(parseChunks(SUCCESS))).toEqual([{ type: "done", sessionId: SESSION }]);
  });

  it("captures the session ID when frames are split mid-frame", () => {
    const stream = SUCCESS.join("");
    for (const size of [1, 3, 7, 16]) {
      expect(doneOf(parseChunks(rechunk(stream, size)))).toEqual([
        { type: "done", sessionId: SESSION },
      ]);
    }
  });

  it("captures the session ID with CRLF line endings", () => {
    const events = parseChunks([SUCCESS.join("").replace(/\n/g, "\r\n")]);
    expect(doneOf(events)).toEqual([{ type: "done", sessionId: SESSION }]);
  });

  it("delivers reply text in order, whatever the chunking", () => {
    const expected = [
      { type: "token", text: "Designing your " },
      { type: "token", text: "carousel." },
      { type: "result", text: "Designed 3 slides." },
      { type: "done", sessionId: SESSION },
    ];
    expect(parseChunks(SUCCESS)).toEqual(expected);
    expect(parseChunks(rechunk(SUCCESS.join(""), 5))).toEqual(expected);
  });
});

describe("chat stream parser: errors after streaming starts (#3)", () => {
  it("yields an error frame that arrives mid-stream, after reply text", () => {
    const events = parseChunks(rechunk(FAILURE.join(""), 9));
    expect(events.map((e) => e.type)).toEqual(["token", "error", "done"]);
    expect(events[1]).toEqual({
      type: "error",
      code: "agent_failed",
      message: "The design agent stopped unexpectedly before finishing. Send your message again to retry.",
    });
  });

  it("ignores an unknown event type and keeps parsing the stream", () => {
    const stream = [
      SUCCESS[0],
      frame({ type: "stage", name: "planning" }),
      "event: stage\ndata: not json at all\n\n",
      SUCCESS[1],
      SUCCESS[3],
    ];
    expect(parseChunks(stream).map((e) => e.type)).toEqual(["token", "token", "done"]);
  });

  it("skips malformed and incomplete payloads without throwing", () => {
    const stream = [
      "data: {\"type\":\"token\"\n\n",
      frame({ type: "token", text: 42 } as never),
      frame({ type: "error", code: "agent_failed" } as never),
      ": a comment line\n\n",
      SUCCESS[0],
      SUCCESS[3],
    ];
    expect(parseChunks(stream).map((e) => e.type)).toEqual(["token", "done"]);
  });

  it("returns what it has when the stream ends without a done frame", () => {
    const parser = createChatStreamParser();
    const events = [...parser.push(SUCCESS[0]), ...parser.push("event: done\ndata: {\"type\":\"do")];
    expect(events.map((e) => e.type)).toEqual(["token"]);
    expect(parser.end()).toEqual([]);
  });
});

describe("chat stream encoder", () => {
  it("writes the exact frames the parser reads back", () => {
    const events: ChatStreamEvent[] = [
      { type: "token", text: "line one\nline two" },
      { type: "error", code: "timed_out", message: "Stopped." },
      { type: "done", sessionId: null },
    ];
    const stream = events.map(encodeChatEvent).join("");
    expect(stream).toBe(events.map((e) => frame(e)).join(""));
    expect(parseChunks(rechunk(stream, 4))).toEqual(events);
  });

  it("refuses a done frame whose session is not a session ID", () => {
    const events = parseChunks([frame({ type: "done", sessionId: "--resume" })]);
    expect(events).toEqual([{ type: "done", sessionId: null }]);
  });
});

describe("what the chat panel does with a run", () => {
  const run = (events: ChatStreamEvent[]) => events.reduce(reduceChatRun, INITIAL_CHAT_RUN);

  it("shows streamed tokens, then the final result in their place", () => {
    const state = run(parseChunks(SUCCESS));
    expect(state).toEqual({ content: "Designed 3 slides.", error: null, sessionId: SESSION, finished: true });
  });

  it("keeps reply text already streamed when a failure follows, and keeps the first failure", () => {
    const state = run([
      ...parseChunks(FAILURE.slice(0, 2)),
      { type: "error", code: "timed_out", message: "later" },
    ]);
    expect(state.content).toBe("Starting your carousel. Designing slide 1");
    expect(state.error?.code).toBe("agent_failed");
  });

  it("resumes the reported session, or keeps the one it was sent with when none was reported", () => {
    expect(sessionAfterRun(run(parseChunks(SUCCESS)), null)).toBe(SESSION);
    // Stopped by the user before the run reported anything.
    expect(sessionAfterRun(run(parseChunks(SUCCESS.slice(0, 2))), SESSION)).toBe(SESSION);
    // Ended without a session to offer.
    expect(sessionAfterRun(run([{ type: "done", sessionId: null }]), SESSION)).toBe(SESSION);
  });

  it("drops a session the CLI could not resume, even if a stale ID comes back", () => {
    const state = run([
      { type: "error", code: "session_not_found", message: "reset" },
      { type: "done", sessionId: SESSION },
    ]);
    expect(sessionAfterRun(state, SESSION)).toBeNull();
  });
});

describe("per-carousel session memory", () => {
  function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
  }

  it("never gives one carousel another carousel's session", () => {
    const storage = memoryStorage();
    writeChatSession(storage, "carousel-a", SESSION);
    expect(readChatSession(storage, "carousel-a")).toBe(SESSION);
    expect(readChatSession(storage, "carousel-b")).toBeNull();
  });

  it("keeps the existing storage key, so stored sessions stay readable", () => {
    const storage = memoryStorage();
    storage.setItem("chat-session-carousel-a", SESSION);
    expect(readChatSession(storage, "carousel-a")).toBe(SESSION);
  });

  it("forgets the session when the chat is cleared", () => {
    const storage = memoryStorage();
    writeChatSession(storage, "carousel-a", SESSION);
    writeChatSession(storage, "carousel-a", null);
    expect(storage.data.size).toBe(0);
    expect(readChatSession(storage, "carousel-a")).toBeNull();
  });

  it("ignores a stored value that is not a session ID, and never stores one", () => {
    const storage = memoryStorage();
    storage.setItem("chat-session-carousel-a", "--dangerously-skip-permissions");
    expect(readChatSession(storage, "carousel-a")).toBeNull();
    writeChatSession(storage, "carousel-b", "not-a-session");
    expect(storage.data.has("chat-session-carousel-b")).toBe(false);
  });

  it("works without resuming when storage is unavailable", () => {
    const broken: KeyValueStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(readChatSession(broken, "carousel-a")).toBeNull();
    expect(() => writeChatSession(broken, "carousel-a", SESSION)).not.toThrow();
  });
});
