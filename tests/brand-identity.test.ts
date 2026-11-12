/**
 * CreatorBrio Brand Identity v1.0 (#189): the product palette is declared once,
 * every documented value equals it, its pairings meet WCAG AA, the logo and
 * browser icons are the brand's, and the product identity never reaches a
 * person's brand, their slides or their exports.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "@/components/ui/button";
import { PRODUCT_PALETTE, type ProductColor } from "@/lib/brand-identity";
import { sampleSlideHtml } from "@/lib/format-samples";
import { PROJECT_FORMATS } from "@/lib/formats";
import { wrapSlideHtml } from "@/lib/slide-html";
import { cn } from "@/lib/utils";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const css = read("src/app/globals.css");
const guide = read("docs/brand/CREATORBRIO-BRAND-GUIDELINES.md");
const specimen = read("docs/brand/specimen.html");

/** The CSS variable each palette entry is declared as, and its name in the guide. */
const NAMES: Record<ProductColor, { variable: string; name: string }> = {
  coral: { variable: "--brand-coral", name: "Brand Coral" },
  deepCoral: { variable: "--brand-deep-coral", name: "Deep Coral" },
  ink: { variable: "--brand-ink", name: "Midnight Ink" },
  canvas: { variable: "--brand-canvas", name: "Studio Canvas" },
  paper: { variable: "--brand-paper", name: "Pure Paper" },
  blush: { variable: "--brand-blush", name: "Soft Blush" },
  graphite: { variable: "--brand-graphite", name: "Graphite" },
  rule: { variable: "--brand-rule", name: "Fine Rule" },
};
const KEYS = Object.keys(PRODUCT_PALETTE) as ProductColor[];

function declared(variable: string): string {
  const m = new RegExp(`${variable}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!m) throw new Error(`${variable} is not declared as a hex value in globals.css`);
  return m[1].toUpperCase();
}

/** WCAG 2.x contrast ratio of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function filesUnder(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(rel, ext));
    else if (ext.test(entry.name)) out.push(rel);
  }
  return out;
}

describe("the product palette", () => {
  it("is declared once in globals.css and equals PRODUCT_PALETTE", () => {
    for (const key of KEYS) {
      expect(declared(NAMES[key].variable), NAMES[key].name).toBe(PRODUCT_PALETTE[key]);
      const occurrences = css.toUpperCase().split(PRODUCT_PALETTE[key]).length - 1;
      expect(occurrences, `${PRODUCT_PALETTE[key]} should appear once in globals.css`).toBe(1);
    }
  });

  it("is what the brand guide and the specimen state", () => {
    for (const key of KEYS) {
      const { name } = NAMES[key];
      const hex = PRODUCT_PALETTE[key];
      expect(guide, `guide row for ${name}`).toMatch(new RegExp(`\\|\\s*${name}\\s*\\|\\s*\`${hex}\``, "i"));
      expect(specimen, `specimen swatch for ${name}`).toMatch(new RegExp(`data-token="${NAMES[key].variable}"[^>]*data-hex="${hex}"`, "i"));
    }
  });

  it("is used through tokens: no component or page hardcodes a palette value", () => {
    const sources = [...filesUnder("src/components", /\.(tsx?|css)$/), ...filesUnder("src/app", /\.(tsx?|css)$/)].filter((f) => !f.endsWith("globals.css"));
    for (const file of sources) {
      const text = read(file).toUpperCase();
      for (const key of KEYS) {
        // Pure Paper (#FFFFFF) is also a person's default colour value in inputs; only the brand colours are checked.
        if (key === "paper") continue;
        expect(text.includes(PRODUCT_PALETTE[key]), `${file} hardcodes ${NAMES[key].name}`).toBe(false);
      }
      // Midnight Ink written as channels, for a shadow or a tint, is still the palette.
      expect(text, `${file} writes Midnight Ink as rgb()`).not.toMatch(/RGBA?\(\s*28[\s,_]+27[\s,_]+41\b/);
    }
    // Inside globals.css only the palette declaration itself may carry a raw value for these.
    expect(css, "globals.css writes white or ink outside the palette").not.toMatch(/#fff\b|rgba?\(\s*28[\s,_]+27[\s,_]+41\b/i);
  });

  it("routes the theme and the older role tokens through the palette", () => {
    for (const [token, variable] of [
      ["--color-ground", "--brand-canvas"],
      ["--color-sheet", "--brand-paper"],
      ["--color-ink", "--brand-ink"],
      ["--color-graphite", "--brand-graphite"],
      ["--color-rule", "--brand-rule"],
      ["--color-crop", "--brand-coral"],
      ["--color-create", "--brand-deep-coral"],
      ["--color-blush", "--brand-blush"],
      ["--background", "--brand-canvas"],
      ["--foreground", "--brand-ink"],
      ["--accent", "--brand-ink"],
    ]) {
      expect(css, token).toMatch(new RegExp(`\\s${token}:\\s*var\\(${variable}\\);`));
    }
  });
});

