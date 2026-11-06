/**
 * The Inspector's pure logic (#150): default parameters each capability's
 * own parser accepts, drafts and the parameters a Save sends, where a
 * refusal's issues belong in the form, free-position placement of new
 * graphics, and caption cue editing.
 */
import { describe, expect, it } from "vitest";

import { TIMED_CAPTIONS } from "@/lib/video/capabilities/captions";
import { LOWER_THIRD } from "@/lib/video/capabilities/lower-third";
import { TITLE_CARD } from "@/lib/video/capabilities/title-card";
import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { addCue, newCueRange, removeCue, updateCue } from "@/lib/video/studio/caption-cues";
import {
  defaultDurationFrames,
  defaultParams,
  draftDiffers,
  draftFromParams,
  fieldKey,
  formIssues,
  frameValue,
  GRAPHIC_KINDS,
  graphicKindOf,
  paramsFromDraft,
  type CaptionsDraft,
  type CueDraft,
  type LowerThirdDraft,
} from "@/lib/video/studio/capability-forms";
import { clipFacts, firstFreeStart, insertGraphic } from "@/lib/video/studio/clip-placement";
import type { RefusalIssue } from "@/lib/video/studio/types";
import type { Clip, GraphicsClip, Production } from "@/types/production";

const PARSERS = { "title-card": TITLE_CARD, "lower-third": LOWER_THIRD, captions: TIMED_CAPTIONS } as const;
const frame = (durationFrames: number, fps = 30) => ({ durationFrames, fps, canvas: { width: 1080, height: 1920 } });

/** Adds a clip to the track at `index` (the tracks' clip lists are typed by kind). */
function push(doc: Production, index: number, ...clips: Clip[]): void {
  (doc.timeline.tracks[index].clips as Clip[]).push(...clips);
}

/** An admission issue at `path`, as the store reports capability problems. */
const issue = (path: string, message: string): RefusalIssue => ({ path, code: "invalid_value", message });

function production(): Production {
  return newEditProduction({ id: "forms", name: "Forms", at: "2026-01-01T00:00:00.000Z" });
}

const provenance = { by: "user", changeSetId: "cs-1" } as const;
function graphic(id: string, start: number, duration: number, capabilityId = "graphics.title-card"): GraphicsClip {
  return { kind: "graphics", id, start, duration, layer: "front", provenance, capability: { id: capabilityId, version: "1.0.0", params: { title: "T", align: "center", scrim: true } } };
}

describe("default parameters", () => {
  for (const info of GRAPHIC_KINDS) {
    it(`are accepted by ${info.capabilityId} at its default length, at 30 and 24 fps`, () => {
      for (const fps of [30, 24]) {
        const duration = defaultDurationFrames(info.kind, fps);
        expect(duration).toBe(info.seconds * fps);
        const parsed = PARSERS[info.kind].parse(defaultParams(info.kind, duration), frame(duration, fps));
        expect(parsed).toMatchObject({ ok: true });
      }
    });

    it(`round-trip through a draft for ${info.capabilityId} and still parse`, () => {
      const duration = defaultDurationFrames(info.kind, 30);
      const draft = draftFromParams(info.kind, defaultParams(info.kind, duration))!;
      expect(draft).not.toBeNull();
      expect(draftDiffers(info.kind, draft, defaultParams(info.kind, duration))).toBe(false);
      expect(PARSERS[info.kind].parse(paramsFromDraft(draft), frame(duration))).toMatchObject({ ok: true });
    });
  }

  it("captions start with one cue spanning the clip", () => {
    expect(defaultParams("captions", 120)).toMatchObject({ cues: [{ start: 0, end: 120, text: expect.any(String) }] });
  });

  it("names the Studio's form only for the first-party ids at version 1.0.0", () => {
    expect(graphicKindOf("graphics.title-card", "1.0.0")?.kind).toBe("title-card");
    expect(graphicKindOf("graphics.title-card", "2.0.0")).toBeNull();
    expect(graphicKindOf("graphics.unknown", "1.0.0")).toBeNull();
  });
});

