/**
 * Slide previews open no connection to any host but CreatorBrio itself
 * (#249), and still show an ordinary slide's uploaded images and fonts.
 *
 * Each case is the real `wrapSlideHtml()` preview document in an
 * `<iframe sandbox="" srcdoc>`, built as `SlideRenderer` builds it, in a page
 * served with the app's real page policy from `next.config.ts`. Synthetic
 * outside host names resolve, through Chromium's host resolver rules, to a
 * local TCP listener that records every connection it accepts and the server
 * name its TLS handshake carries. The listener sees what the browser's own
 * request events miss: a connection made for a load that is then refused.
 *
 * Every markup shape has a control: the same slide in the document and page
 * policy the app used before #249, reproduced below as fixed text, which the
 * listener must see. Every other host name resolves to nothing, and Google
 * Fonts is replaced by a local server, so nothing here touches the network.
 * Runs in CI on the runner's Chrome; a missing browser fails there.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer";
import sharp from "sharp";
import { APP_FONT_SOURCES, contentSecurityPolicy } from "../next.config";
import { wrapSlideHtml } from "@/lib/slide-html";
import { appBrowser, inCi } from "./helpers/app-browser";
import { fetchThrough, PROBE_FAMILY, startFakeFontSource, type FakeFontSource } from "./helpers/fake-font-source";

const browserPath = appBrowser();

/** The app's page policy before #249. */
const PAGE_POLICY_BEFORE =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; frame-src 'self' blob:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com";

/** The preview document before #249 for a 4:5 slide that names no web font. */
const documentBefore = (slideHtml: string) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1080, initial-scale=1">

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1080px; height: 1350px; overflow: hidden; }
  </style>
</head>
<body>
  ${slideHtml}
