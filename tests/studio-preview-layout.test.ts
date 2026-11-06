/**
 * Where the Studio preview draws (#150): the canvas fitted into the panel
 * with letterboxing, and picture boxes from `layerBox()` times that scale.
 * Overlay visibility, the frame the overlay holds, media readiness and the
 * compiler issues in plain words are here too: all pure decisions the
 * preview's components only render.
 */
import { describe, expect, it } from "vitest";

import { layerBox, type CompileIssue } from "@/lib/video/render/plan";
import { fitCanvas, scaledLayerBox } from "@/lib/video/studio/preview-layout";
import { overlayFrameToLoad, overlayVisible } from "@/lib/video/studio/preview-overlay";
import { describeIssues, mediaReadiness } from "@/lib/video/studio/preview-status";
import type { MediaView } from "@/lib/video/studio/types";

describe("fitCanvas", () => {
  it("letterboxes a 9:16 canvas left and right in a wide panel", () => {
    expect(fitCanvas({ width: 800, height: 640 }, { width: 1080, height: 1920 })).toEqual({ scale: 1 / 3, left: 220, top: 0, width: 360, height: 640 });
  });

  it("letterboxes top and bottom in a tall, narrow panel", () => {
    const fit = fitCanvas({ width: 270, height: 600 }, { width: 1080, height: 1920 });
    expect(fit).toEqual({ scale: 0.25, left: 0, top: 60, width: 270, height: 480 });
  });

  it("keeps fractional pixels rather than leave a hairline at the canvas edge", () => {
    const fit = fitCanvas({ width: 1000, height: 700 }, { width: 1080, height: 1920 });
    expect(fit.height).toBe(700);
    expect(fit.width).toBeCloseTo(393.75, 9);
    expect(fit.left).toBeCloseTo(303.125, 9);
  });

  it("draws nothing in a panel with no size yet", () => {
    expect(fitCanvas({ width: 0, height: 500 }, { width: 1080, height: 1920 }).scale).toBe(0);
  });
});

describe("scaledLayerBox", () => {
  it("is layerBox() multiplied by the canvas scale", () => {
    // A landscape source covering a portrait canvas: much wider than the canvas, centred.
    const placement = { scaledWidth: 3413, scaledHeight: 1920, offsetX: 1166, offsetY: 0 };
    const box = layerBox(placement);
    expect(scaledLayerBox(placement, 0.5)).toEqual({ left: box.left * 0.5, top: 0, width: box.width * 0.5, height: 960 });
    expect(scaledLayerBox(placement, 0.5)).toEqual({ left: -583, top: 0, width: 1706.5, height: 960 });
  });
});

describe("overlay visibility", () => {
  const ranges = [
    { startFrame: 0, endFrame: 30 },
    { startFrame: 60, endFrame: 90 },
  ];

  it("shows the overlay only inside its active ranges, [start, end)", () => {
    expect(overlayVisible(ranges, 0)).toBe(true);
    expect(overlayVisible(ranges, 29)).toBe(true);
    expect(overlayVisible(ranges, 30)).toBe(false);
    expect(overlayVisible(ranges, 60)).toBe(true);
    expect(overlayVisible(ranges, 90)).toBe(false);
    expect(overlayVisible([], 0)).toBe(false);
  });

  it("holds the frame shown inside a range and the next range's first frame outside one", () => {
    expect(overlayFrameToLoad(ranges, 12)).toBe(12);
    expect(overlayFrameToLoad(ranges, 30)).toBe(60);
    expect(overlayFrameToLoad(ranges, 45)).toBe(60);
    expect(overlayFrameToLoad(ranges, 90)).toBeNull();
  });
});

const record = (mediaId: string, derived: MediaView["derived"]): MediaView => ({
  mediaId,
  kind: "video",
  originalName: "footage.mov",
  sizeBytes: 1,
  importedAt: "2026-01-01T00:00:00.000Z",
  facts: { kind: "video", container: "mov" },
  provenance: { source: "local-file", rights: "user-supplied" },
  derived,
});

describe("mediaReadiness", () => {
  const media = [
    record("ready", { state: "succeeded", attempts: 1, files: ["proxy.mp4", "poster.jpg", "peaks.json"] }),
    record("running", { state: "running", attempts: 1, files: [] }),
    record("failed", { state: "failed", attempts: 2, files: [], failure: { failureClass: "permanent", code: "x", message: "/Users/someone/secret/path failed" } }),
  ];

  it("is ready once the job succeeded with the file, with a poster where one was made", () => {
    expect(mediaReadiness(media, "ready", "proxy.mp4")).toEqual({ state: "ready", poster: true });
    expect(mediaReadiness(media, "ready", "proxy.m4a")).toEqual({ state: "preparing" });
  });

  it("is preparing while the job runs, missing when unknown, and failed with a short message of its own", () => {
    expect(mediaReadiness(media, "running", "proxy.mp4")).toEqual({ state: "preparing" });
    expect(mediaReadiness(media, "nope", "proxy.mp4")).toEqual({ state: "missing" });
    const failed = mediaReadiness(media, "failed", "proxy.mp4");
    expect(failed.state).toBe("failed");
    // The job's own message can name paths; the preview never shows it.
    expect(failed.state === "failed" && failed.message).not.toContain("/Users");
  });
});

describe("describeIssues", () => {
  const issue = (code: CompileIssue["code"], message: string, clipId?: string): CompileIssue => ({ code, path: "/timeline", message, ...(clipId ? { clipId } : {}) });

  it("treats an empty timeline as a start, not a fault", () => {
    expect(describeIssues([issue("empty_timeline", "the timeline has no clips")]).empty).toBe(true);
  });

  it("lists every other issue in plain words, keeping the clip to select", () => {
    const block = describeIssues([issue("unsupported_feature", "speed changes cannot be exported yet", "c1"), issue("duration_exceeds_profile", "too long.")]);
    expect(block.empty).toBe(false);
    expect(block.lines).toEqual([
      { lead: "A clip uses something the export cannot make yet", detail: "Speed changes cannot be exported yet.", clipId: "c1" },
      { lead: "The production is longer than the export allows", detail: "Too long." },
    ]);
  });
});
