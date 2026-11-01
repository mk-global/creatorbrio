import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acceptInterruptedSlides,
  beginGeneration,
  classifyRunExit,
  getInterruption,
  isGenerating,
  slideFingerprint,
} from "@/lib/generation-status";
import {
  addReferenceImage,
  addSlide,
  createCarousel,
  getCarousel,
  reorderSlides,
  updateCarousel,
  updateSlide,
} from "@/lib/carousels";
import { exportFormatsFor } from "@/lib/export-formats";

// Real storage in a throwaway working directory: the run outcome is persisted
// in data/generation-runs.json next to the carousels it describes.
let workdir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-generation-status-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  await writeFile(
    path.join(workdir, "data", "brand.json"),
    JSON.stringify({
      name: "Synthetic",
      colors: { primary: "#111111", secondary: "#222222", accent: "#e94560", background: "#ffffff", surface: "#f4f4f4" },
      fonts: { heading: "Inter", body: "Inter" },
      customFonts: [],
      logoPath: null,
      styleKeywords: [],
      createdAt: "",
      updatedAt: "",
    })
  );
  process.chdir(workdir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

/** Begins a run as the chat route does: reserve it, then wait for its baseline. */
async function begin(id: string) {
  const run = beginGeneration(id);
  if (!run) throw new Error("a run is already active");
  await run.ready;
  return run.end;
}

/** A carousel with one saved slide, and a run begun on it. */
async function startRun() {
  const carousel = await createCarousel("Run", "4:5");
  await addSlide(carousel.id, "<div>Hook</div>");
  return { id: carousel.id, finish: await begin(carousel.id) };
}

/** What a server restart leaves: no active run, only the persisted record. */
function simulateRestart(id: string) {
  const registry = (globalThis as Record<symbol, Map<string, unknown>>)[
    Symbol.for("framewoven.generation-status")
  ];
  registry.delete(id);
}

const runsFile = async () =>
  JSON.parse(await readFile(path.join(workdir, "data", "generation-runs.json"), "utf8"));

/** What the design agent does mid-run. Timestamps have millisecond resolution. */
async function agentWritesSlide(id: string) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await addSlide(id, "<div>Written by the agent</div>");
}

describe("how a run ended", () => {
  const exit = (over: Partial<Parameters<typeof classifyRunExit>[0]>) =>
    classifyRunExit({ cancelled: false, timedOut: false, code: 0, resultIsError: false, ...over });

  it("tells a completed run from a stopped, failed or timed-out one", () => {
    expect(exit({})).toBe("completed");
    expect(exit({ cancelled: true })).toBe("stopped");
    expect(exit({ cancelled: true, code: null })).toBe("stopped");
    expect(exit({ code: 1 })).toBe("failed");
    expect(exit({ code: null })).toBe("failed");
    // The CLI exited cleanly but its result was an error, e.g. the budget ran out.
    expect(exit({ resultIsError: true })).toBe("failed");
    expect(exit({ timedOut: true, code: null })).toBe("timed-out");
  });
});

