/**
 * Document invariants (spec 07 §1, §6; merged research 05 §3 "Invariants").
 *
 * These run only on a document whose every field already has the right shape,
 * so they can rely on the types. They check what no single field can:
 * identifiers, references between sections, the source/timeline time model,
 * overlaps, and consistency between the workflow, the stage and the content.
 */

import type {
  Clip,
  MediaKind,
  MediaRole,
  Production,
  ProductionStage,
  SceneStatus,
  Workflow,
} from "@/types/production";
import type { CapabilityCatalog } from "@/lib/video/capabilities/types";
import { at, type Issues } from "./primitives";
import { durationMatchesSourceSpan, maxTimelineFrames } from "./time";

/** What the asset ledger knows about a media file, when the caller can supply it. */
export interface LedgerMedia {
  kind: MediaKind;
  /** Duration of audio/video media in microseconds, when known. */
  durationUs?: number;
}

export interface InvariantContext {
  /**
   * The asset ledger's view of media, keyed by media id. When provided, every
   * media reference must be registered there with a matching kind, and every
   * source range must lie within the media's duration.
   */
  ledger?: ReadonlyMap<string, LedgerMedia>;
  /**
   * The native capabilities (#144). When provided, every graphics clip whose
   * capability id and version the catalog knows must have parameters that
   * capability accepts for the clip's length and the production's format.
   * Capabilities the catalog does not know stay admissible; the compiler
   * refuses them at export.
   */
  capabilities?: CapabilityCatalog;
}

export const MEDIA_ROLE_KIND: Record<MediaRole, MediaKind> = {
  "a-roll": "video",
  "b-roll": "video",
  narration: "audio",
  music: "audio",
  sfx: "audio",
  image: "image",
  logo: "image",
};

/** Stages each workflow passes through (spec 07 §8). */
export const WORKFLOW_STAGES: Record<Workflow, readonly ProductionStage[]> = {
  footage: ["brief", "ingest", "selects", "storyboard", "production", "assembly", "review", "finishing", "delivered", "archived"],
  script: ["brief", "research", "script", "storyboard", "production", "assembly", "review", "finishing", "delivered", "archived"],
  hybrid: [
    "brief",
    "research",
    "script",
    "ingest",
    "selects",
    "storyboard",
    "production",
    "assembly",
    "review",
    "finishing",
    "delivered",
    "archived",
  ],
};

const RECORDED = (w: Workflow) => w === "footage" || w === "hybrid";
const SYNTHESISED = (w: Workflow) => w === "script" || w === "hybrid";
const REALISED_STATUSES: readonly SceneStatus[] = ["realized", "final", "locked"];

export function checkInvariants(issues: Issues, doc: Production, context: InvariantContext = {}): void {
  const media = checkMediaRefs(issues, doc, context);
  checkUniqueIds(issues, doc);
  checkWorkflow(issues, doc);
  checkTimes(issues, doc);

  const lines = new Map<string, string>();
  doc.script?.sections.forEach((s, i) =>
    s.lines.forEach((l, j) => lines.set(l.id, at(at(at(at("script", "sections"), i), "lines"), j)))
  );
  const claims = new Set(doc.research?.claims.map((c) => c.id) ?? []);
  const scenes = new Set(doc.storyboard?.scenes.map((s) => s.id) ?? []);
  const comments = new Map(doc.review.comments.map((c) => [c.id, c]));
  const clips = new Map<string, Clip>();
  doc.timeline.tracks.forEach((t) => t.clips.forEach((c) => clips.set(c.id, c)));

  checkResearch(issues, doc);
  checkScript(issues, doc, media, claims);
  checkStoryboard(issues, doc, { lines, claims, media, comments, clips });
  checkTimeline(issues, doc, media, scenes, context);
  if (context.capabilities) checkCapabilities(issues, doc, context.capabilities);
  checkReview(issues, doc, { lines, scenes, clips, media });

  doc.brief.assetRelationships.forEach((r, i) => {
    if (!media.has(r.id)) {
      issues.add(at(at(at("brief", "assetRelationships"), i), "id"), "dangling_reference", "refers to media this production does not use");
    }
  });
}

