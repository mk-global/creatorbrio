import { spawn } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getClaudePath } from "@/lib/claude-path";
import { cleanEnv } from "./server";

/**
 * The creative-outcome judge: one bounded, read-only Claude CLI call that
 * looks at exported slide PNGs. Its only tool is Read, scoped to a temporary
 * folder holding copies of the PNGs; no settings, MCP servers, memory or
 * session. It scores; it never changes a design and is never looped.
 */

export const JUDGE_BUDGET_USD = 0.6;
const JUDGE_TIMEOUT_MS = 6 * 60 * 1000;

export const OUTCOME_DIMENSIONS = [
  "centralMessageRecognizable",
  "constraintsRespected",
  "imagerySupportsSubject",
  "visualPrioritiesVisible",
  "brandCoherent",
  "criticalTextReadable",
] as const;
export type OutcomeDimension = (typeof OUTCOME_DIMENSIONS)[number];

export const OUTCOME_LABELS: Record<OutcomeDimension, string> = {
  centralMessageRecognizable: "Central message recognizable",
  constraintsRespected: "Explicit constraints respected",
  imagerySupportsSubject: "Imagery supports the subject",
  visualPrioritiesVisible: "Visual priorities visible",
  brandCoherent: "Brand coherent",
  criticalTextReadable: "Critical text readable",
};

export interface Score {
  score: number | null;
  evidence: string;
}
export type OutcomeScores = Record<OutcomeDimension, Score>;

export interface OutcomeVerdict {
  scores: OutcomeScores;
  flags: {
    textClippedOrOverflowing: { flag: boolean; evidence: string };
    brokenOrPlaceholderImage: { flag: boolean; evidence: string };
    factualErrorOrFabrication: { flag: boolean; evidence: string };
  };
  summary: string;
}

export interface PairwiseVerdict {
  preference: "A" | "B" | "tie";
  confidence: "low" | "medium" | "high";
  reasons: string[];
  setA: OutcomeScores;
  setB: OutcomeScores;
}

/**
 * `turns` is the CLI's turn count, the only evidence the judge opened the
 * slides. Returning the structured verdict takes a turn of its own (a
 * Director call with nothing to read reports 2), so fewer than 3 suggests no
 * slide was read; the summary marks such verdicts instead of trusting them.
 */
export const MIN_READ_TURNS = 3;

export type JudgeCall<T> =
  | { ok: true; verdict: T; costUsd: number | null; durationMs: number; turns: number | null }
  | { ok: false; error: string; costUsd: number | null; durationMs: number; turns: number | null };

/** What the judge is told about the request; never which arm made a set. */
export interface JudgeContext {
  scenarioId: string;
  message: string;
  aspectRatio: string;
  objective: string;
  audience: string;
  constraints: string[];
  brand: string;
  notes: string;
}

const scoreSchema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "evidence"],
  properties: {
    score: { type: ["integer", "null"], minimum: 1, maximum: 5 },
    evidence: { type: "string", description: "One sentence naming the slide(s) and what you saw." },
  },
};
const scoresSchema = {
  type: "object",
  additionalProperties: false,
  required: [...OUTCOME_DIMENSIONS],
  properties: Object.fromEntries(OUTCOME_DIMENSIONS.map((d) => [d, { ...scoreSchema, description: OUTCOME_LABELS[d] }])),
};
const flagSchema = {
  type: "object",
  additionalProperties: false,
  required: ["flag", "evidence"],
  properties: { flag: { type: "boolean" }, evidence: { type: "string" } },
};

export const OUTCOME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "flags", "summary"],
  properties: {
    scores: scoresSchema,
    flags: {
      type: "object",
      additionalProperties: false,
      required: ["textClippedOrOverflowing", "brokenOrPlaceholderImage", "factualErrorOrFabrication"],
      properties: {
        textClippedOrOverflowing: flagSchema,
        brokenOrPlaceholderImage: flagSchema,
        factualErrorOrFabrication: flagSchema,
      },
    },
    summary: { type: "string", description: "Main strength and main weakness, two sentences." },
  },
};

