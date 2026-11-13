import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { stubDirector, typographyPlanFor } from "./helpers/stub-director";

/**
 * #62: a reference image's server file path never leaves the server. Every
 * route that answers with a carousel, its reference images or something made
 * from them is called through its real handler against a carousel stored
 * before the change, which still has an `absPath` on disk; no response may
 * contain the field or any part of the server's directory. The path the
 * Design Agent and the Visual Director are given still comes from confining
 * the stored URL, for old and new records alike.
 */

// The Claude CLI is replaced by a stub that records its arguments, so the real
// chat route builds its prompt and task message without spawning anything.
const spawned: string[][] = [];

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      spawned.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { end: () => {} },
        kill: () => {},
      });
      setImmediate(() => child.emit("exit", 0));
      return child;
    },
  };
});

vi.mock("@/lib/claude-path", () => ({
  isClaudeAvailable: () => true,
  getClaudePath: () => "/usr/local/bin/claude",
}));

import { GET as listCarouselsRoute, POST as createCarouselRoute } from "@/app/api/carousels/route";
import { GET as getCarouselRoute, PUT as putCarouselRoute } from "@/app/api/carousels/[id]/route";
import { POST as duplicateRoute } from "@/app/api/carousels/[id]/duplicate/route";
import {
  GET as listReferencesRoute,
  POST as addReferenceRoute,
  DELETE as deleteReferenceRoute,
} from "@/app/api/carousels/[id]/references/route";
import { POST as addSlideRoute, PUT as reorderSlidesRoute } from "@/app/api/carousels/[id]/slides/route";
import { PUT as updateSlideRoute } from "@/app/api/carousels/[id]/slides/[slideId]/route";
import { POST as undoSlideRoute } from "@/app/api/carousels/[id]/slides/[slideId]/undo/route";
import { GET as getCaptionRoute, PUT as putCaptionRoute } from "@/app/api/carousels/[id]/caption/route";
import { GET as generationRoute } from "@/app/api/carousels/[id]/generation/route";
import { GET as listTemplatesRoute, POST as saveTemplateRoute } from "@/app/api/templates/route";
import { GET as getTemplateRoute } from "@/app/api/templates/[id]/route";
import { POST as useTemplateRoute } from "@/app/api/templates/[id]/use/route";
import { POST as chat } from "@/app/api/chat/route";
import { DEFAULT_BRAND } from "@/types/brand";

const LEGACY_ID = "c0ffee00-0000-4000-8000-0000000000a1";
const TIME = "2026-10-01T00:00:00.000Z";

let workdir: string;
let realWorkdir: string;
let uploads: string;
let originalCwd: string;
let director: ReturnType<typeof stubDirector>;

async function uploadPng(): Promise<string> {
  const name = `${randomUUID()}.png`;
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#1478c8" } })
    .png()
    .toBuffer();
  await writeFile(path.join(uploads, name), bytes);
  return `/uploads/${name}`;
}

/**
 * Writes a carousel the way the app stored one before #62, straight into
 * `data/carousels.json`: its reference keeps the absolute path it was given.
 */
