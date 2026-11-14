import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Slide } from "@/types/carousel";
import { appBrowser, inCi } from "./helpers/app-browser";
import { ownExportBrowser, type BrowserChild } from "./helpers/export-browser-processes";

// #197: the export browser renders untrusted slide HTML, so every renderer must
// run confined by the operating system's sandbox. This asks the operating
// system, not the command line: on macOS whether the process is under its
// sandbox (`sandbox_check`), on Linux whether a seccomp-bpf filter confines it
// (`Seccomp: 2` in /proc). It runs in CI on the runner's Chrome; a missing
// browser, or a platform it cannot check, fails rather than skips.
const browser = appBrowser();

/** Whether the operating system confines `pid` by its process sandbox. */
function confined(pid: number): boolean {
  if (process.platform === "linux") {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return /^Seccomp:\s+2$/m.test(status);
  }
  if (process.platform === "darwin") {
    const check =
      "import ctypes,sys;l=ctypes.CDLL('/usr/lib/libSystem.dylib');" +
      "l.sandbox_check.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int];" +
      "print(l.sandbox_check(int(sys.argv[1]),None,0))";
    return execFileSync("python3", ["-c", check, String(pid)], { encoding: "utf8" }).trim() === "1";
  }
  throw new Error(`no sandbox check for ${process.platform}`);
}

const slide: Slide = {
  id: "sandboxed",
  html: '<div style="width:100%;height:100%;background:#16a085;color:#fff;font:120px Georgia,serif;padding:80px;box-sizing:border-box">Sandboxed</div>',
  previousVersions: [],
  order: 0,
  notes: "",
};

describe.skipIf(!browser && !inCi)("export browser sandbox in Chromium (#197)", () => {
  let previousExecutable: string | undefined;
  let originalCwd: string;
  let work: string;

  beforeAll(async () => {
    if (!browser) throw new Error("No Chromium or Chrome found: the export sandbox test must run in CI.");
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = browser;
    originalCwd = process.cwd();
    work = await mkdtemp(path.join(tmpdir(), "creatorbrio-export-sandbox-"));
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

  it("renders every slide in renderer processes the operating system sandboxes", async () => {
    const { exportSlide, exportSlidePdf, EXPORT_CHROME_ARGS } = await import("@/lib/export-slides");
    const png = await exportSlide(slide, "4:5");
    const pdf = await exportSlidePdf(slide, "4:5");
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(Buffer.from(pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const { browser: root, children } = ownExportBrowser(browser!);
    expect(root.args).not.toMatch(/--no-sandbox|--disable-setuid-sandbox|--no-zygote|--single-process/);
    expect(EXPORT_CHROME_ARGS).not.toContain("--no-sandbox");
    const renderers = children.filter((p) => p.type === "renderer");
    expect(renderers.length, "the export browser has renderer processes").toBeGreaterThan(0);

    const report = (list: BrowserChild[]) => list.map((p) => `${p.type}=${confined(p.pid) ? "sandboxed" : "unconfined"}`).join(", ");
    console.info(`export browser on ${process.platform}: ${report(children)}`);
    expect(renderers.map((p) => [p.type, confined(p.pid)])).toEqual(renderers.map(() => ["renderer", true]));
  }, 60_000);
});
