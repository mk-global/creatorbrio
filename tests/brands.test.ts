import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DataFileCorruptError } from "@/lib/data";
import {
  listBrands,
  createBrand,
  getBrand,
  updateBrand,
  resolveBrandForCarousel,
} from "@/lib/brand";
import { createCarousel, duplicateCarousel, getCarousel, listCarousels, addSlide } from "@/lib/carousels";
import { saveAsTemplate, listTemplates } from "@/lib/templates";
import { buildSystemPrompt, type PromptCarousel } from "@/lib/chat-system-prompt";
import { resolveReferenceImages } from "@/lib/reference-images";
import { GET as getBrandsRoute, POST as postBrandsRoute } from "@/app/api/brands/route";
import { GET as getBrandRoute, PUT as putBrandRoute } from "@/app/api/brands/[id]/route";
import { GET as listCarouselsRoute, POST as postCarouselRoute } from "@/app/api/carousels/route";
import { PUT as putCarouselRoute } from "@/app/api/carousels/[id]/route";
import { GET as listTemplatesRoute, POST as saveTemplateRoute } from "@/app/api/templates/route";
import { POST as useTemplateRoute } from "@/app/api/templates/[id]/use/route";
import type { BrandConfig } from "@/types/brand";
import type { Carousel, CarouselsData } from "@/types/carousel";
import type { TemplatesData } from "@/types/template";

// Every test runs against a throwaway data directory seeded with a synthetic
// installation from before brands existed. Nothing here touches the real ./data.
let workdir: string;
let originalCwd: string;

const dataFile = (name: string) => path.join(workdir, "data", name);

const LEGACY_BRAND: BrandConfig = {
  name: "Studio Aurora",
  colors: {
    primary: "#2b1d3a",
    secondary: "#5c3d7a",
    accent: "#f2a65a",
    background: "#fffaf3",
    surface: "#f4ece1",
  },
  fonts: { heading: "Playfair Display", body: "Inter" },
  customFonts: [],
  logoPath: "/uploads/aurora-logo.png",
  styleKeywords: ["elegant", "warm"],
  createdAt: "2026-10-27T10:09:27.957Z",
  updatedAt: "2026-10-28T11:46:48.384Z",
};

const legacyCarousel = (id: string, name: string): Carousel => ({
  id,
  name,
  aspectRatio: "4:5",
  slides: [{ id: `${id}-s1`, html: "<div>legacy</div>", previousVersions: [], order: 0, notes: "hook" }],
  referenceImages: [],
  chatSessionId: null,
  isTemplate: false,
  tags: [],
  createdAt: "2026-10-27T11:00:00.000Z",
  updatedAt: "2026-10-27T11:00:00.000Z",
});

const LEGACY_CAROUSELS: CarouselsData = {
  carousels: [legacyCarousel("legacy-1", "Launch week"), legacyCarousel("legacy-2", "Behind the scenes")],
};

const LEGACY_TEMPLATES: TemplatesData = {
  templates: [
    {
      id: "legacy-template",
      name: "Quote card",
      description: "Template from Launch week",
      aspectRatio: "4:5",
      slides: [{ id: "t1", html: "<div>quote</div>", order: 0, notes: "" }],
      tags: [],
      createdAt: "2026-10-27T12:00:00.000Z",
    },
  ],
};

async function seedLegacyInstallation(): Promise<void> {
  // Written the way the data layer writes files, so byte comparisons are fair.
  await writeFile(dataFile("brand.json"), JSON.stringify(LEGACY_BRAND, null, 2));
  await writeFile(dataFile("carousels.json"), JSON.stringify(LEGACY_CAROUSELS, null, 2));
  await writeFile(dataFile("templates.json"), JSON.stringify(LEGACY_TEMPLATES, null, 2));
}

const legacyBytes = async () =>
  Promise.all(["brand.json", "carousels.json", "templates.json"].map((f) => readFile(dataFile(f))));

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-brands-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  process.chdir(workdir);
  await seedLegacyInstallation();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

