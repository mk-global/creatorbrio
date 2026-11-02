import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BRIEF_LIMITS,
  EMPTY_BRIEF_UPDATE,
  briefForCarousel,
  emptyBrief,
  mergeBrief,
  validateBriefUpdate,
  type BriefUpdate,
  type CreativeBrief,
} from "@/lib/creative-brief";
import { createCarousel, duplicateCarousel, getCarousel, setCreativeBrief } from "@/lib/carousels";
import { PUT as putCarousel } from "@/app/api/carousels/[id]/route";

const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-01T11:00:00.000Z";

const update = (patch: Partial<BriefUpdate>): BriefUpdate => ({ ...EMPTY_BRIEF_UPDATE, ...patch });

/** The founder-complacency reel cover after its first request. */
function storedBrief(): CreativeBrief {
  return {
    objective: { value: "Make founders question whether they have grown complacent", source: "explicit", at: T0 },
    audience: { value: "Early-stage founders", source: "inferred", at: T0 },
    centralMessage: { value: "Comfort is the quiet risk", source: "explicit", at: T0 },
    constraints: [
      { text: "Serious tone", source: "explicit", at: T0 },
      { text: "Muted colours", source: "inferred", at: T0 },
    ],
    visualDecisions: [{ text: "One photographic subject, the founder alone at night", source: "inferred", at: T0 }],
    assetRelationships: [{ id: "ref-1", role: "The user's own photograph; the cover subject", source: "explicit", at: T0 }],
    updatedAt: T0,
  };
}

describe("mergeBrief", () => {
  it("keeps every value a revision does not mention", () => {
    const merged = mergeBrief(storedBrief(), update({ addVisualDecisions: [{ text: "Higher contrast", source: "explicit" }] }), T1);
    expect(merged.objective).toEqual(storedBrief().objective);
    expect(merged.centralMessage).toEqual(storedBrief().centralMessage);
    expect(merged.constraints).toEqual(storedBrief().constraints);
    expect(merged.assetRelationships).toEqual(storedBrief().assetRelationships);
    expect(merged.visualDecisions.map((d) => d.text)).toEqual([
      "One photographic subject, the founder alone at night",
      "Higher contrast",
    ]);
    expect(merged.updatedAt).toBe(T1);
  });

  it("never lets an inferred value replace one the user stated", () => {
    const merged = mergeBrief(
      storedBrief(),
      update({ fields: { objective: { value: "Drive sign-ups", source: "inferred" } } }),
      T1
    );
    expect(merged.objective?.value).toBe("Make founders question whether they have grown complacent");
  });

  it("lets a newer explicit instruction replace an older explicit value", () => {
    const merged = mergeBrief(
      storedBrief(),
      update({ fields: { centralMessage: { value: "Growth needs discomfort", source: "explicit" } } }),
      T1
    );
    expect(merged.centralMessage).toEqual({ value: "Growth needs discomfort", source: "explicit", at: T1 });
  });

  it("lets a later inference refine an earlier inference", () => {
    const merged = mergeBrief(
      storedBrief(),
      update({ fields: { audience: { value: "Founders of seed-stage software companies", source: "inferred" } } }),
      T1
    );
    expect(merged.audience?.value).toBe("Founders of seed-stage software companies");
  });

  it("retires an explicit constraint only on an explicit instruction, matching its text loosely", () => {
    const retireBy = (source: "explicit" | "inferred") =>
      mergeBrief(
        storedBrief(),
        update({ retireConstraints: [{ text: "  serious   TONE ", because: "The user now wants it playful", source }] }),
        T1
      );
    expect(retireBy("inferred").constraints.map((c) => c.text)).toContain("Serious tone");
    expect(retireBy("explicit").constraints.map((c) => c.text)).not.toContain("Serious tone");
  });

  it("an explicit restatement confirms an inferred item instead of duplicating it", () => {
    const merged = mergeBrief(storedBrief(), update({ addConstraints: [{ text: "muted colours", source: "explicit" }] }), T1);
    const muted = merged.constraints.filter((c) => c.text.toLowerCase() === "muted colours");
    expect(muted).toEqual([{ text: "muted colours", source: "explicit", at: T1 }]);
  });

  it("keeps explicit items first when a list overflows, dropping the oldest inferences", () => {
    const many = Array.from({ length: BRIEF_LIMITS.constraints }, (_, i) => ({ text: `Inferred ${i}`, source: "inferred" as const }));
    const merged = mergeBrief(storedBrief(), update({ addConstraints: many }), T1);
    expect(merged.constraints).toHaveLength(BRIEF_LIMITS.constraints);
    expect(merged.constraints[0].text).toBe("Serious tone");
  });

  it("does not let an inferred role replace a stated asset relationship", () => {
    const merged = mergeBrief(
      storedBrief(),
      update({ assetRelationships: [{ id: "ref-1", role: "A style reference", source: "inferred" }] }),
      T1
    );
    expect(merged.assetRelationships[0].role).toBe("The user's own photograph; the cover subject");
  });

  it("starts from an empty brief and does not mutate its input", () => {
    const original = storedBrief();
    const snapshot = structuredClone(original);
    mergeBrief(original, update({ addConstraints: [{ text: "No stock photos", source: "explicit" }] }), T1);
    expect(original).toEqual(snapshot);
    expect(mergeBrief(undefined, EMPTY_BRIEF_UPDATE, T1)).toEqual(emptyBrief(T1));
  });
});

