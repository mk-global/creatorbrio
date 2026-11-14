import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Slide } from "@/types/carousel";
import { appBrowser, inCi } from "./helpers/app-browser";

// #200: fetching a font for an export finishes or gives up within a stated
// time. Google Fonts is replaced by a local server, reached by rewriting the
// two hosts in a test-only fetch, so nothing here touches the network. Family
// names choose the server's behaviour.
const STALL_MS = 300;
const UNREACHABLE_MS = 800;

const requests: string[] = [];
let server: Server;
let origin: string;
const hung = new Set<import("node:http").ServerResponse>();

function css(file: string): string {
  return `@font-face { font-family: 'X'; font-style: normal; font-weight: 400; font-display: swap; src: url(https://fonts.gstatic.com/s/x/${file}.woff2) format('woff2'); }`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://local");
    requests.push(url.pathname + url.search);
    if (url.pathname === "/css2") {
      const family = (url.searchParams.get("family") ?? "").split(":")[0];
      if (family === "Stall") return void hung.add(res); // accepts, never answers
      if (family === "BodyStall") return void res.end(css("body-stall"));
      if (family === "Slow") return void res.end(css("slow"));
      if (family === "Ok") return void res.end(css("ok"));
      if (family === "Kit") {
        // A file URL that does not end in .woff2, as Google serves some families.
        return void res.end(
          "@font-face { font-family: 'Kit'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/l/font?kit=abc&v=1) format('woff2'); }"
        );
      }
      res.statusCode = 400;
      return void res.end("no such family");
    }
    if (url.pathname === "/s/x/body-stall.woff2") {
      res.writeHead(200, { "content-type": "font/woff2" });
      res.write(Buffer.from([1, 2]));
      return void hung.add(res); // headers and a first chunk, then nothing
    }
    if (url.pathname === "/s/x/slow.woff2") {
      // Ten chunks, each well inside the stall limit, together well past it.
      res.writeHead(200, { "content-type": "font/woff2" });
      let sent = 0;
      const tick = setInterval(() => {
        res.write(Buffer.from([sent]));
        if (++sent === 10) {
          clearInterval(tick);
          res.end();
        }
      }, STALL_MS / 3);
      return;
    }
    if (url.pathname === "/s/x/ok.woff2") return void res.end(Buffer.from([7, 7, 7]));
    if (url.pathname === "/l/font") {
      res.writeHead(200, { "content-type": "font/woff2" });
      return void res.end(Buffer.from([9, 9, 9]));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of hung) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("font fetch limits (#200)", () => {
  let workdir: string;
  let originalCwd: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    requests.length = 0;
    originalCwd = process.cwd();
    workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-font-limits-"));
    process.chdir(workdir);
    vi.resetModules();
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
      realFetch(
        String(input)
          .replace("https://fonts.googleapis.com", origin)
          .replace("https://fonts.gstatic.com", origin),
        init
      )
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  async function fonts() {
    const fontsModule = await import("@/lib/fonts");
    fontsModule.fontFetchLimits.stallMs = STALL_MS;
    fontsModule.fontFetchLimits.unreachableMs = UNREACHABLE_MS;
    return fontsModule;
  }

  async function cached(): Promise<string[]> {
    return readdir(path.join(workdir, "data", ".font-cache")).catch(() => []);
  }

  it("gives up on a stylesheet that is never answered within the stall limit, and caches nothing", async () => {
    const { getInlinedFontCSS } = await fonts();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    expect(await getInlinedFontCSS(["Stall"])).toBe("");
    expect(Date.now() - started).toBeLessThan(STALL_MS + 400);
    expect(await cached()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("Stall");
  });

  it("gives up on a font file whose body stops arriving, rendering the family with the fallback font and caching nothing", async () => {
    const { getInlinedFontCSS } = await fonts();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    expect(await getInlinedFontCSS(["BodyStall"])).toBe("");
    expect(Date.now() - started).toBeLessThan(STALL_MS + 400);
    expect(await cached()).toEqual([]);
  });

  it("falls back at once for every font while the source is unreachable, then tries again", async () => {
    const { getInlinedFontCSS } = await fonts();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getInlinedFontCSS(["Stall"])).toBe("");
    const asked = requests.length;

    // Within the window: no request at all, and no wait.
    const started = Date.now();
    expect(await getInlinedFontCSS(["Ok", "Slow"], { italic: true })).toBe("");
    expect(Date.now() - started).toBeLessThan(50);
    expect(requests).toHaveLength(asked);
    expect(warn).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, UNREACHABLE_MS + 50));
    expect(await getInlinedFontCSS(["Ok"])).toContain("data:font/woff2;base64,BwcH");
    expect(await cached()).toEqual(["Ok.css"]);
  });

  it("keeps a slow download that never stalls, however long it takes in total", async () => {
    const { getInlinedFontCSS } = await fonts();
    const started = Date.now();
    const result = await getInlinedFontCSS(["Slow"]);
    expect(Date.now() - started).toBeGreaterThan(STALL_MS * 2);
    expect(result).toContain(`data:font/woff2;base64,${Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).toString("base64")}`);
    expect(result).not.toContain("fonts.gstatic.com");
    expect(await cached()).toEqual(["Slow.css"]);
  });

  it("shares one download between slides that need the same font at the same time", async () => {
    const { getInlinedFontCSS } = await fonts();
    const [a, b, c] = await Promise.all([getInlinedFontCSS(["Ok"]), getInlinedFontCSS(["Ok"]), getInlinedFontCSS(["Ok"])]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(requests.filter((r) => r.startsWith("/css2"))).toHaveLength(1);
    expect(requests.filter((r) => r.startsWith("/s/x/ok.woff2"))).toHaveLength(1);
  });

  it("inlines a font file whose URL does not end in .woff2, so no remote URL is ever left in the CSS", async () => {
    const { getInlinedFontCSS } = await fonts();
    const result = await getInlinedFontCSS(["Kit"]);
    expect(result).toContain("src: url(data:font/woff2;base64,CQkJ)");
    expect(result).not.toContain("fonts.gstatic.com");
    expect(await cached()).toEqual(["Kit.css"]);
  });

  it("fetches again a cached stylesheet that still names a remote font file, and replaces it", async () => {
    const cacheDir = path.join(workdir, "data", ".font-cache");
    await mkdir(cacheDir, { recursive: true });
    const stale = "@font-face { font-family: 'Kit'; src: url(https://fonts.gstatic.com/l/font?kit=abc&v=1) format('woff2'); }";
    await writeFile(path.join(cacheDir, "Kit.css"), stale);
    const { getInlinedFontCSS } = await fonts();
    const result = await getInlinedFontCSS(["Kit"]);
    expect(result).toContain("src: url(data:font/woff2;base64,CQkJ)");
    expect(requests.filter((r) => r.startsWith("/css2"))).toHaveLength(1);
    const replaced = await readFile(path.join(cacheDir, "Kit.css"), "utf-8");
    expect(replaced).not.toContain("fonts.gstatic.com");
  });

  it("treats a font file the source refuses as an unavailable family, not a half-inlined one", async () => {
    const { getInlinedFontCSS } = await fonts();
    // The stylesheet answers, but the server has no such file.
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
      realFetch(
        String(input)
          .replace("https://fonts.googleapis.com", origin)
          .replace("https://fonts.gstatic.com/s/x/ok.woff2", `${origin}/s/x/missing.woff2`),
        init
      )
    );
    expect(await getInlinedFontCSS(["Ok"])).toBe("");
    expect(await cached()).toEqual([]);
  });
});

