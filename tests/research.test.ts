import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SourceOutcome } from "@/lib/source-retrieval";
import type { SynthesisRequest, SynthesisResult } from "@/lib/research/synthesis";
import type { SearchProvider } from "@/lib/research/search";
import type { CarouselResearch, SearchFailureCode } from "@/types/research";

// Topic research (#252): the search adapter, the quote check, synthesis
// through a real subprocess standing in for the Claude CLI, the run's
// lifecycle through its routes, and the confirmed snapshot. No network and no
// model: search, retrieval and synthesis are injected where the run allows it.

let claudePath = "";
vi.mock("@/lib/claude-path", () => ({
  isClaudeAvailable: () => true,
  getClaudePath: () => claudePath,
}));

const search = await import("@/lib/research/search");
const providers = await import("@/lib/research/providers");
const webSearch = await import("@/lib/research/web-search");
const synthesis = await import("@/lib/research/synthesis");
const run = await import("@/lib/research/run");
const handoff = await import("@/lib/research/handoff");
const researchRoute = await import("@/app/api/carousels/[id]/research/route");
const cancelRoute = await import("@/app/api/carousels/[id]/research/cancel/route");
const confirmRoute = await import("@/app/api/carousels/[id]/research/confirm/route");
const { createCarousel, duplicateCarousel, getCarousel, updateCarouselResearch } = await import("@/lib/carousels");
const { buildDesignMessage } = await import("@/lib/creative-handoff");
const { buildDirectorInput } = await import("@/lib/visual-director");
const { typographyPlanFor } = await import("./helpers/stub-director");
const { validatePlan } = await import("@/lib/director-plan");
const { planContextFor } = await import("@/lib/visual-director");

const KEY = "BSA-synthetic-key-0123456789";

const PAGE_A =
  "Morning light exposure within an hour of waking helps set the body clock, according to sleep researchers. " +
  "A short walk outside counts, even on a cloudy day. Most adults need seven to nine hours of sleep each night. ".repeat(3);
const PAGE_B =
  "Caffeine has a half-life of about five hours in healthy adults, so an afternoon coffee can still affect sleep at night. " +
  "Moving the last cup earlier is a simple change that many people find helps. ".repeat(3);

const DIRECTION = {
  angle: "Three small morning habits that make evenings calmer.",
  audience: "Busy professionals who sleep badly.",
  centralMessage: "Small changes early in the day make sleep easier later.",
  keyPoints: ["Get outside within an hour of waking", "Move the last coffee earlier", "Keep a steady wake time"],
  callToAction: "Save this for tomorrow morning.",
};

function page(url: string, text: string, title = "A page"): SourceOutcome {
  return { url, host: new URL(url).hostname, ok: true, title, text, truncated: false };
}

function modelOutput(overrides: Record<string, unknown> = {}) {
  return {
    findings: [
      {
        text: "Morning light within an hour of waking helps set the body clock.",
        evidence: [{ sourceId: "S1", quote: "Morning light exposure within an hour of waking helps set the body clock" }],
        sensitive: false,
      },
      {
        text: "Caffeine stays in the body for hours.",
        evidence: [{ sourceId: "S2", quote: "Caffeine has a half-life of about five hours in healthy adults" }],
        sensitive: true,
      },
      {
        text: "Cold showers double productivity.",
        evidence: [{ sourceId: "S1", quote: "cold showers double your productivity every single day" }],
        sensitive: false,
      },
    ],
    gaps: ["No source gives a figure for how much light is enough."],
    direction: DIRECTION,
    ...overrides,
  };
}

let workdir: string;
let originalCwd: string;
const originalDeps = { ...run.researchDeps };
let infoLog: string[];
/** Every console call of the test, by level, so a severity can be asserted. */
let logCalls: { level: "info" | "warn" | "error"; line: string }[];
const loggedAt = (level: "info" | "warn" | "error") => logCalls.filter((c) => c.level === level).map((c) => c.line);
const fieldsOf = (line: string) => JSON.parse(line)[1] as Record<string, unknown>;
/** The fields of the run's own `[research] finished` line (never the synthesis's). */
const finishedLog = () => fieldsOf(loggedAt("info").find((l) => l.includes('"[research] finished"'))!);
/** The fields of Claude's web search's `[research] search` line, which level it was logged at. */
const claudeSearchLog = (level: "info" | "warn" | "error") => fieldsOf(loggedAt(level).find((l) => l.includes('"provider":"claude"'))!);

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-research-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  process.chdir(workdir);
  infoLog = [];
  logCalls = [];
  const recorder = (level: "info" | "warn" | "error") => (...args: unknown[]) => {
    const line = JSON.stringify(args);
    infoLog.push(line);
    logCalls.push({ level, line });
  };
  vi.spyOn(console, "info").mockImplementation(recorder("info"));
  vi.spyOn(console, "warn").mockImplementation(recorder("warn"));
  vi.spyOn(console, "error").mockImplementation(recorder("error"));
});

