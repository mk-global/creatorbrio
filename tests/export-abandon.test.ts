import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Slide } from "@/types/carousel";
import { appBrowser, inCi } from "./helpers/app-browser";
import { ownExportBrowser } from "./helpers/export-browser-processes";

// #203: an export whose request is abandoned stops in the real browser, and an
// export running next to it in the same browser finishes untouched. Synthetic
// slides only. In CI these use the runner's Chrome and must run: a missing
// browser fails.
const browser = appBrowser();

const slide = (n: number): Slide => ({
  id: `s${n}`,
  html: `<div style="width:100%;height:100%;background:linear-gradient(160deg,#f7f3e9,#e94560);color:#1a1a2e;font:96px Georgia,serif;padding:80px;box-sizing:border-box">Slide ${n}</div>`,
  previousVersions: [],
  order: n,
  notes: "",
});

describe.skipIf(!browser && !inCi)("abandoned exports in Chromium (#203)", () => {
  let previousExecutable: string | undefined;
  let originalCwd: string;
  let work: string;

  beforeAll(async () => {
    if (!browser) throw new Error("No Chromium or Chrome found: the abandoned export tests must run in CI.");
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = browser;
    originalCwd = process.cwd();
    work = await mkdtemp(path.join(tmpdir(), "creatorbrio-export-abandon-"));
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

  it("stops an abandoned export promptly, rendering none of its remaining slides, while another export in the same browser finishes unchanged", async () => {
    const { exportAllSlides } = await import("@/lib/export-slides");
    const kept = [1, 2, 3, 4].map(slide);
    // The kept export run alone, for comparison, which also launches the browser.
    const alone = await exportAllSlides(kept, "4:5");
    const before = ownExportBrowser(browser!).browser.pid;

    const controller = new AbortController();
    let abandonedRendered = 0;
    let abortedAt = 0;
    const abandoned = exportAllSlides(
      Array.from({ length: 18 }, (_, i) => slide(i + 1)),
      "4:5",
      {
        signal: controller.signal,
        onProgress: (current) => {
          abandonedRendered = current;
          if (!abortedAt) {
            abortedAt = Date.now();
            controller.abort();
          }
        },
      }
    ).then(
      () => "finished",
      (error: Error) => error.name
    );
    const together = exportAllSlides(kept, "4:5");

    expect(await abandoned).toBe("ExportAbandonedError");
    const stoppedAfter = Date.now() - abortedAt;
    const renderedWhenStopped = abandonedRendered;
    const done = await together;

    // Stopped at once, without finishing its batch or starting another.
    expect(stoppedAfter).toBeLessThan(2_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(abandonedRendered).toBe(renderedWhenStopped);
    expect(renderedWhenStopped).toBeLessThan(18);

    // The other export is exactly what it is alone, from the same browser.
    expect(done.map((s) => s.name)).toEqual(alone.map((s) => s.name));
    done.forEach((s, i) => expect(Buffer.compare(s.buffer, alone[i].buffer)).toBe(0));
    expect(ownExportBrowser(browser!).browser.pid).toBe(before);

    // And the browser keeps serving exports.
    const after = await exportAllSlides(kept, "4:5");
    after.forEach((s, i) => expect(Buffer.compare(s.buffer, alone[i].buffer)).toBe(0));
    expect(ownExportBrowser(browser!).browser.pid).toBe(before);
  }, 120_000);

  it("abandons a PDF export the same way, keeping the browser", async () => {
    const { exportAllSlidePdfs, exportSlidePdf } = await import("@/lib/export-slides");
    await exportSlidePdf(slide(1), "4:5");
    const before = ownExportBrowser(browser!).browser.pid;
    const controller = new AbortController();
    const abandoned = exportAllSlidePdfs(
      Array.from({ length: 18 }, (_, i) => slide(i + 1)),
      "4:5",
      { signal: controller.signal }
    ).then(
      () => "finished",
      (error: Error) => error.name
    );
    setTimeout(() => controller.abort(), 200);
    expect(await abandoned).toBe("ExportAbandonedError");
    await expect(exportSlidePdf(slide(2), "4:5")).resolves.toBeInstanceOf(Uint8Array);
    expect(ownExportBrowser(browser!).browser.pid).toBe(before);
  }, 120_000);
});