describe("drafts", () => {
  it("fill optional fields with the capability's defaults, so an untouched form is not dirty", () => {
    const stored = { title: "Ada", subtitle: "Engineer" };
    const draft = draftFromParams("lower-third", stored) as LowerThirdDraft;
    expect(draft).toEqual({ kind: "lower-third", title: "Ada", subtitle: "Engineer", accent: "#ffd23f" });
    expect(draftDiffers("lower-third", draft, stored)).toBe(false);
    expect(draftDiffers("lower-third", { ...draft, title: "Grace" }, stored)).toBe(true);
  });

  it("are refused for parameters the form cannot show", () => {
    expect(draftFromParams("title-card", "nope")).toBeNull();
    expect(draftFromParams("title-card", { title: "A", align: "left", scrim: true })).toBeNull();
    expect(draftFromParams("captions", { preset: "sentence", position: "lower", cues: [{ start: 0, end: 3 }] })).toBeNull();
  });

  it("send typed frames as numbers when they are whole numbers and as typed otherwise, for the capability to judge", () => {
    expect(frameValue("12")).toBe(12);
    expect(frameValue(" 7 ")).toBe(7);
    expect(frameValue("-3")).toBe(-3);
    expect(frameValue("1.5")).toBe("1.5");
    expect(frameValue("")).toBe("");
    const draft: CaptionsDraft = { kind: "captions", preset: "kinetic", position: "center", accent: "#112233", cues: [{ start: "0", end: "abc", text: "Hi" }] };
    expect(paramsFromDraft(draft)).toEqual({ preset: "kinetic", position: "center", accent: "#112233", cues: [{ start: 0, end: "abc", text: "Hi" }] });
    const parsed = TIMED_CAPTIONS.parse(paramsFromDraft(draft), frame(60));
    expect(parsed.ok === false && parsed.issues.map((i) => i.path)).toEqual(["/cues/0/end"]);
  });
});

describe("refusal issues in the form", () => {
  const doc = production();
  // The captions track is the fifth, bottom to top.
  push(doc, 4, graphic("other", 0, 30, "captions.timed"), graphic("cap", 30, 60, "captions.timed"));
  const base = "timeline.tracks[4].clips[1].capability.params";

  it("puts each capability issue of the edited clip at its field", () => {
    const issues = [
      issue(`${base}.cues[2].end`, "expected a whole number from 1 to 60"),
      issue(`${base}.cues[2].end`, "a second problem"),
      issue(`${base}.preset`, "expected one of: kinetic, sentence"),
      issue(`${base}.cues`, "at most 1500 words in all are allowed"),
    ];
    expect(formIssues(issues, doc, "cap")).toEqual({
      fields: { "cues[2].end": ["expected a whole number from 1 to 60", "a second problem"], preset: ["expected one of: kinetic, sentence"], cues: ["at most 1500 words in all are allowed"] },
      general: [],
    });
    expect(fieldKey("cues", 2, "end")).toBe("cues[2].end");
    expect(fieldKey("cues", 0)).toBe("cues[0]");
    expect(fieldKey("title")).toBe("title");
  });

  it("treats the parameters as a whole, another clip's issues and operation issues as general", () => {
    const issues = [
      issue(base, "unknown field"),
      issue("timeline.tracks[4].clips[0].capability.params.title", "other clip"),
      issue(`${base}x.title`, "a lookalike path"),
      { opIndex: 0, path: "ops[0].clipId", code: "not_found", message: "no clip with this id" } satisfies RefusalIssue,
    ];
    expect(formIssues(issues, doc, "cap")).toEqual({ fields: {}, general: ["unknown field", "other clip", "a lookalike path", "no clip with this id"] });
  });

  it("treats every issue as general when the clip is gone", () => {
    expect(formIssues([issue(`${base}.title`, "m")], doc, "missing")).toEqual({ fields: {}, general: ["m"] });
  });
});

