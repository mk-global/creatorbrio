/**
 * The chat's run notices are readable whatever the operating system's
 * appearance (#168). Before, the "Stopped before designing" notice and the
 * "Design unfinished" bar switched to pale amber text under Tailwind's
 * OS-driven `dark:` variant while their surface stayed light (1.1:1), and the
 * chat error bar drew #ef4444 text on its own tint (3.3:1).
 *
 * The real components are rendered to HTML, the app's real `globals.css` is
 * compiled by Tailwind for exactly the classes they use, and the page is
 * measured in Chromium under light and dark `prefers-color-scheme`: computed
 * text, icon and border colours composited over their real backgrounds,
 * selected text, and wrapping in a narrow chat column.
 *
 * CI installs without Puppeteer's browser, so this test also uses a system
 * Chrome, and under CI it fails rather than skip when there is none.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { compile } from "tailwindcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChatMessage } from "@/components/chat/ChatMessage";
import { ContinueBar, RunError, RunNotice } from "@/components/chat/RunNotice";
import { CHAT_ERROR_MESSAGES } from "@/lib/chat-stream";
import { DIRECTOR_FAILURE_MESSAGES } from "@/lib/visual-director";
import { chromiumPath } from "./helpers/native-pdf";

const ROOT = path.resolve(__dirname, "..");
const SYSTEM_CHROME = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const BROWSER = chromiumPath() ?? SYSTEM_CHROME.find((p) => existsSync(p)) ?? null;
const RUN_ID = "44444444-4444-4444-8444-444444444444";

if (!BROWSER && process.env.CI) {
  throw new Error("No Chromium or Chrome found; the chat notice contrast test must run on CI");
}

const noop = () => {};
/** Every chat surface that reports a stopped, unfinished or failed run, and an ordinary reply for comparison. */
const SURFACES: { id: string; element: ReactElement; kind: "warning" | "error" | "reply" }[] = [
  {
    id: "planning-failure",
    kind: "warning",
    element: createElement(RunNotice, { notice: { kind: "blocked", message: DIRECTOR_FAILURE_MESSAGES.invalid_plan, retryRunId: null } }),
  },
  {
    id: "image-failure",
    kind: "warning",
    element: createElement(RunNotice, {
      notice: { kind: "blocked", message: "The edited photo for slide 1 could not be made. Nothing was changed; Retry remakes only the missing images.", retryRunId: RUN_ID },
      onRetry: noop,
    }),
  },
  { id: "unfinished", kind: "warning", element: createElement(ContinueBar, { saved: 3, expected: 8, onContinue: noop }) },
  ...(["agent_failed", "timed_out", "budget_exceeded"] as const).map((code) => ({
    id: `error-${code}`,
    kind: "error" as const,
    element: createElement(RunError, { message: CHAT_ERROR_MESSAGES[code] }),
  })),
  {
    id: "invalid-input",
    kind: "error",
    element: createElement(RunError, { message: "Message is too long: 32,001 characters, and the limit is 32,000." }),
  },
  { id: "reply", kind: "reply", element: createElement(ChatMessage, { role: "assistant", content: "Changed the colour of the word." }) },
];

/** The app's real stylesheet, compiled for exactly the classes the rendered surfaces use. */
async function appCss(markup: string): Promise<string> {
  const globals = await readFile(path.join(ROOT, "src/app/globals.css"), "utf8");
  const compiler = await compile(globals, {
    base: path.join(ROOT, "src/app"),
    loadStylesheet: async (id) => {
      const file = id === "tailwindcss" ? path.join(ROOT, "node_modules/tailwindcss/index.css") : path.join(ROOT, "node_modules", id);
      return { path: file, base: path.dirname(file), content: await readFile(file, "utf8") };
    },
  });
  const candidates = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) for (const c of match[1].split(/\s+/)) if (c) candidates.add(c);
  return compiler.build([...candidates]);
}

interface Measured {
  ratio: number;
  fg: string;
  bg: string;
}

