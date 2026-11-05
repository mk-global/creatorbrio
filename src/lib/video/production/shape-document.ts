/**
 * Structural checks for the production document and its planning sections:
 * format, brief, media, research, script, voice, review and deliverables.
 *
 * These check each field's type and value on untrusted input. References
 * between sections (a line's claims, a comment's target) are checked later by
 * `invariants.ts`, once the whole document is known to have the right shape.
 */

import { BRIEF_LIMITS } from "@/lib/creative-brief";
import {
  AUDIENCE_KNOWLEDGE,
  CANVAS_SIZES,
  CLAIM_STATUSES,
  HOOK_TECHNIQUES,
  MEDIA_ROLES,
  PLATFORMS,
  PRODUCTION_STAGES,
  SCRIPT_ORIGINS,
  SECTION_ROLES,
  SOURCE_KINDS,
  SOURCE_RELIABILITY,
  SPEAKERS,
  USAGE_INTENTS,
  WORKFLOWS,
} from "@/types/production";
import { LIMITS } from "./limits";
import {
  array,
  at,
  bool,
  has,
  id,
  int,
  isPlainObject,
  oneOf,
  pattern,
  sha256,
  shape,
  text,
  timestamp,
  type Issues,
} from "./primitives";
import { isFrameRate, MAX_PRODUCTION_DURATION_MS } from "./time";
import { checkStoryboard } from "./shape-storyboard";
import { checkTimeline } from "./shape-timeline";
import { checkNarrationDirection, checkVoice } from "./shape-narration";

const T = LIMITS.text;
const C = LIMITS.count;
const URL_PATTERN = /^https?:\/\/[^\s]+$/;

export const PRODUCTION_FIELDS = [
  "schemaVersion",
  "id",
  "name",
  "brandId",
  "styleProfileId",
  "workflow",
  "usageIntent",
  "revision",
  "stage",
  "format",
  "brief",
  "research",
  "script",
  "storyboard",
  "media",
  "timeline",
  "voice",
  "review",
  "deliverables",
  "createdAt",
  "updatedAt",
] as const;

/** Every top-level field, in order. The schema version itself is checked by `admit.ts`. */
export function checkDocument(issues: Issues, doc: Record<string, unknown>): void {
  shape(issues, doc, "", PRODUCTION_FIELDS);
  id(issues, doc.id, "id");
  text(issues, doc.name, "name", T.name);
  id(issues, doc.brandId, "brandId");
  if (doc.styleProfileId !== null) id(issues, doc.styleProfileId, "styleProfileId");
  oneOf(issues, doc.workflow, "workflow", WORKFLOWS);
  oneOf(issues, doc.usageIntent, "usageIntent", USAGE_INTENTS);
  int(issues, doc.revision, "revision", 0, Number.MAX_SAFE_INTEGER);
  oneOf(issues, doc.stage, "stage", PRODUCTION_STAGES);
  checkFormat(issues, doc.format, "format");
  checkBrief(issues, doc.brief, "brief");
  if (doc.research !== null) checkResearch(issues, doc.research, "research");
  if (doc.script !== null) checkScript(issues, doc.script, "script");
  if (doc.storyboard !== null) checkStoryboard(issues, doc.storyboard, "storyboard");
  checkMedia(issues, doc.media, "media");
  checkTimeline(issues, doc.timeline, "timeline");
  if (doc.voice !== null) checkVoice(issues, doc.voice, "voice");
  checkReview(issues, doc.review, "review");
  const deliverables = array(issues, doc.deliverables, "deliverables", C.deliverables);
  deliverables?.forEach((d, i) => {
    const p = at("deliverables", i);
    const o = shape(issues, d, p, ["id", "label", "format"]);
    if (!o) return;
    id(issues, o.id, at(p, "id"));
    text(issues, o.label, at(p, "label"), T.label);
    checkFormat(issues, o.format, at(p, "format"));
  });
  timestamp(issues, doc.createdAt, "createdAt");
  timestamp(issues, doc.updatedAt, "updatedAt");
}

