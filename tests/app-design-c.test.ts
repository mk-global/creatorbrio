import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { startBuiltApp, type BuiltApp } from "./helpers/studio-app";
import { appBrowser, appBrowserTestMissing, inCi } from "./helpers/app-browser";

// The Design C app, end to end in a real browser against the production build
// (#174, #175). The app runs on its own port over an empty data folder, seeded
// through the public API the way a person's actions would fill it. No design
// is ever run: every request is recorded and none may reach /api/chat, the one
// route that starts a paid Claude run.

const PORT = 3191;
const MISSING = appBrowserTestMissing();
// In CI the test must run; a missing build or browser fails it there instead of skipping.
const SKIP = MISSING !== null && !inCi;

const NORTHWIND = {
  name: "Northwind Coffee",
  colors: { primary: "#2b1d14", secondary: "#6b4a33", accent: "#e0a458", background: "#fbf6ef", surface: "#efe4d6" },
  fonts: { heading: "Fraunces", body: "Inter" },
  styleKeywords: ["warm", "crafted"],
};
const HARBOR = {
  name: "Harbor Yoga",
  colors: { primary: "#12355b", secondary: "#2f6690", accent: "#ff7f50", background: "#ffffff", surface: "#e8f1f8" },
  fonts: { heading: "DM Serif Display", body: "DM Sans" },
  styleKeywords: ["calm"],
};
const SLIDE = (text: string, bg: string) =>
  `<div style="width:1080px;height:1350px;background:${bg};color:#fff;display:flex;align-items:center;justify-content:center;font:700 96px sans-serif">${text}</div>`;

