import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

import type { BrandConfig } from "@/types/brand";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import { createChatStreamParser } from "@/lib/chat-stream";
import { IMAGE_DIMENSIONS, ImageGenerationError, type ImageAspectRatio } from "@/lib/image-service";
import { EMPTY_BRIEF_UPDATE } from "@/lib/creative-brief";
import { HANDOFF_START } from "@/lib/creative-handoff";
import { stubDirector, typographyPlanFor } from "./helpers/stub-director";
import type { DirectorRequest } from "@/lib/visual-director";

// Through the real chat route, real storage and a real Design Agent
// subprocess. The Director, the image generator and page retrieval are
// scripted through the creative run's seam; the Design Agent is a script that
// reads the visual plan from its task message and saves slides the way a
// scenario says (conforming, or deviating), so conformance is checked against
// what a real subprocess wrote.
let claudePath = "";
vi.mock("@/lib/claude-path", () => ({
  isClaudeAvailable: () => true,
  getClaudePath: () => claudePath,
}));

const { POST: chat } = await import("@/app/api/chat/route");
const { addReferenceImage, appendCarouselAssets, createCarousel, getCarousel, setCreativeBrief } = await import("@/lib/carousels");
const { isGenerating, getInterruption, readCreativeRuns, slideFingerprint } = await import("@/lib/generation-status");
const { creativeRunDeps } = await import("@/lib/creative-run");
const { simulateRestartForTests } = await import("@/lib/assets");

const SESSION = "6c1f9a52-8d3e-4b7a-9f21-0e4d5c6b7a89";

const FAKE_DESIGN_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_CLAUDE_DIR;
const argv = process.argv.slice(2);
fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
fs.writeFileSync(path.join(dir, "argv.json"), JSON.stringify(argv));
const scenario = fs.readFileSync(path.join(dir, "scenario"), "utf8");
const task = argv[argv.indexOf("-p") + 1];
const emit = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
emit({ type: "system", subtype: "init", session_id: "${SESSION}" });
if (scenario === "hang") { process.on("SIGTERM", () => process.exit(143)); setInterval(() => {}, 1000); return; }

