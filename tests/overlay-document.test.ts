import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import { describe, expect, it } from "vitest";

import { createCatalog, DEFAULT_CATALOG } from "@/lib/video/capabilities/catalog";
import type { CapabilityDefinition, Emitted } from "@/lib/video/capabilities/types";
import { RenderFailure, type FontAsset } from "@/lib/video/render/execute-types";
import { BUNDLED_FACES, bundledFonts, loadBundledFonts, OVERLAY_FONT_FAMILY } from "@/lib/video/render/fonts";
import { activeRanges, buildOverlay, EXPORT_OVERLAY_CSP, OVERLAY_ORIGIN, overlayTimeSeconds, previewOverlayAt } from "@/lib/video/render/overlay";
import { PLAN_VERSION, type GraphicPlacement, type RenderPlan } from "@/lib/video/render/plan";
import type { JsonValue } from "@/types/production";
import { chromiumPath } from "./helpers/native-pdf";

const CHROMIUM = chromiumPath();
const CHROMIUM_MISSING = CHROMIUM ? "" : "Chromium is not installed (puppeteer browsers install chrome); CI has none (#142)";

function graphic(clipId: string, startFrame: number, durationFrames: number, id: string, params: unknown): GraphicPlacement {
  return { clipId, trackId: "track-g", trackIndex: 3, capability: { id, version: "1.0.0", params: params as JsonValue }, startFrame, durationFrames };
}

function plan(graphics: GraphicPlacement[], canvas = { width: 1080, height: 1920, fps: 30 as const }): RenderPlan {
  return {
    version: PLAN_VERSION,
    productionId: "prod-overlay",
    revision: 3,
    profile: "instagram",
    canvas,
    durationFrames: 300,
    video: [],
    audio: [],
    graphics,
    captions: [],
    inputs: [],
    loudness: { targetLufs: -14 },
  };
}

const HOSTILE = [
  `</style><meta http-equiv="refresh" content="0">`,
  "<script>alert(1)</script>",
  "<link rel=prefetch href=https://example.invalid/x>",
  `"Quotes" & 'apostrophes' &amp; done`,
  "Emoji 😀🎬 and RTL مرحبا بالعالم שלום",
];

const sample = () =>
  plan([
    graphic("clip-cap", 0, 150, "captions.timed", {
      preset: "kinetic",
      position: "lower",
      cues: HOSTILE.map((text, i) => ({ start: i * 30, end: i * 30 + 30, text })),
    }),
    graphic("clip-sentence", 150, 90, "captions.timed", { preset: "sentence", position: "center", accent: "#00ccff", cues: [{ start: 0, end: 60, text: HOSTILE[0] }] }),
    graphic("clip-lower", 30, 30, "graphics.lower-third", { title: HOSTILE[1], subtitle: HOSTILE[2] }),
    graphic("clip-title", 200, 60, "graphics.title-card", { title: HOSTILE[3], subtitle: HOSTILE[4], align: "center", scrim: true }),
  ]);