afterEach(async () => {
  Object.assign(run.researchDeps, originalDeps);
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Search.

describe("Brave Search adapter", () => {
  it("is not configured without a key, and a blank key is no key", () => {
    expect(search.braveKeyConfigured({})).toBe(false);
    expect(search.braveKeyConfigured({ [search.SEARCH_KEY_ENV]: "   " })).toBe(false);
    expect(search.braveKeyConfigured({ [search.SEARCH_KEY_ENV]: KEY })).toBe(true);
    expect(providers.configuredSearchProviders({ claudeAvailable: false, env: { [search.SEARCH_KEY_ENV]: "   " } })).toEqual([]);
  });

  it("sends the key only in its header and keeps only distinct web addresses", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      return new Response(
        JSON.stringify({
          web: {
            results: [
              { url: "https://a.example/one", title: "Kept only transiently", description: "never stored" },
              { url: "https://a.example/one" },
              { url: "ftp://b.example/file" },
              { url: "not a url" },
              { url: "https://c.example/two" },
            ],
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const provider = search.braveSearch(KEY, fake);
    const result = await provider.search(search.searchQuery("  calm   mornings  "), new AbortController().signal);
    expect(result).toEqual({ ok: true, urls: ["https://a.example/one", "https://c.example/two"] });
    expect(calls).toHaveLength(1);
    const sent = new URL(calls[0].url);
    expect(sent.origin + sent.pathname).toBe(search.BRAVE_SEARCH_ENDPOINT);
    expect(sent.searchParams.get("q")).toBe("calm mornings");
    expect(sent.search).not.toContain(KEY);
    expect(calls[0].headers["X-Subscription-Token"]).toBe(KEY);
    expect(infoLog.join("\n")).not.toContain(KEY);
    expect(infoLog.join("\n")).not.toContain("calm mornings");
  });

  it.each([
    [401, "search_key_refused"],
    [403, "search_key_refused"],
    [429, "search_rate_limited"],
    [500, "search_unavailable"],
  ])("answers HTTP %i as %s", async (status, code) => {
    const fake = (async () => new Response("{}", { status })) as unknown as typeof fetch;
    const provider = search.braveSearch(KEY, fake);
    expect(await provider.search("topic", new AbortController().signal)).toEqual({ ok: false, code });
  });

  it("answers Brave's invalid-token reply, HTTP 422 with SUBSCRIPTION_TOKEN_INVALID, as a refused key", async () => {
    const body = JSON.stringify({
      type: "ErrorResponse",
      error: { id: "synthetic-id", status: 422, code: "SUBSCRIPTION_TOKEN_INVALID", detail: "The provided subscription token is invalid.", meta: { errors: [] } },
      time: 0,
    });
    const fake = (async () => new Response(body, { status: 422, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const provider = search.braveSearch(KEY, fake);
    expect(await provider.search("topic", new AbortController().signal)).toEqual({ ok: false, code: "search_key_refused" });
    expect(infoLog.join("\n")).toContain('"status":422');
    expect(infoLog.join("\n")).not.toContain(KEY);
  });

  it("answers an unreachable service, a malformed reply and an unusable key without throwing", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await search.braveSearch(KEY, down).search("t", new AbortController().signal)).toEqual({
      ok: false,
      code: "search_unavailable",
    });
    const garbage = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await search.braveSearch(KEY, garbage).search("t", new AbortController().signal)).toEqual({
      ok: false,
      code: "search_unavailable",
    });
    const never = vi.fn();
    const provider = search.braveSearch("key with spaces", never as unknown as typeof fetch);
    expect(await provider.search("t", new AbortController().signal)).toEqual({ ok: false, code: "search_key_refused" });
    expect(never).not.toHaveBeenCalled();
  });

  it("keeps a query within Brave's limits", () => {
    expect(search.searchQuery("word ".repeat(80)).split(" ")).toHaveLength(50);
    expect(Array.from(search.searchQuery("x".repeat(900)))).toHaveLength(400);
  });
});

describe("choosing the web search (#256)", () => {
  const names = (env: Record<string, string>, claudeAvailable: boolean) =>
    providers.configuredSearchProviders({ env, claudeAvailable }).map((p) => p.name);

  it("uses Claude's web search with no Brave key, Brave first with one, and nothing when neither is possible", () => {
    expect(names({}, true)).toEqual(["claude"]);
    expect(names({ [search.SEARCH_KEY_ENV]: KEY }, true)).toEqual(["brave", "claude"]);
    expect(names({ [search.SEARCH_KEY_ENV]: KEY }, false)).toEqual(["brave"]);
    expect(names({}, false)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The quote check.

const PAGES = [
  { id: "S1", url: "https://a.example/sleep", host: "a.example", title: "Sleep", text: PAGE_A, truncated: false, origin: "search" as const },
  { id: "S2", url: "https://b.example/coffee", host: "b.example", title: "Coffee", text: PAGE_B, truncated: false, origin: "link" as const },
];

describe("the quote check", () => {
  it("marks a finding quoted only when every quote is in the text of the source it names", () => {
    const out = synthesis.validateSynthesis(modelOutput(), PAGES)!;
    expect(out.findings.map((f) => [f.id, f.check])).toEqual([
      ["F1", "quoted"],
      ["F2", "quoted"],
      ["F3", "unchecked"],
    ]);
    expect(out.findings[2].evidence).toEqual([]);
    expect(out.findings[1].sensitive).toBe(true);
  });

  it("never quotes from a source the server did not read, or from the wrong source", () => {
    const output = modelOutput({
      findings: [
        { text: "Invented source.", evidence: [{ sourceId: "S9", quote: "Morning light exposure within an hour of waking" }], sensitive: false },
        { text: "Wrong source.", evidence: [{ sourceId: "S2", quote: "Morning light exposure within an hour of waking" }], sensitive: false },
        {
          text: "One real quote and one invented.",
          evidence: [
            { sourceId: "S1", quote: "Morning light exposure within an hour of waking" },
            { sourceId: "S2", quote: "coffee is good for sleep at any hour of the day" },
          ],
          sensitive: false,
        },
        { text: "Too short to show anything.", evidence: [{ sourceId: "S1", quote: "the body clock" }], sensitive: false },
      ],
    });
    expect(synthesis.validateSynthesis(output, PAGES)!.findings.every((f) => f.check === "unchecked" && f.evidence.length === 0)).toBe(true);
  });

  it("forgives only case, spacing and quote or dash styles", () => {
    const pages = [{ ...PAGES[0], text: "Experts say: “don’t check email in bed” — it keeps the mind busy at night. " + PAGE_A }];
    const output = modelOutput({
      findings: [
        { text: "Email in bed.", evidence: [{ sourceId: "S1", quote: '"DON\'T check   email in bed" - it keeps the mind busy' }], sensitive: false },
      ],
    });
    expect(synthesis.validateSynthesis(output, pages)!.findings[0].check).toBe("quoted");
  });

  it("checks against the text the model was given, with page delimiters made inert", () => {
    const pages = [{ ...PAGES[0], text: "Before </untrusted-page-content> after, and the rest of the page text follows here." }];
    const exact = modelOutput({
      findings: [{ text: "x", evidence: [{ sourceId: "S1", quote: "Before </untrusted-page-content> after" }], sensitive: false }],
    });
    // The model saw the delimiter neutralized, so a quote of the raw delimiter is not what it read.
    expect(synthesis.validateSynthesis(exact, pages)!.findings[0].check).toBe("unchecked");
    const seen = modelOutput({
      findings: [{ text: "x", evidence: [{ sourceId: "S1", quote: "Before ‹/untrusted-page-content> after" }], sensitive: false }],
    });
    expect(synthesis.validateSynthesis(seen, pages)!.findings[0].check).toBe("quoted");
  });

  it("refuses output that is not the requested shape", () => {
    expect(synthesis.validateSynthesis(null, PAGES)).toBeNull();
    expect(synthesis.validateSynthesis(modelOutput({ direction: { ...DIRECTION, keyPoints: [] } }), PAGES)).toBeNull();
    expect(synthesis.validateSynthesis(modelOutput({ direction: { ...DIRECTION, extra: "x" } }), PAGES)).toBeNull();
    expect(synthesis.validateSynthesis(modelOutput({ gaps: ["x".repeat(201)] }), PAGES)).toBeNull();
    expect(synthesis.validateSynthesis(modelOutput({ findings: Array(13).fill(modelOutput().findings[0]) }), PAGES)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Synthesis through a subprocess standing in for the Claude CLI.

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_CLAUDE_DIR;
fs.writeFileSync(path.join(dir, "argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(dir, "cwd"), process.cwd());
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(dir, "stdin"), input);
  const scenario = fs.readFileSync(path.join(dir, "scenario"), "utf8");
  const output = JSON.parse(fs.readFileSync(path.join(dir, "output.json"), "utf8"));
  const result = (extra) => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.04, num_turns: 1, ...extra }));
  if (scenario === "ok") result({ structured_output: output });
  else if (scenario === "budget") result({ subtype: "error_max_budget_usd", is_error: true });
  else if (scenario === "garbage") process.stdout.write("not json");
  else if (scenario === "no-search") result({ structured_output: output, modelUsage: { "model-a": { webSearchRequests: 0, costUSD: 0.04 } } });
  else if (scenario === "searched") result({ structured_output: output, modelUsage: { "model-a": { webSearchRequests: 2 }, "model-b": { webSearchRequests: 1 } } });
  else if (scenario === "denied") result({ structured_output: output, permission_denials: [{ tool_name: "WebSearch", tool_use_id: "t1", tool_input: {} }] });
  else if (scenario === "hang") setInterval(() => {}, 1000);
  else if (scenario === "error") {
    result({ subtype: "error_during_execution", is_error: true });
    process.exitCode = 1;
  }
});
`;

describe("synthesis", () => {
  let fakeDir: string;

  beforeEach(async () => {
    fakeDir = path.join(workdir, "fake-claude");
    await mkdir(fakeDir);
    claudePath = path.join(fakeDir, "claude.cjs");
    await writeFile(claudePath, FAKE_CLAUDE);
    await chmod(claudePath, 0o755);
    await writeFile(path.join(fakeDir, "output.json"), JSON.stringify(modelOutput()));
    process.env.FAKE_CLAUDE_DIR = fakeDir;
  });

  afterEach(() => {
    delete process.env.FAKE_CLAUDE_DIR;
    delete process.env[synthesis.RESEARCH_BUDGET_ENV];
  });

  const request: SynthesisRequest = {
    topic: "calmer evenings",
    formatName: "Instagram carousel",
    brand: { name: "Northlight", styleKeywords: ["calm"] },
    pages: PAGES,
  };

  it("runs with the Visual Director's isolation, input on stdin and pages as untrusted blocks", async () => {
    await writeFile(path.join(fakeDir, "scenario"), "ok");
    const result = await synthesis.runSynthesis(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.costUsd).toBe(0.04);
    expect(result.output.findings.map((f) => f.check)).toEqual(["quoted", "quoted", "unchecked"]);

    const argv: string[] = JSON.parse(await readFile(path.join(fakeDir, "argv.json"), "utf8"));
    const cwd = await readFile(path.join(fakeDir, "cwd"), "utf8");
    expect(argv).toEqual(
      (await import("@/lib/structured-claude")).structuredClaudeArgs(cwd, {
        systemPrompt: synthesis.RESEARCH_INSTRUCTIONS,
        schema: synthesis.RESEARCH_OUTPUT_SCHEMA,
        budgetUsd: null,
      })
    );
    expect(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2)).toEqual(["--tools", "Read"]);
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    // The topic and page text never appear in the process arguments.
    expect(argv.join(" ")).not.toContain("calmer evenings");
    expect(argv.join(" ")).not.toContain("half-life");

    const stdin = await readFile(path.join(fakeDir, "stdin"), "utf8");
    expect(stdin).toContain("Topic, in the person's words: calmer evenings");
    expect(stdin.match(/<untrusted-page-content>/g)).toHaveLength(2);
    expect(stdin).toContain("## Source S2 (b.example, a link the person gave)");
    // Its working folder is removed afterwards: the folder itself, not just a file in it.
    await expect(stat(cwd)).rejects.toThrow();
  });

  it("reports the spending cap, an unreadable reply and an invalid cap setting", async () => {
    await writeFile(path.join(fakeDir, "scenario"), "budget");
    expect(await synthesis.runSynthesis(request)).toMatchObject({ ok: false, code: "budget_exceeded" });
    await writeFile(path.join(fakeDir, "scenario"), "garbage");
    expect(await synthesis.runSynthesis(request)).toMatchObject({ ok: false, code: "agent_failed" });
    process.env[synthesis.RESEARCH_BUDGET_ENV] = "lots";
    expect(await synthesis.runSynthesis(request)).toMatchObject({ ok: false, code: "budget_setting_invalid" });
  });

  it("passes a configured cap to the CLI", async () => {
    await writeFile(path.join(fakeDir, "scenario"), "ok");
    process.env[synthesis.RESEARCH_BUDGET_ENV] = "0.50";
    await synthesis.runSynthesis(request);
    const argv: string[] = JSON.parse(await readFile(path.join(fakeDir, "argv.json"), "utf8"));
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.5");
  });

  it("logs every outcome once, as information when it worked and as a warning when it failed as expected", async () => {
    await writeFile(path.join(fakeDir, "scenario"), "ok");
    expect(await synthesis.runSynthesis(request, { carouselId: "carousel-1" })).toMatchObject({ ok: true });
    expect(loggedAt("info")).toHaveLength(1);
    expect(loggedAt("info")[0]).toContain("[research] synthesis finished");
    expect(fieldsOf(loggedAt("info")[0])).toMatchObject({
      carouselId: "carousel-1", outcome: "synthesized", costUsd: 0.04, turns: 1, budgetCapUsd: null, pages: 2, durationMs: expect.any(Number),
    });
    expect(loggedAt("warn")).toEqual([]);

    await writeFile(path.join(fakeDir, "scenario"), "budget");
    await synthesis.runSynthesis(request);
    await writeFile(path.join(fakeDir, "scenario"), "garbage");
    await synthesis.runSynthesis(request);
    await writeFile(path.join(fakeDir, "scenario"), "ok");
    await writeFile(path.join(fakeDir, "output.json"), JSON.stringify({ findings: "not a list" }));
    await synthesis.runSynthesis(request);
    // A time limit that passes before the CLI has even started.
    await synthesis.runSynthesis(request, { timeoutMs: 1 });
    process.env[synthesis.RESEARCH_BUDGET_ENV] = "lots";
    await synthesis.runSynthesis(request);

    expect(loggedAt("warn").map((line) => fieldsOf(line).outcome)).toEqual([
      "budget_exceeded", "agent_failed", "invalid_output", "timed_out", "budget_setting_invalid",
    ]);
    expect(loggedAt("error")).toEqual([]);
    // Codes, cost and counts only: never the topic, a page or a finding.
    for (const text of ["calmer evenings", "half-life", "Morning light", "Caffeine stays"]) expect(infoLog.join("\n")).not.toContain(text);
  });

  it("tells a failed launch from an unexpected failure of ours, and logs only the latter as an error", async () => {
    claudePath = path.join(fakeDir, "no-such-claude");
    expect(await synthesis.runSynthesis(request)).toMatchObject({ ok: false, code: "start_failed" });
    expect(loggedAt("error")).toEqual([]);
    expect(loggedAt("warn")).toHaveLength(1);

    // No temporary folder to work in: a failure of ours, which must not read as "Claude is unavailable".
    claudePath = path.join(fakeDir, "claude.cjs");
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = path.join(workdir, "no-such-folder");
    try {
      expect(await synthesis.runSynthesis(request, { carouselId: "carousel-1" })).toMatchObject({ ok: false, code: "unexpected" });
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
    expect(loggedAt("error")).toHaveLength(1);
    expect(fieldsOf(loggedAt("error")[0])).toMatchObject({ carouselId: "carousel-1", outcome: "unexpected", err: "Error", errCode: "ENOENT" });
    expect(loggedAt("warn")).toHaveLength(1);
    expect(infoLog.join("\n")).not.toContain("calmer evenings");
  });
});

describe("Claude's web search", () => {
  let fakeDir: string;
  const TOPIC = "calmer evenings";

  beforeEach(async () => {
    fakeDir = path.join(workdir, "fake-claude");
    await mkdir(fakeDir);
    claudePath = path.join(fakeDir, "claude.cjs");
    await writeFile(claudePath, FAKE_CLAUDE);
    await chmod(claudePath, 0o755);
    process.env.FAKE_CLAUDE_DIR = fakeDir;
  });

  afterEach(() => {
    delete process.env.FAKE_CLAUDE_DIR;
  });

  async function searchWith(scenario: string, output: unknown, budgetUsd: number | null = null) {
    await writeFile(path.join(fakeDir, "scenario"), scenario);
    await writeFile(path.join(fakeDir, "output.json"), JSON.stringify(output));
    return webSearch.claudeWebSearch().search(TOPIC, new AbortController().signal, { budgetUsd });
  }

  it("runs with web search as its only tool, no Read, the topic on stdin, and returns only well-formed addresses", async () => {
    const urls = [
      "https://a.example/one",
      "https://a.example/one",
      "ftp://b.example/file",
      "javascript:alert(1)",
      "not a url",
      ...Array.from({ length: 12 }, (_, i) => `https://c.example/${i}`),
    ];
    const result = await searchWith("ok", { searched: true, urls });
    expect(result).toEqual({
      ok: true,
      urls: ["https://a.example/one", ...Array.from({ length: search.SEARCH_RESULT_COUNT - 1 }, (_, i) => `https://c.example/${i}`)],
      costUsd: 0.04,
    });

    const argv: string[] = JSON.parse(await readFile(path.join(fakeDir, "argv.json"), "utf8"));
    const cwd = await readFile(path.join(fakeDir, "cwd"), "utf8");
    expect(argv).toEqual(
      (await import("@/lib/structured-claude")).structuredClaudeArgs(cwd, {
        systemPrompt: webSearch.WEB_SEARCH_INSTRUCTIONS,
        schema: webSearch.WEB_SEARCH_SCHEMA,
        budgetUsd: null,
        tools: "web-search",
      })
    );
    expect(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2)).toEqual(["--tools", "WebSearch"]);
    expect(argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", "WebSearch"]);
    expect(argv.some((a) => a.startsWith("Read"))).toBe(false);
    expect(argv).not.toContain("WebFetch");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).not.toContain("--max-budget-usd");
    expect(argv.join(" ")).not.toContain(TOPIC);
    expect(JSON.parse(await readFile(path.join(fakeDir, "stdin"), "utf8"))).toEqual({ topic: TOPIC });
    // Its empty working folder is outside the repository and removed afterwards.
    expect(cwd.startsWith(process.cwd())).toBe(false);
    await expect(stat(cwd)).rejects.toThrow();
    // The log has the outcome and counts, never the topic or an address.
    const logged = infoLog.join("\n");
    expect(logged).toContain('"provider":"claude"');
    expect(logged).not.toContain(TOPIC);
    expect(logged).not.toContain("a.example");
    expect(claudeSearchLog("info")).toMatchObject({ outcome: "results", reason: "results" });
  });

  it("accepts a call whose reported web search count is above zero, or not reported in the documented shape", async () => {
    expect(await searchWith("searched", { searched: true, urls: ["https://a.example/one"] })).toMatchObject({ ok: true, urls: ["https://a.example/one"] });
    expect(fieldsOf(loggedAt("info").find((l) => l.includes('"provider":"claude"'))!)).toMatchObject({ searches: 3 });
    expect(webSearch.reportedWebSearches(undefined)).toBeNull();
    expect(webSearch.reportedWebSearches({})).toBeNull();
    expect(webSearch.reportedWebSearches([{ webSearchRequests: 0 }])).toBeNull();
    expect(webSearch.reportedWebSearches({ a: { webSearchRequests: 0 }, b: {} })).toBeNull();
    expect(webSearch.reportedWebSearches({ a: { webSearchRequests: "0" } })).toBeNull();
    expect(webSearch.reportedWebSearches({ a: { webSearchRequests: 0 }, b: { webSearchRequests: 0 } })).toBe(0);
  });

  it("accepts the addresses of a call the CLI counted no web search for, and only logs the count", async () => {
    // Not every search path of the installed CLI records the count, so a zero is not proof that nothing was searched;
    // the pages are still read, and every quote checked, by the server.
    expect(await searchWith("no-search", { searched: true, urls: ["https://a.example/one"] })).toMatchObject({ ok: true, urls: ["https://a.example/one"] });
    expect(claudeSearchLog("info")).toMatchObject({ outcome: "results", reason: "results", searches: 0 });
    expect(loggedAt("warn")).toEqual([]);
  });

  it("passes the run's remaining budget as its cap, and reports a stop at the cap as budget_exceeded", async () => {
    const stopped = await searchWith("budget", { searched: true, urls: [] }, 0.25);
    // A stop at the cap reports what it cost, so the cost is known.
    expect(stopped).toEqual({ ok: false, code: "budget_exceeded", costUsd: 0.04 });
    expect(claudeSearchLog("warn")).toMatchObject({ outcome: "budget_exceeded", reason: "budget_exceeded", costUsd: 0.04 });
    const argv: string[] = JSON.parse(await readFile(path.join(fakeDir, "argv.json"), "utf8"));
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.25");
  });

  it.each([
    ["the model says it could not search", "ok", { searched: false, urls: ["https://made-up.example/page"] }, "not_searched"],
    ["the connection denies the web search tool", "denied", { searched: true, urls: ["https://a.example/one"] }, "denied"],
    ["the call fails", "error", { searched: true, urls: [] }, "agent_failed"],
    ["the reply is not JSON", "garbage", {}, "agent_failed"],
    ["the output does not match the schema", "ok", { urls: "https://a.example/one" }, "invalid_output"],
  ])("ends as web_search_unavailable when %s, and never returns an address", async (_why, scenario, output, reason) => {
    const result = await searchWith(scenario, output);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("web_search_unavailable");
    expect(result).not.toHaveProperty("urls");
    // The code and the message stay the same; the log says which cause it was, from a closed set.
    const logged = claudeSearchLog("warn");
    expect(logged).toMatchObject({ provider: "claude", outcome: "web_search_unavailable", reason });
    expect(webSearch.WEB_SEARCH_REASONS).toContain(logged.reason);
  });

  it("ends as web_search_unavailable, without throwing, when Claude Code cannot be started", async () => {
    claudePath = path.join(fakeDir, "missing-claude");
    const result = await webSearch.claudeWebSearch().search(TOPIC, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, code: "web_search_unavailable" });
    // Nothing was launched, so nothing can have been spent: the run must not treat it as an unknown cost.
    expect(result).not.toHaveProperty("costUnknown");
    expect(claudeSearchLog("warn")).toMatchObject({ reason: "start_failed" });
  });

  it("ends as web_search_unavailable, as timed out with its cost unknown, when the call never answers", async () => {
    await writeFile(path.join(fakeDir, "scenario"), "hang");
    await writeFile(path.join(fakeDir, "output.json"), JSON.stringify({ searched: true, urls: [] }));
    const result = await webSearch.claudeWebSearch(300).search(TOPIC, new AbortController().signal, { budgetUsd: 1 });
    // It was launched and then stopped, so it may have spent up to its allowance, which is not the same as nothing.
    expect(result).toEqual({ ok: false, code: "web_search_unavailable", costUsd: null, costUnknown: true });
    expect(claudeSearchLog("warn")).toMatchObject({ outcome: "web_search_unavailable", reason: "timed_out", costUsd: null });
  });

  it("ends as web_search_unavailable, logged as an error, when a failure of ours stops it before it launches", async () => {
    const original = process.env.TMPDIR;
    // The call's working folder cannot be made here.
    process.env.TMPDIR = path.join(workdir, "no-such-folder");
    try {
      const result = await webSearch.claudeWebSearch().search(TOPIC, new AbortController().signal);
      expect(result).toEqual({ ok: false, code: "web_search_unavailable", costUsd: null });
      expect(claudeSearchLog("error")).toMatchObject({ reason: "unexpected", err: "Error" });
      expect(infoLog.join("\n")).not.toContain(TOPIC);
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
  });

  it("ends as web_search_unavailable when stopped, and logs it without a warning", async () => {
    await writeFile(path.join(fakeDir, "scenario"), "ok");
    await writeFile(path.join(fakeDir, "output.json"), JSON.stringify({ searched: true, urls: [] }));
    const controller = new AbortController();
    controller.abort();
    expect(await webSearch.claudeWebSearch().search(TOPIC, controller.signal)).toMatchObject({ ok: false, code: "web_search_unavailable" });
    expect(claudeSearchLog("info")).toMatchObject({ reason: "cancelled" });
    expect(loggedAt("warn")).toEqual([]);
    expect(loggedAt("error")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The run, through its routes.

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function start(id: string, body: unknown) {
  const res = await researchRoute.POST(
    new Request(`http://localhost:3000/api/carousels/${id}/research`, { method: "POST", body: JSON.stringify(body) }),
    params(id)
  );
  return { status: res.status, body: await res.json() };
}

async function read(id: string): Promise<CarouselResearch | null> {
  const res = await researchRoute.GET(new Request(`http://localhost:3000/api/carousels/${id}/research`), params(id));
  return (await res.json()).research;
}

async function confirm(id: string, body: unknown) {
  const res = await confirmRoute.POST(
    new Request(`http://localhost:3000/api/carousels/${id}/research/confirm`, { method: "POST", body: JSON.stringify(body) }),
    params(id)
  );
  return { status: res.status, body: await res.json() };
}

/** What a scripted search answers: addresses, or a failure; either with what it cost, or as a launched call whose cost is unknown. */
type ScriptedSearch =
  | string[]
  | { urls: string[]; costUsd: number }
  | { code: SearchFailureCode | "budget_exceeded"; costUsd?: number; costUnknown?: boolean };

interface Script {
  /** Brave Search's answer; absent when no key is set. */
  searchUrls?: ScriptedSearch;
  /** Claude's web search's answer; absent when no web search is possible (#256). */
  claude?: ScriptedSearch;
  pages?: Record<string, SourceOutcome | null>;
  synthesize?: (request: SynthesisRequest, signal: AbortSignal) => Promise<SynthesisResult>;
}

function script(s: Script) {
  const seen = {
    queries: [] as string[],
    links: [] as string[][],
    requests: [] as SynthesisRequest[],
    searches: [] as { name: string; budgetUsd: number | null | undefined }[],
    synthesisBudgets: [] as (number | null | undefined)[],
  };
  const scripted = (name: "brave" | "claude", answer: ScriptedSearch): SearchProvider => ({
    name,
    search: async (query, _signal, options) => {
      seen.queries.push(query);
      seen.searches.push({ name, budgetUsd: options?.budgetUsd });
      if (Array.isArray(answer)) return { ok: true, urls: answer };
      if ("urls" in answer) return { ok: true, urls: answer.urls, costUsd: answer.costUsd };
      return { ok: false, code: answer.code, costUsd: answer.costUsd, costUnknown: answer.costUnknown };
    },
  });
  run.researchDeps.searchProviders = () => [
    ...(s.searchUrls === undefined ? [] : [scripted("brave", s.searchUrls)]),
    ...(s.claude === undefined ? [] : [scripted("claude", s.claude)]),
  ];
  run.researchDeps.retrieveLinks = async (links) => {
    seen.links.push(links);
    return links.map((url) => s.pages?.[url] ?? { url, host: new URL(url).hostname, ok: false, reason: "http_status" });
  };
  run.researchDeps.synthesize = async (request, { signal, budgetUsd }) => {
    seen.requests.push(request);
    seen.synthesisBudgets.push(budgetUsd);
    if (s.synthesize) return s.synthesize(request, signal);
    const output = synthesis.validateSynthesis(modelOutput(), request.pages)!;
    return { ok: true, output, usage: { costUsd: 0.05, durationMs: 1 } };
  };
  run.researchDeps.claudeAvailable = () => true;
  return seen;
}

async function settledResearch(id: string) {
  await run.researchSettled(id);
  return (await read(id))!;
}

describe("a research run", () => {
  it("searches, reads the person's links first, synthesizes and stores only what the server read", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({
      searchUrls: ["https://a.example/sleep", "https://b.example/coffee", "https://a.example/two", "https://a.example/three"],
      pages: {
        "https://mine.example/notes": page("https://mine.example/notes", PAGE_B, "My notes"),
        "https://a.example/sleep": page("https://a.example/sleep", PAGE_A, "Sleep"),
        "https://a.example/two": page("https://a.example/two", PAGE_A),
        "https://a.example/three": page("https://a.example/three", PAGE_A),
      },
    });
    const started = await start(carousel.id, { topic: "  calmer   evenings ", links: ["https://mine.example/notes"] });
    expect(started.status).toBe(202);
    expect(started.body.research).toMatchObject({ revision: 1, state: "running", topic: "calmer evenings", searchProvider: "brave" });

    const research = await settledResearch(carousel.id);
    expect(research.state).toBe("ready");
    expect(seen.queries).toEqual(["calmer evenings"]);
    expect(seen.links[0][0]).toBe("https://mine.example/notes");
    // The link first, then at most two pages from one search host; the unreadable result is listed.
    const pages = seen.requests[0].pages;
    expect(pages.map((p) => [p.id, p.url, p.origin])).toEqual([
      ["S1", "https://mine.example/notes", "link"],
      ["S2", "https://a.example/sleep", "search"],
      ["S3", "https://a.example/two", "search"],
    ]);
    // Brave's terms forbid keeping search results: the failed search page is listed without its host.
    expect(research.result!.unreadable).toEqual([{ host: "", origin: "search", reason: "http_status" }]);
    expect(research.result!.sources.map((s) => ({ id: s.id, kind: s.kind, reliability: s.reliability, retrievedBy: s.retrievedBy }))).toEqual(
      ["S1", "S2", "S3"].map((id) => ({ id, kind: "url", reliability: "unverified", retrievedBy: "source-retrieval" }))
    );
    expect(research.result!.sources[0].blob).toBe(synthesis.textHash(PAGE_B));
    expect(research.usage).toMatchObject({ costUsd: 0.05, searchRequests: 1, pagesRead: 3 });
    // Page text is never stored.
    const stored = await readFile(path.join(workdir, "data", "carousels.json"), "utf8");
    expect(stored).not.toContain("half-life of about five hours in healthy adults, so");
    // Nor is the host of a search result that could not be read.
    expect(stored).not.toContain("b.example");
  });

  it("keeps the host of one of the person's own links that could not be read", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ pages: { "https://mine.example/a": page("https://mine.example/a", PAGE_A) } });
    await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a", "https://gone.example/x"] });
    const research = await settledResearch(carousel.id);
    expect(research.state).toBe("ready");
    expect(research.result!.unreadable).toEqual([{ host: "gone.example", origin: "link", reason: "http_status" }]);
  });

  it("researches from the person's links alone when no web search is possible, and refuses a topic alone then", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ pages: { "https://mine.example/a": page("https://mine.example/a", PAGE_A) } });
    expect((await start(carousel.id, { topic: "calmer evenings" })).status).toBe(400);
    expect(await read(carousel.id)).toBeNull();
    const started = await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
    expect(started.body.research).toMatchObject({ searchProvider: null, stage: "reading" });
    expect((await settledResearch(carousel.id)).state).toBe("ready");
  });

  it.each(["search_key_refused", "search_rate_limited", "search_unavailable"] as const)(
    "goes on with the person's links when search fails with %s, and records why",
    async (code) => {
      const carousel = await createCarousel("Evenings", "4:5");
      const seen = script({ searchUrls: { code }, pages: { "https://mine.example/a": page("https://mine.example/a", PAGE_A) } });
      await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
      const research = await settledResearch(carousel.id);
      expect(research).toMatchObject({ state: "ready", usage: { searchRequests: 1, pagesRead: 1 } });
      expect(research.result!.searchFailure).toBe(code);
      expect(seen.links).toEqual([["https://mine.example/a"]]);
      expect(research.result!.sources.map((s) => s.origin)).toEqual(["link"]);
    }
  );

  it("researches a topic alone with Claude's web search when no Brave key is set, and says so", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({
      claude: { urls: ["https://a.example/sleep", "https://b.example/coffee"], costUsd: 0.12 },
      pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A), "https://b.example/coffee": page("https://b.example/coffee", PAGE_B) },
    });
    const started = await start(carousel.id, { topic: "calmer evenings" });
    expect(started.status).toBe(202);
    expect(started.body.research).toMatchObject({ searchProvider: "claude", stage: "searching" });
    const research = await settledResearch(carousel.id);
    expect(research.state).toBe("ready");
    expect(seen.searches.map((x) => x.name)).toEqual(["claude"]);
    expect(research.result!.searchMethod).toBe("claude");
    expect(research.result).not.toHaveProperty("searchFailure");
    // The pages were read by the server, exactly as for Brave's results, and are attributed as found by search.
    expect(seen.links).toEqual([["https://a.example/sleep", "https://b.example/coffee"]]);
    expect(research.result!.sources.map((x) => ({ url: x.url, origin: x.origin, retrievedBy: x.retrievedBy, reliability: x.reliability }))).toEqual([
      { url: "https://a.example/sleep", origin: "search", retrievedBy: "source-retrieval", reliability: "unverified" },
      { url: "https://b.example/coffee", origin: "search", retrievedBy: "source-retrieval", reliability: "unverified" },
    ]);
    // What the run cost covers both Claude calls.
    expect(research.usage).toMatchObject({ searchRequests: 1, pagesRead: 2 });
    expect(research.usage!.costUsd).toBeCloseTo(0.17, 10);
  });

  it("uses Brave Search first when a key is set, and does not ask Claude to search", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({
      searchUrls: ["https://a.example/sleep"],
      claude: ["https://never.example/x"],
      pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) },
    });
    await start(carousel.id, { topic: "calmer evenings" });
    const research = await settledResearch(carousel.id);
    expect(seen.searches.map((x) => x.name)).toEqual(["brave"]);
    expect(research.result!.searchMethod).toBe("brave");
    expect(research.usage).toMatchObject({ costUsd: 0.05, searchRequests: 1 });
  });

  it.each(["search_key_refused", "search_rate_limited", "search_unavailable"] as const)(
    "falls back to Claude's web search when Brave fails with %s, and records both",
    async (code) => {
      const carousel = await createCarousel("Evenings", "4:5");
      const seen = script({
        searchUrls: { code },
        claude: ["https://a.example/sleep"],
        pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) },
      });
      const started = await start(carousel.id, { topic: "calmer evenings" });
      expect(started.body.research).toMatchObject({ searchProvider: "brave" });
      const research = await settledResearch(carousel.id);
      expect(research.state).toBe("ready");
      expect(seen.searches.map((x) => x.name)).toEqual(["brave", "claude"]);
      expect(research.result).toMatchObject({ searchMethod: "claude", searchFailure: code });
      expect(research.usage).toMatchObject({ searchRequests: 2, pagesRead: 1 });
      expect(finishedLog()).toMatchObject({ outcome: "ready", searchMethod: "claude", searchFailures: [code] });
    }
  );

  it("does not fall back when Brave works but finds nothing", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({ searchUrls: [], claude: ["https://a.example/sleep"] });
    await start(carousel.id, { topic: "calmer evenings" });
    const research = await settledResearch(carousel.id);
    expect(research.failure?.code).toBe("no_results");
    expect(seen.searches.map((x) => x.name)).toEqual(["brave"]);
  });

  it("ends as web_search_unavailable, with what to do, when neither search works and there are no links", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ claude: { code: "web_search_unavailable" } });
    await start(carousel.id, { topic: "calmer evenings" });
    const research = await settledResearch(carousel.id);
    expect(research.failure).toEqual({ code: "web_search_unavailable", message: run.RESEARCH_FAILURE_MESSAGES.web_search_unavailable });
    expect(research.failure!.message).toMatch(/Try again/);
    expect(research.failure!.message).toMatch(/links/);
    expect(research.failure!.message).toMatch(/Brave Search/);
  });

  it("reports Brave's failure when Claude's web search cannot stand in either", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({ searchUrls: { code: "search_key_refused" }, claude: { code: "web_search_unavailable" } });
    await start(carousel.id, { topic: "calmer evenings" });
    const research = await settledResearch(carousel.id);
    expect(research.failure?.code).toBe("search_key_refused");
    expect(seen.searches.map((x) => x.name)).toEqual(["brave", "claude"]);
    // The stored failure is the first; the log keeps every failure the run went past, in order.
    expect(finishedLog()).toMatchObject({ outcome: "search_key_refused", searchFailures: ["search_key_refused", "web_search_unavailable"] });
  });

  it("goes on with the person's links when Claude's web search is unavailable", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ claude: { code: "web_search_unavailable" }, pages: { "https://mine.example/a": page("https://mine.example/a", PAGE_A) } });
    await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
    const research = await settledResearch(carousel.id);
    expect(research.state).toBe("ready");
    expect(research.result).toMatchObject({ searchFailure: "web_search_unavailable" });
    expect(research.result).not.toHaveProperty("searchMethod");
    expect(research.result!.sources.map((x) => x.origin)).toEqual(["link"]);
  });

  it("does not credit a search none of whose pages could be read", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ claude: ["https://gone.example/x"], pages: { "https://mine.example/a": page("https://mine.example/a", PAGE_A) } });
    await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
    const research = await settledResearch(carousel.id);
    expect(research.state).toBe("ready");
    expect(research.result).not.toHaveProperty("searchMethod");
    expect(research.result!.sources.map((x) => x.origin)).toEqual(["link"]);
  });

  it("holds the whole run to RESEARCH_MAX_BUDGET_USD: synthesis may spend only what web search left", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({
      claude: { urls: ["https://a.example/sleep"], costUsd: 0.3 },
      pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) },
    });
    process.env[synthesis.RESEARCH_BUDGET_ENV] = "1.00";
    try {
      await start(carousel.id, { topic: "calmer evenings" });
      const research = await settledResearch(carousel.id);
      expect(research.state).toBe("ready");
      expect(seen.searches).toEqual([{ name: "claude", budgetUsd: 1 }]);
      expect(seen.synthesisBudgets[0]).toBeCloseTo(0.7, 10);
      expect(research.usage!.costUsd).toBeCloseTo(0.35, 10);
    } finally {
      delete process.env[synthesis.RESEARCH_BUDGET_ENV];
    }
  });

  it("ends as budget_exceeded when web search reaches the cap, without another search or synthesis", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({ searchUrls: { code: "search_unavailable" }, claude: { code: "budget_exceeded", costUsd: 0.5 } });
    process.env[synthesis.RESEARCH_BUDGET_ENV] = "0.50";
    try {
      await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
      const research = await settledResearch(carousel.id);
      expect(research.failure?.code).toBe("budget_exceeded");
      expect(research.usage).toMatchObject({ costUsd: 0.5, searchRequests: 2 });
      expect(seen.links).toEqual([]);
      expect(seen.requests).toEqual([]);
    } finally {
      delete process.env[synthesis.RESEARCH_BUDGET_ENV];
    }
  });

  it("ends as budget_exceeded before synthesis when web search spent the whole cap", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({
      claude: { urls: ["https://a.example/sleep"], costUsd: 0.5 },
      pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) },
    });
    process.env[synthesis.RESEARCH_BUDGET_ENV] = "0.50";
    try {
      await start(carousel.id, { topic: "calmer evenings" });
      expect((await settledResearch(carousel.id)).failure?.code).toBe("budget_exceeded");
      expect(seen.requests).toEqual([]);
    } finally {
      delete process.env[synthesis.RESEARCH_BUDGET_ENV];
    }
  });

  describe("a launched web search whose cost is unknown", () => {
    const unknownCost = () =>
      script({
        claude: { code: "web_search_unavailable", costUnknown: true },
        pages: { "https://mine.example/a": page("https://mine.example/a", PAGE_A) },
      });

    it("ends, under a cap, at once with the search's own failure: no page is read and no synthesis starts", async () => {
      const carousel = await createCarousel("Evenings", "4:5");
      const seen = unknownCost();
      process.env[synthesis.RESEARCH_BUDGET_ENV] = "1.00";
      try {
        await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
        const research = await settledResearch(carousel.id);
        // Not budget_exceeded: no limit the person could raise would help, and the search's failure is what they can act on.
        expect(research.failure).toEqual({ code: "web_search_unavailable", message: run.RESEARCH_FAILURE_MESSAGES.web_search_unavailable });
        // The search was given the cap; the run then had nothing it could prove was left.
        expect(seen.searches).toEqual([{ name: "claude", budgetUsd: 1 }]);
        expect(seen.links).toEqual([]);
        expect(seen.requests).toEqual([]);
        expect(seen.synthesisBudgets).toEqual([]);
        expect(finishedLog()).toMatchObject({ outcome: "web_search_unavailable", searchFailures: ["web_search_unavailable"] });
      } finally {
        delete process.env[synthesis.RESEARCH_BUDGET_ENV];
      }
    });

    it("ends, under a cap, with the first failure when Brave failed before it, and reads nothing", async () => {
      const carousel = await createCarousel("Evenings", "4:5");
      const seen = script({
        searchUrls: { code: "search_key_refused" },
        claude: { code: "web_search_unavailable", costUnknown: true },
        pages: { "https://mine.example/a": page("https://mine.example/a", PAGE_A) },
      });
      process.env[synthesis.RESEARCH_BUDGET_ENV] = "1.00";
      try {
        await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
        const research = await settledResearch(carousel.id);
        expect(research.failure).toEqual({ code: "search_key_refused", message: run.RESEARCH_FAILURE_MESSAGES.search_key_refused });
        expect(seen.searches.map((x) => x.name)).toEqual(["brave", "claude"]);
        expect(seen.links).toEqual([]);
        expect(seen.requests).toEqual([]);
        expect(finishedLog()).toMatchObject({ searchFailures: ["search_key_refused", "web_search_unavailable"] });
      } finally {
        delete process.env[synthesis.RESEARCH_BUDGET_ENV];
      }
    });

    it("changes nothing without a cap: the run goes on to synthesis with the person's links", async () => {
      const carousel = await createCarousel("Evenings", "4:5");
      const seen = unknownCost();
      await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
      const research = await settledResearch(carousel.id);
      expect(research.state).toBe("ready");
      expect(research.result).toMatchObject({ searchFailure: "web_search_unavailable" });
      expect(seen.synthesisBudgets).toEqual([null]);
    });

    it("is not assumed for a search that could not be started: synthesis still gets the cap", async () => {
      const carousel = await createCarousel("Evenings", "4:5");
      const seen = script({
        claude: { code: "web_search_unavailable" },
        pages: { "https://mine.example/a": page("https://mine.example/a", PAGE_A) },
      });
      process.env[synthesis.RESEARCH_BUDGET_ENV] = "1.00";
      try {
        await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
        expect((await settledResearch(carousel.id)).state).toBe("ready");
        expect(seen.synthesisBudgets).toEqual([1]);
      } finally {
        delete process.env[synthesis.RESEARCH_BUDGET_ENV];
      }
    });
  });

  it("ends as budget_setting_invalid, never as no cap, when the setting turns invalid after the start check", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({ pages: { "https://mine.example/a": page("https://mine.example/a", PAGE_A) } });
    let searched = false;
    // The start checks the setting, and only afterwards reads the searches' names: this one changes the setting in between.
    run.researchDeps.searchProviders = () => [
      {
        get name() {
          process.env[synthesis.RESEARCH_BUDGET_ENV] = "lots";
          return "claude" as const;
        },
        search: async () => {
          searched = true;
          return { ok: true, urls: [] };
        },
      },
    ];
    try {
      expect((await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] })).status).toBe(202);
      const research = await settledResearch(carousel.id);
      expect(research.failure).toEqual({ code: "budget_setting_invalid", message: run.RESEARCH_FAILURE_MESSAGES.budget_setting_invalid });
      expect(searched).toBe(false);
      expect(seen).toMatchObject({ links: [], requests: [] });
    } finally {
      delete process.env[synthesis.RESEARCH_BUDGET_ENV];
    }
  });

  it("records no search failure when search worked", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) } });
    await start(carousel.id, { topic: "calmer evenings" });
    const research = await settledResearch(carousel.id);
    expect(research.state).toBe("ready");
    expect(research.result).not.toHaveProperty("searchFailure");
    expect(finishedLog()).toMatchObject({ searchFailures: [] });
  });

  it("refuses a bad topic, too many links, a link that cannot be read, an unknown project and a second run", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    let release!: () => void;
    script({
      searchUrls: ["https://a.example/sleep"],
      pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) },
      synthesize: async (request) => {
        await new Promise<void>((r) => (release = r));
        return { ok: true, output: synthesis.validateSynthesis(modelOutput(), request.pages)!, usage: { costUsd: 0, durationMs: 1 } };
      },
    });
    const tooShort = await start(carousel.id, { topic: "x" });
    expect(tooShort.status).toBe(400);
    // Only the refusals Settings fixes carry a code.
    expect(tooShort.body).not.toHaveProperty("code");
    expect((await start(carousel.id, { topic: "ok topic", links: ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"] })).status).toBe(400);
    expect((await start(carousel.id, { topic: "ok topic", links: ["http://127.0.0.1/private"] })).status).toBe(400);
    expect((await start("missing", { topic: "ok topic" })).status).toBe(404);
    expect((await start(carousel.id, { topic: "ok topic" })).status).toBe(202);
    expect((await start(carousel.id, { topic: "ok topic" })).status).toBe(409);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    expect((await settledResearch(carousel.id)).state).toBe("ready");
  });

  it("refuses an invalid RESEARCH_MAX_BUDGET_USD before it searches or reads anything", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({
      searchUrls: ["https://a.example/sleep"],
      pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A), "https://mine.example/a": page("https://mine.example/a", PAGE_A) },
    });
    process.env[synthesis.RESEARCH_BUDGET_ENV] = "lots";
    try {
      const refused = await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(run.RESEARCH_FAILURE_MESSAGES.budget_setting_invalid);
      // The code lets the screen link to the Settings row that fixes it.
      expect(refused.body).toEqual({ error: run.RESEARCH_FAILURE_MESSAGES.budget_setting_invalid, code: "budget_setting_invalid" });
    } finally {
      delete process.env[synthesis.RESEARCH_BUDGET_ENV];
    }
    expect(seen).toMatchObject({ queries: [], links: [], requests: [] });
    expect(run.isResearching(carousel.id)).toBe(false);
    expect(await read(carousel.id)).toBeNull();
  });

  it("refuses to start when Claude is not available, before it searches or reads anything", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({ searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) } });
    run.researchDeps.claudeAvailable = () => false;
    const refused = await start(carousel.id, { topic: "calmer evenings" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(run.RESEARCH_FAILURE_MESSAGES.claude_unavailable);
    // The code lets the screen link to the Settings row that fixes it.
    expect(refused.body).toEqual({ error: run.RESEARCH_FAILURE_MESSAGES.claude_unavailable, code: "claude_unavailable" });
    expect(seen).toMatchObject({ queries: [], links: [], requests: [] });
    expect(await read(carousel.id)).toBeNull();
  });

  it("answers claude_unavailable, not the links refusal, when Claude is missing and there is no web search and no link", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({});
    run.researchDeps.claudeAvailable = () => false;
    const refused = await start(carousel.id, { topic: "calmer evenings" });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: run.RESEARCH_FAILURE_MESSAGES.claude_unavailable, code: "claude_unavailable" });
    expect(seen).toMatchObject({ queries: [], links: [], requests: [] });
    expect(await read(carousel.id)).toBeNull();
  });

  it.each([
    ["search_key_refused", { searchUrls: { code: "search_key_refused" as const } }],
    ["search_rate_limited", { searchUrls: { code: "search_rate_limited" as const } }],
    ["search_unavailable", { searchUrls: { code: "search_unavailable" as const } }],
    ["web_search_unavailable", { claude: { code: "web_search_unavailable" as const } }],
    ["no_results", { searchUrls: [] }],
    ["no_readable_pages", { searchUrls: ["https://a.example/gone"] }],
    [
      "synthesis_timed_out",
      { searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) }, synthesize: async () => ({ ok: false as const, code: "timed_out" as const, usage: { costUsd: 0.02, durationMs: 1 } }) },
    ],
    [
      "synthesis_failed",
      { searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) }, synthesize: async () => ({ ok: false as const, code: "invalid_output" as const, usage: { costUsd: 0.02, durationMs: 1 } }) },
    ],
    [
      "budget_exceeded",
      { searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) }, synthesize: async () => ({ ok: false as const, code: "budget_exceeded" as const, usage: { costUsd: 0.5, durationMs: 1 } }) },
    ],
    [
      "claude_unavailable",
      { searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) }, synthesize: async () => ({ ok: false as const, code: "start_failed" as const, usage: { costUsd: null, durationMs: 1 } }) },
    ],
    [
      // A failure of the server's own is never reported as a Claude sign-in problem.
      "research_failed",
      { searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) }, synthesize: async () => ({ ok: false as const, code: "unexpected" as const, usage: { costUsd: null, durationMs: 1 } }) },
    ],
  ])("ends as failed with %s and a message, and changes nothing else", async (code, s) => {
    const carousel = await createCarousel("Evenings", "4:5");
    const before = await getCarousel(carousel.id);
    script(s as Script);
    await start(carousel.id, { topic: "calmer evenings" });
    const research = await settledResearch(carousel.id);
    expect(research.state).toBe("failed");
    expect(research.failure).toEqual({ code, message: run.RESEARCH_FAILURE_MESSAGES[code as keyof typeof run.RESEARCH_FAILURE_MESSAGES] });
    expect(research.result).toBeUndefined();
    const after = await getCarousel(carousel.id);
    expect({ ...after, research: undefined, updatedAt: "" }).toEqual({ ...before, research: undefined, updatedAt: "" });
  });

  it("stops when cancelled, and reports a run a stopped server left behind as interrupted", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({
      searchUrls: ["https://a.example/sleep"],
      pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) },
      synthesize: (_request, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, code: "cancelled", usage: { costUsd: null, durationMs: 1 } }))),
    });
    await start(carousel.id, { topic: "calmer evenings" });
    await vi.waitFor(async () => expect((await read(carousel.id))!.stage).toBe("synthesizing"));
    const cancelled = await cancelRoute.POST(new Request("http://localhost/x", { method: "POST" }), params(carousel.id));
    expect(cancelled.status).toBe(202);
    expect((await settledResearch(carousel.id)).failure?.code).toBe("cancelled");
    expect((await cancelRoute.POST(new Request("http://localhost/x", { method: "POST" }), params(carousel.id))).status).toBe(409);

    // A record still "running" that this process does not hold: the server stopped mid-run.
    await updateCarouselResearch(carousel.id, (current) => ({ ...current!, revision: 7, state: "running", stage: "reading", failure: undefined }));
    const research = (await read(carousel.id))!;
    expect(research).toMatchObject({ revision: 7, state: "failed", failure: { code: "interrupted" } });
  });

  it("stops a run that is still reading pages, and never starts the model", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    const seen = script({});
    let reading = false;
    // Retrieval that never answers: only the stop can end the run.
    run.researchDeps.retrieveLinks = () => {
      reading = true;
      return new Promise<SourceOutcome[]>(() => {});
    };
    await start(carousel.id, { topic: "calmer evenings", links: ["https://mine.example/a"] });
    await vi.waitFor(() => expect(reading).toBe(true));
    expect((await read(carousel.id))!.stage).toBe("reading");
    expect((await cancelRoute.POST(new Request("http://localhost/x", { method: "POST" }), params(carousel.id))).status).toBe(202);
    expect(await settledResearch(carousel.id)).toMatchObject({ state: "failed", failure: { code: "cancelled" } });
    expect(seen.requests).toEqual([]);
  });

  it("ends as cancelled when the stop arrives after the model answered and before the result is stored", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    let answer!: () => void;
    script({
      searchUrls: ["https://a.example/sleep"],
      pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) },
      // Ignores the stop, as a model call that had already finished would.
      synthesize: async (request) => {
        await new Promise<void>((r) => (answer = r));
        return { ok: true, output: synthesis.validateSynthesis(modelOutput(), request.pages)!, usage: { costUsd: 0.05, durationMs: 1 } };
      },
    });
    await start(carousel.id, { topic: "calmer evenings" });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    expect((await cancelRoute.POST(new Request("http://localhost/x", { method: "POST" }), params(carousel.id))).status).toBe(202);
    answer();
    const research = await settledResearch(carousel.id);
    expect(research).toMatchObject({ state: "failed", failure: { code: "cancelled" }, usage: { costUsd: 0.05 } });
    expect(research.result).toBeUndefined();
  });

  it("ends as research_failed, logged as an error without the topic, when something unexpected is thrown", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) } });
    run.researchDeps.retrieveLinks = async () => {
      throw new TypeError("disk trouble while researching calmer evenings");
    };
    await start(carousel.id, { topic: "calmer evenings" });
    const research = await settledResearch(carousel.id);
    expect(research).toMatchObject({ state: "failed", failure: { code: "research_failed", message: run.RESEARCH_FAILURE_MESSAGES.research_failed } });
    const errors = loggedAt("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[research] finished");
    expect(errors[0]).toContain('"outcome":"research_failed"');
    // The error's name, never its message.
    expect(errors[0]).toContain('"err":"TypeError"');
    // The run's one "finished" line is the error: it is not repeated as information.
    expect(loggedAt("info").filter((line) => line.includes("[research] finished"))).toEqual([]);
    expect(infoLog.join("\n")).not.toContain("calmer evenings");
  });

  it("logs one error, with the real cause, when synthesis fails unexpectedly, and the run's own line is information without an err", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) } });
    // The real synthesis, with no temporary folder to work in: a failure of ours, not a failed launch.
    run.researchDeps.synthesize = originalDeps.synthesize;
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = path.join(workdir, "no-such-folder");
    let research!: CarouselResearch;
    try {
      await start(carousel.id, { topic: "calmer evenings" });
      research = await settledResearch(carousel.id);
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
    expect(research).toMatchObject({ state: "failed", failure: { code: "research_failed", message: run.RESEARCH_FAILURE_MESSAGES.research_failed } });
    // One error line, the one synthesis wrote, naming the real cause; the run adds no second error.
    const errors = loggedAt("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[research] synthesis finished");
    expect(fieldsOf(errors[0])).toMatchObject({ carouselId: carousel.id, outcome: "unexpected", err: "Error", errCode: "ENOENT" });
    const finished = loggedAt("info").filter((line) => line.includes("[research] finished"));
    expect(finished).toHaveLength(1);
    expect(fieldsOf(finished[0])).toMatchObject({ carouselId: carousel.id, outcome: "research_failed" });
    expect(fieldsOf(finished[0])).not.toHaveProperty("err");
    expect(infoLog.join("\n")).not.toContain("calmer evenings");
  });

  it("confirms only the latest ready revision, keeps the snapshot across a new run, and never lets a copy inherit a running run", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) } });
    await start(carousel.id, { topic: "calmer evenings" });
    await settledResearch(carousel.id);

    expect((await confirm(carousel.id, { revision: 2, direction: DIRECTION })).status).toBe(409);
    expect((await confirm(carousel.id, { revision: 1, direction: { ...DIRECTION, angle: "" } })).status).toBe(400);
    const edited = { ...DIRECTION, angle: "My own angle on calmer evenings." };
    const confirmed = await confirm(carousel.id, { revision: 1, direction: edited });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.research.confirmed).toMatchObject({ revision: 1, topic: "calmer evenings", direction: edited, edited: true });
    expect(confirmed.body.research.confirmed.findings).toHaveLength(3);

    // A new run keeps the snapshot until the person confirms another.
    let release!: () => void;
    script({
      searchUrls: ["https://a.example/sleep"],
      pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) },
      synthesize: async (request) => {
        await new Promise<void>((r) => (release = r));
        return { ok: true, output: synthesis.validateSynthesis(modelOutput(), request.pages)!, usage: { costUsd: 0, durationMs: 1 } };
      },
    });
    await start(carousel.id, { topic: "calmer evenings, again" });
    expect((await read(carousel.id))!.confirmed?.direction).toEqual(edited);
    expect((await confirm(carousel.id, { revision: 1, direction: DIRECTION })).status).toBe(409);

    const copy = (await duplicateCarousel(carousel.id))!;
    expect(copy.research).toMatchObject({ state: "failed", failure: { code: "interrupted" }, confirmed: { revision: 1, direction: edited } });

    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    const second = await settledResearch(carousel.id);
    expect(second).toMatchObject({ revision: 2, state: "ready", confirmed: { revision: 1 } });
  });
});

