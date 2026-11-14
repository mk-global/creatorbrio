import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Slide } from "@/types/carousel";
import { appBrowser, inCi } from "./helpers/app-browser";
import { alive, ownExportBrowser } from "./helpers/export-browser-processes";

// #198: the real export browser can stay connected while it stops completing
// captures. Freezing the browser's GPU process, which produces the frames a
// screenshot waits for, reproduces that state: the browser answers the
// DevTools protocol but no capture finishes, in any context. Where Chrome runs
// no separate GPU process, the browser process itself is frozen instead. These
// run in CI on the runner's Chrome; a missing browser fails the suite rather
// than skipping it.
const browser = appBrowser();

const slide = (text: string, background: string): Slide => ({
  id: text,
  html: `<div style="width:100%;height:100%;background:${background};font:120px Georgia,serif;padding:80px;box-sizing:border-box">${text}</div>`,
  previousVersions: [],
  order: 0,
  notes: "",
});

/**
 * The process to freeze in this test process's export browser: its GPU
 * process, which produces the frames a capture waits for. Where Chrome has no
 * separate GPU process, the browser process itself is frozen, which leaves the
 * connection open while nothing completes.
 */
function freezeTarget(): { browserPid: number; freezePid: number } {
  const { browser: root, children } = ownExportBrowser(browser!);
  const gpu = children.filter((p) => p.type === "gpu-process");
  expect(gpu.length, "at most one GPU process").toBeLessThanOrEqual(1);
  console.info(`export browser ${root.pid}: freezing ${gpu.length ? "its GPU process" : "the browser process"}; children ${children.map((p) => p.type).join(", ")}`);
  return { browserPid: root.pid, freezePid: gpu[0]?.pid ?? root.pid };
}

describe.skipIf(!browser && !inCi)("export browser recovery in Chromium (#198)", () => {
  let previousExecutable: string | undefined;
  let originalCwd: string;
  let work: string;
  let frozen: number | null = null;

  beforeAll(async () => {
    if (!browser) throw new Error("No Chromium or Chrome found: the export recovery tests must run in CI.");
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = browser;
    originalCwd = process.cwd();
    work = await mkdtemp(path.join(tmpdir(), "creatorbrio-export-recovery-"));
    await mkdir(path.join(work, "public", "uploads"), { recursive: true });
    await mkdir(path.join(work, "data"), { recursive: true });
    process.chdir(work);
  });

  afterAll(async () => {
    // Never leave a stopped process behind, whatever happened above.
    if (frozen !== null && alive(frozen)) process.kill(frozen, "SIGKILL");
    process.chdir(originalCwd);
    if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("replaces a browser that stays connected but completes no capture, and the next export works", async () => {
    const { exportAllSlides, exportBrowserLimits } = await import("@/lib/export-slides");
    const slides = [slide("One", "#f7f3e9"), slide("Two", "#16a085")];

    // The cold launch and first export run under the default limits.
    const before = await exportAllSlides(slides, "4:5");
    const { browserPid, freezePid } = freezeTarget();
    process.kill(freezePid, "SIGSTOP");
    frozen = freezePid;

    // Short limits only while the browser is frozen, restored for everything after.
    const defaults = { ...exportBrowserLimits };
    exportBrowserLimits.pngSlideMs = 5_000;
    exportBrowserLimits.probeMs = 3_000;
    const started = Date.now();
    let outcomes: (string | null)[];
    try {
      outcomes = await Promise.all([
        exportAllSlides(slides, "4:5").then(() => null, (error: Error) => error.message),
        new Promise((resolve) => setTimeout(resolve, 1_000)).then(() =>
          exportAllSlides(slides, "1:1").then(() => null, (error: Error) => error.message)
        ),
      ]);
    } finally {
      Object.assign(exportBrowserLimits, defaults);
    }
    const elapsed = Date.now() - started;

    const replaced = "The export browser stopped responding and was replaced. Try the export again.";
    expect(outcomes).toEqual([replaced, replaced]);
    // The deadline (5 s) and the health check (3 s), not the 180 s a capture used to wait.
    expect(elapsed).toBeLessThan(15_000);

    // The whole process group is gone, the frozen process included.
    await expect.poll(() => alive(browserPid) || alive(freezePid), { timeout: 10_000 }).toBe(false);
    frozen = null;

    const after = await exportAllSlides(slides, "4:5");
    expect(after.map((s) => Buffer.compare(s.buffer, before[after.indexOf(s)].buffer))).toEqual([0, 0]);
    expect(ownExportBrowser(browser!).browser.pid).not.toBe(browserPid);
  }, 90_000);

  it("produces the same files for concurrent exports as for the same exports one after another", async () => {
    const { exportAllSlides, exportAllSlidePdfs } = await import("@/lib/export-slides");
    const a = [slide("Alpha", "#f7f3e9"), slide("Beta", "#e94560"), slide("Gamma", "#16a085"), slide("Delta", "#1a1a2e")];
    const b = [slide("Echo", "#fdf6e3"), slide("Foxtrot", "#268bd2")];

    const sequentialA = await exportAllSlides(a, "4:5");
    const sequentialB = await exportAllSlides(b, "1:1");
    const [concurrentA, concurrentB, pdfs] = await Promise.all([
      exportAllSlides(a, "4:5"),
      exportAllSlides(b, "1:1"),
      exportAllSlidePdfs(b, "1:1"),
    ]);

    expect(concurrentA.map((s, i) => Buffer.compare(s.buffer, sequentialA[i].buffer))).toEqual([0, 0, 0, 0]);
    expect(concurrentB.map((s, i) => Buffer.compare(s.buffer, sequentialB[i].buffer))).toEqual([0, 0]);
    expect(pdfs).toHaveLength(2);
  }, 90_000);
});
