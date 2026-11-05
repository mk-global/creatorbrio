import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { googleFontsUrl } from "./slide-html";

const FONT_CACHE_DIR = path.resolve(process.cwd(), "data", ".font-cache");

// In-memory cache (survives across requests, lost on restart)
const memoryCache = new Map<string, string>();

// Google serves woff2 only to browsers that advertise support for it.
const WOFF2_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Chrome 60 reads woff2 but predates variable fonts, so Google answers it with
// one static woff2 per weight instead of one variable file for all of them.
const STATIC_WOFF2_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.113 Safari/537.36";

/**
 * Which font files to inline. `variable` is what the preview and the PNG
 * export render with. `static` asks for one instance per weight, drawn from
 * the same design: Chromium embeds a variable font in a PDF as Type 3 glyph
 * outlines, whose text some readers (Apple's PDFKit, behind Preview and
 * Safari) break into fragments, while a static font embeds as TrueType.
 */
export type FontInstances = "variable" | "static";

/**
 * Fetch Google Fonts CSS with inlined base64 woff2 data URIs.
 * This creates a fully self-contained CSS string that works without network access.
 *
 * When `italic` is requested the italic cut is fetched as a second, separate
 * request per family. Google rejects the italic axis for families that have no
 * italic design, and that rejection must not cost the family its upright faces.
 */
export async function getInlinedFontCSS(
  families: string[],
  options: { italic?: boolean; instances?: FontInstances } = {}
): Promise<string> {
  if (families.length === 0) return "";

  const instances = options.instances ?? "variable";
  const parts: string[] = [];

  for (const family of families) {
    const roman = await cssFor(family, false, instances);
    if (roman) parts.push(roman);

    if (options.italic) {
      const italic = await cssFor(family, true, instances);
      // Absent when the family has no italic design. The upright faces above
      // still apply and the browser synthesises a slant, which is the best
      // available result for that family.
      if (italic) parts.push(italic);
    }
  }

  return parts.join("\n");
}

/**
 * Static instances when asked for, else the variable font. A static request
 * Google cannot answer falls back to the variable font: the right typeface
 * with Type 3 text beats a system font in its place.
 */
async function cssFor(
  family: string,
  italic: boolean,
  instances: FontInstances
): Promise<string | null> {
  if (instances === "static") {
    const css = await cssForVariant(family, italic, "static");
    if (css) return css;
  }
  return cssForVariant(family, italic, "variable");
}

async function cssForVariant(
  family: string,
  italic: boolean,
  instances: FontInstances
): Promise<string | null> {
  const key = italic ? `${family}::italic` : family;

  const cached = await getCachedFont(key, instances);
  if (cached !== null) return cached;

  try {
    const css = await fetchAndInlineFont(family, italic, instances);
    if (css) {
      await cacheFont(key, instances, css);
      return css;
    }
  } catch {
    // Font not available - skip silently, system font fallback will be used
  }
  return null;
}

/**
 * Variable fonts keep the cache's original location; static instances live in
 * their own folder, so the two can never be mistaken for each other.
 */
function cacheDir(instances: FontInstances): string {
  return instances === "static" ? path.join(FONT_CACHE_DIR, "static") : FONT_CACHE_DIR;
}

/**
 * Cache file name for a variant key.
 *
 * Family names come from AI-authored slide HTML, so they are reduced to safe
 * characters rather than interpolated into a path as-is.
 */
function cacheFileName(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || "font"}.css`;
}

async function getCachedFont(
  key: string,
  instances: FontInstances
): Promise<string | null> {
  const memoryKey = `${instances}::${key}`;
  if (memoryCache.has(memoryKey)) {
    return memoryCache.get(memoryKey)!;
  }

  try {
    const diskPath = path.join(cacheDir(instances), cacheFileName(key));
    const css = await readFile(diskPath, "utf-8");
    memoryCache.set(memoryKey, css);
    return css;
  } catch {
    return null;
  }
}

async function cacheFont(
  key: string,
  instances: FontInstances,
  css: string
): Promise<void> {
  memoryCache.set(`${instances}::${key}`, css);
  try {
    await mkdir(cacheDir(instances), { recursive: true });
    const diskPath = path.join(cacheDir(instances), cacheFileName(key));
    await writeFile(diskPath, css, "utf-8");
  } catch {
    // Disk cache write failed - not critical
  }
}

async function fetchAndInlineFont(
  family: string,
  italic: boolean,
  instances: FontInstances
): Promise<string | null> {
  const url = googleFontsUrl(family, { italic, display: "block" });
  const response = await fetch(url, {
    headers: {
      "User-Agent": instances === "static" ? STATIC_WOFF2_USER_AGENT : WOFF2_USER_AGENT,
    },
  });

  // 400 here means the family has no such cut. That is an expected answer, not
  // an error, and the caller treats a null result as "nothing to add".
  if (!response.ok) return null;
  let css = await response.text();

  // Find all url() references to woff2 files and inline them
  const urlRegex = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g;
  const matches = [...css.matchAll(urlRegex)];

  for (const match of matches) {
    const fontUrl = match[1];
    try {
      const fontResponse = await fetch(fontUrl);
      if (!fontResponse.ok) continue;
      const buffer = await fontResponse.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      css = css.replace(fontUrl, `data:font/woff2;base64,${base64}`);
    } catch {
      // Keep the original URL - Puppeteer can still fetch it
    }
  }

  // Ensure font-display: block for deterministic rendering
  css = css.replace(/font-display:\s*swap/g, "font-display: block");

  return css;
}