// Read the plan the way a designer would: the count, and each slide's images.
const count = Number((task.match(/Slides to produce: (\\d+)/) || [])[1] || 0);
const perSlide = {};
let current = 0;
for (const line of task.split("\\n")) {
  const head = line.match(/^Slide (\\d+):/);
  if (head) current = Number(head[1]);
  const img = line.match(/^  Place (?:this image|the uploaded image [^:]*): (\\/uploads\\/\\S+)/);
  if (img && current) (perSlide[current] = perSlide[current] || []).push(img[1]);
}
const styleRefs = [...task.matchAll(/\\((\\/uploads\\/[^)]+)\\): a style source only/g)].map((m) => m[1]);
const n = scenario === "wrong-count" ? count + 1 : count;
const slides = Array.from({ length: n }, (_, i) => {
  let urls = scenario === "omit-images" ? [] : (perSlide[i + 1] || []);
  if (scenario === "misplace" ) urls = perSlide[i + 2] || [];
  if (scenario === "place-style" && i === 0) urls = [...urls, ...styleRefs];
  return {
    id: "s" + (i + 1),
    html: "<h1>Slide " + (i + 1) + "</h1>" + urls.map((u) => '<img src="' + u + '">').join(""),
    previousVersions: [],
    order: i,
    notes: "",
  };
});
const file = path.join(process.cwd(), "data", "carousels.json");
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const carousel = data.carousels.find((c) => c.id === fs.readFileSync(path.join(dir, "carousel"), "utf8"));
carousel.slides = slides;
fs.writeFileSync(file, JSON.stringify(data));
emit({ type: "result", subtype: "success", is_error: false, result: "Designed " + n + " slides.", session_id: "${SESSION}" });
`;

const BRAND: BrandConfig = {
  name: "Northlight Studio",
  colors: { primary: "#14213d", secondary: "#fca311", accent: "#e94560", background: "#ffffff", surface: "#f4f4f4" },
  fonts: { heading: "Playfair Display", body: "Inter" },
  customFonts: [],
  logoPath: null,
  styleKeywords: [],
  createdAt: "",
  updatedAt: "",
};

let workdir: string;
let fakeDir: string;
let originalCwd: string;
let director: ReturnType<typeof stubDirector>;
const original = { ...creativeRunDeps };

/** The image requests the run made, and how each one answers. */
let imageCalls: { prompt: string; aspectRatio: ImageAspectRatio }[] = [];
let imageScript: ((call: number, signal?: AbortSignal) => Promise<"ok" | Error>) | null = null;

async function png(aspectRatio: ImageAspectRatio, seed = 1) {
  const { width, height } = IMAGE_DIMENSIONS[aspectRatio];
  return sharp({ create: { width, height, channels: 3, background: { r: (seed * 40) % 256, g: 80, b: 120 } } }).png().toBuffer();
}

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-creative-run-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  await mkdir(path.join(workdir, "public", "uploads"), { recursive: true });
  await writeFile(path.join(workdir, "data", "brand.json"), JSON.stringify(BRAND));
  fakeDir = path.join(workdir, "fake-claude");
  await mkdir(fakeDir);
  claudePath = path.join(fakeDir, "claude.cjs");
  await writeFile(claudePath, FAKE_DESIGN_AGENT);
  await chmod(claudePath, 0o755);
  process.env.FAKE_CLAUDE_DIR = fakeDir;
  process.chdir(workdir);
  simulateRestartForTests();

  imageCalls = [];
  imageScript = null;
  creativeRunDeps.generateImage = async (request, options) => {
    imageCalls.push({ prompt: request.prompt, aspectRatio: request.aspectRatio });
    const answer = imageScript ? await imageScript(imageCalls.length, options?.signal) : "ok";
    if (answer instanceof Error) throw answer;
    const bytes = await png(request.aspectRatio, imageCalls.length);
    return { png: bytes, ...IMAGE_DIMENSIONS[request.aspectRatio] };
  };
  creativeRunDeps.retrieveSources = async () => ({ status: "none" });
  director = stubDirector();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  director.restore();
  Object.assign(creativeRunDeps, original);
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

// ---------------------------------------------------------------------------
// Helpers.

async function newCarousel(aspectRatio: "1:1" | "4:5" | "9:16" = "4:5") {
  const carousel = await createCarousel("Creative", aspectRatio);
  await writeFile(path.join(fakeDir, "carousel"), carousel.id);
  return carousel;
}

async function addReference(carouselId: string, name: string) {
  const id = randomUUID();
  const url = `/uploads/${id}.png`;
  await writeFile(path.join(workdir, "public", "uploads", `${id}.png`), await png("1:1", name.length));
  await addReferenceImage(carouselId, { id, url, absPath: "/stale/path/never/used.png", name, addedAt: "" });
  return { id, url };
}

async function send(body: Record<string, unknown>, scenario = "conform", signal?: AbortSignal) {
  await writeFile(path.join(fakeDir, "scenario"), scenario);
  const res = await chat(
    new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost:3000" },
      body: JSON.stringify(body),
      signal,
    }) as never
  );
  if (res.status !== 200) return { status: res.status, events: [] as ChatStreamEvent[], raw: await res.text() };
  const raw = await res.text();
  const parser = createChatStreamParser();
  return { status: 200, events: [...parser.push(raw), ...parser.end()], raw };
}

const of = <T extends ChatStreamEvent["type"]>(events: ChatStreamEvent[], type: T) =>
  events.filter((e): e is Extract<ChatStreamEvent, { type: T }> => e.type === type);
const stages = (events: ChatStreamEvent[]) => of(events, "stage").map((e) => e.stage);
const designSpawned = async () => (await readdir(fakeDir)).includes("argv.json");
const taskMessage = async () => {
  const argv: string[] = JSON.parse(await readFile(path.join(fakeDir, "argv.json"), "utf8"));
  return argv[argv.indexOf("-p") + 1];
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const strategy = {
  objective: "Invite founders to reflect on complacency",
  audience: "Early-stage founders",
  intendedResponse: "Pause and recognise the pattern",
  centralMessage: "Comfort is the quiet risk",
  contentType: "founder story",
  priorities: ["The cover stops the scroll"],
  creativeDirection: "Quiet, high contrast, night.",
  treatmentStrategy: "One photograph carries the mood.",
  reasoning: [],
  successCriteria: ["The central message is readable"],
  assumptions: [],
};
const brief = {
  subject: "A lone founder at a desk late at night",
  composition: "Subject on the left third",
  framing: "Medium shot",
  lighting: "Single desk lamp",
  textSafeArea: "Upper half kept dark",
};

/** A plan with one generated image per listed slide, typography elsewhere. */
function imagePlan(request: DirectorRequest, imageSlides: number[], opts: { required?: boolean; aspectRatio?: ImageAspectRatio } = {}) {
  const base = typographyPlanFor(request);
  const keys = imageSlides.map((_, i) => `a${i + 1}`);
  return {
    ...base,
    strategy,
    execution: {
      ...base.execution,
      slides: base.execution.slides.map((s) => {
        const i = imageSlides.indexOf(s.index);
        return i === -1 ? s : { ...s, treatment: "generated", assetRefs: [keys[i]] };
      }),
      assets: imageSlides.map((slide, i) => ({
        key: keys[i],
        operation: "generate",
        required: opts.required ?? true,
        targetSlides: [slide],
        brief,
        aspectRatio: opts.aspectRatio ?? "4:5",
        ...(opts.required === false ? { ifUnavailable: "A bold typographic slide instead" } : {}),
      })),
    },
    briefUpdate: {
      ...EMPTY_BRIEF_UPDATE,
      fields: { centralMessage: { value: "Comfort is the quiet risk", source: "explicit" } },
      addConstraints: [{ text: "Serious tone", source: "explicit" }],
    },
  };
}

// ---------------------------------------------------------------------------

describe("a creative run through the chat route", () => {
  it("plans a typography-only request and makes no image call", async () => {
    const carousel = await newCarousel();
    const { events } = await send({ carouselId: carousel.id, message: "Make 3 slides about pricing" });

    expect(stages(events)).toEqual(["planning", "designing"]);
    expect(imageCalls).toEqual([]);
    expect(of(events, "deviations")).toEqual([]);
    expect((await getCarousel(carousel.id))?.slides).toHaveLength(3);
    expect((await readCreativeRuns())[carousel.id]).toMatchObject({ ended: { outcome: "completed" }, tasks: [] });
    expect(isGenerating(carousel.id)).toBe(false);
    expect(await getInterruption(carousel.id)).toBeNull();
  });

  it("makes a one-slide reel cover with one generated photograph and places it", async () => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1], { aspectRatio: "9:16" }));
    const carousel = await newCarousel("9:16");
    const { events } = await send({ carouselId: carousel.id, message: "Design a reel cover about complacency" });

    expect(stages(events)).toEqual(["planning", "preparing-images", "preparing-images", "designing"]);
    expect(imageCalls).toEqual([{ aspectRatio: "9:16", prompt: expect.stringContaining("A lone founder at a desk") }]);
    const after = await getCarousel(carousel.id);
    expect(after?.assets).toHaveLength(1);
    const asset = after!.assets![0];
    expect(asset).toMatchObject({ origin: "generated", width: 864, height: 1536 });
    expect(sha(await readFile(path.join(workdir, "public", "uploads", `${asset.id}.png`)))).toBe(asset.sha256);
    expect(after?.slides[0].html).toContain(asset.url);
    expect(of(events, "deviations")).toEqual([]);

    const task = await taskMessage();
    expect(task.startsWith("Design a reel cover about complacency\n\n" + HANDOFF_START)).toBe(true);
    expect(task).toContain(`Place this image: ${asset.url} (view it with Read at ${path.join(process.cwd(), "public", "uploads")}`);
    expect(task).toContain("Slides to produce: 1 (the user asked for a cover).");
    // The plan travels in the task message only, never in the system prompt.
    const argv: string[] = JSON.parse(await readFile(path.join(fakeDir, "argv.json"), "utf8"));
    const systemPrompt = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(systemPrompt).not.toContain(HANDOFF_START);
    expect(systemPrompt).not.toContain(asset.url);
  });

  it("makes five images for five slides and places each on its own slide", async () => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1, 2, 3, 4, 5]));
    const carousel = await newCarousel();
    const { events } = await send({ carouselId: carousel.id, message: "Make 5 slides, each with a photo of a founder's day" });

    expect(of(events, "stage").filter((e) => e.stage === "preparing-images").map((e) => e.detail)).toEqual([
      "0 of 5", "1 of 5", "2 of 5", "3 of 5", "4 of 5", "5 of 5",
    ]);
    const after = await getCarousel(carousel.id);
    expect(after?.assets).toHaveLength(5);
    const committed = (await readCreativeRuns())[carousel.id].tasks;
    for (const task of committed) {
      const slide = Number(task.key.slice(1));
      expect(after?.slides[slide - 1].html).toContain(`/uploads/${task.assetId}.png`);
    }
    expect(of(events, "deviations")).toEqual([]);
  });

  it("places a placement reference and keeps a style-only reference off every slide", async () => {
    const carousel = await newCarousel();
    const photo = await addReference(carousel.id, "founder-photo.png");
    const mood = await addReference(carousel.id, "brand-moodboard.png");
    director.restore();
    director = stubDirector((r) => {
      const base = typographyPlanFor(r);
      base.execution.slides = base.execution.slides.map((s) =>
        s.index === 1
          ? { ...s, treatment: "uploaded-placement", assetRefs: [photo.id], styleReferenceIds: [mood.id] }
          : { ...s, styleReferenceIds: [mood.id] }
      );
      return base;
    });
    const conforming = await send({ carouselId: carousel.id, message: "Make 2 slides introducing me" });
    const slides = (await getCarousel(carousel.id))!.slides;
    expect(slides[0].html).toContain(photo.url);
    expect(slides.some((s) => s.html.includes(mood.url))).toBe(false);
    expect(of(conforming.events, "deviations")).toEqual([]);
    const task = await taskMessage();
    expect(task).toContain(`"brand-moodboard.png" (${mood.url}): a style source only, on slide 1, 2; do not place it on any slide.`);
    expect(task).not.toContain("/stale/path/never/used.png");

    // The same plan, with a Design Agent that places the style reference anyway.
    const carousel2 = await newCarousel();
    const photo2 = await addReference(carousel2.id, "founder-photo.png");
    const mood2 = await addReference(carousel2.id, "brand-moodboard.png");
    director.restore();
    director = stubDirector((r) => {
      const base = typographyPlanFor(r);
      base.execution.slides[0] = { ...base.execution.slides[0], treatment: "uploaded-placement", assetRefs: [photo2.id], styleReferenceIds: [mood2.id] };
      return base;
    });
    const deviating = await send({ carouselId: carousel2.id, message: "Make 2 slides introducing me" }, "place-style");
    expect(of(deviating.events, "deviations")[0].items).toEqual([
      'The style reference "brand-moodboard.png" appears on slide 1 although it was meant as a style source only.',
    ]);
  });

  it("plans from a readable linked page and lists it in the handoff", async () => {
    creativeRunDeps.retrieveSources = async () => ({
      status: "retrieved",
      sources: [{ url: "https://example.com/post", host: "example.com", ok: true, title: "Post", text: "x".repeat(400), truncated: false }],
    });
    const carousel = await newCarousel();
    const { events } = await send({ carouselId: carousel.id, message: "Turn https://example.com/post into 3 slides" });
    expect(stages(events)).toEqual(["reading-sources", "planning", "designing"]);
    expect(director.requests[0].sources).toEqual([expect.objectContaining({ host: "example.com", text: "x".repeat(400) })]);
    expect(await taskMessage()).toContain("The plan was made from these linked pages:\n- https://example.com/post");
  });

  it("ends blocked before planning when a linked page cannot be read", async () => {
    creativeRunDeps.retrieveSources = async () => ({
      status: "retrieved",
      sources: [{ url: "https://example.com/app", host: "example.com", ok: false, reason: "too_little_text" }],
    });
    const carousel = await newCarousel();
    const { events } = await send({ carouselId: carousel.id, message: "Summarise https://example.com/app in 3 slides" });
    expect(of(events, "blocked")).toEqual([
      expect.objectContaining({ code: "source_unavailable", message: expect.stringMatching(/example\.com had too little readable text.*paste/), retryRunId: null }),
    ]);
    expect(director.requests).toHaveLength(0);
    expect(await designSpawned()).toBe(false);
    expect(isGenerating(carousel.id)).toBe(false);
  });

  it("ends blocked with the Director's message when the plan needs a source", async () => {
    director.restore();
    director = stubDirector(() => ({ status: "source-required", message: "Paste the post's text or share a public link." }));
    const carousel = await newCarousel();
    const { events } = await send({ carouselId: carousel.id, message: "Summarise my latest post" });
    expect(of(events, "blocked")[0]).toMatchObject({ code: "source_required", message: "Paste the post's text or share a public link." });
    expect(await designSpawned()).toBe(false);
  });

  it("ends blocked before planning when the message asks for more slides than allowed", async () => {
    const carousel = await newCarousel();
    const { events } = await send({ carouselId: carousel.id, message: "Make 25 slides about pricing" });
    expect(of(events, "blocked")[0]).toMatchObject({ code: "too_many_slides", message: expect.stringContaining("at most 20") });
    expect(director.requests).toHaveLength(0);
  });

  it("tells the user editing is not available when the plan needs it", async () => {
    const carousel = await newCarousel("9:16");
    const photo = await addReference(carousel.id, "founder-photo.png");
    director.restore();
    director = stubDirector((r) => {
      const base = typographyPlanFor(r);
      base.execution.slides[0] = { ...base.execution.slides[0], treatment: "edited", assetRefs: ["a1"] };
      return {
        ...base,
        execution: {
          ...base.execution,
          assets: [{ key: "a1", operation: "edit", required: true, targetSlides: [1], instruction: "New background", sourceIds: [photo.id], aspectRatio: "9:16" }],
        },
      };
    });
    const { events } = await send({ carouselId: carousel.id, message: "Use my photo on a reel cover with a new background" });
    expect(of(events, "blocked")[0]).toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("editing uploaded images is not available yet"),
    });
    expect(await designSpawned()).toBe(false);
  });

  // Found end to end: a reel cover blocked at the image stage left its brief on
  // an empty carousel, so "Make it more dramatic" reached the Director as a
  // revision of a cover that did not exist, and its plan was refused.
  it("changes no brief when a run ends before design, so the next message is planned as new", async () => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1], { aspectRatio: "9:16" }));
    imageScript = async () => new ImageGenerationError(503, "image_generation_refused", "The image service declined to start because the machine is busy with other AI work.");
    const carousel = await newCarousel("9:16");
    const first = await send({ carouselId: carousel.id, message: "Design a reel cover about complacency" });
    expect(of(first.events, "blocked")[0]).toMatchObject({ code: "image_failed" });
    expect((await getCarousel(carousel.id))?.creativeBrief).toBeUndefined();

    director.restore();
    director = stubDirector();
    await send({ carouselId: carousel.id, message: "Make it more dramatic" });
    expect(director.requests[0].carousel.creativeBrief).toBeUndefined();
  });
});

describe("required images and the export gate", () => {
  it("ends blocked when the image service refuses a required image, changing no slide and starting no design", async () => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1], { aspectRatio: "9:16" }));
    imageScript = async () =>
      new ImageGenerationError(503, "image_generation_refused", "The image service declined to start because the machine is busy with other AI work.", { reason: "memory" });
    const carousel = await newCarousel("9:16");
    const before = slideFingerprint(await getCarousel(carousel.id));
    const { events } = await send({ carouselId: carousel.id, message: "Design a reel cover about complacency" });

    const blocked = of(events, "blocked")[0];
    expect(blocked).toMatchObject({ code: "image_failed", retryRunId: expect.any(String) });
    expect(blocked.message).toMatch(/slide 1 could not be made\. The image service declined to start because the machine is busy with other AI work\. Try again later\./);
    expect(slideFingerprint(await getCarousel(carousel.id))).toBe(before);
    expect((await getCarousel(carousel.id))?.assets ?? []).toEqual([]);
    expect(await designSpawned()).toBe(false);
    expect(await getInterruption(carousel.id)).toBeNull();
    expect(events.at(-1)).toEqual({ type: "done", sessionId: null });
  });

  it("stops the stage at a service-wide failure instead of trying every image", async () => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1, 2, 3]));
    imageScript = async () => new ImageGenerationError(503, "image_service_unavailable", "The local image service is not running.");
    const carousel = await newCarousel();
    await send({ carouselId: carousel.id, message: "Make 3 slides with photos" });
    expect(imageCalls).toHaveLength(1);
  });

  it("continues past an optional failure with the plan's alternative and reports it", async () => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1], { required: false }));
    imageScript = async () => new ImageGenerationError(502, "image_generation_failed", "The image service did not return a usable image.");
    const carousel = await newCarousel();
    const { events } = await send({ carouselId: carousel.id, message: "Make 2 slides" });
    expect(await taskMessage()).toContain("Its image could not be made. Instead: A bold typographic slide instead");
    expect(of(events, "deviations")[0].items).toContain(
      "An optional image for slide 1 could not be made; the plan's alternative was used."
    );
    expect((await readCreativeRuns())[carousel.id].ended?.outcome).toBe("completed");
  });
});

describe("conformance after design", () => {
  beforeEach(() => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [2]));
  });

  it.each([
    ["wrong-count", ["The plan called for 3 slides; the carousel has 4."]],
    ["omit-images", ["Slide 2 does not show the planned image."]],
    ["misplace", ["Slide 2 does not show the planned image."]],
  ])("reports a %s design, completes the run and leaves export open", async (scenario, expected) => {
    const carousel = await newCarousel();
    const { events } = await send({ carouselId: carousel.id, message: "Make 3 slides about focus" }, scenario);
    expect(of(events, "deviations")).toEqual([{ type: "deviations", items: expected }]);
    expect((await readCreativeRuns())[carousel.id]).toMatchObject({ ended: { outcome: "completed" }, deviations: expected });
    expect(await getInterruption(carousel.id)).toBeNull();
    expect(console.info).toHaveBeenCalledWith("[chat] plan_deviation", expect.objectContaining({ carouselId: carousel.id }));
  });
});

describe("revisions", () => {
  it("resumes the Design Agent's session and reuses a committed asset without generating", async () => {
    const carousel = await newCarousel();
    const assetId = randomUUID();
    const bytes = await png("4:5", 9);
    await writeFile(path.join(workdir, "public", "uploads", `${assetId}.png`), bytes);
    await appendCarouselAssets(carousel.id, [
      { id: assetId, url: `/uploads/${assetId}.png`, origin: "generated", sourceIds: [], width: 1024, height: 1280, sha256: sha(bytes), runId: randomUUID(), createdAt: "" },
    ]);
    await send({ carouselId: carousel.id, message: "Make 2 slides about focus" });
    director.restore();
    director = stubDirector((r) => {
      const base = typographyPlanFor(r);
      base.execution.slides[0] = { ...base.execution.slides[0], treatment: "generated", assetRefs: ["a1"] };
      return { ...base, execution: { ...base.execution, assets: [{ key: "a1", operation: "reuse", required: true, targetSlides: [1], assetId }] } };
    });
    const { events } = await send({ carouselId: carousel.id, sessionId: SESSION, message: "Make it more dramatic" });

    const argv: string[] = JSON.parse(await readFile(path.join(fakeDir, "argv.json"), "utf8"));
    expect(argv[argv.indexOf("--resume") + 1]).toBe(SESSION);
    expect(imageCalls).toEqual([]);
    expect(director.requests[0].assets).toEqual([expect.objectContaining({ intact: true })]);
    expect((await getCarousel(carousel.id))?.slides[0].html).toContain(`/uploads/${assetId}.png`);
    expect(of(events, "deviations")).toEqual([]);
  });

  it("gives the Director the stored brief, and a revision's explicit change replaces the older value", async () => {
    const carousel = await newCarousel("9:16");
    await setCreativeBrief(carousel.id, {
      centralMessage: { value: "Comfort is the quiet risk", source: "explicit", at: "" },
      constraints: [{ text: "Serious tone", source: "explicit", at: "" }],
      visualDecisions: [],
      assetRelationships: [],
      updatedAt: "",
    });
    await send({ carouselId: carousel.id, message: "Design a reel cover" });
    director.restore();
    director = stubDirector((r) => ({
      ...typographyPlanFor(r),
      briefUpdate: {
        ...EMPTY_BRIEF_UPDATE,
        retireConstraints: [{ text: "Serious tone", because: "The user now wants it playful", source: "explicit" }],
        addConstraints: [{ text: "Playful tone", source: "explicit" }],
      },
    }));
    await send({ carouselId: carousel.id, sessionId: SESSION, message: "Make it playful instead" });
    expect(director.requests[0].carousel.creativeBrief?.constraints.map((c) => c.text)).toEqual(["Serious tone"]);
    const stored = (await getCarousel(carousel.id))?.creativeBrief;
    expect(stored?.constraints.map((c) => c.text)).toEqual(["Playful tone"]);
    expect(stored?.centralMessage?.value).toBe("Comfort is the quiet risk");
  });
});

describe("cancellation before design", () => {
  it.each([
    ["planning", "director"],
    ["preparing-images", "image"],
  ])("during %s attaches nothing, changes no slide and releases the carousel", async (_stage, where) => {
    const carousel = await newCarousel("9:16");
    const controller = new AbortController();
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1], { aspectRatio: "9:16" }));
    if (where === "director") {
      const planned = creativeRunDeps.runDirector;
      creativeRunDeps.runDirector = async (request, options) => {
        controller.abort();
        await new Promise((r) => setTimeout(r, 20));
        return options.signal?.aborted ? { ok: false, code: "cancelled", usage: { costUsd: 0, durationMs: 1, turns: 0, deniedReads: 0 } } : planned(request, options);
      };
    } else {
      imageScript = async () => {
        controller.abort();
        return new ImageGenerationError(499, "image_generation_cancelled", "Image generation was cancelled.");
      };
    }
    const before = slideFingerprint(await getCarousel(carousel.id));
    const res = await chat(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost:3000" },
        body: JSON.stringify({ carouselId: carousel.id, message: "Design a reel cover" }),
      }) as never
    );
    const reader = res.body!.getReader();
    controller.signal.addEventListener("abort", () => void reader.cancel());
    while (!(await reader.read().catch(() => ({ done: true }))).done) {
      // Drain until the client goes away.
    }
    await vi.waitFor(() => expect(isGenerating(carousel.id)).toBe(false), { timeout: 5000 });
    expect(await designSpawned()).toBe(false);
    expect((await getCarousel(carousel.id))?.assets ?? []).toEqual([]);
    expect(slideFingerprint(await getCarousel(carousel.id))).toBe(before);
    expect((await readCreativeRuns())[carousel.id].ended?.outcome).toBe("stopped");
    expect(await readdir(path.join(workdir, "public", "uploads"))).toEqual([]);
  });
});

describe("retry", () => {
  it("remakes only the two failed images of five and reuses the three staged ones", async () => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1, 2, 3, 4, 5]));
    imageScript = async (call) =>
      call === 2 || call === 4 ? new ImageGenerationError(502, "image_generation_failed", "The image service did not return a usable image.") : "ok";
    const carousel = await newCarousel();
    const message = "Make 5 slides, each with a photo of a founder's day";
    const first = await send({ carouselId: carousel.id, message });
    const blocked = of(first.events, "blocked")[0];
    expect(blocked).toMatchObject({ code: "image_failed", message: expect.stringContaining("2 images for slide 2; slide 4") });
    expect(imageCalls).toHaveLength(5);
    expect((await getCarousel(carousel.id))?.creativeBrief).toBeUndefined();

    imageCalls = [];
    imageScript = null;
    // The client's message is ignored: the stored plan runs with the stored message.
    const retry = await send({ carouselId: carousel.id, message: "something else entirely", retryRunId: blocked.retryRunId });
    expect(imageCalls).toHaveLength(2);
    expect(director.requests).toHaveLength(1);
    expect(stages(retry.events)[0]).toBe("preparing-images");
    expect((await getCarousel(carousel.id))?.assets).toHaveLength(5);
    expect((await taskMessage()).startsWith(message)).toBe(true);
    expect(of(retry.events, "deviations")).toEqual([]);
    // The retried run reached design, so the stored plan's brief update applies now.
    expect((await getCarousel(carousel.id))?.creativeBrief?.centralMessage).toMatchObject({ value: "Comfort is the quiet risk", source: "explicit" });
  });

  it("after a server restart during the image stage, regenerates none of the valid staged images", async () => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1, 2, 3]));
    // The third image never answers, and the server stops while it runs: the
    // request never resumes, and in-process state (the active-run registry and
    // the asset module's live runs) is lost.
    imageScript = async (call) => (call === 3 ? new Promise<Error>(() => {}) : "ok");
    const carousel = await newCarousel();
    void send({ carouselId: carousel.id, message: "Make 3 slides with photos" });
    await vi.waitFor(() => expect(imageCalls).toHaveLength(3));
    await vi.waitFor(async () => expect((await readCreativeRuns())[carousel.id].tasks.filter((t) => t.state === "staged")).toHaveLength(2));
    (globalThis as Record<symbol, Map<string, unknown> | undefined>)[Symbol.for("framewoven.generation-status")]?.clear();
    simulateRestartForTests();

    imageCalls = [];
    imageScript = null;
    const runId = (await readCreativeRuns())[carousel.id].runId;
    const retry = await send({ carouselId: carousel.id, message: "x", retryRunId: runId });
    // Recovery, run by the retry itself, ended the cut-off run blocked.
    expect(imageCalls).toHaveLength(1);
    expect(of(retry.events, "blocked")).toEqual([]);
    expect((await getCarousel(carousel.id))?.assets).toHaveLength(3);
  });

  it.each([
    ["not the carousel's most recent blocked run", async () => randomUUID()],
    ["not a run ID at all", async () => "../../etc"],
  ])("refuses a retry that is %s", async (_name, runId) => {
    const carousel = await newCarousel();
    const id = await runId();
    const result = await send({ carouselId: carousel.id, message: "x", retryRunId: id });
    if (result.status === 400) return expect(result.raw).toContain("Invalid retry");
    expect(of(result.events, "blocked")[0]).toMatchObject({ code: "retry_refused", retryRunId: null });
    expect(await designSpawned()).toBe(false);
  });

  it("refuses a retry past its 24-hour window", async () => {
    director.restore();
    director = stubDirector((r) => imagePlan(r, [1], { aspectRatio: "9:16" }));
    imageScript = async () => new ImageGenerationError(503, "image_service_unavailable", "The local image service is not running.");
    const carousel = await newCarousel("9:16");
    const first = await send({ carouselId: carousel.id, message: "Design a reel cover" });
    const runId = of(first.events, "blocked")[0].retryRunId;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    try {
      const retry = await send({ carouselId: carousel.id, message: "x", retryRunId: runId });
      expect(of(retry.events, "blocked")[0]).toMatchObject({ code: "retry_refused", message: expect.stringMatching(/expired/) });
    } finally {
      vi.useRealTimers();
    }
  });
});