const json = (url: string, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("migration from brand.json", () => {
  it("creates one default brand equal to brand.json and leaves every legacy file byte-identical", async () => {
    const before = await legacyBytes();

    const { brands, defaultBrandId } = await listBrands();
    // Reading carousels, templates and resolving brands must not rewrite them either.
    await listCarousels(defaultBrandId);
    await listTemplates(defaultBrandId);
    await resolveBrandForCarousel(LEGACY_CAROUSELS.carousels[0]);

    expect(brands).toHaveLength(1);
    const { id, ...config } = brands[0];
    expect(id).toBe(defaultBrandId);
    expect(config).toEqual(LEGACY_BRAND);
    expect(await legacyBytes()).toEqual(before);
  });

  it("is idempotent: later reads keep the same id and do not rewrite brands.json", async () => {
    const first = await listBrands();
    const written = await readFile(dataFile("brands.json"));

    const second = await listBrands();
    await getBrand();

    expect(second.defaultBrandId).toBe(first.defaultBrandId);
    expect(second.brands).toHaveLength(1);
    expect(await readFile(dataFile("brands.json"))).toEqual(written);
  });

  it("creates exactly one record when first accessed concurrently", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => listBrands()));

    const ids = new Set(results.map((r) => r.defaultBrandId));
    expect(ids.size).toBe(1);
    const stored = JSON.parse(await readFile(dataFile("brands.json"), "utf-8"));
    expect(stored.brands).toHaveLength(1);
    expect(stored.defaultBrandId).toBe([...ids][0]);
  });

  it("reports a corrupt brand.json, leaves it untouched and does not create brands.json", async () => {
    await writeFile(dataFile("brand.json"), '{"name": "Studio Aur');
    const damaged = await readFile(dataFile("brand.json"));

    await expect(listBrands()).rejects.toBeInstanceOf(DataFileCorruptError);
    expect(existsSync(dataFile("brands.json"))).toBe(false);
    expect(await readFile(dataFile("brand.json"))).toEqual(damaged);
  });

  it("gives the default brand the same id if brands.json is lost and recreated", async () => {
    const { defaultBrandId } = await listBrands();
    const stamped = await createCarousel("Made after the upgrade", "4:5");
    const template = await saveAsTemplate(stamped);

    // What the corrupt-file message invites: move brands.json aside and retry.
    await rm(dataFile("brands.json"));
    const recreated = await listBrands();

    expect(recreated.defaultBrandId).toBe(defaultBrandId);
    expect((await resolveBrandForCarousel(stamped)).name).toBe("Studio Aurora");
    expect((await listCarousels(recreated.defaultBrandId)).map((c) => c.id)).toContain(stamped.id);
    expect((await listTemplates(recreated.defaultBrandId)).map((t) => t.id)).toContain(template.id);
  });

  it("starts a fresh installation with one unconfigured default brand", async () => {
    await rm(dataFile("brand.json"));

    const brand = await getBrand();

    expect(brand.name).toBe("");
    expect(existsSync(dataFile("brand.json"))).toBe(false);
  });

  it("sends brand edits to brands.json and never back to brand.json", async () => {
    const before = await readFile(dataFile("brand.json"));

    await updateBrand({ name: "Studio Aurora Renamed" });

    expect((await getBrand()).name).toBe("Studio Aurora Renamed");
    expect(await readFile(dataFile("brand.json"))).toEqual(before);
  });
});

/** The carousel as the chat route gives it to the prompt: references resolved. */
async function forPrompt(carousel: Carousel): Promise<PromptCarousel> {
  return { ...carousel, referenceImages: await resolveReferenceImages(carousel) };
}

describe("legacy prompt behaviour", () => {
  const baseUrl = "http://localhost:3000";

  it("gives a carousel without brandId a prompt byte-identical to the one built from brand.json", async () => {
    const carousel = LEGACY_CAROUSELS.carousels[0];
    const before = buildSystemPrompt({ baseUrl, brand: LEGACY_BRAND, carousel: await forPrompt(carousel) });

    const after = buildSystemPrompt({
      baseUrl,
      brand: await resolveBrandForCarousel(carousel),
      carousel: await forPrompt(carousel),
    });

    expect(after).toBe(before);
  });

  it("gives a chat without a carousel the default brand's prompt", async () => {
    const before = buildSystemPrompt({ baseUrl, brand: LEGACY_BRAND });

    expect(buildSystemPrompt({ baseUrl, brand: await resolveBrandForCarousel(null) })).toBe(before);
  });

  it("keeps the design agent's prompt text unchanged (golden snapshot)", async () => {
    // Pins the creative engine's prompt for fixed inputs. A change here is a
    // change to the engine and needs its own decision, not a snapshot update.
    const carousel = await forPrompt(LEGACY_CAROUSELS.carousels[0]);
    expect(buildSystemPrompt({ baseUrl, brand: LEGACY_BRAND, carousel })).toMatchSnapshot();
  });
});

