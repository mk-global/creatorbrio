import type { NextConfig } from "next";

/** The app's Content-Security-Policy, with the font sources a page may use. */
export function contentSecurityPolicy(fontSources: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `font-src ${fontSources.join(" ")}`,
    "img-src 'self' data: blob: https:",
    "frame-src 'self' blob:",
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
  ].join("; ");
}

export const APP_FONT_SOURCES = ["'self'", "https://fonts.gstatic.com"] as const;

/**
 * The Video Studio page (#150) shows the caption and graphics overlay in an
 * `<iframe sandbox="" srcdoc>`, which inherits this page's policy; the overlay
 * carries its bundled fonts as `data:` URLs, so only this page also allows
 * `data:` fonts. Every other page keeps the policy above unchanged. The two
 * rules match disjoint paths: two policies on one response would both apply,
 * so the Studio rule could not widen anything.
 */
export const STUDIO_FONT_SOURCES = [...APP_FONT_SOURCES, "data:"] as const;

/** Every path except `/studio` and below it. */
export const APP_PAGES_SOURCE = "/((?!studio(?:/|$)).*)";
export const STUDIO_PAGES_SOURCE = "/studio/:path*";

const nextConfig: NextConfig = {
  // The development indicator would sit over the app shell in every corner
  // (the sidebar footer, the editor rail's Settings button, the phone tab bar
  // or the headers), and people run CreatorBrio with `npm run dev`. Off, Next.js
  // still shows compile and runtime errors (#177).
  devIndicators: false,
  serverExternalPackages: ["sharp", "archiver", "puppeteer"],
  async headers() {
    return [
      { source: APP_PAGES_SOURCE, headers: [{ key: "Content-Security-Policy", value: contentSecurityPolicy(APP_FONT_SOURCES) }] },
      { source: STUDIO_PAGES_SOURCE, headers: [{ key: "Content-Security-Policy", value: contentSecurityPolicy(STUDIO_FONT_SOURCES) }] },
    ];
  },
};

export default nextConfig;
