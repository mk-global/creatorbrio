/**
 * Guards that keep a change to what it claims to change (spec 04 §3, §7).
 *
 * They compare the production before and after a change set rather than
 * trusting each operation, so no combination of operations can slip past them.
 *
 * - A locked scene's content never changes.
 * - An agent changes a scene that a person approved (approved, producing,
 *   realized or final) only when the change set names that scene in its scope.
 * - A change set with a scope changes nothing outside the named scenes'
 *   footprint: their scene records, the clips they own and the script lines
 *   only they use. The one exception is a single ripple: clips of other scenes
 *   that start after some point may all shift by the same number of frames,
 *   which is what shortening or lengthening a targeted scene does downstream.
 *   Media may be added, but no listed media may change or disappear.
 */

import type { Clip, Production, Scene, SceneStatus, ScriptLine } from "@/types/production";
import type { Actor, ChangeIssue } from "./types";

const PROTECTED: readonly SceneStatus[] = ["approved", "producing", "realized", "final"];

function allClips(doc: Production): Clip[] {
  return doc.timeline.tracks.flatMap((t) => t.clips as Clip[]);
}

function allLines(doc: Production): ScriptLine[] {
  return doc.script?.sections.flatMap((s) => s.lines) ?? [];
}

/**
 * Everything that makes up one scene's content: the scene record (without its
 * review comments), the clips it owns (without their start frame, which a
 * ripple may move, or their provenance, which records who last moved them)
 * and the script lines it uses.
 */
function footprint(doc: Production, sceneId: string): string | null {
  const scene = doc.storyboard?.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;
  const sceneContent: Partial<Scene> = { ...scene };
  delete sceneContent.comments;
  const clips = allClips(doc)
    .filter((c) => c.sceneId === sceneId)
    .map((c) => ({ ...c, start: undefined, provenance: undefined }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const lines = allLines(doc).filter((l) => scene.scriptLineIds.includes(l.id));
  return JSON.stringify({ scene: sceneContent, clips, lines });
}

export function checkProtectedScenes(before: Production, after: Production, by: Actor, scope: Set<string> | null): ChangeIssue[] {
  const issues: ChangeIssue[] = [];
  before.storyboard?.scenes.forEach((scene, i) => {
    const changed = footprint(before, scene.id) !== footprint(after, scene.id);
    if (!changed) return;
    const path = `storyboard.scenes[${i}]`;
    if (scene.status === "locked") {
      issues.push({ opIndex: null, path, code: "forbidden", message: "a locked scene cannot change" });
    } else if (by === "agent" && PROTECTED.includes(scene.status) && !scope?.has(scene.id)) {
      issues.push({ opIndex: null, path, code: "out_of_scope", message: `an agent may change this ${scene.status} scene only when the change names it in its scope` });
    }
  });
  return issues;
}

/**
 * The production as seen from outside the scoped scenes. Clip starts are held
 * aside for the ripple check; clip provenance is left out because a ripple
 * move stamps it without changing what the clip shows.
 */
function outside(doc: Production, scope: Set<string>) {
  const inScope = (s: { sceneId?: string }) => s.sceneId !== undefined && scope.has(s.sceneId);
  const scopeScenes = doc.storyboard?.scenes.filter((s) => scope.has(s.id)) ?? [];
  const otherScenes = doc.storyboard?.scenes.filter((s) => !scope.has(s.id)) ?? [];
  const usedOutside = new Set(otherScenes.flatMap((s) => s.scriptLineIds));
  const exclusive = new Set(scopeScenes.flatMap((s) => s.scriptLineIds).filter((id) => !usedOutside.has(id)));
  const starts = new Map<string, number>();

  const view = {
    ...doc,
    revision: undefined,
    updatedAt: undefined,
    media: undefined,
    storyboard: doc.storyboard && { ...doc.storyboard, scenes: otherScenes },
    script: doc.script && {
      ...doc.script,
      sections: doc.script.sections.map((s) => ({ ...s, lines: s.lines.filter((l) => !exclusive.has(l.id)) })),
    },
    timeline: {
      ...doc.timeline,
      tracks: doc.timeline.tracks.map((t) => ({
        ...t,
        clips: (t.clips as Clip[])
          .filter((c) => !inScope(c))
          .map((c) => {
            starts.set(c.id, c.start);
            return { ...c, start: undefined, provenance: undefined };
          })
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      })),
    },
    review: {
      comments: doc.review.comments.filter(
        (c) => !((c.target.kind === "scene" || c.target.kind === "scene-element") && scope.has(c.target.sceneId))
      ),
    },
  };
  return { view: JSON.stringify(view), starts };
}

export function checkScope(before: Production, after: Production, scope: Set<string>): ChangeIssue[] {
  const issues: ChangeIssue[] = [];
  const a = outside(before, scope);
  const b = outside(after, scope);
  if (a.view !== b.view) {
    issues.push({ opIndex: null, path: "", code: "out_of_scope", message: "the change alters content outside the scenes in its scope" });
  }

  // A single ripple: sorted by their original start, unchanged clips come first, then clips that all moved by one delta.
  const moved = [...a.starts.entries()]
    .filter(([id]) => b.starts.has(id))
    .sort((x, y) => x[1] - y[1])
    .map(([id, start]) => b.starts.get(id)! - start);
  let delta = 0;
  for (const d of moved) {
    if (d === delta) continue;
    if (delta === 0 && d !== 0) {
      delta = d;
      continue;
    }
    issues.push({ opIndex: null, path: "timeline", code: "out_of_scope", message: "clips outside the scope moved by more than one uniform ripple" });
    break;
  }

  const afterMedia = new Map(after.media.map((m) => [m.mediaId, JSON.stringify(m)]));
  before.media.forEach((m, i) => {
    if (afterMedia.get(m.mediaId) !== JSON.stringify(m)) {
      issues.push({ opIndex: null, path: `media[${i}]`, code: "out_of_scope", message: "a scoped change may add media but not change or remove it" });
    }
  });
  return issues;
}