export function checkFormat(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["width", "height", "fps", "maxDurationMs", "platform"]);
  if (!o) return;
  const sized =
    int(issues, o.width, at(path, "width"), 1, 8_192) && int(issues, o.height, at(path, "height"), 1, 8_192);
  if (sized && !CANVAS_SIZES.some((s) => s.width === o.width && s.height === o.height)) {
    issues.add(path, "invalid_value", `canvas must be one of ${CANVAS_SIZES.map((s) => `${s.width}x${s.height}`).join(", ")}`);
  }
  if (!isFrameRate(o.fps)) issues.add(at(path, "fps"), "invalid_value", "expected one of: 24, 25, 30, 60");
  int(issues, o.maxDurationMs, at(path, "maxDurationMs"), 1, MAX_PRODUCTION_DURATION_MS);
  oneOf(issues, o.platform, at(path, "platform"), PLATFORMS);
}

function checkBriefValue(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["value", "source", "at"]);
  if (!o) return;
  text(issues, o.value, at(path, "value"), BRIEF_LIMITS.value);
  oneOf(issues, o.source, at(path, "source"), ["explicit", "inferred"]);
  timestamp(issues, o.at, at(path, "at"));
}

function checkBriefItems(issues: Issues, value: unknown, path: string, max: number): void {
  array(issues, value, path, max)?.forEach((item, i) => {
    const p = at(path, i);
    const o = shape(issues, item, p, ["text", "source", "at"]);
    if (!o) return;
    text(issues, o.text, at(p, "text"), BRIEF_LIMITS.item);
    oneOf(issues, o.source, at(p, "source"), ["explicit", "inferred"]);
    timestamp(issues, o.at, at(p, "at"));
  });
}

const BRIEF_VALUE_FIELDS = ["objective", "audience", "centralMessage", "desiredResponse", "brandContext", "callToAction"];

export function checkBrief(issues: Issues, value: unknown, path: string): void {
  const o = shape(
    issues,
    value,
    path,
    [
      "constraints",
      "visualDecisions",
      "assetRelationships",
      "platform",
      "targetDurationMs",
      "tone",
      "mustInclude",
      "mustAvoid",
      "audienceKnowledge",
      "updatedAt",
    ],
    BRIEF_VALUE_FIELDS
  );
  if (!o) return;
  for (const field of BRIEF_VALUE_FIELDS) if (has(o, field)) checkBriefValue(issues, o[field], at(path, field));
  checkBriefItems(issues, o.constraints, at(path, "constraints"), BRIEF_LIMITS.constraints);
  checkBriefItems(issues, o.visualDecisions, at(path, "visualDecisions"), BRIEF_LIMITS.visualDecisions);
  checkBriefItems(issues, o.mustInclude, at(path, "mustInclude"), BRIEF_LIMITS.constraints);
  checkBriefItems(issues, o.mustAvoid, at(path, "mustAvoid"), BRIEF_LIMITS.constraints);
  array(issues, o.assetRelationships, at(path, "assetRelationships"), BRIEF_LIMITS.assetRelationships)?.forEach((r, i) => {
    const p = at(at(path, "assetRelationships"), i);
    const rel = shape(issues, r, p, ["id", "role", "source", "at"]);
    if (!rel) return;
    sha256(issues, rel.id, at(p, "id"));
    text(issues, rel.role, at(p, "role"), BRIEF_LIMITS.item);
    oneOf(issues, rel.source, at(p, "source"), ["explicit", "inferred"]);
    timestamp(issues, rel.at, at(p, "at"));
  });
  oneOf(issues, o.platform, at(path, "platform"), PLATFORMS);
  const d = shape(issues, o.targetDurationMs, at(path, "targetDurationMs"), ["min", "max"]);
  if (d) {
    const ok =
      int(issues, d.min, at(at(path, "targetDurationMs"), "min"), 1, MAX_PRODUCTION_DURATION_MS) &&
      int(issues, d.max, at(at(path, "targetDurationMs"), "max"), 1, MAX_PRODUCTION_DURATION_MS);
    if (ok && (d.min as number) > (d.max as number)) {
      issues.add(at(path, "targetDurationMs"), "inconsistent", "min must not exceed max");
    }
  }
  array(issues, o.tone, at(path, "tone"), C.tone)?.forEach((t, i) => text(issues, t, at(at(path, "tone"), i), T.short));
  oneOf(issues, o.audienceKnowledge, at(path, "audienceKnowledge"), AUDIENCE_KNOWLEDGE);
  timestamp(issues, o.updatedAt, at(path, "updatedAt"));
}

