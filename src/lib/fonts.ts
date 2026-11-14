import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { googleFontsUrl } from "./slide-html";

const FONT_CACHE_DIR = path.resolve(process.cwd(), "data", ".font-cache");

// In-memory cache (survives across requests, lost on restart)
const memoryCache = new Map<string, string>();

/**
 * Bounds on fetching a font for an export (#200). A request is abandoned when
 * nothing arrives for `stallMs`, headers or body, rather than after a fixed
 * total: a slow but working download keeps going (a CJK family's static
 * instances are over a thousand files and took 77 s on a good connection),
 * while a server that accepts the connection and never answers costs one
 * stall. That stall, or a connection that fails, marks the font source
 * unreachable for `unreachableMs`, during which every font request falls back
 * at once instead of waiting out a stall of its own.
 */
export const fontFetchLimits = {
  stallMs: 10_000,
  unreachableMs: 60_000,
};

/** Until when font requests fall back without trying, after the font source stopped answering. */
let unreachableUntil = 0;

/** Font variants being fetched, so slides exported together share one download. */
const inFlight = new Map<string, Promise<string | null>>();

/** The font source did not answer in time, or could not be reached. */
class FontSourceUnreachable extends Error {
  constructor() {
    super("The font source did not answer");
    this.name = "FontSourceUnreachable";
  }
}

/**
 * Fetches `url`, abandoning it when no headers or body bytes arrive for
 * `fontFetchLimits.stallMs`. A stall or a failed connection marks the font
 * source unreachable; an HTTP error status is an answer and does not.
 */
async function fetchFontResource(
  url: string,
  headers?: Record<string, string>
): Promise<{ ok: boolean; bytes: Buffer }> {
  if (Date.now() < unreachableUntil) throw new FontSourceUnreachable();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progressed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), fontFetchLimits.stallMs);
  };
  progressed();
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    progressed();
    const chunks: Uint8Array[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        progressed();
      }
    }
    return { ok: response.ok, bytes: Buffer.concat(chunks) };
  } catch {
    if (Date.now() >= unreachableUntil) {
      console.warn(
        `[fonts] the font source did not answer within ${fontFetchLimits.stallMs / 1000} s or could not be reached; ` +
          `exports use fallback fonts for the next ${fontFetchLimits.unreachableMs / 1000} s`
      );
    }
    unreachableUntil = Date.now() + fontFetchLimits.unreachableMs;
    throw new FontSourceUnreachable();
  } finally {
    clearTimeout(timer);
  }
}

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
 * Google cannot answer, or answers with fewer weights or styles than the
 * variable font has, falls back to the variable font: the right typeface with
 * Type 3 text beats a system font or a synthesised weight in its place.
 */
async function cssFor(
  family: string,
  italic: boolean,
  instances: FontInstances
): Promise<string | null> {
  const variable = await cssForVariant(family, italic, "variable");
  if (instances === "static") {
    const css = await cssForVariant(family, italic, "static");
    // Google can answer with fewer cuts than the variable font has (Roboto
    // Flex, for one, offers only its regular weight as a static file); the
    // slide would then print in a synthesised weight, so the variable font
    // is kept instead.
    if (css && (variable === null || coversFaces(css, variable))) return css;
  }
  return variable;
}

interface FaceRange {
  style: string;
  min: number;
  max: number;
}

/** The style and weight range of each `@font-face` rule in Google's CSS. */
function faceRanges(css: string): FaceRange[] {
  return css
    .split("@font-face")
    .slice(1)
    .map((rule) => {
      const style = rule.match(/font-style:\s*([a-z]+)/)?.[1] ?? "normal";
      const [min, max = min] = (rule.match(/font-weight:\s*([\d\s]+)[;}]/)?.[1] ?? "400")
        .trim()
        .split(/\s+/)
        .map(Number);
      return { style, min, max };
    });
}

/**
 * Whether the static answer has a face for every style and every weight, in
 * steps of 100, that the variable answer covers.
 */
function coversFaces(staticCss: string, variableCss: string): boolean {
  const available = faceRanges(staticCss);
  return faceRanges(variableCss).every(({ style, min, max }) => {
    const weights = [min, max];
    for (let w = Math.ceil(min / 100) * 100; w <= max; w += 100) weights.push(w);
    return weights.every((w) => available.some((f) => f.style === style && f.min <= w && w <= f.max));
  });
}

async function cssForVariant(
  family: string,
  italic: boolean,
  instances: FontInstances
): Promise<string | null> {
  const key = italic ? `${family}::italic` : family;

  const cached = await getCachedFont(key, instances);
  if (cached !== null) return cached;

  const memoryKey = `${instances}::${key}`;
  const pending = inFlight.get(memoryKey);
  if (pending) return pending;
  const fetching = (async () => {
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
  })();
  inFlight.set(memoryKey, fetching);
  try {
    return await fetching;
  } finally {
    inFlight.delete(memoryKey);
  }
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
  const response = await fetchFontResource(url, {
    "User-Agent": instances === "static" ? STATIC_WOFF2_USER_AGENT : WOFF2_USER_AGENT,
  });

  // 400 here means the family has no such cut. That is an expected answer, not
  // an error, and the caller treats a null result as "nothing to add".
  if (!response.ok) return null;
  let css = response.bytes.toString("utf-8");

  // Find all url() references to woff2 files and inline them
  const urlRegex = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g;
  const matches = [...css.matchAll(urlRegex)];

  // Every file must be inlined: the export page loads nothing from the network,
  // so a file that could not be fetched makes the whole variant unavailable,
  // rendered with the fallback font and never cached half-inlined (#200).
  for (const match of matches) {
    const fontUrl = match[1];
    const fontResponse = await fetchFontResource(fontUrl);
    if (!fontResponse.ok) return null;
    const base64 = fontResponse.bytes.toString("base64");
    css = css.replace(fontUrl, `data:font/woff2;base64,${base64}`);
  }

  // Ensure font-display: block for deterministic rendering
  css = css.replace(/font-display:\s*swap/g, "font-display: block");

  return css;
}
