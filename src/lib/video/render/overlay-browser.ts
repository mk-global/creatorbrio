/**
 * One hardened overlay browser (#144, ADR decision 3), driven by
 * `OverlayRenderer`. The overlay document is the only thing it ever loads,
 * and the browser is treated as hostile to everything outside it:
 *
 * - Its own profile folder inside the render's scratch folder, launched with
 *   `OVERLAY_CHROME_ARGS`, the OS sandbox on (a browser whose command line
 *   disables it is refused as `browser_sandbox_disabled`), over the DevTools
 *   pipe so it exits when the server process dies, and without Puppeteer's
 *   signal handlers so it never alters the server's own.
 * - A browser-wide `Fetch` interceptor is the single choke point for every
 *   request from every context and page: it serves the document once per
 *   load at `OVERLAY_ORIGIN` + `OVERLAY_PATH` with the `EXPORT_OVERLAY_CSP`
 *   header and each bundled font at its `urlPath`, all from memory, and fails
 *   everything else, `data:` URLs included. A page-level observer also sees
 *   requests the CSP stops before they reach the interceptor.
 * - Page JavaScript is off before the document loads. Any request the
 *   document makes beyond its fonts fails the render (`overlay_request_blocked`);
 *   a document request the renderer did not make, a main-frame navigation
 *   after load, a frame or a new page fails it as `overlay_navigation`; a
 *   font that does not load fails it as `overlay_font_failed`.
 * - The page's animation timeline runs at rate 0 (DevTools
 *   `Animation.setPlaybackRate`, set before the first load and kept across
 *   reloads), so nothing plays in real time between a load and the first
 *   seek. Without it a document that sat loaded for a few seconds (as it does
 *   while the sound is mastered) drew the first frames of a moving layer
 *   differently (measured: 30 of 120 frames).
 * - A frame is seeked through `document.getAnimations()` to its centre
 *   (`overlayTimeSeconds`) and captured under the frame deadline; a frame
 *   that misses it kills the browser and fails the render as a transient
 *   `timeout`. Launching and loading have the load deadline.
 * - `kill()` SIGKILLs the browser at once; `close()` closes it cleanly when it
 *   can, kills it otherwise, and waits for the process to exit.
 */
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import puppeteer, { type Browser, type CDPSession, type HTTPRequest, type Page, type Protocol } from "puppeteer";

import { OVERLAY_CHROME_ARGS, sandboxDisablingFlags } from "./chrome";
import { RenderFailure, type FontAsset, type OverlayDocument } from "./execute-types";
import { EXPORT_OVERLAY_CSP, OVERLAY_ORIGIN, OVERLAY_PATH, overlayTimeSeconds } from "./overlay";
import { PngShapeError } from "./overlay-png";

/** How long one frame's seek and screenshot may take. */
export const DEFAULT_FRAME_DEADLINE_MS = 10_000;
/** How long launching a browser, loading the document and its fonts may take. */
export const DEFAULT_LOAD_DEADLINE_MS = 30_000;
/** DevTools calls time out this long after the frame deadline, so the renderer's own deadline normally fires first. */
const PROTOCOL_GRACE_MS = 5_000;
/** A clean close gets this long before the browser is killed. */
const CLOSE_GRACE_MS = 2_000;
/** How long to wait for a killed browser to exit. */
const EXIT_WAIT_MS = 5_000;

const DOCUMENT_URL = `${OVERLAY_ORIGIN}${OVERLAY_PATH}`;
const FONT_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,3}\.woff2$/;

export interface Served {
  resourceType: Protocol.Network.ResourceType;
  headers: Protocol.Fetch.HeaderEntry[];
  body: string;
}

type Outcome<T> = { done: true; value: T } | { done: false };