export const PAIRWISE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["preference", "confidence", "reasons", "setA", "setB"],
  properties: {
    preference: { type: "string", enum: ["A", "B", "tie"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reasons: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    setA: scoresSchema,
    setB: scoresSchema,
  },
};

const ANCHORS = `Score each dimension from 1 to 5:
- 5: an experienced creative director would not change anything material. Rare.
- 4: clearly good; minor issues only.
- 3: acceptable but with a visible weakness a reviewer would ask to fix.
- 2: a real problem that undermines the goal.
- 1: fails the dimension.
Use null only when a dimension does not apply: imagerySupportsSubject when the slides contain no photographs or illustrations at all (decorative shapes and icons are not imagery), constraintsRespected when the request states no constraint, criticalTextReadable never (every slide has text that matters).

Dimensions:
- centralMessageRecognizable: someone in the audience, swiping once, would come away with the central message.
- constraintsRespected: every explicit instruction in the request is followed (counts, format, "no photos", the user's own photo used, and so on).
- imagerySupportsSubject: images depict the subject and help the message instead of decorating it; a wrong, generic or distracting image scores low.
- visualPrioritiesVisible: the most important element on each slide dominates; hierarchy and reading order are clear.
- brandCoherent: colours, type and style are consistent across slides and with the brand described.
- criticalTextReadable: headlines and key text are legible at phone size: contrast, size, nothing clipped, overlapped or cut off.`;

function contextBlock(c: JudgeContext): string {
  return [
    `Scenario ${c.scenarioId}`,
    `The user's request, verbatim: ${c.message}`,
    `Format: ${c.aspectRatio} Instagram slides.`,
    `What the user is trying to achieve: ${c.objective}`,
    `Audience: ${c.audience}`,
    `Explicit constraints: ${c.constraints.length ? c.constraints.join("; ") : "none stated"}`,
    `Brand: ${c.brand}`,
    `Evaluator notes (guidance, not a checklist): ${c.notes}`,
  ].join("\n");
}

const OUTCOME_SYSTEM = `You are a strict creative reviewer of finished social-media slides made by an AI studio for a creator.
You judge only what is visible in the slide images. Read every slide image with the Read tool before scoring; do not score a slide you have not opened.
Fluent text and polish earn nothing on their own; judge whether the slides achieve what the user asked for, for the stated audience.
Flag factualErrorOrFabrication only for claims that are wrong or invented statistics, quotes or results.
Return your verdict through the StructuredOutput tool.

${ANCHORS}`;

const PAIRWISE_SYSTEM = `You are a strict creative reviewer comparing two finished sets of social-media slides, Set A and Set B, made for the same request by two different versions of an AI studio.
Neither set is known to be better, and the labels are assigned at random.
Read every slide image of both sets with the Read tool before deciding.
Decide which set better serves the stated objective, audience and explicit constraints. Prefer "tie" when the difference is not material. Do not prefer a set for having more slides, more images or more text.
Score both sets on the same dimensions, independently.
Return your verdict through the StructuredOutput tool.

${ANCHORS}`;

function args(system: string, schema: object, dir: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--system-prompt",
    system,
    "--tools",
    "Read",
    "--allowedTools",
    // The leading slash plus an absolute path is the CLI's absolute-path form.
    `Read(/${dir}/**)`,
    "--json-schema",
    JSON.stringify(schema),
    "--no-session-persistence",
    "--max-budget-usd",
    String(JUDGE_BUDGET_USD),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify({ autoMemoryEnabled: false }),
  ];
}

function runCli(argv: string[], cwd: string, input: string): Promise<{ stdout: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(getClaudePath(), argv, { cwd, stdio: ["pipe", "pipe", "ignore"], env: cleanEnv() });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, JUDGE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout: "", code: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, code, timedOut });
    });
    child.stdin.end(input);
  });
}

