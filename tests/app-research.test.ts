import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer";
import { startBuiltApp, type BuiltApp } from "./helpers/studio-app";
import { appBrowser, appBrowserTestMissing, inCi } from "./helpers/app-browser";
import type { CarouselResearch } from "@/types/research";

// The research screen (#253), end to end in a real browser against the
// production build. No Brave Search key is set and Claude is a stub that
// refuses every call, so nothing leaves the machine. Research therefore tries
// Claude's web search (#256), which the stub refuses: one real run has a topic
// alone and ends as web search unavailable, with what to do; another has one
// link that is refused when it is read (`localhost` is not on the public
// web), so it ends in the server's own failure before any paid call. The
// others seed research into the data folder in the shape a finished run
// stores. The one design request the journey makes is recorded and refused
// by the stub.

const PORT = 3192;
/** The one button that confirms the direction; Enter in a field never does. */
const CONFIRM = 'form[aria-labelledby="direction"] button.btn-create';
const MISSING = appBrowserTestMissing();
const SKIP = MISSING !== null && !inCi;

const DIRECTION = {
  angle: "Three small morning habits that make evenings calmer.",
  audience: "Busy professionals who sleep badly.",
  centralMessage: "Small changes early in the day make sleep easier later.",
  keyPoints: ["Get outside within an hour of waking", "Move the last coffee earlier"],
  callToAction: "Save this for tomorrow morning.",
};

/** The snapshot the server stores when the person confirms a ready run. */
function confirmedFrom(research: CarouselResearch, confirmedAt = "2026-11-23T10:02:00.000Z") {
  return {
    revision: research.revision,
    confirmedAt,
    topic: research.topic,
    direction: DIRECTION,
    edited: false,
    sources: research.result!.sources,
    findings: research.result!.findings,
  };
}

function readyResearch(revision: number): CarouselResearch {
  const source = (id: string, host: string, title: string, origin: "link" | "search") => ({
    id,
    kind: "url" as const,
    url: `https://${host}/article`,
    host,
    title,
    retrievedAt: "2026-11-23T10:00:00.000Z",
    blob: "0".repeat(64),
    reliability: "unverified" as const,
    retrievedBy: "source-retrieval" as const,
    origin,
  });
  return {
    revision,
    topic: "calmer evenings",
    links: ["https://notes.example/article"],
    state: "ready",
    searchProvider: "brave",
    startedAt: "2026-11-23T10:00:00.000Z",
    finishedAt: "2026-11-23T10:01:30.000Z",
    result: {
      sources: [source("S1", "notes.example", "My sleep notes", "link"), source("S2", "sleep.example", "Morning light and the body clock", "search")],
      findings: [
        {
          id: "F1",
          text: "Morning light within an hour of waking helps set the body clock.",
          check: "quoted",
          evidence: [{ sourceId: "S2", quote: "Morning light exposure within an hour of waking helps set the body clock" }],
          sensitive: true,
        },
        { id: "F2", text: "Cold showers double productivity.", check: "unchecked", evidence: [], sensitive: false },
      ],
      gaps: ["No source says how much light is enough."],
      direction: DIRECTION,
      unreadable: [{ host: "", origin: "search", reason: "http_status" }],
      // Brave was tried first and limited requests, so Claude's web search found the pages (#256).
      searchMethod: "claude",
      searchFailure: "search_rate_limited",
    },
    usage: { costUsd: 0.05, durationMs: 90_000, searchRequests: 2, pagesRead: 2 },
  };
}

