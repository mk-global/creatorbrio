import { describe, expect, it } from "vitest";

import type { CaptionCue } from "@/lib/video/render/plan";
import { toSrt, toVtt } from "@/lib/video/render/sidecars";

const cue = (startFrame: number, endFrame: number, text: string): CaptionCue => ({ clipId: "cap", startFrame, endFrame, text });

describe("SRT", () => {
  it("numbers cues and writes comma-separated millisecond times", () => {
    expect(toSrt([cue(0, 45, "Agents loop"), cue(45, 90, "Plan, then act")], 30)).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nAgents loop\n\n2\n00:00:01,500 --> 00:00:03,000\nPlan, then act\n\n"
    );
  });

  it("rounds frames to the nearest millisecond", () => {
    // At 24 fps frame 1 is 41.67 ms and frame 2 is 83.33 ms; at 60 fps frame 1 is 16.67 ms.
    expect(toSrt([cue(1, 2, "a")], 24)).toBe("1\n00:00:00,042 --> 00:00:00,083\na\n\n");
    expect(toSrt([cue(1, 3, "a")], 60)).toBe("1\n00:00:00,017 --> 00:00:00,050\na\n\n");
  });

  it("writes hours, minutes and seconds", () => {
    const at = 25 * (3 * 3600 + 25 * 60 + 7) + 12; // 3:25:07 and 12 frames (480 ms) at 25 fps
    expect(toSrt([cue(at, at + 25, "late")], 25)).toBe("1\n03:25:07,480 --> 03:25:08,480\nlate\n\n");
  });

  it("keeps line breaks, drops blank lines and leaves markup alone but neutralises arrows", () => {
    expect(toSrt([cue(0, 30, "one\r\n\r\ntwo\rthree\n   \n<b>&</b> --> ---> ->")], 30)).toBe(
      "1\n00:00:00,000 --> 00:00:01,000\none\ntwo\nthree\n<b>&</b> -> -> ->\n\n"
    );
  });

  it("is empty with no cues", () => {
    expect(toSrt([], 30)).toBe("");
  });
});

describe("WebVTT", () => {
  it("writes the header and dot-separated times", () => {
    expect(toVtt([cue(0, 45, "Agents loop"), cue(45, 90, "Plan, then act")], 30)).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nAgents loop\n\n00:00:01.500 --> 00:00:03.000\nPlan, then act\n"
    );
  });

  it("escapes markup characters, which also neutralises an arrow in the text", () => {
    expect(toVtt([cue(0, 30, "<script>alert(1)</script> & 'quotes' -->\n\n00:00:09.000 --> 00:00:10.000")], 30)).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n&lt;script&gt;alert(1)&lt;/script&gt; &amp; 'quotes' --&gt;\n00:00:09.000 --&gt; 00:00:10.000\n"
    );
  });

  it("writes hours past one and rounds like SRT", () => {
    expect(toVtt([cue(24 * 3661 + 1, 24 * 3661 + 2, "x")], 24)).toBe("WEBVTT\n\n01:01:01.042 --> 01:01:01.083\nx\n");
  });

  it("is just the header with no cues", () => {
    expect(toVtt([], 30)).toBe("WEBVTT\n");
  });
});