</body>
</html>`;

/** Markup shapes that each fetch, connect or navigate to `at`. */
function shapes(at: string): Record<string, string> {
  return {
    img: `<img src="${at}/img" width="40" height="40">`,
    lazyImg: `<img loading="lazy" src="${at}/lazy" width="40" height="40">`,
    srcset: `<img srcset="${at}/srcset 1x" width="40" height="40">`,
    sizes: `<img sizes="10px" srcset="${at}/sizes 10w" width="40" height="40">`,
    picture: `<picture><source srcset="${at}/picture"><img width="40" height="40"></picture>`,
    cssBackground: `<div style="width:40px;height:40px;background:url(${at}/bg)"></div>`,
    imageSet: `<div style="width:40px;height:40px;background-image:image-set(url(${at}/set) 1x)"></div>`,
    listStyle: `<ul style="list-style-image:url(${at}/list)"><li>x</li></ul>`,
    borderImage: `<div style="border:5px solid;border-image:url(${at}/border) 30">x</div>`,
    mask: `<div style="width:40px;height:40px;mask-image:url(${at}/mask)">x</div>`,
    shapeOutside: `<div style="float:left;width:40px;height:40px;shape-outside:url(${at}/shape)">x</div>`,
    content: `<div style="content:url(${at}/content)"></div>`,
    cursor: `<div style="cursor:url(${at}/cursor),auto">x</div>`,
    poster: `<video poster="${at}/poster" width="100" height="60"></video>`,
    inputImage: `<input type="image" src="${at}/input">`,
    svgImage: `<svg width="40" height="40"><image href="${at}/svg-image" width="40" height="40"/></svg>`,
    feImage: `<svg width="40" height="40"><filter id="f"><feImage href="${at}/fe-image"/></filter><rect width="40" height="40" filter="url(#f)"/></svg>`,
    noscriptImg: `<noscript><img src="${at}/noscript"></noscript>`,
    mathImg: `<math><mtext><img src="${at}/math"></mtext></math>`,
    base: `<base href="${at}/base/"><img src="relative.png" width="40" height="40">`,
    preload: `<link rel="preload" as="image" href="${at}/preload">`,
    prefetch: `<link rel="prefetch" href="${at}/prefetch">`,
    preconnect: `<link rel="preconnect" href="${at}">`,
    iframe: `<iframe src="${at}/frame" width="300" height="200"></iframe>`,
    iframeMixedCase: `<IfRaMe SRC="${at}/frame"></IfRaMe>`,
    iframeSlash: `<iframe/src="${at}/frame"></iframe>`,
    iframeInSvg: `<svg width="100" height="100"><foreignObject width="100" height="100"><iframe src="${at}/frame"></iframe></foreignObject></svg>`,
    iframeInShadowRoot: `<div><template shadowrootmode="open"><iframe src="${at}/frame"></iframe></template></div>`,
    iframeSrcdoc: `<iframe srcdoc="<img src='${at}/srcdoc'>" width="100" height="60"></iframe>`,

    // The listener sees none of these in the control, in Chromium 156 (the
    // load is refused before a connection, the parser drops the element, the
    // sandbox blocks it, or it opens no connection at all), so they are not
    // tested by this file: they run so that a browser in which one of them
    // does connect fails the product case, and are listed in UNOBSERVED.
    frame: `<frame src="${at}/frame">`,
    frameset: `<frameset><frame src="${at}/frameset"></frameset>`,
    object: `<object data="${at}/object" width="100" height="100"></object>`,
    embed: `<embed src="${at}/embed" width="100" height="100">`,
    video: `<video src="${at}/video" width="100" height="60"></video>`,
    audio: `<audio src="${at}/audio" preload="auto"></audio>`,
    track: `<video width="100" height="60"><track src="${at}/track" default></video>`,
    stylesheet: `<link rel="stylesheet" href="${at}/sheet.css"><p>x</p>`,
    cssImport: `<style>@import url(${at}/import.css);</style><p>x</p>`,
    fontFace: `<style>@font-face{font-family:Remote;src:url(${at}/font.woff2)}</style><p style="font-family:Remote">x</p>`,
    icon: `<link rel="icon" href="${at}/icon">`,
    manifest: `<link rel="manifest" href="${at}/manifest">`,
    modulePreload: `<link rel="modulepreload" href="${at}/module">`,
    prerender: `<link rel="prerender" href="${at}/prerender">`,
    dnsPrefetch: `<link rel="dns-prefetch" href="${at}">`,
    svgUse: `<svg width="40" height="40"><use href="${at}/svg-use#a"/></svg>`,
    svgFilter: `<div style="width:40px;height:40px;background:#16a085;filter:url(${at}/filter#f)"></div>`,
    script: `<script src="${at}/script"></script>`,
    refresh: `<meta http-equiv="refresh" content="0;url=${at}/refresh">`,
  };
}

const UNOBSERVED = new Set([
  "frame", "frameset", "object", "embed", "video", "audio", "track", "stylesheet", "cssImport", "fontFace",
  "icon", "manifest", "modulePreload", "prerender", "dnsPrefetch", "svgUse", "svgFilter", "script", "refresh",
]);

const OUTSIDE = "outside.test";
/** A distinct outside host per shape and case, so each connection names its slide. */
const hostFor = (shape: string, mode: Mode) => `${shape.toLowerCase()}.${mode}.${OUTSIDE}`;
type Mode = "control" | "product";

// The listener: one record per accepted connection, with the TLS server name
// or HTTP Host it received, or null when it received nothing readable.
let listener: Server;
const connections: { host: string | null }[] = [];
const sockets = new Set<Socket>();

/** The server name of a TLS ClientHello, or the Host of a plain HTTP request. */
function hostOf(bytes: Buffer): string | null {
  try {
    if (bytes[0] !== 0x16) return /\r\nhost:\s*([^\r\n:]+)/i.exec(bytes.toString("latin1"))?.[1] ?? null;
    let at = 5 + 4 + 2 + 32; // record header, handshake header, version, random
    at += 1 + bytes[at]; // session id
    at += 2 + bytes.readUInt16BE(at); // cipher suites
    at += 1 + bytes[at]; // compression methods
    const end = at + 2 + bytes.readUInt16BE(at);
    at += 2;
    while (at + 4 <= end) {
      const type = bytes.readUInt16BE(at);
      const length = bytes.readUInt16BE(at + 2);
      // server_name: list length (2), name type (1), name length (2), name.
      if (type === 0) return bytes.subarray(at + 9, at + 9 + bytes.readUInt16BE(at + 7)).toString("latin1");
      at += 4 + length;
    }
  } catch {
    // An unreadable handshake still counts as a connection.
  }
  return null;
}

// The app stand-in: case pages, and the real upload and font routes.
let app: HttpServer;
let appOrigin: string;
const appRequests: string[] = [];
const pages = new Map<string, { policy: string; srcdoc: string }>();

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** The slide frame exactly as `SlideRenderer` renders it, at half scale. */
function casePage(srcdoc: string): string {
  return `<!DOCTYPE html><html><body style="margin:0"><div style="width:540px;height:675px;overflow:hidden;position:relative"><iframe sandbox="" srcdoc="${escapeAttribute(srcdoc)}" title="Slide preview" style="width:1080px;height:1350px;border:none;transform:scale(0.5);transform-origin:top left;position:absolute;top:0;left:0;pointer-events:none"></iframe></div></body></html>`;
}

async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url!, appOrigin);
  appRequests.push(url.pathname + url.search);
  const page = pages.get(url.pathname);
  if (page) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": page.policy });
    return void res.end(casePage(page.srcdoc));
  }
  let response: Response | null = null;
  if (url.pathname === "/api/fonts/css") {
    const { GET } = await import("@/app/api/fonts/css/route");
    response = await GET(new Request(url));
  } else if (url.pathname.startsWith("/uploads/")) {
    const { GET } = await import("@/app/uploads/[...path]/route");
    const segments = url.pathname.slice("/uploads/".length).split("/");
    response = await GET(new Request(url), { params: Promise.resolve({ path: segments }) });
  }
  if (!response) {
    res.writeHead(404);
    return void res.end();
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** Serves a slide as one case and returns its address. */
function serve(name: string, slideHtml: string, mode: Mode): string {
  const pathname = `/case/${mode}/${name}`;
  pages.set(
    pathname,
    mode === "control"
      ? { policy: PAGE_POLICY_BEFORE, srcdoc: documentBefore(slideHtml) }
      : { policy: contentSecurityPolicy(APP_FONT_SOURCES), srcdoc: wrapSlideHtml(slideHtml, "4:5") }
  );
  return appOrigin + pathname;
}

/** Opens a case, lets it settle, and hands its slide frame to `inspect` before closing it. */
async function show<T>(browser: Browser, url: string, inspect?: (frame: Frame) => Promise<T>): Promise<T | undefined> {
  const page: Page = await browser.newPage();
  try {
    await page.setViewport({ width: 800, height: 900 });
    await page.goto(url, { waitUntil: "load", timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (!inspect) return undefined;
    const frame = page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
    if (!frame) throw new Error("the slide frame is missing");
    return await inspect(frame);
  } finally {
    await page.close();
  }
}

/** Shows every shape in one mode, a few at a time, and returns the hosts the listener saw. */
async function showEveryShape(browser: Browser, mode: Mode): Promise<{ hosts: (string | null)[] }> {
  const before = connections.length;
  const names = Object.keys(shapes(""));
  for (let i = 0; i < names.length; i += 8) {
    await Promise.all(
      names.slice(i, i + 8).map((name) => show(browser, serve(name, shapes(`https://${hostFor(name, mode)}`)[name], mode)))
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { hosts: connections.slice(before).map((c) => c.host) };
}