describe("placing a new graphic", () => {
  it("goes at the playhead when the spot is free, and after the clips in the way otherwise", () => {
    expect(firstFreeStart([], 45, 90)).toBe(45);
    const clips = [
      { start: 0, duration: 30 },
      { start: 100, duration: 20 },
      { start: 30, duration: 30 },
    ];
    expect(firstFreeStart(clips, 10, 30)).toBe(60); // in the first clip, then flush after the second
    expect(firstFreeStart(clips, 60, 40)).toBe(60); // fits exactly up to the clip at 100
    expect(firstFreeStart(clips, 60, 41)).toBe(120); // one frame too long for the gap
    expect(firstFreeStart(clips, 130, 30)).toBe(130);
    expect(firstFreeStart(clips, -5.6, 10)).toBe(60);
  });

  it("inserts a title card on the titles track and captions on the captions track, as one operation", () => {
    const doc = production();
    push(doc, 3, graphic("t1", 0, 90));
    const title = insertGraphic(doc, "title-card", 30, "new-title");
    expect(title).toMatchObject({ ok: true, clipId: "new-title", trackId: STUDIO_TRACKS.titles, start: 90, duration: 90 });
    expect(title.ok && title.op).toMatchObject({ op: "insertClip", trackId: STUDIO_TRACKS.titles, clip: { kind: "graphics", id: "new-title", start: 90, duration: 90, layer: "front", capability: { id: "graphics.title-card", version: "1.0.0" } } });
    expect(title.ok && "provenance" in (title.op as { clip: object }).clip).toBe(false);
    const captions = insertGraphic(doc, "captions", 30, "new-cap");
    expect(captions).toMatchObject({ ok: true, trackId: STUDIO_TRACKS.captions, start: 30, duration: 120 });
  });

  it("explains a production without the track", () => {
    const doc = production();
    doc.timeline.tracks = doc.timeline.tracks.filter((t) => t.id !== STUDIO_TRACKS.captions);
    expect(insertGraphic(doc, "captions", 0, "c")).toEqual({ ok: false, reason: "This production has no captions track." });
  });
});

describe("clip facts", () => {
  it("describe a graphics clip and a media clip's source range in frames", () => {
    const doc = production();
    doc.media.push({ mediaId: "a".repeat(64), role: "a-roll", label: "footage.mov" });
    push(doc, 0, { kind: "video", id: "v1", start: 15, duration: 60, provenance, source: { mediaId: "a".repeat(64), inUs: 500_000, outUs: 2_500_000 } });
    push(doc, 3, graphic("t1", 0, 90));
    expect(clipFacts(doc, "v1")).toMatchObject({ kindLabel: "Video", start: 15, end: 75, length: 60, source: { inFrame: 15, outFrame: 75 }, mediaLabel: "footage.mov" });
    expect(clipFacts(doc, "t1")).toMatchObject({ kindLabel: "Title card", source: null, mediaLabel: null });
    expect(clipFacts(doc, "none")).toBeNull();
  });
});

describe("caption cues", () => {
  const cue = (start: number, end: number, text = "x"): CueDraft => ({ start: String(start), end: String(end), text });

  it("adds a cue after the last one, as long as there is room in the clip", () => {
    expect(addCue([], 120, 30)).toEqual([{ start: "0", end: "60", text: "New caption" }]);
    expect(addCue([cue(0, 90)], 120, 30)).toEqual([cue(0, 90), { start: "90", end: "120", text: "New caption" }]);
  });

  it("adds a cue in the first gap when the end is taken, keeping cues in order", () => {
    const cues = [cue(0, 10), cue(40, 120)];
    expect(newCueRange(cues, 120, 30)).toEqual({ start: 10, end: 40 });
    expect(addCue(cues, 120, 30)!.map((c) => [c.start, c.end])).toEqual([["0", "10"], ["10", "40"], ["40", "120"]]);
    expect(newCueRange([cue(20, 120)], 120, 30)).toEqual({ start: 0, end: 20 });
  });

  it("has no room in a full clip, and ignores cues still being typed", () => {
    expect(addCue([cue(0, 60), cue(60, 120)], 120, 30)).toBeNull();
    expect(newCueRange([{ start: "", end: "abc", text: "typing" }], 120, 30)).toEqual({ start: 0, end: 60 });
  });

  it("removes and edits one cue without touching the others", () => {
    const cues = [cue(0, 10, "a"), cue(10, 20, "b"), cue(20, 30, "c")];
    expect(removeCue(cues, 1).map((c) => c.text)).toEqual(["a", "c"]);
    expect(updateCue(cues, 2, "end", "35")[2]).toEqual({ start: "20", end: "35", text: "c" });
    expect(updateCue(cues, 0, "text", "A")[0].text).toBe("A");
    expect(cues[0].text).toBe("a");
  });
});
