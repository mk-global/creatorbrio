import { describe, it, expect } from "vitest";
import {
  extractFontFamilies,
  usesItalic,
  googleFontsUrl,
  wrapSlideHtml,
  EXPORT_DOCUMENT_CSP,
  PREVIEW_DOCUMENT_CSP,
} from "@/lib/slide-html";

describe("extractFontFamilies", () => {
  // The single-quoted-with-fallback form is what the system prompt teaches the
  // AI to write, and it is the form the previous implementation missed
  // entirely, so every real slide rendered in a system fallback instead of the
  // brand font.
  const cases: [string, string, string[]][] = [
    [
      "single-quoted with fallback",
      `<div style="font-family: 'Cormorant Garamond', serif">x</div>`,
      ["Cormorant Garamond"],
    ],
    [
      "double-quoted with fallback",
      `<div style='font-family: "Cormorant Garamond", serif'>x</div>`,
      ["Cormorant Garamond"],
    ],
    [
      "unquoted with fallback",
      `<div style="font-family: Cormorant Garamond, serif">x</div>`,
      ["Cormorant Garamond"],
    ],
    [
      "single-quoted, no fallback",
      `<div style="font-family: 'Inter'">x</div>`,
      ["Inter"],
    ],
    [
      "double-quoted, no fallback",
      `<div style='font-family: "Inter"'>x</div>`,
      ["Inter"],
    ],
    ["unquoted, no fallback", `<div style="font-family: Inter">x</div>`, ["Inter"]],
    [
      "style block, single-quoted with fallback",
      `<style>h1 { font-family: 'Playfair Display', serif; }</style>`,
      ["Playfair Display"],
    ],
    [
      "style block, double-quoted with fallback",
      `<style>h1 { font-family: "Playfair Display", serif }</style>`,
      ["Playfair Display"],
    ],
    [
      "style block, unquoted, last declaration in rule",
      `<style>h1 { color: red; font-family: Playfair Display, serif }</style>`,
      ["Playfair Display"],
    ],
    [
      "no space after colon",
      `<div style="font-family:'Inter',sans-serif">x</div>`,
      ["Inter"],
    ],
    [
      "declaration followed by another declaration",
      `<div style="font-family: 'Inter', sans-serif; font-size: 72px">x</div>`,
      ["Inter"],
    ],
  ];

  for (const [name, html, expected] of cases) {
    it(`extracts from ${name}`, () => {
      expect(extractFontFamilies(html)).toEqual(expected);
    });
  }

  it("keeps every distinct family and drops generic keywords", () => {
    const html = `
      <style>h1 { font-family: 'Cormorant Garamond', serif; }</style>
      <p style="font-family: 'Inter', sans-serif">a</p>
      <p style="font-family: Inter, system-ui, monospace">b</p>
      <p style="font-family: inherit">c</p>
    `;
    expect(extractFontFamilies(html).sort()).toEqual([
      "Cormorant Garamond",
      "Inter",
    ]);
  });

  it("finds nothing when no family is declared", () => {
    expect(extractFontFamilies("<div>plain</div>")).toEqual([]);
  });

  it("reads the families used by a real generated slide", () => {
    const slide = `<div style="width:1080px;height:1350px;background:#F7F4EF;padding:90px;display:flex;flex-direction:column;justify-content:center">
      <h1 style="font-family:'Cormorant Garamond',serif;font-size:96px;font-weight:300;color:#2E2E2E">You're not lazy.</h1>
      <p style="font-family:'Inter',sans-serif;font-size:26px;color:#8A8A8A">Why women are tired all the time</p>
    </div>`;
    expect(extractFontFamilies(slide).sort()).toEqual([
      "Cormorant Garamond",
      "Inter",
    ]);
  });
});

describe("usesItalic", () => {
  it("detects an italic font-style declaration", () => {
    expect(usesItalic(`<span style="font-style: italic">x</span>`)).toBe(true);
    expect(usesItalic(`<style>em { font-style:oblique; }</style>`)).toBe(true);
  });

  it("detects italic markup", () => {
    expect(usesItalic("<em>x</em>")).toBe(true);
    expect(usesItalic("<i>x</i>")).toBe(true);
    expect(usesItalic('<i class="icon"></i>')).toBe(true);
  });

  it("does not mistake other tags for italics", () => {
    expect(usesItalic('<img src="/uploads/a.png">')).toBe(false);
    expect(usesItalic('<input value="x">')).toBe(false);
    expect(usesItalic("<iframe></iframe>")).toBe(false);
    expect(usesItalic("<embed>")).toBe(false);
    expect(usesItalic(`<div style="font-style: normal">x</div>`)).toBe(false);
  });
});

describe("googleFontsUrl", () => {
  it("requests weights for the upright cut", () => {
    const url = googleFontsUrl("Cormorant Garamond");
    expect(url).toContain("family=Cormorant%20Garamond");
    expect(url).toContain("wght@300;400;500;600;700;800");
    expect(url).not.toContain("ital");
  });

  it("requests only italic entries for the italic cut", () => {
    const url = googleFontsUrl("Inter", { italic: true });
    expect(url).toContain("ital,wght@1,300;1,400;1,500;1,600;1,700;1,800");
  });

  it("can request a specific font-display strategy", () => {
    expect(googleFontsUrl("Inter", { display: "block" })).toContain(
      "display=block"
    );
  });
});

