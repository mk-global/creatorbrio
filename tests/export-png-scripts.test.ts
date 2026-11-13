import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Slide } from "@/types/carousel";
import { appBrowser, inCi } from "./helpers/app-browser";

// The PNG export loads slides with JavaScript off, as the preview's sandboxed
// iframe and the native PDF do (#130). Slide HTML is untrusted, so a slide's
// script must neither change the exported image nor make any request. In CI
// these use the runner's Chrome and must run: a missing browser fails the
// suite rather than skipping it.
const browser = appBrowser();
const UPLOAD = "8d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a";

const slide = (html: string): Slide => ({ id: "s1", html, previousVersions: [], order: 0, notes: "" });

const TEXT = `<div style="width:100%;height:100%;background:#f7f3e9;font-family:Georgia,serif;padding:80px;box-sizing:border-box">
  <p id="t" style="font-size:96px;margin:0;color:#1a1a2e">Preview text</p>
  <div id="box" style="margin-top:40px;width:300px;height:300px;background:#16a085"></div>
</div>`;

describe.skipIf(!browser && !inCi)("PNG export runs no slide scripts", () => {
  let previousExecutable: string | undefined;
  let originalCwd: string;
  let work: string;
  let listener: Server;
  let listenerUrl: string;
  const requests: string[] = [];

  beforeAll(async () => {
    if (!browser) throw new Error("No Chromium or Chrome found: the PNG script tests must run in CI.");
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = browser;
    originalCwd = process.cwd();
    work = await mkdtemp(path.join(tmpdir(), "creatorbrio-png-scripts-"));
    await mkdir(path.join(work, "public", "uploads"), { recursive: true });
    await mkdir(path.join(work, "data"), { recursive: true });
    await writeFile(
      path.join(work, "public", "uploads", `${UPLOAD}.png`),
      await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 233, g: 69, b: 96 } } }).png().toBuffer()
    );
    process.chdir(work);
    listener = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.end("ok");
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    listenerUrl = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
    await new Promise<void>((resolve) => listener?.close(() => resolve()));
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("exports a scripted slide exactly as the same slide without its script", async () => {
    const { exportSlide } = await import("@/lib/export-slides");
    const script = `<script>
      document.getElementById("t").textContent += " scripted";
      document.getElementById("box").style.background = "#e94560";
      document.body.insertAdjacentHTML("beforeend", "<p style='font-size:96px'>Injected</p>");
    </script>`;
    const plain = await exportSlide(slide(TEXT), "4:5");
    const scripted = await exportSlide(slide(TEXT + script), "4:5");
    expect(Buffer.compare(scripted, plain)).toBe(0);
  }, 60_000);

  it("lets a slide script make no request of any kind", async () => {
    const { exportSlide } = await import("@/lib/export-slides");
    requests.length = 0;
    const L = JSON.stringify(listenerUrl);
    const html = `${TEXT}<script>
      fetch(${L} + "/fetch").catch(() => {});
      fetch(${L} + "/post", { method: "POST", mode: "no-cors", body: "x" }).catch(() => {});
      navigator.sendBeacon(${L} + "/beacon", "x");
      new Image().src = ${L} + "/image";
      const f = document.createElement("form"); f.method = "POST"; f.action = ${L} + "/form";
      document.body.appendChild(f); f.submit();
    </script>`;
    await exportSlide(slide(html), "1:1");
    // Give any request the page started time to arrive after the capture.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(requests).toEqual([]);
  }, 60_000);

  it("still completes the export's own font and image waits without running to their timeouts", async () => {
    const { exportSlide } = await import("@/lib/export-slides");
    const warn = vi.spyOn(console, "warn");
    try {
      const started = Date.now();
      await exportSlide(slide(`${TEXT}<img src="/uploads/${UPLOAD}.png" style="width:400px;height:400px">`), "9:16");
      expect(warn).not.toHaveBeenCalled();
      // The font wait allows 10 s and the image wait 10 s; settling early is the point.
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});
