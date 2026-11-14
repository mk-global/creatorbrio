import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import type { Slide } from "@/types/carousel";
import { appBrowser, inCi } from "./helpers/app-browser";

// #196: a carousel export page makes no network request at all. A local TCP
// listener counts connections, not only HTTP requests, so a connection the
// browser opens without sending a request counts too. Every slide is
// synthetic. Runs in CI on the runner's Chrome; a missing browser fails.
const browser = appBrowser();

let server: Server;
let listener: string;
const connections: string[] = [];
const sockets = new Set<Socket>();

/** One slide per way HTML and CSS can fetch or navigate. */
function vectors(at: string): Record<string, string> {
  return {
    img: `<img src="${at}/img" width="40" height="40">`,
    srcset: `<img srcset="${at}/srcset 1x" width="40" height="40">`,
    picture: `<picture><source srcset="${at}/picture"><img width="40" height="40"></picture>`,
    cssBackground: `<div style="width:40px;height:40px;background:url(${at}/bg)"></div>`,
    imageSet: `<div style="width:40px;height:40px;background-image:image-set(url(${at}/set) 1x)"></div>`,
    cssImport: `<style>@import url(${at}/import.css);</style><p>x</p>`,
    stylesheet: `<link rel="stylesheet" href="${at}/sheet.css"><p>x</p>`,
    fontFace: `<style>@font-face{font-family:Remote;src:url(${at}/font.woff2)}</style><p style="font-family:Remote">x</p>`,
    iframe: `<iframe src="${at}/frame" width="300" height="200"></iframe>`,
    object: `<object data="${at}/object" width="100" height="100"></object>`,
    embed: `<embed src="${at}/embed" width="100" height="100">`,
    video: `<video src="${at}/video" poster="${at}/poster" width="100" height="60"></video>`,
    audio: `<audio src="${at}/audio" preload="auto"></audio>`,
    track: `<video width="100" height="60"><track src="${at}/track" default></video>`,
    inputImage: `<input type="image" src="${at}/input">`,
    icon: `<link rel="icon" href="${at}/icon">`,
    prefetch: `<link rel="prefetch" href="${at}/prefetch">`,
    preload: `<link rel="preload" as="image" href="${at}/preload">`,
    preconnect: `<link rel="preconnect" href="${at}">`,
    dnsPrefetch: `<link rel="dns-prefetch" href="${at}">`,
    manifest: `<link rel="manifest" href="${at}/manifest">`,
    modulePreload: `<link rel="modulepreload" href="${at}/module">`,
    svgImage: `<svg width="40" height="40"><image href="${at}/svg-image" width="40" height="40"/></svg>`,
    svgUse: `<svg width="40" height="40"><use href="${at}/svg-use#a"/></svg>`,
    svgFilter: `<div style="width:40px;height:40px;background:#16a085;filter:url(${at}/filter#f)"></div>`,
    cursor: `<div style="cursor:url(${at}/cursor),auto">x</div>`,
    listStyle: `<ul style="list-style-image:url(${at}/list)"><li>x</li></ul>`,
    borderImage: `<div style="border:5px solid;border-image:url(${at}/border) 30">x</div>`,
    mask: `<div style="width:40px;height:40px;mask-image:url(${at}/mask)">x</div>`,
    shapeOutside: `<div style="float:left;width:40px;height:40px;shape-outside:url(${at}/shape)">x</div>`,
    content: `<div style="content:url(${at}/content)"></div>`,
    script: `<script src="${at}/script"></script>`,
    refresh: `<meta http-equiv="refresh" content="0;url=${at}/refresh">`,
    base: `<base href="${at}/base/"><img src="relative.png" width="40" height="40">`,
    srcdocFrame: `<iframe srcdoc="<img src='${at}/srcdoc'>" width="100" height="60"></iframe>`,
  };
}

/** Slides the PDF export refuses whatever their network references, as it refuses every mask. */
const PDF_REFUSES = new Set(["mask"]);

