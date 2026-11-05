import { describe, it, expect } from "vitest";

import { admitProduction, type AdmissionResult, type LedgerMedia } from "@/lib/video/production";
import type { AudioClip, Production, StillClip, VideoClip } from "@/types/production";
import { footageProduction, hybridProduction, MEDIA, scriptProduction } from "./helpers/production-fixtures";

function issuesOf(result: AdmissionResult) {
  if (result.ok) throw new Error("expected the document to be rejected");
  return result.issues;
}

function expectRejected(doc: unknown, code: string, path?: string, options?: Parameters<typeof admitProduction>[1]) {
  const before = JSON.stringify(doc);
  const issues = issuesOf(admitProduction(doc, options));
  expect(JSON.stringify(doc), "the input must not be modified").toBe(before);
  const match = issues.find((i) => i.code === code && (path === undefined || i.path === path));
  expect(match, `expected ${code}${path ? ` at ${path}` : ""}; got ${JSON.stringify(issues, null, 1)}`).toBeDefined();
}

function expectAdmitted(doc: unknown, options?: Parameters<typeof admitProduction>[1]) {
  const result = admitProduction(doc, options);
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 1));
}

const videoClip = (doc: Production, track: number, clip: number) => doc.timeline.tracks[track].clips[clip] as VideoClip;
const audioClip = (doc: Production, track: number, clip: number) => doc.timeline.tracks[track].clips[clip] as AudioClip;

// ---------------------------------------------------------------------------

describe("identifiers are unique across the whole production", () => {
  it("refuses two clips with the same id", () => {
    const doc = footageProduction();
    doc.timeline.tracks[0].clips[1].id = "clip-v1";
    expectRejected(doc, "duplicate_id", "timeline.tracks[0].clips[1].id");
  });

  it("refuses two tracks with the same id", () => {
    const doc = footageProduction();
    doc.timeline.tracks[1].id = "track-aroll";
    expectRejected(doc, "duplicate_id", "timeline.tracks[1].id");
  });

  it("refuses two scenes with the same id", () => {
    const doc = footageProduction();
    doc.storyboard!.scenes[1].id = "scene-hook";
    expectRejected(doc, "duplicate_id", "storyboard.scenes[1].id");
  });

  it("refuses an id shared by entities of different kinds", () => {
    const doc = footageProduction();
    doc.timeline.markers[0].id = "scene-hook";
    expectRejected(doc, "duplicate_id", "timeline.markers[0].id");
  });

  it("refuses the same media listed twice", () => {
    const doc = footageProduction();
    doc.media.push({ mediaId: MEDIA.aRoll, role: "a-roll", label: "Again" });
    expectRejected(doc, "duplicate_id", "media[4].mediaId");
  });
});

