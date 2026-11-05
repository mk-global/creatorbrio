// G7 driver: real pointer gestures against the spike page; records callbacks, errors, a11y and long tasks.
import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: true });
const out = {};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 700 });
  const errors = []; page.on("console", m => { if (["error", "warn"].includes(m.type())) errors.push(m.text().slice(0, 160)); }); page.on("pageerror", e => errors.push("pageerror " + e.message.slice(0, 160)));
  await page.evaluateOnNewDocument(() => { window.__long = []; new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: true }); });
  const t0 = Date.now(); await page.goto(`${process.env.SPIKE_ORIGIN ?? "http://127.0.0.1:3137"}/spike-g7`, { waitUntil: "networkidle0" }); out.loadMs = Date.now() - t0;
  await page.waitForSelector(".timeline-editor-action");
  out.actionsInDom = await page.$$eval(".timeline-editor-action", a => a.length);
  const box = async (id) => page.$eval(`[data-action="${id}"]`, el => { const r = el.closest(".timeline-editor-action").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const drag = async (x0, y0, dx, steps = 20) => { await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + (dx * i) / steps, y0); await page.mouse.up(); await new Promise(r => setTimeout(r, 150)); };
  const b1 = await box("clip1"); out.clip1Before = b1;
  await drag(b1.x + b1.w / 2, b1.y + b1.h / 2, 100);
  const rs = await page.$$eval(".timeline-editor-action-right-stretch", e => e.slice(0, 1).map(x => { const r = x.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
  if (rs[0]) await drag(rs[0].x, rs[0].y, -50);
  await page.click("#seek"); await page.click("#undo"); await page.click("#redo");
  out.log = await page.$eval("#log", e => e.textContent.split("\n").filter(Boolean));
  out.clip1After = await box("clip1");
  // keyboard reachability: how many timeline items can receive focus by Tab
  const focusable = await page.$$eval(".timeline-editor-action, .timeline-editor-action *", els => els.filter(e => e.tabIndex >= 0).length);
  out.focusableActions = focusable;
  out.roles = await page.$$eval("[role]", els => [...new Set(els.map(e => e.getAttribute("role")))]);
  // stress: 30 rapid drags of caption words
  const tStress = Date.now();
  for (let i = 0; i < 30; i++) { const w = await page.$(`[data-action="w${i}"]`); if (!w) continue; const r = await w.boundingBox(); await drag(r.x + r.width / 2, r.y + r.height / 2, 7, 5); }
  out.stressMs = Date.now() - tStress;
  out.longTasks = await page.evaluate(() => window.__long);
  out.errors = errors;
  out.reactVersion = await page.evaluate(() => document.querySelector("[data-nextjs-scroll-focus-boundary]") ? "?" : "n/a");
} finally { await browser.close(); }
console.log(JSON.stringify(out, null, 1));
