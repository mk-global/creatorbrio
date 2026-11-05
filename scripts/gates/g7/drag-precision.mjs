import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: true });
try {
  for (const q of ["", "?snap"]) for (const steps of [1, 5, 20, 60]) {
    const page = await browser.newPage(); await page.setViewport({ width: 1300, height: 700 });
    await page.goto(`${process.env.SPIKE_ORIGIN ?? "http://127.0.0.1:3137"}/spike-g7` + q, { waitUntil: "networkidle0" }); await page.waitForSelector('[data-action="clip1"]');
    const r = await page.$eval('[data-action="clip1"]', el => { const b = el.closest(".timeline-editor-action").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await page.mouse.move(r.x, r.y); await page.mouse.down(); for (let i = 1; i <= steps; i++) await page.mouse.move(r.x + (60 * i) / steps, r.y); await page.mouse.up();
    await new Promise(res => setTimeout(res, 200));
    const log = await page.$eval("#log", e => e.textContent.trim());
    console.log(`snap=${!!q} steps=${steps} drag=60px expected=+3.000s -> ${log || "(no commit)"}`); await page.close();
  }
} finally { await browser.close(); }
