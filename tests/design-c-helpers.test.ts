import { afterEach, describe, expect, it, vi } from "vitest";
import { editedPhrase } from "@/lib/relative-time";
import { sampleSlideHtml } from "@/lib/format-samples";
import { exportFormatsFor } from "@/lib/export-formats";
import { FORMATS, PROJECT_FORMATS, SIZE_NAMES, countLabel, sizePixels } from "@/lib/formats";
import { clearDraft, clearIdea, handOffDraft, handOffIdea, readDraft, readIdea } from "@/lib/new-project-handoff";

// The pure helpers behind the Design C screens (#175): how an edit time is
// worded, the sample slides drawn for a brand, the Export menu's order, the
// words a format uses for its length and sizes, and the tab-local handoff of
// an idea from Home to the editor's message box.

describe("editedPhrase", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it.each([
    [10_000, "just now"],
    [60_000, "1 minute ago"],
    [12 * 60_000, "12 minutes ago"],
    [60 * 60_000, "1 hour ago"],
    [5 * 3_600_000, "5 hours ago"],
    [30 * 3_600_000, "yesterday"],
    [3 * 86_400_000, "3 days ago"],
  ])("words %i ms ago as %s", (ms, phrase) => {
    expect(editedPhrase(ago(ms), now)).toBe(phrase);
  });

  it("gives a date for anything older than a week, with the year only when it differs", () => {
    expect(editedPhrase("2026-11-03T12:00:00Z", now)).toBe("on 3 Nov");
    expect(editedPhrase("2025-11-03T12:00:00Z", now)).toBe("on 3 Nov 2025");
  });

  it("never shows NaN for a damaged timestamp", () => {
    expect(editedPhrase("not a date", now)).toBe("at an unknown time");
  });
});

describe("sampleSlideHtml", () => {
  const brand = {
    colors: { primary: "#112233", secondary: "#000000", accent: "#ff6600", background: "#ffffff", surface: "#eeeeee" },
    fonts: { heading: "Fraunces", body: "Inter" },
  };

  it("draws every format in the brand's colours and fonts, at the format's own size", () => {
    for (const format of PROJECT_FORMATS) {
      const html = sampleSlideHtml(format, brand);
      expect(html).toContain("#112233");
      expect(html).toContain("#ff6600");
      expect(html).toContain("'Fraunces'");
      expect(html).toContain(FORMATS[format].defaultSize === "9:16" ? "height:1920px" : "height:1350px");
      expect(html).not.toMatch(/<script/i);
    }
  });

  it("refuses colour and font values that would break out of the style attribute", () => {
    const hostile = {
      colors: { ...brand.colors, primary: 'red;"><img src=x onerror=alert(1)>', accent: "url(javascript:x)" },
      fonts: { heading: `Evil'</style><script>alert(1)</script>`, body: `"; background:url(x)` },
    };
    const html = sampleSlideHtml("instagram-carousel", hostile);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("url(");
    expect(html).toContain("#1a1a2e");
    expect(html).toContain("#e94560");
  });

  it("falls back to a generic family when a font name is nothing but stripped characters", () => {
    const html = sampleSlideHtml("reel-cover", { colors: brand.colors, fonts: { heading: `"'<>`, body: "Inter" } });
    expect(html).toContain("font-family:'Inter'");
  });
});

describe("exportFormatsFor", () => {
  const formats = (n: number, primary?: Parameters<typeof exportFormatsFor>[1]) => exportFormatsFor(n, primary).map((o) => o.format);

  it("keeps the original order without a primary format", () => {
    expect(formats(3)).toEqual(["png", "pdf"]);
    expect(formats(1)).toEqual(["png", "pdf", "single-png"]);
  });

  it("puts the format's main export first and removes nothing", () => {
    expect(formats(3, "pdf")).toEqual(["pdf", "png"]);
    expect(formats(1, "single-png")).toEqual(["single-png", "png", "pdf"]);
  });

  it("ignores a primary that this slide count cannot offer", () => {
    expect(formats(2, "single-png")).toEqual(["png", "pdf"]);
  });
});

describe("format words", () => {
  it("counts in the format's own unit", () => {
    expect(countLabel("instagram-carousel", 1)).toBe("1 slide");
    expect(countLabel("instagram-carousel", 6)).toBe("6 slides");
    expect(countLabel("linkedin-document", 1)).toBe("1 page");
    expect(countLabel("linkedin-document", 8)).toBe("8 pages");
    expect(countLabel("reel-cover", 0)).toBe("0 slides");
  });

  it("names every size and gives its exported pixels", () => {
    expect(SIZE_NAMES).toEqual({ "4:5": "Portrait", "1:1": "Square", "9:16": "Story" });
    expect(sizePixels("4:5")).toBe("1080 × 1350");
    expect(sizePixels("1:1")).toBe("1080 × 1080");
    expect(sizePixels("9:16")).toBe("1080 × 1920");
  });
});

describe("new project handoff", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubSession(store = new Map<string, string>()) {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    return store;
  }

  it("does nothing on the server, where there is no window", () => {
    expect(() => handOffIdea("x")).not.toThrow();
    expect(readIdea()).toBe("");
  });

  it("reads without removing, so a doubled render still sees the words, and clears on demand", () => {
    stubSession();
    handOffIdea("A launch post");
    expect(readIdea()).toBe("A launch post");
    expect(readIdea()).toBe("A launch post");
    clearIdea();
    expect(readIdea()).toBe("");
  });

  it("keeps each project's draft separate", () => {
    const store = stubSession();
    handOffDraft("a", "first");
    handOffDraft("b", "second");
    expect(readDraft("a")).toBe("first");
    clearDraft("a");
    expect(readDraft("a")).toBe("");
    expect(readDraft("b")).toBe("second");
    expect([...store.keys()]).toEqual(["creatorbrio:draft:b"]);
  });

  it("survives storage that throws, as a blocked or full sessionStorage does", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("full");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(() => handOffIdea("x")).not.toThrow();
    expect(readIdea()).toBe("");
    expect(() => clearIdea()).not.toThrow();
  });
});