const browser = appBrowser();

const slideIn = (family: string): Slide => ({
  id: family,
  html: `<div style="width:100%;height:100%;background:#f7f3e9;color:#1a1a2e;font-family:'${family}',serif;font-size:120px;padding:80px;box-sizing:border-box">Fallback 123</div>`,
  previousVersions: [],
  order: 0,
  notes: "",
});

describe.skipIf(!browser && !inCi)("an export whose font source never answers (#200)", () => {
  let workdir: string;
  let originalCwd: string;
  let previousExecutable: string | undefined;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    if (!browser) throw new Error("No Chromium or Chrome found: the font limit export test must run in CI.");
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = browser;
    originalCwd = process.cwd();
    workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-font-limits-export-"));
    await mkdir(path.join(workdir, "public", "uploads"), { recursive: true });
    process.chdir(workdir);
    vi.resetModules();
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
      realFetch(
        String(input)
          .replace("https://fonts.googleapis.com", origin)
          .replace("https://fonts.gstatic.com", origin),
        init
      )
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
    await rm(workdir, { recursive: true, force: true });
  });

  it("completes within the stall limit and renders exactly as the fallback font", async () => {
    const { fontFetchLimits } = await import("@/lib/fonts");
    fontFetchLimits.stallMs = 2_000;
    const { exportSlide, exportSlidePdf } = await import("@/lib/export-slides");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // A family the source refuses outright renders in the fallback font today; that is the reference.
    const reference = await exportSlide(slideIn("NoSuchFamily"), "4:5");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const started = Date.now();
    const png = await exportSlide(slideIn("Stall"), "4:5");
    expect(Date.now() - started).toBeLessThan(2_000 + 5_000);
    expect(Buffer.compare(png, reference)).toBe(0);

    // The PDF fetches static instances too; within the unreachable window it does not wait again.
    const pdfStarted = Date.now();
    const pdf = await exportSlidePdf(slideIn("Stall"), "4:5");
    expect(Date.now() - pdfStarted).toBeLessThan(5_000);
    expect(Buffer.from(pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 60_000);
});
