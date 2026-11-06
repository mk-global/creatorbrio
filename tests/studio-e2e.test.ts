/**
 * The Video Studio end to end, in the production build (#150): a person pairs
 * a browser, creates a production, imports synthetic footage, sound and a
 * still, places them, adds and edits a title and captions, splits, undoes,
 * redoes and reorders from the keyboard, plays the preview, restarts the
 * server and continues where they left off, exports, and downloads an MP4
 * that ffprobe reads as an Instagram Reel. The page is driven only through
 * what a person can reach (accessible names, the keyboard); what the store
 * holds is checked through the API, so a page that merely looks right
 * cannot pass.
 *
 * The preview of a paused frame is compared with the same frame of the
 * export, with a control frame that must differ, and the originals must be
 * byte-for-byte unchanged. The server runs with no Claude CLI on its PATH.
 *
 * Skipped without FFmpeg, Chromium or an up-to-date production build (run
 * `npm run build` first); CI has no FFmpeg yet (#142).
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toolPath } from "@/lib/video/media/tools";
import { FFMPEG_MISSING, makeMedia } from "./helpers/media-fixtures";
import { chromiumPath } from "./helpers/native-pdf";
import { builtAppMissing, startBuiltApp, type BuiltApp } from "./helpers/studio-app";

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const PORT = 3190;
const CHROMIUM = chromiumPath();
const MISSING = FFMPEG_MISSING ?? (CHROMIUM ? null : "Chromium is not installed") ?? builtAppMissing();

const sha256 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

describe.skipIf(MISSING)(`the Studio end to end in the built app${MISSING ? ` (skipped: ${MISSING})` : ""}`, () => {
  let app: BuiltApp;
  let browser: Browser;
  let page: Page;
  let key = "";

  /** The Production API as the local human, to check what the store holds. */
  const api = async <T = Record<string, unknown>>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${app.url}${route}`, { method, headers: { "x-creatorbrio-human-key": key, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json as T;
  };
  type Clip = { id: string; kind: string; start: number; duration: number; capability?: { id: string; params: Record<string, unknown> } };
  type View = { revision: number; generation: number; production: { name: string; timeline: { tracks: { id: string; clips: Clip[] }[] } }; history: { undo: { label: string }[] } };
  const stored = (id: string) => api<View>("GET", `/api/video/productions/${encodeURIComponent(id)}`);
  const track = (view: View, trackId: string) => view.production.timeline.tracks.find((t) => t.id === trackId)!.clips;
  const byName = (name: string) => page.waitForSelector(`::-p-aria(${name})`, { timeout: 30_000 }) as Promise<ElementHandle<Element>>;
  const clickName = async (name: string) => (await byName(name)).click();
  const pressOn = async (handle: ElementHandle<Element>, keys: string) => {
    await handle.focus();
    const parts = keys.split("+");
    for (const k of parts.slice(0, -1)) await page.keyboard.down(k as never);
    await page.keyboard.press(parts.at(-1) as never);
    for (const k of parts.slice(0, -1).reverse()) await page.keyboard.up(k as never);
  };
  /** The timeline clip whose accessible name starts with `prefix`. */
  const timelineClip = (prefix: string, nth = 0) =>
    until(`timeline clip "${prefix}"`, async () => (await page.$$(`[role="button"][aria-label^="${prefix}"]`))[nth] ?? null);
  const revisionAfter = (id: string, revision: number) => until(`revision ${revision + 1}`, async () => ((await stored(id)).revision > revision ? stored(id) : null));

  beforeAll(async () => {
    app = await startBuiltApp(PORT, { chromium: CHROMIUM! });
    // The human key is created on the first request that presents one.
    await fetch(`${app.url}/api/video/productions`, { headers: { "x-creatorbrio-human-key": "unknown" } });
    key = (await readFile(path.join(app.dataDir, "video-studio.key"), "utf8")).trim();
    browser = await puppeteer.launch({ executablePath: CHROMIUM!, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await app?.stop();
  });

  it("pairs, imports, edits, previews, survives a restart and exports a verified Reel", { timeout: 480_000 }, async () => {
    // The server cannot find a Claude CLI: its PATH holds only Node and the media tools.
    const bin = path.join(path.dirname(path.dirname(app.dataDir)), "bin");
    expect((await readdir(bin)).sort()).toEqual(["ffmpeg", "ffprobe", "node"]);

    const footage = await makeMedia(app.scratch, "video", "footage.mp4");
    const sound = await makeMedia(app.scratch, "audio", "tone.m4a");
    const still = await makeMedia(app.scratch, "image", "logo.png");
    const originals = await Promise.all([footage, sound, still].map(async (f) => ({ f, hash: await sha256(f), mode: (await stat(f)).mode })));

    // Pair with a code from the pairing command, as the page tells a person to.
    const printed = execFileSync(process.execPath, [path.join(ROOT, "scripts", "studio-pair.mjs"), "--data-dir", app.dataDir, "--no-tty-check"], { encoding: "utf8" });
    const code = /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(printed)![1];
    await page.goto(`${app.url}/studio`, { waitUntil: "networkidle0" });
    await (await byName("Pairing code")).type(code);
    await clickName('[name="Pair"][role="button"]');

    // A new production opens in the workspace.
    await (await byName("New production")).type("End to end");
    await clickName('[name="Create"][role="button"]');
    await page.waitForFunction(() => new URL(location.href).searchParams.has("production"), { timeout: 30_000 });
    const id = new URL(page.url()).searchParams.get("production")!;
    let view = await stored(id);
    expect(view.production.name).toBe("End to end");

    // Import by path; the library prepares a proxy for each.
    for (const file of [footage, sound, still]) {
      const field = await byName("Import a file");
      await field.click({ clickCount: 3 });
      await field.type(file);
      await clickName('[name="Import"][role="button"]');
      await byName(`Add ${path.basename(file)} to the timeline`);
    }
    await until("every proxy", async () => {
      const { media } = await api<{ media: { derived: { state: string } }[] }>("GET", "/api/video/media");
      return media.length === 3 && media.every((m) => m.derived.state === "succeeded");
    }, 120_000);

    // Place all three, each one change set.
    for (const file of [footage, sound, still]) {
      const before = view.revision;
      await clickName(`Add ${path.basename(file)} to the timeline`);
      view = await revisionAfter(id, before);
    }
    expect(track(view, "t-footage")).toHaveLength(1);
    expect(track(view, "t-music")).toHaveLength(1);
    expect(track(view, "t-images")).toHaveLength(1);
    const footageFrames = track(view, "t-footage")[0].duration;

    // A title, edited in the Inspector and saved with Enter.
    await clickName('[name="Go to start"][role="button"]');
    // Placing media selects it; the Inspector offers new graphics when nothing is selected.
    await (await page.$("::-p-aria(Deselect clip)"))?.click();
    let before = view.revision;
    await (await page.waitForSelector("button ::-p-text(Title card)"))!.click();
    view = await revisionAfter(id, before);
    const title = await byName("Title");
    await title.click({ clickCount: 3 });
    await title.type("Made in the Studio");
    before = view.revision;
    await page.keyboard.press("Enter");
    view = await revisionAfter(id, before);
    expect(track(view, "t-titles")[0].capability!.params.title).toBe("Made in the Studio");

    // Captions, with the first cue's text edited and saved.
    await clickName("Deselect clip");
    before = view.revision;
    await (await page.waitForSelector("button ::-p-text(Captions)"))!.click();
    view = await revisionAfter(id, before);
    const cue = await byName("Cue 1 text");
    await cue.click({ clickCount: 3 });
    await cue.type("Every word on time");
    before = view.revision;
    await clickName('[name="Save"][role="button"]');
    view = await revisionAfter(id, before);
    const cues = track(view, "t-captions")[0].capability!.params.cues as { text: string }[];
    expect(cues[0].text).toBe("Every word on time");

    // Split the footage at frame 30 from the keyboard, undo, redo, then swap the halves.
    await clickName('[name="Go to start"][role="button"]');
    const next = await byName('[name="Next frame"][role="button"]');
    for (let i = 0; i < 30; i++) await pressOn(next, "Enter");
    expect(await page.$eval("[data-studio-preview]", (el) => (el as HTMLElement).dataset.frame)).toBe("30");
    before = view.revision;
    await pressOn(await timelineClip("Video"), "s");
    view = await revisionAfter(id, before);
    expect(track(view, "t-footage").map((c) => c.duration)).toEqual([30, footageFrames - 30]);
    expect(view.history.undo.at(-1)!.label).toMatch(/split/i);

    before = view.revision;
    await page.keyboard.down("Control");
    await page.keyboard.press("z");
    await page.keyboard.up("Control");
    view = await revisionAfter(id, before);
    expect(track(view, "t-footage")).toHaveLength(1);
    before = view.revision;
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("z");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    view = await revisionAfter(id, before);
    const [firstHalf, secondHalf] = track(view, "t-footage");
    expect([firstHalf.duration, secondHalf.duration]).toEqual([30, footageFrames - 30]);

    before = view.revision;
    await pressOn(await timelineClip("Video", 0), "Alt+ArrowRight");
    view = await revisionAfter(id, before);
    const swapped = track(view, "t-footage");
    expect(swapped.find((c) => c.id === secondHalf.id)!.start).toBe(0);
    expect(swapped.find((c) => c.id === firstHalf.id)!.start).toBe(footageFrames - 30);

    // Nothing in the preview takes keyboard focus without a name.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? { tag: el.tagName, media: el.hasAttribute("data-studio-media"), name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "" } : null;
      });
      expect(focused?.media).not.toBe(true);
      expect(["VIDEO", "AUDIO", "IFRAME"]).not.toContain(focused?.tag);
    }

    // Playback: the playhead advances and the playing media follow it.
    await clickName('[name="Go to start"][role="button"]');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Space");
    await sleep(1_200);
    const playing = await page.evaluate(() => ({
      frame: Number((document.querySelector("[data-studio-preview]") as HTMLElement).dataset.frame),
      drift: [...document.querySelectorAll<HTMLElement>("[data-studio-media]")].map((el) => el.dataset.driftMs).filter((d) => d !== undefined).map(Number),
    }));
    await page.keyboard.press("Space");
    expect(playing.frame).toBeGreaterThan(20);
    expect(playing.drift.length).toBeGreaterThan(0);
    // A coarse functional bound; the one-frame criterion is measured over 60 s separately.
    for (const d of playing.drift) expect(Math.abs(d)).toBeLessThan(100);

    // A paused frame of the preview, for the export comparison: the title over the moved footage.
    const COMPARE = 15;
    await clickName('[name="Go to start"][role="button"]');
    for (let i = 0; i < COMPARE; i++) await pressOn(next, "Enter");
    await sleep(1_500);
    const canvas = await byName("Preview canvas, 1080 by 1920");
    const previewShot = Buffer.from(await canvas.screenshot({ type: "png" }));

    // Restart the server: the pairing, the production and its history survive.
    const kept = await stored(id);
    await app.restart();
    await page.reload({ waitUntil: "networkidle0" });
    await byName(`Undo ${kept.history.undo.at(-1)!.label}`);
    const afterRestart = await stored(id);
    expect(afterRestart.revision).toBe(kept.revision);
    expect(afterRestart.generation).toBe(kept.generation);
    expect(afterRestart.production).toEqual(kept.production);

    // Export, wait for the verified render, and download the MP4 from the page.
    await clickName('[name="Export"][role="button"]');
    // The panel slides in; click once it has settled where a person would see it.
    const exportButton = (await page.waitForSelector('::-p-aria([name="Export Instagram Reel"][role="button"])', { visible: true }))!;
    await sleep(500);
    await exportButton.click();
    await until("a verified render", async () => {
      // A render that ended without succeeding fails the test with its reason, not a timeout.
      const { renders } = await api<{ renders: { state: string; stage?: string; failure?: unknown }[] }>("GET", `/api/video/productions/${encodeURIComponent(id)}/renders`);
      const ended = renders.find((r) => r.state === "failed" || r.state === "cancelled");
      if (ended) throw new Error(`the render ${ended.state}: ${JSON.stringify(ended).slice(0, 1200)}`);
      return (await page.$("::-p-text(Passed the Instagram Reel checks)")) !== null;
    }, 240_000);
    const downloads = path.join(app.scratch, "downloads");
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await clickName(`Download MP4, revision ${afterRestart.revision}`);
    const mp4 = await until("the downloaded MP4", async () => {
      const names = await readdir(downloads).catch(() => [] as string[]);
      const done = names.find((n) => n.endsWith("video.mp4"));
      return done && (await stat(path.join(downloads, done))).size > 0 ? path.join(downloads, done) : null;
    }, 60_000);

    const { stdout } = await run(toolPath("ffprobe")!, ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate,sample_rate,pix_fmt:format=duration", "-of", "json", mp4]);
    const probe = JSON.parse(stdout) as { streams: Record<string, string | number>[]; format: { duration: string } };
    const video = probe.streams.find((s) => s.codec_name === "h264")!;
    const audio = probe.streams.find((s) => s.codec_name === "aac")!;
    expect(video).toMatchObject({ width: 1080, height: 1920, r_frame_rate: "30/1", pix_fmt: "yuv420p" });
    expect(audio).toMatchObject({ sample_rate: "48000" });
    const end = Math.max(...afterRestart.production.timeline.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
    expect(Number(probe.format.duration)).toBeCloseTo(end / 30, 1);

    // The preview of frame 15 matches the export's frame 15, and not a frame from elsewhere.
    const frameOf = async (n: number) => (await run(toolPath("ffmpeg")!, ["-v", "error", "-i", mp4, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { encoding: "buffer", maxBuffer: 64 << 20 })).stdout as Buffer;
    const small = (png: Buffer) => sharp(png).resize(90, 160, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const meanDiff = (a: Buffer, b: Buffer) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
    // STUDIO_E2E_ARTIFACTS names a folder to keep the compared frames in, for a person to look at.
    const keep = process.env.STUDIO_E2E_ARTIFACTS;
    if (keep) {
      await writeFile(path.join(keep, "preview-frame.png"), previewShot);
      await writeFile(path.join(keep, "export-frame.png"), await frameOf(COMPARE));
      await writeFile(path.join(keep, "export-control-frame.png"), await frameOf(end - 5));
      await page.screenshot({ path: path.join(keep, "studio-after-export.png") as `${string}.png` });
    }
    const preview = await small(previewShot);
    const same = meanDiff(preview, await small(await frameOf(COMPARE)));
    const other = meanDiff(preview, await small(await frameOf(end - 5)));
    console.info(`preview vs export: frame ${COMPARE} differs by ${same.toFixed(1)}, control frame by ${other.toFixed(1)} (of 255)`);
    expect(same).toBeLessThan(12);
    expect(other).toBeGreaterThan(same * 2);

    // The originals were never changed.
    for (const o of originals) {
      expect(await sha256(o.f)).toBe(o.hash);
      expect((await stat(o.f)).mode).toBe(o.mode);
    }
  });
});