describe("colour accessibility (WCAG 2.2 AA)", () => {
  const P = PRODUCT_PALETTE;
  const alert = declared("--color-alert");
  const alertBg = declared("--color-alert-bg");

  it("keeps text at 4.5:1 or more on every surface it is set on", () => {
    for (const surface of [P.canvas, P.paper, P.blush]) {
      expect(contrast(P.ink, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(P.graphite, surface)).toBeGreaterThanOrEqual(4.5);
    }
    // The create button's label, and Deep Coral used as emphasised text.
    expect(contrast(P.paper, P.deepCoral)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(P.deepCoral, P.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(P.deepCoral, P.canvas)).toBeGreaterThanOrEqual(4.5);
    // The destructive button's label on paper and on its hover surface.
    expect(contrast(alert, P.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(alert, alertBg)).toBeGreaterThanOrEqual(4.5);
  });

  it("publishes a contrast table that the declared tokens reproduce, each row meeting its own bar", () => {
    const tokens: Record<string, string> = {
      "Midnight Ink": P.ink,
      "Pure Paper": P.paper,
      "Studio Canvas": P.canvas,
      "Soft Blush": P.blush,
      Graphite: P.graphite,
      "Deep Coral": P.deepCoral,
      "Brand Coral": P.coral,
      Alert: alert,
      "Alert surface": alertBg,
      Placeholder: declared("--color-placeholder"),
      "Field edge": declared("--color-field"),
      Success: declared("--color-ok"),
      "Success surface": declared("--color-ok-bg"),
      Early: declared("--color-early"),
      "Early surface": declared("--color-early-bg"),
      Warning: declared("--warning"),
      "Warning surface": declared("--warning-surface"),
      Hover: declared("--color-hover"),
    };
    const section = guide.slice(guide.indexOf("### Accessibility"), guide.indexOf("## Typography"));
    const rows = [...section.matchAll(/^\| ([^|]+?) \| ([\d.]+):1 \| ([^|]+?) \|$/gm)];
    expect(rows.length, "rows in the guide's contrast table").toBeGreaterThanOrEqual(20);
    for (const [, pairing, stated, verdict] of rows) {
      const [fg, bg] = pairing.replace(/\s*\(.*\)$/, "").split(" on ");
      expect(tokens[fg] && tokens[bg], `known colours in "${pairing}"`).toBeTruthy();
      const ratio = contrast(tokens[fg], tokens[bg]);
      expect(ratio.toFixed(2), pairing).toBe(Number(stated).toFixed(2));
      if (verdict === "Text") expect(ratio, pairing).toBeGreaterThanOrEqual(4.5);
      else if (/only/.test(verdict)) expect(ratio, pairing).toBeGreaterThanOrEqual(3);
      else expect(ratio, pairing).toBeLessThan(4.5);
    }
  });

  it("keeps Brand Coral indicators and the create button's edge at 3:1 or more", () => {
    for (const surface of [P.canvas, P.paper, P.blush, P.ink]) expect(contrast(P.coral, surface)).toBeGreaterThanOrEqual(3);
    // The create button on the ink summary bar of the New project flow.
    expect(contrast(P.deepCoral, P.ink)).toBeGreaterThanOrEqual(3);
  });

  it("never puts text on a Brand Coral fill, which white text cannot pass", () => {
    expect(contrast(P.paper, P.coral)).toBeLessThan(4.5);
    for (const file of [...filesUnder("src/components", /\.tsx$/), ...filesUnder("src/app", /\.tsx$/)]) {
      // Any class string that fills with Brand Coral, wherever its text- class sits.
      for (const [classes] of read(file).matchAll(/["'`][^"'`]*\bbg-crop\b(?!\/)[^"'`]*["'`]/g)) {
        expect(classes, `${file} sets text on a Brand Coral fill`).not.toMatch(/\btext-(?!\[?\d|xs|sm|base|lg|xl|\dxl|left|right|center)/);
      }
    }
    const fills = [...css.matchAll(/\{[^}]*background:\s*var\(--color-crop\)[^}]*\}/g)];
    expect(fills, "a rule fills a box with Brand Coral").toHaveLength(0);
  });
});

describe("action hierarchy", () => {
  const rule = (selector: string) => {
    const m = new RegExp(`\\s${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css);
    if (!m) throw new Error(`${selector} is not defined`);
    return m[1];
  };

  it("fills creation with Deep Coral and keeps the general primary action ink", () => {
    expect(rule(".btn-create")).toMatch(/background:\s*var\(--color-create\)/);
    expect(rule(".btn-primary")).toMatch(/background:\s*var\(--color-ink\)/);
  });

  it("draws a destructive action as an outline, never a fill that could read as create", () => {
    const danger = rule(".btn-danger");
    expect(danger).toMatch(/background:\s*var\(--color-sheet\)/);
    expect(danger).toMatch(/color:\s*var\(--color-alert\)/);
    expect(read("src/components/ui/button.tsx")).not.toMatch(/destructive:\s*"bg-destructive\b/);
  });

  it("uses the create action only where new work starts, and only as often as it should", () => {
    const uses: Record<string, number> = {};
    // Every file that renders a create action; the variant's own definition is not a use.
    for (const f of [...filesUnder("src/components", /\.tsx$/), ...filesUnder("src/app", /\.tsx$/)].filter((f) => f !== path.normalize("src/components/ui/button.tsx"))) {
      const n = read(f).match(/\bbtn-create\b|variant="create"/g)?.length ?? 0;
      if (n) uses[f] = n;
    }
    expect(uses).toEqual(
      Object.fromEntries(
        Object.entries({
          // New project in the wide sidebar, the rail and the phone tab bar.
          "src/components/app/Shell.tsx": 3,
          // Home's "Set up project" from an idea.
          "src/app/(app)/page.tsx": 1,
          // "Start a project" in the empty library.
          "src/app/(app)/projects/page.tsx": 1,
          // "New brand".
          "src/app/(app)/brands/page.tsx": 1,
          // "Create brand", only while making a new one; editing saves in ink.
          "src/components/brands/BrandEditor.tsx": 1,
          // "Create and open editor" on the summary bar.
          "src/components/create/CreateFlow.tsx": 1,
          // The Studio's "Create" for a new production.
          "src/components/studio/ProductionPickerCreate.tsx": 1,
        }).map(([f, n]) => [path.normalize(f), n]),
      ),
    );
  });

  it("turns a disabled create action flat grey, never faded coral", () => {
    // The classes a create Button actually renders, after the base's disabled fade is merged away.
    const classes = cn(buttonVariants({ variant: "create" })).split(" ");
    expect(classes).toEqual(expect.arrayContaining(["disabled:opacity-100", "disabled:bg-hover", "disabled:text-graphite"]));
    expect(classes).not.toContain("disabled:opacity-50");
    expect(rule(".btn-create:disabled")).toMatch(/background:\s*var\(--color-hover\)/);
  });
});

describe("logo and browser icons", () => {
  const ASSETS = [
    "creatorbrio-logo.svg",
    "creatorbrio-logo-dark.svg",
    "creatorbrio-logo-mono.svg",
    "creatorbrio-logo-mono-white.svg",
    "creatorbrio-logo-compact.svg",
    "creatorbrio-logo-compact-dark.svg",
    "creatorbrio-logo-compact-mono.svg",
    "creatorbrio-logo-compact-mono-white.svg",
    "creatorbrio-mark.svg",
    "creatorbrio-mark-dark.svg",
    "creatorbrio-mark-mono.svg",
    "creatorbrio-mark-mono-white.svg",
    "creatorbrio-app-icon.svg",
    "creatorbrio-favicon.svg",
  ];

  it("ships every variant as a self-contained SVG with the crop-mark mark", () => {
    for (const name of ASSETS) {
      const svg = read(`docs/brand/assets/${name}`);
      expect(svg, name).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d. ]+"/);
      expect(svg, name).toContain("<title>CreatorBrio</title>");
      // Outlined: no live text, no font, nothing fetched.
      expect(svg, name).not.toMatch(/<text|font-family|href=|url\(/);
      expect(svg, name).toMatch(/M2 7V2h5M23 2h5v5M28 23v5h-5M7 28H2v-5|M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4/);
    }
    expect(read("docs/brand/assets/creatorbrio-logo.svg")).toContain(PRODUCT_PALETTE.coral);
    expect(read("docs/brand/assets/creatorbrio-logo-mono.svg")).not.toContain(PRODUCT_PALETTE.coral);
  });

  it("serves the brand's icons, not the scaffold's", () => {
    expect(read("src/app/icon.svg")).toBe(read("docs/brand/assets/creatorbrio-favicon.svg"));
    const ico = readFileSync(path.join(ROOT, "src/app/favicon.ico"));
    expect(ico.readUInt16LE(2), "an icon resource").toBe(1);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
    expect(sizes).toEqual([16, 32, 48]);
    const apple = readFileSync(path.join(ROOT, "src/app/apple-icon.png"));
    expect([apple.readUInt32BE(16), apple.readUInt32BE(20)]).toEqual([180, 180]);
    for (const scaffold of ["file.svg", "globe.svg", "next.svg", "vercel.svg", "window.svg"]) {
      expect(existsSync(path.join(ROOT, "public", scaffold)), scaffold).toBe(false);
    }
    expect(statSync(path.join(ROOT, "docs/brand/assets/creatorbrio-app-icon-512.png")).size).toBeGreaterThan(0);
  });
});

describe("CreatorBrio's identity never reaches a person's brand", () => {
  // Three synthetic brands whose palettes and fonts clash with CreatorBrio's and with each other.
  const BRANDS = [
    { colors: { primary: "#2B1D14", secondary: "#6B4A33", accent: "#E0A458", background: "#FBF6EF", surface: "#EFE4D6" }, fonts: { heading: "Fraunces", body: "Inter" } },
    { colors: { primary: "#F4F4FF", secondary: "#39FF14", accent: "#FF00A8", background: "#120024", surface: "#2A0A4A" }, fonts: { heading: "Space Grotesk", body: "JetBrains Mono" } },
    { colors: { primary: "#12355B", secondary: "#2F6690", accent: "#FF7F50", background: "#FFFFFF", surface: "#E8F1F8" }, fonts: { heading: "DM Serif Display", body: "DM Sans" } },
  ];
  const productHex = KEYS.filter((k) => k !== "paper").map((k) => PRODUCT_PALETTE[k]);

  it("draws each brand's samples only in that brand's colours and fonts", () => {
    for (const brand of BRANDS) {
      for (const format of PROJECT_FORMATS) {
        const html = sampleSlideHtml(format, brand).toUpperCase();
        expect(html).toContain(brand.colors.primary);
        expect(html).toContain(brand.colors.accent);
        expect(html).toContain(brand.fonts.heading.toUpperCase());
        for (const hex of productHex) expect(html, `${format} sample contains ${hex}`).not.toContain(hex);
        expect(html).not.toMatch(/INSTRUMENT|GEIST|--BRAND-|--COLOR-/);
      }
    }
  });

  it("wraps slides for preview and export without any product colour or font", () => {
    const wrapped = wrapSlideHtml(sampleSlideHtml("instagram-carousel", BRANDS[1]), "4:5").toUpperCase();
    for (const hex of productHex) expect(wrapped).not.toContain(hex);
    expect(wrapped).not.toMatch(/INSTRUMENT SANS|GEIST|--BRAND-|--COLOR-CROP|--COLOR-CREATE/);
  });

  it("keeps the product palette out of everything that renders or instructs a person's work", () => {
    const userWork = [
      "src/lib/slide-html.ts",
      "src/lib/format-samples.ts",
      "src/lib/chat-system-prompt.ts",
      ...filesUnder("src/lib/video/render", /\.tsx?$/),
      ...filesUnder("src/lib/video/capabilities", /\.tsx?$/),
      ...filesUnder("src/app/api", /\.tsx?$/),
    ];
    for (const file of userWork) {
      const text = read(file);
      expect(text, file).not.toMatch(/brand-identity|PRODUCT_PALETTE|--brand-|--color-create|--color-blush/);
    }
  });
});
