/**
 * The sessions a contained Design Agent run may resume (#237): only those the
 * server bound to the same carousel, most recent kept, forgotten with it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindAgentSession, forgetAgentSessions, isAgentSessionBound, MAX_BOUND_SESSIONS } from "@/lib/agent-sessions";

const session = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
  it("binds a session to one carousel only", async () => {
    await bindAgentSession("carousel-a", session(1));
    expect(await isAgentSessionBound("carousel-a", session(1))).toBe(true);
    expect(await isAgentSessionBound("carousel-b", session(1))).toBe(false);
    expect(await isAgentSessionBound("carousel-a", session(2))).toBe(false);
  });

  it("keeps the most recent sessions, without duplicates, and forgets them with the carousel", async () => {
    for (let n = 0; n < MAX_BOUND_SESSIONS + 3; n++) await bindAgentSession("carousel-a", session(n));
    await bindAgentSession("carousel-a", session(5));
    expect(await isAgentSessionBound("carousel-a", session(0))).toBe(false);
    expect(await isAgentSessionBound("carousel-a", session(5))).toBe(true);
    expect(await isAgentSessionBound("carousel-a", session(MAX_BOUND_SESSIONS + 2))).toBe(true);
    await forgetAgentSessions("carousel-a");
    expect(await isAgentSessionBound("carousel-a", session(5))).toBe(false);
  });

  it("refuses to bind anything that is not a session id", async () => {
    await expect(bindAgentSession("carousel-a", "../../elsewhere")).rejects.toThrow();
  });
});

describe("forgetting a carousel without bindings", () => {
  it("creates no bindings file, so the legacy profile leaves the data folder unchanged", async () => {
    await forgetAgentSessions("2f1c9a52-8d3e-4b7a-9f21-0e4d5c6b7a89");
    expect(existsSync(path.join(process.cwd(), "data", "design-agent-sessions.json"))).toBe(false);
  });
});
