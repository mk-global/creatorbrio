import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SourceOutcome } from "@/lib/source-retrieval";
import type { SynthesisRequest, SynthesisResult } from "@/lib/research/synthesis";
import type { CarouselResearch } from "@/types/research";

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

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-research-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  process.chdir(workdir);
  infoLog = [];
  const record = (...args: unknown[]) => void infoLog.push(JSON.stringify(args));
  vi.spyOn(console, "info").mockImplementation(record);
  vi.spyOn(console, "warn").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
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
    expect(search.configuredSearchProvider({})).toBeNull();
    expect(search.configuredSearchProvider({ [search.SEARCH_KEY_ENV]: "   " })).toBeNull();
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
    const provider = search.configuredSearchProvider({ [search.SEARCH_KEY_ENV]: KEY }, fake)!;
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
    const provider = search.configuredSearchProvider({ [search.SEARCH_KEY_ENV]: KEY }, fake)!;
    expect(await provider.search("topic", new AbortController().signal)).toEqual({ ok: false, code });
  });

  it("answers an unreachable service, a malformed reply and an unusable key without throwing", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await search.configuredSearchProvider({ [search.SEARCH_KEY_ENV]: KEY }, down)!.search("t", new AbortController().signal)).toEqual({
      ok: false,
      code: "search_unavailable",
    });
    const garbage = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await search.configuredSearchProvider({ [search.SEARCH_KEY_ENV]: KEY }, garbage)!.search("t", new AbortController().signal)).toEqual({
      ok: false,
      code: "search_unavailable",
    });
    const never = vi.fn();
    const provider = search.configuredSearchProvider({ [search.SEARCH_KEY_ENV]: "key with spaces" }, never as unknown as typeof fetch)!;
    expect(await provider.search("t", new AbortController().signal)).toEqual({ ok: false, code: "search_key_refused" });
    expect(never).not.toHaveBeenCalled();
  });

  it("keeps a query within Brave's limits", () => {
    expect(search.searchQuery("word ".repeat(80)).split(" ")).toHaveLength(50);
    expect(Array.from(search.searchQuery("x".repeat(900)))).toHaveLength(400);
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
    // Its working folder is removed afterwards.
    await expect(readFile(path.join(cwd, "anything"))).rejects.toThrow();
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

interface Script {
  searchUrls?: string[] | { code: "search_key_refused" | "search_rate_limited" | "search_unavailable" };
  pages?: Record<string, SourceOutcome | null>;
  synthesize?: (request: SynthesisRequest, signal: AbortSignal) => Promise<SynthesisResult>;
}

function script(s: Script) {
  const seen = { queries: [] as string[], links: [] as string[][], requests: [] as SynthesisRequest[] };
  run.researchDeps.searchProvider = () =>
    s.searchUrls === undefined
      ? null
      : {
          name: "brave",
          search: async (query) => {
            seen.queries.push(query);
            return Array.isArray(s.searchUrls) ? { ok: true, urls: s.searchUrls } : { ok: false, code: s.searchUrls!.code };
          },
        };
  run.researchDeps.retrieveLinks = async (links) => {
    seen.links.push(links);
    return links.map((url) => s.pages?.[url] ?? { url, host: new URL(url).hostname, ok: false, reason: "http_status" });
  };
  run.researchDeps.synthesize = async (request, { signal }) => {
    seen.requests.push(request);
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
    expect(research.result!.unreadable).toEqual([{ host: "b.example", origin: "search", reason: "http_status" }]);
    expect(research.result!.sources.map((s) => ({ id: s.id, kind: s.kind, reliability: s.reliability, retrievedBy: s.retrievedBy }))).toEqual(
      ["S1", "S2", "S3"].map((id) => ({ id, kind: "url", reliability: "unverified", retrievedBy: "source-retrieval" }))
    );
    expect(research.result!.sources[0].blob).toBe(synthesis.textHash(PAGE_B));
    expect(research.usage).toMatchObject({ costUsd: 0.05, searchRequests: 1, pagesRead: 3 });
    // Page text is never stored.
    const stored = await readFile(path.join(workdir, "data", "carousels.json"), "utf8");
    expect(stored).not.toContain("half-life of about five hours in healthy adults, so");
  });

  it("researches from the person's links alone without a search key, and refuses to start with neither", async () => {
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

  it("records no search failure when search worked", async () => {
    const carousel = await createCarousel("Evenings", "4:5");
    script({ searchUrls: ["https://a.example/sleep"], pages: { "https://a.example/sleep": page("https://a.example/sleep", PAGE_A) } });
    await start(carousel.id, { topic: "calmer evenings" });
    const research = await settledResearch(carousel.id);
    expect(research.state).toBe("ready");
    expect(research.result).not.toHaveProperty("searchFailure");
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
    expect((await start(carousel.id, { topic: "x" })).status).toBe(400);
    expect((await start(carousel.id, { topic: "ok topic", links: ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"] })).status).toBe(400);
    expect((await start(carousel.id, { topic: "ok topic", links: ["http://127.0.0.1/private"] })).status).toBe(400);
    expect((await start("missing", { topic: "ok topic" })).status).toBe(404);
    expect((await start(carousel.id, { topic: "ok topic" })).status).toBe(202);
    expect((await start(carousel.id, { topic: "ok topic" })).status).toBe(409);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    expect((await settledResearch(carousel.id)).state).toBe("ready");
  });

  it.each([
    ["search_key_refused", { searchUrls: { code: "search_key_refused" as const } }],
    ["search_rate_limited", { searchUrls: { code: "search_rate_limited" as const } }],
    ["search_unavailable", { searchUrls: { code: "search_unavailable" as const } }],
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
