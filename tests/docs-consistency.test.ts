import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { MAX_SLIDES } from "@/types/carousel";
import { DEFAULT_BRAND } from "@/types/brand";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { DIRECTOR_BUDGET_ENV, DIRECTOR_TIMEOUT_MS, DIRECTOR_TOOLS } from "@/lib/visual-director";
import {
  DEFAULT_DESIGN_AGENT_INACTIVITY_SECONDS,
  DEFAULT_DESIGN_AGENT_TIMEOUT_SECONDS,
  DESIGN_AGENT_BUDGET_ENV,
  DESIGN_AGENT_INACTIVITY_ENV,
  DESIGN_AGENT_TIMEOUT_ENV,
  MAX_DESIGN_AGENT_INACTIVITY_SECONDS,
  MAX_DESIGN_AGENT_TIMEOUT_SECONDS,
  MIN_DESIGN_AGENT_INACTIVITY_SECONDS,
  MIN_DESIGN_AGENT_TIMEOUT_SECONDS,
} from "@/lib/design-agent";
import type { Carousel } from "@/types/carousel";

// CLAUDE.md is read by the assistant working on this repository, so a stale
// number there is a wrong instruction, not a stale comment. These assertions
// pin the statements that previously drifted away from the code.
const repoRoot = path.resolve(__dirname, "..");
const claudeMd = readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf-8");
const readme = readFileSync(path.join(repoRoot, "README.md"), "utf-8");
// The Design Agent's CLI arguments, which the chat route uses.
const chatRoute = readFileSync(path.join(repoRoot, "src/lib/design-agent.ts"), "utf-8");
const startCommand = readFileSync(path.join(repoRoot, ".claude/commands/start.md"), "utf-8");
const layout = readFileSync(path.join(repoRoot, "src/app/layout.tsx"), "utf-8");

/** The tool names the chat route actually passes to the Claude CLI. */
function allowedToolsInChatRoute(): string[] {
  const tools: string[] = [];
  const pattern = /"--allowedTools",\s*\n\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(chatRoute)) !== null) tools.push(match[1]);
  return tools;
}

describe("CLAUDE.md matches the product", () => {
  it("states the slide limit the code enforces", () => {
    const stated = claudeMd.match(/Max (\d+) slides per carousel/);
    expect(stated, "CLAUDE.md should state a slide limit").not.toBeNull();
    expect(Number(stated![1])).toBe(MAX_SLIDES);
  });

  it("lists every tool the chat route grants the subprocess", () => {
    const granted = allowedToolsInChatRoute();
    expect(granted.length).toBeGreaterThan(0);

    const stated = claudeMd.match(/--allowedTools ([A-Za-z ]+)`/);
    expect(stated, "CLAUDE.md should list the allowed tools").not.toBeNull();
    expect(stated![1].trim().split(/\s+/)).toEqual(granted);
  });

  it("does not claim the upload route accepts images only", () => {
    // The route also accepts WOFF2 and TTF, detected by magic bytes.
    const uploadLine = claudeMd
      .split("\n")
      .find((line) => line.includes("/api/upload"));
    expect(uploadLine).toBeDefined();
    expect(uploadLine).not.toMatch(/only/i);
    expect(uploadLine).toMatch(/WOFF2/i);
  });
});

describe("README matches the product", () => {
  it("lists the same granted tools as the chat route", () => {
    const stated = readme.match(/--allowedTools ([A-Za-z ]+)`/);
    expect(stated, "README should list the allowed tools").not.toBeNull();
    expect(stated![1].trim().split(/\s+/)).toEqual(allowedToolsInChatRoute());
  });
});

