import { describe, expect, it } from "vitest";

import type { CapabilityCatalog, CapabilityDefinition, ParseResult } from "@/lib/video/capabilities/types";
import type { MediaFacts } from "@/lib/video/media/facts";
import type { MediaRecord } from "@/lib/video/media/registry";
import { admitProduction } from "@/lib/video/production";
import { gainAt } from "@/lib/video/render/audio-envelope";
import { compile } from "@/lib/video/render/compile";
import { coverPlacement, displaySize } from "@/lib/video/render/placement";
import { layerBox, type CompileIssue, type RenderPlan } from "@/lib/video/render/plan";
import { INSTAGRAM_PROFILE, type ExportProfile } from "@/lib/video/render/profile";
import type { AudioClip, GraphicsClip, JsonValue, Production, StillClip, Track, VideoClip } from "@/types/production";
import { footageProduction, MEDIA, scriptProduction } from "./helpers/production-fixtures";

// ---------------------------------------------------------------------------
// A fake catalog: the real one is built separately and has its own tests.

interface Cue {
  startFrame: number;
  endFrame: number;
  text: string;
}

const isObject = (v: JsonValue): v is { [key: string]: JsonValue } => typeof v === "object" && v !== null && !Array.isArray(v);

const testCaptions: CapabilityDefinition<{ cues: Cue[] }> = {
  id: "captions.test-cues",
  version: "1.0.0",
  kind: "captions",
  describe: "Test captions.",
  parse(params): ParseResult<{ cues: Cue[] }> {
    if (!isObject(params) || !Array.isArray(params.cues)) return { ok: false, issues: [{ path: "/cues", message: "expected a list of cues" }] };
    const issues: { path: string; message: string }[] = [];
    params.cues.forEach((cue, i) => {
      if (!isObject(cue) || typeof cue.text !== "string" || cue.text.length === 0) issues.push({ path: `/cues/${i}/text`, message: "expected text" });
    });
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: params as unknown as { cues: Cue[] } };
  },
  captionCues: (p) => p.cues,
  emit: () => ({ css: "", html: "" }),
};

const testLowerThird: CapabilityDefinition<{ name: string }> = {
  id: "graphic.test-lower-third",
  version: "1.0.0",
  kind: "graphic",
  describe: "Test lower third.",
  parse(params, clip) {
    if (!isObject(params) || typeof params.name !== "string") return { ok: false, issues: [{ path: "/name", message: "expected a name" }] };
    if (clip.durationFrames < 2) return { ok: false, issues: [{ path: "", message: "too short" }] };
    return { ok: true, value: { name: params.name } };
  },
  emit: () => ({ css: "", html: "" }),
};

const cuelessCaptions: CapabilityDefinition<null> = {
  id: "captions.no-cues",
  version: "1.0.0",
  kind: "captions",
  describe: "Captions that forgot their cues.",
  parse: () => ({ ok: true, value: null }),
  emit: () => ({ css: "", html: "" }),
};

const DEFINITIONS = [testCaptions, testLowerThird, cuelessCaptions] as CapabilityDefinition[];
const catalog: CapabilityCatalog = {
  get: (id, version) => DEFINITIONS.find((d) => d.id === id && d.version === version),
  list: () => DEFINITIONS,
};

// ---------------------------------------------------------------------------
// Media records

const picture = (width: number, height: number, rotation: 0 | 90 | 180 | 270 = 0) => ({
  codec: "h264",
  width,
  height,
  rotation,
  frameRate: { num: 30, den: 1 },
  variableFrameRate: false,
  pixelFormat: "yuv420p",
  bitDepth: 8,
  color: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
  dynamicRange: "sdr" as const,
});
const sound = { codec: "aac", sampleRate: 48000, channels: 2 };

function record(mediaId: string, facts: MediaFacts): MediaRecord {
  return {
    version: 1,
    mediaId,
    kind: facts.kind,
    originalName: "fixture.bin",
    extension: ".bin",
    sizeBytes: 1,
    importedAt: "2026-11-06T00:00:00.000Z",
    facts,
    provenance: { source: "local-file", rights: "user-supplied" },
  };
}

