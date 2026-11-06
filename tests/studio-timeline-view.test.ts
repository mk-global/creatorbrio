/**
 * What the Studio timeline draws (#150): lanes in an editor's stacking order
 * with their role names, each clip's label and the accessible name a screen
 * reader announces, and ruler steps that keep labels apart at every zoom.
 */
import { describe, expect, it } from "vitest";

import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import type { MediaView } from "@/lib/video/studio/types";
import { clipAccessibleName, clipLabel, clipTone, displayTracks, laneViews, rulerLabel, rulerScale, trackLabel, ZOOM_STEPS } from "@/lib/video/studio/timeline-view";
import type { Clip, GraphicsClip, Production } from "@/types/production";

const prov = { by: "user", changeSetId: "cs-0" } as const;
const MEDIA_V = "a".repeat(64);
const MEDIA_I = "d".repeat(64);

const graphic = (id: string, capability: string, params: GraphicsClip["capability"]["params"]): GraphicsClip => ({
  id,
  kind: "graphics",
  start: 30,
  duration: 45,
  layer: "front",
  capability: { id: capability, version: "1.0.0", params },
  provenance: prov,
});

function production(): Production {
  const p = newEditProduction({ id: "p1", name: "View", at: "2026-01-01T00:00:00.000Z" });
  p.media.push({ mediaId: MEDIA_V, role: "a-roll", label: "Interview take 2" });
  const clips: Record<string, Clip[]> = {
    [STUDIO_TRACKS.footage]: [
      { id: "v2", kind: "video", start: 90, duration: 30, source: { mediaId: MEDIA_V, inUs: 0, outUs: 1_000_000 }, provenance: prov },
      { id: "v1", kind: "video", start: 0, duration: 90, source: { mediaId: MEDIA_V, inUs: 0, outUs: 3_000_000 }, provenance: prov },
    ],
    [STUDIO_TRACKS.images]: [{ id: "s1", kind: "still", start: 0, duration: 30, mediaId: MEDIA_I, provenance: prov }],
    [STUDIO_TRACKS.titles]: [graphic("t1", "graphics.title-card", { title: "  Big news  ", align: "center", scrim: true }), graphic("l1", "graphics.lower-third", { title: "" })],
    [STUDIO_TRACKS.captions]: [graphic("c1", "captions.timed", { preset: "kinetic", position: "lower", cues: [{ start: 0, end: 10, text: "Hello there" }] })],
  };
  for (const t of p.timeline.tracks) (t.clips as Clip[]) = clips[t.id] ?? [];
  return p;
}

const library: MediaView[] = [{ mediaId: MEDIA_I, originalName: "still.png" } as MediaView];

describe("the Studio timeline's view", () => {
  it("stacks picture and graphics lanes frontmost first, then sound", () => {
    expect(displayTracks(production()).map(trackLabel)).toEqual(["Captions", "Titles", "Images", "Footage", "Music"]);
  });

  it("names lanes made outside the Studio by their role", () => {
    expect(trackLabel({ id: "x", kind: "audio", role: "voice", muted: false, clips: [] })).toBe("Voice");
    expect(trackLabel({ id: "y", kind: "graphics", hidden: false, clips: [] })).toBe("Graphics");
    expect(trackLabel({ id: "z", kind: "video", role: "b-roll", hidden: false, clips: [] })).toBe("B-roll");
  });

  it("labels clips by media label, file name, title or first caption", () => {
    const p = production();
    const clip = (id: string) => p.timeline.tracks.flatMap((t) => t.clips as Clip[]).find((c) => c.id === id)!;
    expect(clipLabel(clip("v1"), p, library)).toBe("Interview take 2");
    expect(clipLabel(clip("s1"), p, library)).toBe("still.png");
    expect(clipLabel(clip("s1"), p, [])).toBe("Missing media");
    expect(clipLabel(clip("t1"), p, library)).toBe("Big news");
    expect(clipLabel(clip("l1"), p, library)).toBe("graphics.lower-third");
    expect(clipLabel(clip("c1"), p, library)).toBe("Hello there");
    expect(clipLabel(graphic("c2", "captions.timed", { cues: [] }), p, library)).toBe("No captions yet");
    expect([clipTone(clip("v1")), clipTone(clip("s1")), clipTone(clip("t1")), clipTone(clip("c1")), clipTone(graphic("g", "fx.other", {}))]).toEqual([
      "video",
      "image",
      "title",
      "captions",
      "graphic",
    ]);
  });

  it("gives every clip an accessible name with kind, label, timecodes and lane, in timeline order", () => {
    const lanes = laneViews(production(), library);
    const footage = lanes.find((l) => l.label === "Footage")!;
    expect(footage.clips.map((c) => c.name)).toEqual(["Video: Interview take 2, 00:00:00:00 to 00:00:03:00, Footage track", "Video: Interview take 2, 00:00:03:00 to 00:00:04:00, Footage track"]);
    expect(clipAccessibleName(graphic("t", "graphics.title-card", {}), "Hi", "Titles", 30)).toBe("Title card: Hi, 00:00:01:00 to 00:00:02:15, Titles track");
  });

  it("keeps ruler labels at least 72 px apart at every zoom step", () => {
    for (const pps of ZOOM_STEPS) {
      const r = rulerScale(pps);
      expect(r.scaleWidth).toBeGreaterThanOrEqual(72);
      expect(r.scaleWidth).toBe(r.scale * pps);
      expect(Number.isInteger(r.split) && r.split > 0).toBe(true);
    }
    expect(rulerScale(256).scale).toBe(0.5);
    expect(rulerScale(8).scale).toBe(10);
  });

  it("writes ruler labels as minutes and seconds, with tenths when needed", () => {
    expect(rulerLabel(0)).toBe("0:00");
    expect(rulerLabel(65)).toBe("1:05");
    expect(rulerLabel(2.5)).toBe("0:02.5");
  });
});
