import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AspectRatio, Carousel, Slide } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { pdfPageSize } from "@/lib/export-pdf";
import {
  detailedSlidePng,
  readPdfPages,
  readZipEntries,
  rgbPixels,
  syntheticSlidePng,
} from "./helpers/export-files";

// The route is exercised for real; only storage and the Chromium renderer are
// replaced, so these tests run without a browser and without ./data.
vi.mock("@/lib/carousels", () => ({ getCarousel: vi.fn() }));
vi.mock("@/lib/export-slides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/export-slides")>()),
  exportAllSlides: vi.fn(),
}));

const { getCarousel } = await import("@/lib/carousels");
const { exportAllSlides } = await import("@/lib/export-slides");
const { POST } = await import("@/app/api/carousels/[id]/export/route");
const { beginGeneration, acceptInterruptedSlides } = await import(
  "@/lib/generation-status"
);

// How each generation ended is saved under ./data, so the route runs from a
// throwaway working directory rather than the repository's.
let workdir: string;
let originalCwd: string;
beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-export-route-"));
  process.chdir(workdir);
});
afterAll(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

const getCarouselMock = vi.mocked(getCarousel);
const exportAllSlidesMock = vi.mocked(exportAllSlides);

function carousel(aspectRatio: AspectRatio, slideCount: number): Carousel {
  const slides: Slide[] = Array.from({ length: slideCount }, (_, i) => ({
    id: `s${i + 1}`,
    html: `<div>Slide ${i + 1}</div>`,
    previousVersions: [],
    order: i,
    notes: "",
  }));
  return {
    id: "c1",
    name: "Launch week: v2!",
    aspectRatio,
    slides,
    referenceImages: [],
    chatSessionId: null,
    isTemplate: false,
    tags: [],
    createdAt: "",
    updatedAt: "",
  };
}

/** Stands in for the Chromium renderer: one distinct PNG per slide, in order. */
async function renderedPngs(aspectRatio: AspectRatio, count: number) {
  const { width, height } = DIMENSIONS[aspectRatio];
  return Promise.all(
    Array.from({ length: count }, async (_, i) => ({
      name: `slide-${i + 1}.png`,
      buffer: await syntheticSlidePng(width, height, {
        r: 30 * i,
        g: 200 - 30 * i,
        b: 90,
      }),
    }))
  );
}

function exportRequest(query = "") {
  return POST(
    new Request(`http://localhost:3000/api/carousels/c1/export${query}`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "c1" }) }
  );
}

beforeEach(() => {
  getCarouselMock.mockReset();
  exportAllSlidesMock.mockReset();
});

