import {
  VIDEO_SCHEMA_VERSION,
  type VideoProduction,
} from "@/types/video";

/**
 * Admission is intentionally pure: never silently repair a creator's document,
 * normalize timestamps, or mutate user work.
 */
export interface VideoSchemaProblem {
  path: string;
  code: "invalid_type" | "invalid_value" | "duplicate_id" | "missing_reference";
  message: string;
}
export type VideoSchemaResult =
  | { ok: true; value: VideoProduction; problems: [] }
  | { ok: false; problems: VideoSchemaProblem[] };

type Obj = Record<string, unknown>;
const record = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const integer = (v: unknown, min = 0): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const oneOf = (v: unknown, choices: readonly string[]) =>
  typeof v === "string" && choices.includes(v);
const MEDIA_HASH = /^[a-f0-9]{64}$/;
const ASSET_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function validateVideoProduction(input: unknown): VideoSchemaResult {
  const problems: VideoSchemaProblem[] = [];
  const add = (path: string, code: VideoSchemaProblem["code"], message: string) =>
    problems.push({ path, code, message });
  const checkId = (value: unknown, path: string) => {
    if (!string(value) || !ASSET_ID.test(value)) add(path, "invalid_value", "Expected a stable non-empty ID");
  };
  const unique = (value: unknown, path: string, ids: Set<string>) => {
    checkId(value, path);
    if (!string(value)) return;
    if (ids.has(value)) add(path, "duplicate_id", `Duplicate ID: ${value}`);
    ids.add(value);
  };
  const checkString = (v: unknown, path: string) => {
    if (!string(v)) add(path, "invalid_type", "Expected a non-empty string");
  };
  const checkNonnegative = (v: unknown, path: string, min = 0) => {
    if (!integer(v, min)) add(path, "invalid_value", `Expected an integer >= ${min}`);
  };
  const checkEnum = (v: unknown, path: string, choices: readonly string[]) => {
    if (!oneOf(v, choices)) add(path, "invalid_value", `Expected one of: ${choices.join(", ")}`);
  };
  const checkList = (v: unknown, path: string): unknown[] => {
    if (!Array.isArray(v)) {
      add(path, "invalid_type", "Expected an array");
      return [];
    }
    return v;
  };

  if (!record(input)) {
    return { ok: false, problems: [{ path: "$", code: "invalid_type", message: "Expected a production object" }] };
  }
  if (input.schemaVersion !== VIDEO_SCHEMA_VERSION)
    add("schemaVersion", "invalid_value", "Unsupported schema version; migration required");
  checkId(input.id, "id");
  checkString(input.name, "name");
  checkId(input.brandId, "brandId");
  checkEnum(input.workflow, "workflow", ["footage", "script", "hybrid"]);
  checkEnum(input.usageIntent, "usageIntent", ["personal", "commercial", "client"]);
  checkNonnegative(input.revision, "revision");
  checkEnum(input.stage, "stage", [
    "brief", "research", "script", "ingest", "selects", "storyboard", "production",
    "assembly", "review", "finishing", "delivered", "archived",
  ]);
  checkString(input.createdAt, "createdAt");
  checkString(input.updatedAt, "updatedAt");

  if (!record(input.format)) {
    add("format", "invalid_type", "Expected output format");
  } else {
    checkNonnegative(input.format.width, "format.width", 1);
    checkNonnegative(input.format.height, "format.height", 1);
    if (![24, 25, 30, 60].includes(input.format.fps as number))
      add("format.fps", "invalid_value", "Unsupported frame rate");
    checkEnum(input.format.platform, "format.platform", [
      "instagram-reel", "tiktok", "youtube-short", "linkedin", "youtube", "custom",
    ]);
    checkNonnegative(input.format.maxDurationMs, "format.maxDurationMs", 1);
  }

  const mediaIds = new Set<string>();
  for (const [i, item] of checkList(input.media, "media").entries()) {
    const p = `media[${i}]`;
    if (!record(item)) { add(p, "invalid_type", "Expected media reference"); continue; }
    if (!string(item.mediaId) || !MEDIA_HASH.test(item.mediaId))
      add(`${p}.mediaId`, "invalid_value", "Expected lowercase SHA-256 media ID");
    else if (mediaIds.has(item.mediaId))
      add(`${p}.mediaId`, "duplicate_id", "Media referenced twice");
    else mediaIds.add(item.mediaId);
    checkEnum(item.role, `${p}.role`, [
      "a-roll", "b-roll", "voice", "music", "sfx", "image", "illustration", "logo",
    ]);
    checkString(item.label, `${p}.label`);
    if (item.rightsRecordId !== undefined) checkId(item.rightsRecordId, `${p}.rightsRecordId`);
  }

  const scriptIds = new Set<string>();
  if (input.script !== null) {
    if (!record(input.script)) add("script", "invalid_type", "Expected script or null");
    else {
      checkEnum(input.script.origin, "script.origin", ["written", "generated", "transcribed"]);
      checkEnum(input.script.status, "script.status", ["draft", "approved"]);
      for (const [i, item] of checkList(input.script.lines, "script.lines").entries()) {
        const p = `script.lines[${i}]`;
        if (!record(item)) { add(p, "invalid_type", "Expected script line"); continue; }
        unique(item.id, `${p}.id`, scriptIds);
        checkEnum(item.speaker, `${p}.speaker`, ["on-camera", "narrator", "character"]);
        checkString(item.text, `${p}.text`);
        if (item.characterId !== undefined) checkId(item.characterId, `${p}.characterId`);
        if (item.speaker === "character" && item.characterId === undefined)
          add(`${p}.characterId`, "missing_reference", "Character line requires character ID");
      }
    }
  }

  const sceneIds = new Set<string>();
  const pendingRealizations: Array<{ path: string; id: string }> = [];
  if (input.storyboard !== null) {
    if (!record(input.storyboard)) add("storyboard", "invalid_type", "Expected storyboard or null");
    else {
      checkId(input.storyboard.id, "storyboard.id");
      checkEnum(input.storyboard.status, "storyboard.status", ["draft", "in-review", "approved", "locked"]);
      for (const [i, scene] of checkList(input.storyboard.scenes, "storyboard.scenes").entries()) {
        const p = `storyboard.scenes[${i}]`;
        if (!record(scene)) { add(p, "invalid_type", "Expected scene"); continue; }
        unique(scene.id, `${p}.id`, sceneIds);
        checkString(scene.title, `${p}.title`);
        checkEnum(scene.status, `${p}.status`, ["proposed", "approved", "rejected", "produced"]);
        for (const [j, id] of checkList(scene.lineIds, `${p}.lineIds`).entries()) {
          if (!string(id) || (input.script !== null && !scriptIds.has(id)))
            add(`${p}.lineIds[${j}]`, "missing_reference", "Unknown script line ID");
        }
        for (const [j, id] of checkList(scene.realizationClipIds, `${p}.realizationClipIds`).entries()) {
          if (!string(id)) add(`${p}.realizationClipIds[${j}]`, "invalid_type", "Expected clip ID");
          else pendingRealizations.push({ path: `${p}.realizationClipIds[${j}]`, id });
        }
      }
    }
  }

  if (input.speechSpine !== null) {
    if (!record(input.speechSpine)) add("speechSpine", "invalid_type", "Expected speech spine or null");
    else {
      checkEnum(input.speechSpine.kind, "speechSpine.kind", ["recorded", "narrated"]);
      if (input.speechSpine.sourceMediaId !== undefined && !mediaIds.has(input.speechSpine.sourceMediaId as string))
        add("speechSpine.sourceMediaId", "missing_reference", "Source media is not registered");
      const wordIds = new Set<string>();
      for (const [i, word] of checkList(input.speechSpine.words, "speechSpine.words").entries()) {
        const p = `speechSpine.words[${i}]`;
        if (!record(word)) { add(p, "invalid_type", "Expected word"); continue; }
        unique(word.id, `${p}.id`, wordIds);
        checkString(word.text, `${p}.text`);
        checkNonnegative(word.startUs, `${p}.startUs`);
        checkNonnegative(word.endUs, `${p}.endUs`, 1);
        if (integer(word.startUs) && integer(word.endUs) && word.endUs <= word.startUs)
          add(`${p}.endUs`, "invalid_value", "End must follow start");
      }
    }
  }

  const clipIds = new Set<string>();
  if (!record(input.timeline)) add("timeline", "invalid_type", "Expected timeline");
  else {
    const trackIds = new Set<string>();
    for (const [i, track] of checkList(input.timeline.tracks, "timeline.tracks").entries()) {
      const p = `timeline.tracks[${i}]`;
      if (!record(track)) { add(p, "invalid_type", "Expected track"); continue; }
      unique(track.id, `${p}.id`, trackIds);
      checkEnum(track.kind, `${p}.kind`, ["video", "audio", "graphics"]);
      for (const [j, clip] of checkList(track.clips, `${p}.clips`).entries()) {
        const c = `${p}.clips[${j}]`;
        if (!record(clip)) { add(c, "invalid_type", "Expected clip"); continue; }
        unique(clip.id, `${c}.id`, clipIds);
        checkNonnegative(clip.start, `${c}.start`);
        checkNonnegative(clip.duration, `${c}.duration`, 1);
        if (clip.sceneId !== undefined && !sceneIds.has(clip.sceneId as string))
          add(`${c}.sceneId`, "missing_reference", "Scene ID is not in storyboard");
        checkEnum(clip.kind, `${c}.kind`, ["video", "audio", "graphic"]);
        if ((track.kind === "graphics" && clip.kind !== "graphic") ||
            (track.kind === "video" && clip.kind !== "video") ||
            (track.kind === "audio" && clip.kind !== "audio"))
          add(`${c}.kind`, "invalid_value", "Clip kind does not match track kind");
        if (clip.kind === "graphic") {
          checkId(clip.capabilityId, `${c}.capabilityId`);
          checkString(clip.capabilityVersion, `${c}.capabilityVersion`);
          if (!record(clip.params)) add(`${c}.params`, "invalid_type", "Expected capability parameters");
        } else {
          if (!record(clip.source)) add(`${c}.source`, "invalid_type", "Expected source range");
          else {
            if (!mediaIds.has(clip.source.mediaId as string))
              add(`${c}.source.mediaId`, "missing_reference", "Source media is not registered");
            checkNonnegative(clip.source.inUs, `${c}.source.inUs`);
            checkNonnegative(clip.source.outUs, `${c}.source.outUs`, 1);
            if (integer(clip.source.inUs) && integer(clip.source.outUs) && clip.source.outUs <= clip.source.inUs)
              add(`${c}.source.outUs`, "invalid_value", "Source out must follow in");
          }
        }
        if (record(input.format) && integer(clip.start) && integer(clip.duration) &&
            integer(input.format.maxDurationMs, 1) && integer(input.format.fps, 1) &&
            (clip.start + clip.duration) * 1000 > input.format.maxDurationMs * input.format.fps)
          add(`${c}.duration`, "invalid_value", "Clip extends beyond the production duration limit");
      }
    }
  }

  for (const ref of pendingRealizations)
    if (!clipIds.has(ref.id)) add(ref.path, "missing_reference", "Realization clip ID is not in timeline");

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, value: input as unknown as VideoProduction, problems: [] };
}
