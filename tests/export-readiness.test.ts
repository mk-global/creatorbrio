import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { BrandConfig } from "@/types/brand";
import { readZipEntries } from "./helpers/export-files";

// End to end through the real chat and export routes, real storage and a real
// subprocess. The Claude CLI is replaced by a small script that stays running
// until the test tells it to finish, standing in for the design agent while it
// is still writing slides. Only the Chromium renderer is replaced.
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
const { POST: exportCarousel } = await import(
  "@/app/api/carousels/[id]/export/route"
);
const { GET: generationStatus, DELETE: acceptSlides } = await import(
  "@/app/api/carousels/[id]/generation/route"
);
const { addSlide, createCarousel, getCarousel } = await import("@/lib/carousels");
const { isGenerating } = await import("@/lib/generation-status");
const { exportAllSlides } = await import("@/lib/export-slides");
const exportAllSlidesMock = vi.mocked(exportAllSlides);

const FAKE_CLAUDE = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = process.env.FAKE_CLAUDE_DIR;
writeFileSync(path.join(dir, "pid"), String(process.pid));
if (existsSync(path.join(dir, "ignore-sigterm"))) process.on("SIGTERM", () => {});
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session" }));
const finish = path.join(dir, "finish");
const timer = setInterval(() => {
  if (!existsSync(finish)) return;
  clearInterval(timer);
  const isError = existsSync(path.join(dir, "result-error"));
  console.log(JSON.stringify({ type: "result", session_id: "fake-session", result: "Done.", is_error: isError }));
  process.exit(Number(readFileSync(finish, "utf8")) || 0);
}, 20);
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

let workdir: string;
let originalCwd: string;
let fakeDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-export-readiness-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  await writeFile(path.join(workdir, "data", "brand.json"), JSON.stringify(BRAND));
  fakeDir = path.join(workdir, "fake-claude");
  await mkdir(fakeDir);
  claudePath = path.join(fakeDir, "claude.mjs");
  await writeFile(claudePath, FAKE_CLAUDE);
  await chmod(claudePath, 0o755);
  process.env.FAKE_CLAUDE_DIR = fakeDir;
  process.chdir(workdir);

  exportAllSlidesMock.mockReset();
  exportAllSlidesMock.mockImplementation(async (slides) =>
    Promise.all(
      slides.map(async (_, i) => ({
        name: `slide-${i + 1}.png`,
        buffer: await sharp({
          create: { width: 1080, height: 1350, channels: 3, background: { r: i * 40, g: 90, b: 160 } },
        })
          .png()
          .toBuffer(),
      }))
    )
  );
});

afterEach(async () => {
  // Never leave a stand-in CLI running, whatever the test did.
  await finishRun(0).catch(() => {});
  try {
    process.kill(Number(await readFile(path.join(fakeDir, "pid"), "utf8")), "SIGKILL");
  } catch {
    // Already exited, or never started.
  }
  process.chdir(originalCwd);
  delete process.env.FAKE_CLAUDE_DIR;
  await rm(workdir, { recursive: true, force: true });
});

async function finishRun(exitCode: number) {
  await writeFile(path.join(fakeDir, "finish"), String(exitCode));
}

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function startChat(carouselId: string) {
  return chat(
    new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost:3000" },
      body: JSON.stringify({ message: "Make a two-slide carousel", carouselId }),
    }) as never
  );
}

function requestExport(id: string, format?: string) {
  const query = format ? `?format=${format}` : "";
  return exportCarousel(
    new Request(`http://localhost:3000/api/carousels/${id}/export${query}`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) }
  );
}

interface Status {
  generating: boolean;
  interrupted: { reason: string; endedAt: string } | null;
}

async function statusOf(id: string): Promise<Status> {
  const res = await generationStatus(
    new Request(`http://localhost:3000/api/carousels/${id}/generation`),
    { params: Promise.resolve({ id }) }
  );
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return (await res.json()) as Status;
}

/** The editor's "Use these slides". */
async function useSlidesAsTheyAre(id: string) {
  return acceptSlides(
    new Request(`http://localhost:3000/api/carousels/${id}/generation`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) }
  );
}

/** The design agent saving a slide mid-run, a moment after the run began. */
async function agentSavesSlide(id: string, html = "<div>Saved by the agent</div>") {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await addSlide(id, html);
}