const RECORDS = {
  // Phone footage: coded landscape, turned upright by a 90 degree rotation.
  aRoll: record(MEDIA.aRoll, { kind: "video", container: "mov,mp4", durationUs: 60_000_000, video: picture(1920, 1080, 90), audio: sound }),
  bRoll: record(MEDIA.bRoll, { kind: "video", container: "mov,mp4", durationUs: 10_000_000, video: picture(1920, 1080), audio: sound }),
  music: record(MEDIA.music, { kind: "audio", container: "mp3", durationUs: 120_000_000, audio: sound }),
  logo: record(MEDIA.logo, { kind: "image", container: "png_pipe", video: { ...picture(1000, 1000), codec: "png" } }),
};
const registry = (...records: MediaRecord[]) => new Map(records.map((r) => [r.mediaId, r]));
const ALL_MEDIA = registry(...Object.values(RECORDS));

// ---------------------------------------------------------------------------
// The golden production

const prov = { by: "user" as const, changeSetId: "cs-1" };
const vclip = (id: string, start: number, duration: number, mediaId: string, inUs: number, outUs: number, extra: Partial<VideoClip> = {}): VideoClip => ({
  kind: "video",
  id,
  start,
  duration,
  source: { mediaId, inUs, outUs },
  provenance: prov,
  ...extra,
});
const aclip = (id: string, start: number, duration: number, mediaId: string, inUs: number, outUs: number, extra: Partial<AudioClip> = {}): AudioClip => ({
  kind: "audio",
  id,
  start,
  duration,
  source: { mediaId, inUs, outUs },
  gainDb: [],
  provenance: prov,
  ...extra,
});
const gclip = (id: string, start: number, duration: number, capability: GraphicsClip["capability"], extra: Partial<GraphicsClip> = {}): GraphicsClip => ({
  kind: "graphics",
  id,
  start,
  duration,
  capability,
  layer: "front",
  provenance: prov,
  ...extra,
});
const sclip = (id: string, start: number, duration: number, mediaId: string, extra: Partial<StillClip> = {}): StillClip => ({
  kind: "still",
  id,
  start,
  duration,
  mediaId,
  provenance: prov,
  ...extra,
});

const CAPTION_PARAMS: JsonValue = {
  cues: [
    { startFrame: 0, endFrame: 30, text: "Agents loop" },
    { startFrame: 30, endFrame: 60, text: "<b>plan & act</b>" },
    { startFrame: 90, endFrame: 200, text: "clipped at the clip's end" },
    { startFrame: 200, endFrame: 210, text: "outside the clip" },
  ],
};

/**
 * Two a-roll takes reordered and trimmed (the later take first, stored out
 * of order), b-roll above them, music under the voice with ducking, a
 * captions clip and a lower third. 30 fps: 1 000 000 µs is 30 frames.
 */
function golden(): Production {
  const base = footageProduction();
  return {
    ...base,
    storyboard: null,
    review: { comments: [] },
    media: [
      { mediaId: MEDIA.aRoll, role: "a-roll", label: "Take 3" },
      { mediaId: MEDIA.bRoll, role: "b-roll", label: "Keyboard" },
      { mediaId: MEDIA.music, role: "music", label: "Bed" },
    ],
    timeline: {
      tracks: [
        {
          id: "t-aroll",
          kind: "video",
          role: "a-roll",
          hidden: false,
          clips: [
            vclip("a1", 60, 60, MEDIA.aRoll, 0, 2_000_000, { audio: { gainDb: [], fadeOutFrames: 15 } }),
            vclip("a2", 15, 45, MEDIA.aRoll, 2_500_000, 4_000_000),
          ],
        },
        { id: "t-broll", kind: "video", role: "b-roll", hidden: false, clips: [vclip("b1", 45, 30, MEDIA.bRoll, 1_000_000, 2_000_000)] },
        { id: "t-captions", kind: "graphics", hidden: false, clips: [gclip("cap", 15, 105, { id: "captions.test-cues", version: "1.0.0", params: CAPTION_PARAMS })] },
        { id: "t-lower", kind: "graphics", hidden: false, clips: [gclip("lt", 20, 40, { id: "graphic.test-lower-third", version: "1.0.0", params: { name: "Ada Lovelace" } })] },
        {
          id: "t-music",
          kind: "audio",
          role: "music",
          muted: false,
          clips: [aclip("m1", 0, 135, MEDIA.music, 0, 4_500_000, { gainDb: [{ frame: 0, value: -6 }], fadeInFrames: 10, fadeOutFrames: 15 })],
        },
      ],
      captions: { presetId: null, hidden: false },
      audio: { masterLufs: -14, ducking: { depthDb: 12, attackMs: 80, releaseMs: 300 } },
      markers: [],
    },
  };
}

