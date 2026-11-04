import { describe, expect, it } from "vitest";
import { validateVideoProduction } from "../src/lib/video/schema";
import type { VideoProduction } from "../src/types/video";

const SOURCE = "a".repeat(64);
const MEDIA_B = "b".repeat(64);

function fixture(workflow: VideoProduction["workflow"] = "footage"): VideoProduction {
  return {
    schemaVersion: 2,
    id: "production-1",
    name: "Real creator video",
    brandId: "brand-1",
    workflow,
    usageIntent: "commercial",
    revision: 0,
    stage: "storyboard",
    format: {
      width: 1080, height: 1920, fps: 30,
      platform: "instagram-reel", maxDurationMs: 90_000,
    },
    media: [
      { mediaId: SOURCE, role: "a-roll", label: "Original camera footage" },
      { mediaId: MEDIA_B, role: "voice", label: "Narration" },
    ],
    script: {
      origin: workflow === "footage" ? "transcribed" : "written",
      status: "approved",
      lines: [{ id: "line-1", speaker: workflow === "footage" ? "on-camera" : "narrator", text: "Hello world" }],
    },
    storyboard: {
      id: "board-1", status: "draft",
      scenes: [{
        id: "scene-1", title: "Hook", status: "approved",
        lineIds: ["line-1"], realizationClipIds: ["clip-1"],
      }],
    },
    speechSpine: {
      kind: workflow === "footage" ? "recorded" : "narrated",
      sourceMediaId: workflow === "footage" ? SOURCE : MEDIA_B,
      words: [{ id: "word-1", text: "Hello", startUs: 0, endUs: 400_000 }],
    },
    timeline: {
      tracks: [{
        id: "track-1", kind: "video",
        clips: [{
          kind: "video", id: "clip-1", sceneId: "scene-1",
          start: 0, duration: 90,
          source: { mediaId: SOURCE, inUs: 0, outUs: 3_000_000 },
        }],
      }],
    },
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
}

function failures(input: unknown): string[] {
  const result = validateVideoProduction(input);
  expect(result.ok).toBe(false);
  return result.problems.map((p) => `${p.path}: ${p.code}`);
}

describe("Video Studio Production v2 admission", () => {
  it.each(["footage", "script", "hybrid"] as const)(
    "accepts a valid %s production without mutation",
    (workflow) => {
      const input = fixture(workflow);
      const original = structuredClone(input);
      const result = validateVideoProduction(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(original);
        expect(result.value.schemaVersion).toBe(2);
      }
      expect(input).toEqual(original);
    }
  );

  it("supports storyboard proposals before media exists", () => {
    const input = fixture("script");
    input.media = [];
    input.storyboard!.scenes[0]!.realizationClipIds = [];
    input.timeline.tracks = [];
    input.speechSpine = null;
    expect(validateVideoProduction(input).ok).toBe(true);
  });

  it("refuses missing and unsupported schema versions", () => {
    const input = fixture() as unknown as Record<string, unknown>;
    input.schemaVersion = 1;
    expect(failures(input)).toContain("schemaVersion: invalid_value");
    delete input.schemaVersion;
    expect(failures(input)).toContain("schemaVersion: invalid_value");
  });

  it("refuses media references that are not full SHA-256 hashes", () => {
    const input = fixture();
    input.media[0]!.mediaId = "../invalid";
    expect(failures(input)).toContain("media[0].mediaId: invalid_value");
  });

  it("refuses source clips referencing missing media", () => {
    const input = fixture();
    const clip = input.timeline.tracks[0]!.clips[0]!;
    if (clip.kind !== "graphic") clip.source.mediaId = "c".repeat(64);
    expect(failures(input)).toContain("timeline.tracks[0].clips[0].source.mediaId: missing_reference");
  });

  it("refuses overlapping IDs across different timeline tracks", () => {
    const input = fixture();
    input.timeline.tracks.push({
      id: "track-2", kind: "video", clips: [{
        kind: "video", id: "clip-1", start: 95, duration: 20,
        source: { mediaId: SOURCE, inUs: 0, outUs: 1_000_000 },
      }],
    });
    expect(failures(input)).toContain("timeline.tracks[1].clips[0].id: duplicate_id");
  });

  it("refuses zero, negative and fractional frame positions or durations", () => {
    const input = fixture();
    input.timeline.tracks[0]!.clips[0]!.start = -1;
    input.timeline.tracks[0]!.clips[0]!.duration = 0;
    expect(failures(input)).toEqual(expect.arrayContaining([
      "timeline.tracks[0].clips[0].start: invalid_value",
      "timeline.tracks[0].clips[0].duration: invalid_value",
    ]));
    input.timeline.tracks[0]!.clips[0]!.start = 1.5;
    expect(failures(input)).toContain("timeline.tracks[0].clips[0].start: invalid_value");
  });

  it("refuses clips extending past the output duration", () => {
    const input = fixture();
    input.timeline.tracks[0]!.clips[0]!.start = 2690;
    input.timeline.tracks[0]!.clips[0]!.duration = 20;
    expect(failures(input)).toContain("timeline.tracks[0].clips[0].duration: invalid_value");
  });

  it("refuses zero-length or reversed source microsecond ranges", () => {
    const input = fixture();
    const clip = input.timeline.tracks[0]!.clips[0]!;
    if (clip.kind !== "graphic") clip.source.outUs = clip.source.inUs;
    expect(failures(input)).toContain("timeline.tracks[0].clips[0].source.outUs: invalid_value");
  });

  it("refuses missing storyboard scene or script-line references", () => {
    const input = fixture();
    input.storyboard!.scenes[0]!.lineIds = ["missing"];
    input.timeline.tracks[0]!.clips[0]!.sceneId = "missing";
    expect(failures(input)).toEqual(expect.arrayContaining([
      "storyboard.scenes[0].lineIds[0]: missing_reference",
      "timeline.tracks[0].clips[0].sceneId: missing_reference",
    ]));
  });

  it("refuses a storyboard realization pointing at a nonexistent clip", () => {
    const input = fixture();
    input.storyboard!.scenes[0]!.realizationClipIds = ["missing"];
    expect(failures(input)).toContain(
      "storyboard.scenes[0].realizationClipIds[0]: missing_reference"
    );
  });

  it("rejects malformed unknown JSON and preserves the original input", () => {
    const input: unknown = {
      ...fixture(),
      format: { width: "bad", height: -1, fps: 29, platform: "bad", maxDurationMs: 0 },
      timeline: { tracks: [{ id: "one", kind: "video", clips: [{ bad: true }] }] },
    };
    const original = structuredClone(input);
    const result = validateVideoProduction(input);
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(3);
    expect(input).toEqual(original);
    expect(failures(null)).toContain("$: invalid_type");
  });

  it("accepts an unmaterialized illustration scene without footage or narrator", () => {
    const input = fixture("script");
    input.media = [];
    input.speechSpine = null;
    input.timeline.tracks = [];
    input.storyboard!.scenes[0]!.realizationClipIds = [];
    expect(validateVideoProduction(input).ok).toBe(true);
  });
});