async function fakeCliPid(): Promise<number> {
  await waitFor(() => existsSync(path.join(fakeDir, "pid")));
  return Number(await readFile(path.join(fakeDir, "pid"), "utf8"));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("export while the design agent is generating", () => {
  it("refuses every format mid-run, then exports the finished carousel", async () => {
    const carousel = await createCarousel("Readiness", "4:5");
    await addSlide(carousel.id, "<div>Hook</div>");

    const res = await startChat(carousel.id);
    expect(res.status).toBe(200);
    expect(isGenerating(carousel.id)).toBe(true);
    expect((await statusOf(carousel.id)).generating).toBe(true);

    // The agent has saved one of the slides it is going to write.
    for (const format of [undefined, "png", "pdf", "single-png"]) {
      const premature = await requestExport(carousel.id, format);
      expect(premature.status).toBe(409);
      expect(((await premature.json()) as { error: string }).error).toMatch(
        /still being generated/
      );
    }
    expect(exportAllSlidesMock).not.toHaveBeenCalled();

    // The agent writes its last slide and exits normally.
    await addSlide(carousel.id, "<div>Takeaway</div>");
    await finishRun(0);
    const streamed = await res.text();
    expect(streamed).toContain("event: done");

    expect(isGenerating(carousel.id)).toBe(false);
    expect(await statusOf(carousel.id)).toEqual({ generating: false, interrupted: null });

    const exported = await requestExport(carousel.id);
    expect(exported.status).toBe(200);
    const entries = readZipEntries(Buffer.from(await exported.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["slide-1.png", "slide-2.png"]);
    const saved = await getCarousel(carousel.id);
    expect(exportAllSlidesMock).toHaveBeenCalledWith(saved!.slides, "4:5");
  });

  it("holds back a failed run's partial slides until the user confirms them", async () => {
    const carousel = await createCarousel("Failed run", "1:1");
    await addSlide(carousel.id, "<div>Existing slide</div>");
    const res = await startChat(carousel.id);
    await agentSavesSlide(carousel.id, "<div>Saved before the failure</div>");
    expect((await requestExport(carousel.id)).status).toBe(409);

    await finishRun(1);
    const streamed = await res.text();
    // The failure reaches the user as a typed error; the exit code stays in the server log.
    expect(streamed).toContain('"type":"error","code":"agent_failed"');
    expect(streamed).not.toContain("exited with code");
    expect(streamed).toContain("event: done");

    const status = await statusOf(carousel.id);
    expect(status.generating).toBe(false);
    expect(status.interrupted).toMatchObject({ reason: "failed" });
    const refused = await requestExport(carousel.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /^The last generation failed before it finished, so these slides may be incomplete/
    );
    expect(exportAllSlidesMock).not.toHaveBeenCalled();
    // Nothing the run saved is lost.
    expect((await getCarousel(carousel.id))!.slides).toHaveLength(2);

    expect((await useSlidesAsTheyAre(carousel.id)).status).toBe(200);
    expect(await statusOf(carousel.id)).toEqual({ generating: false, interrupted: null });
    expect((await requestExport(carousel.id)).status).toBe(200);
  });

  it("holds back slides from a run stopped or reloaded mid-way, until a later run completes", async () => {
    const carousel = await createCarousel("Stopped run", "4:5");
    const first = await startChat(carousel.id);
    await fakeCliPid();
    await agentSavesSlide(carousel.id, "<div>1 of 5</div>");

    // Stop, a reload and a closed tab all reach the server as this.
    await first.body!.cancel();
    await waitFor(() => !isGenerating(carousel.id));
    expect((await statusOf(carousel.id)).interrupted).toMatchObject({ reason: "stopped" });
    expect((await requestExport(carousel.id, "single-png")).status).toBe(409);
    expect((await getCarousel(carousel.id))!.slides).toHaveLength(1);

    // "Continue" in the chat: the next run finishes the carousel.
    await rm(path.join(fakeDir, "pid"), { force: true });
    const second = await startChat(carousel.id);
    await fakeCliPid();
    await agentSavesSlide(carousel.id, "<div>2 of 5</div>");
    await finishRun(0);
    await second.text();

    expect(await statusOf(carousel.id)).toEqual({ generating: false, interrupted: null });
    expect((await requestExport(carousel.id)).status).toBe(200);
  });

  it("counts a clean exit whose result is an error as failed", async () => {
    const carousel = await createCarousel("Budget ran out", "4:5");
    await writeFile(path.join(fakeDir, "result-error"), "");
    const res = await startChat(carousel.id);
    await agentSavesSlide(carousel.id);
    await finishRun(0);
    await res.text();

    expect((await statusOf(carousel.id)).interrupted).toMatchObject({ reason: "failed" });
  });

  it("releases export after a cancelled chat only once the subprocess has exited", async () => {
    const carousel = await createCarousel("Cancelled run", "9:16");
    await addSlide(carousel.id, "<div>Cover</div>");
    const res = await startChat(carousel.id);
    const pid = await fakeCliPid();
    expect(isAlive(pid)).toBe(true);

    // What the browser does when the user presses Stop, reloads or leaves.
    await res.body!.cancel();

    await waitFor(() => !isGenerating(carousel.id));
    // Released on exit, never while the agent could still be writing.
    expect(isAlive(pid)).toBe(false);
    // Stopped before the agent saved anything: the carousel is as it was.
    expect((await statusOf(carousel.id)).interrupted).toBeNull();
    expect((await requestExport(carousel.id)).status).toBe(200);
  });

  it("kills a cancelled CLI that ignores the request to stop, then releases export", async () => {
    const carousel = await createCarousel("Stubborn run", "4:5");
    await addSlide(carousel.id, "<div>Cover</div>");
    await writeFile(path.join(fakeDir, "ignore-sigterm"), "");
    const res = await startChat(carousel.id);
    const pid = await fakeCliPid();

    await res.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Still alive after the termination request, so still generating.
    expect(isAlive(pid)).toBe(true);
    expect(isGenerating(carousel.id)).toBe(true);

    await waitFor(() => !isGenerating(carousel.id), 10_000);
    expect(isAlive(pid)).toBe(false);
    expect((await requestExport(carousel.id)).status).toBe(200);
  }, 15_000);

  it("never leaves a carousel generating when the CLI cannot be started", async () => {
    const carousel = await createCarousel("No CLI", "4:5");
    await addSlide(carousel.id, "<div>Only slide</div>");
    claudePath = path.join(fakeDir, "missing-claude");

    const res = await startChat(carousel.id);
    await res.text();

    await waitFor(() => !isGenerating(carousel.id));
    expect((await requestExport(carousel.id, "single-png")).status).toBe(200);
  });

  it("only blocks the carousel being generated", async () => {
    const busy = await createCarousel("Busy", "4:5");
    const idle = await createCarousel("Idle", "4:5");
    await addSlide(idle.id, "<div>Ready</div>");

    const res = await startChat(busy.id);
    expect((await statusOf(busy.id)).generating).toBe(true);
    expect((await statusOf(idle.id)).generating).toBe(false);
    expect((await requestExport(idle.id)).status).toBe(200);

    await finishRun(0);
    await res.text();
  });
});