describe("brand isolation", () => {
  async function secondBrand() {
    return createBrand({ name: "Northwind Labs", colors: { ...LEGACY_BRAND.colors, primary: "#0b3d91" } });
  }

  it("generates a second brand's carousel with that brand and not the default one", async () => {
    const north = await secondBrand();
    const carousel = await createCarousel("North launch", "4:5", north.id);

    const brand = await resolveBrandForCarousel(carousel);
    const prompt = buildSystemPrompt({ baseUrl: "http://localhost:3000", brand, carousel: await forPrompt(carousel) });

    expect(brand.id).toBe(north.id);
    expect(prompt).toContain("Name: Northwind Labs");
    expect(prompt).toContain("#0b3d91");
    expect(prompt).not.toContain("Studio Aurora");
  });

  it("stamps the default brand on a carousel created without one", async () => {
    const { defaultBrandId } = await listBrands();
    const carousel = await createCarousel("Plain", "1:1");
    expect(carousel.brandId).toBe(defaultBrandId);
  });

  it("lists each brand's carousels only, with legacy carousels under the default brand", async () => {
    const { defaultBrandId } = await listBrands();
    const north = await secondBrand();
    const northCarousel = await createCarousel("North launch", "4:5", north.id);
    const auroraCarousel = await createCarousel("Aurora new", "4:5");

    const aurora = (await listCarousels(defaultBrandId)).map((c) => c.id);
    const northIds = (await listCarousels(north.id)).map((c) => c.id);

    expect(aurora.sort()).toEqual(["legacy-1", "legacy-2", auroraCarousel.id].sort());
    expect(northIds).toEqual([northCarousel.id]);
    expect(await listCarousels()).toHaveLength(4);
  });

  it("keeps a carousel's brand when it is duplicated", async () => {
    const north = await secondBrand();
    const carousel = await createCarousel("North launch", "4:5", north.id);
    const copy = await duplicateCarousel(carousel.id);
    const legacyCopy = await duplicateCarousel("legacy-1");

    expect(copy?.brandId).toBe(north.id);
    expect(legacyCopy?.brandId).toBeUndefined();
    expect((await resolveBrandForCarousel(legacyCopy)).name).toBe("Studio Aurora");
  });
});

describe("brand API", () => {
  it("lists brands with the default brand id", async () => {
    const res = await getBrandsRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.brands).toHaveLength(1);
    expect(body.brands[0].id).toBe(body.defaultBrandId);
  });

  it("creates a brand from configurable fields only and requires a name", async () => {
    const missing = await postBrandsRoute(json("http://localhost:3000/api/brands", "POST", { name: "  " }));
    expect(missing.status).toBe(400);

    const res = await postBrandsRoute(
      json("http://localhost:3000/api/brands", "POST", {
        name: " Northwind Labs ",
        id: "chosen-by-client",
        createdAt: "1999-01-01T00:00:00.000Z",
        fonts: { heading: "Space Grotesk" },
      })
    );
    const brand = await res.json();
    expect(res.status).toBe(201);
    expect(brand.name).toBe("Northwind Labs");
    expect(brand.id).not.toBe("chosen-by-client");
    expect(brand.createdAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(brand.fonts).toEqual({ heading: "Space Grotesk", body: "Inter" });
  });

  it("updates only the addressed brand", async () => {
    const { defaultBrandId } = await listBrands();
    const north = await createBrand({ name: "Northwind Labs" });

    const res = await putBrandRoute(
      json(`http://localhost:3000/api/brands/${north.id}`, "PUT", { name: "Northwind", id: defaultBrandId }),
      idParams(north.id)
    );

    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Northwind");
    expect((await getBrand()).name).toBe("Studio Aurora");
    const missing = await getBrandRoute(json("http://localhost:3000/api/brands/nope", "GET"), idParams("nope"));
    expect(missing.status).toBe(404);
  });

  it("refuses to blank a brand's name and trims it, as creation does", async () => {
    const north = await createBrand({ name: "Northwind Labs" });
    const put = (body: unknown) =>
      putBrandRoute(json(`http://localhost:3000/api/brands/${north.id}`, "PUT", body), idParams(north.id));

    expect((await put({ name: "   " })).status).toBe(400);
    expect((await put({ name: "  Northwind  " })).status).toBe(200);
    expect((await listBrands()).brands.find((b) => b.id === north.id)?.name).toBe("Northwind");
    // Updates that do not mention the name leave it alone.
    expect((await put({ styleKeywords: ["bold"] })).status).toBe(200);
  });
});

