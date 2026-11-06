import { describe, expect, it } from "vitest";

import { createCatalog, DEFAULT_CATALOG, escapeHtml } from "@/lib/video/capabilities/catalog";
import { captionBand, safeZoneFor } from "@/lib/video/capabilities/safe-zone";
import type { CapabilityDefinition, ClipFrame, ParseResult } from "@/lib/video/capabilities/types";
import { admitProduction } from "@/lib/video/production";
import type { GraphicsClip, JsonValue, Production } from "@/types/production";
import { footageProduction } from "./helpers/production-fixtures";

const CLIP: ClipFrame = { durationFrames: 90, fps: 30, canvas: { width: 1080, height: 1920 } };

function def(id: string): CapabilityDefinition {
  const found = DEFAULT_CATALOG.get(id, "1.0.0");
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

const parse = (id: string, params: unknown, clip: ClipFrame = CLIP): ParseResult<unknown> => def(id).parse(params as JsonValue, clip);
const paths = (result: ParseResult<unknown>) => (result.ok ? [] : result.issues.map((i) => i.path));
const value = <T>(result: ParseResult<unknown>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value as T;
};

const captions = (cues: unknown[], extra: Record<string, unknown> = {}) => ({ preset: "kinetic", position: "lower", cues, ...extra });

describe("the catalog", () => {
  it("lists the three first-party capabilities by id and exact version", () => {
    expect(DEFAULT_CATALOG.list().map((d) => [d.id, d.version, d.kind])).toEqual([
      ["captions.timed", "1.0.0", "captions"],
      ["graphics.lower-third", "1.0.0", "graphic"],
      ["graphics.title-card", "1.0.0", "graphic"],
    ]);
    expect(DEFAULT_CATALOG.get("captions.timed", "1.0.1")).toBeUndefined();
    expect(DEFAULT_CATALOG.get("captions.kinetic-pop", "1.0.0")).toBeUndefined();
  });

  it("refuses duplicate and malformed definitions", () => {
    const d = def("captions.timed");
    expect(() => createCatalog([d, d])).toThrow(/defined twice/);
    expect(() => createCatalog([{ ...d, id: "Captions" }])).toThrow(/malformed id/);
    expect(() => createCatalog([{ ...d, version: "1" }])).toThrow(/malformed version/);
  });

  it("escapes every character that is markup", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
  });
});

describe("safe zones", () => {
  it("follows the Reels convention on 9:16 and the feed rule elsewhere", () => {
    expect(safeZoneFor({ width: 1080, height: 1920 })).toEqual({ left: 60, top: 269, right: 960, bottom: 1248 });
    expect(safeZoneFor({ width: 1080, height: 1350 })).toEqual({ left: 60, top: 60, right: 1020, bottom: 1230 });
    expect(safeZoneFor({ width: 1080, height: 1080 })).toEqual({ left: 60, top: 60, right: 1020, bottom: 960 });
    expect(safeZoneFor({ width: 1920, height: 1080 })).toEqual({ left: 60, top: 60, right: 1860, bottom: 960 });
    expect(safeZoneFor({ width: 720, height: 1280 })).toEqual({ left: 40, top: 179, right: 640, bottom: 832 });
  });

  it("reserves a caption band at the bottom of the safe zone", () => {
    const band = captionBand({ width: 1080, height: 1920 });
    expect(band).toEqual({ left: 60, top: 1248 - 302, right: 960, bottom: 1248 });
  });
});

