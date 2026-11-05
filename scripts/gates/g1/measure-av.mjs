// A/V sync for the flash-and-beep fixture: flash frames from luma in a corner no overlay covers,
// beep onsets from 1 kHz energy with the 220/330 Hz music filtered out. Reports per-flash offsets.
import { spawnSync } from "node:child_process";
const file = process.argv[2];
const run = (args) => { const r = spawnSync(process.env.FFMPEG ?? "ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 1 << 28 }); return r.stdout + r.stderr; };
const vlog = run(["-i", file, "-vf", "crop=90:50:5:45,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-an", "-f", "null", "-"]);
const ys = [...vlog.matchAll(/frame:(\d+)\s+pts:\S+\s+pts_time:([\d.]+)\s*\nlavfi\.signalstats\.YAVG=([\d.]+)/g)].map(m => ({ n: +m[1], t: +m[2], y: +m[3] }));
const flashes = ys.filter((f, i) => f.y > 200 && !(i > 0 && ys[i - 1].y > 200)).map(f => f.t);
const alog = run(["-i", file, "-vn", "-af", "highpass=f=700,highpass=f=700,highpass=f=700,silencedetect=n=-40dB:d=0.004", "-f", "null", "-"]);
const onsets = [...alog.matchAll(/silence_end: ([\d.]+)/g)].map(m => +m[1]);
// A beep that starts the file has no silence before it: silencedetect then opens with a silence_start
// shortly after 0 and no matching silence_end. Count that beep as an onset at 0.
const firstStart = alog.match(/silence_start: ([\d.]+)/);
if (firstStart && +firstStart[1] < 0.1 && !(onsets[0] < +firstStart[1])) onsets.unshift(0);
const offs = flashes.map(t => { const o = onsets.reduce((b, x) => Math.abs(x - t) < Math.abs(b - t) ? x : b, Infinity); return +(o - t).toFixed(4); });
const worst = Math.max(...offs.map(Math.abs));
console.log(JSON.stringify({ frames: ys.length, flashes: flashes.length, onsets: onsets.length, worstAbsOffsetMs: +(worst * 1000).toFixed(1),
  offsetsMs: offs.map(o => Math.round(o * 1000)), withinOneFrame: offs.filter(o => Math.abs(o) < 1 / 30).length, outliers: flashes.map((t, i) => [t, offs[i]]).filter(([, o]) => Math.abs(o) >= 1 / 30), firstOnsets: onsets.slice(0, 3), medianAbsMs: +([...offs].map(Math.abs).sort((a, b) => a - b)[offs.length >> 1] * 1000).toFixed(1), firstFlashes: flashes.slice(0, 4), lastFlash: flashes.at(-1) }));
