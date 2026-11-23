import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { isFontFamilyName } from "@/lib/slide-html";
import { proxy, config } from "@/proxy";
import { fetchThrough, PROBE_FAMILY, startFakeFontSource, type FakeFontSource } from "./helpers/fake-font-source";

// #249: slide previews take their fonts from CreatorBrio's own route, which
// answers with the export's inlined font CSS. Google Fonts is replaced by a
// local server, so nothing here touches the network.
let source: FakeFontSource;

beforeAll(async () => {
  source = await startFakeFontSource();
});

afterAll(async () => {
  await source.close();
});

describe("the preview font route (#249)", () => {
  let originalCwd: string;
  let workdir: string;

  beforeEach(async () => {
    source.requests.length = 0;
    originalCwd = process.cwd();
    workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-preview-font-route-"));
    process.chdir(workdir);
    vi.resetModules();
    vi.stubGlobal("fetch", fetchThrough(source.origin));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  const get = async (query: string) => {
    const { GET } = await import("@/app/api/fonts/css/route");
    return GET(new Request(`http://127.0.0.1:3000/api/fonts/css${query}`));
  };

  it("answers the family's inlined @font-face CSS, upright only unless the italic cut is asked for", async () => {
    const roman = await get(`?family=${encodeURIComponent(PROBE_FAMILY)}`);
    expect(roman.status).toBe(200);
    expect(roman.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(roman.headers.get("x-content-type-options")).toBe("nosniff");
    const romanCss = await roman.text();
    expect(romanCss).toContain("font-style: normal");
    expect(romanCss).toContain("src: url(data:font/woff2;base64,");
    expect(romanCss).not.toContain("font-style: italic");
    expect(romanCss).not.toContain("fonts.gstatic.com");

    const both = await (await get(`?family=${encodeURIComponent(PROBE_FAMILY)}&italic=1`)).text();
    expect(both).toContain("font-style: normal");
    expect(both).toContain("font-style: italic");
    expect(both).not.toContain("fonts.gstatic.com");
  });

  it("fetches a family once for requests that arrive while it is being fetched", async () => {
    const query = `?family=${encodeURIComponent(PROBE_FAMILY)}`;
    const answers = await Promise.all([get(query), get(query), get(query)]);
    const bodies = await Promise.all(answers.map((answer) => answer.text()));
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("@font-face");
    expect(source.requests.filter((r) => r.startsWith("/css2"))).toHaveLength(1);
  });

  it("answers empty CSS that is not kept for a family the font source does not have", async () => {
    const response = await get("?family=Unknown%20Family");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["no family", ""],
    ["an empty family", "?family="],
    ["two families", "?family=Inter&family=Lora"],
    ["a family with a slash", "?family=a%2Fb"],
    ["a family with an ampersand", "?family=Inter%26x%3D1"],
    ["a family with an axis", "?family=Inter%3Awght%40100"],
    ["an address", "?family=https%3A%2F%2Fexample.test%2Fx"],
    ["a family with two spaces in a row", "?family=Open%20%20Sans"],
    ["a family with a leading space", "?family=%20Inter"],
    ["a family longer than 64 characters", `?family=${"A".repeat(65)}`],
    ["a non-ASCII family", "?family=Int%C3%A9r"],
    ["another italic value", "?family=Inter&italic=true"],
    ["another parameter", "?family=Inter&display=swap"],
  ])("refuses %s without asking the font source", async (_name, query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(source.requests).toEqual([]);
  });
});

describe("isFontFamilyName (#249)", () => {
  it("accepts every family the font picker offers", async () => {
    const { GET } = await import("@/app/api/fonts/route");
    const { fonts } = (await (await GET()).json()) as { fonts: { name: string }[] };
    expect(fonts.length).toBeGreaterThan(10);
    for (const { name } of fonts) expect(isFontFamilyName(name), name).toBe(true);
  });
});

describe("the request guard in front of the preview font route (#249)", () => {
  it("covers the route and refuses a request whose Host is not this machine", () => {
    expect(config.matcher).toBe("/api/:path*");
    const refused = proxy(new NextRequest("http://evil.example/api/fonts/css?family=Inter", { headers: { host: "evil.example" } }));
    expect(refused.status).toBe(403);
    const allowed = proxy(new NextRequest("http://127.0.0.1:3000/api/fonts/css?family=Inter", { headers: { host: "127.0.0.1:3000" } }));
    expect(allowed.status).toBe(200);
  });
});