describe("captions.timed parameters", () => {
  it("accepts valid cues and returns them trimmed, with the default accent", () => {
    const parsed = value<{ accent: string; cues: unknown[] }>(
      parse("captions.timed", captions([{ start: 0, end: 30, text: "  Hello there " }, { start: 30, end: 90, text: "Second cue, fine." }]))
    );
    expect(parsed.accent).toBe("#ffd23f");
    expect(parsed.cues).toEqual([
      { startFrame: 0, endFrame: 30, text: "Hello there" },
      { startFrame: 30, endFrame: 90, text: "Second cue, fine." },
    ]);
    expect(def("captions.timed").captionCues!(parsed)).toEqual(parsed.cues);
    expect(value<{ accent: string }>(parse("captions.timed", captions([], { preset: "sentence", position: "center", accent: "#A0B1C2" }))).accent).toBe("#a0b1c2");
  });

  it("counts characters as code points and allows exactly 120", () => {
    expect(parse("captions.timed", captions([{ start: 0, end: 10, text: "😀".repeat(120) }])).ok).toBe(true);
    expect(paths(parse("captions.timed", captions([{ start: 0, end: 10, text: "a".repeat(121) }])))).toEqual(["/cues/0/text"]);
  });

  it.each([
    ["not an object", [], [""]],
    ["missing fields", {}, ["/preset", "/position", "/cues"]],
    ["an unknown field", { ...captions([]), style: "pop" }, [""]],
    ["an unknown preset", captions([], { preset: "karaoke" }), ["/preset"]],
    ["an unknown position", captions([], { position: "top" }), ["/position"]],
    ["a colour that is not #rrggbb", captions([], { accent: "red" }), ["/accent"]],
    ["a colour carrying CSS", captions([], { accent: "#ffffff; background: url(x)" }), ["/accent"]],
    ["cues that are not a list", captions({} as unknown as unknown[]), ["/cues"]],
    ["a cue that is not an object", captions(["hi"]), ["/cues/0"]],
    ["a cue with an unknown field", captions([{ start: 0, end: 10, text: "a", words: [] }]), ["/cues/0"]],
    ["a cue missing its text", captions([{ start: 0, end: 10 }]), ["/cues/0/text"]],
    ["a fractional start", captions([{ start: 0.5, end: 10, text: "a" }]), ["/cues/0/start"]],
    ["a negative start", captions([{ start: -1, end: 10, text: "a" }]), ["/cues/0/start"]],
    ["an end past the clip", captions([{ start: 0, end: 91, text: "a" }]), ["/cues/0/end"]],
    ["an end before the start", captions([{ start: 20, end: 20, text: "a" }]), ["/cues/0/end"]],
    ["empty text", captions([{ start: 0, end: 10, text: "   " }]), ["/cues/0/text"]],
    ["text that is not a string", captions([{ start: 0, end: 10, text: 7 }]), ["/cues/0/text"]],
    ["a line break", captions([{ start: 0, end: 10, text: "one\ntwo" }]), ["/cues/0/text"]],
    ["a tab", captions([{ start: 0, end: 10, text: "one\ttwo" }]), ["/cues/0/text"]],
    ["a control character", captions([{ start: 0, end: 10, text: "bell\u0007" }]), ["/cues/0/text"]],
    [
      "overlapping cues",
      captions([
        { start: 0, end: 30, text: "a" },
        { start: 29, end: 40, text: "b" },
      ]),
      ["/cues/1/start"],
    ],
    [
      "cues out of order",
      captions([
        { start: 40, end: 50, text: "a" },
        { start: 0, end: 10, text: "b" },
      ]),
      ["/cues/1/start"],
    ],
  ])("refuses %s", (_name, params, expected) => {
    expect(paths(parse("captions.timed", params))).toEqual(expected);
  });

  it("refuses more than 500 cues and more than 1,500 words", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ start: i, end: i + 1, text: "a" }));
    expect(paths(parse("captions.timed", captions(many), { ...CLIP, durationFrames: 600 }))).toEqual(["/cues"]);
    const wordy = Array.from({ length: 26 }, (_, i) => ({ start: i, end: i + 1, text: Array(60).fill("w").join(" ") }));
    expect(paths(parse("captions.timed", captions(wordy)))).toEqual(["/cues"]);
  });

  it("bounds the issues it reports and never quotes the parameters", () => {
    const bad = Array.from({ length: 200 }, () => ({ start: "x", end: "y", text: "<script>" }));
    const result = parse("captions.timed", captions(bad));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBe(51);
    expect(JSON.stringify(result.issues)).not.toContain("script");
  });
});