describe("the source/timeline time model", () => {
  it("refuses negative and fractional timeline positions and empty clips", () => {
    let doc = footageProduction();
    doc.timeline.tracks[2].clips[0].start = -1;
    expectRejected(doc, "out_of_range", "timeline.tracks[2].clips[0].start");
    doc = footageProduction();
    doc.timeline.tracks[2].clips[0].start = 1.5;
    expectRejected(doc, "invalid_type", "timeline.tracks[2].clips[0].start");
    doc = footageProduction();
    doc.timeline.tracks[2].clips[0].duration = 0;
    expectRejected(doc, "out_of_range", "timeline.tracks[2].clips[0].duration");
  });

  it("refuses a source range that ends before it starts or starts before zero", () => {
    let doc = footageProduction();
    videoClip(doc, 0, 0).source = { mediaId: MEDIA.aRoll, inUs: 2_000_000, outUs: 2_000_000 };
    expectRejected(doc, "out_of_range", "timeline.tracks[0].clips[0].source");
    doc = footageProduction();
    videoClip(doc, 0, 0).source.inUs = -1;
    expectRejected(doc, "out_of_range", "timeline.tracks[0].clips[0].source.inUs");
    doc = footageProduction();
    videoClip(doc, 0, 0).source.inUs = 0.5;
    expectRejected(doc, "invalid_type", "timeline.tracks[0].clips[0].source.inUs");
  });

  it("refuses a clip whose frame count does not match its source span", () => {
    const doc = footageProduction();
    videoClip(doc, 0, 0).duration = 62; // 2 s at 30 fps is 60 frames
    expectRejected(doc, "inconsistent", "timeline.tracks[0].clips[0].duration");
  });

  it("allows a source span that is not a whole number of frames, rounded to the nearest frame", () => {
    const doc = footageProduction();
    const clip = videoClip(doc, 1, 0);
    // 1 016 666 µs is 30.49998 frames at 30 fps, so the clip is 30 frames long.
    clip.source.outUs = 1_016_666;
    clip.duration = 30;
    expectAdmitted(doc);
    clip.duration = 31;
    expectRejected(doc, "inconsistent", "timeline.tracks[1].clips[0].duration");
    // 1 016 667 µs is 30.50001 frames, so the clip is 31 frames long.
    clip.source.outUs = 1_016_667;
    expectAdmitted(doc);
    clip.duration = 30;
    expectRejected(doc, "inconsistent", "timeline.tracks[1].clips[0].duration");
  });

  it("accounts for constant playback speed", () => {
    const doc = footageProduction();
    const clip = videoClip(doc, 1, 0); // 1 s of source
    clip.speed = 2;
    clip.duration = 15;
    expectAdmitted(doc);
    clip.duration = 30;
    expectRejected(doc, "inconsistent", "timeline.tracks[1].clips[0].duration");
    clip.duration = 15;
    clip.speed = 10;
    expectRejected(doc, "out_of_range", "timeline.tracks[1].clips[0].speed");
  });

  it("keeps keyframes inside the clip and in increasing order", () => {
    let doc = footageProduction();
    videoClip(doc, 0, 0).framing![1].frame = 61;
    expectRejected(doc, "out_of_range", "timeline.tracks[0].clips[0].framing[1].frame");
    doc = footageProduction();
    videoClip(doc, 0, 0).framing![1].frame = 0;
    expectRejected(doc, "inconsistent", "timeline.tracks[0].clips[0].framing[1].frame");
  });

  it("refuses fades longer than the clip", () => {
    const doc = footageProduction();
    const music = audioClip(doc, 5, 0);
    music.fadeInFrames = 60;
    music.fadeOutFrames = 60;
    expectRejected(doc, "out_of_range", "timeline.tracks[5].clips[0]");
  });

  it("refuses a transition longer than its clip", () => {
    const doc = footageProduction();
    videoClip(doc, 1, 0).transitionIn!.durationFrames = 31;
    expectRejected(doc, "out_of_range", "timeline.tracks[1].clips[0].transitionIn.durationFrames");
  });

  it("refuses overlapping clips on one track but allows abutting ones", () => {
    const doc = footageProduction();
    doc.timeline.tracks[0].clips[1].start = 59;
    expectRejected(doc, "overlap", "timeline.tracks[0].clips[1]");
    doc.timeline.tracks[0].clips[1].start = 60;
    expectAdmitted(doc);
  });

  it("detects overlap regardless of the order clips are stored in", () => {
    const doc = footageProduction();
    doc.timeline.tracks[0].clips.reverse();
    doc.timeline.tracks[0].clips[0].start = 30;
    expectRejected(doc, "overlap", "timeline.tracks[0].clips[0]");
  });

  it("refuses a marker that ends before it starts", () => {
    const doc = footageProduction();
    doc.timeline.markers[0].toFrame = 10;
    expectRejected(doc, "out_of_range", "timeline.markers[0]");
  });
});

