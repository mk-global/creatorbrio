import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stubDirector } from "./helpers/stub-director";

// These tests cover the Design Agent run; the Visual Director is stubbed with an image-free plan.
let director: ReturnType<typeof stubDirector>;

// The Claude CLI is replaced by a stub that records its arguments and exits at
// once, so the real chat route runs end to end without spawning anything.
const spawned: string[][] = [];

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      spawned.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { end: () => {} },
        kill: () => {},
      });
      setImmediate(() => child.emit("exit", 0));
      return child;
    },
  };
});

vi.mock("@/lib/claude-path", () => ({
  isClaudeAvailable: () => true,
  getClaudePath: () => "/usr/local/bin/claude",
}));

import { POST as chat } from "@/app/api/chat/route";
import { createBrand, listBrands } from "@/lib/brand";
import { createCarousel } from "@/lib/carousels";
import type { BrandConfig } from "@/types/brand";

let workdir: string;
let originalCwd: string;

const ORIGINAL_BRAND: BrandConfig = {
  name: "Studio Aurora",
  colors: { primary: "#2b1d3a", secondary: "#5c3d7a", accent: "#f2a65a", background: "#fffaf3", surface: "#f4ece1" },
  fonts: { heading: "Playfair Display", body: "Inter" },
  customFonts: [],
  logoPath: null,
  styleKeywords: ["elegant"],
  createdAt: "2026-10-27T10:09:27.957Z",
  updatedAt: "2026-10-27T10:09:27.957Z",
};

beforeEach(async () => {
  director = stubDirector();
  spawned.length = 0;
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-chat-brand-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  process.chdir(workdir);
  await writeFile(path.join(workdir, "data", "brand.json"), JSON.stringify(ORIGINAL_BRAND, null, 2));
});

afterEach(async () => {
  director.restore();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

async function systemPromptFor(body: Record<string, unknown>): Promise<string> {
  const res = await chat(
    new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost:3000" },
      body: JSON.stringify({ message: "Make a carousel", ...body }),
    }) as never
  );
  expect(res.status).toBe(200);
  await res.text();
  const args = spawned.at(-1)!;
  return args[args.indexOf("--append-system-prompt") + 1];
}

describe("POST /api/chat brand context", () => {
  it("gives the design agent the carousel's own brand", async () => {
    const north = await createBrand({ name: "Northwind Labs", colors: { ...ORIGINAL_BRAND.colors, primary: "#0b3d91" } });
    const northCarousel = await createCarousel("North launch", "4:5", north.id);
    const auroraCarousel = await createCarousel("Aurora launch", "4:5");

    const northPrompt = await systemPromptFor({ carouselId: northCarousel.id });
    const auroraPrompt = await systemPromptFor({ carouselId: auroraCarousel.id });

    expect(northPrompt).toContain("Name: Northwind Labs");
    expect(northPrompt).toContain("#0b3d91");
    expect(northPrompt).not.toContain("Studio Aurora");
    expect(auroraPrompt).toContain("Name: Studio Aurora");
    expect(auroraPrompt).not.toContain("Northwind");
  });

  it("ignores any brand the client sends: only the carousel decides", async () => {
    const north = await createBrand({ name: "Northwind Labs" });
    const auroraCarousel = await createCarousel("Aurora launch", "4:5");

    const prompt = await systemPromptFor({ carouselId: auroraCarousel.id, brandId: north.id });

    expect(prompt).toContain("Name: Studio Aurora");
    expect(prompt).not.toContain("Northwind");
  });

  it("refuses to generate when a carousel's brand is missing instead of using another brand", async () => {
    const { defaultBrandId } = await listBrands();
    const carousel = await createCarousel("Orphan", "4:5", "brand-that-was-never-created");

    const res = await chat(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Make a carousel", carouselId: carousel.id }),
      }) as never
    );

    expect(res.status).toBe(409);
    expect(spawned).toHaveLength(0);
    expect(defaultBrandId).toBeTruthy();
  });
});
