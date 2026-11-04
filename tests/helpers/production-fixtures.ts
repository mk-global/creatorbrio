/**
 * Valid Production v2 documents for the three workflows. Each builder returns
 * a fresh document, so a test can break one rule without affecting another.
 *
 * Timing at 30 fps: one second of source (1 000 000 µs) is 30 frames.
 */

import type {
  AudioClip,
  GraphicsClip,
  Production,
  ProductionBrief,
  Provenance,
  ResearchDossier,
  Scene,
  StillClip,
  VideoClip,
} from "@/types/production";

export const T0 = "2026-11-04T09:00:00.000Z";
export const T1 = "2026-11-04T10:30:00.000Z";

const hex = (c: string) => c.repeat(64);
export const MEDIA = {
  aRoll: hex("a"),
  bRoll: hex("b"),
  music: hex("c"),
  logo: hex("d"),
  narration: hex("e"),
  illustration: hex("f"),
  sfx: hex("1"),
} as const;

const system = (changeSetId = "cs-1"): Provenance => ({ by: "system", changeSetId });

function brief(platform: ProductionBrief["platform"] = "instagram-reel"): ProductionBrief {
  return {
    objective: { value: "Explain how an AI agent plans its work", source: "explicit", at: T0 },
    audience: { value: "Founders new to AI tooling", source: "inferred", at: T0 },
    constraints: [{ text: "No jargon without explanation", source: "explicit", at: T0 }],
    visualDecisions: [],
    assetRelationships: [],
    platform,
    targetDurationMs: { min: 30_000, max: 60_000 },
    tone: ["energetic", "clear"],
    callToAction: { value: "Follow for part two", source: "explicit", at: T0 },
    mustInclude: [{ text: "The planning loop", source: "explicit", at: T0 }],
    mustAvoid: [],
    audienceKnowledge: "novice",
    updatedAt: T0,
  };
}

function research(): ResearchDossier {
  return {
    questions: ["How do agents decide their next step?"],
    sources: [
      {
        id: "src-1",
        kind: "url",
        url: "https://example.org/agents",
        title: "How agents plan",
        retrievedAt: T0,
        blob: hex("9"),
        reliability: "reputable-secondary",
        retrievedBy: "source-retrieval",
      },
    ],
    claims: [{ id: "claim-1", text: "Agents alternate planning and acting", sourceIds: ["src-1"], status: "supported", sensitive: false }],
    status: "reviewed",
  };
}

function scene(id: string, overrides: Partial<Scene>): Scene {
  return {
    id,
    title: `Scene ${id}`,
    purpose: "point",
    scriptLineIds: [],
    durationTargetMs: { min: 1_000, max: 5_000 },
    visual: { mode: "a-roll", description: "The speaker to camera", layers: [] },
    audio: { sfx: [] },
    captions: { emphasisWordIds: [] },
    slots: [],
    status: "proposed",
    approvals: [],
    comments: [],
    frames: [],
    provenance: system(),
    ...overrides,
  };
}

const video = (id: string, start: number, duration: number, mediaId: string, inUs: number, outUs: number, extra: Partial<VideoClip> = {}): VideoClip => ({
  kind: "video",
  id,
  start,
  duration,
  source: { mediaId, inUs, outUs },
  provenance: system(),
  ...extra,
});

const audio = (id: string, start: number, duration: number, mediaId: string, inUs: number, outUs: number, extra: Partial<AudioClip> = {}): AudioClip => ({
  kind: "audio",
  id,
  start,
  duration,
  source: { mediaId, inUs, outUs },
  gainDb: [],
  provenance: system(),
  ...extra,
});

const still = (id: string, start: number, duration: number, mediaId: string, extra: Partial<StillClip> = {}): StillClip => ({
  kind: "still",
  id,
  start,
  duration,
  mediaId,
  provenance: system(),
  ...extra,
});

const graphic = (id: string, start: number, duration: number, capabilityId: string, extra: Partial<GraphicsClip> = {}): GraphicsClip => ({
  kind: "graphics",
  id,
  start,
  duration,
  capability: { id: capabilityId, version: "1.0.0", params: { style: "kinetic", maxWords: 3 } },
  layer: "front",
  provenance: system(),
  ...extra,
});

