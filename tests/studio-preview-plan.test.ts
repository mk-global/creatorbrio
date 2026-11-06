/**
 * What the Studio preview plays at a frame (#150): one element per clip from
 * the compiled plan, picture and its own sound on one element, sound-only
 * clips on an audio element of the right proxy, active and preloaded clips,
 * the media time the playhead asks for, volume from the gain envelope, and
 * how each element is brought to the playhead.
 */
import { describe, expect, it } from "vitest";

import type { AudioSource, RenderPlan, VideoLayer } from "@/lib/video/render/plan";
import { HARD_SYNC_S } from "@/lib/video/studio/playhead";
import {
  activeAt,
  boostsAboveUnity,
  elementTarget,
  MAX_START_LEAD_S,
  mountedAt,
  nextStartLead,
  previewElements,
  startsWithin,
  syncAction,
  targetMediaSeconds,
  volumeAt,
  type SyncInput,
} from "@/lib/video/studio/preview-plan";

const placement = { scaledWidth: 1080, scaledHeight: 1920, offsetX: 0, offsetY: 0 };

const layer = (clipId: string, trackIndex: number, startFrame: number, durationFrames: number, extra: Partial<VideoLayer> = {}): VideoLayer => ({
  clipId,
  trackId: `t${trackIndex}`,
  trackIndex,
  kind: "video",
  mediaId: "m-footage",
  startFrame,
  durationFrames,
  sourceInUs: 0,
  placement,
  ...extra,
});

const sound = (clipId: string, mediaId: string, startFrame: number, durationFrames: number, extra: Partial<AudioSource> = {}): AudioSource => ({
  clipId,
  trackId: "t-sound",
  role: "voice",
  mediaId,
  startFrame,
  durationFrames,
  sourceInUs: 0,
  envelope: [
    { atUs: Math.round((startFrame * 1e6) / 30), gain: 1 },
    { atUs: Math.round(((startFrame + durationFrames) * 1e6) / 30), gain: 1 },
  ],
  ...extra,
});

const inputs: RenderPlan["inputs"] = [
  { mediaId: "m-footage", kind: "video", rotation: 0, dynamicRange: "sdr", hasAudio: true },
  { mediaId: "m-still", kind: "image", rotation: 0, dynamicRange: "sdr", hasAudio: false },
  { mediaId: "m-music", kind: "audio", rotation: 0, dynamicRange: "sdr", hasAudio: true },
];

describe("previewElements", () => {
  it("gives each clip one element: video with its own sound, a still, music, and a hidden track's sound", () => {
    const plan = {
      inputs,
      // Listed out of track order on purpose: the preview draws bottom to top.
      video: [
        layer("still", 1, 0, 60, { kind: "still", mediaId: "m-still", sourceInUs: undefined }),
        layer("a1", 0, 0, 90, { sourceInUs: 2_000_000 }),
        layer("a2", 0, 90, 60, { sourceInUs: 500_000 }),
      ],
      audio: [sound("a1", "m-footage", 0, 90, { sourceInUs: 2_000_000 }), sound("music", "m-music", 0, 150, { role: "music" }), sound("hidden", "m-footage", 0, 30)],
    };
    const elements = previewElements(plan);
    expect(elements.map((e) => [e.clipId, e.tag, e.file, e.sound?.clipId ?? null])).toEqual([
      ["a1", "video", "proxy.mp4", "a1"],
      // No sound in the plan for this clip: its element is muted.
      ["a2", "video", "proxy.mp4", null],
      ["still", "img", "proxy.png", null],
      ["music", "audio", "proxy.m4a", "music"],
      // A video clip's sound with no picture layer reads the video proxy, since video media has no proxy.m4a.
      ["hidden", "audio", "proxy.mp4", "hidden"],
    ]);
    expect(elements.find((e) => e.clipId === "still")!.sourceInUs).toBeUndefined();
    expect(elements.find((e) => e.clipId === "a1")!.sourceInUs).toBe(2_000_000);
  });
});

