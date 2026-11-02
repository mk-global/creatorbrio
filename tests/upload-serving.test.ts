import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET } from "@/app/uploads/[...path]/route";
import { MAX_SERVED_UPLOAD_BYTES } from "@/lib/upload-files";

// A production server serves only files that were in public/ at build time,
// so an image uploaded or generated later showed as broken in the preview.
// This route serves those files, and nothing else.

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let workdir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-uploads-")));
  await mkdir(path.join(workdir, "public", "uploads", "fonts"), { recursive: true });
  await mkdir(path.join(workdir, "data", "asset-staging", "run"), { recursive: true });
  process.chdir(workdir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

const uploads = (...p: string[]) => path.join(workdir, "public", "uploads", ...p);
const get = (...segments: string[]) =>
  GET(new Request(`http://127.0.0.1:3000/uploads/${segments.join("/")}`), { params: Promise.resolve({ path: segments }) });

describe("serving uploads written while the app runs", () => {
  it("serves an image written after start, with its type and nosniff", async () => {
    const name = `${randomUUID()}.png`;
    await writeFile(uploads(name), PNG);
    const res = await get(name);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it.each([
    ["woff2", "font/woff2"],
    ["ttf", "font/ttf"],
  ])("serves an uploaded .%s font from the fonts folder", async (ext, type) => {
    const name = `${randomUUID()}.${ext}`;
    await writeFile(uploads("fonts", name), "font");
    const res = await get("fonts", name);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
  });

  it.each([
    ["a traversal", ["..", "..", "package.json"]],
    ["an encoded traversal", ["..%2F..%2Fpackage.json"]],
    ["a name the app never writes", ["photo.png"]],
    ["another extension", [`${randomUUID()}.svg`]],
    ["a font at the top level", [`${randomUUID()}.woff2`]],
    ["an image in the fonts folder", ["fonts", `${randomUUID()}.png`]],
    ["another folder", ["staging", `${randomUUID()}.png`]],
    ["a deeper path", ["fonts", "x", `${randomUUID()}.ttf`]],
    ["a missing file", [`${randomUUID()}.png`]],
  ])("refuses %s", async (_name, segments) => {
    await writeFile(path.join(workdir, "package.json"), "{}");
    expect((await get(...segments)).status).toBe(404);
  });

  it("refuses a link planted under an upload's name, even to a real image", async () => {
    const outside = path.join(workdir, "data", "asset-staging", "run", "a1.png");
    await writeFile(outside, PNG);
    const name = `${randomUUID()}.png`;
    await symlink(outside, uploads(name));
    expect((await get(name)).status).toBe(404);
  });

  it("refuses a fonts folder replaced by a link", async () => {
    await rm(uploads("fonts"), { recursive: true });
    await mkdir(path.join(workdir, "elsewhere"));
    const name = `${randomUUID()}.ttf`;
    await writeFile(path.join(workdir, "elsewhere", name), "font");
    await symlink(path.join(workdir, "elsewhere"), uploads("fonts"));
    expect((await get("fonts", name)).status).toBe(404);
  });

  it("refuses a directory under an upload's name, and an oversized file", async () => {
    const dir = `${randomUUID()}.png`;
    await mkdir(uploads(dir));
    expect((await get(dir)).status).toBe(404);
    const big = `${randomUUID()}.png`;
    await writeFile(uploads(big), "");
    await truncate(uploads(big), MAX_SERVED_UPLOAD_BYTES + 1);
    expect((await get(big)).status).toBe(404);
  });
});