let fontSource: FakeFontSource;
let work: string;
let originalCwd: string;
let browser: Browser | null = null;
const UPLOAD = "0b5c1e7a-2f4d-4c3b-9a8e-1d2c3b4a5f60.png";

beforeAll(async () => {
  listener = createServer((socket) => {
    sockets.add(socket);
    const record: { host: string | null } = { host: null };
    connections.push(record);
    socket.once("data", (bytes) => {
      record.host = hostOf(bytes);
      socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(2_000, () => socket.destroy());
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));

  app = createHttpServer((req, res) => {
    answer(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  appOrigin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  fontSource = await startFakeFontSource();
  vi.stubGlobal("fetch", fetchThrough(fontSource.origin));
  originalCwd = process.cwd();
  work = await mkdtemp(path.join(tmpdir(), "creatorbrio-preview-network-"));
  await mkdir(path.join(work, "public", "uploads"), { recursive: true });
  await mkdir(path.join(work, "data"), { recursive: true });
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#c0392b" } }).png().toBuffer();
  await writeFile(path.join(work, "public", "uploads", UPLOAD), png);
  process.chdir(work);
});

afterAll(async () => {
  await browser?.close();
  vi.unstubAllGlobals();
  if (originalCwd) process.chdir(originalCwd);
  if (work) await rm(work, { recursive: true, force: true });
  await fontSource?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  app.closeAllConnections();
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

describe.skipIf(!browserPath && !inCi)("slide preview network in Chromium (#249)", () => {
  beforeAll(async () => {
    if (!browserPath) throw new Error("No Chromium or Chrome found: the preview network test must run in CI.");
    const port = (listener.address() as AddressInfo).port;
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", `--host-resolver-rules=MAP *.${OUTSIDE} 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    });
  });

  it("the listener sees each shape's outside host in the document and page policy used before (the controls work)", async () => {
    const { hosts } = await showEveryShape(browser!, "control");
    const missing = Object.keys(shapes("")).filter((name) => !UNOBSERVED.has(name) && !hosts.includes(hostFor(name, "control")));
    expect(missing).toEqual([]);
  }, 120_000);

  it("the slide preview opens no connection to an outside host for any shape", async () => {
    const { hosts } = await showEveryShape(browser!, "product");
    expect(hosts).toEqual([]);
  }, 120_000);

  it("shows an ordinary slide's uploaded image and its font, both from CreatorBrio", async () => {
    const before = connections.length;
    appRequests.length = 0;
    const slide = `<div style="font-family:'${PROBE_FAMILY}',serif;font-size:64px;padding:60px"><img id="upload" src="/uploads/${UPLOAD}" width="240" height="160"><p>Ordinary slide</p></div>`;
    const seen = await show(browser!, serve("ordinary", slide, "product"), (frame) =>
      frame.evaluate(async () => {
        await document.fonts.ready;
        const image = document.getElementById("upload") as HTMLImageElement;
        return {
          image: { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight },
          faces: [...document.fonts].map((face) => ({ family: face.family.replace(/["']/g, ""), style: face.style, status: face.status })),
        };
      })
    );
    expect(seen!.image).toEqual({ complete: true, width: 24, height: 16 });
    expect(seen!.faces).toContainEqual({ family: PROBE_FAMILY, style: "normal", status: "loaded" });
    expect(seen!.faces.some((face) => face.style === "italic")).toBe(false);
    expect(appRequests).toContain(`/uploads/${UPLOAD}`);
    expect(appRequests).toContain("/api/fonts/css?family=Probe%20Sans");
    expect(connections.slice(before)).toEqual([]);
  }, 60_000);

  it("gives an italic slide its italic cut", async () => {
    const slide = `<p style="font-family:'${PROBE_FAMILY}',serif;font-size:64px">Upright <em>and italic</em></p>`;
    const faces = await show(browser!, serve("italic", slide, "product"), (frame) =>
      frame.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].map((face) => ({ family: face.family.replace(/["']/g, ""), style: face.style, status: face.status }));
      })
    );
    expect(faces).toContainEqual({ family: PROBE_FAMILY, style: "normal", status: "loaded" });
    expect(faces).toContainEqual({ family: PROBE_FAMILY, style: "italic", status: "loaded" });
  }, 60_000);

  it("keeps an inert frame's box, as an export keeps an empty frame's", async () => {
    const slide = (mode: Mode) => `<iframe id="frame" src="https://${hostFor("box", mode)}/frame" width="300" height="200"></iframe><p>after</p>`;
    const box = (frame: Frame) =>
      frame.evaluate(() => {
        const rect = document.getElementById("frame")!.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
    const before = await show(browser!, serve("box", slide("control"), "control"), box);
    const after = await show(browser!, serve("box", slide("product"), "product"), box);
    expect(after).toEqual(before);
    expect(after!.width).toBeGreaterThanOrEqual(300);
  }, 60_000);
});
