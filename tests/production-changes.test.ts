import { describe, it, expect } from "vitest";

import { admitProduction } from "@/lib/video/production";
import {
  applyChangeSet,
  MAX_OPS_PER_CHANGE_SET,
  type ChangeSetResult,
  type ProductionOp,
} from "@/lib/video/production/changes";
import type { AudioClip, Clip, Production, VideoClip } from "@/types/production";
import { footageProduction, hybridProduction, MEDIA, scriptProduction } from "./helpers/production-fixtures";

const AT = "2026-11-04T11:00:00.000Z";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

function changeSet(doc: Production, ops: unknown[], extra: Record<string, unknown> = {}) {
  return { id: "cs-test", baseRevision: doc.revision, at: AT, by: "user", summary: "Test change", ops, ...extra };
}

/** Applies to a frozen production and checks the production is unchanged. */
function apply(doc: Production, cs: unknown, options?: Parameters<typeof applyChangeSet>[2]): ChangeSetResult {
  const before = JSON.stringify(doc);
  const result = applyChangeSet(deepFreeze(doc), cs, options);
  expect(JSON.stringify(doc), "the production passed in must never change").toBe(before);
  return result;
}

function applied(result: ChangeSetResult): Production {
  if (result.status !== "applied") throw new Error(JSON.stringify(result, null, 1));
  expect(admitProduction(result.production).ok).toBe(true);
  return result.production;
}

function rejected(result: ChangeSetResult, stage: string, code?: string) {
  if (result.status !== "rejected") throw new Error(`expected rejection, got ${result.status}`);
  expect(result.stage).toBe(stage);
  if (code) expect(result.issues.map((i) => i.code)).toContain(code);
  return result.issues;
}

const allClips = (doc: Production): Clip[] => doc.timeline.tracks.flatMap((t) => t.clips as Clip[]);
const clip = (doc: Production, id: string) => allClips(doc).find((c) => c.id === id)!;
const scene = (doc: Production, id: string) => doc.storyboard!.scenes.find((s) => s.id === id)!;

// ---------------------------------------------------------------------------