/** Computed colours of `selector` within one surface, composited over the backgrounds behind them. */
async function measure(page: Page, surface: string, selector: string, prop: "color" | "borderTopColor" = "color", pseudo?: "::selection") {
  return page.evaluate(
    (surface, selector, prop, pseudo) => {
      const el = document.querySelector(`#${surface} ${selector}`);
      if (!el) throw new Error(`no ${selector} in ${surface}`);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const rgba = (css: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
      let bg = [255, 255, 255, 1];
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
      for (const e of chain) bg = over(rgba(getComputedStyle(e).backgroundColor), bg);
      const style = getComputedStyle(el, pseudo ?? null);
      if (pseudo) {
        const highlight = rgba(style.backgroundColor);
        if (highlight[3] === 0) throw new Error(`${selector} in ${surface} has no explicit selection colour`);
        bg = over(highlight, bg);
      }
      const fg = over(rgba(style[prop as "color"]), bg);
      const lum = ([r, g, b]: number[]) => {
        const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const hex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
      return { ratio: (hi + 0.05) / (lo + 0.05), fg: hex(fg), bg: hex(bg) };
    },
    surface,
    selector,
    prop,
    pseudo
  ) as Promise<Measured>;
}

describe.skipIf(!BROWSER)(`chat run notices in a real browser${BROWSER ? "" : " (skipped: no Chromium or Chrome)"}`, () => {
  let browser: Browser;
  let html: string;

  beforeAll(async () => {
    const markup = SURFACES.map((s) => `<section id="${s.id}" class="bg-background">${renderToStaticMarkup(s.element)}</section>`).join("");
    // The chat column, at the narrowest width the panel reaches on a phone.
    html = `<!doctype html><html><head><style>${await appCss(markup)}</style></head><body><main style="width:320px">${markup}</main></body></html>`;
    browser = await puppeteer.launch({ executablePath: BROWSER!, headless: true, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  for (const scheme of ["light", "dark"] as const) {
    describe(`with the operating system's ${scheme} appearance`, () => {
      let page: Page;
      beforeAll(async () => {
        page = await browser.newPage();
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await page.setContent(html, { waitUntil: "load" });
      });

      for (const surface of SURFACES.filter((s) => s.kind !== "reply")) {
        it(`${surface.id}: text at least 4.5:1, icon and button border at least 3:1, selection readable`, async () => {
          const box = `[data-notice="${surface.kind}"]`;
          const texts = [`${box} p`, ...(surface.id.startsWith("error") || surface.id === "invalid-input" ? [] : [`${box} .font-medium`])];
          for (const text of texts) {
            const m = await measure(page, surface.id, text);
            expect(m.ratio, `${text} ${m.fg} on ${m.bg}`).toBeGreaterThanOrEqual(4.5);
            const selected = await measure(page, surface.id, text, "color", "::selection");
            expect(selected.ratio, `selected ${text} ${selected.fg} on ${selected.bg}`).toBeGreaterThanOrEqual(4.5);
          }
          const icon = await measure(page, surface.id, `${box} svg`);
          expect(icon.ratio, `icon ${icon.fg} on ${icon.bg}`).toBeGreaterThanOrEqual(3);
          if (await page.$(`#${surface.id} button`)) {
            const label = await measure(page, surface.id, "button");
            expect(label.ratio).toBeGreaterThanOrEqual(4.5);
            const border = await measure(page, surface.id, "button", "borderTopColor");
            expect(border.ratio, `button border ${border.fg} on ${border.bg}`).toBeGreaterThanOrEqual(3);
          }
        });
      }

      it("draws the same colours as the light appearance, because the app has one light theme", async () => {
        const colours = await page.evaluate(() =>
          [...document.querySelectorAll("[data-notice], [data-notice] *")].map((e) => {
            const s = getComputedStyle(e);
            return [s.color, s.backgroundColor, s.borderTopColor].join(" ");
          })
        );
        const light = await browser.newPage();
        await light.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await light.setContent(html, { waitUntil: "load" });
        const lightColours = await light.evaluate(() =>
          [...document.querySelectorAll("[data-notice], [data-notice] *")].map((e) => {
            const s = getComputedStyle(e);
            return [s.color, s.backgroundColor, s.borderTopColor].join(" ");
          })
        );
        await light.close();
        expect(colours).toEqual(lightColours);
      });

      it("wraps long notices inside a 320 px chat column", async () => {
        const overflow = await page.evaluate(() =>
          [...document.querySelectorAll("[data-notice]")]
            .filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > 321)
            .map((e) => e.parentElement?.id)
        );
        expect(overflow).toEqual([]);
      });

      it("leaves an ordinary assistant reply as it was", async () => {
        const reply = await measure(page, "reply", ".whitespace-pre-wrap");
        expect(reply).toMatchObject({ fg: "#1c1b29" });
        expect(reply.ratio).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});
