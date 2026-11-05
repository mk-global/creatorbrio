import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// How the fonts module asks Google for variable or static font files, and keeps
// the two apart in its cache. No network: fetch is replaced by a fake Google.

const VARIABLE_UA = /Chrome\/120\./;
const STATIC_UA = /Chrome\/60\./;

interface Call {
  url: string;
  userAgent: string | undefined;
}

/** A fake Google Fonts: CSS naming one woff2 per answer, distinct per user agent. */
function fakeGoogle(options: { staticAnswer?: number } = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, userAgent: headers["User-Agent"] });
    if (url.startsWith("https://fonts.gstatic.com/")) {
      // Different bytes per file, so the inlined CSS shows which file it holds.
      return new Response(new Uint8Array(url.endsWith("/static-600.woff2") ? [1, 2, 3] : [4, 5, 6]));
    }
    const isStatic = STATIC_UA.test(headers["User-Agent"] ?? "");
    if (isStatic && options.staticAnswer && options.staticAnswer !== 200) {
      return new Response("unavailable", { status: options.staticAnswer });
    }
    const file = isStatic ? "static-600" : "variable";
    return new Response(
      `@font-face { font-family: 'Test'; font-display: swap; src: url(https://fonts.gstatic.com/s/test/${file}.woff2) format('woff2'); }`
    );
  });
  return { calls, fetchMock };
}

describe("font instances", () => {
  let workdir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-font-instances-"));
    process.chdir(workdir);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  async function fonts() {
    return import("@/lib/fonts");
  }

  it("asks for variable fonts by default, as the preview and PNG export always have", async () => {
    const google = fakeGoogle();
    vi.stubGlobal("fetch", google.fetchMock);
    const { getInlinedFontCSS } = await fonts();

    const css = await getInlinedFontCSS(["Test"]);

    const cssCalls = google.calls.filter((c) => c.url.startsWith("https://fonts.googleapis.com/"));
    expect(cssCalls).toHaveLength(1);
    expect(cssCalls[0].userAgent).toMatch(VARIABLE_UA);
    expect(css).toContain("data:font/woff2;base64,BAUG");
    expect(css).toContain("font-display: block");
    expect(await readdir(path.join(workdir, "data", ".font-cache"))).toEqual(["Test.css"]);
  });

  it("asks for static instances with a user agent that predates variable fonts", async () => {
    const google = fakeGoogle();
    vi.stubGlobal("fetch", google.fetchMock);
    const { getInlinedFontCSS } = await fonts();

    const css = await getInlinedFontCSS(["Test"], { instances: "static", italic: true });

    const cssCalls = google.calls.filter((c) => c.url.startsWith("https://fonts.googleapis.com/"));
    expect(cssCalls).toHaveLength(2);
    for (const call of cssCalls) expect(call.userAgent).toMatch(STATIC_UA);
    expect(google.calls.some((c) => c.url.endsWith("/static-600.woff2"))).toBe(true);
    expect(google.calls.some((c) => c.url.endsWith("/variable.woff2"))).toBe(false);
    expect(css).toContain("data:font/woff2;base64,AQID");
  });

  it("keeps static and variable files in separate caches", async () => {
    const google = fakeGoogle();
    vi.stubGlobal("fetch", google.fetchMock);
    const { getInlinedFontCSS } = await fonts();

    const variable = await getInlinedFontCSS(["Test"]);
    const staticCss = await getInlinedFontCSS(["Test"], { instances: "static" });
    expect(staticCss).not.toBe(variable);

    const cacheRoot = path.join(workdir, "data", ".font-cache");
    expect(await readFile(path.join(cacheRoot, "Test.css"), "utf8")).toBe(variable);
    expect(await readFile(path.join(cacheRoot, "static", "Test.css"), "utf8")).toBe(staticCss);

    // Both are served from the cache afterwards, each from its own entry.
    const before = google.calls.length;
    expect(await getInlinedFontCSS(["Test"])).toBe(variable);
    expect(await getInlinedFontCSS(["Test"], { instances: "static" })).toBe(staticCss);
    expect(google.calls.length).toBe(before);
  });

  it("reads each kind back from its own disk cache after a restart", async () => {
    const google = fakeGoogle();
    vi.stubGlobal("fetch", google.fetchMock);
    let { getInlinedFontCSS } = await fonts();
    const variable = await getInlinedFontCSS(["Test"]);
    const staticCss = await getInlinedFontCSS(["Test"], { instances: "static" });

    vi.resetModules();
    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", offline);
    ({ getInlinedFontCSS } = await fonts());

    expect(await getInlinedFontCSS(["Test"], { instances: "static" })).toBe(staticCss);
    expect(await getInlinedFontCSS(["Test"])).toBe(variable);
    expect(offline).not.toHaveBeenCalled();
  });

  it("falls back to the variable font when Google has no static instance", async () => {
    const google = fakeGoogle({ staticAnswer: 400 });
    vi.stubGlobal("fetch", google.fetchMock);
    const { getInlinedFontCSS } = await fonts();

    const css = await getInlinedFontCSS(["Test"], { instances: "static" });

    const cssCalls = google.calls.filter((c) => c.url.startsWith("https://fonts.googleapis.com/"));
    expect(cssCalls.map((c) => STATIC_UA.test(c.userAgent ?? ""))).toEqual([true, false]);
    expect(css).toContain("data:font/woff2;base64,BAUG");
    // The failed static answer is not cached, so a later export asks again.
    await expect(readdir(path.join(workdir, "data", ".font-cache", "static"))).rejects.toThrow();
  });

  it("falls back to the variable font when the static request fails outright", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const ua = ((init?.headers ?? {}) as Record<string, string>)["User-Agent"] ?? "";
        calls.push(ua);
        if (STATIC_UA.test(ua)) throw new Error("network down");
        if (String(input).startsWith("https://fonts.gstatic.com/")) return new Response(new Uint8Array([1]));
        return new Response("@font-face { font-family: 'Test'; src: url(https://fonts.gstatic.com/s/test/v.woff2); }");
      })
    );
    const { getInlinedFontCSS } = await fonts();

    expect(await getInlinedFontCSS(["Test"], { instances: "static" })).toContain("data:font/woff2;base64,AQ==");
  });
});