describe("references resolve", () => {
  it("refuses a clip using media the production does not list", () => {
    const doc = footageProduction();
    videoClip(doc, 1, 0).source.mediaId = MEDIA.narration;
    expectRejected(doc, "dangling_reference", "timeline.tracks[1].clips[0].source.mediaId");
  });

  it("refuses clips whose media kind does not fit", () => {
    let doc = footageProduction();
    (doc.timeline.tracks[2].clips[0] as StillClip).mediaId = MEDIA.bRoll;
    expectRejected(doc, "inconsistent", "timeline.tracks[2].clips[0].mediaId");
    doc = footageProduction();
    videoClip(doc, 1, 0).source.mediaId = MEDIA.music;
    expectRejected(doc, "inconsistent", "timeline.tracks[1].clips[0].source.mediaId");
    doc = footageProduction();
    audioClip(doc, 4, 0).source.mediaId = MEDIA.logo;
    expectRejected(doc, "inconsistent", "timeline.tracks[4].clips[0].source.mediaId");
  });

  it("refuses a clip kind on the wrong kind of track", () => {
    const doc = footageProduction();
    const clip = doc.timeline.tracks[0].clips[0];
    (doc.timeline.tracks[4].clips as unknown[]).push({ ...clip, id: "misplaced", start: 200 });
    expectRejected(doc, "invalid_value", "timeline.tracks[4].clips[2].kind");
  });

  it("refuses a clip that names a scene the storyboard does not hold", () => {
    const doc = footageProduction();
    doc.timeline.tracks[3].clips[0].sceneId = "scene-ghost";
    expectRejected(doc, "dangling_reference", "timeline.tracks[3].clips[0].sceneId");
  });

  it("keeps scene realisations consistent with the clips that carry the scene", () => {
    let doc = footageProduction();
    doc.storyboard!.scenes[0].realization!.clipIds.push("clip-missing");
    expectRejected(doc, "dangling_reference", "storyboard.scenes[0].realization.clipIds[2]");
    doc = footageProduction();
    doc.storyboard!.scenes[0].realization!.clipIds.push("clip-captions");
    expectRejected(doc, "inconsistent", "storyboard.scenes[0].realization.clipIds[2]");
    doc = footageProduction();
    delete doc.storyboard!.scenes[0].realization;
    expectRejected(doc, "inconsistent", "storyboard.scenes[0].status");
  });

  it("refuses references into the future", () => {
    let doc = footageProduction();
    doc.storyboard!.scenes[0].approvals[0].revision = 8;
    expectRejected(doc, "out_of_range", "storyboard.scenes[0].approvals[0].revision");
    doc = footageProduction();
    doc.storyboard!.scenes[0].realization!.materializedAtRevision = 8;
    expectRejected(doc, "out_of_range", "storyboard.scenes[0].realization.materializedAtRevision");
    doc = footageProduction();
    doc.review.comments[0].revision = 8;
    expectRejected(doc, "out_of_range", "review.comments[0].revision");
  });

  it("refuses scenes that reference missing script lines, slots or assets", () => {
    let doc = footageProduction();
    doc.storyboard!.scenes[1].scriptLineIds.push("line-ghost");
    expectRejected(doc, "dangling_reference", "storyboard.scenes[1].scriptLineIds[1]");
    doc = footageProduction();
    doc.storyboard!.scenes[1].visual.layers[0] = { kind: "media", slotId: "slot-ghost", fit: "cover" };
    expectRejected(doc, "dangling_reference", "storyboard.scenes[1].visual.layers[0].slotId");
    doc = footageProduction();
    doc.storyboard!.scenes[1].slots[0].selectedAssetId = MEDIA.illustration;
    expectRejected(doc, "dangling_reference", "storyboard.scenes[1].slots[0].selectedAssetId");
    doc = footageProduction();
    doc.storyboard!.structure!.hookSceneId = "scene-ghost";
    expectRejected(doc, "dangling_reference", "storyboard.structure.hookSceneId");
  });

  it("refuses claims and lines that cite missing sources or claims", () => {
    let doc = footageProduction();
    doc.research!.claims[0].sourceIds = ["src-ghost"];
    expectRejected(doc, "dangling_reference", "research.claims[0].sourceIds[0]");
    doc = footageProduction();
    doc.research!.claims[0].sourceIds = [];
    expectRejected(doc, "inconsistent", "research.claims[0].sourceIds");
    doc = footageProduction();
    doc.script!.sections[1].lines[0].claimIds = ["claim-ghost"];
    expectRejected(doc, "dangling_reference", "script.sections[1].lines[0].claimIds[0]");
    doc = footageProduction();
    doc.research = null;
    expectRejected(doc, "dangling_reference", "script.sections[1].lines[0].claimIds[0]");
  });

  it("refuses a selected hook the script does not offer", () => {
    const doc = footageProduction();
    doc.script!.selectedHookId = "hook-ghost";
    expectRejected(doc, "dangling_reference", "script.selectedHookId");
  });

  it("refuses review comments about things that do not exist or another scene", () => {
    let doc = footageProduction();
    doc.review.comments[0].target = { kind: "clip", clipId: "clip-ghost" };
    expectRejected(doc, "dangling_reference", "review.comments[0].target.clipId");
    doc = footageProduction();
    doc.review.comments[0].target = { kind: "scene", sceneId: "scene-hook" };
    expectRejected(doc, "inconsistent", "storyboard.scenes[1].comments[0]");
    doc = footageProduction();
    doc.storyboard!.scenes[1].comments = ["comment-ghost"];
    expectRejected(doc, "dangling_reference", "storyboard.scenes[1].comments[0]");
    doc = footageProduction();
    doc.review.comments[0].target = { kind: "time-range", fromFrame: 30, toFrame: 10 };
    doc.storyboard!.scenes[1].comments = [];
    expectRejected(doc, "out_of_range", "review.comments[0].target");
  });

  it("refuses a review target with fields of another target kind", () => {
    const doc = footageProduction();
    (doc.review.comments[0] as { target: unknown }).target = { kind: "scene", clipId: "clip-v1" };
    expectRejected(doc, "missing_field", "review.comments[0].target.sceneId");
  });

  it("refuses a brief that relates to media the production does not use", () => {
    const doc = footageProduction();
    doc.brief.assetRelationships.push({ id: MEDIA.illustration, role: "Founder photo", source: "explicit", at: doc.createdAt });
    expectRejected(doc, "dangling_reference", "brief.assetRelationships[0].id");
  });
});

