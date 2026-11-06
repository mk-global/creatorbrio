/**
 * The Studio's shared frame arithmetic (#150): timecodes are SMPTE, so a
 * frame count is never mistaken for a fraction of a second, and seconds
 * from gestures round to whole frames.
 */
import { describe, expect, it } from "vitest";

import { formatTimecode, secondsToFrame } from "@/lib/video/studio/frames";

describe("timecodes", () => {
  it("writes hours, minutes, seconds and the frame within the second, separated by colons", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    expect(formatTimecode(135, 30)).toBe("00:00:04:15");
    expect(formatTimecode(30 * 61 + 29, 30)).toBe("00:01:01:29");
    expect(formatTimecode(30 * 3600, 30)).toBe("01:00:00:00");
  });

  it("never shows a negative, fractional or non-finite frame", () => {
    expect(formatTimecode(-4, 30)).toBe("00:00:00:00");
    expect(formatTimecode(44.9, 30)).toBe("00:00:01:14");
    expect(formatTimecode(Number.NaN, 30)).toBe("00:00:00:00");
  });
});

describe("seconds to frames", () => {
  it("rounds to the nearest frame and never goes below zero", () => {
    expect(secondsToFrame(1.49, 30)).toBe(45);
    expect(secondsToFrame(-1, 30)).toBe(0);
    expect(secondsToFrame(Number.POSITIVE_INFINITY, 30)).toBe(0);
  });
});