/** Workflow A: talking-head footage with B-roll, a logo, captions and music. */
export function footageProduction(): Production {
  return {
    schemaVersion: 2,
    id: "prod-footage",
    name: "Agents plan, then act",
    brandId: "default",
    styleProfileId: "founder-style",
    workflow: "footage",
    usageIntent: "commercial",
    revision: 7,
    stage: "assembly",
    format: { width: 1080, height: 1920, fps: 30, maxDurationMs: 90_000, platform: "instagram-reel" },
    brief: brief(),
    research: research(),
    script: {
      origin: "transcribed",
      hookOptions: [
        { id: "hook-1", text: "Your agent is not thinking. It is looping.", technique: "bold-claim", rationale: "Contradicts a common belief" },
        { id: "hook-2", text: "What does an agent do between your prompts?", technique: "question", rationale: "Invites curiosity" },
      ],
      selectedHookId: "hook-1",
      sections: [
        {
          id: "sec-hook",
          role: "hook",
          lines: [
            {
              id: "line-1",
              speaker: "on-camera",
              text: "Your agent is not thinking. It is looping.",
              claimIds: [],
              spoken: { mediaId: MEDIA.aRoll, fromWordId: "w1", toWordId: "w8", takeGroupId: "take-1" },
            },
          ],
        },
        {
          id: "sec-point",
          role: "point",
          lines: [
            {
              id: "line-2",
              speaker: "on-camera",
              text: "It plans, acts, checks the result, and plans again.",
              claimIds: ["claim-1"],
              spoken: { mediaId: MEDIA.aRoll, fromWordId: "w9", toWordId: "w18" },
            },
          ],
        },
      ],
      status: "approved",
    },
    storyboard: {
      id: "board-1",
      scenes: [
        scene("scene-hook", {
          purpose: "hook",
          scriptLineIds: ["line-1"],
          visual: {
            mode: "a-roll-overlay",
            description: "Speaker with a bold caption",
            layers: [
              { kind: "a-roll", take: "selected" },
              { kind: "text", role: "title", text: "It is looping", claimIds: [] },
            ],
            camera: { move: "punch-in", onWordIds: ["w5"] },
            framing: "full",
          },
          status: "realized",
          approvals: [{ by: "user", at: T1, revision: 5, scope: "plan" }],
          realization: { clipIds: ["clip-a1", "clip-v1"], materializedAtRevision: 6, fingerprint: "fp-hook", diverged: false },
        }),
        scene("scene-point", {
          scriptLineIds: ["line-2"],
          visual: {
            mode: "b-roll",
            description: "Hands at a keyboard while the plan unfolds",
            layers: [
              { kind: "media", slotId: "slot-broll", fit: "cover", kenBurns: true },
              { kind: "text", role: "citation", text: "Source: How agents plan", claimIds: ["claim-1"] },
            ],
          },
          audio: {
            musicCue: { mood: "driving", intensity: "medium", trackSlotId: "slot-music" },
            sfx: [{ at: { wordId: "w12" }, intent: "soft whoosh on the cut" }],
          },
          slots: [
            {
              id: "slot-broll",
              need: "Hands typing, shallow focus",
              kind: "video",
              sourcing: ["user-library", "connector"],
              candidates: [{ assetId: MEDIA.bRoll, score: 0.82, reason: "Matches the action and colour" }],
              selectedAssetId: MEDIA.bRoll,
            },
            { id: "slot-music", need: "Driving electronic bed", kind: "music", sourcing: ["user-library"], candidates: [], selectedAssetId: MEDIA.music },
          ],
          status: "realized",
          comments: ["comment-1"],
          realization: { clipIds: ["clip-v2", "clip-b1", "clip-a2"], materializedAtRevision: 6, fingerprint: "fp-point", diverged: true },
          frames: [{ id: "frame-1", atMs: 0, assetId: null }],
        }),
      ],
      structure: { pattern: "hook-problem-solution-cta", hookSceneId: "scene-hook", targetDurationMs: 45_000, rationale: "Short explainer" },
      status: "in-review",
    },
    media: [
      { mediaId: MEDIA.aRoll, role: "a-roll", label: "Take 3, kitchen" },
      { mediaId: MEDIA.bRoll, role: "b-roll", label: "Keyboard close-up" },
      { mediaId: MEDIA.music, role: "music", label: "Driving bed" },
      { mediaId: MEDIA.logo, role: "logo", label: "Brand mark" },
    ],
    timeline: {
      tracks: [
        {
          id: "track-aroll",
          kind: "video",
          role: "a-roll",
          hidden: false,
          clips: [
            video("clip-v1", 0, 60, MEDIA.aRoll, 0, 2_000_000, {
              sceneId: "scene-hook",
              framing: [
                { frame: 0, value: { x: 0, y: 0, width: 1080, height: 1920 } },
                { frame: 30, value: { x: 90, y: 160, width: 900, height: 1600 }, ease: "ease-in-out" },
              ],
            }),
            video("clip-v2", 60, 45, MEDIA.aRoll, 2_500_000, 4_000_000, { sceneId: "scene-point" }),
          ],
        },
        {
          id: "track-broll",
          kind: "video",
          role: "b-roll",
          hidden: false,
          clips: [video("clip-b1", 75, 30, MEDIA.bRoll, 0, 1_000_000, { sceneId: "scene-point", transitionIn: { capability: { id: "transition.dissolve", version: "1.0.0", params: {} }, durationFrames: 6 } })],
        },
        { id: "track-overlay", kind: "video", role: "overlay", hidden: false, clips: [still("clip-logo", 0, 15, MEDIA.logo)] },
        { id: "track-captions", kind: "graphics", hidden: false, clips: [graphic("clip-captions", 0, 105, "captions.kinetic-pop")] },
        {
          id: "track-voice",
          kind: "audio",
          role: "voice",
          muted: false,
          clips: [
            audio("clip-a1", 0, 60, MEDIA.aRoll, 0, 2_000_000, { sceneId: "scene-hook" }),
            audio("clip-a2", 60, 45, MEDIA.aRoll, 2_500_000, 4_000_000, { sceneId: "scene-point", processing: { denoise: 0.4, normalise: true } }),
          ],
        },
        {
          id: "track-music",
          kind: "audio",
          role: "music",
          muted: false,
          clips: [
            audio("clip-m1", 0, 105, MEDIA.music, 0, 3_500_000, {
              gainDb: [
                { frame: 0, value: -18 },
                { frame: 60, value: -24, ease: "linear" },
              ],
              fadeInFrames: 10,
              fadeOutFrames: 15,
            }),
          ],
        },
      ],
      captions: { presetId: "kinetic-pop", hidden: false },
      audio: { masterLufs: -14, ducking: { depthDb: 12, attackMs: 80, releaseMs: 300 } },
      markers: [{ id: "marker-1", fromFrame: 60, toFrame: 75, note: "Is this cut too abrupt?", kind: "question", by: "agent" }],
    },
    voice: null,
    review: {
      comments: [
        {
          id: "comment-1",
          target: { kind: "scene", sceneId: "scene-point" },
          text: "Use a calmer B-roll shot here",
          kind: "change-request",
          by: "user",
          at: T1,
          revision: 6,
        },
      ],
    },
    deliverables: [{ id: "deliv-reel", label: "Instagram Reel", format: { width: 1080, height: 1920, fps: 30, maxDurationMs: 90_000, platform: "instagram-reel" } }],
    createdAt: T0,
    updatedAt: T1,
  };
}

