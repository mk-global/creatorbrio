import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { BrandConfig } from "@/types/brand";
import { CHAT_ERROR_MESSAGES, createChatStreamParser, executionLimitMessage, type ChatStreamEvent } from "@/lib/chat-stream";
import {
  DEFAULT_DESIGN_AGENT_INACTIVITY_SECONDS,
  DEFAULT_DESIGN_AGENT_TIMEOUT_SECONDS,
  DESIGN_AGENT_BUDGET_ENV,
  DESIGN_AGENT_INACTIVITY_ENV,
  DESIGN_AGENT_TIMEOUT_ENV,
  designAgentArgs,
  designAgentSettings,
} from "@/lib/design-agent";
import { DIRECTOR_BUDGET_ENV, directorArgs, directorBudgetCap } from "@/lib/visual-director";
import {
  CONTINUATION_START,
  ORIGINAL_TASK_START,
  buildContinuationMessage,
} from "@/lib/creative-handoff";
import { stubDirector, typographyPlanFor } from "./helpers/stub-director";

/**
 * The Design Agent's limits and an unfinished design's continuation (#127),
 * through the real chat, generation and export routes, real storage and a
 * real subprocess. The Claude CLI is replaced by a script that records every
 * invocation's arguments, emits the events a scenario asks for, and, where a
 * scenario says so, waits while the test saves slides the way the agent's
 * curl calls would. The Visual Director is stubbed with an image-free plan,
 * and only the Chromium renderer is replaced.
 */
let director: ReturnType<typeof stubDirector>;
let claudePath = "";
vi.mock("@/lib/claude-path", () => ({
  isClaudeAvailable: () => true,
  getClaudePath: () => claudePath,
}));
vi.mock("@/lib/export-slides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/export-slides")>()),
  exportAllSlides: vi.fn(),
}));

const { POST: chat } = await import("@/app/api/chat/route");
const { POST: exportCarousel } = await import("@/app/api/carousels/[id]/export/route");
const { GET: generationStatus, DELETE: acceptSlides } = await import("@/app/api/carousels/[id]/generation/route");
const { addSlide, createCarousel, getCarousel } = await import("@/lib/carousels");
const { isGenerating } = await import("@/lib/generation-status");
const { continuationOffer } = await import("@/lib/assets");
const { exportAllSlides } = await import("@/lib/export-slides");
const exportAllSlidesMock = vi.mocked(exportAllSlides);

const SESSION = "6c1f9a52-8d3e-4b7a-9f21-0e4d5c6b7a89";
const OTHER_SESSION = "0f8b7c2e-3d4a-4b5c-9d6e-7f8091a2b3c4";

/**
 * The scenario is JSON: `before` events, then (with `wait`) a pause until the
 * test writes the `proceed` file, then `after` events and `exit`; `hang`
 * never exits, `ignoreSigterm` survives a plain kill. `resumeMissing` plays
 * the real CLI's answer to a session it cannot find. With `beats`, each
 * `beat-<n>` file the test writes makes the CLI print "beat <n>", in order:
 * output at exactly the moment a test chooses.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = process.env.FAKE_CLAUDE_DIR;
// The arguments are recorded before the pid announces the process, so a test
// that waits for the pid can always read this invocation's arguments.
appendFileSync(path.join(dir, "argv.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
writeFileSync(path.join(dir, "pid"), String(process.pid));
const s = JSON.parse(readFileSync(path.join(dir, "scenario.json"), "utf8"));
// Options are parsed like the real CLI's: anything before "--" that starts
// with "-" must be a known option, or the CLI refuses it before running.
const VALUED = new Set(["--output-format", "--append-system-prompt", "--allowedTools", "--max-budget-usd", "--name", "--resume"]);
const FLAGS = new Set(["-p", "--include-partial-messages", "--verbose"]);
const args = process.argv.slice(2);
for (let i = 0; i < args.length && args[i] !== "--"; i++) {
  if (VALUED.has(args[i])) i++;
  else if (args[i].startsWith("-") && !FLAGS.has(args[i])) {
    process.stderr.write("error: unknown option '" + args[i].slice(0, 40) + "'\\n");
    process.exit(1);
  }
}
if (s.ignoreSigterm) process.on("SIGTERM", () => {});
const resumeAt = process.argv.indexOf("--resume");
const requested = resumeAt === -1 ? null : process.argv[resumeAt + 1];
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (requested && s.resumeMissing) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: requested });
  process.stderr.write("No conversation found with session ID: " + requested + "\\n");
  process.exit(1);
}
const session = requested ?? "${SESSION}";
out({ type: "system", subtype: "init", session_id: session });
const fill = (e) => (e.type === "result" ? { session_id: session, ...e } : e);
for (const e of s.before ?? []) out(fill(e));
if (s.beats) {
  let beat = 1;
  setInterval(() => {
    while (existsSync(path.join(dir, "beat-" + beat))) {
      out({ type: "assistant", message: { type: "message", content: [{ type: "text", text: "beat " + beat + " " }] } });
      beat++;
    }
  }, 10);
}
const finish = () => {
  for (const e of s.after ?? []) out(fill(e));
  if (s.hang) setInterval(() => {}, 1000);
  else process.exit(s.exit ?? 0);
};
if (s.wait) {
  const timer = setInterval(() => {
    if (!existsSync(path.join(dir, "proceed"))) return;
    clearInterval(timer);
    finish();
  }, 10);
} else finish();
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

const text = (t: string) => ({ type: "assistant", message: { type: "message", content: [{ type: "text", text: t }] } });
const success = (costUsd: number) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Done.",
  total_cost_usd: costUsd,
  num_turns: 12,
  usage: { input_tokens: 40, output_tokens: 9000, cache_read_input_tokens: 400000, cache_creation_input_tokens: 30000 },
});
const BUDGET_RESULT = { type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 1.02 };

let workdir: string;
let originalCwd: string;
let fakeDir: string;

beforeEach(async () => {
  director = stubDirector();
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-design-limits-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  await writeFile(path.join(workdir, "data", "brand.json"), JSON.stringify(BRAND));
  fakeDir = path.join(workdir, "fake-claude");
  await mkdir(fakeDir);
  claudePath = path.join(fakeDir, "claude.mjs");
  await writeFile(claudePath, FAKE_CLAUDE);
  await chmod(claudePath, 0o755);
  process.env.FAKE_CLAUDE_DIR = fakeDir;
  delete process.env[DESIGN_AGENT_BUDGET_ENV];
  delete process.env[DESIGN_AGENT_TIMEOUT_ENV];
  delete process.env[DESIGN_AGENT_INACTIVITY_ENV];
  delete process.env[DIRECTOR_BUDGET_ENV];
  process.chdir(workdir);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  exportAllSlidesMock.mockReset();
  exportAllSlidesMock.mockImplementation(async (slides) =>
    Promise.all(
      slides.map(async (_, i) => ({
        name: `slide-${i + 1}.png`,
        buffer: await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 10, g: 90, b: 160 } } })
          .png()
          .toBuffer(),
      }))
    )
  );
});

afterEach(async () => {
  director.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await writeFile(path.join(fakeDir, "proceed"), "").catch(() => {});
  try {
    process.kill(Number(await readFile(path.join(fakeDir, "pid"), "utf8")), "SIGKILL");
  } catch {
    // Already exited, or never started.
  }
  process.chdir(originalCwd);
  delete process.env.FAKE_CLAUDE_DIR;
  delete process.env[DESIGN_AGENT_BUDGET_ENV];
  delete process.env[DESIGN_AGENT_TIMEOUT_ENV];
  delete process.env[DESIGN_AGENT_INACTIVITY_ENV];
  delete process.env[DIRECTOR_BUDGET_ENV];
  await rm(workdir, { recursive: true, force: true });
});

async function play(scenario: Record<string, unknown>) {
  await rm(path.join(fakeDir, "proceed"), { force: true });
  await rm(path.join(fakeDir, "pid"), { force: true });
  await writeFile(path.join(fakeDir, "scenario.json"), JSON.stringify(scenario));
}

async function proceed() {
  await writeFile(path.join(fakeDir, "proceed"), "");
}

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const started = () => waitFor(() => existsSync(path.join(fakeDir, "pid")));

/**
 * Waits on real time while the route's timers and clock are faked: it
 * polls with setImmediate and measures with performance.now, neither of
 * which the limit tests fake.
 */
