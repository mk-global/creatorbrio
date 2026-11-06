/**
 * The compiler (#144): a pure function from an admitted production, the
 * registry records of its media and an export profile to a render plan. It
 * reads nothing and writes nothing, so the same inputs always give the same
 * plan; it reports every problem it finds, each with a JSON-pointer-like path
 * into the production, rather than stopping at the first.
 *
 * Semantics (the plan's own comments in `plan.ts` give the units):
 * - The output lasts until the end of the last clip on any track, hidden or
 *   muted tracks included, so the export is as long as the timeline the
 *   editor shows.
 * - Picture: video tracks bottom to top; a hidden video track draws nothing
 *   but its clips' own sound still plays. Every picture is cover-fitted to
 *   the canvas in upright pixels (`placement.ts`); where nothing covers a
 *   frame the output is black.
 * - Sound: an a-roll video clip's own sound is `voice` and a b-roll clip's is
 *   `b-roll`, whenever the media has an audio stream, at 0 dB unless the
 *   clip's `audio` says otherwise. Audio clips take their track's role. A
 *   muted audio track contributes nothing and is not checked. Gain envelopes
 *   are defined in `audio-envelope.ts`; music, sfx and ambience are ducked
 *   under every voice source.
 * - Graphics: front graphics in track order, then by start. A hidden graphics
 *   track is skipped entirely, and `Timeline.captions.hidden` skips every
 *   captions-kind clip, for the picture and the sidecars alike.
 * - Features with no export semantics yet are refused with
 *   `unsupported_feature` naming the clip, never ignored: `transitionIn`,
 *   clips on an `overlay` video track, non-empty `framing`, `speed` other
 *   than 1, `behind-subject` graphics, non-empty `effects`, and audio
 *   `processing` with any field set.
 * - Not rendered, by design: `sceneId`, `provenance`, `renderCacheKey`,
 *   `Timeline.markers` and `Timeline.captions.presetId` (caption styling is
 *   each captions capability's own parameters).
 */
import type { CapabilityCatalog, CapabilityDefinition } from "@/lib/video/capabilities/types";
import type { MediaRecord } from "@/lib/video/media/registry";
import { framesToSourceSpanUs } from "@/lib/video/production/time";
import type { AudioClip, FrameRate, GraphicsClip, Keyframe, MediaKind, Production, StillClip, Track, VideoClip } from "@/types/production";
import { buildEnvelope, type Interval } from "./audio-envelope";
import { coverPlacement, displaySize } from "./placement";
import {
  PLAN_VERSION,
  type AudioSource,
  type CaptionCue,
  type CompileIssue,
  type CompileIssueCode,
  type CompileResult,
  type GraphicPlacement,
  type PlanInput,
  type VideoLayer,
} from "./plan";
import type { ExportProfile } from "./profile";

/**
 * Bumped whenever the plan compiled from the same production, media and
 * profile would change (placement, sound, envelope sampling, refusals), and
 * recorded in the render manifest. `PLAN_VERSION` is the plan's shape.
 */
export const COMPILER_VERSION = 1;

export interface CompileOptions {
  profile: ExportProfile;
  catalog: CapabilityCatalog;
}

type VideoTrack = Extract<Track, { kind: "video" }>;
type AudioTrack = Extract<Track, { kind: "audio" }>;

const DUCKED_ROLES: ReadonlySet<AudioSource["role"]> = new Set(["music", "sfx", "ambience"]);

/** A sound found on the timeline, before its envelope (which needs every voice source) is built. */
interface Sound extends Omit<AudioSource, "envelope"> {
  gainDb: readonly Keyframe<number>[];
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

export function compile(production: Production, media: ReadonlyMap<string, MediaRecord>, options: CompileOptions): CompileResult {
  const c = new Compilation(production, media, options);
  c.checkFormat();
  production.timeline.tracks.forEach((track, index) => c.track(track, index));
  if (c.issues.length > 0) return { ok: false, issues: c.issues };

  const { width, height, fps } = production.format;
  return {
    ok: true,
    plan: {
      version: PLAN_VERSION,
      productionId: production.id,
      revision: production.revision,
      profile: options.profile.id,
      canvas: { width, height, fps },
      durationFrames: c.durationFrames,
      video: c.video,
      audio: c.mix(),
      graphics: c.graphics,
      captions: c.captions.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame),
      inputs: [...c.inputs.values()],
      loudness: { targetLufs: production.timeline.audio.masterLufs },
    },
  };
}

/** A JSON pointer from fixed keys and indexes. */
const pointer = (...parts: (string | number)[]) => parts.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");

/** A track's clips in timeline order, with their indexes in the document for paths. */
function inTimelineOrder<C extends { start: number }>(clips: readonly C[]): { clip: C; index: number }[] {
  return clips.map((clip, index) => ({ clip, index })).sort((a, b) => a.clip.start - b.clip.start || a.index - b.index);
}