describe("wrapSlideHtml font loading", () => {
  const slide = `<h1 style="font-family: 'Cormorant Garamond', serif">Hook</h1>`;

  it("links the family the slide declares from CreatorBrio's own font route, never from Google (#249)", () => {
    const doc = wrapSlideHtml(slide, "4:5");
    expect(doc).toContain(`<link href="/api/fonts/css?family=Cormorant%20Garamond" rel="stylesheet">`);
    expect(doc).not.toContain("fonts.googleapis.com");
  });

  it("requests one stylesheet per family so one rejection cannot break the rest", () => {
    const twoFamilies = `
      <h1 style="font-family: 'Cormorant Garamond', serif">a</h1>
      <p style="font-family: 'Inter', sans-serif">b</p>`;
    const doc = wrapSlideHtml(twoFamilies, "4:5");
    expect(doc.match(/<link /g)).toHaveLength(2);
  });

  it("asks for the italic cut only when the slide renders italics", () => {
    expect(wrapSlideHtml(slide, "4:5")).not.toContain("italic=1");

    const italicSlide = `<h1 style="font-family: 'Cormorant Garamond', serif"><em>Hook</em></h1>`;
    const doc = wrapSlideHtml(italicSlide, "4:5");
    expect(doc).toContain(`<link href="/api/fonts/css?family=Cormorant%20Garamond&amp;italic=1" rel="stylesheet">`);
    expect(doc.match(/<link /g)).toHaveLength(1);
  });

  it("does not link a family name the font route would refuse", () => {
    const doc = wrapSlideHtml(`<p style="font-family: 'Inter', 'a/b', 'x&y'">a</p>`, "4:5");
    expect(doc.match(/<link /g)).toHaveLength(1);
    expect(doc).toContain("family=Inter");
  });

  it("uses inlined CSS instead of network links when exporting", () => {
    const doc = wrapSlideHtml(slide, "4:5", {
      inlineFontCss: "@font-face{font-family:'Cormorant Garamond';src:url(data:font/woff2;base64,AA)}",
    });
    expect(doc).not.toContain("fonts.googleapis.com");
    expect(doc).toContain("@font-face");
  });

  it("still applies the aspect ratio's exact pixel dimensions", () => {
    const doc = wrapSlideHtml(slide, "9:16");
    expect(doc).toContain("width: 1080px");
    expect(doc).toContain("height: 1920px");
  });
});

describe("wrapSlideHtml preview document (#249)", () => {
  const head = (doc: string) => doc.slice(0, doc.indexOf("<body>"));
  const body = (doc: string) => doc.slice(doc.indexOf("<body>"));

  it("carries the preview policy in its head, and an export document carries only the export policy", () => {
    const preview = wrapSlideHtml("<p>x</p>", "1:1");
    expect(head(preview)).toContain(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_DOCUMENT_CSP}">`);
    expect(PREVIEW_DOCUMENT_CSP).toBe(
      "default-src 'none'; img-src 'self' data:; media-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    );
    const exported = wrapSlideHtml("<p>x</p>", "1:1", { forExport: true });
    expect(exported).toContain(EXPORT_DOCUMENT_CSP);
    expect(exported).not.toContain(PREVIEW_DOCUMENT_CSP);
  });

  it("puts inert attributes first in each frame, object and embed start tag, and renames each link, in any letter case", () => {
    const slideHtml = [
      `<iframe src="https://example.test/a" width="300" height="200"></iframe>`,
      `<IfRaMe\nSRC="https://example.test/b"></IfRaMe>`,
      `<iframe/src="https://example.test/c">`,
      `<frame src="https://example.test/d">`,
      `<object data="https://example.test/e" width="10"></object>`,
      `<EMBED src="https://example.test/f">`,
      `<LINK rel="preconnect" href="https://example.test">`,
      `<link>`,
    ].join("");
    expect(body(wrapSlideHtml(slideHtml, "1:1"))).toContain(
      [
        `<iframe src=about:blank srcdoc src="https://example.test/a" width="300" height="200"></iframe>`,
        `<IfRaMe src=about:blank srcdoc\nSRC="https://example.test/b"></IfRaMe>`,
        `<iframe src=about:blank srcdoc/src="https://example.test/c">`,
        `<frame src=about:blank src="https://example.test/d">`,
        `<object data data="https://example.test/e" width="10"></object>`,
        `<EMBED src src="https://example.test/f">`,
        `<basefont rel="preconnect" href="https://example.test">`,
        `<basefont>`,
      ].join("")
    );
  });

  it("matches only those tag names, and a start tag cut off by the end of the slide", () => {
    const others = `<frameset><iframes><linked><objects><embedded><img src="/uploads/a.png"><p>iframe link</p>`;
    expect(body(wrapSlideHtml(others, "1:1"))).toContain(others);
    expect(body(wrapSlideHtml("<p>x</p><iframe", "1:1"))).toContain("<p>x</p><iframe src=about:blank srcdoc\n</body>");
  });

  it("leaves the slide unchanged in an export document, whose browser keeps frames empty itself", () => {
    const slideHtml = `<iframe src="https://example.test/a"></iframe><link rel="preconnect" href="https://example.test">`;
    expect(wrapSlideHtml(slideHtml, "1:1", { forExport: true })).toContain(slideHtml);
  });
});
