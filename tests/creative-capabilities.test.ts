import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CAPABILITIES, capabilityStatus, isAvailable } from "@/lib/creative-capabilities";

const byId = async (context: { referenceCount: number; intactAssetCount: number }, generation: boolean) =>
  Object.fromEntries((await capabilityStatus(context, async () => generation)).map((c) => [c.id, c]));

describe("the capability table", () => {
  it("describes every capability completely, so the Director can reason about it", () => {
    expect(CAPABILITIES.map((c) => c.id)).toEqual([
      "design-composition",
      "reference-placement",
      "reference-style",
      "image-generation",
      "asset-reuse",
      "image-editing",
      "object-removal",
      "relighting",
      "image-combination",
    ]);
    for (const c of CAPABILITIES) {
      for (const field of ["does", "usefulWhen", "needs", "produces", "constraints", "failureModes"] as const) {
        expect(c[field].trim().length, `${c.id}.${field}`).toBeGreaterThan(10);
      }
    }
  });
});

describe("capabilityStatus", () => {
  it("offers reference and reuse capabilities only when the carousel has something to use", async () => {
    const none = await byId({ referenceCount: 0, intactAssetCount: 0 }, true);
    expect(none["reference-placement"]).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/no uploaded reference/) });
    expect(none["reference-style"].available).toBe(false);
    expect(none["asset-reuse"]).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/no earlier generated/) });

    const some = await byId({ referenceCount: 2, intactAssetCount: 1 }, true);
    expect(some["reference-placement"].available).toBe(true);
    expect(some["reference-style"].available).toBe(true);
    expect(some["asset-reuse"].available).toBe(true);
  });

  it("follows whether image generation is set up", async () => {
    expect((await byId({ referenceCount: 0, intactAssetCount: 0 }, true))["image-generation"].available).toBe(true);
    expect((await byId({ referenceCount: 0, intactAssetCount: 0 }, false))["image-generation"]).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/not set up/),
    });
  });

  it("always offers composition and never an edit that would change the photo or the person", async () => {
    for (const generation of [true, false]) {
      const status = await capabilityStatus({ referenceCount: 3, intactAssetCount: 3 }, async () => generation);
      expect(isAvailable(status, "design-composition")).toBe(true);
      for (const id of ["object-removal", "relighting", "image-combination"] as const) {
        expect(isAvailable(status, id), id).toBe(false);
      }
    }
  });

  it("offers background replacement exactly when the image service is set up, as background replacement only", async () => {
    expect((await byId({ referenceCount: 1, intactAssetCount: 0 }, true))["image-editing"].available).toBe(true);
    expect((await byId({ referenceCount: 1, intactAssetCount: 0 }, false))["image-editing"]).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/not set up/),
    });
    const editing = CAPABILITIES.find((c) => c.id === "image-editing")!;
    expect(editing.constraints).toMatch(/Background replacement only/);
    expect(editing.failureModes).toMatch(/never replaced by a generated image/);
  });
});

describe("capabilityStatus with the real set-up check", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "creatorbrio-capabilities-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("IMAGE_SERVICE_URL", "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("reports generation unavailable without a token, and never contacts the service", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const status = await capabilityStatus({ referenceCount: 0, intactAssetCount: 0 });
    expect(isAvailable(status, "image-generation")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reports generation available once a well-formed token is in place", async () => {
    const dir = path.join(home, ".config", "framewoven");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "image-service.token"), "ab".repeat(32), { mode: 0o600 });
    const status = await capabilityStatus({ referenceCount: 0, intactAssetCount: 0 });
    expect(isAvailable(status, "image-generation")).toBe(true);
  });
});
