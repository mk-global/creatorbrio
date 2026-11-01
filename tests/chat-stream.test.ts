import { describe, expect, it } from "vitest";
import { createChatStreamParser, type ChatStreamEvent } from "@/lib/chat-stream";

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