describe("slide fingerprint", () => {
  const slide = (id: string, order: number, html: string, notes = "") => ({
    id, order, html, notes, previousVersions: [],
  });
  const base = { slides: [slide("a", 0, "<p>A</p>"), slide("b", 1, "<p>B</p>")] };

  it("changes when slide HTML is edited, a slide is added or removed, or the order changes", () => {
    const fp = slideFingerprint(base);
    expect(slideFingerprint({ slides: [slide("a", 0, "<p>A!</p>"), base.slides[1]] })).not.toBe(fp);
    expect(slideFingerprint({ slides: [...base.slides, slide("c", 2, "<p>C</p>")] })).not.toBe(fp);
    expect(slideFingerprint({ slides: [base.slides[0]] })).not.toBe(fp);
    expect(slideFingerprint({ slides: [slide("a", 1, "<p>A</p>"), slide("b", 0, "<p>B</p>")] })).not.toBe(fp);
  });

  it("ignores notes, version history and the order slides happen to be stored in", () => {
    const fp = slideFingerprint(base);
    expect(slideFingerprint({ slides: [slide("a", 0, "<p>A</p>", "note"), base.slides[1]] })).toBe(fp);
    expect(slideFingerprint({ slides: [{ ...base.slides[0], previousVersions: ["<p>old</p>"] }, base.slides[1]] })).toBe(fp);
    expect(slideFingerprint({ slides: [base.slides[1], base.slides[0]] })).toBe(fp);
  });

  it("is the same for a stored carousel whatever its other fields, and null for a missing one", async () => {
    const carousel = await createCarousel("Fingerprint", "4:5");
    const slideA = await addSlide(carousel.id, "<p>A</p>");
    const slideB = await addSlide(carousel.id, "<p>B</p>");
    const fp = slideFingerprint(await getCarousel(carousel.id));
    await updateCarousel(carousel.id, { name: "Renamed", caption: "c", hashtags: ["#x"] });
    expect(slideFingerprint(await getCarousel(carousel.id))).toBe(fp);
    await reorderSlides(carousel.id, [slideB!.id, slideA!.id]);
    expect(slideFingerprint(await getCarousel(carousel.id))).not.toBe(fp);
    expect(slideFingerprint(null)).toBeNull();
  });
});

