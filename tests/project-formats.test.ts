/**
 * Project formats (#175): one carousel engine, with an optional stored format
 * that sets sizes, the slide limit and the main export. Exercised through the
 * real route modules against a throwaway data directory seeded with a project
 * from before formats existed, so backward compatibility is tested on the
 * shape of data people actually have. Nothing here touches the real ./data.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FORMATS,
  formatOf,
  isProjectFormat,
  primaryExportFor,
  sizeRefusal,
  slideLimitOf,
  slideLimitRefusal,
  withArticle,
} from "@/lib/formats";
import { summarizeProject } from "@/lib/project-summary";
import { duplicateCarousel, getCarousel } from "@/lib/carousels";
import { explicitCountOverFormatLimit } from "@/lib/director-plan";
import { GET as listRoute, POST as createRoute } from "@/app/api/carousels/route";
import { PUT as updateRoute } from "@/app/api/carousels/[id]/route";
import { POST as addSlideRoute } from "@/app/api/carousels/[id]/slides/route";
import { POST as saveTemplateRoute } from "@/app/api/templates/route";
import { POST as useTemplateRoute } from "@/app/api/templates/[id]/use/route";
import { GET as statusRoute } from "@/app/api/status/route";
import type { Carousel, CarouselsData } from "@/types/carousel";
import type { ProjectSummary } from "@/lib/project-summary";

let workdir: string;
let originalCwd: string;

const legacy: Carousel = {
  id: "legacy-1",
  name: "Launch week",
  aspectRatio: "4:5",
  slides: [
    { id: "s2", html: "<div>second</div>", previousVersions: ["<div>old second</div>"], order: 1, notes: "" },
    { id: "s1", html: "<div>first</div>", previousVersions: ["<div>old first</div>"], order: 0, notes: "hook" },
  ],
  referenceImages: [],
  chatSessionId: null,
  isTemplate: false,
  tags: [],
  createdAt: "2026-10-27T11:00:00.000Z",
  updatedAt: "2026-10-28T11:00:00.000Z",
};

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-formats-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  process.chdir(workdir);
  const data: CarouselsData = { carousels: [legacy] };
  await writeFile(path.join(workdir, "data", "carousels.json"), JSON.stringify(data, null, 2));
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

const json = (url: string, method: string, body?: unknown) =>
  new Request(`http://127.0.0.1:3000${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function create(body: Record<string, unknown>) {
  const res = await createRoute(json("/api/carousels", "POST", body));
  return { status: res.status, body: await res.json() };
}

describe("the format registry", () => {
  it("reads a project without a format as an Instagram carousel", () => {
    expect(formatOf(legacy)).toBe("instagram-carousel");
    expect(formatOf({ format: "something-else" })).toBe("instagram-carousel");
    expect(slideLimitOf(legacy)).toBe(20);
    expect(isProjectFormat("reel-cover")).toBe(true);
    expect(isProjectFormat("cover")).toBe(false);
  });

  it("gives each format its sizes, limit and main export", () => {
    expect(FORMATS["instagram-carousel"].sizes).toEqual(["4:5", "1:1", "9:16"]);
    expect(FORMATS["linkedin-document"].sizes).toEqual(["4:5", "1:1"]);
    expect(FORMATS["reel-cover"].sizes).toEqual(["9:16"]);
    expect(FORMATS["reel-cover"].maxSlides).toBe(1);
    expect(primaryExportFor("instagram-carousel", 6)).toBe("png");
    expect(primaryExportFor("linkedin-document", 8)).toBe("pdf");
    expect(primaryExportFor("reel-cover", 1)).toBe("single-png");
    // A single PNG needs exactly one slide, so an empty or larger cover falls back to the ZIP.
    expect(primaryExportFor("reel-cover", 0)).toBe("png");
  });

  it("explains refusals in plain words", () => {
    expect(withArticle("Instagram carousel")).toBe("An Instagram carousel");
    expect(sizeRefusal("reel-cover")).toBe("A Reel cover is always 9:16.");
    expect(sizeRefusal("linkedin-document")).toBe("A LinkedIn document can be 4:5 or 1:1.");
    expect(slideLimitRefusal({ format: "reel-cover" })).toBe(
      "A Reel cover has one slide. Change the slide that is there instead of adding another."
    );
  });
});

describe("creating a project", () => {
  it("stores no format when none is given, exactly as before", async () => {
    const { status, body } = await create({ name: "Plain", aspectRatio: "1:1" });
    expect(status).toBe(201);
    expect(body).not.toHaveProperty("format");
    expect(body.aspectRatio).toBe("1:1");
  });

  it("stores each format, with the format's usual size when none is sent", async () => {
    const cover = await create({ name: "Cover", format: "reel-cover" });
    expect(cover.status).toBe(201);
    expect(cover.body).toMatchObject({ format: "reel-cover", aspectRatio: "9:16" });
    const doc = await create({ name: "Guide", format: "linkedin-document", aspectRatio: "1:1" });
    expect(doc.body).toMatchObject({ format: "linkedin-document", aspectRatio: "1:1" });
    const carousel = await create({ name: "Tips", format: "instagram-carousel" });
    expect(carousel.body).toMatchObject({ format: "instagram-carousel", aspectRatio: "4:5" });
  });

  it("refuses an unknown format and a size the format does not allow", async () => {
    expect((await create({ name: "X", format: "story" })).status).toBe(400);
    const cover = await create({ name: "X", format: "reel-cover", aspectRatio: "4:5" });
    expect(cover).toEqual({ status: 400, body: { error: "A Reel cover is always 9:16." } });
    const doc = await create({ name: "X", format: "linkedin-document", aspectRatio: "9:16" });
    expect(doc.status).toBe(400);
  });
});

describe("the format holds on the server", () => {
  it("refuses a size change a Reel cover does not allow, and leaves carousels as they were", async () => {
    const { body: cover } = await create({ name: "Cover", format: "reel-cover" });
    const refused = await updateRoute(json(`/api/carousels/${cover.id}`, "PUT", { aspectRatio: "4:5" }), idParams(cover.id));
    expect(refused.status).toBe(400);
    expect((await getCarousel(cover.id))!.aspectRatio).toBe("9:16");
    // A rename alone is not a size change.
    const renamed = await updateRoute(json(`/api/carousels/${cover.id}`, "PUT", { name: "Renamed" }), idParams(cover.id));
    expect(renamed.status).toBe(200);
    // A project from before formats can still take any size.
    const legacyResize = await updateRoute(json("/api/carousels/legacy-1", "PUT", { aspectRatio: "9:16" }), idParams("legacy-1"));
    expect(legacyResize.status).toBe(200);
    expect((await getCarousel("legacy-1"))!.aspectRatio).toBe("9:16");
  });

  it("keeps a Reel cover to one slide and says why", async () => {
    const { body: cover } = await create({ name: "Cover", format: "reel-cover" });
    const first = await addSlideRoute(json(`/api/carousels/${cover.id}/slides`, "POST", { html: "<div>one</div>" }), idParams(cover.id));
    expect(first.status).toBe(201);
    const second = await addSlideRoute(json(`/api/carousels/${cover.id}/slides`, "POST", { html: "<div>two</div>" }), idParams(cover.id));
    expect(second.status).toBe(400);
    expect((await second.json()).error).toMatch(/has one slide/);
    expect((await getCarousel(cover.id))!.slides).toHaveLength(1);
    // An ordinary carousel takes a second slide as before.
    const more = await addSlideRoute(json("/api/carousels/legacy-1/slides", "POST", { html: "<div>three</div>" }), idParams("legacy-1"));
    expect(more.status).toBe(201);
  });

  it("keeps the format when a project is duplicated", async () => {
    const { body: doc } = await create({ name: "Guide", format: "linkedin-document" });
    expect((await duplicateCarousel(doc.id))!.format).toBe("linkedin-document");
  });
});

describe("the library's summary view", () => {
  it("lists each project's card and nothing more, most recently edited first", async () => {
    const { body: cover } = await create({ name: "Cover", format: "reel-cover" });
    const res = await listRoute(json("/api/carousels?view=summary", "GET"));
    expect(res.status).toBe(200);
    const { projects } = (await res.json()) as { projects: ProjectSummary[] };
    expect(projects.map((p) => p.id)).toEqual([cover.id, "legacy-1"]);
    const old = projects[1];
    expect(old).toEqual({
      id: "legacy-1",
      name: "Launch week",
      brandId: expect.any(String),
      format: "instagram-carousel",
      aspectRatio: "4:5",
      slideCount: 2,
      firstSlideHtml: "<div>first</div>",
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    });
    // No undo history and no slide after the first leaves the server.
    const text = JSON.stringify(projects);
    expect(text).not.toContain("old first");
    expect(text).not.toContain("second");
    expect(projects[0].firstSlideHtml).toBeNull();
  });

  it("refuses an unknown view and leaves the plain list exactly as it was", async () => {
    expect((await listRoute(json("/api/carousels?view=all", "GET"))).status).toBe(400);
    const plain = await (await listRoute(json("/api/carousels", "GET"))).json();
    expect(Object.keys(plain)).toEqual(["carousels"]);
    expect(plain.carousels[0]).toEqual(legacy);
  });

  it("summarises a project from before brands under the default brand", () => {
    expect(summarizeProject(legacy, "default").brandId).toBe("default");
  });
});

describe("templates carry the format", () => {
  it("saves a document's format and makes documents from it, with an optional name", async () => {
    const { body: doc } = await create({ name: "Guide", format: "linkedin-document" });
    await addSlideRoute(json(`/api/carousels/${doc.id}/slides`, "POST", { html: "<div>p1</div>" }), idParams(doc.id));
    const saved = await (await saveTemplateRoute(json("/api/templates", "POST", { carouselId: doc.id }))).json();
    expect(saved.format).toBe("linkedin-document");

    const named = await useTemplateRoute(json(`/api/templates/${saved.id}/use`, "POST", { name: "  Q3 guide  " }), idParams(saved.id));
    expect(named.status).toBe(201);
    const made = await named.json();
    expect(made).toMatchObject({ name: "Q3 guide", format: "linkedin-document" });
    expect((await getCarousel(made.id))!.slides).toHaveLength(1);

    // Without a body the project is named after the template, as before.
    const plain = await (await useTemplateRoute(json(`/api/templates/${saved.id}/use`, "POST"), idParams(saved.id))).json();
    expect(plain.name).toBe("Guide (from template)");

    const bad = await useTemplateRoute(json(`/api/templates/${saved.id}/use`, "POST", { name: 42 }), idParams(saved.id));
    expect(bad.status).toBe(400);
  });

  it("saves no format for a project without one", async () => {
    const saved = await (await saveTemplateRoute(json("/api/templates", "POST", { carouselId: "legacy-1" }))).json();
    expect(saved).not.toHaveProperty("format");
    const stored = JSON.parse(await readFile(path.join(workdir, "data", "templates.json"), "utf8"));
    expect(stored.templates[0]).not.toHaveProperty("format");
  });
});

describe("planning a Reel cover", () => {
  // The plan validator's limit is tested with the other slide-count rules in director-plan.test.ts.
  it("finds a count over the format's limit, and none for a carousel", () => {
    expect(explicitCountOverFormatLimit("Make 3 slides about mornings", 1)).toBe(3);
    expect(explicitCountOverFormatLimit("A one-slide Reel cover. Mornings", 1)).toBeNull();
    expect(explicitCountOverFormatLimit("Make 3 slides about mornings", 20)).toBeNull();
  });
});

describe("the app status", () => {
  it("reports Claude Code and image generation without paths, URLs or secrets", async () => {
    const body = await (await statusRoute()).json();
    expect(Object.keys(body).sort()).toEqual(["claude", "imageGeneration"]);
    expect(typeof body.claude.available).toBe("boolean");
    expect(typeof body.imageGeneration.configured).toBe("boolean");
    expect(JSON.stringify(body)).not.toMatch(/[/\\]|http|token/i);
  });
});