async function storeLegacyCarousel(url: string, storedPath: string) {
  const legacy = {
    id: LEGACY_ID,
    name: "Stored before #62",
    aspectRatio: "4:5",
    slides: [
      { id: "slide-1", html: "<h1>One</h1>", previousVersions: ["<h1>Zero</h1>"], order: 0, notes: "" },
      { id: "slide-2", html: "<h1>Two</h1>", previousVersions: [], order: 1, notes: "" },
    ],
    referenceImages: [{ id: "ref-legacy", url, absPath: storedPath, name: "legacy mood", addedAt: TIME }],
    chatSessionId: null,
    isTemplate: false,
    tags: [],
    createdAt: TIME,
    updatedAt: TIME,
  };
  await writeFile(path.join(workdir, "data", "carousels.json"), JSON.stringify({ carousels: [legacy] }, null, 2));
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

function json(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "Content-Type": "application/json", host: "localhost:3000" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Routes whose response named a server path, checked once all have answered. */
let leaks: string[];

/** The response text; a response that names a server path is recorded as a leak. */
async function bodyWithoutServerPaths(label: string, response: Response | Promise<Response>): Promise<string> {
  const res = await response;
  const text = await res.text();
  expect(res.status, `${label}: ${text}`).toBeLessThan(300);
  if (["absPath", workdir, realWorkdir].some((s) => text.includes(s))) leaks.push(label);
  return text;
}

beforeEach(async () => {
  director = stubDirector();
  spawned.length = 0;
  leaks = [];
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-reference-paths-"));
  realWorkdir = await realpath(workdir);
  uploads = path.join(workdir, "public", "uploads");
  await mkdir(uploads, { recursive: true });
  await mkdir(path.join(workdir, "data"), { recursive: true });
  process.chdir(workdir);
  await writeFile(
    path.join(workdir, "data", "brand.json"),
    JSON.stringify({ ...DEFAULT_BRAND, name: "Studio Aurora" }, null, 2)
  );
});

afterEach(async () => {
  director.restore();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

describe("carousel API responses for a carousel stored with a reference's server path (#62)", () => {
  it("never return the path from any carousel, reference or template route", async () => {
    const url = await uploadPng();
    await storeLegacyCarousel(url, path.join(uploads, path.basename(url)));
    const id = LEGACY_ID;

    await bodyWithoutServerPaths("GET /api/carousels", listCarouselsRoute(json("GET", "/api/carousels")));
    await bodyWithoutServerPaths(
      "GET /api/carousels?brandId=",
      listCarouselsRoute(json("GET", "/api/carousels?brandId=default"))
    );
    await bodyWithoutServerPaths(
      "GET /api/carousels?view=summary",
      listCarouselsRoute(json("GET", "/api/carousels?view=summary"))
    );
    await bodyWithoutServerPaths(
      "POST /api/carousels",
      createCarouselRoute(json("POST", "/api/carousels", { name: "Fresh" }))
    );

    const one = await bodyWithoutServerPaths(
      "GET /api/carousels/[id]",
      getCarouselRoute(json("GET", `/api/carousels/${id}`), params({ id }))
    );
    await bodyWithoutServerPaths(
      "PUT /api/carousels/[id]",
      putCarouselRoute(json("PUT", `/api/carousels/${id}`, { name: "Renamed" }), params({ id }))
    );

    const references = await bodyWithoutServerPaths(
      "GET /api/carousels/[id]/references",
      listReferencesRoute(json("GET", `/api/carousels/${id}/references`), params({ id }))
    );
    const added = JSON.parse(
      await bodyWithoutServerPaths(
        "POST /api/carousels/[id]/references",
        addReferenceRoute(
          json("POST", `/api/carousels/${id}/references`, { url: await uploadPng(), name: "new mood" }),
          params({ id })
        )
      )
    );
    await bodyWithoutServerPaths(
      "DELETE /api/carousels/[id]/references",
      deleteReferenceRoute(json("DELETE", `/api/carousels/${id}/references?imageId=${added.id}`), params({ id }))
    );

    await bodyWithoutServerPaths(
      "POST /api/carousels/[id]/slides",
      addSlideRoute(json("POST", `/api/carousels/${id}/slides`, { html: "<h1>Three</h1>" }), params({ id }))
    );
    await bodyWithoutServerPaths(
      "PUT /api/carousels/[id]/slides/[slideId]",
      updateSlideRoute(
        json("PUT", `/api/carousels/${id}/slides/slide-2`, { html: "<h1>Two, again</h1>" }),
        params({ id, slideId: "slide-2" })
      )
    );
    await bodyWithoutServerPaths(
      "POST /api/carousels/[id]/slides/[slideId]/undo",
      undoSlideRoute(json("POST", `/api/carousels/${id}/slides/slide-1/undo`), params({ id, slideId: "slide-1" }))
    );
    const slideIds = JSON.parse(
      await bodyWithoutServerPaths(
        "GET /api/carousels/[id] (after slide changes)",
        getCarouselRoute(json("GET", `/api/carousels/${id}`), params({ id }))
      )
    ).slides.map((s: { id: string }) => s.id);
    await bodyWithoutServerPaths(
      "PUT /api/carousels/[id]/slides",
      reorderSlidesRoute(json("PUT", `/api/carousels/${id}/slides`, { slideIds: [...slideIds].reverse() }), params({ id }))
    );
    await bodyWithoutServerPaths(
      "GET /api/carousels/[id]/caption",
      getCaptionRoute(json("GET", `/api/carousels/${id}/caption`), params({ id }))
    );
    await bodyWithoutServerPaths(
      "PUT /api/carousels/[id]/caption",
      putCaptionRoute(json("PUT", `/api/carousels/${id}/caption`, { caption: "Hi", hashtags: [] }), params({ id }))
    );
    await bodyWithoutServerPaths(
      "GET /api/carousels/[id]/generation",
      generationRoute(json("GET", `/api/carousels/${id}/generation`), params({ id }))
    );

    const duplicate = JSON.parse(
      await bodyWithoutServerPaths(
        "POST /api/carousels/[id]/duplicate",
        duplicateRoute(json("POST", `/api/carousels/${id}/duplicate`), params({ id }))
      )
    );

    const template = JSON.parse(
      await bodyWithoutServerPaths(
        "POST /api/templates",
        saveTemplateRoute(json("POST", "/api/templates", { carouselId: id }))
      )
    );
    await bodyWithoutServerPaths("GET /api/templates", listTemplatesRoute(json("GET", "/api/templates")));
    await bodyWithoutServerPaths(
      "GET /api/templates/[id]",
      getTemplateRoute(json("GET", `/api/templates/${template.id}`), params({ id: template.id }))
    );
    await bodyWithoutServerPaths(
      "POST /api/templates/[id]/use",
      useTemplateRoute(json("POST", `/api/templates/${template.id}/use`, {}), params({ id: template.id }))
    );

    // Every list after all of that, including the duplicate and the project
    // made from the template.
    await bodyWithoutServerPaths("GET /api/carousels (after)", listCarouselsRoute(json("GET", "/api/carousels")));
    expect(leaks).toEqual([]);

    // The browser still gets everything it uses about the reference.
    const publicLegacy = { id: "ref-legacy", url, name: "legacy mood", addedAt: TIME };
    expect(JSON.parse(one).referenceImages).toEqual([publicLegacy]);
    expect(JSON.parse(references).references).toEqual([publicLegacy]);
    expect(duplicate.referenceImages).toEqual([publicLegacy]);
  });

  it("does not copy the stored path into a duplicate, and leaves the original record as it was", async () => {
    const url = await uploadPng();
    const storedPath = path.join(uploads, path.basename(url));
    await storeLegacyCarousel(url, storedPath);

    const res = await duplicateRoute(json("POST", `/api/carousels/${LEGACY_ID}/duplicate`), params({ id: LEGACY_ID }));
    expect(res.status).toBe(201);
    const copyId = (await res.json()).id;

    const stored = JSON.parse(await readFile(path.join(workdir, "data", "carousels.json"), "utf8"));
    const byId = new Map(stored.carousels.map((c: { id: string }) => [c.id, c]));
    expect(JSON.stringify(byId.get(copyId))).not.toContain("absPath");
    // Existing data is never rewritten: the old record keeps what it had.
    expect((byId.get(LEGACY_ID) as { referenceImages: { absPath: string }[] }).referenceImages[0].absPath).toBe(
      storedPath
    );
  });
});

describe("adding a reference image (#62)", () => {
  it("stores no server path, even when the request sends one", async () => {
    const createRes = await createCarouselRoute(json("POST", "/api/carousels", { name: "Refs" }));
    const id = (await createRes.json()).id;
    const url = await uploadPng();

    const text = await bodyWithoutServerPaths(
      "POST /api/carousels/[id]/references",
      addReferenceRoute(
        json("POST", `/api/carousels/${id}/references`, { url, name: "mood.png", absPath: "/etc/hosts" }),
        params({ id })
      )
    );
    expect(leaks).toEqual([]);
    const ref = JSON.parse(text);
    expect(Object.keys(ref).sort()).toEqual(["addedAt", "id", "name", "url"]);
    expect(ref.url).toBe(url);

    const raw = await readFile(path.join(workdir, "data", "carousels.json"), "utf8");
    expect(raw).not.toContain("absPath");
    expect(raw).not.toContain(workdir);
    expect(raw).not.toContain(realWorkdir);
    expect(raw).not.toContain("/etc/hosts");
    const stored = JSON.parse(raw).carousels.find((c: { id: string }) => c.id === id);
    expect(stored.referenceImages).toEqual([ref]);
  });
});

describe("reference paths on the server (#62)", () => {
  it("still reach the prompt, the Visual Director and the design handoff, confined, for old and new records", async () => {
    const legacyUrl = await uploadPng();
    // A stale stored path, to show the one used is derived now, not read back.
    await storeLegacyCarousel(legacyUrl, path.join(workdir, "stale", "never-used.png"));
    const newUrl = await uploadPng();
    const addRes = await addReferenceRoute(
      json("POST", `/api/carousels/${LEGACY_ID}/references`, { url: newUrl, name: "new mood" }),
      params({ id: LEGACY_ID })
    );
    expect(addRes.status).toBe(201);
    const newId = (await addRes.json()).id;

    const realUploads = await realpath(uploads);
    const confinedLegacy = path.join(realUploads, path.basename(legacyUrl));
    const confinedNew = path.join(realUploads, path.basename(newUrl));

    director.restore();
    director = stubDirector((request) => {
      const plan = typographyPlanFor(request);
      plan.execution.slides = plan.execution.slides.map((s) =>
        s.index === 1
          ? { ...s, treatment: "uploaded-placement", assetRefs: ["ref-legacy"], styleReferenceIds: [newId] }
          : s
      );
      return plan;
    });

    const res = await chat(json("POST", "/api/chat", { message: "Make it with my photo", carouselId: LEGACY_ID }) as never);
    expect(res.status).toBe(200);
    await res.text();

    // The Visual Director is given both references at their confined paths.
    expect(director.requests).toHaveLength(1);
    expect(director.requests[0].references.map((r) => [r.id, r.absPath])).toEqual([
      ["ref-legacy", confinedLegacy],
      [newId, confinedNew],
    ]);

    const args = spawned.at(-1)!;
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    expect(prompt).toContain(`- "legacy mood" → ${confinedLegacy}`);
    expect(prompt).toContain(`- "new mood" → ${confinedNew}`);

    const task = args[args.indexOf("--") + 1];
    expect(task).toContain(`${legacyUrl} (view it with Read at ${confinedLegacy})`);
    expect(task).toContain(`(${confinedNew}) without placing it`);
    expect(prompt + task).not.toContain("never-used.png");
  });
});
