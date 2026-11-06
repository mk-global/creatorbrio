/**
 * Ids and names the Studio page makes (#150): production and clip ids that
 * match the document's id pattern and never collide with an id the
 * production uses, names checked as the document will check them, and the
 * production list's order.
 */
import { describe, expect, it } from "vitest";

import { ID_PATTERN } from "@/lib/video/production/primitives";
import { newEditProduction } from "@/lib/video/production/new-production";
import { admitProduction } from "@/lib/video/production";
import { checkProductionName, cryptoRandom, newClipId, newProductionId, PRODUCTION_NAME_MAX, sortProductions, STUDIO_ID_PATTERN, usedIds } from "@/lib/video/studio/production-ids";
import type { ProductionSummary } from "@/lib/video/studio/types";

const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe("Studio ids", () => {
  it("uses the document's id pattern", () => {
    expect(STUDIO_ID_PATTERN.source).toBe(ID_PATTERN.source);
  });

  it("makes production ids from the time and six random base36 characters", () => {
    expect(newProductionId(0, sequence(0))).toBe("prod-0-000000");
    expect(newProductionId(1_762_387_200_000, sequence(0.5, 0.999))).toBe(`prod-${(1_762_387_200_000).toString(36)}-iziziz`);
    for (let i = 0; i < 200; i++) expect(newProductionId(Date.now(), cryptoRandom)).toMatch(ID_PATTERN);
  });

  it("makes production ids the store admits", () => {
    const id = newProductionId(Date.now(), cryptoRandom);
    expect(admitProduction(newEditProduction({ id, name: "A name", at: new Date().toISOString() })).ok).toBe(true);
  });

  it("makes clip ids the production does not use yet", () => {
    const taken = new Set(["clip-0-0000", "clip-0-1111"]);
    // The first two candidates collide, the third does not.
    expect(newClipId(taken, 0, sequence(0, 0, 0, 0, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 2 / 36, 2 / 36, 2 / 36, 2 / 36))).toBe("clip-0-2222");
    for (let i = 0; i < 200; i++) expect(newClipId(taken, Date.now(), cryptoRandom)).toMatch(ID_PATTERN);
  });

  it("collects every id a new clip must not reuse", () => {
    const p = newEditProduction({ id: "p", name: "P", at: "2026-01-01T00:00:00.000Z" });
    expect([...usedIds(p)].sort()).toEqual(["t-captions", "t-footage", "t-images", "t-music", "t-titles"]);
  });
});

describe("production names", () => {
  it("trims, requires and bounds the name", () => {
    expect(checkProductionName("  Launch teaser ")).toEqual({ ok: true, name: "Launch teaser" });
    expect(checkProductionName("   ")).toEqual({ ok: false, message: expect.stringContaining("name") });
    expect(checkProductionName("x".repeat(PRODUCTION_NAME_MAX))).toEqual({ ok: true, name: "x".repeat(PRODUCTION_NAME_MAX) });
    expect(checkProductionName("x".repeat(PRODUCTION_NAME_MAX + 1))).toEqual({ ok: false, message: "Use at most 120 characters." });
    expect(checkProductionName("a\tb")).toEqual({ ok: false, message: expect.stringContaining("tabs") });
  });

  it("accepts only names the document admits", () => {
    for (const name of ["Spring launch", "x".repeat(PRODUCTION_NAME_MAX), "\u{1F3AC}".repeat(60), "Ünïcødé – teaser"]) {
      const checked = checkProductionName(name);
      expect(checked.ok).toBe(true);
      if (checked.ok) expect(admitProduction(newEditProduction({ id: "p", name: checked.name, at: "2026-01-01T00:00:00.000Z" })).ok).toBe(true);
    }
  });
});

describe("the production list", () => {
  it("lists openable productions newest change first, then damaged or incomplete ones", () => {
    const ok = (productionId: string, updatedAt: string): ProductionSummary => ({ productionId, status: "ok", name: productionId, revision: 1, generation: 1, updatedAt, runId: null });
    const list: ProductionSummary[] = [
      { productionId: "broken", status: "corrupt", message: "unreadable" },
      ok("old", "2026-01-01T00:00:00.000Z"),
      { productionId: "aborted", status: "incomplete", message: "creation did not finish" },
      ok("new", "2026-03-01T00:00:00.000Z"),
      ok("b-tie", "2026-02-01T00:00:00.000Z"),
      ok("a-tie", "2026-02-01T00:00:00.000Z"),
    ];
    expect(sortProductions(list).map((p) => p.productionId)).toEqual(["new", "a-tie", "b-tie", "old", "aborted", "broken"]);
  });
});
