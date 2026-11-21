/**
 * The sessions a contained Design Agent run may resume (#237, #241): only
 * those the server bound to the same carousel, each in the conversation
 * folder it began in, most recent kept, forgotten with the carousel or when a
 * new conversation starts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindAgentSession, boundConversation, forgetAgentSessions, MAX_BOUND_SESSIONS } from "@/lib/agent-sessions";

const session = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const conversation = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
let dir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-sessions-"));
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
});

describe("design agent session bindings", () => {
  it("binds a session to one carousel and the conversation it began in", async () => {
    await bindAgentSession("carousel-a", session(1), conversation(1));
    expect(await boundConversation("carousel-a", session(1))).toBe(conversation(1));
    expect(await boundConversation("carousel-b", session(1))).toBeNull();
    expect(await boundConversation("carousel-a", session(2))).toBeNull();
  });

  it("keeps the most recent sessions, without duplicates, and forgets them with the carousel", async () => {
    for (let n = 0; n < MAX_BOUND_SESSIONS + 3; n++) await bindAgentSession("carousel-a", session(n), conversation(n));
    await bindAgentSession("carousel-a", session(5), conversation(5));
    expect(await boundConversation("carousel-a", session(0))).toBeNull();
    expect(await boundConversation("carousel-a", session(5))).toBe(conversation(5));
    expect(await boundConversation("carousel-a", session(MAX_BOUND_SESSIONS + 2))).toBe(conversation(MAX_BOUND_SESSIONS + 2));
    await forgetAgentSessions("carousel-a");
    expect(await boundConversation("carousel-a", session(5))).toBeNull();
  });

  it("refuses to bind anything that is not a session id, or a conversation that is not a server identifier", async () => {
    await expect(bindAgentSession("carousel-a", "../../elsewhere", conversation(1))).rejects.toThrow();
    await expect(bindAgentSession("carousel-a", session(1), "../elsewhere")).rejects.toThrow();
  });

  it("never resumes a binding written before conversation folders existed", async () => {
    await mkdir(path.join(dir, "data"), { recursive: true });
    await writeFile(path.join(dir, "data", "design-agent-sessions.json"), JSON.stringify({ version: 1, carousels: { "carousel-a": [session(1)] } }));
    expect(await boundConversation("carousel-a", session(1))).toBeNull();
    await bindAgentSession("carousel-a", session(2), conversation(2));
    expect(await boundConversation("carousel-a", session(1))).toBeNull();
    expect(await boundConversation("carousel-a", session(2))).toBe(conversation(2));
  });
});

describe("forgetting a carousel without bindings", () => {
  it("creates no bindings file, so the legacy profile leaves the data folder unchanged", async () => {
    await forgetAgentSessions("2f1c9a52-8d3e-4b7a-9f21-0e4d5c6b7a89");
    expect(existsSync(path.join(process.cwd(), "data", "design-agent-sessions.json"))).toBe(false);
  });
});
