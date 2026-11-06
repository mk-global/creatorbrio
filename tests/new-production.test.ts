/**
 * The Studio's new production (#150) is admitted as it is, so creating one
 * from the page can never be refused for its shape, and each call returns a
 * document that shares nothing with another.
 */
import { describe, expect, it } from "vitest";

import { admitProduction } from "@/lib/video/production/admit";
import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";

const input = { id: "studio-1", name: "My reel", at: "2026-11-06T09:00:00.000Z" };

describe("a new Edit Studio production", () => {
  it("is admitted, at revision 0, as an Instagram Reel with the Studio's tracks bottom to top", () => {
    const doc = newEditProduction(input);
    const admitted = admitProduction(doc);
    expect(admitted.ok ? [] : admitted.issues).toEqual([]);
    expect(doc).toMatchObject({ id: "studio-1", name: "My reel", revision: 0, workflow: "footage", stage: "assembly", createdAt: input.at, updatedAt: input.at });
    expect(doc.format).toEqual({ width: 1080, height: 1920, fps: 30, maxDurationMs: 90_000, platform: "instagram-reel" });
    expect(doc.timeline.tracks.map((t) => t.id)).toEqual([STUDIO_TRACKS.footage, STUDIO_TRACKS.images, STUDIO_TRACKS.music, STUDIO_TRACKS.titles, STUDIO_TRACKS.captions]);
  });

  it("returns a fresh document every time", () => {
    const a = newEditProduction(input);
    const b = newEditProduction(input);
    expect(a).toEqual(b);
    expect(a.format).not.toBe(a.deliverables[0].format);
    a.timeline.tracks[0].clips.push({} as never);
    expect(b.timeline.tracks[0].clips).toEqual([]);
  });
});