describe("a change set is one atomic, revisioned transition", () => {
  it("applies, advances the revision and stamps the update time", () => {
    const doc = footageProduction();
    const next = applied(apply(doc, changeSet(doc, [{ op: "renameProduction", name: "Agents, looped" }])));
    expect(next.name).toBe("Agents, looped");
    expect(next.revision).toBe(doc.revision + 1);
    expect(next.updatedAt).toBe(AT);
    expect(next).not.toBe(doc);
  });

  it("is a conflict when made against another revision, and changes nothing", () => {
    const doc = footageProduction();
    const result = apply(doc, { ...changeSet(doc, [{ op: "renameProduction", name: "Late" }]), baseRevision: doc.revision - 1 });
    expect(result).toMatchObject({ status: "conflict", reason: "stale_revision", expectedRevision: 6, actualRevision: 7 });
  });

  it("rejects the whole change set when any operation fails, even after earlier ones succeeded", () => {
    const doc = footageProduction();
    const result = apply(doc, changeSet(doc, [
      { op: "renameProduction", name: "Half applied?" },
      { op: "removeMarker", markerId: "marker-ghost" },
    ]));
    const issues = rejected(result, "operations", "not_found");
    expect(issues[0]).toMatchObject({ opIndex: 1 });
  });

  it("rejects a result that is not a valid production, with the admission issues", () => {
    const doc = footageProduction();
    const result = apply(doc, changeSet(doc, [{ op: "moveClip", clipId: "clip-v2", start: 30 }]));
    rejected(result, "admission", "overlap");
  });

  it("is deterministic: the same change on the same production gives the same result", () => {
    const ops = [
      { op: "trimClip", clipId: "clip-b1", edge: "out", toFrame: 95 },
      { op: "addMarker", marker: { id: "m-2", fromFrame: 0, toFrame: 10, note: "Check the hook", kind: "note" } },
    ];
    const a = applyChangeSet(footageProduction(), changeSet(footageProduction(), ops));
    const b = applyChangeSet(footageProduction(), changeSet(footageProduction(), ops));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("change sets and operations are strict", () => {
  it("rejects malformed envelopes", () => {
    const doc = footageProduction();
    const ok = changeSet(doc, [{ op: "renameProduction", name: "x" }]);
    for (const bad of [
      null,
      { ...ok, id: "../x" },
      { ...ok, at: "now" },
      { ...ok, by: "admin" },
      { ...ok, ops: [] },
      { ...ok, extra: true },
      { ...ok, scope: { sceneIds: ["ok"], extra: 1 } },
    ]) {
      rejected(apply(doc, bad), "change_set");
    }
  });

  it("limits the number of operations in one change set", () => {
    const doc = footageProduction();
    const ops = Array.from({ length: MAX_OPS_PER_CHANGE_SET + 1 }, () => ({ op: "renameProduction", name: "x" }));
    rejected(apply(doc, changeSet(doc, ops)), "change_set", "limit_exceeded");
  });

  it("refuses unknown operations and unknown fields; there is no generic path patch", () => {
    const doc = footageProduction();
    rejected(apply(doc, changeSet(doc, [{ op: "setPath", path: "revision", value: 99 }])), "change_set", "unknown_op");
    rejected(apply(doc, changeSet(doc, [{ op: "renameProduction", name: "x", brandId: "other" }])), "change_set", "invalid_op");
    rejected(apply(doc, changeSet(doc, [JSON.parse('{"op":"renameProduction","name":"x","__proto__":{"a":1}}')])), "change_set", "invalid_op");
  });

  it("refuses server-owned fields in patches and new entities", () => {
    const doc = footageProduction();
    rejected(apply(doc, changeSet(doc, [{ op: "editScene", sceneId: "scene-point", patch: { status: "final" } }])), "change_set", "invalid_op");
    rejected(apply(doc, changeSet(doc, [{ op: "editScene", sceneId: "scene-point", patch: { approvals: [] } }])), "change_set", "invalid_op");
    const newClip = { ...clip(doc, "clip-logo"), id: "clip-logo-2", start: 20 };
    rejected(apply(doc, changeSet(doc, [{ op: "insertClip", trackId: "track-overlay", clip: newClip }])), "change_set", "invalid_op");
  });

  it("validates whole entities an operation adds through admission", () => {
    const doc = footageProduction();
    const line = { id: "line-3", speaker: "on-camera", text: "And repeat.", claimIds: [], mood: "happy" };
    rejected(apply(doc, changeSet(doc, [{ op: "insertScriptLine", sectionId: "sec-point", afterLineId: "line-2", line }])), "admission", "unknown_field");
  });
});

describe("timeline operations keep source and frames consistent", () => {
  it("inserts a clip with provenance set by the engine", () => {
    const doc = footageProduction();
    const { provenance: _ignored, ...logo } = clip(doc, "clip-logo");
    void _ignored;
    const next = applied(apply(doc, changeSet(doc, [{ op: "insertClip", trackId: "track-overlay", clip: { ...logo, id: "clip-logo-2", start: 90 } }], { id: "cs-logo" })));
    expect(clip(next, "clip-logo-2").provenance).toEqual({ by: "user", changeSetId: "cs-logo" });
  });

  it("trims either edge and moves the source point with it", () => {
    const doc = footageProduction();
    const next = applied(apply(doc, changeSet(doc, [
      { op: "trimClip", clipId: "clip-v2", edge: "in", toFrame: 75 },
      { op: "trimClip", clipId: "clip-a2", edge: "out", toFrame: 90 },
    ])));
    expect(clip(next, "clip-v2")).toMatchObject({ start: 75, duration: 30, source: { inUs: 3_000_000, outUs: 4_000_000 } });
    expect(clip(next, "clip-a2")).toMatchObject({ start: 60, duration: 30, source: { inUs: 2_500_000, outUs: 3_500_000 } });
  });

  it("splits a clip into two that cover the same source, dividing keyframes and fades", () => {
    const doc = footageProduction();
    const next = applied(apply(doc, changeSet(doc, [{ op: "splitClip", clipId: "clip-m1", atFrame: 50, newClipId: "clip-m2" }])));
    const left = clip(next, "clip-m1") as AudioClip;
    const right = clip(next, "clip-m2") as AudioClip;
    expect(left).toMatchObject({ start: 0, duration: 50, fadeInFrames: 10 });
    expect(left.fadeOutFrames).toBeUndefined();
    expect(right).toMatchObject({ start: 50, duration: 55, fadeOutFrames: 15 });
    expect(right.fadeInFrames).toBeUndefined();
    expect(left.source.outUs).toBe(right.source.inUs);
    expect(left.source.inUs).toBe(0);
    expect(right.source.outUs).toBe(3_500_000);
    expect(left.gainDb.map((k) => k.frame)).toEqual([0]);
    expect(right.gainDb.map((k) => k.frame)).toEqual([10]);
  });

  it("refuses a split outside the clip", () => {
    const doc = footageProduction();
    rejected(apply(doc, changeSet(doc, [{ op: "splitClip", clipId: "clip-m1", atFrame: 105, newClipId: "clip-m2" }])), "operations", "invalid_op");
  });

  it("removes with ripple, shifting later clips on the track, in one atomic change", () => {
    const doc = footageProduction();
    const next = applied(apply(doc, changeSet(doc, [
      { op: "setSceneRealization", sceneId: "scene-hook", realization: { clipIds: ["clip-v1"], materializedAtRevision: 6, fingerprint: "fp-hook", diverged: true } },
      { op: "removeClip", clipId: "clip-a1", ripple: true },
    ])));
    expect(clip(next, "clip-a1")).toBeUndefined();
    expect(clip(next, "clip-a2").start).toBe(0);
  });

  it("sets keyframes, fades, transitions and graphic parameters on the right clip kinds only", () => {
    const doc = footageProduction();
    const next = applied(apply(doc, changeSet(doc, [
      { op: "setClipKeyframes", clipId: "clip-v2", property: "gainDb", keyframes: [{ frame: 0, value: -3 }] },
      { op: "setClipFades", clipId: "clip-a2", fadeInFrames: 5, fadeOutFrames: 0 },
      { op: "setClipTransition", clipId: "clip-b1", transition: null },
      { op: "setGraphicParams", clipId: "clip-captions", params: { style: "calm" } },
    ])));
    expect((clip(next, "clip-v2") as VideoClip).audio?.gainDb).toEqual([{ frame: 0, value: -3 }]);
    expect((clip(next, "clip-a2") as AudioClip).fadeInFrames).toBe(5);
    expect((clip(next, "clip-b1") as VideoClip).transitionIn).toBeUndefined();
    rejected(apply(doc, changeSet(doc, [{ op: "setClipTransition", clipId: "clip-a2", transition: null }])), "operations", "invalid_op");
    rejected(apply(doc, changeSet(doc, [{ op: "setGraphicParams", clipId: "clip-v1", params: {} }])), "operations", "invalid_op");
    rejected(apply(doc, changeSet(doc, [{ op: "setClipKeyframes", clipId: "clip-captions", property: "framing", keyframes: [] }])), "operations", "invalid_op");
  });

  it("refuses removing a track that still has clips", () => {
    const doc = footageProduction();
    rejected(apply(doc, changeSet(doc, [{ op: "removeTrack", trackId: "track-overlay" }])), "operations", "invalid_op");
  });
});

describe("script, storyboard and review operations", () => {
  it("inserts and edits script lines and links new lines to scenes", () => {
    const doc = scriptProduction();
    const next = applied(apply(doc, changeSet(doc, [
      { op: "insertScriptLine", sectionId: "sec-1", afterLineId: "nl-2", line: { id: "nl-3", speaker: "narrator", text: "Now exhale slowly.", claimIds: [] } },
      { op: "editScriptLine", lineId: "nl-1", text: "Breathe like this for sixty seconds.", estimatedMs: 2_000 },
      { op: "editScene", sceneId: "scene-b1", patch: { scriptLineIds: ["nl-1", "nl-2", "nl-3"] } },
    ])));
    expect(next.script!.sections[0].lines.map((l) => l.id)).toEqual(["nl-1", "nl-2", "nl-3"]);
    expect(scene(next, "scene-b1").scriptLineIds).toContain("nl-3");
  });

  it("refuses removing a script line a scene still uses", () => {
    const doc = scriptProduction();
    rejected(apply(doc, changeSet(doc, [{ op: "removeScriptLine", lineId: "nl-1" }])), "admission", "dangling_reference");
  });

  it("adds scenes as proposed with engine-set provenance", () => {
    const doc = hybridProduction();
    const newScene = {
      id: "scene-h3",
      title: "Call to action",
      purpose: "cta",
      scriptLineIds: [],
      durationTargetMs: { min: 1_000, max: 3_000 },
      visual: { mode: "title-card", description: "Follow for part two", layers: [] },
      audio: { sfx: [] },
      captions: { emphasisWordIds: [] },
      slots: [],
      frames: [],
    };
    const next = applied(apply(doc, changeSet(doc, [{ op: "addScene", scene: newScene, afterSceneId: "scene-h2" }], { id: "cs-add" })));
    expect(scene(next, "scene-h3")).toMatchObject({ status: "proposed", approvals: [], comments: [], provenance: { by: "user", changeSetId: "cs-add" } });
  });

  it("follows the scene lifecycle and records approvals at the new revision", () => {
    const doc = hybridProduction();
    const next = applied(apply(doc, changeSet(doc, [{ op: "setSceneStatus", sceneId: "scene-h1", status: "approved" }])));
    expect(scene(next, "scene-h1").approvals).toEqual([{ by: "user", at: AT, revision: 10, scope: "plan" }]);
    rejected(apply(doc, changeSet(doc, [{ op: "setSceneStatus", sceneId: "scene-h1", status: "final" }])), "operations", "invalid_transition");
  });

  it("returns an edited approved scene to proposed, withdrawing the approval", () => {
    const doc = scriptProduction();
    const next = applied(apply(doc, changeSet(doc, [{ op: "editScene", sceneId: "scene-b1", patch: { title: "Box breathing" } }])));
    expect(scene(next, "scene-b1").status).toBe("proposed");
  });

  it("never changes a locked scene", () => {
    const doc = footageProduction();
    doc.storyboard!.scenes[0].status = "locked";
    rejected(apply(doc, changeSet(doc, [{ op: "editScene", sceneId: "scene-hook", patch: { title: "x" } }])), "operations", "forbidden");
    rejected(apply(doc, changeSet(doc, [{ op: "removeScene", sceneId: "scene-hook" }])), "operations", "forbidden");
    rejected(apply(doc, changeSet(doc, [{ op: "trimClip", clipId: "clip-v1", edge: "out", toFrame: 50 }])), "scope", "forbidden");
  });

  it("reorders scenes only as a permutation", () => {
    const doc = footageProduction();
    const next = applied(apply(doc, changeSet(doc, [{ op: "reorderScenes", sceneIds: ["scene-point", "scene-hook"] }])));
    expect(next.storyboard!.scenes.map((s) => s.id)).toEqual(["scene-point", "scene-hook"]);
    rejected(apply(doc, changeSet(doc, [{ op: "reorderScenes", sceneIds: ["scene-point"] }])), "operations", "invalid_op");
  });

  it("adds comments linked to their scene and resolves them once", () => {
    const doc = footageProduction();
    const next = applied(apply(doc, changeSet(doc, [
      { op: "addComment", comment: { id: "comment-2", target: { kind: "scene", sceneId: "scene-hook" }, text: "Punchier, please", kind: "change-request" } },
      { op: "resolveComment", commentId: "comment-1", note: "Swapped the shot" },
    ], { id: "cs-review" })));
    expect(scene(next, "scene-hook").comments).toEqual(["comment-2"]);
    expect(next.review.comments[0].resolution).toEqual({ by: "user", at: AT, changeSetId: "cs-review", note: "Swapped the shot" });
    rejected(apply(next, changeSet(next, [{ op: "resolveComment", commentId: "comment-1" }])), "operations", "invalid_op");
  });

  it("adds media before using it, and refuses removing media in use", () => {
    const doc = footageProduction();
    const sfx = { kind: "audio", id: "clip-sfx", start: 0, duration: 3, source: { mediaId: MEDIA.sfx, inUs: 0, outUs: 100_000 }, gainDb: [] };
    applied(apply(doc, changeSet(doc, [
      { op: "addMedia", media: { mediaId: MEDIA.sfx, role: "sfx", label: "Whoosh" } },
      { op: "insertClip", trackId: "track-music", clip: { ...sfx, start: 105 } },
    ])));
    rejected(apply(doc, changeSet(doc, [{ op: "removeMedia", mediaId: MEDIA.bRoll }])), "admission", "dangling_reference");
  });
});

describe("actors, agent runs and scope", () => {
  const run = { runId: "run-1", scope: null };
  const agent = (doc: Production, ops: unknown[], extra: Record<string, unknown> = {}) =>
    changeSet(doc, ops, { by: "agent", runId: "run-1", ...extra });

  it("requires agent changes to belong to the open run", () => {
    const doc = footageProduction();
    rejected(apply(doc, changeSet(doc, [{ op: "renameProduction", name: "x" }], { by: "agent" })), "change_set", "forbidden");
    expect(apply(doc, agent(doc, [{ op: "renameProduction", name: "x" }]))).toMatchObject({ status: "conflict", reason: "no_open_run" });
    expect(apply(doc, changeSet(doc, [{ op: "renameProduction", name: "x" }]), { run })).toMatchObject({ status: "conflict", reason: "run_in_progress" });
  });

  it("keeps approvals, stage gates and realisation records away from agents and the system", () => {
    const doc = hybridProduction();
    rejected(apply(doc, agent(doc, [{ op: "setSceneStatus", sceneId: "scene-h1", status: "approved" }]), { run }), "operations", "forbidden");
    rejected(apply(doc, changeSet(doc, [{ op: "setSceneStatus", sceneId: "scene-h1", status: "approved" }], { by: "system" })), "operations", "forbidden");
    rejected(apply(doc, agent(doc, [{ op: "setStage", stage: "finishing" }]), { run }), "operations", "forbidden");
    rejected(apply(doc, agent(doc, [{ op: "setScriptStatus", status: "approved" }]), { run }), "operations", "forbidden");
  });

  it("stops an agent changing an approved or realised scene it was not asked to change", () => {
    const doc = footageProduction();
    const edit = [{ op: "trimClip", clipId: "clip-b1", edge: "out", toFrame: 95 }];
    rejected(apply(doc, agent(doc, edit), { run }), "scope", "out_of_scope");
    applied(apply(doc, agent(doc, edit), { run: { runId: "run-1", scope: ["scene-point"] } }));
  });

  it("lets a scoped change touch only its scenes' footprint", () => {
    const doc = footageProduction();
    const scoped = { run: { runId: "run-1", scope: ["scene-point"] } };
    rejected(apply(doc, agent(doc, [{ op: "renameProduction", name: "x" }]), scoped), "scope", "out_of_scope");
    rejected(apply(doc, agent(doc, [{ op: "setClipKeyframes", clipId: "clip-m1", property: "gainDb", keyframes: [] }]), scoped), "scope", "out_of_scope");
    rejected(apply(doc, agent(doc, [{ op: "editScene", sceneId: "scene-point", patch: { title: "x" } }], { scope: { sceneIds: ["scene-hook"] } }), scoped), "scope", "out_of_scope");
    applied(apply(doc, agent(doc, [{ op: "addComment", comment: { id: "c-agent", target: { kind: "scene", sceneId: "scene-point" }, text: "Swapped to a calmer shot?", kind: "question" } }]), scoped));
  });

  it("allows one uniform ripple of other scenes' clips after a targeted change, and nothing else", () => {
    const doc = hybridProduction();
    const scoped = { run: { runId: "run-1", scope: ["scene-h1"] } };
    const shorten = [
      { op: "trimClip", clipId: "hx-v1", edge: "out", toFrame: 45 },
      { op: "trimClip", clipId: "hx-a1", edge: "out", toFrame: 45 },
    ];
    const ripple = (delta: number, clickDelta: number) => [
      ...shorten,
      { op: "moveClip", clipId: "hx-diagram", start: 60 + delta },
      { op: "moveClip", clipId: "hx-narr", start: 60 + delta },
      { op: "moveClip", clipId: "hx-click", start: 70 + clickDelta },
    ];
    const next = applied(apply(doc, agent(doc, ripple(-15, -15)), scoped));
    expect(clip(next, "hx-diagram").start).toBe(45);
    rejected(apply(doc, agent(doc, ripple(-15, -10)), scoped), "scope", "out_of_scope");
  });

  it("refuses a change that widens its run's scope", () => {
    const doc = footageProduction();
    const result = apply(doc, agent(doc, [{ op: "renameProduction", name: "x" }], { scope: { sceneIds: ["scene-hook"] } }), {
      run: { runId: "run-1", scope: ["scene-point"] },
    });
    rejected(result, "scope", "out_of_scope");
  });
});

describe("property: random edits are atomic and never corrupt a production", () => {
  it("either applies an admitted production or changes nothing, for every workflow", () => {
    let seed = 0x5eed;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const builders = [footageProduction, scriptProduction, hybridProduction];
    let appliedCount = 0;

    for (let round = 0; round < 200; round++) {
      let doc = builders[round % 3]();
      for (let step = 0; step < 4; step++) {
        const clips = allClips(doc);
        const target = pick(clips);
        const frame = Math.floor(random() * 200) - 20;
        const op: ProductionOp | Record<string, unknown> = pick([
          { op: "moveClip", clipId: target.id, start: frame },
          { op: "trimClip", clipId: target.id, edge: pick(["in", "out"] as const), toFrame: frame },
          { op: "splitClip", clipId: target.id, atFrame: frame, newClipId: `split-${round}-${step}` },
          { op: "removeClip", clipId: target.id, ripple: random() < 0.5 },
          { op: "addMarker", marker: { id: `mk-${round}-${step}`, fromFrame: Math.max(0, frame), toFrame: Math.max(0, frame) + 5, note: "n", kind: "note" } },
          { op: "renameProduction", name: pick(["A", "", "B".repeat(300)]) },
          { op: pick(["editScene", "bogus"]), sceneId: "nope", patch: {} },
        ]);
        const before = JSON.stringify(doc);
        const result = applyChangeSet(deepFreeze(doc), changeSet(doc, [op], { id: `cs-${round}-${step}` }));
        expect(JSON.stringify(doc)).toBe(before);
        if (result.status === "applied") {
          expect(admitProduction(result.production).ok).toBe(true);
          expect(result.production.revision).toBe(doc.revision + 1);
          doc = result.production;
          appliedCount++;
        } else {
          expect(result.status).toBe("rejected");
        }
      }
    }
    // The generator must exercise both outcomes, or the property proves little.
    expect(appliedCount).toBeGreaterThan(50);
  });
});

describe("property: a scoped agent run never changes what it was not asked to change", () => {
  /** Each scene's clips and the rest of the timeline, without starts and provenance (which a ripple may change). */
  const outsideContent = (doc: Production, scope: string) =>
    JSON.stringify({
      scenes: doc.storyboard!.scenes.filter((s) => s.id !== scope).map((s) => ({ ...s, comments: undefined })),
      clips: allClips(doc)
        .filter((c) => c.sceneId !== scope)
        .map((c) => ({ ...c, start: undefined, provenance: undefined }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      name: doc.name,
      brief: doc.brief,
      media: doc.media,
    });

  it("leaves every other scene and clip as it was, whatever the agent tries", () => {
    let seed = 0xa9e7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const cases = [
      { build: footageProduction, scope: "scene-point" },
      { build: hybridProduction, scope: "scene-h1" },
      { build: scriptProduction, scope: "scene-b1" },
    ];
    const outcomes = { applied: 0, refused: 0 };

    for (let round = 0; round < 150; round++) {
      const { build, scope } = cases[round % cases.length];
      const doc = build();
      const clips = allClips(doc);
      const target = pick(clips);
      const frame = Math.floor(random() * 160);
      const ops = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, k) =>
        pick([
          { op: "moveClip", clipId: pick(clips).id, start: frame + k },
          { op: "trimClip", clipId: target.id, edge: pick(["in", "out"] as const), toFrame: frame },
          { op: "removeClip", clipId: pick(clips).id, ripple: random() < 0.5 },
          { op: "setClipScene", clipId: pick(clips).id, sceneId: scope },
          { op: "editScene", sceneId: pick(doc.storyboard!.scenes).id, patch: { title: "Agent title" } },
          { op: "renameProduction", name: "Agent name" },
          { op: "updateBrief", patch: { tone: "breezy" } },
        ])
      );
      const result = apply(doc, changeSet(doc, ops, { by: "agent", runId: "run-p", id: `cs-p${round}` }), { run: { runId: "run-p", scope: [scope] } });
      if (result.status === "applied") {
        outcomes.applied++;
        expect(outsideContent(result.production, scope)).toBe(outsideContent(doc, scope));
      } else {
        outcomes.refused++;
        expect(result.status).toBe("rejected");
      }
    }
    expect(outcomes.applied).toBeGreaterThan(10);
    expect(outcomes.refused).toBeGreaterThan(10);
  });
});