describe("activeAt and mountedAt", () => {
  const plan = { inputs, video: [layer("a1", 0, 0, 90), layer("a2", 0, 90, 60), layer("a3", 0, 300, 30)], audio: [] };
  const elements = previewElements(plan);

  it("treats a clip's frames as [start, start + duration)", () => {
    expect(activeAt(elements[0], 0)).toBe(true);
    expect(activeAt(elements[0], 89)).toBe(true);
    expect(activeAt(elements[0], 90)).toBe(false);
    expect(activeAt(elements[1], 90)).toBe(true);
  });

  it("keeps the active clip and those starting within two seconds ahead", () => {
    expect(mountedAt(elements, 0, 30).map((e) => e.clipId)).toEqual(["a1"]);
    expect(mountedAt(elements, 30, 30).map((e) => e.clipId)).toEqual(["a1", "a2"]);
    expect(mountedAt(elements, 89, 30).map((e) => e.clipId)).toEqual(["a1", "a2"]);
    expect(mountedAt(elements, 100, 30).map((e) => e.clipId)).toEqual(["a2"]);
    // a3 starts at 300: mounted from frame 240 (two seconds before) on.
    expect(mountedAt(elements, 239, 30).map((e) => e.clipId)).toEqual([]);
    expect(mountedAt(elements, 240, 30).map((e) => e.clipId)).toEqual(["a3"]);
  });
});

describe("targetMediaSeconds and elementTarget", () => {
  const [a2] = previewElements({ inputs, video: [layer("a2", 0, 90, 60, { sourceInUs: 500_000 })], audio: [] });

  it("maps timeline seconds into the clip's source: sourceIn + (seconds - start / fps)", () => {
    expect(targetMediaSeconds(a2, 3, 30)).toBeCloseTo(0.5, 9);
    expect(targetMediaSeconds(a2, 4.25, 30)).toBeCloseTo(1.75, 9);
  });

  it("waits at the clip's first source frame while it is not on the playhead", () => {
    expect(elementTarget(a2, 80, 80 / 30, 30)).toBe(0.5);
    expect(elementTarget(a2, 120, 4, 30)).toBeCloseTo(1.5, 9);
  });

  it("gives stills no media time", () => {
    const [still] = previewElements({ inputs, video: [layer("s", 1, 0, 30, { kind: "still", mediaId: "m-still", sourceInUs: undefined })], audio: [] });
    expect(targetMediaSeconds(still, 0.5, 30)).toBe(0);
  });
});

describe("volumeAt", () => {
  const envelope = [
    { atUs: 1_000_000, gain: 0 },
    { atUs: 2_000_000, gain: 1 },
    { atUs: 3_000_000, gain: 0.25 },
  ];

  it("follows the envelope in absolute timeline time and is silent outside it", () => {
    expect(volumeAt(envelope, 0.5)).toBe(0);
    expect(volumeAt(envelope, 1.5)).toBeCloseTo(0.5, 9);
    expect(volumeAt(envelope, 2)).toBe(1);
    expect(volumeAt(envelope, 3)).toBe(0.25);
    expect(volumeAt(envelope, 3.5)).toBe(0);
  });

  it("clamps a boost above unity to the 1 a media element allows, and says so", () => {
    const boosted = [
      { atUs: 0, gain: 2 },
      { atUs: 1_000_000, gain: 2 },
    ];
    expect(volumeAt(boosted, 0.5)).toBe(1);
    expect(boostsAboveUnity(boosted)).toBe(true);
    expect(boostsAboveUnity(envelope)).toBe(false);
  });
});

