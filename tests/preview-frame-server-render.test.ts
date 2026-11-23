/**
 * A slide preview's policy names the app's origin (#249), which only the
 * browser knows, so no server render may build a preview document or draw a
 * frame: one built there would carry a policy without the origin, or throw.
 * Each component that shows a slide in a preview frame is rendered to HTML as
 * the server renders it, where there is no `window`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SlideRenderer } from "@/components/editor/SlideRenderer";
import { ProjectFrame, SlideFace } from "@/components/library/ProjectFrame";

const SLIDE = `<p style="font-family: 'Inter', sans-serif">Hook</p>`;

describe("slide preview frames on the server (#249)", () => {
  it("runs where there is no window", () => {
    expect(typeof window).toBe("undefined");
  });

  it("the editor's slide renderer draws no frame and builds no document", () => {
    const html = renderToStaticMarkup(createElement(SlideRenderer, { html: SLIDE, aspectRatio: "4:5" }));
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("Content-Security-Policy");
  });

  it("a library slide face draws no frame and builds no document", () => {
    const html = renderToStaticMarkup(createElement(SlideFace, { html: SLIDE, aspectRatio: "4:5" }));
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("Content-Security-Policy");
  });

  it("a library project frame draws no frame and builds no document", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectFrame, { html: SLIDE, slideCount: 3, aspectRatio: "4:5", format: "instagram-carousel" })
    );
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("Content-Security-Policy");
  });
});