const run = (production: Production, media = ALL_MEDIA, profile: ExportProfile = INSTAGRAM_PROFILE) => compile(production, media, { profile, catalog });

function planOf(production: Production, media = ALL_MEDIA): RenderPlan {
  const result = run(production, media);
  if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.issues)}`);
  return result.plan;
}

function issuesOf(production: Production, media = ALL_MEDIA, profile?: ExportProfile): CompileIssue[] {
  const result = run(production, media, profile);
  if (result.ok) throw new Error("expected issues");
  return result.issues;
}

const brief = (issues: CompileIssue[]) => issues.map(({ code, path, clipId }) => ({ code, path, ...(clipId ? { clipId } : {}) }));

const db = (gain: number) => 20 * Math.log10(gain);

// ---------------------------------------------------------------------------

describe("compile: the golden plan", () => {
  it("is compiled from an admitted production", () => {
    expect(admitProduction(golden()).ok).toBe(true);
  });

  it("places picture, sound, graphics and captions exactly", () => {
    const plan = planOf(golden());
    const envelope = expect.any(Array);
    expect(plan).toEqual({
      version: 1,
      productionId: "prod-footage",
      revision: 7,
      profile: "instagram",
      canvas: { width: 1080, height: 1920, fps: 30 },
      durationFrames: 135,
      video: [
        { clipId: "a2", trackId: "t-aroll", trackIndex: 0, kind: "video", mediaId: MEDIA.aRoll, startFrame: 15, durationFrames: 45, sourceInUs: 2_500_000, placement: { scaledWidth: 1080, scaledHeight: 1920, offsetX: 0, offsetY: 0 } },
        { clipId: "a1", trackId: "t-aroll", trackIndex: 0, kind: "video", mediaId: MEDIA.aRoll, startFrame: 60, durationFrames: 60, sourceInUs: 0, placement: { scaledWidth: 1080, scaledHeight: 1920, offsetX: 0, offsetY: 0 } },
        { clipId: "b1", trackId: "t-broll", trackIndex: 1, kind: "video", mediaId: MEDIA.bRoll, startFrame: 45, durationFrames: 30, sourceInUs: 1_000_000, placement: { scaledWidth: 3413, scaledHeight: 1920, offsetX: 1166, offsetY: 0 } },
      ],
      audio: [
        { clipId: "a2", trackId: "t-aroll", role: "voice", mediaId: MEDIA.aRoll, startFrame: 15, durationFrames: 45, sourceInUs: 2_500_000, envelope },
        { clipId: "a1", trackId: "t-aroll", role: "voice", mediaId: MEDIA.aRoll, startFrame: 60, durationFrames: 60, sourceInUs: 0, envelope },
        { clipId: "b1", trackId: "t-broll", role: "b-roll", mediaId: MEDIA.bRoll, startFrame: 45, durationFrames: 30, sourceInUs: 1_000_000, envelope },
        { clipId: "m1", trackId: "t-music", role: "music", mediaId: MEDIA.music, startFrame: 0, durationFrames: 135, sourceInUs: 0, envelope },
      ],
      graphics: [
        { clipId: "cap", trackId: "t-captions", trackIndex: 2, capability: { id: "captions.test-cues", version: "1.0.0", params: CAPTION_PARAMS }, startFrame: 15, durationFrames: 105 },
        { clipId: "lt", trackId: "t-lower", trackIndex: 3, capability: { id: "graphic.test-lower-third", version: "1.0.0", params: { name: "Ada Lovelace" } }, startFrame: 20, durationFrames: 40 },
      ],
      captions: [
        { clipId: "cap", startFrame: 15, endFrame: 45, text: "Agents loop" },
        { clipId: "cap", startFrame: 45, endFrame: 75, text: "<b>plan & act</b>" },
        { clipId: "cap", startFrame: 105, endFrame: 120, text: "clipped at the clip's end" },
      ],
      inputs: [
        { mediaId: MEDIA.aRoll, kind: "video", display: { width: 1080, height: 1920 }, rotation: 90, dynamicRange: "sdr", hasAudio: true, durationUs: 60_000_000 },
        { mediaId: MEDIA.bRoll, kind: "video", display: { width: 1920, height: 1080 }, rotation: 0, dynamicRange: "sdr", hasAudio: true, durationUs: 10_000_000 },
        { mediaId: MEDIA.music, kind: "audio", rotation: 0, dynamicRange: "sdr", hasAudio: true, durationUs: 120_000_000 },
      ],
      loudness: { targetLufs: -14 },
    });
  });

  it("ducks the music under the voice, fades it, and leaves voice and b-roll sound alone", () => {
    const plan = planOf(golden());
    const music = plan.audio.find((a) => a.clipId === "m1")!.envelope;
    const near = (atUs: number, expectedDb: number) => expect(Math.abs(db(gainAt(music, atUs)) - expectedDb)).toBeLessThanOrEqual(0.1);

    expect(music[0]).toEqual({ atUs: 0, gain: 0 });
    expect(music[music.length - 1]).toEqual({ atUs: 4_500_000, gain: 0 });
    near(166_667, -6 + db(0.5)); // half way through the 10-frame fade in
    near(400_000, -6); // faded in, before the voice
    near(540_000, -12); // half way through the 80 ms attack from 500 000 µs
    near(580_000, -18); // fully ducked
    near(3_000_000, -18);
    near(4_150_000, -12 + db(0.7)); // half way through the release, inside the fade out
    near(4_300_000, -6 + db(0.4)); // released

    // The two voice takes abut, so the reduction does not lift at the cut.
    near(2_000_000, -18);

    for (const id of ["a2", "b1"]) {
      expect(plan.audio.find((a) => a.clipId === id)!.envelope.every((p) => p.gain === 1)).toBe(true);
    }
    const a1 = plan.audio.find((a) => a.clipId === "a1")!.envelope;
    expect(gainAt(a1, 3_000_000)).toBe(1);
    expect(gainAt(a1, 3_750_000)).toBeCloseTo(0.5, 6); // half way through its 15-frame fade out
    expect(gainAt(a1, 4_000_000)).toBe(0);
  });

  it("gives every layer the preview box that matches its cover placement", () => {
    const b1 = planOf(golden()).video.find((v) => v.clipId === "b1")!;
    const box = layerBox(b1.placement);
    expect([box.left, box.top === 0, box.width, box.height]).toEqual([-1166, true, 3413, 1920]);
  });

  it("is deterministic, does not change the production and does not share its objects", () => {
    const production = golden();
    const before = structuredClone(production);
    const first = planOf(production);
    const second = planOf(production);
    expect(second).toEqual(first);
    expect(production).toEqual(before);
    first.graphics[0].capability.params = null;
    expect(planOf(production).graphics[0].capability.params).toEqual(CAPTION_PARAMS);
  });
});

describe("compile: refusals", () => {
  it("returns every issue in the footage fixture at once, each with its path and clip", () => {
    const issues = issuesOf(footageProduction());
    expect(brief(issues)).toEqual([
      { code: "unsupported_feature", path: "/timeline/tracks/0/clips/0/framing", clipId: "clip-v1" },
      { code: "unsupported_feature", path: "/timeline/tracks/1/clips/0/transitionIn", clipId: "clip-b1" },
      { code: "unsupported_feature", path: "/timeline/tracks/2/role", clipId: "clip-logo" },
      { code: "capability_unavailable", path: "/timeline/tracks/3/clips/0/capability", clipId: "clip-captions" },
      { code: "unsupported_feature", path: "/timeline/tracks/4/clips/1/processing", clipId: "clip-a2" },
    ]);
    for (const issue of issues) expect(issue.message).toMatch(/\S/);
  });

  it("refuses speed changes in the script fixture", () => {
    const media = registry(
      record(MEDIA.illustration, { kind: "image", container: "png_pipe", video: picture(1024, 1024) }),
      record(MEDIA.narration, { kind: "audio", container: "wav", durationUs: 10_000_000, audio: sound }),
      RECORDS.music
    );
    expect(brief(issuesOf(scriptProduction(), media))).toEqual([
      { code: "capability_unavailable", path: "/timeline/tracks/1/clips/0/capability", clipId: "gx-1" },
      { code: "unsupported_feature", path: "/timeline/tracks/3/clips/0/speed", clipId: "au-m1" },
    ]);
  });

  it("refuses an empty timeline", () => {
    const p = golden();
    p.timeline.tracks = [{ id: "t", kind: "video", role: "a-roll", hidden: false, clips: [] }];
    expect(brief(issuesOf(p))).toEqual([{ code: "empty_timeline", path: "/timeline/tracks" }]);
  });

  it("refuses a canvas or frame rate the profile does not take", () => {
    const p = golden();
    p.format = { ...p.format, width: 1920, height: 1080 };
    expect(brief(issuesOf(p))).toEqual([{ code: "profile_mismatch", path: "/format" }]);
    const thirtyOnly: ExportProfile = { ...INSTAGRAM_PROFILE, frameRates: [30] };
    const q = golden();
    q.format = { ...q.format, fps: 25 };
    expect(brief(issuesOf(q, ALL_MEDIA, thirtyOnly))).toEqual([{ code: "profile_mismatch", path: "/format/fps" }]);
  });

  it("refuses a timeline longer than the production's limit, and accepts one exactly at it", () => {
    const p = golden();
    p.format = { ...p.format, maxDurationMs: 4_499 };
    expect(brief(issuesOf(p))).toEqual([{ code: "duration_exceeds_profile", path: "/format/maxDurationMs" }]);
    p.format = { ...p.format, maxDurationMs: 4_500 };
    expect(run(p).ok).toBe(true);
  });

  it("refuses every feature without export semantics, naming the clip", () => {
    const p = golden();
    const [aroll, broll, captions, lower, music] = p.timeline.tracks as [
      Extract<Track, { kind: "video" }>,
      Extract<Track, { kind: "video" }>,
      Extract<Track, { kind: "graphics" }>,
      Extract<Track, { kind: "graphics" }>,
      Extract<Track, { kind: "audio" }>,
    ];
    const transition = { capability: { id: "transition.dissolve", version: "1.0.0", params: {} }, durationFrames: 6 };
    const effect = { id: "fx-1", capability: { id: "effect.grade", version: "1.0.0", params: {} } };
    Object.assign(aroll.clips[0], { speed: 2, effects: [effect] });
    Object.assign(aroll.clips[1], { speed: 1, effects: [], framing: [] });
    broll.clips.push(sclip("still-1", 80, 10, MEDIA.logo, { framing: [{ frame: 0, value: { x: 0, y: 0, width: 10, height: 10 } }], transitionIn: transition }));
    Object.assign(captions.clips[0], { transitionIn: transition });
    Object.assign(lower.clips[0], { layer: "behind-subject" });
    Object.assign(music.clips[0], { speed: 0.5, processing: { normalise: false } });
    music.clips.push(aclip("m2", 140, 10, MEDIA.music, 0, 333_333, { processing: {} }));

    expect(brief(issuesOf(p))).toEqual([
      { code: "unsupported_feature", path: "/timeline/tracks/0/clips/0/effects", clipId: "a1" },
      { code: "unsupported_feature", path: "/timeline/tracks/0/clips/0/speed", clipId: "a1" },
      { code: "unsupported_feature", path: "/timeline/tracks/1/clips/1/transitionIn", clipId: "still-1" },
      { code: "unsupported_feature", path: "/timeline/tracks/1/clips/1/framing", clipId: "still-1" },
      { code: "unsupported_feature", path: "/timeline/tracks/2/clips/0/transitionIn", clipId: "cap" },
      { code: "unsupported_feature", path: "/timeline/tracks/3/clips/0/layer", clipId: "lt" },
      { code: "unsupported_feature", path: "/timeline/tracks/4/clips/0/speed", clipId: "m1" },
      { code: "unsupported_feature", path: "/timeline/tracks/4/clips/0/processing", clipId: "m1" },
    ]);
  });

  it("refuses unknown capabilities and invalid parameters, with the parameter path appended", () => {
    const p = golden();
    const [, , captions, lower] = p.timeline.tracks as Extract<Track, { kind: "graphics" }>[];
    captions.clips[0].capability = { id: "captions.test-cues", version: "1.0.0", params: { cues: [{ text: "ok" }, { text: "" }, { text: 3 }] } };
    lower.clips[0].capability = { id: "graphic.test-lower-third", version: "2.0.0", params: {} };
    lower.clips.push(gclip("lt2", 70, 1, { id: "graphic.test-lower-third", version: "1.0.0", params: { name: "x" } }));
    lower.clips.push(gclip("nocues", 80, 10, { id: "captions.no-cues", version: "1.0.0", params: null }));
    expect(brief(issuesOf(p))).toEqual([
      { code: "invalid_capability_params", path: "/timeline/tracks/2/clips/0/capability/params/cues/1/text", clipId: "cap" },
      { code: "invalid_capability_params", path: "/timeline/tracks/2/clips/0/capability/params/cues/2/text", clipId: "cap" },
      { code: "capability_unavailable", path: "/timeline/tracks/3/clips/0/capability", clipId: "lt" },
      { code: "invalid_capability_params", path: "/timeline/tracks/3/clips/1/capability/params", clipId: "lt2" },
      { code: "capability_unavailable", path: "/timeline/tracks/3/clips/2/capability", clipId: "nocues" },
    ]);
  });

  it("refuses media that is not registered, of the wrong kind, without a picture or without sound", () => {
    const silentVideo = record(MEDIA.bRoll, { kind: "video", container: "mov,mp4", durationUs: 10_000_000, video: picture(1920, 1080) });
    const p = golden();
    const [aroll, broll, , , music] = p.timeline.tracks as [
      Extract<Track, { kind: "video" }>,
      Extract<Track, { kind: "video" }>,
      unknown,
      unknown,
      Extract<Track, { kind: "audio" }>,
    ];
    broll.clips.push(sclip("still-music", 80, 10, MEDIA.music), sclip("still-video", 95, 10, MEDIA.aRoll));
    music.clips.push(aclip("m-logo", 140, 10, MEDIA.logo, 0, 333_333), aclip("m-silent", 160, 10, MEDIA.bRoll, 0, 333_333));
    aroll.clips.push(vclip("unknown", 130, 10, MEDIA.sfx, 0, 333_333));
    const noPicture = record(MEDIA.aRoll, { kind: "video", container: "fixture", durationUs: 60_000_000, audio: sound });

    expect(brief(issuesOf(p, registry(noPicture, silentVideo, RECORDS.music, RECORDS.logo)))).toEqual([
      { code: "media_kind_mismatch", path: "/timeline/tracks/0/clips/1/source/mediaId", clipId: "a2" },
      { code: "media_kind_mismatch", path: "/timeline/tracks/0/clips/0/source/mediaId", clipId: "a1" },
      { code: "media_not_registered", path: "/timeline/tracks/0/clips/2/source/mediaId", clipId: "unknown" },
      { code: "media_kind_mismatch", path: "/timeline/tracks/1/clips/1/mediaId", clipId: "still-music" },
      { code: "media_kind_mismatch", path: "/timeline/tracks/1/clips/2/mediaId", clipId: "still-video" },
      { code: "media_kind_mismatch", path: "/timeline/tracks/4/clips/1/source/mediaId", clipId: "m-logo" },
      { code: "no_audio_stream", path: "/timeline/tracks/4/clips/2/source/mediaId", clipId: "m-silent" },
    ]);
  });
});

describe("compile: visibility", () => {
  it("draws nothing from a hidden video track but still plays its sound, and reads silent hidden media not at all", () => {
    const p = golden();
    (p.timeline.tracks[0] as Extract<Track, { kind: "video" }>).hidden = true;
    (p.timeline.tracks[1] as Extract<Track, { kind: "video" }>).hidden = true;
    const silentBRoll = record(MEDIA.bRoll, { kind: "video", container: "mov,mp4", durationUs: 10_000_000, video: picture(1920, 1080) });
    const plan = planOf(p, registry(RECORDS.aRoll, silentBRoll, RECORDS.music));
    expect(plan.video).toEqual([]);
    expect(plan.audio.map((a) => [a.clipId, a.role])).toEqual([
      ["a2", "voice"],
      ["a1", "voice"],
      ["m1", "music"],
    ]);
    expect(plan.inputs.map((i) => i.mediaId)).toEqual([MEDIA.aRoll, MEDIA.music]);
    // The hidden a-roll still ducks the music.
    expect(db(gainAt(plan.audio[2].envelope, 3_000_000))).toBeCloseTo(-18, 1);
  });

  it("skips a hidden graphics track entirely but still counts its length", () => {
    const p = golden();
    p.timeline.tracks.push({ id: "t-hidden", kind: "graphics", hidden: true, clips: [gclip("ghost", 0, 300, { id: "graphic.unknown", version: "9.9.9", params: null })] });
    const plan = planOf(p);
    expect(plan.durationFrames).toBe(300);
    expect(plan.graphics.map((g) => g.clipId)).toEqual(["cap", "lt"]);
  });

  it("skips captions everywhere when the timeline hides them, even invalid ones, but keeps other graphics", () => {
    const p = golden();
    p.timeline.captions = { presetId: null, hidden: true };
    (p.timeline.tracks[2] as Extract<Track, { kind: "graphics" }>).clips[0].capability.params = { cues: [{ text: "" }] };
    const plan = planOf(p);
    expect(plan.graphics.map((g) => g.clipId)).toEqual(["lt"]);
    expect(plan.captions).toEqual([]);
    expect(plan.durationFrames).toBe(135);
  });

  it("shows captions when the timeline has no caption settings", () => {
    const p = golden();
    p.timeline.captions = null;
    expect(planOf(p).captions).toHaveLength(3);
  });

  it("ignores a muted audio track, unregistered media and all", () => {
    const p = golden();
    p.timeline.tracks.push({ id: "t-muted", kind: "audio", role: "sfx", muted: true, clips: [aclip("s1", 0, 30, MEDIA.sfx, 0, 1_000_000, { speed: 2 })] });
    const plan = planOf(p);
    expect(plan.audio.map((a) => a.clipId)).toEqual(["a2", "a1", "b1", "m1"]);
    expect(plan.inputs.map((i) => i.mediaId)).not.toContain(MEDIA.sfx);
  });

  it("does not duck when the depth is 0, nor under a muted voice track", () => {
    const p = golden();
    p.timeline.audio.ducking.depthDb = 0;
    const flat = planOf(p).audio.find((a) => a.clipId === "m1")!.envelope;
    expect(db(gainAt(flat, 3_000_000))).toBeCloseTo(-6, 4);

    const q = golden();
    q.timeline.tracks = q.timeline.tracks.filter((t) => t.id !== "t-aroll");
    q.timeline.tracks.push({ id: "t-voice", kind: "audio", role: "voice", muted: true, clips: [aclip("v1", 0, 135, MEDIA.music, 0, 4_500_000)] });
    expect(db(gainAt(planOf(q).audio.find((a) => a.clipId === "m1")!.envelope, 3_000_000))).toBeCloseTo(-6, 4);
  });

  it("takes an audio clip's role from its track and plays a video's sound from an audio clip", () => {
    const p = golden();
    p.timeline.tracks.push({ id: "t-amb", kind: "audio", role: "ambience", muted: false, clips: [aclip("amb", 0, 30, MEDIA.aRoll, 0, 1_000_000, { gainDb: [{ frame: 0, value: -3 }] })] });
    const plan = planOf(p);
    const amb = plan.audio.find((a) => a.clipId === "amb")!;
    expect(amb.role).toBe("ambience");
    expect(db(gainAt(amb.envelope, 100_000))).toBeCloseTo(-3, 5);
    expect(db(gainAt(amb.envelope, 999_999))).toBeLessThan(-3); // ducked by the voice from 500 000 µs
  });

  it("places a still image without a source time", () => {
    const p = golden();
    (p.timeline.tracks[1] as Extract<Track, { kind: "video" }>).clips.push(sclip("logo", 80, 10, MEDIA.logo));
    const plan = planOf(p);
    expect(plan.video.find((v) => v.clipId === "logo")).toEqual({
      clipId: "logo",
      trackId: "t-broll",
      trackIndex: 1,
      kind: "still",
      mediaId: MEDIA.logo,
      startFrame: 80,
      durationFrames: 10,
      placement: { scaledWidth: 1920, scaledHeight: 1920, offsetX: 420, offsetY: 0 },
    });
    expect(plan.inputs.find((i) => i.mediaId === MEDIA.logo)).toEqual({ mediaId: MEDIA.logo, kind: "image", display: { width: 1000, height: 1000 }, rotation: 0, dynamicRange: "sdr", hasAudio: false });
  });
});

describe("cover placement", () => {
  const portrait = { width: 1080, height: 1920 };

  it("fills the canvas exactly with matching footage", () => {
    expect(coverPlacement({ width: 1080, height: 1920 }, portrait)).toEqual({ scaledWidth: 1080, scaledHeight: 1920, offsetX: 0, offsetY: 0 });
    expect(coverPlacement({ width: 2160, height: 3840 }, portrait)).toEqual({ scaledWidth: 1080, scaledHeight: 1920, offsetX: 0, offsetY: 0 });
  });

  it("crops landscape footage into a portrait canvas around its centre", () => {
    expect(coverPlacement({ width: 1920, height: 1080 }, portrait)).toEqual({ scaledWidth: 3413, scaledHeight: 1920, offsetX: 1166, offsetY: 0 });
  });

  it("turns rotated phone footage upright before fitting it", () => {
    expect(displaySize({ width: 1920, height: 1080, rotation: 90 })).toEqual(portrait);
    expect(displaySize({ width: 1920, height: 1080, rotation: 270 })).toEqual(portrait);
    expect(displaySize({ width: 1920, height: 1080, rotation: 180 })).toEqual({ width: 1920, height: 1080 });
    expect(coverPlacement(displaySize({ width: 1920, height: 1080, rotation: 90 }), portrait)).toEqual({ scaledWidth: 1080, scaledHeight: 1920, offsetX: 0, offsetY: 0 });
  });

  it("crops a square image to the canvas", () => {
    expect(coverPlacement({ width: 1000, height: 1000 }, portrait)).toEqual({ scaledWidth: 1920, scaledHeight: 1920, offsetX: 420, offsetY: 0 });
    expect(coverPlacement({ width: 1000, height: 1000 }, { width: 1080, height: 1080 })).toEqual({ scaledWidth: 1080, scaledHeight: 1080, offsetX: 0, offsetY: 0 });
  });

  it("handles odd sizes with integers, never smaller than the canvas", () => {
    expect(coverPlacement({ width: 1001, height: 777 }, { width: 1080, height: 1350 })).toEqual({ scaledWidth: 1739, scaledHeight: 1350, offsetX: 329, offsetY: 0 });
    expect(coverPlacement({ width: 3, height: 5 }, { width: 1080, height: 1080 })).toEqual({ scaledWidth: 1080, scaledHeight: 1800, offsetX: 0, offsetY: 360 });
    let seed = 7;
    const next = (max: number) => 1 + ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % max);
    for (let i = 0; i < 2000; i++) {
      const display = { width: next(8000), height: next(8000) };
      for (const canvas of [portrait, { width: 1080, height: 1350 }, { width: 1080, height: 1080 }]) {
        const p = coverPlacement(display, canvas);
        for (const v of Object.values(p)) expect(Number.isInteger(v)).toBe(true);
        expect(p.scaledWidth).toBeGreaterThanOrEqual(canvas.width);
        expect(p.scaledHeight).toBeGreaterThanOrEqual(canvas.height);
        expect(p.scaledWidth === canvas.width || p.scaledHeight === canvas.height).toBe(true);
        expect(p.offsetX + canvas.width).toBeLessThanOrEqual(p.scaledWidth);
        expect(p.offsetY + canvas.height).toBeLessThanOrEqual(p.scaledHeight);
        expect(Math.abs(p.scaledWidth / p.scaledHeight - display.width / display.height) * p.scaledHeight).toBeLessThanOrEqual(1);
      }
    }
  });
});
