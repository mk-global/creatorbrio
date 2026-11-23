import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

/**
 * Keywords that are not downloadable families. `font-family: Inter, sans-serif`
 * declares one web font and one generic fallback; only the former is fetched.
 */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);

/** Weights requested for every family. Google clamps to what a family has. */
export const FONT_WEIGHTS = [300, 400, 500, 600, 700, 800] as const;

/**
 * Collects family names out of a block of CSS.
 *
 * The declaration value is captured whole and split afterwards. Trying to match
 * the quotes around a family name in the same pass is what broke the previous
 * implementation: it excluded quote characters from the captured value, so
 * `font-family: 'Cormorant Garamond', serif` - the exact form the system prompt
 * teaches the AI to write - never matched at all.
 */
function collectFromCss(css: string, into: Set<string>): void {
  const declaration = /font-family\s*:\s*([^;}]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(css)) !== null) {
    for (const part of match[1].split(",")) {
      const name = part.trim().replace(/^['"]/, "").replace(/['"]$/, "").trim();
      if (name && !GENERIC_FAMILIES.has(name.toLowerCase())) {
        into.add(name);
      }
    }
  }
}

/**
 * Extract downloadable font family names from slide HTML.
 *
 * Handles quoted and unquoted names, with or without fallbacks, in `<style>`
 * blocks and in inline `style` attributes.
 */
export function extractFontFamilies(html: string): string[] {
  const families = new Set<string>();
  let match: RegExpExecArray | null;

  const styleBlock = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((match = styleBlock.exec(html)) !== null) {
    collectFromCss(match[1], families);
  }

  // Inline styles are pulled out as whole attribute values first. The
  // attribute's own delimiter marks where the value ends, which is what makes
  // a quoted family name inside it unambiguous.
  const styleAttribute = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((match = styleAttribute.exec(html)) !== null) {
    collectFromCss(match[1] ?? match[2] ?? "", families);
  }

  return Array.from(families);
}

/**
 * Whether the slide renders any italic text, and therefore needs the italic
 * cut of its fonts rather than a browser-synthesised slant.
 */
export function usesItalic(html: string): boolean {
  if (/font-style\s*:\s*(italic|oblique)/i.test(html)) return true;
  // `<i` must not match `<img`, `<input` or `<iframe`; `<em` must not match
  // `<embed`.
  return /<(?:em|i)(?=[\s/>])/i.test(html);
}

/**
 * Builds a Google Fonts CSS2 request for one family.
 *
 * Roman and italic are separate requests on purpose. Google answers 400 for the
 * `ital` axis on a family that has no italic design (Bebas Neue and Anton, for
 * example), and one rejected family fails an entire combined request. Asking
 * separately means a family without italics still gets its upright faces.
 */
export function googleFontsUrl(
  family: string,
  options: { italic?: boolean; display?: string } = {}
): string {
  const display = options.display ?? "swap";
  const axis = options.italic
    ? `ital,wght@${FONT_WEIGHTS.map((w) => `1,${w}`).join(";")}`
    : `wght@${FONT_WEIGHTS.join(";")}`;
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family
  )}:${axis}&display=${display}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Whether `name` may be asked of the preview font route (#249): letters and
 * digits in words separated by single spaces, the form of Google Fonts family
 * names, every family the font picker offers among them, and nothing that
 * could change the request the server makes.
 */
export function isFontFamilyName(name: string): boolean {
  return name.length <= 64 && /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(name);
}

/** The preview font route's address for one family, with its italic cut when the slide needs one. */
export function previewFontCssUrl(family: string, italic: boolean): string {
  return `/api/fonts/css?family=${encodeURIComponent(family)}${italic ? "&italic=1" : ""}`;
}

/**
 * The Content-Security-Policy of a preview document (#249). A slide shown in
 * the app loads only from CreatorBrio itself (uploaded images, and its fonts
 * through the preview font route) and from inline `data:` and styles. In the
 * preview's `sandbox=""` frame, whose origin is opaque, Chromium still takes
 * `'self'` to be the app's origin, which `tests/preview-network.test.ts`
 * measures. The app page's own policy applies as well, since a `srcdoc` frame
 * inherits it, so both must allow what a slide loads.
 */
export const PREVIEW_DOCUMENT_CSP =
  "default-src 'none'; img-src 'self' data:; media-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/**
 * Attributes put first in each start tag of a frame or embedded object, which
 * can open a connection when it is shown although the document's policy
 * refuses its load: a frame connects to its host before the refusal. The HTML
 * parser keeps the first of two attributes with the same name, so the slide's
 * own address is dropped while the element keeps its box, as an export's empty
 * frame does.
 */
const INERT_ATTRIBUTES: Record<string, string> = {
  iframe: "src=about:blank srcdoc",
  frame: "src=about:blank",
  object: "data",
  embed: "src",
};

/**
 * Makes the slide's frames, embedded objects and links inert for the preview
 * (#249), by tag name as the HTML tokenizer reads it: ASCII letters in any
 * case, ended by whitespace, `/`, `>` or the end of the slide. Only the
 * document shown is changed; the stored slide is not.
 *
 * A link hint such as `preconnect` is not governed by the policy at all, and an
 * inert `rel` put first did not stop one in Chromium 156 without the policy,
 * since its preload scanner reads links ahead of the parser. So a link is
 * renamed instead, to `basefont`, an obsolete element that the parser treats
 * exactly as it treats `link` (void, never shown) and that does nothing.
 *
 * The inserted text has no quotes and no `>`, so wherever the pattern matches
 * outside a tag (in text or inside an attribute value) it can only add these
 * same inert attributes or rename text.
 */
function inertEmbeddedContent(html: string): string {
  return html.replace(/<(iframe|frame|object|embed|link)(?=[\t\n\f\r />]|$)/gi, (tag, name: string) => {
    const element = name.toLowerCase();
    return element === "link" ? "<basefont" : `${tag} ${INERT_ATTRIBUTES[element]}`;
  });
}

/**
 * Wraps slide body HTML into a full HTML document at the correct dimensions.
 * This is THE shared rendering contract between preview (iframe) and export
 * (Puppeteer).
 */
/**
 * The Content-Security-Policy of an export document (#196): everything a slide
 * shows is inlined before it loads, so only `data:` images, fonts and media
 * and inline styles may load, and nothing else. Frames stay allowed here only
 * so that their navigations reach the export browser's interceptor, which
 * cancels them and leaves the frame empty; a frame the policy refused would
 * show Chromium's error page in the slide instead.
 */
export const EXPORT_DOCUMENT_CSP =
  "default-src 'none'; img-src data:; font-src data:; media-src data:; style-src 'unsafe-inline'; frame-src *; base-uri 'none'; form-action 'none'";

export function wrapSlideHtml(
  slideHtml: string,
  aspectRatio: AspectRatio,
  options?: { inlineFontCss?: string; forExport?: boolean }
): string {
  const { width, height } = DIMENSIONS[aspectRatio];

  let fontBlock = "";
  let body = slideHtml;
  if (options?.forExport) {
    // An export document loads nothing from the network: its fonts are the
    // inlined ones or none, never a stylesheet link, under a policy that
    // refuses anything not inlined.
    fontBlock = [
      `<meta http-equiv="Content-Security-Policy" content="${EXPORT_DOCUMENT_CSP}">`,
      options.inlineFontCss ? `<style>${options.inlineFontCss}</style>` : "",
    ]
      .filter(Boolean)
      .join("\n  ");
  } else if (options?.inlineFontCss) {
    // For export: self-contained base64 @font-face CSS, no network needed.
    fontBlock = `<style>${options.inlineFontCss}</style>`;
  } else {
    // For preview (#249): the preview policy, then one stylesheet per family
    // from CreatorBrio's own font route, which answers with the export's
    // inlined font CSS, the italic cut included when the slide needs one.
    const italic = usesItalic(slideHtml);
    fontBlock = [
      `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_DOCUMENT_CSP}">`,
      ...extractFontFamilies(slideHtml)
        .filter(isFontFamilyName)
        .map((family) => `<link href="${escapeAttribute(previewFontCssUrl(family, italic))}" rel="stylesheet">`),
    ].join("\n  ");
    body = inertEmbeddedContent(slideHtml);
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${width}, initial-scale=1">
  ${fontBlock}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}
