import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

import {
  IMAGE_DIMENSIONS,
  ImageGenerationError,
  MAX_IMAGE_BYTES,
  generateImage,
  parseImageRequest,
  type GeneratedImage,
  type ImageAspectRatio,
} from "@/lib/image-service";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { DEFAULT_BRAND } from "@/types/brand";
import type { Carousel } from "@/types/carousel";

// The server-side image client runs for real against a stand-in for the
// founder's image service on a loopback port: a real HTTP exchange, real token
// file, real PNG checks and real storage under a throwaway working directory
// and home. No app route exposes it since #35; these tests call it directly,
// as the future server-side caller will: parse the request, then generate.
const TOKEN = "c0ffee".repeat(10) + "abcd";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler;
let received: { headers: IncomingMessage["headers"]; body: string }[];
let server: Server;
let workdir: string;
let originalCwd: string;
let originalHome: string | undefined;
let originalUrl: string | undefined;
let logged: unknown[][];

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 150 } } })
    .png()
    .withMetadata({ exif: { IFD0: { ImageDescription: "secret prompt text" } } })
    .toBuffer();
}

function replyPng(bytes: Buffer, contentType = "image/png"): Handler {
  return (_req, _body, res) => {
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": bytes.length });
    res.end(bytes);
  };
}

function replyError(status: number, error: string, message: string, headers: Record<string, string> = {}): Handler {
  return (_req, _body, res) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify({ error, message }));
  };
}

async function writeToken(content = TOKEN, mode = 0o600) {
  const dir = path.join(workdir, "home", ".config", "framewoven");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "image-service.token");
  await writeFile(file, content + "\n");
  await chmod(file, mode);
}

/** Parses then generates, as a server-side caller does. */
function generate(body: unknown): Promise<GeneratedImage> {
  return (async () => generateImage(parseImageRequest(body)))();
}

/** The typed refusal a call ends with; fails the test if it succeeded. */
async function refusal(body: unknown): Promise<ImageGenerationError> {
  try {
    await generate(body);
  } catch (err) {
    if (err instanceof ImageGenerationError) return err;
    throw err;
  }
  throw new Error("expected the image client to refuse");
}

const uploads = async () => readdir(path.join(workdir, "public", "uploads")).catch(() => [] as string[]);

beforeAll(async () => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  originalUrl = process.env.IMAGE_SERVICE_URL;
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-images-"));
  process.chdir(workdir);
  process.env.HOME = path.join(workdir, "home");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.IMAGE_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  if (originalUrl === undefined) delete process.env.IMAGE_SERVICE_URL;
  else process.env.IMAGE_SERVICE_URL = originalUrl;
  await rm(workdir, { recursive: true, force: true });
});

beforeEach(async () => {
  received = [];
  logged = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
  await rm(path.join(workdir, "public"), { recursive: true, force: true });
  await rm(path.join(workdir, "home"), { recursive: true, force: true });
  await writeToken();
});

afterEach(() => {
  vi.restoreAllMocks();
  // Nothing the client logs may carry the token or the prompt.
  const text = JSON.stringify(logged);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain("quiet harbour");
});