/** Waits for `work` or `ms`, whichever comes first; a late rejection of `work` is absorbed. */
async function within<T>(work: Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work.then((value): Outcome<T> => ({ done: true, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

export const interrupted = () => new RenderFailure("transient", "interrupted", "the render was cancelled");

/** Maps an error from the browser side to a typed failure; messages never carry paths or URLs. */
export function browserFailure(error: unknown): RenderFailure {
  if (error instanceof RenderFailure) return error;
  if (error instanceof PngShapeError) return new RenderFailure("permanent", "internal_error", error.message);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EIO" || code === "EMFILE" || code === "ENFILE" || code === "EBUSY") {
    return new RenderFailure("transient", "io_error", `the overlay browser could not use the disk (${code})`);
  }
  if ((error as Error | null)?.name === "TimeoutError") return new RenderFailure("transient", "timeout", "the overlay browser did not respond in time");
  return new RenderFailure("permanent", "tool_failed", "the overlay browser failed");
}

export function servedFiles(overlay: OverlayDocument, fonts: readonly FontAsset[]): Map<string, Served> {
  if (createHash("sha256").update(overlay.html).digest("hex") !== overlay.sha256) {
    throw new RenderFailure("permanent", "internal_error", "the overlay document does not match its hash");
  }
  const served = new Map<string, Served>();
  served.set(DOCUMENT_URL, {
    resourceType: "Document",
    headers: [
      { name: "content-type", value: "text/html; charset=utf-8" },
      { name: "content-security-policy", value: EXPORT_OVERLAY_CSP },
      { name: "x-content-type-options", value: "nosniff" },
      { name: "cache-control", value: "no-store" },
    ],
    body: Buffer.from(overlay.html, "utf-8").toString("base64"),
  });
  for (const font of fonts) {
    if (!FONT_PATH.test(font.urlPath) || served.has(`${OVERLAY_ORIGIN}${font.urlPath}`)) {
      throw new RenderFailure("permanent", "internal_error", "a bundled font has an invalid or repeated path");
    }
    served.set(`${OVERLAY_ORIGIN}${font.urlPath}`, {
      resourceType: "Font",
      headers: [
        { name: "content-type", value: "font/woff2" },
        { name: "x-content-type-options", value: "nosniff" },
      ],
      body: font.bytes.toString("base64"),
    });
  }
  return served;
}

export interface BrowserSettings {
  signal: AbortSignal;
  executablePath: string;
  profileDir: string;
  canvas: { width: number; height: number };
  fps: number;
  frameDeadlineMs: number;
  loadDeadlineMs: number;
  served: ReadonlyMap<string, Served>;
}

/** One isolated browser with the overlay document loaded. */
export class OverlayBrowser {
  private browser!: Browser;
  private page!: Page;
  private process!: ChildProcess;
  private exited!: Promise<void>;
  /** Set once the first load has finished; afterwards new pages are violations. */
  private ready = false;
  /** True between asking for the document and receiving it: only then may it be requested. */
  private expectingDocument = false;
  /** True while the renderer's own navigation runs, when main-frame navigations are expected. */
  private navigating = false;
  /** The document is freshly loaded and has not drawn a frame yet. */
  private fresh = false;
  private navigation: string | null = null;
  private readonly blocked = new Set<string>();
  /** Why this browser was killed, when the renderer killed it on purpose. */
  private killedFor: RenderFailure | null = null;
  version = "";

  private constructor(private readonly settings: BrowserSettings) {}

  static async launch(index: number, settings: BrowserSettings): Promise<OverlayBrowser> {
    const instance = new OverlayBrowser(settings);
    let browser: Browser;
    try {
      browser = await puppeteer.launch({
        executablePath: settings.executablePath,
        headless: true,
        pipe: true,
        args: [...OVERLAY_CHROME_ARGS],
        userDataDir: path.join(/*turbopackIgnore: true*/ settings.profileDir, `browser-${index}`),
        protocolTimeout: settings.frameDeadlineMs + PROTOCOL_GRACE_MS,
        timeout: settings.loadDeadlineMs,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
    } catch (error) {
      if ((error as Error | null)?.name === "TimeoutError") throw new RenderFailure("transient", "timeout", "the overlay browser did not start in time");
      const mapped = browserFailure(error);
      throw mapped.code === "tool_failed" ? new RenderFailure("permanent", "tool_failed", "the overlay browser could not be started") : mapped;
    }
    instance.browser = browser;
    const child = browser.process();
    if (!child || child.pid === undefined) {
      await browser.close().catch(() => undefined);
      throw new RenderFailure("permanent", "internal_error", "the overlay browser has no process to supervise");
    }
    instance.process = child;
    instance.exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    // A cancellation while the document loads kills the browser rather than waiting for the deadline.
    const onAbort = () => instance.kill(interrupted());
    settings.signal.addEventListener("abort", onAbort);
    if (settings.signal.aborted) onAbort();
    try {
      const outcome = await within(instance.setUp(), settings.loadDeadlineMs);
      if (!outcome.done) throw new RenderFailure("transient", "timeout", `the overlay document did not load within ${settings.loadDeadlineMs / 1000} s`);
    } catch (error) {
      const failure = instance.explain(error);
      instance.kill(failure);
      await instance.waitForExit();
      throw failure;
    } finally {
      settings.signal.removeEventListener("abort", onAbort);
    }
    return instance;
  }

  private async setUp(): Promise<void> {
    const { browser } = this;
    const disabled = sandboxDisablingFlags(this.process.spawnargs);
    if (disabled.length > 0) {
      throw new RenderFailure("configuration", "browser_sandbox_disabled", `the overlay browser was started with its sandbox disabled (${disabled.join(", ")})`);
    }
    this.version = await browser.version();
    browser.on("disconnected", () => {
      if (!this.killedFor) this.killedFor = new RenderFailure("permanent", "tool_failed", "the overlay browser stopped unexpectedly");
    });
    browser.on("targetcreated", (target) => {
      if (this.ready && target.type() === "page") this.navigated("the overlay document opened a new page");
    });
    const session = await browser.target().createCDPSession();
    session.on("Fetch.requestPaused", (event) => this.intercept(session, event));
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    this.page = page;
    page.on("request", (request) => this.observe(request));
    page.on("frameattached", () => this.navigated("the overlay document opened a frame"));
    page.on("framenavigated", (frame) => {
      if (!this.navigating && frame === page.mainFrame()) this.navigated("the overlay document navigated away");
    });
    await page.setJavaScriptEnabled(false);
    // Animations advance only when a capture seeks them, never with the wall clock.
    const animation = await page.createCDPSession();
    await animation.send("Animation.enable");
    await animation.send("Animation.setPlaybackRate", { playbackRate: 0 });
    await page.setViewport({ width: this.settings.canvas.width, height: this.settings.canvas.height, deviceScaleFactor: 1 });
    await this.load();
    this.ready = true;
  }

  /** Loads (or reloads) the document and its fonts, and checks the document has done nothing it may not. */
  private async load(): Promise<void> {
    this.fresh = false;
    this.expectingDocument = true;
    this.navigating = true;
    let response;
    try {
      response = await this.page.goto(DOCUMENT_URL, { waitUntil: "load", timeout: this.settings.loadDeadlineMs });
    } finally {
      this.navigating = false;
    }
    if (this.expectingDocument || !response || response.status() !== 200) throw new RenderFailure("permanent", "internal_error", "the overlay document was not served");
    this.check();
    await this.loadFonts();
    this.check();
    this.fresh = true;
  }

  /** Makes sure the next capture starts on a freshly loaded document, under the load deadline. */
  async prepare(): Promise<void> {
    if (this.fresh) return;
    let outcome: Outcome<void>;
    try {
      outcome = await within(this.load(), this.settings.loadDeadlineMs);
    } catch (error) {
      throw this.explain(error);
    }
    if (!outcome.done) {
      this.kill(new RenderFailure("transient", "timeout", `the overlay document did not reload within ${this.settings.loadDeadlineMs / 1000} s`));
      throw this.killedFor!;
    }
  }

  /** The browser-wide choke point: serve the allowlist from memory, fail and record everything else. */
  private intercept(session: CDPSession, event: Protocol.Fetch.RequestPausedEvent): void {
    const { requestId, request, resourceType } = event;
    const served = request.method === "GET" ? this.settings.served.get(request.url) : undefined;
    let allowed = served !== undefined && served.resourceType === resourceType;
    if (allowed && request.url === DOCUMENT_URL) {
      if (!this.expectingDocument) {
        this.navigated("the overlay document was requested again by itself");
        allowed = false;
      }
      this.expectingDocument = false;
    } else if (!allowed) {
      this.block(resourceType);
    }
    const reply = allowed
      ? session.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: served!.headers, body: served!.body })
      : session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    // The request can vanish (its page closed, the browser was killed) before the reply lands.
    reply.catch(() => undefined);
  }

  /** Page-level view, which also sees loads the CSP stops before they reach the interceptor. */
  private observe(request: HTTPRequest): void {
    const url = request.url();
    const served = this.settings.served.get(url);
    const type = request.resourceType();
    if (served && type === served.resourceType.toLowerCase()) return;
    this.block(type);
  }

  private block(resourceType: string): void {
    this.blocked.add(resourceType.toLowerCase().replace(/[^a-z]/g, "") || "other");
  }

  private navigated(reason: string): void {
    if (this.navigation === null) this.navigation = reason;
  }

  /** The first policy violation seen so far, navigation before requests. */
  private violation(): RenderFailure | null {
    if (this.navigation !== null) return new RenderFailure("permanent", "overlay_navigation", this.navigation);
    if (this.blocked.size > 0) {
      return new RenderFailure("permanent", "overlay_request_blocked", `the overlay document asked for resources it may not load (${[...this.blocked].sort().join(", ")})`);
    }
    return null;
  }

  /** Throws the first policy violation seen so far. */
  check(): void {
    const violation = this.violation();
    if (violation) throw violation;
  }

  private async loadFonts(): Promise<void> {
    const state = await this.page.evaluate(async () => {
      const faces = Array.from(document.fonts);
      await Promise.all(faces.map((face) => face.load().catch(() => null)));
      await document.fonts.ready;
      return { status: document.fonts.status, total: faces.length, failed: faces.filter((face) => face.status !== "loaded").length };
    });
    if (state.failed > 0 || state.status !== "loaded") {
      throw new RenderFailure("permanent", "overlay_font_failed", `${state.failed} of ${state.total} overlay fonts did not load`);
    }
  }

  /** Seeks the document to a frame and captures it, under the frame deadline. */
  async capture(frame: number): Promise<Buffer> {
    this.fresh = false;
    const ms = overlayTimeSeconds(frame, this.settings.fps) * 1000;
    const page = this.page;
    const work = (async () => {
      await page.evaluate((at: number) => {
        for (const animation of document.getAnimations()) {
          animation.pause();
          animation.currentTime = at;
        }
      }, ms);
      return page.screenshot({ type: "png", omitBackground: true });
    })();
    let outcome: Outcome<Uint8Array>;
    try {
      outcome = await within(work, this.settings.frameDeadlineMs);
    } catch (error) {
      throw this.explain(error);
    }
    if (!outcome.done) {
      this.kill(new RenderFailure("transient", "timeout", `overlay frame ${frame} was not drawn within ${this.settings.frameDeadlineMs / 1000} s`));
      throw this.killedFor!;
    }
    this.check();
    const png = outcome.value;
    return Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  }

  /**
   * The failure an error from this browser stands for: why it was killed, if
   * it was; else a policy violation, which is what makes a navigating or
   * requesting document's DevTools calls fail; else the error's own mapping.
   */
  explain(error: unknown): RenderFailure {
    if (error instanceof RenderFailure) return error;
    return this.killedFor ?? this.violation() ?? browserFailure(error);
  }

  /** SIGKILLs the browser now; its children exit with it. */
  kill(reason?: RenderFailure): void {
    if (reason && !this.killedFor) this.killedFor = reason;
    if (!this.killedFor) this.killedFor = interrupted();
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) this.process.kill("SIGKILL");
  }

  private async waitForExit(): Promise<void> {
    await within(this.exited, EXIT_WAIT_MS);
  }

  get pid(): number {
    return this.process.pid!;
  }

  /** Closes cleanly when it can, kills otherwise, and waits for the process to exit. */
  async close(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      if (!this.killedFor) this.killedFor = interrupted();
      await within(this.browser.close(), CLOSE_GRACE_MS);
      this.kill();
    }
    await this.waitForExit();
  }
}
