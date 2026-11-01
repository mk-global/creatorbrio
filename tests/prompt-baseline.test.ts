import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { PROMPT_BASELINE_CASES } from "./fixtures/prompt-baseline/cases";

/**
 * The Design Agent's system prompt is pinned to its pre-#28 form. Each fixture
 * is the output of `buildSystemPrompt` at afbeefe for the same input, with
 * exactly one documented substitution: the product name.
 *
 *   "design engine for Framewoven." -> "design engine for CreatorBrio."
 *
 * Any other change to the prompt needs founder authorization and is added
 * here as another documented substitution; the fixtures are never regenerated
 * from the current code.
 */
const fixtureDir = path.join(__dirname, "fixtures", "prompt-baseline");

describe("Design Agent system prompt baseline", () => {
  it("covers exactly the five committed cases", () => {
    expect(Object.keys(PROMPT_BASELINE_CASES)).toHaveLength(5);
  });

  it.each(Object.entries(PROMPT_BASELINE_CASES))(
    "case %s matches its afbeefe fixture byte for byte",
    (name, context) => {
      const fixture = readFileSync(path.join(fixtureDir, `${name}.txt`), "utf8");
      expect(buildSystemPrompt(context)).toBe(fixture);
    }
  );

  it("offers the agent no image generation", () => {
    for (const context of Object.values(PROMPT_BASELINE_CASES)) {
      const prompt = buildSystemPrompt(context);
      expect(prompt).not.toContain("/api/images");
      expect(prompt).not.toMatch(/generate an image/i);
    }
  });
});
