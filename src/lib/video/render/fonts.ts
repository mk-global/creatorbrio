/**
 * The overlay's bundled font (#144): Inter, from the pinned
 * `@fontsource/inter` 5.3.0 package (SIL Open Font License 1.1), latin and
 * latin-ext subsets at weights 400, 700 and 800.
 *
 * The overlay document names it by a private family, so a system-installed
 * Inter (or any other font) can never stand in for it. The export browser is
 * served these bytes from memory at each face's `urlPath` on the overlay
 * origin; the preview document carries the same bytes as `data:` URLs. No
 * user-supplied font ever reaches the overlay.
 *
 * Characters outside latin and latin-ext (emoji, Arabic, Hebrew, CJK and so
 * on) are not in the bundle and are drawn by the browser's system fallback
 * fonts, so their pixels can differ between machines.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FontAsset } from "./execute-types";
import { RenderFailure } from "./execute-types";

/** The private `font-family` name of the bundled font. */
export const OVERLAY_FONT_FAMILY = "CreatorBrio Inter";
/** The family as a CSS `font-family` value. There is deliberately no fallback family, so a font that failed to load is noticed. */
export const OVERLAY_FONT_CSS = `"${OVERLAY_FONT_FAMILY}"`;

export const FONT_PACKAGE = { name: "@fontsource/inter", version: "5.3.0" } as const;
const SOURCE = `${FONT_PACKAGE.name}@${FONT_PACKAGE.version}`;

/**
 * Each subset's `unicode-range`, exactly as `@fontsource/inter` 5.3.0 declares
 * it (its CSS and `unicode.json`). `bundledFonts()` checks the installed
 * package still says the same, so these can be emitted without reading it.
 */
const UNICODE_RANGES = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
} as const;

export const FONT_WEIGHTS = [400, 700, 800] as const;

export interface BundledFace {
  /** Where the overlay document requests it, e.g. `/fonts/inter-latin-800-normal.woff2`. */
  urlPath: string;
  /** The file's name in the package's `files/` folder. */
  file: string;
  weight: (typeof FONT_WEIGHTS)[number];
  unicodeRange: string;
}

export const BUNDLED_FACES: readonly BundledFace[] = Object.freeze(
  (Object.keys(UNICODE_RANGES) as (keyof typeof UNICODE_RANGES)[]).flatMap((subset) =>
    FONT_WEIGHTS.map((weight) => {
      const file = `inter-${subset}-${weight}-normal.woff2`;
      return { urlPath: `/fonts/${file}`, file, weight, unicodeRange: UNICODE_RANGES[subset] };
    })
  )
);

/** The bundled face served at `urlPath`, or undefined for anything that is not one. */
export function bundledFace(urlPath: string): BundledFace | undefined {
  return BUNDLED_FACES.find((face) => face.urlPath === urlPath);
}

let cached: Promise<FontAsset[]> | null = null;

/**
 * The bundled faces with their bytes and SHA-256, read once per process from
 * `node_modules/@fontsource/inter` under the working directory. A read
 * failure is not cached, so a later render retries.
 *
 * Fails with `RenderFailure("configuration", "font_bundle_missing")` when the
 * package or a face cannot be read, and `"font_bundle_mismatch"` when the
 * installed package is not 5.3.0 or declares other unicode ranges.
 */
export function bundledFonts(): Promise<FontAsset[]> {
  if (!cached) {
    // Runtime data, not build input: the ignore comment stops Next.js tracing the whole project.
    const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "node_modules", "@fontsource", "inter");
    cached = loadBundledFonts(dir);
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

/** Reads the bundled faces from a `@fontsource/inter` package folder. Exported for tests. */
export async function loadBundledFonts(packageDir: string): Promise<FontAsset[]> {
  const read = async (...parts: string[]): Promise<Buffer> => {
    try {
      return await readFile(path.join(/*turbopackIgnore: true*/ packageDir, ...parts));
    } catch {
      throw new RenderFailure("configuration", "font_bundle_missing", `the bundled font package ${SOURCE} is not installed or incomplete`);
    }
  };
  const mismatch = () => new RenderFailure("configuration", "font_bundle_mismatch", `the installed font package is not ${SOURCE}`);
  const parse = (bytes: Buffer): unknown => {
    try {
      return JSON.parse(bytes.toString("utf-8"));
    } catch {
      throw mismatch();
    }
  };

  const pkg = parse(await read("package.json")) as { name?: unknown; version?: unknown } | null;
  if (pkg?.name !== FONT_PACKAGE.name || pkg?.version !== FONT_PACKAGE.version) throw mismatch();
  const ranges = parse(await read("unicode.json")) as Record<string, unknown> | null;
  for (const [subset, range] of Object.entries(UNICODE_RANGES)) {
    if (ranges?.[subset] !== range) throw mismatch();
  }

  const fonts: FontAsset[] = [];
  for (const face of BUNDLED_FACES) {
    const bytes = await read("files", face.file);
    fonts.push({
      urlPath: face.urlPath,
      family: OVERLAY_FONT_FAMILY,
      weight: face.weight,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source: SOURCE,
    });
  }
  return fonts;
}
