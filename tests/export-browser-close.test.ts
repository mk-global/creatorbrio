import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Slide } from "@/types/carousel";
import { appBrowser, inCi } from "./helpers/app-browser";
import { censusAvailable, processesInside, profilesInside } from "./helpers/browser-census";

// #204: closeExportBrowser() shuts the real export browser down within its
// bound and leaves no process or profile behind, also when it interrupts an
// export, as the test setup does after a test that failed mid-export. In CI
// these use the runner's Chrome and must run: a missing browser fails.
const browser = appBrowser();

const slide = (n: number): Slide => ({
  id: `s${n}`,
  html: `<div style="width:100%;height:100%;background:#f7f3e9;color:#1a1a2e;font:96px Georgia,serif;padding:80px;box-sizing:border-box">Slide ${n}</div>`,
  previousVersions: [],
  order: n,
  notes: "",
});

// The run's browser folder exists only where the census runs (not on Windows).
describe.skipIf((!browser && !inCi) || !censusAvailable)("closing the real export browser (#204)", () => {
  let previousExecutable: string | undefined;
  let originalCwd: string;
  let work: string;
  let profiles: string;

  beforeAll(async () => {
    if (!browser) throw new Error("No Chromium or Chrome found: the export browser close tests must run in CI.");
    if (!process.env.PUPPETEER_TMP_DIR) throw new Error("The test run's browser folder is not set (tests/global-setup.ts).");
    profiles = process.env.PUPPETEER_TMP_DIR;
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = browser;
    originalCwd = process.cwd();
    work = await mkdtemp(path.join(tmpdir(), "creatorbrio-export-close-"));
    await mkdir(path.join(work, "public", "uploads"), { recursive: true });
    await mkdir(path.join(work, "data"), { recursive: true });
    process.chdir(work);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("closes an idle browser, leaving no process or profile, and the next export launches a new one", async () => {
    const { exportSlide, closeExportBrowser } = await import("@/lib/export-slides");
    await exportSlide(slide(1), "1:1");
    expect(processesInside(profiles).length).toBeGreaterThan(0);
    expect(profilesInside(profiles)).toHaveLength(1);

    const started = Date.now();
    await closeExportBrowser();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(processesInside(profiles)).toEqual([]);
    expect(profilesInside(profiles)).toEqual([]);

    await expect(exportSlide(slide(2), "1:1")).resolves.toBeInstanceOf(Buffer);
    await closeExportBrowser();
    expect(processesInside(profiles)).toEqual([]);
    expect(profilesInside(profiles)).toEqual([]);
  }, 60_000);

  it("closes a browser in the middle of an export, which fails, within its bound and leaving nothing behind", async () => {
    const { exportAllSlides, closeExportBrowser } = await import("@/lib/export-slides");
    let closing: Promise<void> | null = null;
    let requestedAt = 0;
    let closedAt = 0;
    const exported = exportAllSlides(
      Array.from({ length: 12 }, (_, i) => slide(i + 1)),
      "4:5",
      {
        onProgress: () => {
          // After the first slide, with the rest still to render.
          if (closing) return;
          requestedAt = Date.now();
          closing = closeExportBrowser().then(() => void (closedAt = Date.now()));
        },
      }
    );
    await expect(exported).rejects.toThrow();
    await closing;
    expect(closing).not.toBeNull();
    expect(closedAt - requestedAt).toBeLessThan(10_000);
    expect(processesInside(profiles)).toEqual([]);
    expect(profilesInside(profiles)).toEqual([]);
  }, 90_000);

  it("returns at once when no export browser was launched", async () => {
    const { closeExportBrowser } = await import("@/lib/export-slides");
    const started = Date.now();
    await closeExportBrowser();
    expect(Date.now() - started).toBeLessThan(100);
  });
});