describe("the Visual Director's architecture page matches the code", () => {
  const page = readFileSync(path.join(repoRoot, "docs/architecture/visual-director.md"), "utf-8");

  it("states the Director's tools, which stay distinct from the Design Agent's", () => {
    const stated = page.match(/^Director tools: (.+)$/m);
    expect(stated, "visual-director.md should state the Director's tools").not.toBeNull();
    expect(stated![1].split(",").map((t) => t.trim().replace(/`/g, ""))).toEqual([...DIRECTOR_TOOLS]);
    expect(allowedToolsInChatRoute()).not.toEqual([...DIRECTOR_TOOLS]);
  });

  it("states the Director's mandatory time limit and its optional spending cap", () => {
    expect(page).toContain(`a mandatory ${DIRECTOR_TIMEOUT_MS / 1000}-second timeout`);
    expect(page).toContain(`\`${DIRECTOR_BUDGET_ENV}\``);
    expect(readme, "README should list the Director's spending-cap setting").toContain(`\`${DIRECTOR_BUDGET_ENV}\``);
  });
});

describe("the Design Agent's limits are documented as the code sets them (#127)", () => {
  const workflow = readFileSync(path.join(repoRoot, "docs/architecture/creative-workflow.md"), "utf-8");

  it("states the optional cap and the default deadline, and no fixed dollar cap", () => {
    for (const doc of [readme, claudeMd, workflow]) {
      expect(doc).toContain(`\`${DESIGN_AGENT_BUDGET_ENV}\``);
      expect(doc).toContain(`\`${DESIGN_AGENT_TIMEOUT_ENV}\``);
      expect(doc).not.toMatch(/capped at USD 1\.00|\$1\.00 and 8 minutes/);
    }
    expect(DEFAULT_DESIGN_AGENT_TIMEOUT_SECONDS).toBe(1800);
    expect(readme).toContain(`${DEFAULT_DESIGN_AGENT_TIMEOUT_SECONDS / 60}-minute time limit`);
    expect(readme).toContain(`${MIN_DESIGN_AGENT_TIMEOUT_SECONDS} to ${MAX_DESIGN_AGENT_TIMEOUT_SECONDS}`);
    expect(workflow).toContain(`${MIN_DESIGN_AGENT_TIMEOUT_SECONDS} to ${MAX_DESIGN_AGENT_TIMEOUT_SECONDS} seconds`);
    expect(claudeMd).toContain(`(default ${DEFAULT_DESIGN_AGENT_TIMEOUT_SECONDS})`);
    expect(chatRoute).not.toMatch(/"--max-budget-usd",\s*\n\s*"\d/);
  });

  it("states the inactivity limit, its default and its range (#187)", () => {
    for (const doc of [readme, claudeMd, workflow]) expect(doc).toContain(`\`${DESIGN_AGENT_INACTIVITY_ENV}\``);
    expect(DEFAULT_DESIGN_AGENT_INACTIVITY_SECONDS).toBe(300);
    expect(readme).toContain(`stopped after ${DEFAULT_DESIGN_AGENT_INACTIVITY_SECONDS / 60} minutes without output`);
    expect(readme).toContain(`${MIN_DESIGN_AGENT_INACTIVITY_SECONDS} to ${MAX_DESIGN_AGENT_INACTIVITY_SECONDS}`);
    expect(workflow).toContain(`${MIN_DESIGN_AGENT_INACTIVITY_SECONDS} to ${MAX_DESIGN_AGENT_INACTIVITY_SECONDS} seconds`);
    expect(claudeMd).toContain(`(default ${DEFAULT_DESIGN_AGENT_INACTIVITY_SECONDS})`);
  });
});

describe("the generated system prompt agrees with the docs", () => {
  it("reports the same slide limit the documentation states", () => {
    const carousel = {
      id: "abc",
      name: "T",
      aspectRatio: "4:5",
      slides: [
        { id: "s1", html: "", previousVersions: [], order: 0, notes: "hook" },
      ],
      referenceImages: [],
      chatSessionId: null,
      isTemplate: false,
      tags: [],
      createdAt: "",
      updatedAt: "",
    } as Carousel;

    const prompt = buildSystemPrompt({
      baseUrl: "http://localhost:3001",
      brand: DEFAULT_BRAND,
      carousel,
    });

    // The agent is given both the prompt and CLAUDE.md, so these two numbers
    // must not contradict each other.
    expect(prompt).toContain(`Slides: 1/${MAX_SLIDES}`);
    const stated = claudeMd.match(/Max (\d+) slides per carousel/);
    expect(Number(stated![1])).toBe(MAX_SLIDES);
  });
});

describe("/start recognizes a running instance", () => {
  // /start greps the served page to decide whether the port already runs this
  // app. An instance that has not reloaded since the rename still shows the
  // former name, and must not be offered for killing.
  const pattern = startCommand.match(/grep -qE "([^"]+)"/);
  const title = layout.match(/title: "([^"]+)"/);

  it("matches the page title the app serves", () => {
    expect(pattern, "start.md should grep the served page").not.toBeNull();
    expect(title, "layout.tsx should set a title").not.toBeNull();
    expect(new RegExp(pattern![1]).test(`<title>${title![1]}</title>`)).toBe(true);
  });

  it("still matches an instance showing the former name", () => {
    expect(new RegExp(pattern![1]).test("<title>Framewoven - AI Creative Studio</title>")).toBe(true);
  });
});