describe("generation status", () => {
  it("is generating from the start of a run until its outcome is saved", async () => {
    const { id, finish } = await startRun();
    expect(isGenerating(id)).toBe(true);
    expect(await getInterruption(id)).toBeNull();
    await finish("completed");
    expect(isGenerating(id)).toBe(false);
    expect(await getInterruption(id)).toBeNull();
  });

  it("marks a carousel interrupted when a run that changed slides was stopped", async () => {
    for (const reason of ["stopped", "failed", "timed-out"] as const) {
      const { id, finish } = await startRun();
      await agentWritesSlide(id);
      await finish(reason);
      expect(await getInterruption(id)).toMatchObject({ reason });
    }
  });

  it("leaves a carousel alone when an interrupted run changed nothing", async () => {
    const { id, finish } = await startRun();
    await finish("stopped");
    expect(await getInterruption(id)).toBeNull();
  });

  it("keeps an earlier interruption through a run that changes nothing, even a completed one", async () => {
    const first = await startRun();
    await agentWritesSlide(first.id);
    await first.finish("failed");

    for (const outcome of ["completed", "stopped", "not-started"] as const) {
      const again = await begin(first.id);
      expect(await getInterruption(first.id)).toBeNull(); // generating
      await again(outcome);
      expect(await getInterruption(first.id)).toMatchObject({ reason: "failed" });
    }
  });

  it("clears an interruption when a later run completes after changing slides", async () => {
    const { id, finish } = await startRun();
    await agentWritesSlide(id);
    await finish("stopped");

    const resume = await begin(id);
    await agentWritesSlide(id);
    await resume("completed");
    expect(await getInterruption(id)).toBeNull();
  });

  it("reports a run cut off by a server restart as interrupted when it changed slides", async () => {
    const { id } = await startRun();
    await agentWritesSlide(id);
    simulateRestart(id);

    expect(isGenerating(id)).toBe(false);
    expect(await getInterruption(id)).toMatchObject({ reason: "server-stopped" });
    // Settled on first read, so the verdict no longer depends on later edits.
    expect((await runsFile()).runs[id].state).toBe("interrupted");
  });

  it("recovers a run cut off by a restart that changed no slide, keeping any earlier interruption", async () => {
    const clean = await startRun();
    simulateRestart(clean.id);
    expect(await getInterruption(clean.id)).toBeNull();
    expect((await runsFile()).runs[clean.id]).toBeUndefined();
    // A slide edited by hand afterwards does not reopen the verdict.
    const [slide] = (await getCarousel(clean.id))!.slides;
    await updateSlide(clean.id, slide.id, { html: "<div>Edited by the user</div>" });
    expect(await getInterruption(clean.id)).toBeNull();

    const earlier = await startRun();
    await agentWritesSlide(earlier.id);
    await earlier.finish("failed");
    await begin(earlier.id);
    simulateRestart(earlier.id);
    expect(await getInterruption(earlier.id)).toMatchObject({ reason: "failed" });
  });

  it("settles a restart-abandoned run against the next run's baseline when that run begins first", async () => {
    const { id } = await startRun();
    simulateRestart(id);
    const next = await begin(id);
    await next("stopped");
    expect(await getInterruption(id)).toBeNull();
  });

  it("treats a running record from before fingerprints as interrupted, as before", async () => {
    const carousel = await createCarousel("Legacy", "4:5");
    await writeFile(
      path.join(workdir, "data", "generation-runs.json"),
      JSON.stringify({
        runs: {
          [carousel.id]: { state: "running", startedAt: "2026-10-01T00:00:00.000Z", baseline: carousel.updatedAt, previous: null },
        },
      })
    );
    expect(await getInterruption(carousel.id)).toEqual({ reason: "server-stopped", endedAt: "2026-10-01T00:00:00.000Z" });
  });

  it("allows one active run per carousel and refuses a second until it ends", async () => {
    const { id, finish } = await startRun();
    expect(beginGeneration(id)).toBeNull();
    const other = await createCarousel("Other", "4:5");
    const otherRun = beginGeneration(other.id);
    expect(otherRun).not.toBeNull();

    await finish("completed");
    await finish("stopped"); // ending the same run again is ignored
    expect(isGenerating(id)).toBe(false);
    expect(await getInterruption(id)).toBeNull();
    const again = beginGeneration(id);
    expect(again).not.toBeNull();
    await again!.end("completed");
    await otherRun!.end("completed");
  });

  it("never counts a run that changed only references, notes, caption, hashtags or name", async () => {
    for (const reason of ["stopped", "failed", "timed-out"] as const) {
      const { id, finish } = await startRun();
      const [slide] = (await getCarousel(id))!.slides;
      await addReferenceImage(id, {
        id: "ref-1",
        url: "/uploads/11111111-2222-4333-8444-555555555555.png",
        absPath: "/srv/uploads/11111111-2222-4333-8444-555555555555.png",
        name: "mood",
        addedAt: "2026-10-01T00:00:00.000Z",
      });
      await updateSlide(id, slide.id, { notes: "Hook, tightened" });
      await updateCarousel(id, { caption: "New caption", hashtags: ["#calm"], name: "Renamed" });
      await finish(reason);
      expect(await getInterruption(id)).toBeNull();
    }
  });

  it("never lets a blocked run create an interruption, and keeps an earlier one", async () => {
    const { id, finish } = await startRun();
    await agentWritesSlide(id);
    await finish("blocked");
    expect(await getInterruption(id)).toBeNull();

    const failed = await begin(id);
    await agentWritesSlide(id);
    await failed("failed");
    const blocked = await begin(id);
    await blocked("blocked");
    expect(await getInterruption(id)).toMatchObject({ reason: "failed" });
  });

  it("lets the user accept an interrupted carousel's slides, but not mid-run", async () => {
    const { id, finish } = await startRun();
    await agentWritesSlide(id);
    expect(await acceptInterruptedSlides(id)).toBe(false);
    await finish("failed");
    expect(await getInterruption(id)).not.toBeNull();

    expect(await acceptInterruptedSlides(id)).toBe(true);
    expect(await getInterruption(id)).toBeNull();
  });

  it("is shared by every copy of the module, as separately bundled routes load it", async () => {
    const { id, finish } = await startRun();
    vi.resetModules();
    const fresh = await import("@/lib/generation-status");
    expect(fresh.isGenerating(id)).toBe(true);
    await finish("completed");
    expect(fresh.isGenerating(id)).toBe(false);
  });
});

describe("export menu choices", () => {
  const formats = (count: number) => exportFormatsFor(count).map((o) => o.format);

  it("offers the single PNG only for a one-slide carousel", () => {
    expect(formats(1)).toEqual(["png", "pdf", "single-png"]);
    expect(formats(2)).toEqual(["png", "pdf"]);
    expect(formats(20)).toEqual(["png", "pdf"]);
    expect(formats(0)).toEqual(["png", "pdf"]);
  });
});
