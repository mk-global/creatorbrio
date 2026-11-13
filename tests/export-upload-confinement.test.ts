import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Slide } from "@/types/carousel";
import { appBrowser, inCi } from "./helpers/app-browser";

// Carousel export inlines the uploaded images a slide references (#145). Slide
// HTML is untrusted, so the export must read only the app's own uploads,
// directly under public/uploads, and inline only real images. Every path the
// export opens or reads is recorded here, so "never read" is checked directly,
// not inferred from what the output happens to show.

const opened: string[] = [];
function recorded<T extends Record<string, unknown>>(actual: T): T {
  const wrap = (name: "open" | "readFile") => {
    const real = actual[name] as (...args: unknown[]) => unknown;
    return (...args: unknown[]) => {
      if (typeof args[0] === "string") opened.push(path.resolve(args[0]));
      return real(...args);
    };
  };
  return { ...actual, default: actual, open: wrap("open"), readFile: wrap("readFile") };
}
vi.mock("node:fs/promises", async (importOriginal) => recorded(await importOriginal()));
vi.mock("fs/promises", async (importOriginal) => recorded(await importOriginal()));

const LEGIT = "0b6b5c3e-1d2f-4a5b-8c7d-9e0f1a2b3c4d";
const LINKED = "1c7c6d4f-2e3a-4b6c-9d8e-0f1a2b3c4d5e";
const NOT_AN_IMAGE = "2d8d7e5a-3f4b-4c7d-8e9f-1a2b3c4d5e6f";
const JPEG = "3e9e8f6b-4a5c-4d8e-9f0a-2b3c4d5e6f7a";

