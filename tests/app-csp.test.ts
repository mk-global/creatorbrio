/**
 * The app's Content-Security-Policy headers (#150). The Studio page's overlay
 * iframe inherits the page's policy and loads its bundled fonts as `data:`
 * URLs, which the app policy blocks (a real browser refused them); so the
 * Studio page alone also allows `data:` fonts, and every other page keeps
 * the policy it had. The two rules must match disjoint paths, because two
 * policies on one response both apply and the narrower would win.
 */
import { describe, expect, it } from "vitest";

import nextConfig, { APP_PAGES_SOURCE, contentSecurityPolicy, STUDIO_PAGES_SOURCE } from "../next.config";

/** The policy the app sent before #150, for every page. */
const BEFORE =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; frame-src 'self' blob:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com";

/** `APP_PAGES_SOURCE` is a path-to-regexp source whose only parameter is an unnamed regex group. */
const appPages = new RegExp(`^${APP_PAGES_SOURCE}$`);

describe("the app's Content-Security-Policy", () => {
  it("is unchanged for every page but the Studio", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(2);
    const app = rules.find((r) => r.source === APP_PAGES_SOURCE)!;
    expect(app.headers).toEqual([{ key: "Content-Security-Policy", value: BEFORE }]);
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
