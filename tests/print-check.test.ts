import { describe, it, expect } from "vitest";
import { comparableCharacters, hasClosedShadowRoot } from "@/lib/print-check";

// readPrintableText runs inside Chromium and is covered by the render suite;
// what runs in Node is covered here.

const counts = (text: string) => Object.fromEntries(comparableCharacters(text));

describe("comparableCharacters", () => {
  it("counts letters and digits, folding case, accents and ligatures, and drops the rest", () => {
    expect(counts("Café, ﬁne 10!")).toEqual({ c: 1, a: 1, f: 2, e: 2, i: 1, n: 1, "1": 1, "0": 1 });
    expect(counts("CAFÉ")).toEqual(counts("café"));
  });

  it("compares text however it was cased for display", () => {
    expect(counts("Straße")).toEqual(counts("STRASSE"));
    // Final sigma lower-cases differently depending on what follows it.
    expect(counts("Στόχος")).toEqual(counts("ΣΤΌΧΟΣΜΆΘΕΤΕ".slice(0, 6)));
    expect(counts("στόχοςμάθετε")).toEqual(counts("ΣΤΌΧΟΣΜΆΘΕΤΕ"));
  });

  it("counts repeated characters, so one place cannot stand in for another", () => {
    expect(comparableCharacters("提高 提高").get("提")).toBe(2);
  });

  it("leaves out emoji, keycaps included, which print as pictures", () => {
    expect(counts("Step 1️⃣ 🚀 2️ #️⃣")).toEqual(counts("Step"));
  });
});

describe("hasClosedShadowRoot", () => {
  it("finds a closed root anywhere, frames included, and ignores browser-internal ones", () => {
    expect(hasClosedShadowRoot({ children: [{ shadowRoots: [{ shadowRootType: "user-agent" }, { shadowRootType: "open" }] }] })).toBe(false);
    expect(hasClosedShadowRoot({ children: [{ contentDocument: { children: [{ shadowRoots: [{ shadowRootType: "closed" }] }] } }] })).toBe(true);
  });
});
