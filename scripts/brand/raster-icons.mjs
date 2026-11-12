// CreatorBrio Brand Identity v1.0 (#189): rasterise the browser and device
// icons from the SVG sources in docs/brand/assets, with the Chromium Puppeteer
// already uses for exports, so the PNGs match how browsers draw the SVGs.
// Writes src/app/favicon.ico (16, 32, 48), src/app/icon.svg,
// src/app/apple-icon.png (180) and docs/brand/assets/creatorbrio-app-icon-512.png.
// A maintainer's tool, not part of the build. It needs Puppeteer's downloaded
// Chromium (absent after `npm ci --ignore-scripts`; `npx puppeteer browsers
// install chrome` fetches it) and ImageMagick 7's `magick` to pack the ICO file.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const assets = path.join(root, "docs/brand/assets");
const work = mkdtempSync(path.join(tmpdir(), "creatorbrio-icons-"));
const jobs = [
  ["creatorbrio-favicon.svg", 16, path.join(work, "f16.png")],
  ["creatorbrio-favicon.svg", 32, path.join(work, "f32.png")],
  ["creatorbrio-favicon.svg", 48, path.join(work, "f48.png")],
  ["creatorbrio-app-icon.svg", 180, path.join(root, "src/app/apple-icon.png")],
  ["creatorbrio-app-icon.svg", 512, path.join(assets, "creatorbrio-app-icon-512.png")],
];

try {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const [svg, size, out] of jobs) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      const data = `data:image/svg+xml;base64,${readFileSync(path.join(assets, svg)).toString("base64")}`;
      await page.setContent(`<body style="margin:0;background:transparent"><img src="${data}" width="${size}" height="${size}" style="display:block"></body>`);
      await page.waitForFunction(() => document.images[0].complete);
      await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    }
  } finally {
    await browser.close();
  }
  execFileSync("magick", [16, 32, 48].map((s) => path.join(work, `f${s}.png`)).concat(path.join(root, "src/app/favicon.ico")));
  copyFileSync(path.join(assets, "creatorbrio-favicon.svg"), path.join(root, "src/app/icon.svg"));
  console.log("icons written");
} finally {
  rmSync(work, { recursive: true, force: true });
}
