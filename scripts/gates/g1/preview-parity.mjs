// Preview vs export parity for the script-free overlay: export = DevTools seek with page JS off;
// preview = same document in a sandbox="" srcdoc iframe, time set by --t with animations paused.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import puppeteer from "puppeteer";
import { CHROME_ARGS as args } from "./chrome-args.mjs";
// usage: OUT=<dir> node preview-parity.mjs <overlay.html>
const [docPath] = process.argv.slice(2);
const doc = readFileSync(docPath, "utf8");
const browser = await puppeteer.launch({ headless: true, args });
const hash = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const deny = async (page) => { await page.setRequestInterception(true); let n = 0; page.on("request", r => (r.url().startsWith("data:") || r.url() === "about:blank" || r.url() === "about:srcdoc") ? r.continue() : (n++, r.abort())); return () => n; };
try {
  const ex = await (await browser.createBrowserContext()).newPage();
  await ex.setJavaScriptEnabled(false); const exBlocked = await deny(ex);
  await ex.setViewport({ width: 1080, height: 1920 }); await ex.setContent(doc, { waitUntil: "load" });
  const pv = await (await browser.createBrowserContext()).newPage(); const pvBlocked = await deny(pv);
  await pv.setViewport({ width: 1080, height: 1920 });
  await pv.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><iframe id="f" sandbox="" style="border:0;width:1080px;height:1920px;display:block;background:transparent" allowtransparency="true"></iframe></body></html>`);
  const lat = [];
  for (const t of [3.2, 21.7, 26.9, 41.5, 50.4, 59.9]) {
    await ex.evaluate(ms => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } }, t * 1000);
    const e = await ex.screenshot({ type: "png", omitBackground: true, path: `${process.env.OUT}/e-${t}.png` });
    const seeked = doc.replace("<style>", `<style>:root{--t:${t}s} *,*::before,*::after{animation-play-state:paused !important}`);
    const ms = await pv.evaluate(async (html) => { const f = document.getElementById("f"); const t0 = performance.now();
      await new Promise(r => { f.onload = r; f.srcdoc = html; }); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t0; }, seeked);
    lat.push(+ms.toFixed(1));
    const p = await pv.screenshot({ type: "png", omitBackground: true, path: `${process.env.OUT}/p-${t}.png` });
    const scriptRan = await pv.evaluate(() => { try { return !!document.getElementById("f").contentDocument; } catch { return "opaque"; } });
    console.log(JSON.stringify({ t, export: hash(e), preview: hash(p), identical: hash(e) === hash(p), rebuildMs: +ms.toFixed(1), iframeAccess: scriptRan }));
  }
  console.log(JSON.stringify({ blocked: { export: exBlocked(), preview: pvBlocked() }, medianRebuildMs: lat.sort((a, b) => a - b)[lat.length >> 1] }));
} finally { await browser.close(); }
