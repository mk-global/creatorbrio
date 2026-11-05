// OpenFilm G1 candidate: the same fixture through openfilm's render() as a library.
// usage: node openfilm-render.mjs <openfilmRunDir> <filmDir> <outFile> <workers>
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [run, film, out, w] = process.argv.slice(2);
const { render } = await import(pathToFileURL(run + "/node_modules/openfilm/src/render.mjs").href);
let peakKb = 0;
const sampler = setInterval(() => execFile("ps", ["-axo", "pid=,ppid=,rss="], (e, so) => { if (e) return;
  const rows = so.trim().split("\n").map(l => l.trim().split(/\s+/).map(Number)); const kids = new Map();
  for (const [p, pp] of rows) (kids.get(pp) ?? kids.set(pp, []).get(pp)).push(p);
  const rss = new Map(rows.map(([p, , r]) => [p, r])); let s = 0; const st = [process.pid];
  while (st.length) { const p = st.pop(); s += rss.get(p) ?? 0; st.push(...(kids.get(p) ?? [])); } peakKb = Math.max(peakKb, s); }), 250);
const t0 = performance.now();
const r = await render([film], { out, workers: Number(w), hardware: false, onProgress: () => {} });
const secs = (performance.now() - t0) / 1000; clearInterval(sampler);
const rep = { workers: Number(w), totalSeconds: +secs.toFixed(2), peakTreeRssMB: Math.round(peakKb / 1024), result: typeof r === "object" ? Object.keys(r ?? {}) : r };
writeFileSync(out + ".report.json", JSON.stringify(rep, null, 2)); console.log(JSON.stringify(rep)); process.exit(0);
