import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getClaudePath } from "@/lib/claude-path";

/**
 * The LLM judge of RUBRIC.md. It runs the real Claude CLI with no tools, no
 * settings, no MCP servers, no memory and no session, in an empty temporary
 * directory, and returns scores through a JSON schema. It never sees the
 * deterministic check results, so the two signals stay independent.
 */

export const DIMENSIONS = [
  "intent",
  "contentAccuracy",
  "audience",
  "treatment",
  "continuity",
  "assetRelevance",
  "generationRestraint",
  "handoff",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  intent: "Intent comprehension",
  contentAccuracy: "Content accuracy and central message",
  audience: "Audience alignment",
  treatment: "Visual-treatment judgment",
  continuity: "Context continuity",
  assetRelevance: "Asset relevance",
  generationRestraint: "Appropriate non-use of image generation",
  handoff: "Handoff quality",
};

export const JUDGE_BUDGET_USD = 0.15;
const JUDGE_TIMEOUT_MS = 180_000;

export interface DimensionScore {
  score: number | null;
  why: string;
}

export interface JudgeVerdict {
  scores: Record<Dimension, DimensionScore>;
  fabricatedClaims: { flag: boolean; evidence: string };
  ignoredConstraint: { flag: boolean; evidence: string };
  summary: string;
}

export type JudgeResult =
  | { ok: true; verdict: JudgeVerdict; costUsd: number | null; durationMs: number }
  | { ok: false; error: string; costUsd: number | null; durationMs: number };

const scoreSchema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "why"],
  properties: {
    score: { type: ["integer", "null"], minimum: 1, maximum: 5, description: "1 to 5, or null when the rubric says not applicable." },
    why: { type: "string", description: "One or two sentences citing the plan." },
  },
};

const flagSchema = {
  type: "object",
  additionalProperties: false,
  required: ["flag", "evidence"],
  properties: { flag: { type: "boolean" }, evidence: { type: "string", description: "Quote the plan text, or empty." } },
};

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "fabricatedClaims", "ignoredConstraint", "summary"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: [...DIMENSIONS],
      properties: Object.fromEntries(DIMENSIONS.map((d) => [d, { ...scoreSchema, description: DIMENSION_LABELS[d] }])),
    },
    fabricatedClaims: flagSchema,
    ignoredConstraint: flagSchema,
    summary: { type: "string", description: "The plan's main strength and main weakness, two sentences." },
  },
};

export function judgeInstructions(rubric: string): string {
  return `You are a strict evaluator of plans written by the Visual Director of CreatorBrio, a studio that turns a creator's request into branded social slides. The Visual Director does not design slides; it writes a strategy and a binding execution plan that a separate Design Agent follows.

Score the plan against the rubric below. Rules:
- Be strict and use the anchors literally. A score of 5 is rare and means an experienced creative director would not change anything material.
- Valid JSON, complete fields and fluent prose earn nothing on their own. Judge the decisions and whether they serve the user's request.
- Judge only what the plan says. Do not assume the Design Agent will fix gaps.
- Use null only where the rubric says a dimension is not applicable (continuity for new requests; asset relevance when there are no references and no images; for a source-required outcome everything except intent and handoff).
- Flag fabricatedClaims when the plan states statistics, research findings, performance or engagement predictions, or user preferences that are not in the user's message, the stored brief or the supplied page text.
- Flag ignoredConstraint when the plan ignores or contradicts an explicit instruction from the user or the stored brief that the current message did not replace.
- The scenario notes describe what a good plan looks like; use them as guidance, not as a checklist that must be matched word for word.
- Reference images are identified by ID in the plan; the scenario lists each ID with its file name and what it depicts.

Return your scores through the StructuredOutput tool.

<rubric>
${rubric}
</rubric>`;
}

export interface JudgeInput {
  scenarioId: string;
  message: string;
  setupSummary: string;
  whatGoodLooksLike: string;
  outcome: unknown;
}

export function judgePrompt(input: JudgeInput): string {
  return [
    `# Scenario ${input.scenarioId}`,
    "## Setup",
    input.setupSummary,
    "## The user's message",
    input.message,
    "## What a good plan looks like (evaluator notes)",
    input.whatGoodLooksLike,
    "## The Visual Director's output",
    JSON.stringify(input.outcome, null, 2),
  ].join("\n\n");
}

export function judgeArgs(rubric: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--system-prompt",
    judgeInstructions(rubric),
    "--tools",
    "",
    "--json-schema",
    JSON.stringify(JUDGE_SCHEMA),
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

function run(args: string[], cwd: string, input: string): Promise<{ stdout: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(getClaudePath(), args, { cwd, stdio: ["pipe", "pipe", "ignore"], env: process.env });
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

function isVerdict(value: unknown): value is JudgeVerdict {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const scores = v.scores as Record<string, unknown> | undefined;
  if (!scores || typeof scores !== "object") return false;
  return DIMENSIONS.every((d) => {
    const s = scores[d] as { score?: unknown } | undefined;
    return !!s && (s.score === null || (typeof s.score === "number" && s.score >= 1 && s.score <= 5));
  });
}

/** Scores one Director outcome. Never throws: a judge failure is a recorded result. */
export async function judge(rubric: string, input: JudgeInput): Promise<JudgeResult> {
  const started = Date.now();
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "creatorbrio-judge-")));
  try {
    const out = await run(judgeArgs(rubric), dir, judgePrompt(input));
    const durationMs = Date.now() - started;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(out.stdout.trim());
    } catch {
      parsed = null;
    }
    const costUsd = typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : null;
    if (out.timedOut) return { ok: false, error: "timed out", costUsd, durationMs };
    if (!parsed) return { ok: false, error: `no JSON result (exit ${out.code})`, costUsd, durationMs };
    if (parsed.subtype === "error_max_budget_usd") return { ok: false, error: "judge budget exceeded", costUsd, durationMs };
    if (parsed.is_error || out.code !== 0) return { ok: false, error: `judge failed: ${String(parsed.subtype ?? out.code)}`, costUsd, durationMs };
    if (!isVerdict(parsed.structured_output)) return { ok: false, error: "judge output did not match the schema", costUsd, durationMs };
    return { ok: true, verdict: parsed.structured_output, costUsd, durationMs };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
