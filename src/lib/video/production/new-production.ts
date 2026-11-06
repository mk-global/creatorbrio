/**
 * A new, empty Edit Studio production (#150): a footage workflow at the
 * assembly stage, formatted as an Instagram Reel, with the tracks the Studio
 * page edits. It is pure, so the page and the tests make productions the same
 * way, and the store's admission stays the only judge of what is valid.
 *
 * Tracks are listed bottom to top, which is the order the render plan draws
 * picture layers and graphics in.
 */
import type { Production } from "@/types/production";

/** The tracks of a new production, by role; the Studio places media and graphics on them. */
export const STUDIO_TRACKS = {
  footage: "t-footage",
  images: "t-images",
  music: "t-music",
  titles: "t-titles",
  captions: "t-captions",
} as const;

export interface NewProductionInput {
  /** A short safe identifier (`ID_PATTERN`). */
  id: string;
  name: string;
  /** ISO 8601 UTC creation time. */
  at: string;
}

export function newEditProduction({ id, name, at }: NewProductionInput): Production {
  const format = { width: 1080, height: 1920, fps: 30, maxDurationMs: 90_000, platform: "instagram-reel" } as const;
  return {
    schemaVersion: 2,
    id,
    name,
    brandId: "default",
    styleProfileId: null,
    workflow: "footage",
    usageIntent: "commercial",
    revision: 0,
    stage: "assembly",
    format: { ...format },
    brief: {
      constraints: [],
      visualDecisions: [],
      assetRelationships: [],
      platform: "instagram-reel",
      targetDurationMs: { min: 15_000, max: 90_000 },
      tone: [],
      mustInclude: [],
      mustAvoid: [],
      audienceKnowledge: "novice",
      updatedAt: at,
    },
    research: null,
    script: null,
    storyboard: null,
    media: [],
    timeline: {
      tracks: [
        { id: STUDIO_TRACKS.footage, kind: "video", role: "a-roll", hidden: false, clips: [] },
        { id: STUDIO_TRACKS.images, kind: "video", role: "b-roll", hidden: false, clips: [] },
        { id: STUDIO_TRACKS.music, kind: "audio", role: "music", muted: false, clips: [] },
        { id: STUDIO_TRACKS.titles, kind: "graphics", hidden: false, clips: [] },
        { id: STUDIO_TRACKS.captions, kind: "graphics", hidden: false, clips: [] },
      ],
      captions: { presetId: null, hidden: false },
      audio: { masterLufs: -14, ducking: { depthDb: 12, attackMs: 80, releaseMs: 300 } },
      markers: [],
    },
    voice: null,
    review: { comments: [] },
    deliverables: [{ id: "deliv-reel", label: "Instagram Reel", format: { ...format } }],
    createdAt: at,
    updatedAt: at,
  };
}