function validScores(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return OUTCOME_DIMENSIONS.every((d) => {
    const s = (value as Record<string, { score?: unknown }>)[d];
    return !!s && (s.score === null || (typeof s.score === "number" && s.score >= 1 && s.score <= 5));
  });
}

async function call<T>(
  system: string,
  schema: object,
  files: { from: string; as: string }[],
  prompt: (dir: string) => string,
  valid: (v: unknown) => v is T
): Promise<JudgeCall<T>> {
  const started = Date.now();
  // Outside the repository, so no project instructions are loaded.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "creatorbrio-acceptance-judge-")));
  try {
    for (const f of files) await copyFile(f.from, path.join(dir, f.as));
    const out = await runCli(args(system, schema, dir), dir, prompt(dir));
    const durationMs = Date.now() - started;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(out.stdout.trim());
    } catch {
      parsed = null;
    }
    const costUsd = typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : null;
    const turns = typeof parsed?.num_turns === "number" ? parsed.num_turns : null;
    const fail = (error: string) => ({ ok: false as const, error, costUsd, durationMs, turns });
    if (out.timedOut) return fail("timed out");
    if (!parsed) return fail(`no JSON result (exit ${out.code})`);
    if (parsed.subtype === "error_max_budget_usd") return fail("judge budget exceeded");
    if (parsed.is_error || out.code !== 0) return fail(`judge failed: ${String(parsed.subtype ?? out.code)}`);
    if (!valid(parsed.structured_output)) return fail("judge output did not match the schema");
    return { ok: true, verdict: parsed.structured_output, costUsd, durationMs, turns };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Scores one finished set of slides. Never throws for a judge failure. */
export function judgeOutcome(context: JudgeContext, pngs: string[]): Promise<JudgeCall<OutcomeVerdict>> {
  const files = pngs.map((from, i) => ({ from, as: `slide-${i + 1}.png` }));
  return call(
    OUTCOME_SYSTEM,
    OUTCOME_SCHEMA,
    files,
    (dir) =>
      [
        contextBlock(context),
        "",
        `The ${files.length} slide image(s), in order:`,
        ...files.map((f) => `- ${path.join(dir, f.as)}`),
      ].join("\n"),
    (v): v is OutcomeVerdict => !!v && typeof v === "object" && validScores((v as OutcomeVerdict).scores)
  );
}

export type Arm = "director" | "baseline";

/** Compares two finished sets blind; the arm-to-label mapping is random per call and returned. */
export async function judgePairwise(
  context: JudgeContext,
  sets: Record<Arm, string[]>
): Promise<{ mapping: { A: Arm; B: Arm }; winner: Arm | "tie" | null; result: JudgeCall<PairwiseVerdict> }> {
  const mapping: { A: Arm; B: Arm } = Math.random() < 0.5 ? { A: "director", B: "baseline" } : { A: "baseline", B: "director" };
  const filesA = sets[mapping.A].map((from, i) => ({ from, as: `A-slide-${i + 1}.png` }));
  const filesB = sets[mapping.B].map((from, i) => ({ from, as: `B-slide-${i + 1}.png` }));
  const result = await call(
    PAIRWISE_SYSTEM,
    PAIRWISE_SCHEMA,
    [...filesA, ...filesB],
    (dir) =>
      [
        contextBlock(context),
        "",
        `Set A, ${filesA.length} slide(s) in order:`,
        ...filesA.map((f) => `- ${path.join(dir, f.as)}`),
        "",
        `Set B, ${filesB.length} slide(s) in order:`,
        ...filesB.map((f) => `- ${path.join(dir, f.as)}`),
      ].join("\n"),
    (v): v is PairwiseVerdict =>
      !!v &&
      typeof v === "object" &&
      ["A", "B", "tie"].includes((v as PairwiseVerdict).preference) &&
      validScores((v as PairwiseVerdict).setA) &&
      validScores((v as PairwiseVerdict).setB)
  );
  const winner = result.ok ? (result.verdict.preference === "tie" ? "tie" : mapping[result.verdict.preference]) : null;
  return { mapping, winner, result };
}