describe("image client: generateImage", () => {
  it.each(Object.entries(IMAGE_DIMENSIONS))(
    "stores a %s image at its native size and returns its upload path",
    async (aspectRatio, { width, height }) => {
      handler = replyPng(await png(width, height));
      const body = await generate({ prompt: "  quiet harbour at dawn, empty sky above  ", aspectRatio });

      expect(body).toEqual({ url: expect.stringMatching(/^\/uploads\/[0-9a-f-]{36}\.png$/), width, height });

      const saved = await readFile(path.join(workdir, "public", body.url));
      const meta = await sharp(saved).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["png", width, height]);
      expect(meta.exif).toBeUndefined();
      expect(saved.includes("secret prompt text")).toBe(false);

      // The service saw exactly one authenticated request with only the two fields.
      expect(received).toHaveLength(1);
      expect(received[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(received[0].headers.host).toBe(new URL(process.env.IMAGE_SERVICE_URL!).host);
      expect(JSON.parse(received[0].body)).toEqual({ prompt: "quiet harbour at dawn, empty sky above", aspectRatio });

      // The result names neither the token nor any filesystem path.
      const text = JSON.stringify(body);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(workdir);
    }
  );

  it("gives every image a new unpredictable name", async () => {
    handler = replyPng(await png(1024, 1024));
    const a = await generate({ prompt: "quiet harbour", aspectRatio: "1:1" });
    const b = await generate({ prompt: "quiet harbour", aspectRatio: "1:1" });
    expect(a.url).not.toBe(b.url);
    expect((await uploads()).sort()).toEqual([a.url, b.url].map((u: string) => path.basename(u)).sort());
  });

  it.each([
    ["bytes that are not a PNG", async () => replyPng(Buffer.from("<html>not an image</html>"))],
    ["a PNG of the wrong width", async () => replyPng(await png(1000, 1024))],
    ["a PNG of the wrong height", async () => replyPng(await png(1024, 1000))],
    ["a truncated PNG", async () => {
      const full = await png(1024, 1024);
      return replyPng(full.subarray(0, Math.floor(full.length / 2)));
    }],
    ["a non-PNG content type", async () => replyPng(await png(1024, 1024), "image/jpeg")],
    ["an unexpected success status", async () => (_req: IncomingMessage, _b: string, res: ServerResponse) => {
      res.writeHead(204);
      res.end();
    }],
    ["a generation failure", async () => replyError(500, "generation_failed", "backend failed")],
  ])("refuses %s and stores nothing", async (_name, make) => {
    handler = await make();
    const err = await refusal({ prompt: "quiet harbour", aspectRatio: "1:1" });
    expect(err).toMatchObject({ status: 502, code: "image_generation_failed" });
    expect(await uploads()).toEqual([]);
  });

  it.each([
    ["with a declared length", () => replyPng(Buffer.alloc(MAX_IMAGE_BYTES + 1))],
    ["with no declared length", (): Handler => (_req, _b, res) => {
      // Chunked: only the cap applied while reading can stop this one.
      res.writeHead(200, { "Content-Type": "image/png" });
      const chunk = Buffer.alloc(1024 * 1024);
      for (let i = 0; i * chunk.length <= MAX_IMAGE_BYTES; i++) res.write(chunk);
      res.end();
    }],
  ])("refuses an oversized response %s, by its size", async (_name, make) => {
    handler = make();
    const err = await refusal({ prompt: "quiet harbour", aspectRatio: "1:1" });
    expect(err).toMatchObject({ status: 502, code: "image_generation_failed", message: expect.stringContaining("oversized") });
    expect(await uploads()).toEqual([]);
  });

  it("reports a busy service with its retry hint, without retrying", async () => {
    handler = replyError(503, "busy", "Another generation is running", { "Retry-After": "15" });
    const err = await refusal({ prompt: "quiet harbour", aspectRatio: "9:16" });
    expect(err).toMatchObject({ status: 503, code: "image_service_busy", detail: { retryAfterSeconds: 15 } });
    expect(received).toHaveLength(1);
  });

  it("reports an admission refusal with its reason", async () => {
    handler = replyError(503, "admission_refused", "insufficient_free_memory", { "Retry-After": "30" });
    const err = await refusal({ prompt: "quiet harbour", aspectRatio: "4:5" });
    expect(err).toMatchObject({
      status: 503,
      code: "image_generation_refused",
      detail: { reason: "insufficient_free_memory", retryAfterSeconds: 30 },
    });
  });

  it("does not repeat free text from a refusal", async () => {
    handler = replyError(503, "admission_refused", "Something at /Users/founder/private went wrong");
    const err = await refusal({ prompt: "quiet harbour", aspectRatio: "4:5" });
    expect(err.detail.reason).toBeUndefined();
    expect(JSON.stringify({ message: err.message, ...err.detail })).not.toContain("/Users/founder");
  });

  it("reports a service timeout", async () => {
    handler = replyError(504, "generation_timeout", "timed out");
    const err = await refusal({ prompt: "quiet harbour", aspectRatio: "1:1" });
    expect(err).toMatchObject({ status: 504, code: "image_generation_timeout" });
  });

  it("reports a rejected token as missing setup, not as the token", async () => {
    handler = replyError(401, "unauthorized", "Missing or wrong token");
    const err = await refusal({ prompt: "quiet harbour", aspectRatio: "1:1" });
    expect(err).toMatchObject({ status: 503, code: "image_service_not_configured" });
  });

  it("reports an image service that is not running", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const previous = process.env.IMAGE_SERVICE_URL;
    process.env.IMAGE_SERVICE_URL = `http://127.0.0.1:${port}`;
    try {
      const err = await refusal({ prompt: "quiet harbour", aspectRatio: "1:1" });
      expect(err).toMatchObject({ status: 503, code: "image_service_unavailable" });
    } finally {
      process.env.IMAGE_SERVICE_URL = previous;
    }
  });

  it.each([
    ["is missing", async () => rm(path.join(workdir, "home"), { recursive: true, force: true })],
    ["can be read by other users", async () => writeToken(TOKEN, 0o644)],
    ["holds something other than a token", async () => writeToken("not-a-token")],
  ])("refuses to call the service when the token file %s", async (_name, setUp) => {
    await setUp();
    handler = replyPng(await png(1024, 1024));
    const err = await refusal({ prompt: "quiet harbour", aspectRatio: "1:1" });
    expect(err).toMatchObject({ status: 503, code: "image_service_not_configured" });
    expect(received).toEqual([]);
  });

  it("never sends the token to a service that is not on loopback", async () => {
    const previous = process.env.IMAGE_SERVICE_URL;
    process.env.IMAGE_SERVICE_URL = "http://images.example.test:8791";
    try {
      const err = await refusal({ prompt: "quiet harbour", aspectRatio: "1:1" });
      expect(err).toMatchObject({ status: 503, code: "image_service_not_configured" });
      expect(received).toEqual([]);
    } finally {
      process.env.IMAGE_SERVICE_URL = previous;
    }
  });

  it.each([
    ["no prompt", { aspectRatio: "1:1" }, "invalid_prompt"],
    ["a blank prompt", { prompt: "   ", aspectRatio: "1:1" }, "invalid_prompt"],
    ["an over-long prompt", { prompt: "x".repeat(2001), aspectRatio: "1:1" }, "invalid_prompt"],
    ["a control character", { prompt: "bad\u0007byte", aspectRatio: "1:1" }, "invalid_prompt"],
    ["a carriage return", { prompt: "bad\rbyte", aspectRatio: "1:1" }, "invalid_prompt"],
    ["an unsupported aspect ratio", { prompt: "quiet harbour", aspectRatio: "3:2" }, "invalid_aspect_ratio"],
  ])("refuses %s before calling the service", async (_name, body, error) => {
    handler = replyPng(await png(1024, 1024));
    const err = await refusal(body);
    expect(err).toMatchObject({ status: 400, code: error });
    expect(received).toEqual([]);
  });

  it("accepts newlines and tabs in a brief and forwards only prompt and aspectRatio", async () => {
    handler = replyPng(await png(1024, 1280));
    await generate({ prompt: "quiet harbour\n\tempty sky", aspectRatio: "4:5", seed: 7, model: "x" });
    expect(Object.keys(JSON.parse(received[0].body))).toEqual(["prompt", "aspectRatio"]);
  });
});

