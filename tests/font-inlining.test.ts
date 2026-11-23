import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// #196: the export loads nothing from the network, so every font file a
// Google Fonts stylesheet names must be inlined before the slide loads. Google
// is replaced by a local server, reached by rewriting its two hosts in a
// test-only fetch, so nothing here touches the network.
let server: Server;
let origin: string;
const requests: string[] = [];

/** A stylesheet naming one file, the way Google names the files of a family it serves from a kit. */
const KIT_CSS =
  "@font-face { font-family: 'Kit'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/l/font?kit=abc&skey=1&v=v10) format('woff2'); }";

/**
 * A stylesheet that names each of three files in four rules, one rule per
 * weight, the way Google's answer for a family with many unicode ranges names
 * the same file again and again.
 */
const RULE_COUNT = 12;
const FILE_COUNT = 3;
const rangesRule = (n: number, src: string) =>
  `@font-face { font-family: 'Ranges'; font-style: normal; font-weight: ${100 * (1 + Math.floor(n / FILE_COUNT))}; font-display: swap; src: url(${src}) format('woff2'); }`;
const rangesCss = (src: (file: number) => string) =>
  Array.from({ length: RULE_COUNT }, (_, n) => rangesRule(n, src(n % FILE_COUNT))).join("\n");
const RANGES_CSS = rangesCss((file) => `https://fonts.gstatic.com/r/${file}.woff2`);

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url!);
    const url = new URL(req.url!, "http://local");
    if (url.pathname === "/css2" && url.searchParams.get("family")?.startsWith("Kit")) {
      res.writeHead(200, { "content-type": "text/css" });
      return void res.end(KIT_CSS);
    }
    if (url.pathname === "/l/font") {
      res.writeHead(200, { "content-type": "font/woff2" });
      return void res.end(Buffer.from([9, 9, 9]));
    }
    if (url.pathname === "/css2" && url.searchParams.get("family")?.startsWith("Ranges")) {
      res.writeHead(200, { "content-type": "text/css" });
      return void res.end(RANGES_CSS);
    }
    const file = /^\/r\/(\d)\.woff2$/.exec(url.pathname)?.[1];
    if (file !== undefined) {
      res.writeHead(200, { "content-type": "font/woff2" });
      return void res.end(Buffer.from([Number(file), Number(file), Number(file)]));
    }
    res.writeHead(400);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("font inlining for a no-network export (#196)", () => {
  let originalCwd: string;
  let workdir: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    requests.length = 0;
    originalCwd = process.cwd();
    workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-font-inlining-"));
    process.chdir(workdir);
    vi.resetModules();
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
      realFetch(
        String(input).replace("https://fonts.googleapis.com", origin).replace("https://fonts.gstatic.com", origin),
        init
      )
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  it("inlines a font file whose URL does not end in .woff2, so no remote URL is left in the CSS", async () => {
    const { getInlinedFontCSS } = await import("@/lib/fonts");
    const css = await getInlinedFontCSS(["Kit"]);
    expect(css).toContain("src: url(data:font/woff2;base64,CQkJ) format('woff2')");
    expect(css).not.toContain("fonts.gstatic.com");
    expect(requests.filter((r) => r.startsWith("/l/font"))).toHaveLength(1);
  });

  it("fetches each font file once however many rules name it, and inlines every rule exactly as before (#249)", async () => {
    const { getInlinedFontCSS } = await import("@/lib/fonts");
    const css = await getInlinedFontCSS(["Ranges"]);

    // The output is what fetching once per rule produced: every rule's address
    // replaced by that file's bytes, and font-display made `block`.
    const dataUrl = (file: number) => `data:font/woff2;base64,${Buffer.from([file, file, file]).toString("base64")}`;
    expect(css).toBe(rangesCss(dataUrl).replace(/font-display: swap/g, "font-display: block"));

    const fontRequests = requests.filter((r) => r.startsWith("/r/"));
    expect(fontRequests.sort()).toEqual(Array.from({ length: FILE_COUNT }, (_, file) => `/r/${file}.woff2`));
    expect(requests.filter((r) => r.startsWith("/css2"))).toHaveLength(1);
  });

  it("fetches again a cached stylesheet that still names a remote font file, and replaces it", async () => {
    const cacheDir = path.join(workdir, "data", ".font-cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "Kit.css"), KIT_CSS);

    const { getInlinedFontCSS } = await import("@/lib/fonts");
    const css = await getInlinedFontCSS(["Kit"]);

    expect(css).toContain("data:font/woff2;base64,CQkJ");
    expect(requests.filter((r) => r.startsWith("/css2"))).toHaveLength(1);
    expect(await readFile(path.join(cacheDir, "Kit.css"), "utf-8")).not.toContain("fonts.gstatic.com");
  });

  it("uses a cached stylesheet whose font files are all inlined, without asking the source", async () => {
    const cacheDir = path.join(workdir, "data", ".font-cache");
    await mkdir(cacheDir, { recursive: true });
    const inlined = "@font-face { font-family: 'Kit'; src: url(data:font/woff2;base64,CQkJ) format('woff2'); }";
    await writeFile(path.join(cacheDir, "Kit.css"), inlined);

    const { getInlinedFontCSS } = await import("@/lib/fonts");
    expect(await getInlinedFontCSS(["Kit"])).toBe(inlined);
    expect(requests).toEqual([]);
  });
});