describe("workflows: footage, script and hybrid on one schema", () => {
  it("keeps each workflow's stages to its own", () => {
    expectRejected({ ...scriptProduction(), stage: "ingest" }, "workflow_mismatch", "stage");
    expectRejected({ ...scriptProduction(), stage: "selects" }, "workflow_mismatch", "stage");
    expectRejected({ ...footageProduction(), stage: "research" }, "workflow_mismatch", "stage");
    expectRejected({ ...footageProduction(), stage: "script" }, "workflow_mismatch", "stage");
    for (const stage of ["research", "ingest", "selects", "script"] as const) {
      const doc = hybridProduction();
      doc.stage = stage;
      expectAdmitted(doc);
    }
  });

  it("transcribes footage scripts and writes or generates script-workflow scripts", () => {
    let doc = footageProduction();
    doc.script!.origin = "written";
    expectRejected(doc, "workflow_mismatch", "script.origin");
    doc = scriptProduction();
    doc.script!.origin = "transcribed";
    expectRejected(doc, "workflow_mismatch", "script.origin");
  });

  it("keeps recorded speech out of script productions", () => {
    const doc = scriptProduction();
    doc.media.push({ mediaId: MEDIA.aRoll, role: "a-roll", label: "Stray footage" });
    doc.script!.sections[0].lines[0].spoken = { mediaId: MEDIA.aRoll, fromWordId: "w1", toWordId: "w2" };
    expectRejected(doc, "workflow_mismatch", "script.sections[0].lines[0].spoken");
    const aroll = scriptProduction();
    aroll.storyboard!.scenes[0].visual.layers.push({ kind: "a-roll", take: "selected" });
    expectRejected(aroll, "workflow_mismatch", "storyboard.scenes[0].visual.layers[3]");
  });

  it("keeps narration out of footage productions", () => {
    let doc = footageProduction();
    doc.media.push({ mediaId: MEDIA.narration, role: "narration", label: "Voice-over" });
    expectRejected(doc, "workflow_mismatch", "media[4].role");
    doc = footageProduction();
    doc.voice = scriptProduction().voice;
    expectRejected(doc, "workflow_mismatch", "voice");
  });

  it("anchors spoken lines to recorded footage only", () => {
    const doc = hybridProduction();
    doc.script!.sections[0].lines[0].spoken!.mediaId = MEDIA.narration;
    expectRejected(doc, "inconsistent", "script.sections[0].lines[0].spoken.mediaId");
  });

  it("lets a hybrid production hold both recorded and narrated speech", () => {
    const doc = hybridProduction();
    expect(doc.media.map((m) => m.role)).toEqual(expect.arrayContaining(["a-roll", "narration"]));
    expectAdmitted(doc);
  });

  it("requires a character for character lines", () => {
    const doc = scriptProduction();
    delete doc.script!.sections[0].lines[1].characterId;
    expectRejected(doc, "missing_field", "script.sections[0].lines[1].characterId");
  });

  it("refuses an update time before the creation time", () => {
    const doc = footageProduction();
    doc.updatedAt = "2026-11-03T00:00:00.000Z";
    expectRejected(doc, "inconsistent", "updatedAt");
  });
});

describe("the asset ledger, when supplied", () => {
  const ledger = (overrides: Record<string, LedgerMedia | undefined> = {}) => {
    const map = new Map<string, LedgerMedia>([
      [MEDIA.aRoll, { kind: "video", durationUs: 60_000_000 }],
      [MEDIA.bRoll, { kind: "video", durationUs: 10_000_000 }],
      [MEDIA.music, { kind: "audio", durationUs: 120_000_000 }],
      [MEDIA.logo, { kind: "image" }],
    ]);
    for (const [id, value] of Object.entries(overrides)) {
      if (value) map.set(id, value);
      else map.delete(id);
    }
    return map;
  };

  it("admits media registered with matching kinds and durations", () => {
    expectAdmitted(footageProduction(), { ledger: ledger() });
  });

  it("refuses media the ledger does not know", () => {
    expectRejected(footageProduction(), "dangling_reference", "media[3].mediaId", { ledger: ledger({ [MEDIA.logo]: undefined }) });
  });

  it("refuses a role whose kind differs from the ledger's", () => {
    expectRejected(footageProduction(), "inconsistent", "media[2].role", { ledger: ledger({ [MEDIA.music]: { kind: "image" } }) });
  });

  it("refuses a source range past the end of the media", () => {
    expectRejected(footageProduction(), "out_of_range", "timeline.tracks[1].clips[0].source.outUs", {
      ledger: ledger({ [MEDIA.bRoll]: { kind: "video", durationUs: 900_000 } }),
    });
  });

  it("is not needed for structural admission", () => {
    expectAdmitted(footageProduction());
  });
});