/** Media references: unique, consistent with the workflow and, when supplied, with the ledger. */
function checkMediaRefs(issues: Issues, doc: Production, context: InvariantContext): Map<string, MediaRole> {
  const media = new Map<string, MediaRole>();
  doc.media.forEach((m, i) => {
    const p = at("media", i);
    if (media.has(m.mediaId)) issues.add(at(p, "mediaId"), "duplicate_id", "this media is listed more than once");
    media.set(m.mediaId, m.role);
    if (m.role === "narration" && !SYNTHESISED(doc.workflow)) {
      issues.add(at(p, "role"), "workflow_mismatch", "narration media belongs to script or hybrid productions");
    }
    const known = context.ledger?.get(m.mediaId);
    if (context.ledger && !known) {
      issues.add(at(p, "mediaId"), "dangling_reference", "this media is not registered in the asset ledger");
    } else if (known && known.kind !== MEDIA_ROLE_KIND[m.role]) {
      issues.add(at(p, "role"), "inconsistent", `the role needs ${MEDIA_ROLE_KIND[m.role]} media but the ledger records ${known.kind}`);
    }
  });
  return media;
}

/**
 * Every entity inside a production has its own id, unique across the whole
 * document, so a review target, an agent's change or a provenance record can
 * name it without ambiguity. Media ids, which are content hashes, are checked
 * separately; references to things outside the document (brands, voices,
 * capabilities, words in a transcript) are not entities of the document.
 */
function checkUniqueIds(issues: Issues, doc: Production): void {
  const seen = new Map<string, string>();
  const claim = (value: string, path: string) => {
    const first = seen.get(value);
    if (first !== undefined) issues.add(path, "duplicate_id", `this id is already used at ${first}`);
    else seen.set(value, path);
  };

  claim(doc.id, "id");
  doc.deliverables.forEach((d, i) => claim(d.id, at(at("deliverables", i), "id")));
  doc.research?.sources.forEach((s, i) => claim(s.id, at(at("research.sources", i), "id")));
  doc.research?.claims.forEach((c, i) => claim(c.id, at(at("research.claims", i), "id")));
  doc.script?.hookOptions.forEach((h, i) => claim(h.id, at(at("script.hookOptions", i), "id")));
  doc.script?.sections.forEach((s, i) => {
    const sp = at("script.sections", i);
    claim(s.id, at(sp, "id"));
    s.lines.forEach((l, j) => claim(l.id, at(at(at(sp, "lines"), j), "id")));
  });
  if (doc.storyboard) {
    claim(doc.storyboard.id, "storyboard.id");
    doc.storyboard.scenes.forEach((s, i) => {
      const sp = at("storyboard.scenes", i);
      claim(s.id, at(sp, "id"));
      s.slots.forEach((slot, j) => claim(slot.id, at(at(at(sp, "slots"), j), "id")));
      s.frames.forEach((f, j) => claim(f.id, at(at(at(sp, "frames"), j), "id")));
    });
  }
  doc.timeline.tracks.forEach((t, i) => {
    const tp = at("timeline.tracks", i);
    claim(t.id, at(tp, "id"));
    t.clips.forEach((c, j) => {
      const cp = at(at(tp, "clips"), j);
      claim(c.id, at(cp, "id"));
      if (c.kind === "video" || c.kind === "still") c.effects?.forEach((e, k) => claim(e.id, at(at(at(cp, "effects"), k), "id")));
    });
  });
  doc.timeline.markers.forEach((m, i) => claim(m.id, at(at("timeline.markers", i), "id")));
  doc.review.comments.forEach((c, i) => claim(c.id, at(at("review.comments", i), "id")));
}