describe("syncAction", () => {
  const base: SyncInput = { elementSeconds: 1, targetSeconds: 1, active: true, playing: true, elementPaused: false, startsSoon: false, startLeadSeconds: 0.05, settling: false };

  it("pauses an element whose clip is not on the playhead and holds it at its first frame", () => {
    expect(syncAction({ ...base, active: false, targetSeconds: 0.5 })).toEqual({ seekTo: 0.5, rate: 1, play: false, pause: true });
    expect(syncAction({ ...base, active: false, elementPaused: true, elementSeconds: 0.5, targetSeconds: 0.5 })).toEqual({ seekTo: null, rate: 1, play: false, pause: false });
  });

  it("holds an element at exactly the target while the playhead is paused", () => {
    expect(syncAction({ ...base, playing: false, elementSeconds: 1.02 })).toEqual({ seekTo: 1, rate: 1, play: false, pause: true });
    expect(syncAction({ ...base, playing: false, elementPaused: true, elementSeconds: 1.0005 })).toEqual({ seekTo: null, rate: 1, play: false, pause: false });
  });

  it("starts the next clip from its first frame one start lead before its cut, and leaves it running", () => {
    const waiting = { ...base, active: false, startsSoon: true, elementPaused: true, elementSeconds: 0.5, targetSeconds: 0.5 };
    expect(syncAction(waiting)).toEqual({ seekTo: null, rate: 1, play: true, pause: false });
    // Already running towards the cut: not pulled back to its first frame.
    expect(syncAction({ ...waiting, elementPaused: false, elementSeconds: 0.53 })).toEqual({ seekTo: null, rate: 1, play: false, pause: false });
    // Not about to start: it waits, paused.
    expect(syncAction({ ...waiting, startsSoon: false, elementPaused: false, elementSeconds: 0.53 })).toEqual({ seekTo: 0.5, rate: 1, play: false, pause: true });
  });

  it("starts a paused element that should be playing one start lead ahead of its target", () => {
    expect(syncAction({ ...base, elementPaused: true, elementSeconds: 0.9 })).toEqual({ seekTo: 1.05, rate: 1, play: true, pause: false });
    expect(syncAction({ ...base, elementPaused: true, elementSeconds: 1.05 })).toEqual({ seekTo: null, rate: 1, play: true, pause: false });
  });

  it("closes small drift by rate and large drift by seeking, using the shared correction", () => {
    expect(syncAction({ ...base, elementSeconds: 0.96 })).toEqual({ seekTo: null, rate: 1.05, play: false, pause: false });
    expect(syncAction({ ...base, elementSeconds: 1.04 })).toEqual({ seekTo: null, rate: 0.95, play: false, pause: false });
    expect(syncAction({ ...base, elementSeconds: 1.004 })).toEqual({ seekTo: null, rate: 1, play: false, pause: false });
    expect(syncAction({ ...base, elementSeconds: 1 + HARD_SYNC_S + 0.01 })).toEqual({ seekTo: 1, rate: 1, play: false, pause: false });
  });

  it("leaves a settling start's small drift alone, so it can be measured, but still seeks a large one", () => {
    expect(syncAction({ ...base, settling: true, elementSeconds: 0.96 })).toEqual({ seekTo: null, rate: 1, play: false, pause: false });
    expect(syncAction({ ...base, settling: true, elementSeconds: 1 - HARD_SYNC_S - 0.01 })).toEqual({ seekTo: 1, rate: 1, play: false, pause: false });
  });
});

describe("startsWithin and nextStartLead", () => {
  it("is true only before the clip's first frame and within the lead", () => {
    expect(startsWithin({ startFrame: 90 }, 2.96, 30, 0.05)).toBe(true);
    expect(startsWithin({ startFrame: 90 }, 2.9, 30, 0.05)).toBe(false);
    expect(startsWithin({ startFrame: 90 }, 3, 30, 0.05)).toBe(false);
  });

  it("grows the lead after a late start and shrinks it after an early one, by half the error, within bounds", () => {
    expect(nextStartLead(0.05, -0.04)).toBeCloseTo(0.07, 9);
    expect(nextStartLead(0.05, 0.02)).toBeCloseTo(0.04, 9);
    expect(nextStartLead(0.05, -1)).toBe(MAX_START_LEAD_S);
    expect(nextStartLead(0.01, 0.5)).toBe(0);
    expect(nextStartLead(0.05, Number.NaN)).toBe(0.05);
  });
});
