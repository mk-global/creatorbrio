import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { MAX_SLIDES } from "@/types/carousel";
import { DEFAULT_BRAND } from "@/types/brand";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { DIRECTOR_BUDGET_USD, DIRECTOR_TIMEOUT_MS, DIRECTOR_TOOLS } from "@/lib/visual-director";
import type { Carousel } from "@/types/carousel";

// CLAUDE.md is read by the assistant working on this repository, so a stale
// number there is a wrong instruction, not a stale comment. These assertions
// pin the statements that previously drifted away from the code.
const repoRoot = path.resolve(__dirname, "..");
const claudeMd = readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf-8");
const readme = readFileSync(path.join(repoRoot, "README.md"), "utf-8");
const chatRoute = readFileSync(
  path.join(repoRoot, "src/app/api/chat/route.ts"),
  "utf-8"
);
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

  it("states the Director's budget and time limit", () => {
    expect(page).toContain(`$${DIRECTOR_BUDGET_USD.toFixed(2)} and ${DIRECTOR_TIMEOUT_MS / 1000} seconds`);
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