export function checkMedia(issues: Issues, value: unknown, path: string): void {
  array(issues, value, path, C.media)?.forEach((m, i) => {
    const p = at(path, i);
    const o = shape(issues, m, p, ["mediaId", "role", "label"]);
    if (!o) return;
    sha256(issues, o.mediaId, at(p, "mediaId"));
    oneOf(issues, o.role, at(p, "role"), MEDIA_ROLES);
    text(issues, o.label, at(p, "label"), T.label);
  });
}

export function checkResearch(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["questions", "sources", "claims", "status"]);
  if (!o) return;
  array(issues, o.questions, at(path, "questions"), C.questions)?.forEach((q, i) =>
    text(issues, q, at(at(path, "questions"), i), T.line)
  );
  array(issues, o.sources, at(path, "sources"), C.sources)?.forEach((s, i) => {
    const p = at(at(path, "sources"), i);
    const src = shape(
      issues,
      s,
      p,
      ["id", "kind", "title", "retrievedAt", "blob", "reliability", "retrievedBy"],
      ["url", "publisher"]
    );
    if (!src) return;
    id(issues, src.id, at(p, "id"));
    oneOf(issues, src.kind, at(p, "kind"), SOURCE_KINDS);
    if (has(src, "url")) {
      if (typeof src.url !== "string" || src.url.length > T.url) {
        issues.add(at(p, "url"), "invalid_value", `expected an http(s) URL of at most ${T.url} characters`);
      } else {
        pattern(issues, src.url, at(p, "url"), URL_PATTERN, "an http(s) URL");
      }
    } else if (src.kind === "url") {
      issues.add(at(p, "url"), "missing_field", "a source of kind url needs its url");
    }
    text(issues, src.title, at(p, "title"), T.title);
    if (has(src, "publisher")) text(issues, src.publisher, at(p, "publisher"), T.title);
    timestamp(issues, src.retrievedAt, at(p, "retrievedAt"));
    sha256(issues, src.blob, at(p, "blob"));
    oneOf(issues, src.reliability, at(p, "reliability"), SOURCE_RELIABILITY);
    oneOf(issues, src.retrievedBy, at(p, "retrievedBy"), ["user", "source-retrieval"]);
  });
  array(issues, o.claims, at(path, "claims"), C.claims)?.forEach((c, i) => {
    const p = at(at(path, "claims"), i);
    const claim = shape(issues, c, p, ["id", "text", "sourceIds", "status", "sensitive"]);
    if (!claim) return;
    id(issues, claim.id, at(p, "id"));
    text(issues, claim.text, at(p, "text"), T.line);
    array(issues, claim.sourceIds, at(p, "sourceIds"), C.sourceIdsPerClaim)?.forEach((s, j) =>
      id(issues, s, at(at(p, "sourceIds"), j))
    );
    oneOf(issues, claim.status, at(p, "status"), CLAIM_STATUSES);
    bool(issues, claim.sensitive, at(p, "sensitive"));
  });
  oneOf(issues, o.status, at(path, "status"), ["draft", "reviewed"]);
}

export function checkScript(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["origin", "hookOptions", "selectedHookId", "sections", "status"]);
  if (!o) return;
  oneOf(issues, o.origin, at(path, "origin"), SCRIPT_ORIGINS);
  array(issues, o.hookOptions, at(path, "hookOptions"), C.hookOptions)?.forEach((h, i) => {
    const p = at(at(path, "hookOptions"), i);
    const hook = shape(issues, h, p, ["id", "text", "technique", "rationale"]);
    if (!hook) return;
    id(issues, hook.id, at(p, "id"));
    text(issues, hook.text, at(p, "text"), T.line);
    oneOf(issues, hook.technique, at(p, "technique"), HOOK_TECHNIQUES);
    text(issues, hook.rationale, at(p, "rationale"), T.rationale);
  });
  if (o.selectedHookId !== null) id(issues, o.selectedHookId, at(path, "selectedHookId"));
  array(issues, o.sections, at(path, "sections"), C.sections)?.forEach((s, i) => {
    const p = at(at(path, "sections"), i);
    const section = shape(issues, s, p, ["id", "role", "lines"]);
    if (!section) return;
    id(issues, section.id, at(p, "id"));
    oneOf(issues, section.role, at(p, "role"), SECTION_ROLES);
    array(issues, section.lines, at(p, "lines"), C.linesPerSection)?.forEach((l, j) =>
      checkScriptLine(issues, l, at(at(p, "lines"), j))
    );
  });
  oneOf(issues, o.status, at(path, "status"), ["draft", "approved"]);
}