/** Workflow B: a generated script narrated by a local voice over illustrations and a diagram. */
export function scriptProduction(): Production {
  return {
    schemaVersion: 2,
    id: "prod-script",
    name: "Three breathing techniques",
    brandId: "wellness",
    styleProfileId: null,
    workflow: "script",
    usageIntent: "personal",
    revision: 3,
    stage: "storyboard",
    format: { width: 1080, height: 1920, fps: 25, maxDurationMs: 60_000, platform: "youtube-short" },
    brief: brief("youtube-short"),
    research: research(),
    script: {
      origin: "generated",
      hookOptions: [{ id: "hook-a", text: "Breathe like this for one minute.", technique: "demonstration", rationale: "Shows the benefit immediately" }],
      selectedHookId: null,
      sections: [
        {
          id: "sec-1",
          role: "hook",
          lines: [
            { id: "nl-1", speaker: "narrator", text: "Breathe like this for one minute.", claimIds: [], delivery: { rate: 0.9, energy: "calm", pausesMs: [{ afterWordIndex: 2, ms: 400 }] } },
            { id: "nl-2", speaker: "character", characterId: "guide", text: "In for four, hold for four.", claimIds: ["claim-1"], estimatedMs: 2_400 },
          ],
        },
      ],
      status: "draft",
    },
    storyboard: {
      id: "board-b",
      scenes: [
        scene("scene-b1", {
          purpose: "hook",
          scriptLineIds: ["nl-1", "nl-2"],
          visual: {
            mode: "animated-scene",
            description: "A calm character demonstrates box breathing over a soft illustration",
            layers: [
              { kind: "media", slotId: "slot-illus", fit: "cover" },
              { kind: "scene-spec", specId: "spec-breathing" },
              { kind: "capability", capability: { id: "graphic.key-point-card", version: "1.2.0", params: { text: "4-4-4-4" } }, layer: "front" },
            ],
          },
          audio: { ambience: { intent: "soft room tone", slotId: "slot-amb" }, sfx: [{ at: "scene-start", intent: "gentle chime" }], voiceDirection: { rate: 0.85 } },
          slots: [
            { id: "slot-illus", need: "Soft pastel room, morning light", kind: "illustration", sourcing: ["generate"], candidates: [], selectedAssetId: MEDIA.illustration },
            { id: "slot-amb", need: "Quiet room tone", kind: "sfx", sourcing: ["user-library"], candidates: [], selectedAssetId: null },
          ],
          status: "approved",
          approvals: [{ by: "user", at: T1, revision: 3, scope: "plan" }],
        }),
      ],
      structure: { pattern: "list", hookSceneId: "scene-b1", targetDurationMs: 45_000, rationale: "Three techniques in order" },
      status: "draft",
    },
    media: [
      { mediaId: MEDIA.narration, role: "narration", label: "Narration draft read" },
      { mediaId: MEDIA.illustration, role: "image", label: "Morning room illustration" },
      { mediaId: MEDIA.music, role: "music", label: "Ambient bed" },
    ],
    timeline: {
      tracks: [
        { id: "tr-illus", kind: "video", role: "b-roll", hidden: false, clips: [still("st-1", 0, 125, MEDIA.illustration)] },
        { id: "tr-gfx", kind: "graphics", hidden: false, clips: [graphic("gx-1", 25, 50, "graphic.key-point-card", { layer: "front" })] },
        { id: "tr-voice", kind: "audio", role: "voice", muted: false, clips: [audio("au-n1", 0, 125, MEDIA.narration, 0, 5_000_000)] },
        { id: "tr-music", kind: "audio", role: "music", muted: false, clips: [audio("au-m1", 0, 100, MEDIA.music, 0, 2_000_000, { speed: 0.5 })] },
      ],
      captions: { presetId: null, hidden: false },
      audio: { masterLufs: -16, ducking: { depthDb: 10, attackMs: 100, releaseMs: 400 } },
      markers: [],
    },
    voice: { voiceId: "kokoro-af-heart", defaultDirection: { rate: 0.95, energy: "calm", pronunciations: { pranayama: "prah-nah-YAH-mah" } }, lexiconId: "wellness-lexicon" },
    review: { comments: [] },
    deliverables: [],
    createdAt: T0,
    updatedAt: T0,
  };
}