/** A solid image of `size` pixels; the forbidden files are real images, so inlining one would show. */
const solid = (size: number, rgb: [number, number, number], format: "png" | "jpeg" = "png") =>
  sharp({ create: { width: size, height: size, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    [format]()
    .toBuffer();

const slide = (html: string): Slide => ({ id: "s1", html, previousVersions: [], order: 0, notes: "" });

let work: string;
let originalCwd: string;
let secrets: string[];
let secretBase64: string[];

beforeAll(async () => {
  originalCwd = process.cwd();
  work = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-upload-confinement-")));
  const uploads = path.join(work, "public", "uploads");
  await mkdir(path.join(uploads, "fonts"), { recursive: true });
  await mkdir(path.join(work, "data"), { recursive: true });

  const red = await solid(48, [220, 20, 20]);
  secrets = [path.join(work, "public", "secret.png"), path.join(work, "data", "secret.png"), path.join(work, "secret.png")];
  for (const file of secrets) await writeFile(file, red);
  secretBase64 = [red.toString("base64").slice(0, 64)];

  await writeFile(path.join(uploads, `${LEGIT}.png`), await solid(40, [20, 180, 60]));
  await writeFile(path.join(uploads, `${JPEG}.png`), await solid(40, [20, 60, 180], "jpeg"));
  await writeFile(path.join(uploads, `${NOT_AN_IMAGE}.png`), "not an image, only text");
  await symlink(path.join(work, "secret.png"), path.join(uploads, `${LINKED}.png`));
  process.chdir(work);
});

afterAll(async () => {
  process.chdir(originalCwd);
  if (work) await rm(work, { recursive: true, force: true });
});

beforeEach(() => {
  opened.length = 0;
});

/** Every way a reference could leave public/uploads or name something that is not an upload. */
const ESCAPES = [
  "/uploads/../secret.png",
  "/uploads/../../data/secret.png",
  "/uploads/../../secret.png",
  `/uploads/${LEGIT}.png/../../secret.png`,
  "/uploads/fonts/../../data/secret.png",
  "/uploads/%2e%2e/secret.png",
  "/uploads/..%2fsecret.png",
  `/uploads/${LINKED}.png`,
];

function readSecret(): string[] {
  return opened.filter((p) => secrets.includes(p));
}

describe("inlining uploaded images for export", () => {
  it("never reads or inlines a reference outside public/uploads, in src or CSS url()", async () => {
    const { inlineImages } = await import("@/lib/export-slides");
    for (const escape of ESCAPES) {
      const html = `<img src="${escape}"><div style="background:url('${escape}')"></div><div style="background:url(${escape})"></div>`;
      const out = await inlineImages(html);
      expect(out, escape).toBe(html);
      expect(readSecret(), escape).toEqual([]);
      for (const bytes of secretBase64) expect(out).not.toContain(bytes);
    }
  });

  it("leaves a file with an upload's name but no image bytes untouched", async () => {
    const { inlineImages } = await import("@/lib/export-slides");
    const html = `<img src="/uploads/${NOT_AN_IMAGE}.png">`;
    expect(await inlineImages(html)).toBe(html);
  });

  it("inlines every occurrence of a real upload, labelled by its bytes", async () => {
    const { inlineImages } = await import("@/lib/export-slides");
    const out = await inlineImages(
      `<img src="/uploads/${LEGIT}.png"><i style="background:url('/uploads/${LEGIT}.png')"></i><b style="background:url(/uploads/${LEGIT}.png)"></b><img src='/uploads/${JPEG}.png'>`
    );
    expect(out).not.toContain("/uploads/");
    expect(out.match(/data:image\/png;base64,/g)).toHaveLength(3);
    expect(out).toContain("<img src='data:image/jpeg;base64,");
  });

  it("keeps a real upload next to an escaping reference", async () => {
    const { inlineImages } = await import("@/lib/export-slides");
    const out = await inlineImages(`<img src="/uploads/${LEGIT}.png"><img src="/uploads/../secret.png">`);
    expect(out).toMatch(/^<img src="data:image\/png;base64,[^"]+"><img src="\/uploads\/\.\.\/secret\.png">$/);
    expect(readSecret()).toEqual([]);
  });
});

// The real PNG and PDF exports. In CI these use the runner's Chrome and must
// run: a missing browser fails the suite rather than skipping it, so the
// security check cannot pass by not running.
const browser = appBrowser();

describe.skipIf(!browser && !inCi)("PNG and PDF export of a slide referencing files outside uploads", () => {
  let previousExecutable: string | undefined;
  const html = `<div style="width:100%;height:100%;background:#ffffff;font-family:Georgia,serif">
    <p style="margin:0;font-size:40px">Confined</p>
    <img src="/uploads/${LEGIT}.png" style="position:absolute;left:100px;top:200px;width:200px;height:200px">
    <img src="/uploads/../../secret.png" style="position:absolute;left:500px;top:200px;width:200px;height:200px">
    <div style="position:absolute;left:100px;top:600px;width:200px;height:200px;background:url('/uploads/../secret.png') center/cover"></div>
  </div>`;

  beforeAll(() => {
    if (!browser) throw new Error("No Chromium or Chrome found: the export confinement tests must run in CI.");
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = browser;
  });

  afterAll(() => {
    if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
  });

  it("PNG shows the real upload and nothing read from outside uploads", async () => {
    const { exportSlide } = await import("@/lib/export-slides");
    const png = await exportSlide(slide(html), "1:1");
    expect(readSecret()).toEqual([]);

    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    expect(at(200, 300)).toEqual([20, 180, 60]);
    for (const [x, y] of [[600, 300], [200, 700]]) {
      const [r, g, b] = at(x, y);
      expect(r > 150 && g < 80 && b < 80, `pixel ${x},${y} is ${r},${g},${b}`).toBe(false);
    }
  }, 60_000);

  it("PDF prints the real upload only and reads nothing outside uploads", async () => {
    const { exportSlidePdf } = await import("@/lib/export-slides");
    const { inspectPdf } = await import("@/lib/pdf-content");
    const pdf = await exportSlidePdf(slide(html), "1:1");
    expect(readSecret()).toEqual([]);
    const [page] = await inspectPdf(pdf);
    expect(page.images.map((i) => `${i.width}x${i.height}`)).toEqual(["40x40"]);
  }, 60_000);
});