describe("PNG ZIP export (unchanged)", () => {
  it("still answers a request without a format with the ZIP of PNGs", async () => {
    const rendered = await renderedPngs("4:5", 3);
    getCarouselMock.mockResolvedValue(carousel("4:5", 3));
    exportAllSlidesMock.mockResolvedValue(rendered);

    const response = await exportRequest();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="carousel-Launch_week__v2_.zip"'
    );
    const entries = readZipEntries(Buffer.from(await response.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual([
      "slide-1.png",
      "slide-2.png",
      "slide-3.png",
    ]);
    // The PNGs inside are byte-for-byte what the renderer produced.
    entries.forEach((entry, i) =>
      expect(entry.data.equals(rendered[i].buffer)).toBe(true)
    );
  });

  it("renders with the carousel's slides and aspect ratio, once", async () => {
    const c = carousel("9:16", 2);
    getCarouselMock.mockResolvedValue(c);
    exportAllSlidesMock.mockResolvedValue(await renderedPngs("9:16", 2));

    await exportRequest();

    expect(exportAllSlidesMock).toHaveBeenCalledTimes(1);
    expect(exportAllSlidesMock).toHaveBeenCalledWith(c.slides, "9:16");
  });

  it("treats ?format=png exactly like no format", async () => {
    const rendered = await renderedPngs("1:1", 2);
    getCarouselMock.mockResolvedValue(carousel("1:1", 2));
    exportAllSlidesMock.mockResolvedValue(rendered);

    const implicit = await exportRequest();
    const explicit = await exportRequest("?format=png");

    expect(explicit.status).toBe(implicit.status);
    expect([...explicit.headers.entries()]).toEqual([
      ...implicit.headers.entries(),
    ]);
    const a = readZipEntries(Buffer.from(await implicit.arrayBuffer()));
    const b = readZipEntries(Buffer.from(await explicit.arrayBuffer()));
    expect(b.map((e) => e.name)).toEqual(a.map((e) => e.name));
    b.forEach((entry, i) => expect(entry.data.equals(a[i].data)).toBe(true));
  });
});

describe("LinkedIn PDF export", () => {
  for (const ratio of ["4:5", "1:1", "9:16"] as AspectRatio[]) {
    it(`returns one ${ratio} PDF page per rendered slide, in order`, async () => {
      const rendered = await renderedPngs(ratio, 4);
      getCarouselMock.mockResolvedValue(carousel(ratio, 4));
      exportAllSlidesMock.mockResolvedValue(rendered);

      const response = await exportRequest("?format=pdf");

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/pdf");
      expect(response.headers.get("Content-Disposition")).toBe(
        'attachment; filename="carousel-Launch_week__v2_.pdf"'
      );

      const pages = await readPdfPages(new Uint8Array(await response.arrayBuffer()));
      expect(pages).toHaveLength(4);
      for (const [i, page] of pages.entries()) {
        expect({ width: page.width, height: page.height }).toEqual(
          pdfPageSize(ratio)
        );
        expect(
          page.images[0].pixels.equals(await rgbPixels(rendered[i].buffer))
        ).toBe(true);
      }
    });
  }

  it("renders the slides once, through the same renderer as the ZIP", async () => {
    const c = carousel("4:5", 2);
    getCarouselMock.mockResolvedValue(c);
    exportAllSlidesMock.mockResolvedValue(await renderedPngs("4:5", 2));

    await exportRequest("?format=pdf");

    expect(exportAllSlidesMock).toHaveBeenCalledTimes(1);
    expect(exportAllSlidesMock).toHaveBeenCalledWith(c.slides, "4:5");
  });

  it(
    "refuses a PDF above LinkedIn's 100 MB limit with an actionable error",
    async () => {
      // 20 story slides of incompressible detail is the largest carousel
      // CreatorBrio allows, and it does not fit in a LinkedIn document.
      const noise = await detailedSlidePng(1080, 1920, 11);
      getCarouselMock.mockResolvedValue(carousel("9:16", 20));
      exportAllSlidesMock.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          name: `slide-${i + 1}.png`,
          buffer: noise,
        }))
      );

      const response = await exportRequest("?format=pdf");

      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(
        /^The PDF is \d+\.\d MB, above LinkedIn's 100\.0 MB limit\. Remove slides/
      );
    },
    120_000
  );
});