function checkScriptLine(issues: Issues, value: unknown, path: string): void {
  const o = shape(
    issues,
    value,
    path,
    ["id", "speaker", "text", "claimIds"],
    ["characterId", "delivery", "estimatedMs", "spoken"]
  );
  if (!o) return;
  id(issues, o.id, at(path, "id"));
  oneOf(issues, o.speaker, at(path, "speaker"), SPEAKERS);
  if (has(o, "characterId")) id(issues, o.characterId, at(path, "characterId"));
  else if (o.speaker === "character") issues.add(at(path, "characterId"), "missing_field", "a character line needs its character");
  text(issues, o.text, at(path, "text"), T.line);
  array(issues, o.claimIds, at(path, "claimIds"), C.claimIdsPerLine)?.forEach((c, i) =>
    id(issues, c, at(at(path, "claimIds"), i))
  );
  if (has(o, "delivery")) checkNarrationDirection(issues, o.delivery, at(path, "delivery"));
  if (has(o, "estimatedMs")) int(issues, o.estimatedMs, at(path, "estimatedMs"), 1, MAX_PRODUCTION_DURATION_MS);
  if (has(o, "spoken")) {
    const p = at(path, "spoken");
    const s = shape(issues, o.spoken, p, ["mediaId", "fromWordId", "toWordId"], ["takeGroupId"]);
    if (s) {
      sha256(issues, s.mediaId, at(p, "mediaId"));
      id(issues, s.fromWordId, at(p, "fromWordId"));
      id(issues, s.toWordId, at(p, "toWordId"));
      if (has(s, "takeGroupId")) id(issues, s.takeGroupId, at(p, "takeGroupId"));
    }
  }
}

const TARGET_FIELDS: Record<string, readonly string[]> = {
  production: [],
  "script-line": ["lineId"],
  scene: ["sceneId"],
  "scene-element": ["sceneId", "elementId"],
  "time-range": ["fromFrame", "toFrame"],
  clip: ["clipId"],
  asset: ["assetId"],
};

export function checkReview(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["comments"]);
  if (!o) return;
  array(issues, o.comments, at(path, "comments"), C.comments)?.forEach((c, i) => {
    const p = at(at(path, "comments"), i);
    const comment = shape(issues, c, p, ["id", "target", "text", "kind", "by", "at", "revision"], ["resolution"]);
    if (!comment) return;
    id(issues, comment.id, at(p, "id"));
    checkReviewTarget(issues, comment.target, at(p, "target"));
    text(issues, comment.text, at(p, "text"), T.comment);
    oneOf(issues, comment.kind, at(p, "kind"), ["note", "change-request", "question"]);
    oneOf(issues, comment.by, at(p, "by"), ["user", "agent"]);
    timestamp(issues, comment.at, at(p, "at"));
    int(issues, comment.revision, at(p, "revision"), 0, Number.MAX_SAFE_INTEGER);
    if (has(comment, "resolution")) {
      const rp = at(p, "resolution");
      const r = shape(issues, comment.resolution, rp, ["by", "at"], ["changeSetId", "note"]);
      if (r) {
        oneOf(issues, r.by, at(rp, "by"), ["user", "agent"]);
        timestamp(issues, r.at, at(rp, "at"));
        if (has(r, "changeSetId")) id(issues, r.changeSetId, at(rp, "changeSetId"));
        if (has(r, "note")) text(issues, r.note, at(rp, "note"), T.note);
      }
    }
  });
}

function checkReviewTarget(issues: Issues, value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    issues.add(path, "not_object", "expected an object");
    return;
  }
  if (!oneOf(issues, value.kind, at(path, "kind"), Object.keys(TARGET_FIELDS))) return;
  const fields = TARGET_FIELDS[value.kind as string];
  const o = shape(issues, value, path, ["kind", ...fields]);
  if (!o) return;
  for (const field of fields) {
    if (field === "fromFrame" || field === "toFrame") int(issues, o[field], at(path, field), 0, Number.MAX_SAFE_INTEGER);
    else if (field === "assetId") sha256(issues, o[field], at(path, field));
    else id(issues, o[field], at(path, field));
  }
}
