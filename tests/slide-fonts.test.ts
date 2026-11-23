import { describe, it, expect } from "vitest";
import {
  extractFontFamilies,
  usesItalic,
  googleFontsUrl,
  wrapSlideHtml,
  EXPORT_DOCUMENT_CSP,
  previewDocumentCsp,
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

/** The app's origin as the browser reports it (`window.location.origin`), for a preview document. */
const APP_ORIGIN = "http://localhost:3000";
const PREVIEW = { previewOrigin: APP_ORIGIN };

describe("wrapSlideHtml font loading", () => {
  const slide = `<h1 style="font-family: 'Cormorant Garamond', serif">Hook</h1>`;

  it("links the family the slide declares from CreatorBrio's own font route, never from Google (#249)", () => {
    const doc = wrapSlideHtml(slide, "4:5", PREVIEW);
    expect(doc).toContain(`<link href="/api/fonts/css?family=Cormorant%20Garamond" rel="stylesheet">`);
    expect(doc).not.toContain("fonts.googleapis.com");
  });

  it("requests one stylesheet per family so one rejection cannot break the rest", () => {
    const twoFamilies = `
      <h1 style="font-family: 'Cormorant Garamond', serif">a</h1>
      <p style="font-family: 'Inter', sans-serif">b</p>`;
    const doc = wrapSlideHtml(twoFamilies, "4:5", PREVIEW);
    expect(doc.match(/<link /g)).toHaveLength(2);
  });

  it("asks for the italic cut only when the slide renders italics", () => {
    expect(wrapSlideHtml(slide, "4:5", PREVIEW)).not.toContain("italic=1");

    const italicSlide = `<h1 style="font-family: 'Cormorant Garamond', serif"><em>Hook</em></h1>`;
    const doc = wrapSlideHtml(italicSlide, "4:5", PREVIEW);
    expect(doc).toContain(`<link href="/api/fonts/css?family=Cormorant%20Garamond&amp;italic=1" rel="stylesheet">`);
    expect(doc.match(/<link /g)).toHaveLength(1);
  });

  it("does not link a family name the font route would refuse", () => {
    const doc = wrapSlideHtml(`<p style="font-family: 'Inter', 'a/b', 'x&y'">a</p>`, "4:5", PREVIEW);
    expect(doc.match(/<link /g)).toHaveLength(1);
    expect(doc).toContain("family=Inter");
  });

  it("uses inlined CSS instead of network links when exporting", () => {
    const doc = wrapSlideHtml(slide, "4:5", {
      inlineFontCss: "@font-face{font-family:'Cormorant Garamond';src:url(data:font/woff2;base64,AA)}",
      forExport: true,
    });
    expect(doc).not.toContain("fonts.googleapis.com");
    expect(doc).toContain("@font-face");
  });

  it("still applies the aspect ratio's exact pixel dimensions", () => {
    const doc = wrapSlideHtml(slide, "9:16", PREVIEW);
    expect(doc).toContain("width: 1080px");
    expect(doc).toContain("height: 1920px");
  });
});

describe("wrapSlideHtml preview document (#249)", () => {
  const head = (doc: string) => doc.slice(0, doc.indexOf("<body>"));
  const body = (doc: string) => doc.slice(doc.indexOf("<body>"));

  it("carries the preview policy for the app's origin in its head, and an export document carries only the export policy", () => {
    const preview = wrapSlideHtml("<p>x</p>", "1:1", PREVIEW);
    expect(head(preview)).toContain(`<meta http-equiv="Content-Security-Policy" content="${previewDocumentCsp(APP_ORIGIN)}">`);
    expect(previewDocumentCsp(APP_ORIGIN)).toBe(
      "default-src 'none'; img-src http://localhost:3000 data:; media-src http://localhost:3000 data:; font-src http://localhost:3000 data:; style-src http://localhost:3000 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    );
    const exported = wrapSlideHtml("<p>x</p>", "1:1", { forExport: true });
    expect(exported).toContain(EXPORT_DOCUMENT_CSP);
    expect(exported).not.toContain(previewDocumentCsp(APP_ORIGIN));
  });

  it("names the app's exact origin in the preview policy and never 'self', which only some browsers read as the app in a sandboxed frame", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:41873", "https://creatorbrio.example", "http://localhost"]) {
      const policy = previewDocumentCsp(origin);
      expect(policy).not.toContain("'self'");
      for (const directive of ["img-src", "media-src", "font-src", "style-src"]) {
        expect(policy).toContain(`${directive} ${origin} `);
      }
      expect(wrapSlideHtml("<p>x</p>", "1:1", { previewOrigin: origin })).not.toContain("'self'");
    }
  });

  it("refuses to build a preview policy from anything but an http or https origin", () => {
    for (const origin of ["", "null", "'self'", "http://localhost:3000/", "http://localhost:3000/a", "localhost:3000", "http://a b", "http://a;b", "http://a'b", "http://[::1]:3000", "ftp://localhost", "http://localhost:3000 *"]) {
      expect(() => previewDocumentCsp(origin), origin).toThrow(/origin/);
    }
    // Written for a caller outside the type system, which gives no origin.
    expect(() => wrapSlideHtml("<p>x</p>", "1:1", {} as never)).toThrow(/origin/);
    expect(() => wrapSlideHtml("<p>x</p>", "1:1", { inlineFontCss: "p{}" } as never)).toThrow(/origin/);
  });

  it("turns DNS prefetch off in the head, before the policy and the slide", () => {
    const preview = wrapSlideHtml(`<meta http-equiv="x-dns-prefetch-control" content="on"><a href="https://example.test/">x</a>`, "1:1", PREVIEW);
    const off = `<meta http-equiv="x-dns-prefetch-control" content="off">`;
    expect(head(preview)).toContain(off);
    expect(preview.indexOf(off)).toBeLessThan(preview.indexOf("Content-Security-Policy"));
    expect(preview.indexOf(off)).toBeLessThan(preview.indexOf(`content="on"`));
    expect(wrapSlideHtml("<p>x</p>", "1:1", { forExport: true })).not.toContain("x-dns-prefetch-control");
  });

  it("puts inert attributes first in each frame, object, embed, image and source start tag, ends them with an attribute of their own, and renames each link, in any letter case", () => {
    const slideHtml = [
      `<iframe src="https://example.test/a" width="300" height="200"></iframe>`,
      `<IfRaMe\nSRC="https://example.test/b"></IfRaMe>`,
      `<iframe/src="https://example.test/c">`,
      `<frame src="https://example.test/d">`,
      `<object data="https://example.test/e" width="10"></object>`,
      `<EMBED src="https://example.test/f">`,
      `<LINK rel="preconnect" href="https://example.test">`,
      `<link>`,
      `<img srcset="https://example.test/g 1x" src="/uploads/a.png" width="40">`,
      `<IMG\nSrcSet="https://example.test/h 1x" sizes="10px">`,
      `<picture><source srcset="https://example.test/i"><img/srcset="https://example.test/j"></picture>`,
      `<SOURCE media="(min-width: 1px)" srcset="https://example.test/k">`,
      `<img>`,
      `<IMAGE srcset="https://example.test/l 1x">`,
      `<svg><image href="https://example.test/m"/></svg>`,
    ].join("");
    expect(body(wrapSlideHtml(slideHtml, "1:1", PREVIEW))).toContain(
      [
        `<iframe src=about:blank srcdoc data-inert src="https://example.test/a" width="300" height="200"></iframe>`,
        `<IfRaMe src=about:blank srcdoc data-inert\nSRC="https://example.test/b"></IfRaMe>`,
        `<iframe src=about:blank srcdoc data-inert/src="https://example.test/c">`,
        `<frame src=about:blank data-inert src="https://example.test/d">`,
        `<object data data-inert data="https://example.test/e" width="10"></object>`,
        `<EMBED src data-inert src="https://example.test/f">`,
        `<basefont rel="preconnect" href="https://example.test">`,
        `<basefont>`,
        `<img srcset data-inert srcset="https://example.test/g 1x" src="/uploads/a.png" width="40">`,
        `<IMG srcset data-inert\nSrcSet="https://example.test/h 1x" sizes="10px">`,
        `<picture><source srcset data-inert srcset="https://example.test/i"><img srcset data-inert/srcset="https://example.test/j"></picture>`,
        `<SOURCE srcset data-inert media="(min-width: 1px)" srcset="https://example.test/k">`,
        `<img srcset data-inert>`,
        `<IMAGE srcset data-inert srcset="https://example.test/l 1x">`,
        `<svg><image srcset data-inert href="https://example.test/m"/></svg>`,
      ].join("")
    );
  });

  it("ends the inserted text in an attribute of its own, after every delimiter a tag name can have", () => {
    const inserted: Record<string, string> = {
      iframe: "src=about:blank srcdoc data-inert",
      frame: "src=about:blank data-inert",
      object: "data data-inert",
      embed: "src data-inert",
      img: "srcset data-inert",
      image: "srcset data-inert",
      source: "srcset data-inert",
    };
    // What may follow a tag name: whitespace of every kind, a slash, `>` or the end of the slide.
    const followers = [" ", "\t", "\n", "\f", "\r", "/", ">", ""];
    for (const [tag, text] of Object.entries(inserted)) {
      for (const follower of followers) {
        for (const rest of [`="https://example.test/x 1x"`, `\n="&lt;link rel=preconnect href=https://example.test&gt;"`, ` = x`, ``]) {
          // A tag name is ended by what follows it, so nothing follows only when the slide ends or whitespace comes next.
          if (follower === "" && rest !== "" && !/^\s/.test(rest)) continue;
          const slideHtml = `<${tag}${follower}${rest}`;
          const out = body(wrapSlideHtml(slideHtml, "1:1", PREVIEW));
          expect(out, JSON.stringify(slideHtml)).toContain(`<${tag} ${text}${follower}${rest}`);
        }
        // Mixed case, and two matches in one start tag (the second is inside an attribute value).
        if (follower === "") continue;
        const mixed = `<${tag.toUpperCase()}${follower}="a" title="<${tag}${follower}b">`;
        const out = body(wrapSlideHtml(mixed, "1:1", PREVIEW));
        expect(out, JSON.stringify(mixed)).toContain(`<${tag.toUpperCase()} ${text}${follower}="a" title="<${tag} ${text}${follower}b">`);
      }
    }
    const start = body(wrapSlideHtml(`<iframe ="&lt;img src=https://example.test/x&gt;">`, "1:1", PREVIEW));
    expect(start).toContain(`<iframe src=about:blank srcdoc data-inert ="&lt;img src=https://example.test/x&gt;">`);
  });

  it("matches only those tag names, and a start tag cut off by the end of the slide", () => {
    const others = `<frameset><iframes><linked><objects><embedded><images><imgs><sources><p>iframe link img image source</p>`;
    expect(body(wrapSlideHtml(others, "1:1", PREVIEW))).toContain(others);
    expect(body(wrapSlideHtml("<p>x</p><iframe", "1:1", PREVIEW))).toContain("<p>x</p><iframe src=about:blank srcdoc data-inert\n</body>");
    expect(body(wrapSlideHtml("<p>x</p><img", "1:1", PREVIEW))).toContain("<p>x</p><img srcset data-inert\n</body>");
  });

  it("leaves the slide unchanged in an export document, whose browser keeps frames empty itself", () => {
    const slideHtml = `<iframe src="https://example.test/a"></iframe><link rel="preconnect" href="https://example.test">`;
    expect(wrapSlideHtml(slideHtml, "1:1", { forExport: true })).toContain(slideHtml);
  });
});