/** A hybrid: on-camera intro from footage, then a narrated animated segment. */
export function hybridProduction(): Production {
  const footage = footageProduction();
  const script = scriptProduction();
  return {
    ...footage,
    id: "prod-hybrid",
    name: "Agents, explained two ways",
    workflow: "hybrid",
    stage: "review",
    revision: 9,
    script: {
      origin: "written",
      hookOptions: footage.script!.hookOptions,
      selectedHookId: "hook-1",
      sections: [
        footage.script!.sections[0],
        { id: "sec-anim", role: "example", lines: [{ id: "nl-h1", speaker: "narrator", text: "Here is the loop, step by step.", claimIds: ["claim-1"] }] },
      ],
      status: "approved",
    },
    storyboard: {
      id: "board-h",
      scenes: [
        scene("scene-h1", { purpose: "hook", scriptLineIds: ["line-1"], visual: { mode: "a-roll", description: "Speaker intro", layers: [{ kind: "a-roll", take: "selected" }] } }),
        scene("scene-h2", {
          purpose: "example",
          scriptLineIds: ["nl-h1"],
          visual: { mode: "diagram", description: "The plan-act-check loop drawn step by step", layers: [{ kind: "capability", capability: { id: "graphic.architecture-diagram", version: "0.3.0", params: { nodes: ["plan", "act", "check"] } }, layer: "front" }] },
          status: "realized",
          realization: { clipIds: ["hx-diagram", "hx-narr"], materializedAtRevision: 8, fingerprint: "fp-h2", diverged: false },
        }),
      ],
      structure: { pattern: "explainer", hookSceneId: "scene-h1", targetDurationMs: 50_000, rationale: "Human intro, then a clear diagram" },
      status: "in-review",
    },
    media: [
      { mediaId: MEDIA.aRoll, role: "a-roll", label: "Intro take" },
      { mediaId: MEDIA.narration, role: "narration", label: "Loop narration" },
      { mediaId: MEDIA.sfx, role: "sfx", label: "Click" },
    ],
    timeline: {
      tracks: [
        { id: "hx-aroll", kind: "video", role: "a-roll", hidden: false, clips: [video("hx-v1", 0, 60, MEDIA.aRoll, 0, 2_000_000, { sceneId: "scene-h1" })] },
        { id: "hx-gfx", kind: "graphics", hidden: false, clips: [graphic("hx-diagram", 60, 90, "graphic.architecture-diagram", { sceneId: "scene-h2" })] },
        {
          id: "hx-voice",
          kind: "audio",
          role: "voice",
          muted: false,
          clips: [
            audio("hx-a1", 0, 60, MEDIA.aRoll, 0, 2_000_000, { sceneId: "scene-h1" }),
            audio("hx-narr", 60, 90, MEDIA.narration, 0, 3_000_000, { sceneId: "scene-h2" }),
          ],
        },
        { id: "hx-sfx", kind: "audio", role: "sfx", muted: false, clips: [audio("hx-click", 70, 3, MEDIA.sfx, 0, 100_000)] },
      ],
      captions: { presetId: "kinetic-pop", hidden: false },
      audio: footage.timeline.audio,
      markers: [],
    },
    voice: script.voice,
    review: { comments: [] },
    deliverables: [],
  };
}