describe("carousel ownership through the API", () => {
  it("creates a carousel in a named brand and refuses an unknown one", async () => {
    const north = await createBrand({ name: "Northwind Labs" });

    const created = await postCarouselRoute(
      json("http://localhost:3000/api/carousels", "POST", { name: "North", aspectRatio: "4:5", brandId: north.id })
    );
    const unknown = await postCarouselRoute(
      json("http://localhost:3000/api/carousels", "POST", { name: "Lost", brandId: "no-such-brand" })
    );
    const wrongType = await postCarouselRoute(
      json("http://localhost:3000/api/carousels", "POST", { name: "Lost", brandId: 42 })
    );

    expect(created.status).toBe(201);
    expect((await created.json()).brandId).toBe(north.id);
    expect(unknown.status).toBe(400);
    expect(wrongType.status).toBe(400);
    // The two legacy carousels plus the one created; the refused requests created nothing.
    expect(await listCarousels()).toHaveLength(3);
  });

  it("never moves a carousel to another brand through an update", async () => {
    const north = await createBrand({ name: "Northwind Labs" });
    const carousel = await createCarousel("North", "4:5", north.id);
    const { defaultBrandId } = await listBrands();

    const res = await putCarouselRoute(
      json(`http://localhost:3000/api/carousels/${carousel.id}`, "PUT", { name: "Renamed", brandId: defaultBrandId }),
      idParams(carousel.id)
    );
    const legacy = await putCarouselRoute(
      json("http://localhost:3000/api/carousels/legacy-1", "PUT", { brandId: north.id }),
      idParams("legacy-1")
    );

    expect(res.status).toBe(200);
    expect((await getCarousel(carousel.id))?.brandId).toBe(north.id);
    expect((await getCarousel(carousel.id))?.name).toBe("Renamed");
    expect(legacy.status).toBe(200);
    expect((await getCarousel("legacy-1"))?.brandId).toBeUndefined();
  });

  it("filters the carousel list by ?brandId=", async () => {
    const north = await createBrand({ name: "Northwind Labs" });
    await createCarousel("North", "4:5", north.id);

    const res = await listCarouselsRoute(new Request(`http://localhost:3000/api/carousels?brandId=${north.id}`));
    const all = await listCarouselsRoute(new Request("http://localhost:3000/api/carousels"));

    expect((await res.json()).carousels.map((c: Carousel) => c.name)).toEqual(["North"]);
    expect((await all.json()).carousels).toHaveLength(3);
  });
});

describe("brand-specific templates", () => {
  it("stamps the source carousel's brand and lists the template only under it", async () => {
    const { defaultBrandId } = await listBrands();
    const north = await createBrand({ name: "Northwind Labs" });
    const carousel = await createCarousel("North", "4:5", north.id);
    await addSlide(carousel.id, "<div>north</div>");

    const saved = await saveTemplateRoute(
      json("http://localhost:3000/api/templates", "POST", { carouselId: carousel.id })
    );
    const template = await saved.json();
    const northList = await (
      await listTemplatesRoute(new Request(`http://localhost:3000/api/templates?brandId=${north.id}`))
    ).json();
    const defaultList = await (
      await listTemplatesRoute(new Request(`http://localhost:3000/api/templates?brandId=${defaultBrandId}`))
    ).json();

    expect(template.brandId).toBe(north.id);
    expect(northList.templates.map((t: { id: string }) => t.id)).toEqual([template.id]);
    expect(defaultList.templates.map((t: { id: string }) => t.id)).toEqual(["legacy-template"]);
  });

  it("creates a carousel from a template in the template's brand", async () => {
    const north = await createBrand({ name: "Northwind Labs" });
    const carousel = await createCarousel("North", "4:5", north.id);
    const template = await saveAsTemplate(carousel);
    const { defaultBrandId } = await listBrands();

    const fromNorth = await (await useTemplateRoute(new Request("http://localhost:3000"), idParams(template.id))).json();
    const fromLegacy = await (
      await useTemplateRoute(new Request("http://localhost:3000"), idParams("legacy-template"))
    ).json();

    expect(fromNorth.brandId).toBe(north.id);
    expect(fromLegacy.brandId).toBe(defaultBrandId);
  });
});