describe("single PNG download", () => {
  for (const ratio of ["1:1", "4:5", "9:16"] as AspectRatio[]) {
    it(`answers a one-slide ${ratio} carousel with the PNG the ZIP holds, byte for byte`, async () => {
      const rendered = await renderedPngs(ratio, 1);
      getCarouselMock.mockResolvedValue(carousel(ratio, 1));
      exportAllSlidesMock.mockResolvedValue(rendered);

      const single = await exportRequest("?format=single-png");
      const zip = await exportRequest();

      expect(single.status).toBe(200);
      expect(single.headers.get("Content-Type")).toBe("image/png");
      expect(single.headers.get("Content-Disposition")).toBe(
        'attachment; filename="carousel-Launch_week__v2_.png"'
      );
      const png = Buffer.from(await single.arrayBuffer());
      const [entry] = readZipEntries(Buffer.from(await zip.arrayBuffer()));
      expect(entry.name).toBe("slide-1.png");
      expect(png.equals(entry.data)).toBe(true);
      expect(png.equals(rendered[0].buffer)).toBe(true);

      // An ordinary, directly openable PNG at the slide's exact size.
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
      const { width, height } = DIMENSIONS[ratio];
      expect(png.readUInt32BE(16)).toBe(width);
      expect(png.readUInt32BE(20)).toBe(height);
    });
  }

  it("sends exactly the PNG's bytes when it sits inside a larger allocation", async () => {
    // Node pools small Buffers, so a rendered PNG can be a view at a non-zero
    // offset into a bigger ArrayBuffer. Only the PNG's own bytes may be sent.
    const [rendered] = await renderedPngs("1:1", 1);
    const pool = Buffer.alloc(rendered.buffer.length + 64, 0xab);
    rendered.buffer.copy(pool, 32);
    const pooled = pool.subarray(32, 32 + rendered.buffer.length);
    expect(pooled.byteOffset).toBeGreaterThan(0);
    getCarouselMock.mockResolvedValue(carousel("1:1", 1));
    exportAllSlidesMock.mockResolvedValue([{ name: "slide-1.png", buffer: pooled }]);

    const png = Buffer.from(await (await exportRequest("?format=single-png")).arrayBuffer());

    expect(png.length).toBe(rendered.buffer.length);
    expect(png.equals(rendered.buffer)).toBe(true);
  });

  it("renders through the same renderer as the ZIP, once", async () => {
    const c = carousel("4:5", 1);
    getCarouselMock.mockResolvedValue(c);
    exportAllSlidesMock.mockResolvedValue(await renderedPngs("4:5", 1));

    await exportRequest("?format=single-png");

    expect(exportAllSlidesMock).toHaveBeenCalledTimes(1);
    expect(exportAllSlidesMock).toHaveBeenCalledWith(c.slides, "4:5");
  });

  it("refuses a multi-slide carousel before rendering, pointing to the ZIP", async () => {
    getCarouselMock.mockResolvedValue(carousel("4:5", 3));

    const response = await exportRequest("?format=single-png");

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /only available for a carousel with one slide.*PNG ZIP/
    );
    expect(exportAllSlidesMock).not.toHaveBeenCalled();
  });

  it("leaves a one-slide ZIP and PDF as they were", async () => {
    const rendered = await renderedPngs("1:1", 1);
    getCarouselMock.mockResolvedValue(carousel("1:1", 1));
    exportAllSlidesMock.mockResolvedValue(rendered);

    const zip = await exportRequest("?format=png");
    expect(zip.headers.get("Content-Type")).toBe("application/zip");
    const entries = readZipEntries(Buffer.from(await zip.arrayBuffer()));
    expect(entries).toHaveLength(1);
    expect(entries[0].data.equals(rendered[0].buffer)).toBe(true);

    const pdf = await exportRequest("?format=pdf");
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    const pages = await readPdfPages(new Uint8Array(await pdf.arrayBuffer()));
    expect(pages).toHaveLength(1);
    expect(
      pages[0].images[0].pixels.equals(await rgbPixels(rendered[0].buffer))
    ).toBe(true);
  });
});

describe("export during generation", () => {
  for (const query of ["", "?format=png", "?format=pdf", "?format=single-png"]) {
    it(`refuses with 409 before rendering (${query || "no format"})`, async () => {
      getCarouselMock.mockResolvedValue(carousel("4:5", 1));
      const end = beginGeneration("c1")!.end;
      try {
        const response = await exportRequest(query);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error:
            "Slides are still being generated. Export will be available as soon as generation finishes.",
        });
        expect(exportAllSlidesMock).not.toHaveBeenCalled();
      } finally {
        await end("completed");
      }
    });
  }

  it("exports normally once the run has ended", async () => {
    getCarouselMock.mockResolvedValue(carousel("4:5", 2));
    exportAllSlidesMock.mockResolvedValue(await renderedPngs("4:5", 2));
    await beginGeneration("c1")!.end("completed");

    const response = await exportRequest();

    expect(response.status).toBe(200);
  });

  it("does not block other carousels", async () => {
    getCarouselMock.mockResolvedValue(carousel("4:5", 1));
    exportAllSlidesMock.mockResolvedValue(await renderedPngs("4:5", 1));
    const end = beginGeneration("another-carousel")!.end;
    try {
      expect((await exportRequest()).status).toBe(200);
    } finally {
      await end("completed");
    }
  });
});

