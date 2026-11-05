import { describe, it, expect } from "vitest";

import {
  durationMatchesSourceSpan,
  framesToMs,
  framesToSourceSpanUs,
  isFrameRate,
  maxTimelineFrames,
  msToFrames,
  sourceSpanToExactFrames,
  sourceSpanToFrames,
} from "@/lib/video/production";
import { FRAME_RATES } from "@/types/production";

describe("the production time model", () => {
  it("knows exactly the four supported frame rates", () => {
    for (const fps of FRAME_RATES) expect(isFrameRate(fps)).toBe(true);
    for (const fps of [29.97, 23.976, 50, "30", null]) expect(isFrameRate(fps)).toBe(false);
  });

  it("converts whole seconds of source exactly at every frame rate", () => {
    for (const fps of FRAME_RATES) {
      expect(sourceSpanToFrames(0, 1_000_000, fps)).toBe(fps);
      expect(sourceSpanToFrames(5_000_000, 7_000_000, fps)).toBe(2 * fps);
      expect(framesToSourceSpanUs(fps, fps)).toBe(1_000_000);
    }
  });

  it("scales by constant playback speed", () => {
    expect(sourceSpanToFrames(0, 1_000_000, 30, 2)).toBe(15);
    expect(sourceSpanToFrames(0, 1_000_000, 30, 0.5)).toBe(60);
    expect(framesToSourceSpanUs(15, 30, 2)).toBe(1_000_000);
  });

  it("round-trips frames through source microseconds without drift", () => {
    for (const fps of FRAME_RATES) {
      for (const frames of [1, 7, 29, 1_000, 123_457]) {
        const us = framesToSourceSpanUs(frames, fps);
        expect(sourceSpanToFrames(0, us, fps)).toBe(frames);
        expect(sourceSpanToFrames(10_000_000, 10_000_000 + us, fps)).toBe(frames);
      }
    }
  });

  it("accepts the duration nearest to the source span, within half a frame", () => {
    expect(sourceSpanToExactFrames(0, 1_016_666, 30)).toBeCloseTo(30.49998, 4);
    expect(durationMatchesSourceSpan(30, 0, 1_016_666, 30)).toBe(true);
    expect(durationMatchesSourceSpan(31, 0, 1_016_666, 30)).toBe(false);
    expect(durationMatchesSourceSpan(31, 0, 1_016_667, 30)).toBe(true);
    expect(durationMatchesSourceSpan(30, 0, 1_016_667, 30)).toBe(false);
    expect(durationMatchesSourceSpan(29, 0, 1_016_666, 30)).toBe(false);
  });

  it("converts between frames and milliseconds", () => {
    expect(framesToMs(30, 30)).toBe(1_000);
    expect(framesToMs(24, 24)).toBe(1_000);
    expect(msToFrames(1_000, 25)).toBe(25);
    expect(msToFrames(1_020, 25)).toBe(26);
  });

  it("caps the timeline at four hours at each frame rate", () => {
    expect(maxTimelineFrames(30)).toBe(4 * 3600 * 30);
    expect(maxTimelineFrames(60)).toBe(4 * 3600 * 60);
    expect(Number.isSafeInteger(maxTimelineFrames(60))).toBe(true);
  });
});
