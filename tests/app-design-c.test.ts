import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

  /** `expectFailedRequests`: a page that provokes server errors on purpose, whose "Failed to load resource" lines are not app errors. */
  async function openPage(width = 1440, height = 900, { expectFailedRequests = false } = {}): Promise<Page> {
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
      if (m.type() !== "error" || /about:srcdoc|sandboxed/i.test(m.text())) return;
      if (expectFailedRequests && /Failed to load resource/.test(m.text())) return;
      consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    return page;
  }

  /** An export, failing with the app's own error and its log rather than a bare status. */
  async function exportAs(id: string, format: string): Promise<Response> {
    const res = await fetch(`${app.url}/api/carousels/${id}/export?format=${format}`, { method: "POST" });
    if (res.status !== 200) throw new Error(`Export ${format} answered ${res.status}: ${await res.text()}\n--- server log ---\n${app.logTail()}`);
    return res;
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
    await page.waitForFunction(() => document.querySelector("#make")?.previousElementSibling?.textContent?.includes("Northwind Coffee") && document.body.innerText.includes("Spring menu"), { timeout: 15_000 });
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

  it("wears the CreatorBrio identity: its icons, coral creation, outlined deletion, type roles and mono metadata (#189)", async () => {
    // The browser and device icons are the brand's, linked from every page.
    const html = await (await fetch(`${app.url}/`)).text();
    const icons = [...html.matchAll(/<link rel="(icon|apple-touch-icon)" href="([^"?]+)[^>]*>/g)].map(([, rel, href]) => `${rel} ${href}`);
    expect(icons).toEqual(["icon /favicon.ico", "icon /icon.svg", "apple-touch-icon /apple-icon.png"]);
    expect(await (await fetch(`${app.url}/icon.svg`)).text()).toContain("M1 5V1h4");
    const ico = await fetch(`${app.url}/favicon.ico`);
    expect(ico.status).toBe(200);
    expect(Buffer.from(await ico.arrayBuffer()).readUInt16LE(4)).toBe(3);

    const page = await openPage();
    const style = (selector: string, ...props: string[]) =>
      page.$eval(selector, (el, names) => names.map((n) => getComputedStyle(el).getPropertyValue(n)), props);

    await settled(page, "/");
    await page.waitForSelector("aside .btn-create");
    // Deep Coral fills the action that starts new work.
    expect(await style("aside .btn-create", "background-color", "color")).toEqual(["rgb(191, 57, 79)", "rgb(255, 255, 255)"]);
    const [heroSize, heroFamily] = await style("h1#make", "font-size", "font-family");
    expect(heroSize).toBe("48px");
    expect(heroFamily).toMatch(/Instrument Sans/);
    // The current page is marked with Brand Coral.
    expect(await style('aside a[aria-current="page"] svg', "color")).toEqual(["rgb(233, 69, 96)"]);

    await settled(page, "/projects");
    expect(await style("h1", "font-size")).toEqual(["32px"]);

    // Technical values are Geist Mono; the interface is Instrument Sans.
    await settled(page, `/carousel/${carouselId}`);
    await page.waitForSelector("header .meta");
    const meta = await page.$eval("header .meta", (el) => ({ text: el.textContent ?? "", family: getComputedStyle(el).fontFamily }));
    expect(meta.text).toContain("1080 × 1350");
    expect(meta.family).toMatch(/Geist Mono/);
    expect((await style("body", "font-family"))[0]).toMatch(/Instrument Sans/);

    // The current slide is named to assistive technology and outlined twice in coral, so it never depends on colour alone.
    const current = () => page.$$eval('button[aria-current="true"][aria-label^="Select slide"]', (els) => els.map((el) => [el.getAttribute("aria-label"), getComputedStyle(el).boxShadow]));
    const first = await current();
    expect(first.map(([name]) => name)).toEqual(["Select slide 1"]);
    expect(first[0][1]).toContain("rgb(233, 69, 96)");
    await (await page.waitForSelector('::-p-aria([name="Select slide 2"][role="button"])'))!.click();
    await page.waitForFunction(() => document.querySelector('button[aria-current="true"]')?.getAttribute("aria-label") === "Select slide 2");
    expect((await current()).map(([name]) => name)).toEqual(["Select slide 2"]);

    // Deleting is an alert outline on paper: never a fill that could read as the create action.
    await settled(page, "/templates");
    await (await page.waitForSelector('::-p-aria([name="Delete template Menu launch"][role="button"])'))!.click();
    const confirm = await page.waitForSelector('::-p-aria([name="Delete template"][role="button"])');
    const [bg, color] = await confirm!.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
    expect([bg, color]).toEqual(["rgb(255, 255, 255)", "rgb(163, 36, 59)"]);
    await page.keyboard.press("Escape");
    const kept = await api<{ templates: { id: string }[] }>(`/api/templates`);
    expect(kept.body.templates.map((t) => t.id)).toContain(templateId);
    await page.close();
  }, 120_000);

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

  it("shows every colour's full role name and hint in the brand editor at 1440, 1280, 768, 390 and 320 px (#190)", async () => {
    const page = await openPage();
    const clipped: string[] = [];
    /** Each colour field's role name and hint must lie wholly inside its own box, clear of the swatch and the hex input. */
    const measure = async (where: string, width: number) => {
      const found = await page.$$eval("main form li:has(input[type=color])", (items) =>
        items.flatMap((li) => {
          const label = li.querySelector("label")!;
          const hint = li.querySelector("p")!;
          const swatch = li.querySelector("input[type=color]")!.getBoundingClientRect();
          const hex = li.querySelector("input:not([type=color])")!.getBoundingClientRect();
          const field = li.getBoundingClientRect();
          const name = label.textContent ?? "";
          return [label, hint].flatMap((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const text = range.getBoundingClientRect();
            const own = el.getBoundingClientRect();
            const problems: string[] = [];
            if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) problems.push(`overflows its box (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`);
            if (text.left < own.left - 0.5 || text.right > own.right + 0.5) problems.push(`text is ${Math.round(text.width)}px wide in a ${Math.round(own.width)}px box`);
            if (text.left < field.left - 0.5 || text.right > field.right + 0.5) problems.push("text leaves the field");
            for (const [other, r] of [["hex input", hex], ["swatch", swatch]] as const) {
              if (text.left < r.right && text.right > r.left && text.top < r.bottom && text.bottom > r.top) problems.push(`text lies under the ${other}`);
            }
            const what = el === label ? `${name} role name` : `${name} hint "${el.textContent}"`;
            return problems.map((p) => `${what}: ${p}`);
          });
        })
      );
      clipped.push(...found.map((f) => `${where} at ${width}px: ${f}`));
    };
    const fieldsShown = (primary: string) =>
      page.waitForFunction(
        (want) => (document.querySelector("#hex-primary") as HTMLInputElement | null)?.value === want && document.querySelectorAll("main form li:has(input[type=color])").length === 5,
        { timeout: 15_000 },
        primary
      );

    // The sidebar is as the app draws it at each width: full at 1440 and 1280, the rail at 768, none on a phone.
    for (const width of [1440, 1280, 768, 390, 320]) {
      await page.setViewport({ width, height: 900 });
      await settled(page, "/brands/new");
      await fieldsShown("#1a1a2e");
      await measure("/brands/new", width);
      await settled(page, `/brands/${harborId}`);
      await fieldsShown(HARBOR.colors.primary);
      await measure(`/brands/${HARBOR.name}`, width);
      // The longer message for a colour that is not #RRGGBB must fit as well.
      // Focused and selected directly: on a clipped layout the field may not be where a click would land.
      await page.focus("#hex-surface");
      await page.$eval("#hex-surface", (el) => (el as HTMLInputElement).select());
      await page.keyboard.type("#12");
      await page.waitForFunction(() => document.querySelector("#hex-surface-hint")?.textContent?.startsWith("Use # and six digits"), { timeout: 10_000 });
      await measure(`/brands/${HARBOR.name} with an invalid surface colour`, width);
    }
    expect(clipped).toEqual([]);
    // Nothing typed here was saved.
    expect((await api<{ colors: { surface: string } }>(`/api/brands/${harborId}`)).body.colors.surface).toBe(HARBOR.colors.surface);
    await page.close();
  }, 240_000);

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
    await page.waitForFunction(() => document.querySelector("#make")?.previousElementSibling?.textContent?.includes("Harbor Yoga"), { timeout: 15_000 });

    await settled(page, "/projects");
    await page.waitForFunction(() => (document.querySelector("main")?.innerText ?? "").includes("Breathing guide"), { timeout: 15_000 });
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

    // The message box appears once the editor has checked that Claude Code is installed.
    await page.waitForSelector('textarea[aria-label="Chat message input"]', { timeout: 15_000 });
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
    await page.waitForFunction(() => document.body.innerText.includes("1080 × 1920"), { timeout: 15_000 });
    const png = await exportAs(id, "single-png");
    expect(png.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await png.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1080, 1920]);
    expect(chatRequests).toEqual([]);
    await page.close();
  }, 120_000);

  it("exports a LinkedIn document as one PDF", async () => {
    const pdf = await exportAs(documentId, "pdf");
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
    // The page asks whether this browser is paired, then shows the pairing panel.
    await page.waitForFunction(() => /pair/i.test(document.querySelector("main")?.innerText ?? "") && !/Checking this browser/.test(document.querySelector("main")?.innerText ?? ""), { timeout: 15_000 });
    const text = await page.evaluate(() => document.querySelector("main")?.innerText ?? "");
    expect(text).toContain("Video Studio");
    expect(unauthorized).toEqual([]);
    await page.close();
  }, 60_000);

  it("renames a project with Enter and cancels a rename with Escape", async () => {
    const page = await openPage();
    await settled(page, `/carousel/${carouselId}`);
    const field = await page.waitForSelector("#project-name");
    const stored = async () => (await api<{ name: string }>(`/api/carousels/${carouselId}`)).body.name;

    await field!.click({ clickCount: 3 });
    await page.keyboard.type("Spring menu, final");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (document.querySelector("#project-name") as HTMLInputElement | null)?.value === "Spring menu, final");
    await expect.poll(stored).toBe("Spring menu, final");

    // Escape puts the stored name back and saves nothing.
    await field!.click({ clickCount: 3 });
    await page.keyboard.type("A name I did not want");
    await page.keyboard.press("Escape");
    expect(await page.$eval("#project-name", (e) => (e as HTMLInputElement).value)).toBe("Spring menu, final");
    await new Promise((r) => setTimeout(r, 500));
    expect(await stored()).toBe("Spring menu, final");
    await page.close();
  }, 60_000);

  it("opens a recent production from Home in the Studio workspace", async () => {
    const page = await openPage();
    // Pair this browser with a code from the pairing command, as a person does; the data is this test's own.
    const printed = execFileSync(process.execPath, [path.resolve(__dirname, "..", "scripts", "studio-pair.mjs"), "--data-dir", app.dataDir, "--no-tty-check"], { encoding: "utf8" });
    const code = /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(printed)![1];
    await settled(page, "/studio");
    await (await page.waitForSelector("::-p-aria(Pairing code)"))!.type(code);
    await (await page.waitForSelector('::-p-aria([name="Pair"][role="button"])'))!.click();
    await (await page.waitForSelector("::-p-aria(New production)", { timeout: 30_000 }))!.type("Launch teaser");
    await (await page.waitForSelector('::-p-aria([name="Create"][role="button"])'))!.click();
    await page.waitForFunction(() => new URL(location.href).searchParams.has("production"), { timeout: 30_000 });
    const id = new URL(page.url()).searchParams.get("production")!;

    // Home lists it; following the link is a client-side navigation into that production.
    await settled(page, "/");
    const link = await page.waitForSelector(`a[href="/studio?production=${id}"]`, { timeout: 15_000 });
    await link!.click();
    await page.waitForFunction((want) => new URL(location.href).searchParams.get("production") === want, {}, id);
    // The workspace, not the list: its heading is the production's name, and the list's form is gone.
    await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.textContent?.trim() === "Launch teaser"), { timeout: 15_000 });
    expect(await page.$("::-p-aria(New production)")).toBeNull();
    await page.close();
  }, 120_000);

  it("refuses an invalid colour, keeps duplicate brand names apart and reverts a rename that was not saved", async () => {
    const page = await openPage(1440, 900, { expectFailedRequests: true });

    // A colour that is not #RRGGBB blocks saving, with the reason.
    await settled(page, "/brands/new");
    await page.type("#bname", "Draft brand");
    const hex = await page.waitForSelector("#hex-accent");
    await hex!.click({ clickCount: 3 });
    await page.keyboard.type("#12");
    expect(await page.$eval('form button[type="submit"]', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.evaluate(() => document.querySelector("form")?.innerText ?? "")).toContain("Fix the accent colour to save it.");

    // Two brands may share a name; the menu still lists both without a React key clash.
    expect((await api(`/api/brands`, { method: "POST", body: JSON.stringify({ ...HARBOR, colors: { ...HARBOR.colors, accent: "#00aa88" } }) })).status).toBe(201);
    await settled(page, "/");
    await page.click('aside button[aria-label^="Brand for new work"]');
    await page.waitForSelector('[role="menuitemradio"]');
    expect((await page.$$eval('[role="menuitemradio"]', (els) => els.map((e) => e.textContent ?? ""))).filter((t) => t.includes("Harbor Yoga"))).toHaveLength(2);
    await page.keyboard.press("Escape");

    // The Projects toggles say which option is on.
    await settled(page, "/projects");
    expect(await page.$$eval('[role="group"][aria-label="Which brands"] button', (els) => els.map((e) => e.getAttribute("aria-pressed")))).toEqual(["true", "false"]);

    // A rename the server does not store puts the stored name back in the field.
    await settled(page, `/carousel/${documentId}`);
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.method() === "PUT" && r.url().endsWith(`/api/carousels/${documentId}`) ? r.respond({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' }) : r.continue()));
    const field = await page.waitForSelector("#project-name");
    await field!.click({ clickCount: 3 });
    await page.keyboard.type("Never stored");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (document.querySelector("#project-name") as HTMLInputElement | null)?.value === "Breathing guide", { timeout: 10_000 });
    await page.setRequestInterception(false);
    await page.close();
  }, 120_000);

  it("shows the brands error on Projects and Templates rather than an empty library", async () => {
    const file = path.join(app.dataDir, "brands.json");
    const original = await readFile(file, "utf8");
    const page = await openPage(1440, 900, { expectFailedRequests: true });
    try {
      await writeFile(file, "{ not json");
      for (const where of ["/projects", "/templates"]) {
        await settled(page, where);
        await page.waitForFunction(() => document.body.innerText.includes("Your brands couldn't be loaded"), { timeout: 15_000 });
      }
    } finally {
      await writeFile(file, original);
      await page.close();
    }
  }, 60_000);

  it("logged no errors in the browser console and never started a design", () => {
    expect(consoleErrors).toEqual([]);
    expect(chatRequests).toEqual([]);
  });
});
