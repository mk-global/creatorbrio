import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Slide } from "@/types/carousel";
import { appBrowser, inCi } from "./helpers/app-browser";

// #198: the real export browser can stay connected while it stops completing
// captures. Freezing the browser's GPU process, which produces the frames a
// screenshot waits for, reproduces that state: the browser answers the
// DevTools protocol but no capture finishes, in any context. These run in CI
// on the runner's Chrome; a missing browser, or no GPU process to freeze,
// fails the suite rather than skipping it.
const browser = appBrowser();

const slide = (text: string, background: string): Slide => ({
  id: text,
  html: `<div style="width:100%;height:100%;background:${background};font:120px Georgia,serif;padding:80px;box-sizing:border-box">${text}</div>`,
  previousVersions: [],
  order: 0,
  notes: "",
});

interface Proc {
  pid: number;
  ppid: number;
  args: string;
}

function processes(): Proc[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
}

/** This test process's own export browser and its GPU process, found by parentage only. */
function ownExportBrowser(): { browserPid: number; gpuPid: number } {
  const all = processes();
  // Children of this process that run the browser executable (the `ps` above is a child too).
  const roots = all.filter((p) => p.ppid === process.pid && p.args.includes(browser!) && !p.args.includes("--type="));
  expect(roots, "exactly one export browser launched by this test process").toHaveLength(1);
  const gpu = all.filter((p) => p.ppid === roots[0].pid && p.args.includes("--type=gpu-process"));
  expect(gpu, "the export browser has a GPU process to freeze").toHaveLength(1);
  return { browserPid: roots[0].pid, gpuPid: gpu[0].pid };
}

function alive(pid: number): boolean {
  const row = processes().find((p) => p.pid === pid);
  return row !== undefined && !/<defunct>/.test(row.args);
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
    exportBrowserLimits.pngSlideMs = 5_000;
    exportBrowserLimits.probeMs = 3_000;
    const slides = [slide("One", "#f7f3e9"), slide("Two", "#16a085")];

    const before = await exportAllSlides(slides, "4:5");
    const { browserPid, gpuPid } = ownExportBrowser();
    process.kill(gpuPid, "SIGSTOP");
    frozen = gpuPid;

    const started = Date.now();
    const outcomes = await Promise.all([
      exportAllSlides(slides, "4:5").then(() => null, (error: Error) => error.message),
      new Promise((resolve) => setTimeout(resolve, 1_000)).then(() =>
        exportAllSlides(slides, "1:1").then(() => null, (error: Error) => error.message)
      ),
    ]);
    const elapsed = Date.now() - started;

    const replaced = "The export browser stopped responding and was replaced. Try the export again.";
    expect(outcomes).toEqual([replaced, replaced]);
    // The deadline (5 s) and the health check (3 s), not the 180 s a capture used to wait.
    expect(elapsed).toBeLessThan(15_000);

    // The whole process group is gone, the frozen GPU process included.
    await expect.poll(() => alive(browserPid) || alive(gpuPid), { timeout: 10_000 }).toBe(false);
    frozen = null;

    const after = await exportAllSlides(slides, "4:5");
    expect(after.map((s) => Buffer.compare(s.buffer, before[after.indexOf(s)].buffer))).toEqual([0, 0]);
    expect(ownExportBrowser().browserPid).not.toBe(browserPid);
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
