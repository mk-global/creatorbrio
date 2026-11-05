// Writes the script-free G1 overlay: captions with per-word highlight, a self-drawing SVG diagram,
// a waving stick figure, an animated circular mask reveal and a lower third, all CSS animations
// on one 60 s timeline. Nothing in the document runs script; a renderer seeks document.getAnimations().
import { writeFileSync } from "node:fs";
const out = process.argv[2];
const words = "Footage cuts land on the frame while every caption word lights up on time and the diagram draws itself".split(" ");
const phrases = [];
for (let i = 0; i < 12; i++) phrases.push(words.slice((i * 4) % words.length, ((i * 4) % words.length) + 4));
// Visibility window: visible only inside [start, end). Every delay is relative to --t, so a script-free
// preview can show any instant by setting --t and pausing, while export seeks document.getAnimations().
const win = (start, end) => `animation: show ${end - start}s linear calc(${start}s - var(--t, 0s)) none;`;
let css = `
@keyframes show { from { visibility: visible } to { visibility: visible } }
@keyframes pop { 0% { transform: scale(.6); opacity: 0 } 60% { transform: scale(1.08); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
@keyframes lit { from { color: #fff } to { color: #ffd23f } }
@keyframes draw { from { stroke-dashoffset: 1000 } to { stroke-dashoffset: 0 } }
@keyframes wave { 0%,100% { transform: rotate(-30deg) } 50% { transform: rotate(40deg) } }
@keyframes iris { from { clip-path: circle(0% at 50% 50%) } to { clip-path: circle(60% at 50% 50%) } }
@keyframes slide { from { transform: translateX(-110%) } to { transform: translateX(0) } }
html, body { margin: 0; width: 1080px; height: 1920px; background: transparent; overflow: hidden; font-family: Arial, Helvetica, sans-serif }
.clip { position: absolute; visibility: hidden }
.cap { left: 60px; right: 60px; bottom: 360px; text-align: center; font: 800 78px/1.15 Arial, sans-serif; color: #fff;
       text-shadow: 0 4px 0 #000, 0 0 18px rgba(0,0,0,.6) }
.cap span { display: inline-block; margin: 0 10px }
.diagram { left: 140px; top: 520px; width: 800px; height: 600px }
.diagram rect, .diagram path { fill: none; stroke: #fff; stroke-width: 10; stroke-dasharray: 1000 }
.stick { right: 80px; top: 260px; width: 240px; height: 360px }
.stick line, .stick circle { stroke: #fff; stroke-width: 12; fill: none; stroke-linecap: round }
.arm { transform-origin: 120px 150px; animation: wave 1.2s ease-in-out calc(0s - var(--t, 0s)) infinite }
.mask { left: 0; top: 0; width: 1080px; height: 1920px; background: linear-gradient(135deg, rgba(255,40,120,.55), rgba(40,120,255,.55)) }
.lower { left: 0; top: 1500px; height: 140px; width: 760px; background: #111c; color: #fff; font: 700 56px/140px Arial, sans-serif; padding-left: 60px }
`;
let html = "";
phrases.forEach((p, i) => {
  const s = i * 5, e = s + 5;
  css += `.p${i} { ${win(s, e)} }\n`;
  html += `<div class="clip cap p${i}">` + p.map((w, j) => {
    const d = s + 0.25 + j * 0.9;
    return `<span style="animation: pop .35s cubic-bezier(.2,1.4,.4,1) calc(${s + j * 0.12}s - var(--t, 0s)) both, lit .2s linear calc(${d}s - var(--t, 0s)) both">${w}</span>`;
  }).join("") + `</div>\n`;
});
// Diagram 20-40 s, drawn stroke by stroke.
css += `.diagram { ${win(20, 40)} }\n`;
html += `<svg class="clip diagram" viewBox="0 0 800 600">
<rect x="20" y="40" width="300" height="180" rx="24" style="animation: draw 1.5s ease-out calc(20.5s - var(--t, 0s)) both"/>
<rect x="480" y="40" width="300" height="180" rx="24" style="animation: draw 1.5s ease-out calc(22s - var(--t, 0s)) both"/>
<path d="M320 130 L480 130" style="animation: draw 1s linear calc(23.5s - var(--t, 0s)) both"/>
<rect x="250" y="380" width="300" height="180" rx="24" style="animation: draw 1.5s ease-out calc(25s - var(--t, 0s)) both"/>
<path d="M630 220 L630 300 L400 300 L400 380" style="animation: draw 1.2s linear calc(26.5s - var(--t, 0s)) both"/>
</svg>\n`;
// Stick figure 0-60 s.
css += `.stick { ${win(0, 60)} }\n`;
html += `<svg class="clip stick" viewBox="0 0 240 360"><circle cx="120" cy="60" r="40"/><line x1="120" y1="100" x2="120" y2="230"/>
<line x1="120" y1="150" x2="40" y2="200"/><line class="arm" x1="120" y1="150" x2="200" y2="90"/>
<line x1="120" y1="230" x2="60" y2="340"/><line x1="120" y1="230" x2="180" y2="340"/></svg>\n`;
// Mask reveal 40-50 s (keeps the top-left 160 px corner clear for flash detection via its own clip-path).
css += `.mask { ${win(40, 50)}; clip-path: circle(0%); }\n.mask { animation: show 10s linear calc(40s - var(--t, 0s)) none, iris 3s ease-in-out calc(40.5s - var(--t, 0s)) both }\n`;
html += `<div class="clip mask"></div>\n`;
// Lower third 50-60 s.
css += `.lower { animation: show 10s linear calc(50s - var(--t, 0s)) none, slide .6s cubic-bezier(.2,.8,.2,1) calc(50.2s - var(--t, 0s)) both }\n`;
html += `<div class="clip lower">CreatorBrio G1 fixture</div>\n`;
writeFileSync(out, `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>${css}</style></head><body>${html}</body></html>\n`);
console.log("wrote", out);