describe.skipIf(SKIP)("the Design C app in a browser", () => {
  let app: BuiltApp;
  let browser: Browser;
  let harborId = "";
  let carouselId = "";
  let documentId = "";
  let templateId = "";
  const chatRequests: string[] = [];
  const unauthorized: string[] = [];
  const consoleErrors: string[] = [];

  async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${app.url}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async function openPage(width = 1440, height = 900): Promise<Page> {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    page.on("request", (r) => {
      // /api/chat starts a design run; /api/chat/check only asks whether Claude is installed.
      if (new URL(r.url()).pathname === "/api/chat") chatRequests.push(`${r.method()} ${r.url()}`);
    });
    page.on("response", (r) => {
      if (r.status() === 401) unauthorized.push(new URL(r.url()).pathname);
    });
    page.on("console", (m) => {
      // Sandboxed slide iframes have no scripts; that is the point, not an error.
      if (m.type() === "error" && !/about:srcdoc|sandboxed/i.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    return page;
  }

  async function settled(page: Page, path: string): Promise<void> {
    await page.goto(`${app.url}${path}`, { waitUntil: "networkidle0" });
  }

  beforeAll(async () => {
    if (MISSING) throw new Error(`The Design C browser test cannot run in CI: ${MISSING}`);
    const chromium = appBrowser()!;
    app = await startBuiltApp(PORT, { chromium, claudeStub: true });
    browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });

    // Two brands, the first set up as the default.
    expect((await api(`/api/brands/default`, { method: "PUT", body: JSON.stringify(NORTHWIND) })).status).toBe(200);
    const harbor = await api<{ id: string }>(`/api/brands`, { method: "POST", body: JSON.stringify(HARBOR) });
    expect(harbor.status).toBe(201);
    harborId = harbor.body.id;

    // A carousel with no format, as every project before formats was; a LinkedIn document for Harbor.
    const carousel = await api<{ id: string }>(`/api/carousels`, { method: "POST", body: JSON.stringify({ name: "Spring menu", aspectRatio: "4:5" }) });
    carouselId = carousel.body.id;
    for (const [i, bg] of ["#2b1d14", "#6b4a33"].entries()) {
      await api(`/api/carousels/${carouselId}/slides`, { method: "POST", body: JSON.stringify({ html: SLIDE(`Slide ${i + 1}`, bg) }) });
    }
    const document = await api<{ id: string }>(`/api/carousels`, {
      method: "POST",
      body: JSON.stringify({ name: "Breathing guide", aspectRatio: "4:5", brandId: harborId, format: "linkedin-document" }),
    });
    documentId = document.body.id;
    for (const [i, bg] of ["#12355b", "#2f6690", "#12355b"].entries()) {
      await api(`/api/carousels/${documentId}/slides`, { method: "POST", body: JSON.stringify({ html: SLIDE(`Page ${i + 1}`, bg) }) });
    }
    const template = await api<{ id: string }>(`/api/templates`, { method: "POST", body: JSON.stringify({ carouselId, name: "Menu launch" }) });
    expect(template.status).toBe(201);
    templateId = template.body.id;
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.stop();
  });

  it("opens Home on the four formats, for the default brand, with one main navigation", async () => {
    const page = await openPage();
    await settled(page, "/");
    const home = await page.evaluate(() => ({
      heading: document.querySelector("h1")?.textContent?.trim(),
      creatingFor: document.querySelector("#make")?.previousElementSibling?.textContent ?? "",
      formats: [...document.querySelectorAll('ul[aria-label="Formats"] a')].map((a) => [a.textContent ?? "", a.getAttribute("href")]),
      visibleNavs: [...document.querySelectorAll('nav[aria-label="Main"]')].filter((n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden").length,
      recent: document.body.innerText.includes("Spring menu"),
    }));
    expect(home.heading).toBe("What do you want to make?");
    expect(home.creatingFor).toContain("Northwind Coffee");
    expect(home.formats.map(([, href]) => href)).toEqual([
      "/create?format=instagram-carousel",
      "/create?format=linkedin-document",
      "/create?format=reel-cover",
      "/studio",
    ]);
    expect(home.formats[3][0]).toContain("Video Studio");
    expect(home.visibleNavs).toBe(1);
    expect(home.recent).toBe(true);
    await page.close();
  }, 60_000);

  it("has no horizontal overflow on any page at 1440, 1280, 768, 390 and 320 px", async () => {
    const page = await openPage();
    const overflow: string[] = [];
    const pages = ["/", "/projects", "/templates", "/brands", `/brands/${harborId}`, "/brands/new", "/settings", "/create", "/create?format=reel-cover", "/studio", `/carousel/${carouselId}`, `/carousel/${documentId}`];
    for (const width of [1440, 1280, 768, 390, 320]) {
      await page.setViewport({ width, height: 900 });
      for (const path of pages) {
        await settled(page, path);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
        if (scroll > width) overflow.push(`${path} at ${width}px is ${scroll}px wide`);
        const navs = await page.evaluate(
          () => [...document.querySelectorAll('nav[aria-label="Main"]')].filter((n) => (n as HTMLElement).getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden").length
        );
        // The editor on a phone gives the whole screen to the work; everywhere else there is exactly one main navigation.
        const expected = path.startsWith("/carousel/") && width < 768 ? 0 : 1;
        if (navs !== expected) overflow.push(`${path} at ${width}px shows ${navs} main navigations`);
      }
    }
    expect(overflow).toEqual([]);
    await page.close();
  }, 300_000);

  it("can be used from the keyboard: skip link first, every stop visibly focused", async () => {
    const page = await openPage();
    await settled(page, "/");
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
    expect(first).toBe("Skip to content");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");

    await settled(page, "/");
    const stops: { name: string; outlined: boolean }[] = [];
    // Every stop on Home once, until focus leaves the page at the end.
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement === document.body)) break;
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const style = getComputedStyle(el);
          const label = el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "";
          return {
            name: `${el.tagName.toLowerCase()} ${label.trim().replace(/\s+/g, " ").slice(0, 60)}`,
            // A visible ring: an outline, or the inset ring the text fields draw instead.
            outlined: (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1) || style.boxShadow !== "none",
          };
        })
      );
    }
    const names = stops.map((s) => s.name);
    expect(names.length).toBeGreaterThan(15);
    expect(names.some((n) => n.startsWith("button Brand for new work: Northwind Coffee"))).toBe(true);
    expect(names.some((n) => n.startsWith("a Instagram carousel"))).toBe(true);
    expect(names.some((n) => n.startsWith("a Reel cover"))).toBe(true);
    expect(stops.filter((s) => !s.outlined).map((s) => s.name)).toEqual([]);
    await page.close();
  }, 60_000);

  it("switches the brand for new work, keeps the choice and filters the library by it", async () => {
    const page = await openPage();
    await settled(page, "/");
    await page.click('aside button[aria-label^="Brand for new work"]');
    await page.waitForSelector('[role="menuitemradio"]');
    const options = await page.$$eval('[role="menuitemradio"]', (els) => els.map((e) => e.textContent ?? ""));
    expect(options.map((t) => t.includes("Harbor Yoga") || t.includes("Northwind Coffee"))).toEqual([true, true]);
    const harbor = (await page.$$('[role="menuitemradio"]'))[options.findIndex((t) => t.includes("Harbor Yoga"))];
    await harbor.click();
    await page.waitForFunction(() => document.querySelector("#make")?.previousElementSibling?.textContent?.includes("Harbor Yoga"));

    await page.reload({ waitUntil: "networkidle0" });
    expect(await page.evaluate(() => document.querySelector("#make")?.previousElementSibling?.textContent)).toContain("Harbor Yoga");

    await settled(page, "/projects");
    const text = await page.evaluate(() => document.querySelector("main")?.innerText ?? "");
    expect(text).toContain("Breathing guide");
    expect(text).not.toContain("Spring menu");

    // Switching brand is a view preference: the project's own brand never changes.
    const project = await api<{ brandId?: string }>(`/api/carousels/${carouselId}`);
    expect(project.body.brandId ?? "default").toBe("default");

    // Back to the default, so the remaining tests start where a person would.
    await page.click('aside button[aria-label^="Brand for new work"]');
    await page.waitForSelector('[role="menuitemradio"]');
    const items = await page.$$('[role="menuitemradio"]');
    for (const item of items) if ((await item.evaluate((e) => e.textContent ?? "")).includes("Northwind Coffee")) await item.click();
    await page.close();
  }, 90_000);

  it("offers each format's own sizes and locks the Reel cover to one 9:16 image", async () => {
    const page = await openPage();
    await settled(page, "/create?format=linkedin-document");
    const sizes = await page.$$eval('input[name="size"]', (els) => els.map((e) => (e.closest("label")?.textContent ?? "").trim()));
    expect(sizes.join(" ")).toMatch(/4:5/);
    expect(sizes.join(" ")).toMatch(/1:1/);
    expect(sizes.join(" ")).not.toMatch(/9:16/);

    await page.click('input[name="format"][value="reel-cover"]');
    const text = await page.evaluate(() => document.querySelector("form")?.innerText ?? "");
    expect(text).toContain("A Reel cover is always one 9:16 image.");
    await page.close();
  }, 60_000);

  it("creates a Reel cover with the words prefilled, sends nothing, and refuses a second slide", async () => {
    const page = await openPage();
    await settled(page, "/create?format=reel-cover");
    await page.type("#about", "Three stretches for desk workers");
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click('form button[type="submit"]')]);
    const id = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
    expect(page.url()).toContain("/carousel/");

    const composer = await page.$eval('textarea[aria-label="Chat message input"]', (e) => (e as HTMLTextAreaElement).value);
    expect(composer).toBe("A one-slide Reel cover. Three stretches for desk workers");

    const cover = await api<{ format: string; aspectRatio: string; brandId?: string; slides: unknown[] }>(`/api/carousels/${id}`);
    expect(cover.body).toMatchObject({ format: "reel-cover", aspectRatio: "9:16", slides: [] });

    const cover916 = SLIDE("Cover", "#2b1d14").replace("height:1350px", "height:1920px");
    expect((await api(`/api/carousels/${id}/slides`, { method: "POST", body: JSON.stringify({ html: cover916 }) })).status).toBe(201);
    const second = await api<{ error: string }>(`/api/carousels/${id}/slides`, { method: "POST", body: JSON.stringify({ html: cover916 }) });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.body.error).toContain("A Reel cover has one slide.");

    // The editor's main export for a one-slide cover is the single PNG, at 1080 × 1920.
    await page.reload({ waitUntil: "networkidle0" });
    expect(await page.evaluate(() => document.body.innerText)).toContain("1080 × 1920");
    const png = await fetch(`${app.url}/api/carousels/${id}/export?format=single-png`, { method: "POST" });
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await png.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1080, 1920]);
    expect(chatRequests).toEqual([]);
    await page.close();
  }, 120_000);

  it("exports a LinkedIn document as one PDF", async () => {
    const pdf = await fetch(`${app.url}/api/carousels/${documentId}/export?format=pdf`, { method: "POST" });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length).toBe(3);
  }, 120_000);

  it("starts a project from a template with its slides", async () => {
    const page = await openPage();
    await settled(page, `/create?template=${templateId}`);
    expect(await page.$eval(`input[name="template"]`, (e) => (e as HTMLInputElement).checked)).toBe(true);
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click('form button[type="submit"]')]);
    const id = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
    const made = await api<{ slides: unknown[]; templateId?: string }>(`/api/carousels/${id}`);
    expect(made.body.slides).toHaveLength(2);
    expect(chatRequests).toEqual([]);
    await page.close();
  }, 60_000);

  it("opens Video Studio unpaired without a single 401", async () => {
    const page = await openPage();
    await settled(page, "/");
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click('aside a[href="/studio"]')]);
    const text = await page.evaluate(() => document.querySelector("main")?.innerText ?? "");
    expect(text).toContain("Video Studio");
    expect(text).toMatch(/pair/i);
    expect(unauthorized).toEqual([]);
    await page.close();
  }, 60_000);

  it("logged no errors in the browser console and never started a design", () => {
    expect(consoleErrors).toEqual([]);
    expect(chatRequests).toEqual([]);
  });
});
