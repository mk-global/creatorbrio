import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrandConfig } from "@/types/brand";
import {
  createChatStreamParser,
  INITIAL_CHAT_RUN,
  MAX_CHAT_MESSAGE_LENGTH,
  reduceChatRun,
  sessionAfterRun,
  type ChatStreamEvent,
} from "@/lib/chat-stream";
import { stubDirector, typographyPlanFor } from "./helpers/stub-director";
import { TEN_PAGE_BRIEF } from "./fixtures/ten-page-brief";

// These tests cover the Design Agent run; the Visual Director is stubbed with an image-free plan.
let director: ReturnType<typeof stubDirector>;

// Through the real chat route and a real subprocess. The Claude CLI is replaced
// by a script that records its arguments and plays one scripted run, so every
// stream below is recorded from the route itself, not written by hand.
let claudePath = "";
vi.mock("@/lib/claude-path", () => ({
  isClaudeAvailable: () => true,
  getClaudePath: () => claudePath,
}));

const { POST: chat } = await import("@/app/api/chat/route");
const { createCarousel } = await import("@/lib/carousels");
const { isGenerating } = await import("@/lib/generation-status");

const SESSION = "6c1f9a52-8d3e-4b7a-9f21-0e4d5c6b7a89";
const OTHER_SESSION = "0f8b7c2e-3d4a-4b5c-9d6e-7f8091a2b3c4";