/** The stage and the content must belong to the production's workflow. */
function checkWorkflow(issues: Issues, doc: Production): void {
  const w = doc.workflow;
  if (!WORKFLOW_STAGES[w].includes(doc.stage)) {
    issues.add("stage", "workflow_mismatch", `a ${w} production has no ${doc.stage} stage`);
  }
  if (doc.script) {
    const origin = doc.script.origin;
    if (w === "footage" && origin !== "transcribed") {
      issues.add("script.origin", "workflow_mismatch", "a footage production's script is transcribed from its footage");
    }
    if (w === "script" && origin === "transcribed") {
      issues.add("script.origin", "workflow_mismatch", "a script production has no footage to transcribe");
    }
  }
  if (doc.voice && !SYNTHESISED(w)) {
    issues.add("voice", "workflow_mismatch", "narration voice settings belong to script or hybrid productions");
  }
}

function checkTimes(issues: Issues, doc: Production): void {
  if (Date.parse(doc.updatedAt) < Date.parse(doc.createdAt)) {
    issues.add("updatedAt", "inconsistent", "a production cannot be updated before it was created");
  }
}

function checkResearch(issues: Issues, doc: Production): void {
  if (!doc.research) return;
  const sources = new Set(doc.research.sources.map((s) => s.id));
  doc.research.claims.forEach((c, i) => {
    const p = at("research.claims", i);
    c.sourceIds.forEach((s, j) => {
      if (!sources.has(s)) issues.add(at(at(p, "sourceIds"), j), "dangling_reference", "refers to a source the dossier does not list");
    });
    if (c.status === "supported" && c.sourceIds.length === 0) {
      issues.add(at(p, "sourceIds"), "inconsistent", "a supported claim needs at least one source");
    }
  });
}

function checkScript(issues: Issues, doc: Production, media: Map<string, MediaRole>, claims: Set<string>): void {
  const script = doc.script;
  if (!script) return;
  if (script.selectedHookId !== null && !script.hookOptions.some((h) => h.id === script.selectedHookId)) {
    issues.add("script.selectedHookId", "dangling_reference", "refers to a hook option the script does not offer");
  }
  script.sections.forEach((s, i) =>
    s.lines.forEach((l, j) => {
      const p = at(at(at(at("script", "sections"), i), "lines"), j);
      l.claimIds.forEach((c, k) => {
        if (!claims.has(c)) issues.add(at(at(p, "claimIds"), k), "dangling_reference", "refers to a claim the research dossier does not hold");
      });
      if (l.spoken) {
        if (!RECORDED(doc.workflow)) {
          issues.add(at(p, "spoken"), "workflow_mismatch", "a script production has no recorded speech to anchor to");
        }
        const role = media.get(l.spoken.mediaId);
        if (!role) {
          issues.add(at(at(p, "spoken"), "mediaId"), "dangling_reference", "refers to media this production does not use");
        } else if (role !== "a-roll" && role !== "b-roll") {
          issues.add(at(at(p, "spoken"), "mediaId"), "inconsistent", "spoken lines anchor to recorded footage");
        }
      }
    })
  );
}

interface StoryboardRefs {
  lines: Map<string, string>;
  claims: Set<string>;
  media: Map<string, MediaRole>;
  comments: Map<string, Production["review"]["comments"][number]>;
  clips: Map<string, Clip>;
}

