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
 * Whether `origin` is what `window.location.origin` is for the app: `http` or
 * `https`, a host name or IPv4 address, and an optional port, with no path.
 * Nothing else may reach a Content-Security-Policy.
 */
const APP_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

/**
 * The Content-Security-Policy of a preview document (#249). A slide shown in
 * the app loads only from CreatorBrio itself (uploaded images, and its fonts
 * through the preview font route) and from inline `data:` and styles.
 *
 * CreatorBrio is named by its exact origin, never by `'self'`. The preview's
 * `sandbox=""` frame has an opaque origin, and what `'self'` then means is
 * left to each browser, so the policy states the origin itself, which the
 * caller takes from `window.location.origin`. The app page's own policy
 * applies as well, since a `srcdoc` frame inherits it, so both must allow what
 * a slide loads.
 */
export function previewDocumentCsp(origin: string): string {
  if (!APP_ORIGIN.test(origin)) {
    throw new Error("A preview document needs the app's origin, such as http://localhost:3000.");
  }
  return `default-src 'none'; img-src ${origin} data:; media-src ${origin} data:; font-src ${origin} data:; style-src ${origin} 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
}

/**
 * Turns off DNS prefetch for the preview document. It is placed before the
 * slide, and a declaration in the slide does not turn it back on.
 */
const DNS_PREFETCH_OFF = `<meta http-equiv="x-dns-prefetch-control" content="off">`;

/**
 * Attributes put first in each start tag of a frame, embedded object, image or
 * picture source. The HTML parser keeps the first of two attributes with the
 * same name, so the slide's own address or candidate list is dropped while the
 * element keeps its box, as an export's empty frame does. An image keeps its
 * `src`. The parser reads an `image` start tag in HTML as `img`, so it takes
 * the same attribute, which an SVG `image` ignores.
 */
const INERT_ATTRIBUTES: Record<string, string> = {
  iframe: "src=about:blank srcdoc",
  frame: "src=about:blank",
  object: "data",
  embed: "src",
  img: "srcset",
  image: "srcset",
  source: "srcset",
};

/** The attribute that ends the text inserted into a start tag. */
const INERT_END = "data-inert";

/**
 * Makes the slide's frames, embedded objects, image candidate lists and links
 * inert for the preview (#249), by tag name as the HTML tokenizer reads it:
 * ASCII letters in any case, ended by whitespace, `/`, `>` or the end of the
 * slide. Only the document shown is changed; the stored slide is not.
 *
 * A link is renamed to `basefont`, an obsolete element that the parser treats
 * exactly as it treats `link` (void, never shown) and that does nothing.
 *
 * The inserted text is `INERT_ATTRIBUTES` and then `INERT_END`, separated by
 * spaces, with no quotes, no `<` or `>`, and no `=` except in the fixed
 * `src=about:blank` of a frame's attributes. It ends in an attribute of its
 * own, `INERT_END`, so a value that follows in the slide belongs to that
 * attribute and never to an inert one. Wherever the pattern matches outside a
 * tag (in text or inside an attribute value) it can only add these same
 * attributes or rename text.
 */
function inertEmbeddedContent(html: string): string {
  return html.replace(/<(iframe|frame|object|embed|img|image|source|link)(?=[\t\n\f\r />]|$)/gi, (tag, name: string) => {
    const element = name.toLowerCase();
    return element === "link" ? "<basefont" : `${tag} ${INERT_ATTRIBUTES[element]} ${INERT_END}`;
  });
}

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

/**
 * How a slide document is built. An export carries its fonts inlined and loads
 * nothing; a preview names the app's origin, which only the browser knows
 * (`window.location.origin`), so every caller of the preview form passes it
 * once it has mounted.
 */
export type SlideDocumentOptions =
  | { forExport: true; inlineFontCss?: string }
  | { forExport?: false; previewOrigin: string };

/**
 * Wraps slide body HTML into a full HTML document at the correct dimensions.
 * This is THE shared rendering contract between preview (iframe) and export
 * (Puppeteer).
 */
export function wrapSlideHtml(slideHtml: string, aspectRatio: AspectRatio, options: SlideDocumentOptions): string {
  const { width, height } = DIMENSIONS[aspectRatio];

  let fontBlock: string;
  let body = slideHtml;
  if (options.forExport) {
    // An export document loads nothing from the network: its fonts are the
    // inlined ones or none, never a stylesheet link, under a policy that
    // refuses anything not inlined.
    fontBlock = [
      `<meta http-equiv="Content-Security-Policy" content="${EXPORT_DOCUMENT_CSP}">`,
      options.inlineFontCss ? `<style>${options.inlineFontCss}</style>` : "",
    ]
      .filter(Boolean)
      .join("\n  ");
  } else {
    // For preview (#249): DNS prefetch off, the preview policy for the app's
    // origin, then one stylesheet per family from CreatorBrio's own font
    // route, which answers with the export's inlined font CSS, the italic cut
    // included when the slide needs one.
    const italic = usesItalic(slideHtml);
    fontBlock = [
      DNS_PREFETCH_OFF,
      `<meta http-equiv="Content-Security-Policy" content="${previewDocumentCsp(options.previewOrigin)}">`,
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
