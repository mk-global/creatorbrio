// G1 in-house candidate renderer (gate harness, not product code).
// Overlay frames: script-free HTML rendered by Chromium with page JavaScript disabled, every request
// refused, an isolated browser per worker and pinned software-raster flags, seeked through
// document.getAnimations() from DevTools. Footage and audio: cut and mixed from the originals by FFmpeg.
//
// usage: node scripts/gates/g1/render.mjs <fixtureDir> <outDir> <workers> [fromFrame toFrame]
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import puppeteer from "puppeteer";

import { CHROME_ARGS } from "./chrome-args.mjs";

const [fx, out, workersArg, fromArg, toArg] = process.argv.slice(2);
if (!fx || !out || !workersArg) {
  console.error("usage: node render.mjs <fixtureDir> <outDir> <workers> [fromFrame toFrame]");
  process.exit(2);
}
const tl = JSON.parse(readFileSync(join(fx, "timeline.json"), "utf8"));
const workers = Number(workersArg);
const from = Number(fromArg ?? 0);
const to = Number(toArg ?? tl.durationFrames);
const html = readFileSync(join(fx, tl.overlay), "utf8");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "frames"), { recursive: true });

// Memory: RSS summed over this process and all its descendants, sampled every 250 ms.
let peakKb = 0;
const sampler = setInterval(() => execFile("ps", ["-axo", "pid=,ppid=,rss="], (error, stdout) => {
  if (error) return;
  const rows = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map();
  for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]));
  let sum = 0;
  const stack = [process.pid];
  while (stack.length) {
    const pid = stack.pop();
    sum += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  peakKb = Math.max(peakKb, sum);
}), 250);

const t0 = performance.now();
let blocked = 0;
const hashes = new Array(to - from);
const browsers = [];
async function worker(w) {
  const browser = await puppeteer.launch({ headless: true, args: CHROME_ARGS });
  browsers.push(browser);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url === "about:blank") return request.continue();
    blocked++;
    return request.abort();
  });
  await page.setViewport({ width: tl.width, height: tl.height, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  const per = Math.ceil((to - from) / workers);
  for (let f = from + w * per; f < Math.min(to, from + (w + 1) * per); f++) {
    await page.evaluate((ms) => {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = ms;
      }
    }, (f * 1000) / tl.fps);
    const png = await page.screenshot({ type: "png", omitBackground: true });
    hashes[f - from] = createHash("sha256").update(png).digest("hex");
    writeFileSync(join(out, "frames", `f${String(f).padStart(5, "0")}.png`), png);
  }
}
await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
await Promise.all(browsers.map((browser) => browser.close()));
const t1 = performance.now();

// FFmpeg: the same timeline, footage and audio from the originals, overlay composited with alpha.
const fps = tl.fps;
const startS = from / fps;
const secs = (to - from) / fps;
const total = tl.durationFrames / fps;
const inputs = [];
const graph = [];
tl.video.forEach((clip, i) => {
  inputs.push("-i", join(fx, clip.src));
  graph.push(
    `[${i}:v]trim=start=${clip.inUs / 1e6}:end=${clip.outUs / 1e6},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[v${i}]`,
    `[${i}:a]atrim=start=${clip.inUs / 1e6}:end=${clip.outUs / 1e6},asetpts=PTS-STARTPTS[a${i}]`,
  );
});
const n = tl.video.length;
const music = tl.music;
inputs.push("-i", join(fx, music.src), "-framerate", String(fps), "-start_number", String(from), "-i", join(out, "frames", "f%05d.png"));
graph.push(
  tl.video.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${n}:v=1:a=1[vc][ac]`,
  `[${n}:a]atrim=0:${total},asetpts=PTS-STARTPTS,volume=${music.gain},afade=t=in:d=${music.fadeInFrames / fps},afade=t=out:st=${total - music.fadeOutFrames / fps}:d=${music.fadeOutFrames / fps}[mu]`,
  `[ac][mu]amix=inputs=2:normalize=0,atrim=start=${startS}:end=${startS + secs},asetpts=PTS-STARTPTS[aout]`,
  `[vc]trim=start=${startS}:end=${startS + secs},setpts=PTS-STARTPTS[vt]`,
  `[${n + 1}:v]format=rgba,setpts=PTS-STARTPTS[ovl]`,
  "[vt][ovl]overlay=format=auto:eof_action=pass,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[vout]",
);
const args = [
  "-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", graph.join(";"), "-map", "[vout]", "-map", "[aout]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(fps),
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", join(out, "out.mp4"),
];
await new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
});
const t2 = performance.now();
clearInterval(sampler);
writeFileSync(join(out, "frame-hashes.txt"), hashes.join("\n") + "\n");
const report = {
  workers, from, to,
  overlaySeconds: +((t1 - t0) / 1000).toFixed(2),
  encodeSeconds: +((t2 - t1) / 1000).toFixed(2),
  totalSeconds: +((t2 - t0) / 1000).toFixed(2),
  peakTreeRssMB: Math.round(peakKb / 1024),
  blockedRequests: blocked,
};
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