async function settle(condition: () => boolean, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A chat stream read incrementally, so a test can act between its events. */
function streamOf(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const parser = createChatStreamParser();
  const events: ChatStreamEvent[] = [];
  return {
    events,
    /** Reads until `condition` holds; fails if the stream ends first. */
    async until(condition: (events: ChatStreamEvent[]) => boolean) {
      while (!condition(events)) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`The stream ended early: ${JSON.stringify(events.map((e) => e.type))}`);
        events.push(...parser.push(decoder.decode(value, { stream: true })));
      }
    },
    /** Reads to the end of the stream. */
    async drain() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(...parser.push(decoder.decode(value, { stream: true })));
      }
      events.push(...parser.end());
      return events;
    },
    /** The user's Stop: the client goes away. */
    cancel: () => reader.cancel(),
  };
}

const replied = (text: string) => (events: ChatStreamEvent[]) =>
  events.some((e) => e.type === "token" && e.text.includes(text));

/** Makes the agent print one line of output, and waits until the route has received it. */
async function beat(run: ReturnType<typeof streamOf>, n: number) {
  await writeFile(path.join(fakeDir, `beat-${n}`), "");
  await run.until(replied(`beat ${n} `));
}

/** The warnings logged when an execution limit stops the agent. */
const limitStops = () => vi.mocked(console.warn).mock.calls.filter((c) => c[0] === "[chat] design agent stopped by an execution limit");

function postChat(body: Record<string, unknown>) {
  return chat(
    new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost:3000" },
      body: JSON.stringify(body),
    }) as never
  );
}

async function readEvents(res: Response): Promise<ChatStreamEvent[]> {
  const parser = createChatStreamParser();
  return [...parser.push(await res.text()), ...parser.end()];
}