class Compilation {
  readonly issues: CompileIssue[] = [];
  readonly inputs = new Map<string, PlanInput>();
  readonly video: VideoLayer[] = [];
  readonly graphics: GraphicPlacement[] = [];
  readonly captions: CaptionCue[] = [];
  readonly durationFrames: number;
  private readonly sounds: Sound[] = [];
  private readonly fps: FrameRate;

  constructor(
    private readonly production: Production,
    private readonly media: ReadonlyMap<string, MediaRecord>,
    private readonly options: CompileOptions
  ) {
    this.fps = production.format.fps;
    let end = 0;
    for (const track of production.timeline.tracks) for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration);
    this.durationFrames = end;
  }

  private issue(code: CompileIssueCode, path: string, message: string, clipId?: string): void {
    this.issues.push(clipId === undefined ? { code, path, message } : { code, path, message, clipId });
  }

  checkFormat(): void {
    const { profile } = this.options;
    const format = this.production.format;
    if (!profile.canvases.includes(`${format.width}x${format.height}`)) {
      this.issue("profile_mismatch", "/format", `the ${profile.label} profile does not take a ${format.width}x${format.height} canvas`);
    }
    if (!profile.frameRates.includes(format.fps)) {
      this.issue("profile_mismatch", "/format/fps", `the ${profile.label} profile does not take ${format.fps} fps`);
    }
    if (this.durationFrames === 0) {
      this.issue("empty_timeline", "/timeline/tracks", "the timeline has no clips to export");
    } else if ((this.durationFrames * 1000) / format.fps > format.maxDurationMs) {
      this.issue("duration_exceeds_profile", "/format/maxDurationMs", `the timeline is longer than this production's limit of ${format.maxDurationMs} ms`);
    }
  }

  track(track: Track, trackIndex: number): void {
    const path = pointer("timeline", "tracks", trackIndex);
    switch (track.kind) {
      case "video":
        if (track.role === "overlay") {
          for (const clip of track.clips) {
            this.issue("unsupported_feature", `${path}/role`, "clips on an overlay video track cannot be exported yet", clip.id);
          }
        }
        for (const { clip, index } of inTimelineOrder(track.clips)) this.visual(track, trackIndex, clip, `${path}/clips/${index}`);
        return;
      case "graphics":
        if (track.hidden) return;
        for (const { clip, index } of inTimelineOrder(track.clips)) this.graphic(track.id, trackIndex, clip, `${path}/clips/${index}`);
        return;
      case "audio":
        if (track.muted) return;
        for (const { clip, index } of inTimelineOrder(track.clips)) this.sound(track.id, track.role, clip, `${path}/clips/${index}`);
        return;
    }
  }

  private visual(track: VideoTrack, trackIndex: number, clip: VideoClip | StillClip, path: string): void {
    const refuse = (field: string, what: string) => this.issue("unsupported_feature", `${path}/${field}`, `${what} cannot be exported yet`, clip.id);
    if (clip.transitionIn) refuse("transitionIn", "transitions");
    if (clip.framing && clip.framing.length > 0) refuse("framing", "framing");
    if (clip.effects && clip.effects.length > 0) refuse("effects", "clip effects");
    if (clip.kind === "video" && clip.speed !== undefined && clip.speed !== 1) refuse("speed", "speed changes");

    const isVideo = clip.kind === "video";
    const mediaId = isVideo ? clip.source.mediaId : clip.mediaId;
    const record = this.record(mediaId, isVideo ? `${path}/source/mediaId` : `${path}/mediaId`, clip.id, isVideo ? ["video"] : ["image"]);
    if (!record || track.role === "overlay") return;

    if (!track.hidden) {
      const picture = record.facts.video;
      if (!picture) {
        this.issue("media_kind_mismatch", isVideo ? `${path}/source/mediaId` : `${path}/mediaId`, "the registered media has no picture", clip.id);
        return;
      }
      const { width, height } = this.production.format;
      this.use(record);
      this.video.push({
        clipId: clip.id,
        trackId: track.id,
        trackIndex,
        kind: clip.kind,
        mediaId,
        startFrame: clip.start,
        durationFrames: clip.duration,
        ...(isVideo ? { sourceInUs: clip.source.inUs } : {}),
        placement: coverPlacement(displaySize(picture), { width, height }),
      });
    }
    if (isVideo && record.facts.audio) {
      this.use(record);
      this.sounds.push({
        clipId: clip.id,
        trackId: track.id,
        role: track.role === "a-roll" ? "voice" : "b-roll",
        mediaId,
        startFrame: clip.start,
        durationFrames: clip.duration,
        sourceInUs: clip.source.inUs,
        gainDb: clip.audio?.gainDb ?? [],
        fadeInFrames: clip.audio?.fadeInFrames,
        fadeOutFrames: clip.audio?.fadeOutFrames,
      });
    }
  }

  private graphic(trackId: string, trackIndex: number, clip: GraphicsClip, path: string): void {
    const { id, version, params } = clip.capability;
    const definition = this.options.catalog.get(id, version);
    if (definition?.kind === "captions" && this.production.timeline.captions?.hidden === true) return;

    if (clip.transitionIn) this.issue("unsupported_feature", `${path}/transitionIn`, "transitions cannot be exported yet", clip.id);
    if (clip.layer === "behind-subject") this.issue("unsupported_feature", `${path}/layer`, "behind-subject graphics cannot be exported yet", clip.id);
    if (!definition) {
      this.issue("capability_unavailable", `${path}/capability`, `no capability ${id} at version ${version} is available`, clip.id);
      return;
    }
    const { width, height } = this.production.format;
    const parsed = definition.parse(params, { durationFrames: clip.duration, fps: this.fps, canvas: { width, height } });
    if (!parsed.ok) {
      for (const problem of parsed.issues) {
        this.issue("invalid_capability_params", `${path}/capability/params${problem.path}`, problem.message, clip.id);
      }
      return;
    }
    if (definition.kind === "captions") this.cues(definition, parsed.value, clip, path);
    this.graphics.push({
      clipId: clip.id,
      trackId,
      trackIndex,
      capability: structuredClone(clip.capability),
      startFrame: clip.start,
      durationFrames: clip.duration,
    });
  }

  private cues(definition: CapabilityDefinition, value: unknown, clip: GraphicsClip, path: string): void {
    if (!definition.captionCues) {
      this.issue("capability_unavailable", `${path}/capability`, `capability ${definition.id} does not provide caption cues`, clip.id);
      return;
    }
    const end = clip.start + clip.duration;
    for (const cue of definition.captionCues(value)) {
      const startFrame = Math.max(clip.start, clip.start + cue.startFrame);
      const endFrame = Math.min(end, clip.start + cue.endFrame);
      if (endFrame > startFrame) this.captions.push({ clipId: clip.id, startFrame, endFrame, text: cue.text });
    }
  }

  private sound(trackId: string, role: AudioTrack["role"], clip: AudioClip, path: string): void {
    if (clip.speed !== undefined && clip.speed !== 1) this.issue("unsupported_feature", `${path}/speed`, "speed changes cannot be exported yet", clip.id);
    if (clip.processing && Object.keys(clip.processing).length > 0) {
      this.issue("unsupported_feature", `${path}/processing`, "audio processing cannot be exported yet", clip.id);
    }
    const record = this.record(clip.source.mediaId, `${path}/source/mediaId`, clip.id, ["video", "audio"]);
    if (!record) return;
    if (!record.facts.audio) {
      this.issue("no_audio_stream", `${path}/source/mediaId`, "the media has no sound", clip.id);
      return;
    }
    this.use(record);
    this.sounds.push({
      clipId: clip.id,
      trackId,
      role,
      mediaId: clip.source.mediaId,
      startFrame: clip.start,
      durationFrames: clip.duration,
      sourceInUs: clip.source.inUs,
      gainDb: clip.gainDb,
      fadeInFrames: clip.fadeInFrames,
      fadeOutFrames: clip.fadeOutFrames,
    });
  }

  private record(mediaId: string, path: string, clipId: string, kinds: readonly MediaKind[]): MediaRecord | null {
    const record = this.media.get(mediaId);
    if (!record) {
      this.issue("media_not_registered", path, "the media is not in the media registry", clipId);
      return null;
    }
    if (!kinds.includes(record.kind)) {
      this.issue("media_kind_mismatch", path, `this clip needs ${kinds.join(" or ")} media but the registry records ${record.kind}`, clipId);
      return null;
    }
    return record;
  }

  private use(record: MediaRecord): void {
    if (this.inputs.has(record.mediaId)) return;
    const picture = record.facts.video;
    this.inputs.set(record.mediaId, {
      mediaId: record.mediaId,
      kind: record.kind,
      ...(picture ? { display: displaySize(picture) } : {}),
      rotation: picture?.rotation ?? 0,
      dynamicRange: picture?.dynamicRange ?? "sdr",
      hasAudio: record.facts.audio !== undefined,
      ...(record.facts.durationUs !== undefined ? { durationUs: record.facts.durationUs } : {}),
    });
  }

  /** Every sound with its envelope; ducked roles are lowered under the union of the voice sources. */
  mix(): AudioSource[] {
    const voice: Interval[] = this.sounds
      .filter((s) => s.role === "voice")
      .map((s) => ({ startUs: framesToSourceSpanUs(s.startFrame, this.fps), endUs: framesToSourceSpanUs(s.startFrame + s.durationFrames, this.fps) }));
    const policy = this.production.timeline.audio.ducking;
    return this.sounds.map(({ gainDb, fadeInFrames, fadeOutFrames, ...source }) => ({
      ...source,
      envelope: buildEnvelope({
        fps: this.fps,
        startFrame: source.startFrame,
        durationFrames: source.durationFrames,
        gainDb,
        fadeInFrames,
        fadeOutFrames,
        ...(DUCKED_ROLES.has(source.role) ? { ducking: { ...policy, voice } } : {}),
      }),
    }));
  }
}
