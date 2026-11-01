import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

// The Claude CLI is replaced by a stub that records its arguments, so the real
// chat route builds and passes its system prompt without spawning anything.
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

import { POST as chat } from "@/app/api/chat/route";
import { POST as addReference } from "@/app/api/carousels/[id]/references/route";
import { confineUploadedPng, MAX_REFERENCE_BYTES } from "@/lib/reference-images";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { addReferenceImage, createCarousel, duplicateCarousel, getCarousel } from "@/lib/carousels";
import { DEFAULT_BRAND } from "@/types/brand";
import type { Carousel } from "@/types/carousel";

let workdir: string;
let uploads: string;
let originalCwd: string;

async function png(width = 32, height = 32): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

/** Writes a real PNG upload and returns its URL. */
async function uploadPng(): Promise<string> {
  const name = `${randomUUID()}.png`;
  await writeFile(path.join(uploads, name), await png());
  return `/uploads/${name}`;
}

beforeEach(async () => {
  spawned.length = 0;
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-references-"));
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
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

function register(carouselId: string, body: unknown) {
  return addReference(
    new Request(`http://localhost:3000/api/carousels/${carouselId}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: carouselId }) }
  );
}

async function systemPromptFor(carouselId: string): Promise<string> {
  const res = await chat(
    new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost:3000" },
      body: JSON.stringify({ message: "Make a carousel", carouselId }),
    }) as never
  );
  expect(res.status).toBe(200);
  await res.text();
  const args = spawned.at(-1)!;
  return args[args.indexOf("--append-system-prompt") + 1];
}

describe("confineUploadedPng", () => {
  it("accepts an uploaded PNG and derives its path inside the real uploads directory", async () => {
    const url = await uploadPng();
    const result = await confineUploadedPng(url);
    expect(result).toEqual({
      ok: true,
      url,
      absPath: path.join(await realpath(uploads), path.basename(url)),
    });
  });

  const id = "0f8b7c2e-3d4a-4b5c-9d6e-7f8091a2b3c4";
  it.each([
    ["a parent-directory segment", `/uploads/../${id}.png`],
    ["an escape to a system file", "/uploads/../../../../etc/hosts"],
    ["a percent-encoded separator", `/uploads/..%2F${id}.png`],
    ["percent-encoded dots", `/uploads/%2e%2e/${id}.png`],
    ["an absolute filesystem path", "/etc/hosts"],
    ["an absolute path to a PNG", `/tmp/${id}.png`],
    ["backslashes", `\\uploads\\${id}.png`],
    ["a nested directory", `/uploads/sub/${id}.png`],
    ["a non-PNG extension", `/uploads/${id}.jpg`],
    ["an upper-case extension", `/uploads/${id}.PNG`],
    ["a font upload", `/uploads/fonts/${id}.woff2`],
    ["a name that is not a UUID", "/uploads/logo.png"],
    ["a full URL", `http://localhost:3000/uploads/${id}.png`],
    ["a query string", `/uploads/${id}.png?x=1`],
    ["a non-string value", 42],
  ])("refuses %s", async (_label, url) => {
    expect(await confineUploadedPng(url)).toEqual({ ok: false, reason: "invalid_url" });
  });

  it("refuses a well-formed URL whose file does not exist", async () => {
    expect(await confineUploadedPng(`/uploads/${randomUUID()}.png`)).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a symlink in uploads that points to a real PNG outside it", async () => {
    const outside = path.join(workdir, "outside.png");
    await writeFile(outside, await png());
    const name = `${randomUUID()}.png`;
    await symlink(outside, path.join(uploads, name));
    expect(await confineUploadedPng(`/uploads/${name}`)).toEqual({ ok: false, reason: "symlink" });
  });

  it("refuses a symlink in uploads that points to a system file", async () => {
    const name = `${randomUUID()}.png`;
    await symlink("/etc/hosts", path.join(uploads, name));
    expect(await confineUploadedPng(`/uploads/${name}`)).toEqual({ ok: false, reason: "symlink" });
  });

  it("refuses a directory and a FIFO named like an upload, without blocking", async () => {
    const dirName = `${randomUUID()}.png`;
    await mkdir(path.join(uploads, dirName));
    expect(await confineUploadedPng(`/uploads/${dirName}`)).toEqual({ ok: false, reason: "not_regular_file" });

    const fifoName = `${randomUUID()}.png`;
    execFileSync("mkfifo", [path.join(uploads, fifoName)]);
    expect(await confineUploadedPng(`/uploads/${fifoName}`)).toEqual({ ok: false, reason: "not_regular_file" });
  });

  it("refuses a file that is not a PNG, and a truncated PNG", async () => {
    const jpegName = `${randomUUID()}.png`;
    await writeFile(
      path.join(uploads, jpegName),
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).jpeg().toBuffer()
    );
    expect(await confineUploadedPng(`/uploads/${jpegName}`)).toEqual({ ok: false, reason: "not_png" });

    const textName = `${randomUUID()}.png`;
    await writeFile(path.join(uploads, textName), "127.0.0.1 localhost\n");
    expect(await confineUploadedPng(`/uploads/${textName}`)).toEqual({ ok: false, reason: "not_png" });

    const full = await png(256, 256);
    const truncatedName = `${randomUUID()}.png`;
    await writeFile(path.join(uploads, truncatedName), full.subarray(0, Math.floor(full.length / 2)));
    expect(await confineUploadedPng(`/uploads/${truncatedName}`)).toEqual({ ok: false, reason: "not_png" });
  });

  it("refuses a file larger than the upload limit", async () => {
    const name = `${randomUUID()}.png`;
    await writeFile(path.join(uploads, name), Buffer.concat([await png(), Buffer.alloc(MAX_REFERENCE_BYTES)]));
    expect(await confineUploadedPng(`/uploads/${name}`)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("POST /api/carousels/[id]/references", () => {
  it("stores a valid upload with a server-derived path", async () => {
    const carousel = await createCarousel("Refs", "4:5");
    const url = await uploadPng();

    const res = await register(carousel.id, { url, name: "mood.png", absPath: "/etc/hosts" });
    expect(res.status).toBe(201);
    const ref = await res.json();
    expect(ref.url).toBe(url);
    expect(ref.absPath).toBe(path.join(await realpath(uploads), path.basename(url)));

    const stored = (await getCarousel(carousel.id))!.referenceImages;
    expect(stored).toHaveLength(1);
    expect(stored[0].absPath).toBe(ref.absPath);
  });

  it.each([
    ["traversal", "/uploads/../../../../etc/hosts"],
    ["an absolute path", "/etc/hosts"],
    ["a percent-encoded separator", "/uploads/..%2F0f8b7c2e-3d4a-4b5c-9d6e-7f8091a2b3c4.png"],
    ["backslashes", "\\uploads\\0f8b7c2e-3d4a-4b5c-9d6e-7f8091a2b3c4.png"],
    ["a non-PNG extension", "/uploads/0f8b7c2e-3d4a-4b5c-9d6e-7f8091a2b3c4.jpg"],
    ["a font", "/uploads/fonts/0f8b7c2e-3d4a-4b5c-9d6e-7f8091a2b3c4.woff2"],
    ["a missing upload", "/uploads/0f8b7c2e-3d4a-4b5c-9d6e-7f8091a2b3c4.png"],
  ])("refuses %s with 400 and stores nothing", async (_label, url) => {
    const carousel = await createCarousel("Refs", "4:5");
    const res = await register(carousel.id, { url, name: "x" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(workdir);
    expect((await getCarousel(carousel.id))!.referenceImages).toEqual([]);
  });

  it("refuses a symlinked upload with 400 and stores nothing", async () => {
    const carousel = await createCarousel("Refs", "4:5");
    const name = `${randomUUID()}.png`;
    await symlink("/etc/hosts", path.join(uploads, name));
    const res = await register(carousel.id, { url: `/uploads/${name}`, name: "x" });
    expect(res.status).toBe(400);
    expect((await getCarousel(carousel.id))!.referenceImages).toEqual([]);
  });

  it("refuses an upload-named file that does not decode as PNG with 400 and stores nothing", async () => {
    const carousel = await createCarousel("Refs", "4:5");
    const name = `${randomUUID()}.png`;
    await writeFile(path.join(uploads, name), "not an image\n");
    const res = await register(carousel.id, { url: `/uploads/${name}`, name: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("not_png");
    expect((await getCarousel(carousel.id))!.referenceImages).toEqual([]);
  });
});

describe("reference images in the design agent's prompt", () => {
  it("offers only confined references, with paths derived now, and never deletes the others", async () => {
    const carousel = await createCarousel("Refs", "9:16");
    const validUrl = await uploadPng();
    const realValid = path.join(await realpath(uploads), path.basename(validUrl));
    const poisonedUrl = await uploadPng();
    const realPoisoned = path.join(await realpath(uploads), path.basename(poisonedUrl));

    // Stored records written before confinement existed, straight into storage.
    await addReferenceImage(carousel.id, {
      id: "ref-valid", url: validUrl, absPath: realValid, name: "valid", addedAt: "2026-10-01T00:00:00.000Z",
    });
    await addReferenceImage(carousel.id, {
      id: "ref-poisoned-path", url: poisonedUrl, absPath: "/etc/hosts", name: "poisoned path", addedAt: "2026-10-01T00:00:00.000Z",
    });
    await addReferenceImage(carousel.id, {
      id: "ref-traversal", url: "/uploads/../../../../etc/passwd", absPath: "/etc/passwd", name: "traversal", addedAt: "2026-10-01T00:00:00.000Z",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const prompt = await systemPromptFor(carousel.id);

    expect(prompt).toContain(`- "valid" → ${realValid}`);
    // The poisoned record's URL is valid, so it is offered at the derived path,
    // never at the stored one.
    expect(prompt).toContain(`- "poisoned path" → ${realPoisoned}`);
    expect(prompt).not.toContain("/etc/hosts");
    expect(prompt).not.toContain("/etc/passwd");
    expect(prompt).not.toContain("traversal");

    // The excluded record is logged by ID only, and kept in storage.
    expect(warn).toHaveBeenCalledWith(
      "[references] excluded a stored reference image",
      { carouselId: carousel.id, referenceId: "ref-traversal", reason: "invalid_url" }
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/etc/passwd");
    expect((await getCarousel(carousel.id))!.referenceImages.map((r) => r.id)).toEqual([
      "ref-valid", "ref-poisoned-path", "ref-traversal",
    ]);
    warn.mockRestore();
  });

  it("buildSystemPrompt is pure: it uses the paths it is given and reads no file", async () => {
    const source = await readFile(path.join(originalCwd, "src/lib/chat-system-prompt.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'](node:)?fs(\/promises)?["']/);

    const carousel = {
      id: "c1", name: "Pure", aspectRatio: "4:5", slides: [], caption: "", hashtags: [],
      referenceImages: [{ id: "r1", url: "/uploads/x.png", absPath: "/nowhere/given.png", name: "given", addedAt: "" }],
      chatSessionId: null, isTemplate: false, createdAt: "", updatedAt: "",
    } as unknown as Carousel;
    const prompt = buildSystemPrompt({ baseUrl: "http://127.0.0.1:3000", brand: DEFAULT_BRAND, carousel, stylePreset: null });
    expect(prompt).toContain(`- "given" → /nowhere/given.png`);
  });

  it("duplicating a carousel still copies its valid references", async () => {
    const carousel = await createCarousel("Refs", "4:5");
    const url = await uploadPng();
    expect((await register(carousel.id, { url, name: "keep" })).status).toBe(201);

    const copy = await duplicateCarousel(carousel.id);
    expect(copy!.referenceImages.map((r) => r.url)).toEqual([url]);
    expect(await systemPromptFor(copy!.id)).toContain(`- "keep" → ${path.join(await realpath(uploads), path.basename(url))}`);
  });
});