/** Every CLI invocation's arguments, in order. */
async function invocations(): Promise<string[][]> {
  if (!existsSync(path.join(fakeDir, "argv.jsonl"))) return [];
  return (await readFile(path.join(fakeDir, "argv.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}
const taskOf = (argv: string[]) => argv[argv.indexOf("--") + 1];

async function statusOf(id: string) {
  const res = await generationStatus(new Request(`http://localhost:3000/api/carousels/${id}/generation`), {
    params: Promise.resolve({ id }),
  });
  return (await res.json()) as {
    generating: boolean;
    interrupted: { reason: string } | null;
    continuation: { runId: string; saved: number; expected: number } | null;
  };
}

function requestExport(id: string) {
  return exportCarousel(new Request(`http://localhost:3000/api/carousels/${id}/export`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

/** A plan of exactly `count` slides, as the Director returns for a stated count. */
function planOf(count: number) {
  return (request: Parameters<typeof typographyPlanFor>[0]) => {
    const plan = typographyPlanFor(request);
    if (request.carousel.slides.length > 0) return plan;
    return {
      ...plan,
      execution: {
        ...plan.execution,
        slideCount: count,
        slideCountBasis: "user-explicit",
        slides: Array.from({ length: count }, (_, i) => ({
          index: i + 1,
          visualIntent: `Editorial page ${i + 1}`,
          treatment: "typography",
          assetRefs: [],
          styleReferenceIds: [],
        })),
      },
    };
  };
}

/** The agent's curl calls, one slide at a time. */
async function agentSaves(carouselId: string, from: number, to: number) {
  for (let n = from; n <= to; n++) {
    await addSlide(carouselId, `<div style="padding:80px"><h1>Editorial page ${n}</h1><p>Approved copy for page ${n}.</p></div>`, `Page ${n}`);
  }
}

const slidesOf = async (id: string) =>
  [...(await getCarousel(id))!.slides].sort((a, b) => a.order - b.order).map((s) => ({ id: s.id, html: s.html }));

function runLog(): Record<string, unknown> {
  const call = vi.mocked(console.info).mock.calls.filter((c) => c[0] === "[chat] run finished").at(-1);
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

describe("the Design Agent's spending cap (#127)", () => {
  it("passes no --max-budget-usd by default; main hardcoded 1.00", () => {
    const settings = designAgentSettings({});
    expect(settings).toEqual({
      ok: true,
      budgetUsd: null,
      timeoutMs: DEFAULT_DESIGN_AGENT_TIMEOUT_SECONDS * 1000,
      inactivityMs: DEFAULT_DESIGN_AGENT_INACTIVITY_SECONDS * 1000,
    });
    const args = designAgentArgs({ taskMessage: "t", systemPrompt: "s", resumeSessionId: null, budgetUsd: null });
    expect(args).not.toContain("--max-budget-usd");
    expect(args).not.toContain("1.00");
  });

  it("runs the real route with no cap when none is configured", async () => {
    await play({ before: [text("Designing")], after: [success(0.4)] });
    const carousel = await createCarousel("No cap", "4:5");
    await readEvents(await postChat({ message: "Make a carousel", carouselId: carousel.id }));
    const [argv] = await invocations();
    expect(argv).not.toContain("--max-budget-usd");
    expect(runLog()).toMatchObject({ budgetUsd: null, timeoutMs: 1_800_000, inactivityMs: 300_000 });
  });

  it.each([["2.5", "2.5"], [" 3 ", "3"], ["0.75", "0.75"]])("passes a configured cap %j exactly once", async (raw, passed) => {
    process.env[DESIGN_AGENT_BUDGET_ENV] = raw;
    await play({ after: [success(0.4)] });
    const carousel = await createCarousel("Cap", "4:5");
    await readEvents(await postChat({ message: "Make a carousel", carouselId: carousel.id }));
    const [argv] = await invocations();
    expect(argv.filter((a) => a === "--max-budget-usd")).toHaveLength(1);
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe(passed);
  });

  it.each(["abc", "0", "0.0", "-1", "Infinity", "NaN", "1e3", "2.5usd", "$2", "1,5", "."])(
    "refuses the cap %j before planning or starting the CLI, changing nothing",
    async (raw) => {
      process.env[DESIGN_AGENT_BUDGET_ENV] = raw;
      await play({ after: [success(0.4)] });
      const carousel = await createCarousel("Bad cap", "4:5");
      await addSlide(carousel.id, "<div>Kept</div>");
      const before = await slidesOf(carousel.id);
      const events = await readEvents(await postChat({ message: "Make a carousel", carouselId: carousel.id }));
      expect(events).toEqual([
        { type: "error", code: "budget_setting_invalid", message: CHAT_ERROR_MESSAGES.budget_setting_invalid },
        { type: "done", sessionId: null },
      ]);
      expect(await invocations()).toEqual([]);
      expect(director.requests).toHaveLength(0);
      expect(isGenerating(carousel.id)).toBe(false);
      expect(await slidesOf(carousel.id)).toEqual(before);
      expect((await statusOf(carousel.id)).interrupted).toBeNull();
    }
  );

  it("keeps the Visual Director's cap independent of the Design Agent's, both ways", async () => {
    // The Design Agent's setting never reaches the Director.
    process.env[DESIGN_AGENT_BUDGET_ENV] = "4";
    const director = directorBudgetCap(process.env[DIRECTOR_BUDGET_ENV]);
    expect(director).toEqual({ ok: true, usd: null });
    expect(directorArgs("/tmp/x", director.ok ? director.usd : null)).not.toContain("--max-budget-usd");
    // The Director's setting never reaches the Design Agent.
    delete process.env[DESIGN_AGENT_BUDGET_ENV];
    process.env[DIRECTOR_BUDGET_ENV] = "0.5";
    expect(designAgentSettings()).toMatchObject({ ok: true, budgetUsd: null });
    await play({ after: [success(0.4)] });
    const carousel = await createCarousel("Independent", "4:5");
    await readEvents(await postChat({ message: "Make a carousel", carouselId: carousel.id }));
    expect((await invocations())[0]).not.toContain("--max-budget-usd");
    // An invalid Director setting does not invalidate the Design Agent's either.
    process.env[DIRECTOR_BUDGET_ENV] = "nonsense";
    expect(designAgentSettings().ok).toBe(true);
  });
});

describe("the task reaches the CLI as the task, never as an option (#127)", () => {
  it("delivers a brief that starts with a Markdown list, which the CLI refused as an unknown option", async () => {
    await play({ after: [success(0.2)] });
    const carousel = await createCarousel("Dash", "4:5");
    const message = "- Slide 1: the hook\n- Slide 2: the proof";
    const events = await readEvents(await postChat({ message, carouselId: carousel.id }));
    expect(events.some((e) => e.type === "error")).toBe(false);
    const [argv] = await invocations();
    expect(argv.at(-2)).toBe("--");
    expect(taskOf(argv).startsWith(`${message}\n\n`)).toBe(true);
  });
});

describe("the Design Agent's execution deadline (#127)", () => {
  it.each([
    ["", 1_800_000],
    ["60", 60_000],
    ["1200", 1_200_000],
    ["3600", 3_600_000],
  ])("reads %j as %d ms", (raw, ms) => {
    expect(designAgentSettings({ [DESIGN_AGENT_TIMEOUT_ENV]: raw })).toMatchObject({ ok: true, timeoutMs: ms });
  });

  it.each(["59", "3601", "0", "-5", "90.5", "15m", "abc", "1e3"])("refuses %j before anything runs", async (raw) => {
    process.env[DESIGN_AGENT_TIMEOUT_ENV] = raw;
    await play({ after: [success(0.4)] });
    const carousel = await createCarousel("Bad timeout", "4:5");
    const events = await readEvents(await postChat({ message: "Make a carousel", carouselId: carousel.id }));
    expect(events[0]).toMatchObject({ type: "error", code: "timeout_setting_invalid" });
    expect(await invocations()).toEqual([]);
    expect(director.requests).toHaveLength(0);
  });

  it("stops a run at the configured deadline, keeps its saved slides, and offers Continue", async () => {
    process.env[DESIGN_AGENT_TIMEOUT_ENV] = "120";
    director.restore();
    director = stubDirector(planOf(8));
    await play({ before: [text("Designing")], hang: true });
    const carousel = await createCarousel("Deadline", "4:5");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const res = await postChat({ message: "Make 8 slides", carouselId: carousel.id });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const parser = createChatStreamParser();
    const events: ChatStreamEvent[] = [];
    while (!events.some((e) => e.type === "token")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("The stream ended before the agent replied");
      events.push(...parser.push(decoder.decode(value, { stream: true })));
    }
    await agentSaves(carousel.id, 1, 3);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(isGenerating(carousel.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(...parser.push(decoder.decode(value, { stream: true })));
    }
    vi.useRealTimers();
    expect(events.find((e) => e.type === "error")).toEqual({
      type: "error",
      code: "timed_out",
      message: executionLimitMessage("deadline", { limitMs: 120_000, saved: 3, expected: 8 }),
    });
    expect((await getCarousel(carousel.id))!.slides).toHaveLength(3);
    const status = await statusOf(carousel.id);
    expect(status.interrupted).toMatchObject({ reason: "timed-out" });
    expect(status.continuation).toMatchObject({ saved: 3, expected: 8 });
    // The default inactivity limit is not shorter than a 2-minute deadline, so only the deadline applies.
    expect(runLog()).toMatchObject({
      failureCategory: "timed_out",
      limit: "deadline",
      timeoutMs: 120_000,
      inactivityMs: null,
      slidesSaved: 3,
      slidesExpected: 8,
      continuationAvailable: true,
    });
  });

  it("kills a CLI that ignores the stop at the deadline, so the run always ends", async () => {
    process.env[DESIGN_AGENT_TIMEOUT_ENV] = "60";
    await play({ before: [text("Designing")], hang: true, ignoreSigterm: true });
    const carousel = await createCarousel("Stubborn", "4:5");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const res = await postChat({ message: "Make a carousel", carouselId: carousel.id });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (!raw.includes('"type":"token"')) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`The stream ended before the agent replied: ${raw}`);
      raw += decoder.decode(value, { stream: true });
    }
    const pid = Number(await readFile(path.join(fakeDir, "pid"), "utf8"));
    await vi.advanceTimersByTimeAsync(60_000);
    // Time for the stop to be delivered and ignored; setImmediate is not faked.
    for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(isGenerating(carousel.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    expect(raw).toContain('"code":"timed_out"');
    expect(() => process.kill(pid, 0)).toThrow();
    expect(isGenerating(carousel.id)).toBe(false);
  }, 15_000);
});

describe("the inactivity watchdog and the absolute deadline (#187)", () => {
  /** Fakes the route's timers and clock; real time is still measured by `settle`. */
  const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  it("defaults to a 30-minute deadline and a 5-minute inactivity limit", () => {
    expect(designAgentSettings({})).toEqual({ ok: true, budgetUsd: null, timeoutMs: 1_800_000, inactivityMs: 300_000 });
  });

  it.each([
    ["60", 60_000],
    ["300", 300_000],
    ["900", 900_000],
  ])("reads an inactivity limit of %j as %d ms", (raw, ms) => {
    expect(designAgentSettings({ [DESIGN_AGENT_INACTIVITY_ENV]: raw })).toMatchObject({ ok: true, inactivityMs: ms });
  });

  it("applies no inactivity limit when the deadline is not longer than the default one", () => {
    expect(designAgentSettings({ [DESIGN_AGENT_TIMEOUT_ENV]: "300" })).toMatchObject({ ok: true, timeoutMs: 300_000, inactivityMs: null });
    expect(designAgentSettings({ [DESIGN_AGENT_TIMEOUT_ENV]: "301" })).toMatchObject({ ok: true, inactivityMs: 300_000 });
  });

  it.each([
    [{ [DESIGN_AGENT_INACTIVITY_ENV]: "59" }],
    [{ [DESIGN_AGENT_INACTIVITY_ENV]: "901" }],
    [{ [DESIGN_AGENT_INACTIVITY_ENV]: "0" }],
    [{ [DESIGN_AGENT_INACTIVITY_ENV]: "-5" }],
    [{ [DESIGN_AGENT_INACTIVITY_ENV]: "90.5" }],
    [{ [DESIGN_AGENT_INACTIVITY_ENV]: "5m" }],
    [{ [DESIGN_AGENT_INACTIVITY_ENV]: "1e3" }],
    [{ [DESIGN_AGENT_INACTIVITY_ENV]: "300", [DESIGN_AGENT_TIMEOUT_ENV]: "300" }],
    [{ [DESIGN_AGENT_INACTIVITY_ENV]: "900", [DESIGN_AGENT_TIMEOUT_ENV]: "600" }],
  ])("refuses %j before planning or starting the CLI", async (env) => {
    Object.assign(process.env, env);
    await play({ after: [success(0.4)] });
    const carousel = await createCarousel("Bad inactivity limit", "4:5");
    const events = await readEvents(await postChat({ message: "Make a carousel", carouselId: carousel.id }));
    expect(events[0]).toEqual({ type: "error", code: "inactivity_setting_invalid", message: CHAT_ERROR_MESSAGES.inactivity_setting_invalid });
    expect(await invocations()).toEqual([]);
    expect(director.requests).toHaveLength(0);
    expect((await getCarousel(carousel.id))!.slides).toHaveLength(0);
  });

  it("lets a run that keeps producing output work past the old 15-minute deadline", async () => {
    director.restore();
    director = stubDirector(planOf(10));
    await play({ before: [text("Designing")], beats: true, wait: true, after: [success(4.1)] });
    const carousel = await createCarousel("Long and productive", "4:5");
    fakeTime();
    const run = streamOf(await postChat({ message: "Make a 10 slides LinkedIn document", carouselId: carousel.id }));
    await run.until(replied("Designing"));
    // Output every 4 minutes for 24 minutes, saving pages along the way. Main stopped this run at 15 minutes.
    for (let n = 1; n <= 6; n++) {
      await vi.advanceTimersByTimeAsync(240_000);
      if (n <= 5) await agentSaves(carousel.id, 2 * n - 1, 2 * n);
      await beat(run, n);
    }
    expect(isGenerating(carousel.id)).toBe(true);
    await proceed();
    const events = await run.drain();
    vi.useRealTimers();
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(await slidesOf(carousel.id)).toHaveLength(10);
    expect(await statusOf(carousel.id)).toEqual({ generating: false, interrupted: null, continuation: null });
    expect(runLog()).toMatchObject({ outcome: "completed", limit: null, timeoutMs: 1_800_000, inactivityMs: 300_000, slidesSaved: 10 });
    expect(limitStops()).toHaveLength(0);
  });

  it("stops a run that produces no output for 5 minutes as stalled, keeps its slides and offers Continue", async () => {
    director.restore();
    director = stubDirector(planOf(8));
    await play({ before: [text("Designing")], beats: true, hang: true });
    const carousel = await createCarousel("Stalled", "4:5");
    fakeTime();
    const start = Date.now();
    const run = streamOf(await postChat({ message: "Make 8 slides", carouselId: carousel.id }));
    await run.until(replied("Designing"));
    await agentSaves(carousel.id, 1, 3);
    // Output resets the watchdog; then the agent goes quiet.
    await vi.advanceTimersByTimeAsync(200_000);
    await beat(run, 1);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(isGenerating(carousel.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await run.drain();
    vi.useRealTimers();

    const errors = events.filter((e) => e.type === "error");
    const message = executionLimitMessage("inactivity", { limitMs: 300_000, saved: 3, expected: 8 });
    expect(errors).toEqual([{ type: "error", code: "stalled", message }]);
    expect(message).toContain("3 of 8 planned slides");
    expect(message).toContain("5 missing slides");
    expect((await getCarousel(carousel.id))!.slides).toHaveLength(3);
    const status = await statusOf(carousel.id);
    expect(status.interrupted).toMatchObject({ reason: "timed-out" });
    expect(status.continuation).toMatchObject({ saved: 3, expected: 8 });
    expect((await requestExport(carousel.id)).status).toBe(409);
    const log = runLog();
    expect(log).toMatchObject({
      outcome: "timed-out",
      errorCode: "stalled",
      failureCategory: "stalled",
      limit: "inactivity",
      timeoutMs: 1_800_000,
      inactivityMs: 300_000,
      quietMs: 300_000,
      longestQuietMs: 300_000,
      designStartedAt: new Date(start).toISOString(),
      lastOutputAt: new Date(start + 200_000).toISOString(),
      lastCarouselWriteAt: new Date(start).toISOString(),
      slidesSaved: 3,
      slidesExpected: 8,
      continuationAvailable: true,
    });
    expect(limitStops()).toHaveLength(1);
    expect(limitStops()[0][1]).toMatchObject({ limit: "inactivity", elapsedMs: 500_000, quietMs: 300_000 });
    // Counts, codes and times only.
    const logged = JSON.stringify([...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls]);
    expect(logged).not.toContain("Approved copy");
    expect(logged).not.toContain("Make 8 slides");
  });

  it("stops a run at the absolute deadline however much output it produces", async () => {
    process.env[DESIGN_AGENT_TIMEOUT_ENV] = "600";
    process.env[DESIGN_AGENT_INACTIVITY_ENV] = "120";
    director.restore();
    director = stubDirector(planOf(4));
    await play({ before: [text("Designing")], beats: true, hang: true });
    const carousel = await createCarousel("Noisy", "4:5");
    fakeTime();
    const run = streamOf(await postChat({ message: "Make 4 slides", carouselId: carousel.id }));
    await run.until(replied("Designing"));
    await agentSaves(carousel.id, 1, 4);
    // Output every 100 seconds keeps the watchdog quiet, and never moves the deadline.
    for (let n = 1; n <= 5; n++) {
      await vi.advanceTimersByTimeAsync(100_000);
      await beat(run, n);
    }
    await vi.advanceTimersByTimeAsync(99_000);
    expect(isGenerating(carousel.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await run.drain();
    vi.useRealTimers();

    const message = executionLimitMessage("deadline", { limitMs: 600_000, saved: 4, expected: 4 });
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", code: "timed_out", message }]);
    // Every planned slide exists, so nothing is called missing.
    expect(message).toContain("all 4 planned slides");
    expect(message).not.toMatch(/missing/);
    expect(runLog()).toMatchObject({
      errorCode: "timed_out",
      limit: "deadline",
      timeoutMs: 600_000,
      inactivityMs: 120_000,
      quietMs: 100_000,
      longestQuietMs: 100_000,
      slidesSaved: 4,
    });
    expect(limitStops()).toHaveLength(1);
  });

  it("kills a CLI that ignores the stop, and the first limit to fire is the only one reported", async () => {
    process.env[DESIGN_AGENT_TIMEOUT_ENV] = "120";
    process.env[DESIGN_AGENT_INACTIVITY_ENV] = "60";
    await play({ before: [text("Designing")], beats: true, hang: true, ignoreSigterm: true });
    const carousel = await createCarousel("Stubborn and silent", "4:5");
    fakeTime();
    const run = streamOf(await postChat({ message: "Make a carousel", carouselId: carousel.id }));
    await run.until(replied("Designing"));
    const pid = Number(await readFile(path.join(fakeDir, "pid"), "utf8"));
    await vi.advanceTimersByTimeAsync(55_000);
    await beat(run, 1);
    // Silent from 55 s: the watchdog stops it at 115 s, and the CLI ignores the stop.
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(isGenerating(carousel.id)).toBe(true);
    // At 120 s the deadline would also have fired; the kill lands instead, and nothing else.
    await vi.advanceTimersByTimeAsync(5_000);
    const events = await run.drain();
    vi.useRealTimers();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(isGenerating(carousel.id)).toBe(false);
    const log = runLog();
    expect(log).toMatchObject({ limit: "inactivity", errorCode: "stalled", slidesSaved: 0 });
    expect(events.filter((e) => e.type === "error")).toEqual([
      {
        type: "error",
        code: "stalled",
        message: executionLimitMessage("inactivity", { limitMs: 60_000, saved: 0, expected: log.slidesExpected as number }),
      },
    ]);
    expect(limitStops()).toHaveLength(1);
  }, 15_000);

  it("fires no limit after Stop", async () => {
    director.restore();
    director = stubDirector(planOf(8));
    await play({ before: [text("Designing")], hang: true });
    const carousel = await createCarousel("Stopped early", "4:5");
    fakeTime();
    const run = streamOf(await postChat({ message: "Make 8 slides", carouselId: carousel.id }));
    await run.until(replied("Designing"));
    const pid = Number(await readFile(path.join(fakeDir, "pid"), "utf8"));
    await agentSaves(carousel.id, 1, 2);
    await run.cancel();
    await settle(() => !isGenerating(carousel.id) && vi.mocked(console.info).mock.calls.some((c) => c[0] === "[chat] run finished"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    vi.useRealTimers();
    expect(limitStops()).toHaveLength(0);
    expect(runLog()).toMatchObject({ outcome: "stopped", failureCategory: "cancelled", limit: null });
    expect((await statusOf(carousel.id)).interrupted).toMatchObject({ reason: "stopped" });
  });

  it("fires no limit after the CLI exits", async () => {
    await play({ before: [text("Designing")], after: [success(0.3)] });
    const carousel = await createCarousel("Quick", "4:5");
    fakeTime();
    const events = await streamOf(await postChat({ message: "Make a carousel", carouselId: carousel.id })).drain();
    await settle(() => !isGenerating(carousel.id) && vi.mocked(console.info).mock.calls.some((c) => c[0] === "[chat] run finished"));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    vi.useRealTimers();
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(limitStops()).toHaveLength(0);
    expect(runLog()).toMatchObject({ outcome: "completed", limit: null });
  });

  it("continues after a stalled stop with only the missing slides, leaving the saved ones untouched", async () => {
    director.restore();
    director = stubDirector(planOf(8));
    await play({ before: [text("Designing")], hang: true });
    const carousel = await createCarousel("Stalled then continued", "4:5");
    fakeTime();
    const run = streamOf(await postChat({ message: "Make 8 slides", carouselId: carousel.id }));
    await run.until(replied("Designing"));
    await agentSaves(carousel.id, 1, 3);
    await vi.advanceTimersByTimeAsync(300_000);
    await run.drain();
    vi.useRealTimers();
    expect(runLog()).toMatchObject({ errorCode: "stalled" });
    const savedBefore = await slidesOf(carousel.id);
    const { continuation } = await statusOf(carousel.id);
    expect(continuation).toMatchObject({ saved: 3, expected: 8 });

    await play({ before: [text("Continuing")], wait: true, after: [success(0.9)] });
    const res = await postChat({ message: "Continue the unfinished design", carouselId: carousel.id, sessionId: SESSION, continueRunId: continuation!.runId });
    await started();
    const task = taskOf((await invocations())[1]);
    expect(task).toContain("Still to make: slides 4 to 8 of the plan.");
    await agentSaves(carousel.id, 4, 8);
    await proceed();
    const events = await readEvents(res);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const after = await slidesOf(carousel.id);
    expect(after).toHaveLength(8);
    expect(after.slice(0, 3)).toEqual(savedBefore);
    expect(director.requests).toHaveLength(1);
    expect(await statusOf(carousel.id)).toEqual({ generating: false, interrupted: null, continuation: null });
    expect((await requestExport(carousel.id)).status).toBe(200);
  });
});

describe("an unfinished design and its continuation (#127)", () => {
  /** Starts an 8-slide run whose agent saves `saved` slides, then ends with `end`. */
  async function interruptedRun(saved: number, end: Record<string, unknown>) {
    director.restore();
    director = stubDirector(planOf(8));
    await play({ before: [text("Designing slide 1")], wait: true, ...end });
    const carousel = await createCarousel("Editorial", "4:5");
    const res = await postChat({ message: "Make an 8 slides editorial carousel", carouselId: carousel.id });
    await started();
    await agentSaves(carousel.id, 1, saved);
    await proceed();
    const events = await readEvents(res);
    return { carousel, events };
  }

  it("keeps 4 of 8 saved slides exactly as saved, marks the run incomplete and offers Continue", async () => {
    process.env[DESIGN_AGENT_BUDGET_ENV] = "1";
    const { carousel, events } = await interruptedRun(4, { after: [BUDGET_RESULT], exit: 1 });
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "budget_exceeded" });
    const saved = await slidesOf(carousel.id);
    expect(saved).toHaveLength(4);
    const status = await statusOf(carousel.id);
    expect(status.interrupted).toMatchObject({ reason: "failed" });
    expect(status.continuation).toMatchObject({ saved: 4, expected: 8 });
    // Not exportable as if it were finished.
    expect((await requestExport(carousel.id)).status).toBe(409);
    expect(exportAllSlidesMock).not.toHaveBeenCalled();
    const log = runLog();
    expect(log).toMatchObject({
      stage: "design",
      failureCategory: "budget_exceeded",
      budgetUsd: 1,
      slidesSaved: 4,
      slidesExpected: 8,
      continuationAvailable: true,
      designCostUsd: 1.02,
    });
    expect(log.runId).toBe(status.continuation!.runId);
    // Safe metadata only: no message, plan text or slide copy.
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logged).not.toContain("Approved copy");
    expect(logged).not.toContain("editorial carousel");
  });

  it("continues in the same session: no re-planning, only the 4 missing slides, saved slides untouched", async () => {
    const { carousel } = await interruptedRun(4, { after: [{ type: "assistant", error: "rate_limit", message: { type: "message", content: [] } }, { type: "result", subtype: "success", is_error: true, result: "limit" }], exit: 1 });
    const savedBefore = await slidesOf(carousel.id);
    const { continuation } = await statusOf(carousel.id);
    expect(director.requests).toHaveLength(1);

    await play({ before: [text("Continuing")], wait: true, after: [success(0.9)] });
    const res = await postChat({
      message: "Continue the unfinished design",
      carouselId: carousel.id,
      sessionId: SESSION,
      continueRunId: continuation!.runId,
    });
    await started();
    const argv = (await invocations())[1];
    expect(argv[argv.indexOf("--resume") + 1]).toBe(SESSION);
    const task = taskOf(argv);
    expect(task.startsWith(CONTINUATION_START)).toBe(true);
    for (const slide of savedBefore) expect(task).toContain(`(ID: ${slide.id})`);
    expect(task).toContain("Still to make: slides 5 to 8 of the plan.");
    expect(task).not.toContain("Slide 4: typography");
    expect(task).toContain("Slide 5: typography. Visual intent: Editorial page 5");
    // The session already holds the original task, so it is not repeated.
    expect(task).not.toContain(ORIGINAL_TASK_START);
    expect(task).not.toContain("Make an 8 slides editorial carousel");

    await agentSaves(carousel.id, 5, 8);
    await proceed();
    const events = await readEvents(res);
    // The Director did not run again, and no image stage ran.
    expect(director.requests).toHaveLength(1);
    expect(events.filter((e) => e.type === "stage")).toEqual([{ type: "stage", stage: "designing" }]);
    expect(events.some((e) => e.type === "error" || e.type === "blocked" || e.type === "deviations")).toBe(false);

    const after = await slidesOf(carousel.id);
    expect(after).toHaveLength(8);
    expect(after.slice(0, 4)).toEqual(savedBefore);
    expect(new Set(after.map((s) => s.id)).size).toBe(8);
    expect(await statusOf(carousel.id)).toEqual({ generating: false, interrupted: null, continuation: null });
    expect(runLog()).toMatchObject({ continued: true, outcome: "completed", slidesSaved: 8, slidesExpected: 8, continuationAvailable: false });
    expect((await requestExport(carousel.id)).status).toBe(200);

    // A spent continuation is refused, and nothing runs.
    const again = await readEvents(
      await postChat({ message: "Continue", carouselId: carousel.id, continueRunId: continuation!.runId })
    );
    expect(again[0]).toMatchObject({ type: "blocked", code: "continue_refused", retryRunId: null });
    expect(await invocations()).toHaveLength(2);
  });

  it("starts a new conversation with the full stored task when the session cannot be resumed", async () => {
    const { carousel } = await interruptedRun(4, { after: [{ type: "result", subtype: "error_during_execution", is_error: true }], exit: 1 });
    const { continuation } = await statusOf(carousel.id);

    // The session is gone: the run fails before changing anything, and Continue stays offered.
    await play({ resumeMissing: true });
    const lost = await readEvents(
      await postChat({ message: "Continue", carouselId: carousel.id, sessionId: OTHER_SESSION, continueRunId: continuation!.runId })
    );
    expect(lost.find((e) => e.type === "error")).toMatchObject({ code: "session_not_found" });
    expect(lost.at(-1)).toEqual({ type: "done", sessionId: null });
    expect(await statusOf(carousel.id)).toMatchObject({ continuation: { runId: continuation!.runId, saved: 4, expected: 8 } });

    // Continue again, with no session: the stored task travels with the continuation.
    await play({ wait: true, after: [success(0.8)] });
    const res = await postChat({ message: "Continue", carouselId: carousel.id, continueRunId: continuation!.runId });
    await started();
    const argv = (await invocations()).at(-1)!;
    expect(argv).not.toContain("--resume");
    const task = taskOf(argv);
    expect(task).toContain(ORIGINAL_TASK_START);
    expect(task).toContain("Make an 8 slides editorial carousel");
    expect(task).toContain("Slides to produce: 8 ");
    await agentSaves(carousel.id, 5, 8);
    await proceed();
    await readEvents(res);
    expect(await slidesOf(carousel.id)).toHaveLength(8);
    expect((await statusOf(carousel.id)).continuation).toBeNull();
    expect(director.requests).toHaveLength(1);
  });

  it("continues after Stop: the CLI is terminated and every saved slide is kept", async () => {
    director.restore();
    director = stubDirector(planOf(8));
    await play({ before: [text("Designing")], hang: true });
    const carousel = await createCarousel("Stopped", "4:5");
    const res = await postChat({ message: "Make 8 slides", carouselId: carousel.id });
    await started();
    const pid = Number(await readFile(path.join(fakeDir, "pid"), "utf8"));
    await agentSaves(carousel.id, 1, 2);
    const before = await slidesOf(carousel.id);
    await res.body!.cancel();
    await waitFor(() => !isGenerating(carousel.id));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await slidesOf(carousel.id)).toEqual(before);
    const status = await statusOf(carousel.id);
    expect(status.interrupted).toMatchObject({ reason: "stopped" });
    expect(status.continuation).toMatchObject({ saved: 2, expected: 8 });
    expect(runLog()).toMatchObject({ outcome: "stopped", failureCategory: "cancelled", errorCode: null });
  });

  it("refuses a Continue for another run, another carousel or a malformed ID, changing nothing", async () => {
    const { carousel } = await interruptedRun(2, { after: [{ type: "result", subtype: "error_during_execution", is_error: true }], exit: 1 });
    const { continuation } = await statusOf(carousel.id);
    const other = await createCarousel("Other", "4:5");
    const count = (await invocations()).length;

    const foreign = await readEvents(await postChat({ message: "Continue", carouselId: other.id, continueRunId: continuation!.runId }));
    expect(foreign[0]).toMatchObject({ type: "blocked", code: "continue_refused" });
    const unknown = await readEvents(
      await postChat({ message: "Continue", carouselId: carousel.id, continueRunId: "11111111-2222-4333-8444-555555555555" })
    );
    expect(unknown[0]).toMatchObject({ type: "blocked", code: "continue_refused" });
    for (const body of [
      { continueRunId: "../x", carouselId: carousel.id },
      { continueRunId: continuation!.runId },
      { continueRunId: continuation!.runId, carouselId: carousel.id, retryRunId: continuation!.runId },
    ]) {
      const res = await postChat({ message: "Continue", ...body });
      expect(res.status).toBe(400);
    }
    expect(await invocations()).toHaveLength(count);
    expect(await slidesOf(carousel.id)).toHaveLength(2);
    // The real offer survives the refusals.
    expect((await statusOf(carousel.id)).continuation).toMatchObject({ runId: continuation!.runId });
  });

  it("withdraws the offer when the user accepts the slides as they are, and after the retry window", async () => {
    const { carousel } = await interruptedRun(3, { after: [{ type: "result", subtype: "error_during_execution", is_error: true }], exit: 1 });
    expect(await continuationOffer(carousel.id, Date.now() + 25 * 60 * 60 * 1000)).toBeNull();
    expect((await statusOf(carousel.id)).continuation).not.toBeNull();
    await acceptSlides(new Request(`http://localhost:3000/api/carousels/${carousel.id}/generation`, { method: "DELETE" }), {
      params: Promise.resolve({ id: carousel.id }),
    });
    expect(await statusOf(carousel.id)).toEqual({ generating: false, interrupted: null, continuation: null });
  });

  it("offers no Continue after a design that completed", async () => {
    director.restore();
    director = stubDirector(planOf(2));
    await play({ wait: true, after: [success(0.3)] });
    const carousel = await createCarousel("Done", "4:5");
    const res = await postChat({ message: "Make 2 slides", carouselId: carousel.id });
    await started();
    await agentSaves(carousel.id, 1, 2);
    await proceed();
    await readEvents(res);
    expect(await statusOf(carousel.id)).toEqual({ generating: false, interrupted: null, continuation: null });
  });
});

describe("failure classification (#127)", () => {
  const cases: [string, Record<string, unknown>, Record<string, string>, string][] = [
    ["a configured cap", { after: [BUDGET_RESULT], exit: 1 }, { [DESIGN_AGENT_BUDGET_ENV]: "1" }, "budget_exceeded"],
    ["a budget error with no cap configured", { after: [BUDGET_RESULT], exit: 1 }, {}, "usage_limited"],
    [
      "a provider usage limit on the reply",
      { after: [{ type: "assistant", error: "rate_limit", message: { type: "message", content: [] } }, { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" }], exit: 1 },
      {},
      "usage_limited",
    ],
    ["a billing restriction", { after: [{ type: "assistant", error: "billing_error", message: { type: "message", content: [] } }], exit: 1 }, {}, "usage_limited"],
    ["a rejected rate-limit event", { after: [{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }], exit: 1 }, {}, "usage_limited"],
    ["a crash", { exit: 2 }, {}, "agent_failed"],
    ["an error result", { after: [{ type: "result", subtype: "error_during_execution", is_error: true }], exit: 1 }, {}, "agent_failed"],
  ];

  it.each(cases)("reports %s distinctly", async (_label, scenario, env, code) => {
    Object.assign(process.env, env);
    await play({ before: [text("Designing")], ...scenario });
    const carousel = await createCarousel("Classify", "4:5");
    const events = await readEvents(await postChat({ message: "Make a carousel", carouselId: carousel.id }));
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toEqual([{ type: "error", code, message: CHAT_ERROR_MESSAGES[code as keyof typeof CHAT_ERROR_MESSAGES] }]);
    expect(runLog()).toMatchObject({ failureCategory: code });
  });

  it("never blames a CreatorBrio cap for a provider limit, and gives each failure its own message", () => {
    expect(CHAT_ERROR_MESSAGES.usage_limited).toMatch(/not a CreatorBrio limit/);
    expect(CHAT_ERROR_MESSAGES.usage_limited).not.toMatch(/DESIGN_AGENT_MAX_BUDGET_USD/);
    expect(CHAT_ERROR_MESSAGES.budget_exceeded).toMatch(/DESIGN_AGENT_MAX_BUDGET_USD/);
    expect(CHAT_ERROR_MESSAGES.timed_out).toMatch(/time limit/);
    expect(CHAT_ERROR_MESSAGES.stalled).toMatch(/no output/);
    const messages = ["budget_exceeded", "usage_limited", "timed_out", "stalled", "agent_failed", "start_failed", "session_not_found"].map(
      (c) => CHAT_ERROR_MESSAGES[c as keyof typeof CHAT_ERROR_MESSAGES]
    );
    expect(new Set(messages).size).toBe(messages.length);
    // The old message that blamed "its spending limit" for every budget error is gone.
    expect(Object.values(CHAT_ERROR_MESSAGES).join(" ")).not.toContain("reached its spending limit for this message");
  });
});

describe("long carousels with no application cap (#127)", () => {
  it.each([
    [8, 3.4],
    [10, 4.9],
  ])("completes a %d-slide editorial run whose estimated cost passes the old USD 1.00 cap", async (count, costUsd) => {
    director.restore();
    director = stubDirector(planOf(count));
    await play({ before: [text("Designing")], wait: true, after: [success(costUsd)] });
    const carousel = await createCarousel(`${count} slides`, "4:5");
    const res = await postChat({ message: `Make a ${count} slides editorial carousel`, carouselId: carousel.id });
    await started();
    await agentSaves(carousel.id, 1, count);
    await proceed();
    const events = await readEvents(res);
    expect((await invocations())[0]).not.toContain("--max-budget-usd");
    expect(events.some((e) => e.type === "error" || e.type === "deviations")).toBe(false);
    expect(await slidesOf(carousel.id)).toHaveLength(count);
    expect(await statusOf(carousel.id)).toEqual({ generating: false, interrupted: null, continuation: null });
    expect(runLog()).toMatchObject({ outcome: "completed", designCostUsd: costUsd, slidesSaved: count, slidesExpected: count, budgetUsd: null });
    expect((await requestExport(carousel.id)).status).toBe(200);
  });
});

describe("the continuation message", () => {
  const plan = {
    status: "ready",
    execution: {
      requestType: "new",
      slideCount: 3,
      slideCountBasis: "user-explicit",
      slides: [1, 2, 3].map((index) => ({ index, visualIntent: `Intent ${index}`, treatment: "typography", assetRefs: [], styleReferenceIds: [] })),
      assets: [],
    },
  } as never;
  const slides = [
    { id: "s-b", order: 1, notes: "Second\nline" },
    { id: "s-a", order: 0, notes: "First" },
  ];

  it("lists saved slides in order and only the missing ones", () => {
    const message = buildContinuationMessage({ plan, slides, originalTask: "ORIGINAL", resumingSession: true });
    expect(message.indexOf("(ID: s-a)")).toBeLessThan(message.indexOf("(ID: s-b)"));
    expect(message).toContain("Slide 2 (ID: s-b) - Second line");
    expect(message).toContain("Still to make: slide 3 of the plan.");
    expect(message).toContain("Slide 3: typography. Visual intent: Intent 3");
    expect(message).not.toContain("Intent 2");
    expect(message).not.toContain("ORIGINAL");
  });

  it("adds nothing when every planned slide exists, and carries the original task to a new conversation", () => {
    const full = [...slides, { id: "s-c", order: 2, notes: "" }];
    const message = buildContinuationMessage({ plan, slides: full, originalTask: "ORIGINAL", resumingSession: false });
    expect(message).toContain("already has all 3 slides");
    expect(message).not.toContain("Still to make");
    expect(message.endsWith(`${ORIGINAL_TASK_START}\nORIGINAL\n--- End of the original request ---`)).toBe(true);
  });
});
