"use client";

import { useEffect } from "react";
import { googleFontsUrl } from "@/lib/slide-html";

/**
 * Loads Google Fonts families into this page so a brand's fonts can be shown
 * in their own typeface (specimens, previews). Each family's stylesheet is
 * added once per page and never removed; the app's Content-Security-Policy
 * already allows Google Fonts stylesheets and files. Families that are not on
 * Google Fonts (an uploaded font) simply fall back to the next font in the stack.
 */
export function useGoogleFonts(families: readonly string[]): void {
  const key = families.filter(Boolean).join("|");
  useEffect(() => {
    for (const family of key.split("|").filter(Boolean)) {
      const href = googleFontsUrl(family);
      if (document.head.querySelector(`link[data-font-family="${CSS.escape(family)}"]`)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.fontFamily = family;
      document.head.appendChild(link);
    }
  }, [key]);
}
