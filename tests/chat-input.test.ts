import { describe, it, expect } from "vitest";
import { COUNTER_FROM, draftStatus } from "@/components/chat/ChatInput";
import { MAX_CHAT_MESSAGE_LENGTH } from "@/lib/chat-stream";

// The composer's decisions, which the browser check in #57 confirmed render as shown here.
describe("chat composer draft status (#57)", () => {
  it("sends a short draft trimmed, with no length line", () => {
    expect(draftStatus("  Make a carousel\n")).toEqual({ text: "Make a carousel", canSend: true, tooLong: false, notice: null });
  });

  it("does not send an empty or whitespace-only draft", () => {
    expect(draftStatus("")).toMatchObject({ canSend: false, tooLong: false, notice: null });
    expect(draftStatus(" \n\t ")).toMatchObject({ canSend: false, tooLong: false, notice: null });
  });

  it("shows the counter from 80% of the limit and still sends at the limit", () => {
    expect(draftStatus("x".repeat(COUNTER_FROM - 1)).notice).toBeNull();
    expect(draftStatus("x".repeat(COUNTER_FROM))).toMatchObject({ canSend: true, notice: "25,600 / 32,000 characters" });
    expect(draftStatus("x".repeat(MAX_CHAT_MESSAGE_LENGTH))).toMatchObject({ canSend: true, tooLong: false, notice: "32,000 / 32,000 characters" });
  });

  it("refuses a draft over the limit and says how much to cut", () => {
    expect(draftStatus("x".repeat(MAX_CHAT_MESSAGE_LENGTH + 1_119))).toMatchObject({
      canSend: false,
      tooLong: true,
      notice: "33,119 / 32,000 characters. Shorten it by 1,119 to send it.",
    });
  });

  it("measures the trimmed draft, as the server does, and counts emoji as the server does", () => {
    // Surrounding whitespace never counts against the limit.
    expect(draftStatus(`  ${"x".repeat(MAX_CHAT_MESSAGE_LENGTH)}  `).canSend).toBe(true);
    // Each emoji is two UTF-16 code units, here and in the route.
    expect(draftStatus("x".repeat(MAX_CHAT_MESSAGE_LENGTH - 1) + "\u{1F680}").tooLong).toBe(true);
  });
});
