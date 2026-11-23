import { NextResponse } from "next/server";
import { getInlinedFontCSS } from "@/lib/fonts";
import { isFontFamilyName } from "@/lib/slide-html";

// Fonts are fetched and cached while the app runs, so this is never prerendered.
export const dynamic = "force-dynamic";

/**
 * The CSS being built for each family and cut. Every slide frame on a page asks
 * for its fonts at once, and until the first answer is cached each would
 * otherwise fetch the whole family again.
 */
const building = new Map<string, Promise<string>>();

/**
 * The `@font-face` CSS of one Google Fonts family for a slide preview (#249):
 * the export's own inlined CSS from `getInlinedFontCSS()`, with its cache and
 * fetch limits, so a preview loads its fonts from CreatorBrio and never from
 * an outside server. `?family=` is one family name, refused unless
 * `isFontFamilyName()` accepts it; `&italic=1` adds the italic cut. A family
 * that cannot be fetched answers empty CSS, and the slide shows its fallback
 * font, as the export does.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const families = params.getAll("family");
  const italic = params.getAll("italic");
  const valid =
    families.length === 1 &&
    isFontFamilyName(families[0]) &&
    (italic.length === 0 || (italic.length === 1 && italic[0] === "1")) &&
    [...params.keys()].every((key) => key === "family" || key === "italic");
  if (!valid) {
    return new NextResponse("Invalid font family", { status: 400, headers: { "Content-Type": "text/plain" } });
  }

  const key = `${families[0]}${italic.length === 1 ? "::italic" : ""}`;
  let pending = building.get(key);
  if (!pending) {
    pending = getInlinedFontCSS(families, { italic: italic.length === 1 }).finally(() => building.delete(key));
    building.set(key, pending);
  }
  const css = await pending;
  return new NextResponse(css, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      // An empty answer is a family Google does not have, or a font source
      // that could not be reached, so the next preview asks again.
      "Cache-Control": css ? "max-age=300" : "no-store",
    },
  });
}
