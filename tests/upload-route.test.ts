import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

// The upload route stores every image as an sRGB PNG without metadata. A phone
// photo is often stored sideways with an EXIF rotation tag, so the rotation has
// to be applied before the tag is stripped, or the photo is kept sideways: on
// slides, and as an edit source, where no upright person would be found.

let workdir: string;
let originalCwd: string;
let POST: (request: Request) => Promise<Response>;

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-upload-route-")));
  process.chdir(workdir);
  // The route resolves its upload folder from the working directory when it loads.
  ({ POST } = await import("@/app/api/upload/route"));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

async function upload(bytes: Buffer, name: string, type: string) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type }));
  const res = await POST(new Request("http://127.0.0.1:3000/api/upload", { method: "POST", body: form }));
  return { status: res.status, body: await res.json() };
}

describe("upload route", () => {
  it("stores a photo with an EXIF rotation upright, as a PNG without metadata", async () => {
    const half = (r: number, b: number) =>
      sharp({ create: { width: 300, height: 200, channels: 3, background: { r, g: 0, b } } }).png().toBuffer();
    const upright = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#000000" } })
      .composite([{ input: await half(255, 0), left: 0, top: 0 }, { input: await half(0, 255), left: 0, top: 200 }])
      .png()
      .toBuffer();
    const sideways = await sharp(await sharp(upright).rotate(-90).png().toBuffer()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect((await sharp(sideways).metadata()).width).toBe(400);

    const { status, body } = await upload(sideways, "portrait.jpg", "image/jpeg");
    expect(status).toBe(200);
    const stored = await readFile(path.join(workdir, "public", body.url));
    const meta = await sharp(stored).metadata();
    expect([meta.format, meta.width, meta.height, meta.orientation, meta.exif]).toEqual(["png", 300, 400, undefined, undefined]);
    const { data, info } = await sharp(stored).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    expect(at(150, 20)[0]).toBeGreaterThan(200);
    expect(at(150, 380)[2]).toBeGreaterThan(200);
  });

  it("leaves an upright photo's size and orientation as they were", async () => {
    const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    const { status, body } = await upload(photo, "landscape.jpg", "image/jpeg");
    expect(status).toBe(200);
    const meta = await sharp(await readFile(path.join(workdir, "public", body.url))).metadata();
    expect([meta.width, meta.height]).toEqual([640, 480]);
  });
});