const slide = (id: string, body: string): Slide => ({
  id,
  html: `<div style="width:100%;height:100%;background:#f7f3e9;color:#1a1a2e;font:64px Georgia,serif;padding:60px;box-sizing:border-box">${body}<p>Slide ${id}</p></div>`,
  previousVersions: [],
  order: 0,
  notes: "",
});

beforeAll(async () => {
  // Answers any request with a visible page, so a request that got through would show.
  server = createServer((socket) => {
    sockets.add(socket);
    connections.push("connect");
    socket.on("data", () => {
      connections.push("request");
      socket.end("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 38\r\n\r\n<p style='font-size:90px'>REMOTE</p>\n");
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  listener = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(!browser && !inCi)("export page network in Chromium (#196)", () => {
  let previousExecutable: string | undefined;
  let originalCwd: string;
  let work: string;

  beforeAll(async () => {
    if (!browser) throw new Error("No Chromium or Chrome found: the export network test must run in CI.");
    previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = browser;
    originalCwd = process.cwd();
    work = await mkdtemp(path.join(tmpdir(), "creatorbrio-export-network-"));
    await mkdir(path.join(work, "public", "uploads"), { recursive: true });
    await mkdir(path.join(work, "data"), { recursive: true });
    process.chdir(work);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("the listener sees these slides when nothing refuses their requests (the test can detect them)", async () => {
    const plain = await puppeteer.launch({ executablePath: browser!, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await plain.newPage();
      await page.setJavaScriptEnabled(false);
      const before = connections.length;
      const html = Object.values(vectors(listener)).filter((v) => !v.includes("refresh")).join("");
      await page.setContent(`<!DOCTYPE html><html><body>${html}</body></html>`, { waitUntil: "load", timeout: 15_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(connections.slice(before).filter((c) => c === "request").length).toBeGreaterThan(10);
    } finally {
      await plain.close();
    }
  }, 60_000);

  it("exports every way a slide can reach the network as PNG and PDF without a single connection to the listener", async () => {
    const { exportAllSlides, exportAllSlidePdfs } = await import("@/lib/export-slides");
    const slides = Object.entries(vectors(listener)).map(([id, body]) => slide(id, body));
    const before = connections.length;

    // The PDF export refuses masks by design (readers draw them without their fade), so that one
    // slide is exported as PNG only; every other vector is exported both ways.
    const printable = slides.filter((s) => !PDF_REFUSES.has(s.id));
    const pngs = await exportAllSlides(slides, "1:1");
    const pdfs = await exportAllSlidePdfs(printable, "1:1");
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(pngs).toHaveLength(slides.length);
    expect(pdfs).toHaveLength(printable.length);
    expect(connections.slice(before)).toEqual([]);
  }, 180_000);

  it("keeps a slide that tries to leave on its own content, and a slide's frame empty", async () => {
    const { exportAllSlides, exportAllSlidePdfs } = await import("@/lib/export-slides");
    const { inspectPdf } = await import("@/lib/pdf-content");
    const before = connections.length;
    const [redirecting, itself, framed, emptyFrame] = await exportAllSlides(
      [
        slide("refresh", `<meta http-equiv="refresh" content="0;url=${listener}/away">`),
        slide("refresh", ""),
        slide("frame", `<iframe src="${listener}/frame" width="300" height="200"></iframe>`),
        slide("frame", `<iframe width="300" height="200"></iframe>`),
      ],
      "4:5"
    );
    expect(Buffer.compare(redirecting.buffer, itself.buffer)).toBe(0);
    expect(Buffer.compare(framed.buffer, emptyFrame.buffer)).toBe(0);

    const [pdf] = await exportAllSlidePdfs([slide("refresh", `<meta http-equiv="refresh" content="0;url=${listener}/away">`)], "4:5");
    const text = (await inspectPdf(pdf)).map((page) => page.text).join("");
    expect(text).toMatch(/Slide\s*refresh/);
    expect(text).not.toContain("REMOTE");
    expect(connections.slice(before)).toEqual([]);
  }, 120_000);
});