function checkStoryboard(issues: Issues, doc: Production, refs: StoryboardRefs): void {
  const board = doc.storyboard;
  if (!board) return;
  const sceneIds = new Set(board.scenes.map((s) => s.id));
  if (board.structure && !sceneIds.has(board.structure.hookSceneId)) {
    issues.add("storyboard.structure.hookSceneId", "dangling_reference", "refers to a scene the storyboard does not hold");
  }
  board.scenes.forEach((scene, i) => {
    const p = at("storyboard.scenes", i);
    scene.scriptLineIds.forEach((l, j) => {
      if (!refs.lines.has(l)) issues.add(at(at(p, "scriptLineIds"), j), "dangling_reference", "refers to a script line that does not exist");
    });
    scene.slots.forEach((slot, j) => {
      if (slot.selectedAssetId !== null && !refs.media.has(slot.selectedAssetId)) {
        issues.add(at(at(at(p, "slots"), j), "selectedAssetId"), "dangling_reference", "a selected asset must be one of the production's media");
      }
    });
    scene.visual.layers.forEach((layer, j) => {
      const lp = at(at(p, "visual.layers"), j);
      if (layer.kind === "a-roll" && !RECORDED(doc.workflow)) {
        issues.add(lp, "workflow_mismatch", "a script production has no A-roll footage");
      }
      if (layer.kind === "text") {
        layer.claimIds?.forEach((c, k) => {
          if (!refs.claims.has(c)) issues.add(at(at(lp, "claimIds"), k), "dangling_reference", "refers to a claim the research dossier does not hold");
        });
      }
    });
    scene.comments.forEach((c, j) => {
      const cp = at(at(p, "comments"), j);
      const comment = refs.comments.get(c);
      if (!comment) {
        issues.add(cp, "dangling_reference", "refers to a review comment that does not exist");
      } else if (
        (comment.target.kind !== "scene" && comment.target.kind !== "scene-element") ||
        comment.target.sceneId !== scene.id
      ) {
        issues.add(cp, "inconsistent", "the comment is not about this scene");
      }
    });
    scene.approvals.forEach((a, j) => {
      if (a.revision > doc.revision) {
        issues.add(at(at(at(p, "approvals"), j), "revision"), "out_of_range", "approval cannot refer to a future revision");
      }
    });
    if (scene.realization) {
      const rp = at(p, "realization");
      if (scene.realization.materializedAtRevision > doc.revision) {
        issues.add(at(rp, "materializedAtRevision"), "out_of_range", "materialisation cannot refer to a future revision");
      }
      scene.realization.clipIds.forEach((c, j) => {
        const clip = refs.clips.get(c);
        if (!clip) issues.add(at(at(rp, "clipIds"), j), "dangling_reference", "refers to a clip the timeline does not hold");
        else if (clip.sceneId !== scene.id) issues.add(at(at(rp, "clipIds"), j), "inconsistent", "an owned clip must carry this scene's id");
      });
    } else if (REALISED_STATUSES.includes(scene.status)) {
      issues.add(at(p, "status"), "inconsistent", `a ${scene.status} scene must record its realisation`);
    }
  });
}

function checkTimeline(
  issues: Issues,
  doc: Production,
  media: Map<string, MediaRole>,
  scenes: Set<string>,
  context: InvariantContext
): void {
  const fps = doc.format.fps;
  const limit = maxTimelineFrames(fps);

  doc.timeline.tracks.forEach((track, i) => {
    const tp = at("timeline.tracks", i);
    const order = track.clips.map((c, j) => ({ c, j })).sort((a, b) => a.c.start - b.c.start || a.j - b.j);

    order.forEach(({ c: clip, j }, k) => {
      const cp = at(at(tp, "clips"), j);
      if (clip.start + clip.duration > limit) {
        issues.add(cp, "out_of_range", `the clip ends after the longest timeline allowed (${limit} frames at ${fps} fps)`);
      }
      if (clip.sceneId !== undefined && !scenes.has(clip.sceneId)) {
        issues.add(at(cp, "sceneId"), "dangling_reference", "refers to a scene the storyboard does not hold");
      }
      if (k > 0) {
        const prev = order[k - 1].c;
        if (prev.start + prev.duration > clip.start) {
          issues.add(cp, "overlap", "clips on the same track may not overlap");
        }
      }
      checkClipMedia(issues, clip, cp, media, context, fps);
    });
  });

  doc.timeline.markers.forEach((m, i) => {
    if (m.toFrame > limit) issues.add(at("timeline.markers", i), "out_of_range", "the marker ends after the longest timeline allowed");
  });
}

const ROLES_FOR: Record<"video" | "still" | "audio", readonly MediaKind[]> = {
  video: ["video"],
  still: ["image"],
  audio: ["video", "audio"],
};