/** Every tag in a document, by name, e.g. `div`, `/div`, `!doctype`. */
function tags(html: string): string[] {
  return [...html.matchAll(/<\s*(\/?[!a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase());
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("the overlay document", async () => {
  const fonts = await bundledFonts();
  const build = (p: RenderPlan, target: "export" | "preview" = "export") => buildOverlay(p, { catalog: DEFAULT_CATALOG, fonts, target });

  it("renders hostile text only as escaped text, with one style element and no forbidden tags", () => {
    for (const target of ["export", "preview"] as const) {
      const { html } = build(sample(), target);
      expect(count(html, "<style")).toBe(1);
      expect(count(html, "</style>")).toBe(1);
      const allowed = new Set(["!doctype", "html", "/html", "head", "/head", "meta", "style", "/style", "body", "/body", "div", "/div", "span", "/span"]);
      expect(tags(html).filter((t) => !allowed.has(t))).toEqual([]);
      // The only meta elements are the charset and, in the preview, the CSP.
      expect(count(html, "<meta")).toBe(target === "preview" ? 2 : 1);
      expect(count(html, "<meta http-equiv")).toBe(target === "preview" ? 1 : 0);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<link");
      expect(html).not.toMatch(/url\(https?:/);
    }
    const { html } = build(sample());
    expect(html).toContain("&lt;/style&gt;&lt;meta http-equiv=&quot;refresh&quot; content=&quot;0&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;link rel=prefetch href=https://example.invalid/x&gt;");
    expect(html).toContain("&quot;Quotes&quot; &amp; &#39;apostrophes&#39; &amp;amp; done");
    expect(html).toContain("😀🎬");
    expect(html).toContain("مرحبا");
  });

  it("is deterministic and hashes its own bytes", () => {
    const a = build(sample());
    const b = build(sample());
    expect(a.sha256).toBe(b.sha256);
    expect(a.html).toBe(b.html);
    expect(a.sha256).toBe(createHash("sha256").update(a.html).digest("hex"));
    expect(build(plan([graphic("clip-lower", 30, 30, "graphics.lower-third", { title: "Ada" })])).html).toMatchSnapshot();
  });

  it("shows a clip exactly on its frames when sampled at frame centres", () => {
    const { html } = build(plan([graphic("clip-lower", 30, 30, "graphics.lower-third", { title: "Ada" })]));
    expect(html).toContain("animation: c0-show 1.000000s linear calc(1.000000s - var(--t, 0s)) 1 normal none");
    const window = /c0-show (\d+\.\d{6})s linear calc\((\d+\.\d{6})s - var\(--t, 0s\)\)/.exec(html)!;
    const [duration, delay] = [Number(window[1]), Number(window[2])];
    const visible = (frame: number) => {
      const t = overlayTimeSeconds(frame, 30);
      return t >= delay && t < delay + duration;
    };
    expect(overlayTimeSeconds(59, 30)).toBeCloseTo(59.5 / 30, 12);
    expect([29, 30, 59, 60].map(visible)).toEqual([false, true, true, false]);
  });

  it("merges overlapping and touching graphics into sorted active ranges", () => {
    expect(build(sample()).activeRanges).toEqual([{ startFrame: 0, endFrame: 260 }]);
    expect(
      activeRanges([
        { startFrame: 90, durationFrames: 10 },
        { startFrame: 0, durationFrames: 30 },
        { startFrame: 30, durationFrames: 5 },
        { startFrame: 10, durationFrames: 5 },
        { startFrame: 50, durationFrames: 20 },
        { startFrame: 60, durationFrames: 40 },
      ])
    ).toEqual([
      { startFrame: 0, endFrame: 35 },
      { startFrame: 50, endFrame: 100 },
    ]);
    expect(build(plan([])).activeRanges).toEqual([]);
  });

  it("differs between export and preview only in font sources and the preview's CSP", () => {
    const exported = build(sample(), "export").html;
    const preview = build(sample(), "preview").html;
    expect(exported).toContain("src: url(/fonts/inter-latin-800-normal.woff2)");
    expect(exported).not.toContain("data:");
    expect(preview).not.toContain("/fonts/");
    expect(preview).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:">`);
    const normalise = (html: string) => html.replace(/<meta http-equiv="[^"]*" content="[^"]*">/, "").replace(/src: url\([^)]*\)/g, "src: url(FONT)");
    expect(normalise(preview)).toBe(normalise(exported));
    expect(count(exported, "@font-face")).toBe(BUNDLED_FACES.length);
    expect(exported).toContain(`font-family: "${OVERLAY_FONT_FAMILY}"`);
    expect(EXPORT_OVERLAY_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; font-src 'self'");
    expect(OVERLAY_ORIGIN).toBe("https://overlay.creatorbrio.invalid");
  });

  it("times kinetic words, sentence fades and graphic entrances in whole frames", () => {
    const { html } = build(
      plan([
        graphic("k", 30, 60, "captions.timed", { preset: "kinetic", position: "lower", cues: [{ start: 0, end: 30, text: "one two three" }] }),
        graphic("s", 90, 60, "captions.timed", { preset: "sentence", position: "lower", cues: [{ start: 6, end: 8, text: "short" }] }),
        graphic("l", 150, 9, "graphics.lower-third", { title: "Short" }),
        graphic("t", 160, 60, "graphics.title-card", { title: "Title", align: "top", scrim: false }),
      ])
    );
    // Words appear on cue frames 0, 10 and 20 (timeline 30, 40, 50) and stay current for 10 frames.
    expect(html).toContain(".c0-q0w0 { animation: c0-pop 0.200000s cubic-bezier(0.2, 1.4, 0.4, 1) calc(1.000000s - var(--t, 0s)) 1 normal both, c0-lit 0.333333s linear calc(1.000000s - var(--t, 0s)) 1 normal none }");
    expect(html).toContain("calc(1.333333s - var(--t, 0s)) 1 normal both, c0-lit 0.333333s");
    expect(html).toContain("calc(1.666667s - var(--t, 0s)) 1 normal both, c0-lit 0.333333s");
    // A two-frame sentence cue fades in over its two frames.
    expect(html).toContain(".c1-q0 { animation: c1-show 0.066667s linear calc(3.200000s - var(--t, 0s)) 1 normal none, c1-fade 0.066667s ease-out calc(3.200000s - var(--t, 0s)) 1 normal both }");
    // A nine-frame lower third enters over 5 frames and leaves over the last 4.
    expect(html).toContain("c2-in 0.166667s cubic-bezier(0.2, 0.8, 0.2, 1) calc(5.000000s - var(--t, 0s)) 1 normal both, c2-out 0.133333s cubic-bezier(0.4, 0, 1, 1) calc(5.166667s - var(--t, 0s)) 1 normal forwards");
    expect(html).toContain("c3-in 0.400000s cubic-bezier(0.2, 0.8, 0.2, 1) calc(5.333333s - var(--t, 0s)) 1 normal both, c3-out 0.266667s ease-in calc(7.066667s - var(--t, 0s)) 1 normal forwards");
  });

  it("places captions and graphics inside the safe zone", () => {
    const { html } = build(sample());
    // Reels safe zone: x 60-960, y 269-1248; lower captions end on its bottom edge.
    expect(html).toMatch(/\.c0-q \{ position: absolute; left: 60px; width: 900px; top: (\d+)px; height: (\d+)px;/);
    const [, top, height] = /\.c0-q \{ position: absolute; left: 60px; width: 900px; top: (\d+)px; height: (\d+)px;/.exec(html)!;
    expect(Number(top) + Number(height)).toBe(1248);
    expect(html).toContain(".c3 { position: absolute; left: 60px; top: 269px; width: 900px; height: 979px;");
    // The lower third ends 24 px above the caption band (1248 - 302).
    expect(html).toContain(`.c2 { position: absolute; left: 60px; bottom: ${1920 - (1248 - 302 - 24)}px;`);
  });

  it("refuses unknown capabilities, refused parameters and fonts that are not the bundle", () => {
    const failure = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof RenderFailure ? [error.failureClass, error.code] : ["other", String(error)];
      }
      return null;
    };
    expect(failure(() => build(plan([graphic("g", 0, 10, "captions.kinetic-pop", {})])))).toEqual(["permanent", "internal_error"]);
    expect(failure(() => build(plan([graphic("g", 0, 10, "graphics.lower-third", { title: "" })])))).toEqual(["permanent", "internal_error"]);
    expect(failure(() => buildOverlay(plan([]), { catalog: DEFAULT_CATALOG, fonts: fonts.slice(1), target: "export" }))).toEqual(["permanent", "internal_error"]);
    const foreign: FontAsset = { ...fonts[0], urlPath: "/fonts/user-upload.woff2" };
    expect(failure(() => buildOverlay(plan([]), { catalog: DEFAULT_CATALOG, fonts: [...fonts.slice(1), foreign], target: "export" }))).toEqual(["permanent", "internal_error"]);
    expect(failure(() => buildOverlay(plan([]), { catalog: DEFAULT_CATALOG, fonts: [...fonts, fonts[0]], target: "export" }))).toEqual(["permanent", "internal_error"]);
  });

  describe("checks every capability's output", () => {
    const rogue = (emitted: Emitted): CapabilityDefinition => ({
      id: "graphics.rogue",
      version: "1.0.0",
      kind: "graphic",
      describe: "test",
      parse: () => ({ ok: true, value: null }),
      emit: () => emitted,
    });
    const attempt = (emitted: Emitted) => {
      const p = plan([graphic("g", 0, 10, "graphics.rogue", {})]);
      return () => buildOverlay(p, { catalog: createCatalog([rogue(emitted)]), fonts, target: "export" });
    };
    const fine = { css: ".c0 { color: #ffffff }\n@keyframes c0-x { from { opacity: 0 } to { opacity: 1 } }", html: `<div class="c0"><span class="c0-a c0-b">a &amp; b</span></div>` };

    it("accepts output that keeps to the safe subset", () => {
      expect(attempt(fine)).not.toThrow();
    });

    it.each([
      ["a url()", ".c0 { background: url(/x.png) }"],
      ["an @import", "@import 'x.css';"],
      ["an @font-face", "@font-face { font-family: x }"],
      ["a closing tag", ".c0 { color: red } </style>"],
      ["an escape", ".c0 { background: u\\72l(x) }"],
      ["a quoted string", ".c0::after { content: 'x' }"],
      ["!important", ".c0 { animation-play-state: running !important }"],
      ["a rule for another clip", ".c1 { color: red }"],
      ["a rule for the whole document", "body { background: red }"],
      ["a descendant selector", ".c0 div { color: red }"],
      ["keyframes without the prefix", "@keyframes spin { from { opacity: 0 } }"],
      ["unbalanced braces", ".c0 { color: red"],
    ])("refuses CSS with %s", (_name, css) => {
      expect(attempt({ ...fine, css })).toThrow(/unsafe CSS for graphic g/);
    });

    it.each([
      ["a script", `<script>alert(1)</script>`],
      ["an image", `<img src="x">`],
      ["a meta refresh", `<meta http-equiv="refresh" content="0">`],
      ["a style element", `<style>body{}</style>`],
      ["an svg", `<svg></svg>`],
      ["a style attribute", `<div class="c0" style="color:red"></div>`],
      ["an event attribute", `<div class="c0" onclick="x"></div>`],
      ["another clip's class", `<div class="c1"></div>`],
      ["unbalanced elements", `<div class="c0"><span class="c0-a"></div>`],
      ["raw angle brackets in text", `<div class="c0">a > b</div>`],
    ])("refuses markup with %s", (_name, html) => {
      expect(attempt({ ...fine, html })).toThrow(/unsafe markup for graphic g/);
    });
  });

  it("builds the preview document for a frame with time set and animations paused", () => {
    const doc = build(sample(), "preview");
    const at59 = previewOverlayAt(doc, 59, 30);
    expect(at59).toContain(":root{--t:1.983333s} *,*::before,*::after{animation-play-state:paused !important}");
    expect(at59).not.toContain(":root{--t:0s}");
    expect(at59.length).toBeGreaterThan(doc.html.length);
    expect(() => previewOverlayAt(build(sample(), "export"), 0, 30)).toThrow(RenderFailure);

    // Caption text may spell the time rule itself; it stays text and the preview still seeks.
    const spelled = build(plan([graphic("g", 0, 90, "captions.timed", { preset: "kinetic", position: "lower", cues: [{ start: 0, end: 90, text: ":root{--t:0s} is just text" }] })]), "preview");
    const seeked = previewOverlayAt(spelled, 59, 30);
    expect(count(seeked, ":root{--t:1.983333s}")).toBe(1);
    expect(count(seeked, ":root{--t:0s}")).toBe(1);
    expect(seeked).toContain(`<span class="c0-w c0-q0w0">:root{--t:0s}</span>`);
  });
});

describe("the bundled font", () => {
  it("is Inter latin and latin-ext at 400, 700 and 800 with their hashes", async () => {
    const fonts = await bundledFonts();
    expect(fonts.map((f) => [f.urlPath, f.weight])).toEqual([
      ["/fonts/inter-latin-400-normal.woff2", 400],
      ["/fonts/inter-latin-700-normal.woff2", 700],
      ["/fonts/inter-latin-800-normal.woff2", 800],
      ["/fonts/inter-latin-ext-400-normal.woff2", 400],
      ["/fonts/inter-latin-ext-700-normal.woff2", 700],
      ["/fonts/inter-latin-ext-800-normal.woff2", 800],
    ]);
    for (const font of fonts) {
      expect(font.family).toBe("CreatorBrio Inter");
      expect(font.source).toBe("@fontsource/inter@5.3.0");
      expect(font.bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
      expect(font.sha256).toBe(createHash("sha256").update(font.bytes).digest("hex"));
    }
    expect(await bundledFonts()).toBe(await bundledFonts());
  });

  it("fails as a configuration problem when the package is missing or another version", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cb-fonts-"));
    try {
      await expect(loadBundledFonts(dir)).rejects.toMatchObject({ failureClass: "configuration", code: "font_bundle_missing" });
      const pkg = path.join(dir, "inter");
      await mkdir(pkg);
      await cp(path.join(process.cwd(), "node_modules", "@fontsource", "inter", "unicode.json"), path.join(pkg, "unicode.json"));
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@fontsource/inter", version: "5.4.0" }));
      await expect(loadBundledFonts(pkg)).rejects.toMatchObject({ failureClass: "configuration", code: "font_bundle_mismatch" });
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@fontsource/inter", version: "5.3.0" }));
      await expect(loadBundledFonts(pkg)).rejects.toMatchObject({ failureClass: "configuration", code: "font_bundle_missing" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!CHROMIUM)(`the overlay in Chromium${CHROMIUM_MISSING ? ` (skipped: ${CHROMIUM_MISSING})` : ""}`, async () => {
  const fonts = await bundledFonts();

  it("shows a graphic on exactly its frames in the preview (time variable) and the export (seeked animations)", async () => {
    const p = plan([graphic("clip-lower", 30, 30, "graphics.lower-third", { title: "Ada" })]);
    const preview = buildOverlay(p, { catalog: DEFAULT_CATALOG, fonts, target: "preview" });
    const exported = buildOverlay(p, { catalog: DEFAULT_CATALOG, fonts, target: "export" });
    const browser = await puppeteer.launch({ headless: true, executablePath: CHROMIUM! });
    try {
      const page = await (await browser.createBrowserContext()).newPage();
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      let requests = 0;
      page.on("request", (r) => (r.url().startsWith("data:") || r.url() === "about:blank" ? r.continue() : (requests++, r.abort())));
      const visibility = () => page.evaluate(() => getComputedStyle(document.querySelector(".c0")!).visibility);

      const previewSeen: string[] = [];
      for (const frame of [29, 30, 59, 60]) {
        await page.setContent(previewOverlayAt(preview, frame, 30), { waitUntil: "load" });
        previewSeen.push(await visibility());
      }
      expect(previewSeen).toEqual(["hidden", "visible", "visible", "hidden"]);
      // The preview's fonts are data: URLs; nothing else is requested.
      expect(requests).toBe(0);

      await page.setContent(exported.html, { waitUntil: "load" });
      const exportSeen: string[] = [];
      for (const frame of [29, 30, 59, 60]) {
        await page.evaluate((ms) => {
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = ms;
          }
        }, overlayTimeSeconds(frame, 30) * 1000);
        exportSeen.push(await visibility());
      }
      expect(exportSeen).toEqual(["hidden", "visible", "visible", "hidden"]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