describe.skipIf(SKIP)("research in a browser", () => {
  let app: BuiltApp;
  let browser: Browser;
  const chatBodies: string[] = [];
  const consoleErrors: string[] = [];

  async function api<T>(p: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${app.url}${p}`, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async function openPage(width = 1440, height = 900, { expectFailedRequests = false } = {}): Promise<Page> {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/chat") chatBodies.push(r.postData() ?? "");
    });
    page.on("console", (m) => {
      if (m.type() !== "error" || /about:srcdoc|sandboxed/i.test(m.text())) return;
      if (expectFailedRequests && /Failed to load resource/.test(m.text())) return;
      consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    return page;
  }

  async function seed(id: string, research: CarouselResearch): Promise<void> {
    const file = path.join(app.dataDir, "carousels.json");
    const data = JSON.parse(await readFile(file, "utf8")) as { carousels: { id: string; research?: CarouselResearch }[] };
    data.carousels.find((c) => c.id === id)!.research = research;
    await writeFile(file, JSON.stringify(data, null, 2));
  }

  const project = async (name: string) =>
    (await api<{ id: string }>(`/api/carousels`, { method: "POST", body: JSON.stringify({ name, aspectRatio: "4:5" }) })).body.id;

  /**
   * Holds the requests `match` selects while `hold()` is on, and lets them go on `release()`. A run that ends in
   * milliseconds is then still on screen mid-run for the test to read, and a request can be in flight while the
   * person does something else. The server is never held, only the browser's side of the exchange.
   */
  async function holdRequests(page: Page, match: (r: HTTPRequest) => boolean) {
    const held: HTTPRequest[] = [];
    let on = false;
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.isInterceptResolutionHandled()) return;
      if (on && match(r)) held.push(r);
      else void r.continue().catch(() => undefined);
    });
    return {
      hold: () => {
        on = true;
      },
      release: () => {
        on = false;
        for (const r of held.splice(0)) void r.continue().catch(() => undefined);
      },
    };
  }

  const stored = async (id: string) => (await api<{ research: CarouselResearch | null }>(`/api/carousels/${id}/research`)).body.research;
  const text = (page: Page) => page.evaluate(() => document.body.innerText);
  const until = (page: Page, words: string) =>
    page.waitForFunction((w) => document.body.innerText.includes(w), { timeout: 15_000 }, words);

  beforeAll(async () => {
    if (MISSING) throw new Error(`The research browser test cannot run in CI: ${MISSING}`);
    const chromium = appBrowser()!;
    app = await startBuiltApp(PORT, { chromium, claudeStub: true });
    browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
    expect((await api(`/api/brands/default`, { method: "PUT", body: JSON.stringify({ name: "Northlight", colors: { primary: "#12355b", secondary: "#2f6690", accent: "#ff7f50", background: "#ffffff", surface: "#e8f1f8" }, fonts: { heading: "Inter", body: "Inter" }, styleKeywords: [] }) })).status).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.stop();
  });

  it("starts research from New project, and says why a link cannot be read without sending anything", async () => {
    const page = await openPage(1440, 900, { expectFailedRequests: true });
    await page.goto(`${app.url}/create`, { waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll("label")].find((l) => l.textContent?.includes("Research a topic"))!.click());
    // Without a Brave key, research searches with Claude's web search, so links are optional (#256).
    await until(page, "Claude's web search");
    const create = () => page.$eval("button[type=submit].btn-create", (b) => ({ text: b.textContent, disabled: (b as HTMLButtonElement).disabled }));
    expect(await text(page)).toContain("Optional, up to 3");
    expect(await text(page)).not.toContain("Brave");
    await page.type("#create-research-topic", "calmer evenings");
    expect(await create()).toEqual({ text: "Create and research", disabled: false });
    expect(await text(page)).not.toContain("Add at least one link");
    await page.type("#create-research-links", "http://127.0.0.1/private");
    expect((await create()).disabled).toBe(false);
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button[type=submit].btn-create")]);

    expect(new URL(page.url()).pathname).toMatch(/^\/carousel\/[^/]+\/research$/);
    await until(page, "Research didn't start:");
    expect(await text(page)).toContain("This link cannot be read: http://127.0.0.1/private");
    // Only a refusal that Settings fixes links there.
    expect(await page.$$eval('form p[role="alert"] a', (as) => as.length)).toBe(0);
    // The form keeps what was typed, so the person can correct it.
    expect(await page.$eval("#research-topic", (t) => (t as HTMLTextAreaElement).value)).toBe("calmer evenings");
    expect(await page.$eval("#research-links", (t) => (t as HTMLTextAreaElement).value)).toBe("http://127.0.0.1/private");
    const id = new URL(page.url()).pathname.split("/")[2];
    expect(await stored(id)).toBeNull();
    expect(chatBodies).toEqual([]);
    await page.close();
  }, 60_000);

  it("reports research a stopped server left behind, and keeps an earlier confirmed direction", async () => {
    const created = await api<{ id: string }>(`/api/carousels`, { method: "POST", body: JSON.stringify({ name: "Interrupted", aspectRatio: "4:5" }) });
    const ready = readyResearch(1);
    const confirmed = { revision: 1, confirmedAt: "2026-11-23T10:02:00.000Z", topic: ready.topic, direction: DIRECTION, edited: false, sources: ready.result!.sources, findings: ready.result!.findings };
    await seed(created.body.id, { ...readyResearch(2), state: "running", stage: "reading", result: undefined, finishedAt: undefined, confirmed });

    const page = await openPage();
    await page.goto(`${app.url}/carousel/${created.body.id}/research`, { waitUntil: "networkidle0" });
    await until(page, "Research didn't finish");
    const body = await text(page);
    expect(body).toContain("Research stopped because CreatorBrio was restarted.");
    // The direction the slides were built from stays in view.
    expect(body).toContain(`Direction in use, confirmed`);
    expect(body).toContain(DIRECTION.angle);
    expect(await page.$$eval("button", (bs) => bs.map((b) => b.textContent?.trim()))).toContain("Try again");
    expect(await stored(created.body.id)).toMatchObject({ state: "failed", failure: { code: "interrupted" }, confirmed: { revision: 1 } });
    await page.close();
  }, 60_000);

  it("runs a real research start with no key, shows its progress, ends in the server's failure and recovers", async () => {
    const id = await project("Offline research");
    const chatBefore = chatBodies.length;
    const page = await openPage();
    const polls = await holdRequests(page, (r) => r.method() === "GET" && new URL(r.url()).pathname === `/api/carousels/${id}/research`);
    await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#research-topic");
    // No Brave key, so Claude's web search is tried and the stub refuses it; the run goes on with the link, and
    // `localhost` passes the start check but is refused when its page is read: no network and nothing paid.
    await page.click("#research-topic", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type("#research-topic", "calmer evenings");
    await page.type("#research-links", "https://localhost/research-link");
    polls.hold();
    await page.click("form button[type=submit].btn-primary");

    // Progress: the steps this run has and Stop. The run's progress reads are held, so the view cannot be missed.
    await page.waitForSelector("#progress");
    const progress = await text(page);
    expect(progress).toContain("Searching the web");
    expect(progress).toContain("Reading the pages");
    expect(progress).toContain("Finding what the pages say");
    expect(await page.$$eval("button", (bs) => bs.map((b) => b.textContent?.trim()))).toContain("Stop");
    // The live region is the steps that change, not the sentence that stays.
    expect(await page.$('section[aria-labelledby="progress"] ol[aria-live="polite"]')).not.toBeNull();
    expect(await page.$('section[aria-labelledby="progress"] p[aria-live]')).toBeNull();
    // Each step is announced whole, its name with its state, and not the state alone.
    expect(await page.$$eval('section[aria-labelledby="progress"] ol[aria-live="polite"] > li', (steps) => steps.map((li) => li.getAttribute("aria-atomic")))).toEqual(["true", "true", "true"]);

    // The failure: the server's own message, a recovery that is offered, and no result or model cost behind it.
    polls.release();
    await until(page, "Research didn't finish");
    expect(await text(page)).toContain("None of the pages could be read, so there is nothing to research from.");
    expect(await page.$$eval("button", (bs) => bs.map((b) => b.textContent?.trim()))).toContain("Try again");
    const failed = await stored(id);
    expect(failed).toMatchObject({
      revision: 1,
      state: "failed",
      searchProvider: "claude",
      failure: { code: "no_readable_pages" },
      usage: { costUsd: null, searchRequests: 1, pagesRead: 0 },
    });
    expect(failed?.result).toBeUndefined();

    // Recovery: Try again starts the next revision of the same research, which ends the same way, with the form still holding the words.
    polls.hold();
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Try again")!.click());
    await page.waitForSelector("#progress");
    polls.release();
    await page.waitForFunction(() => !document.querySelector("#progress") && document.body.innerText.includes("Research didn't finish"), { timeout: 15_000 });
    expect(await stored(id)).toMatchObject({ revision: 2, state: "failed", failure: { code: "no_readable_pages" }, links: ["https://localhost/research-link"] });
    expect(await page.$eval("#research-topic", (t) => (t as HTMLTextAreaElement).value)).toBe("calmer evenings");
    expect(await page.$eval("#research-links", (t) => (t as HTMLTextAreaElement).value)).toBe("https://localhost/research-link");
    // No design request, and so no paid call, at any point.
    expect(chatBodies).toHaveLength(chatBefore);
    await page.close();
  }, 90_000);

  it("researches a topic alone without a Brave key, and says what to do when Claude's web search is unavailable", async () => {
    const id = await project("Topic only");
    const chatBefore = chatBodies.length;
    const page = await openPage();
    const polls = await holdRequests(page, (r) => r.method() === "GET" && new URL(r.url()).pathname === `/api/carousels/${id}/research`);
    await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#research-topic");
    await page.click("#research-topic", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type("#research-topic", "calmer evenings");
    expect(await page.$eval("#research-links", (t) => (t as HTMLTextAreaElement).value)).toBe("");
    polls.hold();
    await page.click("form button[type=submit].btn-primary");
    await page.waitForSelector("#progress");
    expect(await text(page)).toContain("Searching the web");
    polls.release();

    // The stub stands in for a connection without web search: the run says so, and offers every way on.
    await until(page, "Research didn't finish");
    const body = await text(page);
    expect(body).toContain("Claude's web search isn't available through your Claude Code connection");
    expect(await page.$$eval("button", (bs) => bs.map((b) => b.textContent?.trim()))).toContain("Try again");
    expect(await page.$$eval("a", (as) => as.map((a) => a.getAttribute("href")))).toContain("/settings#research");
    const failed = await stored(id);
    expect(failed).toMatchObject({
      revision: 1,
      state: "failed",
      searchProvider: "claude",
      failure: { code: "web_search_unavailable" },
      usage: { costUsd: null, searchRequests: 1, pagesRead: 0 },
    });
    expect(failed?.result).toBeUndefined();
    // Nothing was made up: no source, no finding, and no design request.
    expect(chatBodies).toHaveLength(chatBefore);
    await page.close();
  }, 90_000);

  it("links a failure to the Settings row that fixes it", async () => {
    const page = await openPage();
    for (const [code, href] of [
      ["claude_unavailable", "/settings#claude"],
      ["budget_setting_invalid", "/settings#research"],
      ["search_key_refused", "/settings#research"],
      ["web_search_unavailable", "/settings#research"],
    ] as const) {
      const id = await project(`Failed with ${code}`);
      await seed(id, {
        revision: 1,
        topic: "calmer evenings",
        links: ["https://notes.example/article"],
        state: "failed",
        searchProvider: null,
        startedAt: "2026-11-23T10:00:00.000Z",
        finishedAt: "2026-11-23T10:00:10.000Z",
        failure: { code, message: "This is what went wrong." },
      });
      await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
      await until(page, "This is what went wrong.");
      expect(await page.$$eval("a", (as) => as.map((a) => a.getAttribute("href")))).toContain(href);
    }
    await page.close();
  }, 60_000);

  it("links a refused start to the Settings row that fixes it", async () => {
    // The test server's Claude is a stub that is always found and its spending setting is always valid, so these two
    // refusals cannot be made by the server here (tests/research.test.ts asserts its answer carries the code). The
    // browser's side of the exchange is real: the start request is answered the way the server answers it.
    const page = await openPage(1440, 900, { expectFailedRequests: true });
    await page.setRequestInterception(true);
    let startPath = "";
    let refusal = "";
    page.on("request", (r) => {
      if (r.isInterceptResolutionHandled()) return;
      if (r.method() === "POST" && new URL(r.url()).pathname === startPath) void r.respond({ status: 400, contentType: "application/json", body: refusal });
      else void r.continue().catch(() => undefined);
    });
    for (const [code, message, href] of [
      ["claude_unavailable", "Research needs Claude Code on this computer, signed in. Connect it in Settings, then try again.", "/settings#claude"],
      ["budget_setting_invalid", "RESEARCH_MAX_BUDGET_USD in .env.local is not a valid amount. Set a positive number such as 0.50, or remove it, then restart CreatorBrio.", "/settings#research"],
    ] as const) {
      const id = await project(`Refused with ${code}`);
      startPath = `/api/carousels/${id}/research`;
      refusal = JSON.stringify({ error: message, code });
      await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
      await page.waitForSelector("#research-topic");
      // The topic is typed rather than left to the project's name, which may not have loaded when the form opened.
      await page.click("#research-topic", { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type("#research-topic", "calmer evenings");
      await page.type("#research-links", "https://notes.example/article");
      await page.click("form button[type=submit].btn-primary");
      await until(page, "Research didn't start:");
      const alert = await page.$eval('form p[role="alert"]', (p) => ({ text: p.textContent ?? "", hrefs: [...p.querySelectorAll("a")].map((a) => a.getAttribute("href")) }));
      expect(alert.text).toContain(message);
      expect(alert.hrefs).toEqual([href]);
      // Nothing was started, and the form still holds the words.
      expect(await stored(id)).toBeNull();
      expect(await page.$eval("#research-links", (t) => (t as HTMLTextAreaElement).value)).toBe("https://notes.example/article");
    }
    await page.close();
  }, 60_000);

  it("refuses a topic over 500 characters before it creates a project", async () => {
    const page = await openPage();
    const projects = async () => (await api<{ carousels: unknown[] }>(`/api/carousels`)).body.carousels.length;
    const before = await projects();
    // The idea Home hands over is not limited to the research topic's length.
    await page.goto(`${app.url}/settings`, { waitUntil: "networkidle0" });
    await page.evaluate((idea) => sessionStorage.setItem("creatorbrio:idea", idea), "calmer evenings ".repeat(40));
    await page.goto(`${app.url}/create?start=research&from=idea`, { waitUntil: "networkidle0" });
    await page.type("#create-research-links", "https://notes.example/article");
    await until(page, "The topic can be at most 500 characters");
    expect(await page.$eval("button[type=submit].btn-create", (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(await projects()).toBe(before);
    await page.close();
  }, 60_000);

  it("shows findings with their sources, takes an edited direction, and starts exactly one design", async () => {
    const created = await api<{ id: string }>(`/api/carousels`, { method: "POST", body: JSON.stringify({ name: "Calmer evenings", aspectRatio: "4:5" }) });
    const id = created.body.id;
    await seed(id, readyResearch(1));

    const page = await openPage();
    await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
    await until(page, "Findings quoted in a source");
    const body = await text(page);
    // Which search found the pages, and why the first one did not (#256).
    expect(body).toContain("found with Claude's web search and your links");
    expect(body).toContain("Brave Search is limiting requests, so Claude's web search found the pages instead.");
    expect(body).toContain("Morning light within an hour of waking helps set the body clock.");
    // The words found in the source and the source's title are on the screen, and nothing is called verified.
    expect(body).toContain("Morning light exposure within an hour of waking helps set the body clock");
    expect(body).toContain("My sleep notes");
    expect(body).toContain("Morning light and the body clock");
    expect(body.toLowerCase()).not.toContain("verified");
    expect(body).toContain("Health, money, law or safety");
    expect(body).toMatch(/Not checked[\s\S]*Cold showers double productivity\./);
    expect(body).toContain("No source says how much light is enough.");
    expect(body).toContain("a search result (the site answered with an error)");
    // Every source link leaves the app in a new tab, without a referrer path back.
    const links = await page.$$eval('a[href^="https://"]', (as) => as.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]));
    expect(links).toContainEqual(["https://sleep.example/article", "_blank", "noopener noreferrer"]);
    expect(links.every(([, target, rel]) => target === "_blank" && rel === "noopener noreferrer")).toBe(true);

    // The person edits the angle and drops the second key point.
    await page.click("#direction-angle", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type("#direction-angle", "My own angle on calmer evenings.");
    await page.click('button[aria-label="Remove key point 2"]');
    expect(chatBodies).toEqual([]);

    await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click(CONFIRM)]);
    expect(new URL(page.url()).pathname).toBe(`/carousel/${id}`);
    await page.waitForFunction(() => document.body.innerText.includes("Design it from the confirmed research."), { timeout: 15_000 });
    // The stub refuses the run; wait until the server says it has ended.
    await expect
      .poll(async () => (await api<{ generating: boolean }>(`/api/carousels/${id}/generation`)).body.generating, { timeout: 30_000, interval: 250 })
      .toBe(false);
    expect(chatBodies).toHaveLength(1);
    expect(JSON.parse(chatBodies[0])).toMatchObject({ carouselId: id, message: "Design it from the confirmed research." });

    const research = await stored(id);
    expect(research?.confirmed).toMatchObject({
      revision: 1,
      edited: true,
      direction: { ...DIRECTION, angle: "My own angle on calmer evenings.", keyPoints: [DIRECTION.keyPoints[0]] },
    });

    // A reload of the editor never sends it again.
    await page.reload({ waitUntil: "networkidle0" });
    expect(chatBodies).toHaveLength(1);
    // The editor leads back to the research.
    expect(await page.$eval(`a[href="/carousel/${id}/research"]`, (a) => a.textContent?.trim())).toBe("Research");
    await page.close();
  }, 90_000);

  it("sends the design request only after the Claude check has answered, and sends exactly one", async () => {
    const id = await project("Check first");
    await seed(id, readyResearch(1));
    const chatBefore = chatBodies.length;
    const page = await openPage();
    const isCheck = (r: HTTPRequest) => new URL(r.url()).pathname === "/api/chat/check";
    const check = await holdRequests(page, isCheck);
    await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
    await until(page, "Suggested direction");
    await page.waitForSelector(`${CONFIRM}:not(:disabled)`);
    check.hold();
    // A real confirmation: the editor opens, and its check of Claude Code is the request that is held.
    await Promise.all([page.waitForRequest(isCheck), page.click(CONFIRM)]);
    await until(page, "AI Assistant");
    // A round trip to the server orders everything the editor had already started before it.
    await page.evaluate(() => fetch("/api/status").then((r) => r.text()));
    expect(new URL(page.url()).pathname).toBe(`/carousel/${id}`);
    expect(chatBodies).toHaveLength(chatBefore);
    check.release();
    await page.waitForFunction(() => document.body.innerText.includes("Design it from the confirmed research."), { timeout: 15_000 });
    // The stub refuses the run; wait until the server says it has ended.
    await expect
      .poll(async () => (await api<{ generating: boolean }>(`/api/carousels/${id}/generation`)).body.generating, { timeout: 30_000, interval: 250 })
      .toBe(false);
    expect(chatBodies).toHaveLength(chatBefore + 1);
    expect(JSON.parse(chatBodies[chatBefore])).toMatchObject({ carouselId: id, message: "Design it from the confirmed research." });
    await page.close();
  }, 60_000);

  it("does not confirm when Enter is pressed in a field", async () => {
    const id = await project("Enter key");
    await seed(id, readyResearch(1));
    const chatBefore = chatBodies.length;
    const page = await openPage();
    const confirms: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/research/confirm")) confirms.push(r.url());
    });
    await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
    await until(page, "Suggested direction");
    const point = () => page.$eval("#direction-point-0", (t) => (t as HTMLTextAreaElement).value);
    const before = await point();
    await page.click("#direction-point-0");
    await page.keyboard.press("Enter");
    // A confirmation the Enter made would be on its way already; a round trip to the server orders everything after it.
    await page.evaluate(() => fetch("/api/status").then((r) => r.text()));
    expect(confirms).toEqual([]);
    expect(new URL(page.url()).pathname).toBe(`/carousel/${id}/research`);
    // A key point is one line of meaning: Enter changes nothing in it either.
    expect(await point()).toBe(before);
    expect((await stored(id))?.confirmed).toBeUndefined();
    expect(chatBodies).toHaveLength(chatBefore);
    await page.close();
  }, 60_000);

  it("sends no design request for a confirmation the carousel no longer holds", async () => {
    const id = await project("Stale design start");
    const ready = readyResearch(1);
    await seed(id, { ...ready, confirmed: confirmedFrom(ready) });
    const chatBefore = chatBodies.length;
    const page = await openPage();
    const key = `creatorbrio:design-start:${id}`;
    await page.goto(`${app.url}/settings`, { waitUntil: "networkidle0" });
    // Two keys an earlier visit could have left: one for another confirmation time, one for another revision.
    for (const stale of [
      { revision: 1, confirmedAt: "2026-11-22T09:00:00.000Z" },
      { revision: 2, confirmedAt: "2026-11-23T10:02:00.000Z" },
    ]) {
      await page.evaluate((k, v) => sessionStorage.setItem(k, v), key, JSON.stringify({ message: "Design it from the confirmed research.", ...stale }));
      const checked = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/chat/check");
      await page.goto(`${app.url}/carousel/${id}`, { waitUntil: "networkidle0" });
      // Claude is available, so only the key itself stopped the send.
      expect(await (await checked).json()).toMatchObject({ available: true });
      await until(page, "AI Assistant");
      expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).toBeNull();
      expect(chatBodies).toHaveLength(chatBefore);
      expect((await stored(id))?.lastDesign).toBeUndefined();
    }
    await page.close();
  }, 60_000);

  it("starts no design when the person leaves before the confirmation is answered", async () => {
    const id = await project("Left early");
    await seed(id, readyResearch(1));
    const chatBefore = chatBodies.length;
    const page = await openPage();
    const isConfirm = (r: HTTPRequest) => r.method() === "POST" && new URL(r.url()).pathname === `/api/carousels/${id}/research/confirm`;
    const confirm = await holdRequests(page, isConfirm);
    await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
    await until(page, "Suggested direction");
    confirm.hold();
    await Promise.all([page.waitForRequest(isConfirm), page.click(CONFIRM)]);
    // The person goes back to the project instead of waiting; the research screen unmounts.
    await page.click(`a[href="/carousel/${id}"]`);
    await page.waitForFunction((p) => location.pathname === p, { timeout: 15_000 }, `/carousel/${id}`);
    await until(page, "AI Assistant");
    confirm.release();
    // The server did confirm, but the screen that asked is gone: it hands nothing to the editor and sends nothing.
    await expect.poll(async () => (await stored(id))?.confirmed?.revision, { timeout: 15_000, interval: 250 }).toBe(1);
    await page.evaluate(() => fetch("/api/status").then((r) => r.text()));
    expect(await page.evaluate((k) => sessionStorage.getItem(k), `creatorbrio:design-start:${id}`)).toBeNull();
    expect(chatBodies).toHaveLength(chatBefore);
    await page.close();
  }, 60_000);

  it("fits a phone without sideways scrolling, even for a very long project name", async () => {
    const named = (n: number) => "Calmer evenings ".repeat(Math.ceil(n / 16)).slice(0, n).trim();
    const projects: { id: string; name: string }[] = [];
    for (const name of [named(60), named(200), "x".repeat(200)]) {
      const id = await project(name);
      await seed(id, readyResearch(1));
      // The name as the server keeps it, which is what the back link must come to show.
      projects.push({ id, name: (await api<{ name: string }>(`/api/carousels/${id}`)).body.name });
    }
    const page = await openPage(375, 812);
    const fits = async () => {
      const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(scroll).toBeLessThanOrEqual(client);
    };
    for (const width of [375, 320]) {
      await page.setViewport({ width, height: 812 });
      // `from=idea` opens New project on its details step on a phone, where the research fields are.
      if (width === 375) {
        await page.goto(`${app.url}/create?start=research&from=idea`, { waitUntil: "networkidle0" });
        await page.waitForSelector("h1");
        await fits();
      }
      for (const { id, name } of projects) {
        await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
        await until(page, "Findings quoted in a source");
        // The back link names the project, in full in the page and cut to the screen by the layout. The wait is for the
        // project's own name, not for the label the link shows until the project has loaded.
        await page.waitForFunction((href, expected) => document.querySelector(`a[href="${href}"] .truncate`)?.textContent === expected, {}, `/carousel/${id}`, name);
        await fits();
      }
    }
    await page.close();
  }, 90_000);

  it("logs no browser errors", () => {
    expect(consoleErrors).toEqual([]);
  });
});
