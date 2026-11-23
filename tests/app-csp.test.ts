/**
 * The app's Content-Security-Policy headers (#150, #249). The Studio page's
 * overlay iframe and every page's slide previews inherit the page's policy and
 * load their fonts as `data:` URLs, which the earlier policy blocked (a real
 * browser refused them); so every page allows `data:` fonts, and nothing else
 * changed. The two rules must match disjoint paths, because two policies on
 * one response both apply and the narrower would win.
 */
import { describe, expect, it } from "vitest";

import nextConfig, { APP_PAGES_SOURCE, contentSecurityPolicy, STUDIO_PAGES_SOURCE } from "../next.config";

/** The policy the app sent before #150, for every page, and before #249 for every page but the Studio. */
const BEFORE =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; frame-src 'self' blob:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com";

/** `APP_PAGES_SOURCE` is a path-to-regexp source whose only parameter is an unnamed regex group. */
const appPages = new RegExp(`^${APP_PAGES_SOURCE}$`);

describe("the app's Content-Security-Policy", () => {
  it("allows data: fonts on every page but the Studio and changes nothing else there", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(2);
    const app = rules.find((r) => r.source === APP_PAGES_SOURCE)!;
    expect(app.headers).toEqual([{ key: "Content-Security-Policy", value: contentSecurityPolicy(["'self'", "https://fonts.gstatic.com", "data:"]) }]);
    expect(app.headers[0].value.replace(" data:;", ";")).toBe(BEFORE);
  });

  it("allows data: fonts on the Studio page and changes nothing else there", async () => {
    const rules = await nextConfig.headers!();
    const studio = rules.find((r) => r.source === STUDIO_PAGES_SOURCE)!;
    expect(studio.headers).toEqual([{ key: "Content-Security-Policy", value: contentSecurityPolicy(["'self'", "https://fonts.gstatic.com", "data:"]) }]);
    expect(studio.headers[0].value.replace(" data:;", ";")).toBe(BEFORE);
  });

  it("matches the Studio paths with the Studio rule only", () => {
    for (const path of ["/studio", "/studio/", "/studio/anything"]) expect(appPages.test(path), path).toBe(false);
    for (const path of ["/", "/carousel/abc", "/studios", "/studio-x", "/api/video/session", "/uploads/a.png"]) expect(appPages.test(path), path).toBe(true);
  });
});
