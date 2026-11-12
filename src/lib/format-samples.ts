import type { BrandConfig } from "@/types/brand";
import { FORMATS, type ProjectFormat } from "@/lib/formats";

/**
 * A sample first slide for each format in a brand's colours and fonts (#175),
 * shown where the brand has no project of that format yet: Home's format
 * stage and the New project flow. It is ordinary slide HTML, rendered by the
 * same sandboxed preview as real slides, and never saved anywhere.
 */

const HEX = /^#[0-9a-f]{3,8}$/i;

function colour(value: string, fallback: string): string {
  return HEX.test(value) ? value : fallback;
}

/** A font family name safe inside a CSS string: no quotes, backslashes or markup. */
function family(name: string): string {
  return name.replace(/["'\\<>;{}]/g, "").trim() || "Inter";
}

export function sampleSlideHtml(format: ProjectFormat, brand: Pick<BrandConfig, "colors" | "fonts">): string {
  const primary = colour(brand.colors.primary, "#1a1a2e");
  const accent = colour(brand.colors.accent, "#e94560");
  const background = colour(brand.colors.background, "#ffffff");
  const surface = colour(brand.colors.surface, "#f5f5f5");
  const heading = `font-family:'${family(brand.fonts.heading)}',sans-serif`;
  const body = `font-family:'${family(brand.fonts.body)}',sans-serif`;
  const { width, height } = { width: 1080, height: FORMATS[format].defaultSize === "9:16" ? 1920 : 1350 };

  if (format === "reel-cover") {
    return `<div style="width:${width}px;height:${height}px;background:${primary};color:${background};display:flex;flex-direction:column;justify-content:center;padding:120px;box-sizing:border-box">
<div style="width:120px;height:14px;background:${accent};margin-bottom:56px"></div>
<h1 style="${heading};font-size:150px;line-height:1;margin:0;font-weight:700">Watch this first</h1>
<p style="${body};font-size:44px;margin:48px 0 0;opacity:.85">A 30-second guide</p>
</div>`;
  }
  if (format === "linkedin-document") {
    return `<div style="width:${width}px;height:${height}px;background:${background};color:${primary};padding:110px;box-sizing:border-box;display:flex;flex-direction:column">
<p style="${body};font-size:34px;margin:0;color:${accent};font-weight:700">A short guide</p>
<h1 style="${heading};font-size:120px;line-height:1.02;margin:40px 0 0;font-weight:700">How our process works</h1>
<div style="margin-top:auto;display:flex;flex-direction:column;gap:22px">
<div style="height:22px;width:86%;background:${surface}"></div>
<div style="height:22px;width:72%;background:${surface}"></div>
<div style="height:22px;width:64%;background:${surface}"></div>
</div>
</div>`;
  }
  return `<div style="width:${width}px;height:${height}px;background:${primary};color:${background};padding:110px;box-sizing:border-box;display:flex;flex-direction:column">
<p style="${body};font-size:36px;margin:0;opacity:.8">1 / 5</p>
<h1 style="${heading};font-size:132px;line-height:1;margin:auto 0 0;font-weight:700">Five things we learned this year</h1>
<div style="width:160px;height:16px;background:${accent};margin-top:64px"></div>
</div>`;
}
