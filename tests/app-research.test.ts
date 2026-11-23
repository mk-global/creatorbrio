import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { startBuiltApp, type BuiltApp } from "./helpers/studio-app";
import { appBrowser, appBrowserTestMissing, inCi } from "./helpers/app-browser";
import type { CarouselResearch } from "@/types/research";

// The research screen (#253), end to end in a real browser against the
// production build. No search key is set and Claude is a stub that refuses
// every run, so nothing leaves the machine: research is seeded into the data
// folder in the shape a finished run stores, and the one design request the
// journey makes is recorded and refused by the stub.

const PORT = 3192;
const MISSING = appBrowserTestMissing();
const SKIP = MISSING !== null && !inCi;

const DIRECTION = {
  angle: "Three small morning habits that make evenings calmer.",
  audience: "Busy professionals who sleep badly.",
  centralMessage: "Small changes early in the day make sleep easier later.",
  keyPoints: ["Get outside within an hour of waking", "Move the last coffee earlier"],
  callToAction: "Save this for tomorrow morning.",
};

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
    },
    usage: { costUsd: 0.05, durationMs: 90_000, searchRequests: 1, pagesRead: 2 },
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
    await until(page, "Web search is not set up");
    const create = () => page.$eval("button[type=submit].btn-create", (b) => ({ text: b.textContent, disabled: (b as HTMLButtonElement).disabled }));
    await page.type("#create-research-topic", "calmer evenings");
    // Without a search key, a link is required before anything can start.
    expect(await create()).toEqual({ text: "Create and research", disabled: true });
    expect(await text(page)).toContain("Add at least one link, or set up web search.");
    await page.type("#create-research-links", "http://127.0.0.1/private");
    expect((await create()).disabled).toBe(false);
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button[type=submit].btn-create")]);

    expect(new URL(page.url()).pathname).toMatch(/^\/carousel\/[^/]+\/research$/);
    await until(page, "Research didn't start:");
    expect(await text(page)).toContain("This link cannot be read: http://127.0.0.1/private");
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

  it("shows findings with their sources, takes an edited direction, and starts exactly one design", async () => {
    const created = await api<{ id: string }>(`/api/carousels`, { method: "POST", body: JSON.stringify({ name: "Calmer evenings", aspectRatio: "4:5" }) });
    const id = created.body.id;
    await seed(id, readyResearch(1));

    const page = await openPage();
    await page.goto(`${app.url}/carousel/${id}/research`, { waitUntil: "networkidle0" });
    await until(page, "Findings quoted in a source");
    const body = await text(page);
    expect(body).toContain("Morning light within an hour of waking helps set the body clock.");
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

    await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("button[type=submit].btn-create")]);
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

  it("fits a phone without sideways scrolling", async () => {
    const created = await api<{ id: string }>(`/api/carousels`, { method: "POST", body: JSON.stringify({ name: "Phone", aspectRatio: "4:5" }) });
    await seed(created.body.id, readyResearch(1));
    const page = await openPage(375, 812);
    // `from=idea` opens New project on its details step on a phone, where the research fields are.
    for (const where of ["/create?start=research&from=idea", `/carousel/${created.body.id}/research`]) {
      await page.goto(`${app.url}${where}`, { waitUntil: "networkidle0" });
      await page.waitForSelector("h1");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    }
    await page.close();
  }, 60_000);

  it("logs no browser errors", () => {
    expect(consoleErrors).toEqual([]);
  });
});