describe("graphics.lower-third parameters", () => {
  it("accepts a title with or without a subtitle and accent", () => {
    expect(value(parse("graphics.lower-third", { title: "Ada Lovelace" }))).toEqual({ title: "Ada Lovelace", subtitle: "", accent: "#ffd23f" });
    expect(value(parse("graphics.lower-third", { title: "Ada", subtitle: "", accent: "#112233" }))).toEqual({ title: "Ada", subtitle: "", accent: "#112233" });
    expect(value(parse("graphics.lower-third", { title: "t".repeat(60), subtitle: "s".repeat(80) }))).toMatchObject({ subtitle: "s".repeat(80) });
  });

  it.each([
    ["missing title", {}, ["/title"]],
    ["empty title", { title: " " }, ["/title"]],
    ["a title too long", { title: "t".repeat(61) }, ["/title"]],
    ["a subtitle too long", { title: "t", subtitle: "s".repeat(81) }, ["/subtitle"]],
    ["a subtitle that is not text", { title: "t", subtitle: null }, ["/subtitle"]],
    ["a bad accent", { title: "t", accent: "#12345" }, ["/accent"]],
    ["an unknown field", { title: "t", align: "left" }, [""]],
  ])("refuses %s", (_name, params, expected) => {
    expect(paths(parse("graphics.lower-third", params))).toEqual(expected);
  });
});

describe("graphics.title-card parameters", () => {
  it("accepts a title, alignment and scrim", () => {
    expect(value(parse("graphics.title-card", { title: "Chapter one", align: "top", scrim: true }))).toEqual({ title: "Chapter one", subtitle: "", align: "top", scrim: true });
    expect(value(parse("graphics.title-card", { title: "t".repeat(80), subtitle: "s".repeat(120), align: "center", scrim: false }))).toMatchObject({ align: "center" });
  });

  it.each([
    ["missing fields", { title: "t" }, ["/align", "/scrim"]],
    ["a title too long", { title: "t".repeat(81), align: "center", scrim: false }, ["/title"]],
    ["a subtitle too long", { title: "t", subtitle: "s".repeat(121), align: "center", scrim: false }, ["/subtitle"]],
    ["an unknown alignment", { title: "t", align: "bottom", scrim: false }, ["/align"]],
    ["a scrim that is not a boolean", { title: "t", align: "center", scrim: "yes" }, ["/scrim"]],
    ["an accent it does not have", { title: "t", align: "center", scrim: false, accent: "#ffffff" }, [""]],
  ])("refuses %s", (_name, params, expected) => {
    expect(paths(parse("graphics.title-card", params))).toEqual(expected);
  });
});

describe("admission with the catalog", () => {
  function withCaptions(params: unknown): Production {
    const doc = footageProduction();
    const track = doc.timeline.tracks.find((t) => t.id === "track-captions");
    if (!track || track.kind !== "graphics") throw new Error("fixture changed");
    (track.clips[0] as GraphicsClip).capability = { id: "captions.timed", version: "1.0.0", params: params as JsonValue };
    return doc;
  }
  const trackIndex = footageProduction().timeline.tracks.findIndex((t) => t.id === "track-captions");

  it("admits valid parameters and refuses invalid ones at their path inside the clip", () => {
    const valid = withCaptions(captions([{ start: 0, end: 30, text: "Hi" }]));
    expect(admitProduction(valid, { capabilities: DEFAULT_CATALOG }).ok).toBe(true);

    const result = admitProduction(withCaptions(captions([{ start: 0, end: 200, text: "Hi" }])), { capabilities: DEFAULT_CATALOG });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { path: `timeline.tracks[${trackIndex}].clips[0].capability.params.cues[0].end`, code: "invalid_value", message: "expected a whole number from 1 to 105" },
    ]);
    // Without the catalog, parameters are not checked.
    expect(admitProduction(withCaptions({ nonsense: true })).ok).toBe(true);
  });

  it("reports a problem with the whole parameter value at the params path", () => {
    const result = admitProduction(withCaptions("text"), { capabilities: DEFAULT_CATALOG });
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toEqual([`timeline.tracks[${trackIndex}].clips[0].capability.params`]);
  });

  it("keeps capabilities the catalog does not know admissible", () => {
    expect(admitProduction(footageProduction(), { capabilities: DEFAULT_CATALOG }).ok).toBe(true);
    const doc = withCaptions({ anything: 1 });
    (doc.timeline.tracks[trackIndex].clips[0] as GraphicsClip).capability.version = "2.0.0";
    expect(admitProduction(doc, { capabilities: DEFAULT_CATALOG }).ok).toBe(true);
  });
});