describe("export after an interrupted generation", () => {
  for (const reason of ["stopped", "failed", "timed-out"] as const) {
    it(`refuses a carousel whose generation ${reason} after changing slides, in every format`, async () => {
      getCarouselMock.mockResolvedValue(carousel("4:5", 1));
      const run = beginGeneration("c1")!;
      await run.ready;
      // The run rewrites the carousel's slide before it ends.
      const rewritten = carousel("4:5", 1);
      rewritten.slides[0].html = "<div>Rewritten by the agent</div>";
      getCarouselMock.mockResolvedValue(rewritten);
      await run.end(reason);

      for (const query of ["", "?format=png", "?format=pdf", "?format=single-png"]) {
        const response = await exportRequest(query);
        expect(response.status).toBe(409);
        const body = (await response.json()) as {
          error: string;
          interrupted: { reason: string };
        };
        expect(body.error).toMatch(/before it finished, so these slides may be incomplete/);
        expect(body.interrupted.reason).toBe(reason);
      }
      expect(exportAllSlidesMock).not.toHaveBeenCalled();

      // The user confirms the slides as they are; nothing about them changes.
      expect(await acceptInterruptedSlides("c1")).toBe(true);
      exportAllSlidesMock.mockResolvedValue(await renderedPngs("4:5", 1));
      expect((await exportRequest()).status).toBe(200);
    });
  }

  it("exports normally after an interrupted run that changed nothing", async () => {
    getCarouselMock.mockResolvedValue(carousel("4:5", 1));
    exportAllSlidesMock.mockResolvedValue(await renderedPngs("4:5", 1));
    await beginGeneration("c1")!.end("stopped");

    expect((await exportRequest()).status).toBe(200);
  });
});

describe("export errors", () => {
  it("rejects an unknown format before rendering anything", async () => {
    getCarouselMock.mockResolvedValue(carousel("4:5", 2));

    const response = await exportRequest("?format=docx");

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /Unknown export format/
    );
    expect(exportAllSlidesMock).not.toHaveBeenCalled();
  });

  for (const query of ["", "?format=pdf", "?format=single-png"]) {
    it(`answers 404 for a missing carousel (${query || "no format"})`, async () => {
      getCarouselMock.mockResolvedValue(null);
      const response = await exportRequest(query);
      expect(response.status).toBe(404);
      expect(exportAllSlidesMock).not.toHaveBeenCalled();
    });

    it(`refuses an empty carousel (${query || "no format"})`, async () => {
      getCarouselMock.mockResolvedValue(carousel("4:5", 0));
      const response = await exportRequest(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "No slides to export" });
      expect(exportAllSlidesMock).not.toHaveBeenCalled();
    });

    it(`reports a render failure safely (${query || "no format"})`, async () => {
      getCarouselMock.mockResolvedValue(carousel("4:5", 1));
      exportAllSlidesMock.mockRejectedValue(
        new Error("Failed to launch the browser process! /home/x/chrome")
      );
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await exportRequest(query);

      expect(response.status).toBe(500);
      const { error } = (await response.json()) as { error: string };
      expect(error).toContain("npx puppeteer browsers install chrome");
      expect(error).not.toContain("/home/x");
      spy.mockRestore();
    });
  }

  it("reports a slide rendered at the wrong size as a failure, not a distorted page", async () => {
    getCarouselMock.mockResolvedValue(carousel("4:5", 1));
    exportAllSlidesMock.mockResolvedValue([
      {
        name: "slide-1.png",
        buffer: await syntheticSlidePng(1080, 1080, { r: 0, g: 0, b: 0 }),
      },
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await exportRequest("?format=pdf");

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    spy.mockRestore();
  });
});
