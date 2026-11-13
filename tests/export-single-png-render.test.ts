import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import sharp from "sharp";
import type { AspectRatio, Carousel } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { readZipEntries, rgbPixels } from "./helpers/export-files";

// The single PNG download through the real route and the real Chromium
// renderer, compared with the same slide taken out of the PNG ZIP. Needs
// Chromium, which CI does not install; without it the suite is skipped and
// export-route.test.ts covers the packaging everywhere.
function chromiumPath(): string | null {
  try {
    const candidate = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
    return candidate && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const chromium = chromiumPath();

vi.mock("@/lib/carousels", () => ({ getCarousel: vi.fn() }));

/** Synthetic one-slide carousel: text in a web font, italics, an uploaded image, a gradient. */
function oneSlideCarousel(aspectRatio: AspectRatio): Carousel {
  return {
    id: "render-check",
    name: "Reel cover",
    aspectRatio,
    slides: [
      {
        id: "s1",
        html: `<div style="width:100%;height:100%;background:linear-gradient(160deg,#f7f3e9,#e94560);font-family:'Playfair Display',serif;color:#1a1a2e;padding:80px;box-sizing:border-box">
          <h1 style="font-size:110px;margin:0">Reel cover</h1>
          <p style="font-size:44px;font-style:italic">Synthetic fidelity check</p>
          <img src="/uploads/6b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e.png" style="display:block;width:300px;height:300px" />
        </div>`,
        previousVersions: [],
        order: 0,
        notes: "",
      },
    ],
    referenceImages: [],
    chatSessionId: null,
    isTemplate: false,
    tags: [],
    createdAt: "",
    updatedAt: "",
  };
}

describe.skipIf(!chromium)("single PNG download through the real renderer", () => {
  let workdir: string;
  let originalCwd: string;
  let previousExecutable: string | undefined;
  let POST: typeof import("@/app/api/carousels/[id]/export/route").POST;
  let getCarouselMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    originalCwd = process.cwd();
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = chromium!;

    workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-single-png-"));
    await mkdir(path.join(workdir, "public", "uploads"), { recursive: true });
    await mkdir(path.join(workdir, "data"), { recursive: true });
    await writeFile(
      path.join(workdir, "public", "uploads", "6b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e.png"),
      await sharp({
        create: { width: 300, height: 300, channels: 3, background: { r: 22, g: 160, b: 133 } },
      })
        .png()
        .toBuffer()
    );
    process.chdir(workdir);

    ({ POST } = await import("@/app/api/carousels/[id]/export/route"));
    const { getCarousel } = await import("@/lib/carousels");
    getCarouselMock = vi.mocked(getCarousel);
  }, 60_000);

  afterAll(async () => {
    process.chdir(originalCwd);
    if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  async function download(query: string): Promise<Response> {
    return POST(
      new Request(`http://localhost:3000/api/carousels/render-check/export${query}`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "render-check" }) }
    );
  }

  for (const ratio of ["1:1", "4:5", "9:16"] as AspectRatio[]) {
    it(
      `downloads a ${ratio} slide with the same pixels as its PNG in the ZIP`,
      async () => {
        getCarouselMock.mockResolvedValue(oneSlideCarousel(ratio));

        const single = await download("?format=single-png");
        expect(single.status).toBe(200);
        expect(single.headers.get("Content-Type")).toBe("image/png");
        const png = Buffer.from(await single.arrayBuffer());

        const zip = await download("");
        expect(zip.status).toBe(200);
        const [entry] = readZipEntries(Buffer.from(await zip.arrayBuffer()));

        const meta = await sharp(png).metadata();
        expect(meta.format).toBe("png");
        expect([meta.width, meta.height]).toEqual([
          DIMENSIONS[ratio].width,
          DIMENSIONS[ratio].height,
        ]);
        expect(meta.space).toBe("srgb");
        expect((await rgbPixels(png)).equals(await rgbPixels(entry.data))).toBe(true);
      },
      120_000
    );
  }
});