function checkClipMedia(
  issues: Issues,
  clip: Clip,
  path: string,
  media: Map<string, MediaRole>,
  context: InvariantContext,
  fps: Production["format"]["fps"]
): void {
  if (clip.kind === "graphics") return;
  const mediaId = clip.kind === "still" ? clip.mediaId : clip.source.mediaId;
  const idPath = clip.kind === "still" ? at(path, "mediaId") : at(at(path, "source"), "mediaId");
  const role = media.get(mediaId);
  if (!role) {
    issues.add(idPath, "dangling_reference", "refers to media this production does not use");
    return;
  }
  if (!ROLES_FOR[clip.kind].includes(MEDIA_ROLE_KIND[role])) {
    issues.add(idPath, "inconsistent", `a ${clip.kind} clip cannot use ${role} media`);
  }
  if (clip.kind === "still") return;

  const { inUs, outUs } = clip.source;
  const speed = clip.speed ?? 1;
  if (!durationMatchesSourceSpan(clip.duration, inUs, outUs, fps, speed)) {
    issues.add(
      at(path, "duration"),
      "inconsistent",
      `the duration must match the source span at ${fps} fps and speed ${speed} (within half a frame)`
    );
  }
  const fadeIn = clip.kind === "audio" ? clip.fadeInFrames : clip.audio?.fadeInFrames;
  const fadeOut = clip.kind === "audio" ? clip.fadeOutFrames : clip.audio?.fadeOutFrames;
  if ((fadeIn ?? 0) + (fadeOut ?? 0) > clip.duration) {
    issues.add(path, "out_of_range", "fades together may not be longer than the clip");
  }
  const known = context.ledger?.get(mediaId);
  if (known?.durationUs !== undefined && outUs > known.durationUs) {
    issues.add(at(at(path, "source"), "outUs"), "out_of_range", "the source range ends after the media does");
  }
}

/**
 * Graphics clips' capability parameters, against the catalog. Each problem the
 * capability reports becomes an `invalid_value` issue at the clip's
 * `capability.params` path followed by the problem's own path inside the
 * parameters (its JSON pointer written in this notation, e.g.
 * `timeline.tracks[3].clips[0].capability.params.cues[2].text`).
 */
function checkCapabilities(issues: Issues, doc: Production, catalog: CapabilityCatalog): void {
  const canvas = { width: doc.format.width, height: doc.format.height };
  doc.timeline.tracks.forEach((track, i) => {
    track.clips.forEach((clip, j) => {
      if (clip.kind !== "graphics") return;
      const def = catalog.get(clip.capability.id, clip.capability.version);
      if (!def) return;
      const parsed = def.parse(clip.capability.params, { durationFrames: clip.duration, fps: doc.format.fps, canvas });
      if (parsed.ok) return;
      const base = at(at(at(at("timeline.tracks", i), "clips"), j), "capability.params");
      for (const issue of parsed.issues) issues.add(paramsPath(base, issue.path), "invalid_value", issue.message);
    });
  });
}

/** Appends a JSON pointer inside capability parameters to an issue path. */
function paramsPath(base: string, pointer: string): string {
  if (pointer === "") return base;
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<string>((path, part) => at(path, /^(0|[1-9][0-9]*)$/.test(part) ? Number(part) : part), base);
}

interface ReviewRefs {
  lines: Map<string, string>;
  scenes: Set<string>;
  clips: Map<string, Clip>;
  media: Map<string, MediaRole>;
}

function checkReview(issues: Issues, doc: Production, refs: ReviewRefs): void {
  doc.review.comments.forEach((c, i) => {
    const p = at("review.comments", i);
    const tp = at(p, "target");
    const t = c.target;
    const missing = (field: string, what: string) => issues.add(at(tp, field), "dangling_reference", `refers to ${what} that does not exist`);
    switch (t.kind) {
      case "script-line":
        if (!refs.lines.has(t.lineId)) missing("lineId", "a script line");
        break;
      case "scene":
      case "scene-element":
        if (!refs.scenes.has(t.sceneId)) missing("sceneId", "a scene");
        break;
      case "clip":
        if (!refs.clips.has(t.clipId)) missing("clipId", "a clip");
        break;
      case "asset":
        if (!refs.media.has(t.assetId)) missing("assetId", "media of this production");
        break;
      case "time-range":
        if (t.toFrame < t.fromFrame) issues.add(tp, "out_of_range", "a time range must not end before it starts");
        break;
    }
    if (c.revision > doc.revision) issues.add(at(p, "revision"), "out_of_range", "a comment cannot refer to a future revision");
  });
}