describe("generateImage timeout", () => {
  it("gives up on a service that never answers", async () => {
    handler = () => {}; // never responds
    await expect(
      generateImage({ prompt: "quiet harbour", aspectRatio: "1:1" as ImageAspectRatio }, { timeoutMs: 200 })
    ).rejects.toMatchObject({ status: 504, code: "image_generation_timeout" });
    expect(await uploads()).toEqual([]);
  });
});

describe("design agent instructions", () => {
  const carousel = {
    id: "carousel-abc",
    name: "Test",
    aspectRatio: "9:16",
    slides: [],
    referenceImages: [],
    chatSessionId: null,
    isTemplate: false,
    tags: [],
    createdAt: "",
    updatedAt: "",
  } as Carousel;
  const prompt = buildSystemPrompt({ baseUrl: "http://127.0.0.1:3042", brand: DEFAULT_BRAND, carousel });

  it("no longer offers image generation", () => {
    expect(prompt).not.toContain("/api/images");
    expect(prompt).not.toMatch(/generate an image/i);
    expect(prompt).not.toContain("IMAGE BRIEF");
  });

  it("keeps the existing slide workflow", () => {
    expect(prompt).toContain("http://127.0.0.1:3042/api/carousels/carousel-abc/slides");
    expect(prompt).toContain("## Slide HTML rules (CRITICAL)");
    expect(prompt).toContain("ONE SLIDE AT A TIME");
  });

  it("names neither the image service nor its token", () => {
    expect(prompt).not.toContain("8791");
    expect(prompt).not.toContain("image-service.token");
    expect(prompt).not.toContain("Bearer");
  });
});