describe("validateBriefUpdate", () => {
  const known = new Set(["ref-1"]);

  it("accepts a complete, bounded update", () => {
    const input = {
      fields: { objective: { value: "Teach the basics", source: "inferred" } },
      addConstraints: [{ text: "No jargon", source: "explicit" }],
      retireConstraints: [],
      addVisualDecisions: [],
      retireVisualDecisions: [],
      assetRelationships: [{ id: "ref-1", role: "Cover photograph", source: "explicit" }],
    };
    expect(validateBriefUpdate(input, known)).toMatchObject({ ok: true });
  });

  it.each([
    ["an unknown top-level field", { notes: "x" }],
    ["an unknown brief field", { fields: { mood: { value: "dark", source: "inferred" } } }],
    ["a missing provenance", { addConstraints: [{ text: "No jargon" }] }],
    ["an unknown provenance", { addConstraints: [{ text: "No jargon", source: "assumed" }] }],
    ["an over-long value", { fields: { objective: { value: "x".repeat(BRIEF_LIMITS.value + 1), source: "inferred" } } }],
    ["a control character", { addConstraints: [{ text: "No\u0007jargon", source: "explicit" }] }],
    ["too many constraints", { addConstraints: Array.from({ length: BRIEF_LIMITS.constraints + 1 }, () => ({ text: "x", source: "inferred" })) }],
    ["a retirement without a reason", { retireConstraints: [{ text: "Serious tone", source: "explicit" }] }],
    ["a relationship to another carousel's image", { assetRelationships: [{ id: "ref-of-another-carousel", role: "Cover", source: "explicit" }] }],
  ])("refuses %s", (_name, input) => {
    expect(validateBriefUpdate(input, known)).toMatchObject({ ok: false });
  });
});

describe("briefForCarousel", () => {
  it("drops relationships to images the carousel no longer has", () => {
    expect(briefForCarousel(storedBrief(), new Set())?.assetRelationships).toEqual([]);
    expect(briefForCarousel(storedBrief(), new Set(["ref-1"]))?.assetRelationships).toHaveLength(1);
    expect(briefForCarousel(undefined, new Set())).toBeNull();
  });
});

describe("brief storage", () => {
  let workdir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-brief-"));
    await mkdir(path.join(workdir, "data"), { recursive: true });
    process.chdir(workdir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  it("belongs to one carousel and never appears on another", async () => {
    const a = await createCarousel("A", "9:16");
    const b = await createCarousel("B", "9:16");
    expect(await setCreativeBrief(a.id, storedBrief())).toBe(true);
    expect((await getCarousel(a.id))?.creativeBrief).toEqual(storedBrief());
    expect((await getCarousel(b.id))?.creativeBrief).toBeUndefined();
    expect(await setCreativeBrief("missing", storedBrief())).toBe(false);
  });

  it("is copied with a duplicate, and the copies then evolve independently", async () => {
    const original = await createCarousel("Original", "9:16");
    await setCreativeBrief(original.id, storedBrief());
    const copy = await duplicateCarousel(original.id);
    expect(copy?.creativeBrief).toEqual(storedBrief());

    await setCreativeBrief(copy!.id, mergeBrief(copy!.creativeBrief, update({ addConstraints: [{ text: "Playful", source: "explicit" }] }), T1));
    expect((await getCarousel(original.id))?.creativeBrief).toEqual(storedBrief());
    expect((await getCarousel(copy!.id))?.creativeBrief?.constraints.map((c) => c.text)).toContain("Playful");
  });

  it("cannot be written through the carousel update route", async () => {
    const carousel = await createCarousel("Owned", "9:16");
    await setCreativeBrief(carousel.id, storedBrief());
    const forged = { ...storedBrief(), objective: { value: "Forged", source: "explicit", at: T1 } };
    const res = await putCarousel(
      new Request(`http://localhost:3000/api/carousels/${carousel.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed", creativeBrief: forged }),
      }),
      { params: Promise.resolve({ id: carousel.id }) }
    );
    expect(res.status).toBe(200);
    const stored = await getCarousel(carousel.id);
    expect(stored?.name).toBe("Renamed");
    expect(stored?.creativeBrief).toEqual(storedBrief());
  });
});