const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = process.env.FAKE_CLAUDE_DIR;
writeFileSync(path.join(dir, "pid"), String(process.pid));
writeFileSync(path.join(dir, "argv.json"), JSON.stringify(process.argv.slice(2)));
const scenario = readFileSync(path.join(dir, "scenario"), "utf8");
const resumeAt = process.argv.indexOf("--resume");
const requested = resumeAt === -1 ? null : process.argv[resumeAt + 1];
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const init = () => out({ type: "system", subtype: "init", session_id: requested ?? "${SESSION}" });
const text = (t) => out({ type: "assistant", message: { type: "message", content: [{ type: "text", text: t }] } });
switch (scenario) {
  case "success":
    init();
    text("Designing your ");
    text("carousel.");
    out({ type: "result", subtype: "success", is_error: false, session_id: requested ?? "${SESSION}", result: "Designed 3 slides." });
    process.exit(0);
  case "crash":
    init();
    text("Starting your carousel. Designing slide 1");
    process.stderr.write("fatal: simulated crash reading " + dir + "/session.jsonl\\n");
    process.exit(2);
  case "budget":
    init();
    text("Designing slide 1");
    out({ type: "result", subtype: "error_max_budget_usd", is_error: true, session_id: "${SESSION}" });
    process.exit(1);
  case "resume-missing":
    // What the real CLI does when the session to resume does not exist.
    out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: requested });
    process.stderr.write("No conversation found with session ID: " + requested + "\\n");
    process.exit(1);
  case "hang":
    init();
    text("Designing slide 1");
    setInterval(() => {}, 1000);
    break;
}
`;

const BRAND: BrandConfig = {
  name: "Synthetic Test Brand",
  colors: { primary: "#111111", secondary: "#222222", accent: "#e94560", background: "#ffffff", surface: "#f4f4f4" },
  fonts: { heading: "Inter", body: "Inter" },
  customFonts: [],
  logoPath: null,
  styleKeywords: [],
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
};

let workdir: string;
let originalCwd: string;
let fakeDir: string;

beforeEach(async () => {
  director = stubDirector();
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-chat-stream-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  await writeFile(path.join(workdir, "data", "brand.json"), JSON.stringify(BRAND));
  fakeDir = path.join(workdir, "fake-claude");
  await mkdir(fakeDir);
  claudePath = path.join(fakeDir, "claude.mjs");
  await writeFile(claudePath, FAKE_CLAUDE);
  await chmod(claudePath, 0o755);
  process.env.FAKE_CLAUDE_DIR = fakeDir;
  process.chdir(workdir);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  director.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
  try {
    process.kill(Number(await readFile(path.join(fakeDir, "pid"), "utf8")), "SIGKILL");
  } catch {
    // Already exited, or never started.
  }
  process.chdir(originalCwd);
  delete process.env.FAKE_CLAUDE_DIR;
  await rm(workdir, { recursive: true, force: true });
});

async function play(scenario: string) {
  await writeFile(path.join(fakeDir, "scenario"), scenario);
}

function postChat(body: Record<string, unknown>) {
  return chat(
    new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost:3000" },
      body: JSON.stringify({ message: "Make a three-slide carousel", ...body }),
    }) as never
  );
}

/** The route's bytes, read through the chat panel's own parser. */
async function readEvents(res: Response): Promise<{ raw: string; events: ChatStreamEvent[] }> {
  const raw = await res.text();
  const parser = createChatStreamParser();
  return { raw, events: [...parser.push(raw), ...parser.end()] };
}

const argv = async (): Promise<string[]> =>
  JSON.parse(await readFile(path.join(fakeDir, "argv.json"), "utf8"));

/** Every run with a carousel plans first; the stub Director's plan has no images. */
const STAGES: ChatStreamEvent[] = [
  { type: "stage", stage: "planning" },
  { type: "stage", stage: "designing" },
];

/** Diagnostics that belong in the server log and never in the stream. */
function expectNoDiagnostics(raw: string) {
  expect(raw).not.toContain(workdir);
  expect(raw).not.toContain(fakeDir);
  expect(raw).not.toContain(claudePath);
  expect(raw).not.toMatch(/stderr|syscall|exitCode|"path"|simulated crash|No conversation found|ENOENT/);
}

describe("chat sessions through the route (#2)", () => {
  it("starts a new session, reports it in done, and the panel would resume it", async () => {
    await play("success");
    const carousel = await createCarousel("Session", "4:5");
    const { events } = await readEvents(await postChat({ carouselId: carousel.id, sessionId: null }));

    expect(await argv()).not.toContain("--resume");
    expect(events).toEqual([
      ...STAGES,
      { type: "token", text: "Designing your " },
      { type: "token", text: "carousel." },
      { type: "result", text: "Designed 3 slides." },
      // The fake agent saves no slides, so the three-slide plan is not met;
      // the difference is reported, not corrected.
      { type: "deviations", items: ["The plan called for 3 slides; the carousel has 0."] },
      { type: "done", sessionId: SESSION },
    ]);
    const run = events.reduce(reduceChatRun, INITIAL_CHAT_RUN);
    expect(run.error).toBeNull();
    expect(sessionAfterRun(run, null)).toBe(SESSION);
  });

  it("passes the stored session to the CLI with --resume and keeps it", async () => {
    await play("success");
    const carousel = await createCarousel("Session", "4:5");
    const { events } = await readEvents(await postChat({ carouselId: carousel.id, sessionId: OTHER_SESSION }));

    const args = await argv();
    expect(args[args.indexOf("--resume") + 1]).toBe(OTHER_SESSION);
    expect(events.at(-1)).toEqual({ type: "done", sessionId: OTHER_SESSION });
    expect(console.info).toHaveBeenCalledWith(
      "[chat] run finished",
      expect.objectContaining({ carouselId: carousel.id, resumedSessionId: OTHER_SESSION, sessionId: OTHER_SESSION })
    );
  });

  it.each([
    ["an option", "--dangerously-skip-permissions"],
    ["a path", "../../sessions/x"],
    ["a non-UUID string", "fake-session"],
    ["a number", 42],
    ["an object", { id: SESSION }],
  ])("refuses %s as a session with 400 and starts nothing", async (_label, sessionId) => {
    await play("success");
    const carousel = await createCarousel("Session", "4:5");
    const res = await postChat({ carouselId: carousel.id, sessionId });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid session" });
    expect(existsSync(path.join(fakeDir, "argv.json"))).toBe(false);
    expect(isGenerating(carousel.id)).toBe(false);
  });

  it("reports a session the CLI cannot resume, so the panel drops it", async () => {
    await play("resume-missing");
    const carousel = await createCarousel("Session", "4:5");
    const { raw, events } = await readEvents(await postChat({ carouselId: carousel.id, sessionId: OTHER_SESSION }));

    expect(events.map((e) => e.type)).toEqual(["stage", "stage", "error", "done"]);
    expect(events[2]).toMatchObject({ type: "error", code: "session_not_found" });
    // The CLI echoes the requested ID in its error result; it is not offered back.
    expect(events[3]).toEqual({ type: "done", sessionId: null });
    expect(sessionAfterRun(events.reduce(reduceChatRun, INITIAL_CHAT_RUN), OTHER_SESSION)).toBeNull();
    expectNoDiagnostics(raw);
  });
});

describe("chat errors after streaming starts (#3)", () => {
  it("reports a crash mid-reply as a typed error, keeping the reply text and the session", async () => {
    await play("crash");
    const carousel = await createCarousel("Errors", "4:5");
    const { raw, events } = await readEvents(await postChat({ carouselId: carousel.id }));

    expect(events.map((e) => e.type)).toEqual(["stage", "stage", "token", "error", "done"]);
    expect(events[3]).toEqual({
      type: "error",
      code: "agent_failed",
      message:
        "The design agent stopped unexpectedly before finishing. Slides it already saved are kept; select Continue to make only the missing ones, or send your message again.",
    });
    expectNoDiagnostics(raw);
    const run = events.reduce(reduceChatRun, INITIAL_CHAT_RUN);
    expect(run.content).toBe("Starting your carousel. Designing slide 1");
    expect(sessionAfterRun(run, null)).toBe(SESSION);
    // The diagnostics are still available to the operator.
    expect(console.error).toHaveBeenCalledWith(
      "[chat] Claude subprocess exited non-zero",
      expect.objectContaining({ exitCode: 2, errorCode: "agent_failed", stderr: expect.stringContaining("simulated crash") })
    );
  });

  it("reports an error result once, with its own code, and never as a reply", async () => {
    await play("budget");
    // Only an operator's own cap is reported as CreatorBrio's (#127).
    process.env.DESIGN_AGENT_MAX_BUDGET_USD = "2.5";
    try {
      const carousel = await createCarousel("Errors", "4:5");
      const { raw, events } = await readEvents(await postChat({ carouselId: carousel.id }));

      expect(events.map((e) => e.type)).toEqual(["stage", "stage", "token", "error", "done"]);
      expect(events[3]).toMatchObject({ type: "error", code: "budget_exceeded" });
      expectNoDiagnostics(raw);
    } finally {
      delete process.env.DESIGN_AGENT_MAX_BUDGET_USD;
    }
  });

  it("reports a timeout kill at the default 15-minute deadline, which exits without a code", async () => {
    await play("hang");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const carousel = await createCarousel("Errors", "4:5");
    const res = await postChat({ carouselId: carousel.id });
    const reader = res.body!.getReader();
    const parser = createChatStreamParser();
    const events: ChatStreamEvent[] = [];
    let raw = "";
    const decoder = new TextDecoder();
    while (!events.some((e) => e.type === "token")) {
      const { value } = await reader.read();
      const text = decoder.decode(value, { stream: true });
      raw += text;
      events.push(...parser.push(text));
    }

    // Still running at the old 8-minute limit and just before the deadline (#127).
    await vi.advanceTimersByTimeAsync(480_000);
    expect(isGenerating(carousel.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(900_000 - 480_000);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      raw += text;
      events.push(...parser.push(text));
    }

    expect(events.map((e) => e.type)).toEqual(["stage", "stage", "token", "error", "done"]);
    expect(events[3]).toMatchObject({ type: "error", code: "timed_out" });
    expectNoDiagnostics(raw);
  });

  it("reports a CLI that fails to start, without its path or error details", async () => {
    claudePath = path.join(fakeDir, "missing-claude");
    const carousel = await createCarousel("Errors", "4:5");
    const { raw, events } = await readEvents(await postChat({ carouselId: carousel.id }));

    expect(events).toEqual([
      ...STAGES,
      expect.objectContaining({ type: "error", code: "start_failed" }),
    ]);
    expectNoDiagnostics(raw);
    // Released before the stream closes, as on a normal exit.
    expect(isGenerating(carousel.id)).toBe(false);
  });

  it("reports a CLI that cannot even be spawned, without its path or error details", async () => {
    // A NUL byte makes spawn throw synchronously rather than emit an error.
    claudePath = path.join(fakeDir, "claude\0.mjs");
    const carousel = await createCarousel("Errors", "4:5");
    const { raw, events } = await readEvents(await postChat({ carouselId: carousel.id }));

    expect(events).toEqual([
      ...STAGES,
      expect.objectContaining({ type: "error", code: "start_failed" }),
    ]);
    expectNoDiagnostics(raw);
  });
});

/** A synthetic brief at exactly `length` UTF-16 units, never splitting a surrogate pair. */
function briefOfLength(block: string, length: number): string {
  let brief = "Create an 8 slides carousel from this brief.\n\n";
  while (brief.length + block.length <= length) brief += block;
  return brief + "x".repeat(length - brief.length);
}

const MARKDOWN_BLOCK = [
  "## Slide \u2014 \u201cThe hook\u201d",
  "- **Headline:** \u201cStop guessing\u201d \u2014 it\u2019s caf\u00e9-grade clarity \u2192 r\u00e9sum\u00e9 \u00a9 \u2122",
  "- Diagram labels: `Input` \u2192 `Plan` \u2192 `Design`; \u00bd \u2264 \u00be; \u65e5\u672c\u8a9e \u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u{1F680}\u{1F3A8}",
  "> Keep the brand \"primary\" colour; use /uploads/synthetic.png & <b>no</b> raw HTML.",
  "",
].join("\n");

describe("chat message limits (Invalid message incident)", () => {
  it.each([
    ["a Markdown brief with quotes, dashes, accents, emoji and other scripts", MARKDOWN_BLOCK],
    // Three bytes of UTF-8 per code unit: the worst case the limit is derived from.
    ["a brief entirely in a non-Latin script", "\u65e5\u672c\u8a9e\u306e\u6307\u793a\u3002"],
  ])("delivers %s at the full limit, intact, to the Director and the Design Agent", async (_label, block) => {
    await play("success");
    const carousel = await createCarousel("Long brief", "4:5");
    const message = briefOfLength(block, MAX_CHAT_MESSAGE_LENGTH);
    expect(message.length).toBe(MAX_CHAT_MESSAGE_LENGTH);

    const { events } = await readEvents(await postChat({ carouselId: carousel.id, message }));

    expect(events.at(-1)).toEqual({ type: "done", sessionId: SESSION });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(director.requests[0].message).toBe(message);
    const args = await argv();
    const task = args[args.indexOf("--") + 1];
    // The whole message, then the plan: nothing truncated or re-encoded.
    expect(task.startsWith(`${message}\n\n`)).toBe(true);
    // Linux allows 128 KiB in one argument; the task message must fit.
    expect(Buffer.byteLength(task, "utf8")).toBeLessThan(128 * 1024);
  });

  it("refuses a message one character over the limit with the lengths, and starts nothing", async () => {
    await play("success");
    const carousel = await createCarousel("Long brief", "4:5");
    const message = briefOfLength(MARKDOWN_BLOCK, MAX_CHAT_MESSAGE_LENGTH + 1);

    const res = await postChat({ carouselId: carousel.id, message });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "This message is 32,001 characters long, and the limit is 32,000. " +
        "Nothing was sent or changed. Shorten it by 1 character and send it again.",
    });
    expect(existsSync(path.join(fakeDir, "argv.json"))).toBe(false);
    expect(director.requests).toHaveLength(0);
    expect(isGenerating(carousel.id)).toBe(false);
    // Traceable in the server log, without the content.
    expect(console.info).toHaveBeenCalledWith("[chat] message refused", {
      carouselId: carousel.id,
      reason: "too_long",
      length: MAX_CHAT_MESSAGE_LENGTH + 1,
      limit: MAX_CHAT_MESSAGE_LENGTH,
    });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("Stop guessing");
  });

  it.each([["an empty string", ""], ["whitespace", "  \n\t "], ["a number", 42], ["nothing", undefined]])(
    "still refuses %s as the message, and starts nothing",
    async (_label, message) => {
      await play("success");
      const carousel = await createCarousel("Empty", "4:5");
      const res = await postChat({ carouselId: carousel.id, message });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "The message is empty. Type what you want, then send it." });
      expect(existsSync(path.join(fakeDir, "argv.json"))).toBe(false);
      expect(isGenerating(carousel.id)).toBe(false);
    }
  );
});

describe("a fully specified ten-page request reaches the Design Agent (#124)", () => {
  it("plans the ten pages as ten slides, with no images or sources, and hands the whole brief to the Design Agent", async () => {
    // The plan the founder's Director returned for this request: the user's ten pages, as stated.
    director.restore();
    director = stubDirector((request) => {
      const plan = typographyPlanFor(request);
      const slides = Array.from({ length: 10 }, (_, i) => ({
        index: i + 1,
        visualIntent: "The page's approved copy, set in type with a quiet diagram",
        treatment: "typography",
        assetRefs: [] as string[],
        styleReferenceIds: [] as string[],
      }));
      return {
        ...plan,
        execution: { ...plan.execution, requestType: "new", slideCount: 10, slideCountBasis: "user-explicit", slides, assets: [] },
      };
    });
    await play("success");
    const carousel = await createCarousel("Ten pages", "4:5");

    const { events } = await readEvents(await postChat({ carouselId: carousel.id, message: TEN_PAGE_BRIEF }));

    // On main this run was blocked as plan_failed before the Design Agent started.
    expect(events.filter((e) => e.type === "blocked" || e.type === "error")).toEqual([]);
    // Planning then designing: no image stage, so no image job ran.
    expect(events.filter((e) => e.type === "stage")).toEqual(STAGES);
    expect(events.at(-1)).toEqual({ type: "done", sessionId: SESSION });
    expect(director.requests).toHaveLength(1);
    expect(director.requests[0].sources).toEqual([]);
    const args = await argv();
    const task = args[args.indexOf("--") + 1];
    expect(task.startsWith(`${TEN_PAGE_BRIEF}\n\n`)).toBe(true);
    expect(task).toContain("Slides to produce: 10 ");
  });
});