describe("duplicating a carousel with research", () => {
  const confirmedOf = (revision: number) => ({
    revision, confirmedAt: "", topic: "calmer evenings", direction: DIRECTION, edited: false, sources: [], findings: [],
  });

  it("keeps the confirmed direction but not the original's design record", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    await updateCarouselResearch(carousel.id, () => ({
      revision: 1, topic: "calmer evenings", links: [], state: "ready", searchProvider: null, startedAt: "",
      confirmed: confirmedOf(1), lastDesign: { revision: 1, runId: "run-1", at: "" },
    }));
    const copy = (await duplicateCarousel(carousel.id))!;
    expect(copy.research).toMatchObject({ state: "ready", confirmed: { revision: 1, direction: DIRECTION } });
    // The copy has had no design run, so it never claims the original's.
    expect(copy.research).not.toHaveProperty("lastDesign");
    expect((await getCarousel(copy.id))!.research).not.toHaveProperty("lastDesign");
    expect((await getCarousel(carousel.id))!.research?.lastDesign).toMatchObject({ runId: "run-1" });
  });

  it("gives a copy no research at all when the original's run is still in progress and nothing was confirmed", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    await updateCarouselResearch(carousel.id, () => ({
      revision: 1, topic: "calmer evenings", links: [], state: "running", stage: "reading", searchProvider: null, startedAt: "",
    }));
    const copy = (await duplicateCarousel(carousel.id))!;
    expect(copy).not.toHaveProperty("research");
    expect(await getCarousel(copy.id)).not.toHaveProperty("research");
    expect((await getCarousel(carousel.id))!.research?.state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// The handoff.

describe("confirmed research in the plan and the design", () => {
  async function confirmedCarousel() {
    const carousel = await createCarousel("Evenings", "4:5");
    const result = synthesis.validateSynthesis(modelOutput(), PAGES)!;
    const sources = PAGES.map((p) => ({
      id: p.id, kind: "url" as const, url: p.url, host: p.host, title: p.title, retrievedAt: "", blob: "", reliability: "unverified" as const,
      retrievedBy: "source-retrieval" as const, origin: p.origin,
    }));
    await updateCarouselResearch(carousel.id, () => ({
      revision: 3, topic: "calmer evenings", links: [], state: "ready", searchProvider: "brave", startedAt: "",
      result: { ...result, sources, unreadable: [] },
      confirmed: { revision: 3, confirmedAt: "", topic: "calmer evenings", direction: DIRECTION, edited: false, sources, findings: result.findings },
    }));
    return (await getCarousel(carousel.id))!;
  }

  function request(carousel: Awaited<ReturnType<typeof confirmedCarousel>>, message = "Make it") {
    return { carousel, brand: { name: "", colors: { primary: "", secondary: "", accent: "", background: "", surface: "" }, fonts: { heading: "", body: "" }, customFonts: [], logoPath: null, styleKeywords: [], createdAt: "", updatedAt: "" }, stylePreset: null, message, sources: [], references: [], assets: [], capabilities: [] };
  }

  it("gives the Director and the Design Agent the direction and only the quoted findings", async () => {
    const carousel = await confirmedCarousel();
    const req = request(carousel);
    const input = buildDirectorInput(req, { references: new Map(), assets: new Map() });
    expect(input).toContain("Confirmed research");
    expect(input).toContain(DIRECTION.angle);
    expect(input).toContain("Morning light within an hour of waking");
    expect(input).not.toContain("Cold showers double productivity");

    const validated = validatePlan(typographyPlanFor(req as never), planContextFor(req as never));
    expect(validated.ok).toBe(true);
    if (!validated.ok || validated.plan.status !== "ready") return;
    const message = buildDesignMessage("Make it", {
      plan: validated.plan,
      assets: new Map(),
      references: [],
      sources: [],
      research: handoff.confirmedResearchOf(carousel.research),
    });
    expect(message).toContain("Confirmed research (revision 3)");
    expect(message).toContain(`- Angle: ${DIRECTION.angle}`);
    expect(message).toContain("F2: Caffeine stays in the body for hours. (sources: S2) [sensitive: state it carefully]");
    expect(message).toContain("S2: Coffee (b.example) https://b.example/coffee");
    expect(message).not.toContain("Cold showers");
    expect(message.match(/<untrusted-page-content>/g)).toHaveLength(1);

    // Without research, both are exactly what they were.
    const plain = { ...carousel, research: undefined };
    const plainReq = request(plain);
    expect(buildDirectorInput(plainReq, { references: new Map(), assets: new Map() })).not.toContain("Confirmed research");
    const without = buildDesignMessage("Make it", { plan: validated.plan, assets: new Map(), references: [], sources: [] });
    expect(buildDesignMessage("Make it", { plan: validated.plan, assets: new Map(), references: [], sources: [], research: null })).toBe(without);
    expect(without).not.toContain("Confirmed research");
  });
});
