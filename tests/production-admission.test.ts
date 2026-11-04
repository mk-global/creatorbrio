import { describe, it, expect } from "vitest";

import { admitProduction, MAX_SOURCE_US, maxTimelineFrames, type AdmissionResult, type ProductionMigration } from "@/lib/video/production";
import { MAX_REPORTED_ISSUES } from "@/lib/video/production/primitives";
import type { Production } from "@/types/production";
import { footageProduction, hybridProduction, MEDIA, scriptProduction } from "./helpers/production-fixtures";

// ---------------------------------------------------------------------------
// Helpers. Every rejection test starts from a document the validator accepts
// and breaks one rule, so the rejection can only come from that rule.

type Loose = Record<string, unknown> & Production;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

function issuesOf(result: AdmissionResult) {
  if (result.ok) throw new Error("expected the document to be rejected");
  return result.issues;
}

function expectRejected(result: AdmissionResult, code: string, path?: string) {
  const issues = issuesOf(result);
  const match = issues.find((i) => i.code === code && (path === undefined || i.path === path));
  expect(match, `expected ${code}${path ? ` at ${path}` : ""}; got ${JSON.stringify(issues, null, 1)}`).toBeDefined();
}

/** Admits a frozen copy, so a write to the input would throw, and checks the input is unchanged. */
function admitFrozen(doc: unknown, options?: Parameters<typeof admitProduction>[1]): AdmissionResult {
  const before = JSON.stringify(doc);
  const frozen = deepFreeze(doc);
  const result = admitProduction(frozen, options);
  expect(JSON.stringify(frozen)).toBe(before);
  return result;
}

const FIXTURES = { footage: footageProduction, script: scriptProduction, hybrid: hybridProduction };

// ---------------------------------------------------------------------------

describe("valid productions are admitted for every workflow", () => {
  for (const [workflow, build] of Object.entries(FIXTURES)) {
    it(`admits the ${workflow} fixture unchanged`, () => {
      const doc = build();
      const result = admitFrozen(doc);
      if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 1));
      expect(result.production).toEqual(doc);
      expect(result.migratedFrom).toBeNull();
    });
  }

  it("returns a copy that shares nothing with the input", () => {
    const doc = footageProduction();
    const result = admitProduction(doc);
    if (!result.ok) throw new Error("expected admission");
    expect(result.production).not.toBe(doc);
    expect(result.production.timeline.tracks[0]).not.toBe(doc.timeline.tracks[0]);
    result.production.timeline.tracks[0].clips[0].start = 999;
    result.production.name = "changed";
    expect(doc.timeline.tracks[0].clips[0].start).toBe(0);
    expect(doc.name).toBe("Agents plan, then act");
  });

  it("admits a document that has been through JSON, as one read from disk", () => {
    const result = admitProduction(JSON.parse(JSON.stringify(hybridProduction())));
    expect(result.ok).toBe(true);
  });

  it("admits a minimal new footage production with no plans or media yet", () => {
    const doc = footageProduction();
    Object.assign(doc, {
      stage: "brief",
      research: null,
      script: null,
      storyboard: null,
      media: [],
      timeline: { ...doc.timeline, tracks: [], markers: [] },
      review: { comments: [] },
      deliverables: [],
      revision: 0,
    });
    expect(admitFrozen(doc).ok).toBe(true);
  });
});

describe("the input is never modified", () => {
  it("leaves rejected input untouched", () => {
    const doc = footageProduction() as Loose;
    doc.revision = -1;
    (doc.timeline.tracks[0].clips[0] as unknown as Record<string, unknown>).start = -5;
    const result = admitFrozen(doc);
    expect(result.ok).toBe(false);
  });

  it("survives arbitrary corruption without throwing or writing", () => {
    // A deterministic generator, so a failure reproduces.
    let seed = 0x1234;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const junk: unknown[] = [null, -1, 1.5, "", "x", {}, [], NaN, Infinity, true, { kind: "zzz" }, [null], 2 ** 60];

    for (let round = 0; round < 300; round++) {
      const doc = [footageProduction, scriptProduction, hybridProduction][round % 3]() as unknown;
      // Walk to a random node and replace one of its fields.
      let node = doc as Record<string, unknown>;
      for (let depth = 0; depth < 6; depth++) {
        const keys = Object.keys(node);
        if (keys.length === 0) break;
        const key = keys[Math.floor(random() * keys.length)];
        const child = node[key];
        if (child && typeof child === "object" && random() < 0.7) node = child as Record<string, unknown>;
        else break;
      }
      const keys = Object.keys(node);
      if (keys.length > 0) node[keys[Math.floor(random() * keys.length)]] = junk[Math.floor(random() * junk.length)];

      expect(() => admitFrozen(doc)).not.toThrow();
    }
  });
});

describe("schema versions and migrations", () => {
  it("refuses a document without a schema version", () => {
    const doc = footageProduction() as Partial<Production>;
    delete doc.schemaVersion;
    expectRejected(admitFrozen(doc), "unsupported_schema_version", "schemaVersion");
  });

  it("refuses a non-integer or string schema version", () => {
    for (const version of ["2", 2.5, 0, -2, null]) {
      const doc = { ...footageProduction(), schemaVersion: version };
      expectRejected(admitFrozen(doc), "unsupported_schema_version", "schemaVersion");
    }
  });

  it("refuses version 1, which was never persisted, because no migration exists", () => {
    const doc = { ...footageProduction(), schemaVersion: 1 };
    expectRejected(admitFrozen(doc), "unsupported_schema_version", "schemaVersion");
  });

  it("refuses a document from a newer CreatorBrio instead of dropping its fields", () => {
    const doc = { ...footageProduction(), schemaVersion: 3 };
    expectRejected(admitFrozen(doc), "schema_version_too_new", "schemaVersion");
  });

  it("migrates an older document step by step, on a copy, then admits it", () => {
    const v1 = { ...footageProduction(), schemaVersion: 1, title: "Old name field" } as Record<string, unknown>;
    delete v1.name;
    const migration: ProductionMigration = {
      from: 1,
      to: 2,
      migrate(doc) {
        doc.name = doc.title;
        delete doc.title;
        doc.schemaVersion = 2;
        return doc;
      },
    };
    const result = admitFrozen(v1, { migrations: [migration] });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.migratedFrom).toBe(1);
    expect(result.production.name).toBe("Old name field");
    expect(v1.title).toBe("Old name field");
  });

  it("reports a migration that throws or produces the wrong version", () => {
    const v1 = { ...footageProduction(), schemaVersion: 1 };
    const throwing: ProductionMigration = { from: 1, to: 2, migrate: () => { throw new Error("boom"); } };
    expectRejected(admitFrozen(v1, { migrations: [throwing] }), "migration_failed");
    const wrong: ProductionMigration = { from: 1, to: 2, migrate: (doc) => doc };
    expectRejected(admitFrozen({ ...footageProduction(), schemaVersion: 1 }, { migrations: [wrong] }), "migration_failed");
  });

  it("still validates a migrated document in full", () => {
    const v1 = { ...footageProduction(), schemaVersion: 1 };
    const sloppy: ProductionMigration = { from: 1, to: 2, migrate: (doc) => ({ ...doc, schemaVersion: 2, revision: -1 }) };
    expectRejected(admitFrozen(v1, { migrations: [sloppy] }), "out_of_range", "revision");
  });
});

describe("only plain JSON objects with known fields are admitted", () => {
  it("refuses non-objects", () => {
    for (const value of [null, undefined, 42, "production", [], new Date(), new Map()]) {
      expectRejected(admitProduction(value), "not_object", "");
    }
  });

  it("refuses unknown fields at the top level and inside clips", () => {
    const doc = footageProduction() as Loose;
    doc.renderer = "other";
    (doc.timeline.tracks[0].clips[0] as unknown as Record<string, unknown>).html = "<script></script>";
    const issues = issuesOf(admitFrozen(doc));
    expect(issues.filter((i) => i.code === "unknown_field").map((i) => i.path)).toEqual(["", "timeline.tracks[0].clips[0]"]);
  });

  it("refuses a __proto__ key from JSON without polluting prototypes", () => {
    const text = JSON.stringify(footageProduction()).replace('"name":', '"__proto__":{"polluted":true},"name":');
    const parsed = JSON.parse(text);
    expectRejected(admitProduction(parsed), "unknown_field", "");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses class instances where plain objects are expected", () => {
    const doc = footageProduction() as Loose;
    (doc as unknown as Record<string, unknown>).format = new (class Format {
      width = 1080; height = 1920; fps = 30; maxDurationMs = 90_000; platform = "instagram-reel";
    })();
    expectRejected(admitFrozen(doc), "not_object", "format");
  });

  it("refuses missing required fields", () => {
    const doc = footageProduction() as Partial<Production>;
    delete doc.timeline;
    expectRejected(admitFrozen(doc), "missing_field", "timeline");
  });

  it("refuses sparse arrays", () => {
    const doc = footageProduction();
    const media = [...doc.media];
    delete (media as unknown[])[1];
    doc.media = media;
    expectRejected(admitProduction(doc), "invalid_value", "media[1]");
  });

  it("refuses text with control characters and over-long names", () => {
    expectRejected(admitFrozen({ ...footageProduction(), name: "Bad\u0000name" }), "invalid_value", "name");
    expectRejected(admitFrozen({ ...footageProduction(), name: "x".repeat(201) }), "invalid_value", "name");
    expectRejected(admitFrozen({ ...footageProduction(), name: "   " }), "invalid_value", "name");
    const voiced = scriptProduction();
    voiced.voice!.defaultDirection.pronunciations = { "bad\u0007word": "said" };
    expectRejected(admitFrozen(voiced), "invalid_value", "voice.defaultDirection.pronunciations");
  });

  it("refuses identifiers that are not short safe tokens", () => {
    expectRejected(admitFrozen({ ...footageProduction(), id: "../escape" }), "invalid_id", "id");
    const doc = footageProduction();
    doc.media[0].mediaId = "A".repeat(64);
    expectRejected(admitFrozen(doc), "invalid_id", "media[0].mediaId");
  });

  it("refuses unsupported enumerations", () => {
    expectRejected(admitFrozen({ ...footageProduction(), workflow: "slideshow" }), "invalid_value", "workflow");
    expectRejected(admitFrozen({ ...footageProduction(), usageIntent: "resale" }), "invalid_value", "usageIntent");
    expectRejected(admitFrozen({ ...footageProduction(), stage: "done" }), "invalid_value", "stage");
  });

  it("refuses timestamps that are not ISO 8601 UTC", () => {
    expectRejected(admitFrozen({ ...footageProduction(), createdAt: "yesterday" }), "invalid_value", "createdAt");
    expectRejected(admitFrozen({ ...footageProduction(), createdAt: "2026-13-40T99:00:00Z" }), "invalid_value", "createdAt");
  });

  it("caps the number of reported issues for a hostile document", () => {
    const doc = footageProduction();
    doc.media = Array.from({ length: 1_000 }, () => ({ mediaId: "bad", role: "a-roll" as const, label: "x" }));
    const issues = issuesOf(admitProduction(doc));
    expect(issues.length).toBe(MAX_REPORTED_ISSUES + 1);
    expect(issues[MAX_REPORTED_ISSUES].code).toBe("limit_exceeded");
  });

  it("refuses arrays beyond their size limit", () => {
    const doc = footageProduction();
    doc.brief.tone = Array.from({ length: 9 }, (_, i) => `tone ${i}`);
    expectRejected(admitFrozen(doc), "limit_exceeded", "brief.tone");
  });
});

describe("output format", () => {
  it("accepts the four supported frame rates and refuses others", () => {
    for (const fps of [24, 25, 30, 60]) {
      const doc = scriptProduction();
      doc.format.fps = fps as Production["format"]["fps"];
      // Source spans are fixed in microseconds, so re-derive frame counts for this rate.
      doc.timeline.tracks = [];
      doc.storyboard!.scenes[0].realization = undefined;
      expect(admitFrozen(doc).ok, `fps ${fps}`).toBe(true);
    }
    for (const fps of [29.97, 23.976, 50, 120, 0]) {
      const doc = footageProduction() as Loose;
      (doc.format as unknown as Record<string, unknown>).fps = fps;
      expectRejected(admitFrozen(doc), "invalid_value", "format.fps");
    }
  });

  it("accepts only the supported canvas sizes", () => {
    const doc = footageProduction();
    doc.format = { ...doc.format, width: 720, height: 1280 };
    expectRejected(admitFrozen(doc), "invalid_value", "format");
    const landscape = footageProduction();
    landscape.format = { ...landscape.format, width: 1920, height: 1080, platform: "youtube" };
    expect(admitFrozen(landscape).ok).toBe(true);
  });

  it("bounds the platform duration target at the four-hour maximum", () => {
    const doc = footageProduction();
    doc.format.maxDurationMs = 4 * 60 * 60 * 1000 + 1;
    expectRejected(admitFrozen(doc), "out_of_range", "format.maxDurationMs");
  });
});

describe("capability parameters are plain JSON", () => {
  const withParams = (params: unknown) => {
    const doc = footageProduction();
    const track = doc.timeline.tracks.find((t) => t.kind === "graphics")!;
    (track.clips[0] as { capability: { params: unknown } }).capability.params = params;
    return doc;
  };
  const path = "timeline.tracks[3].clips[0].capability.params";

  it("accepts nested JSON", () => {
    expect(admitFrozen(withParams({ a: [1, "two", null, { b: false }] })).ok).toBe(true);
  });

  it("refuses non-finite numbers, functions and class instances", () => {
    expectRejected(admitProduction(withParams({ x: NaN })), "invalid_value", `${path}.x`);
    expectRejected(admitProduction(withParams({ x: Infinity })), "invalid_value", `${path}.x`);
    expectRejected(admitProduction(withParams({ f: () => 1 })), "invalid_type", `${path}.f`);
    expectRejected(admitProduction(withParams({ d: new Date() })), "invalid_type", `${path}.d`);
  });

  it("refuses excessive nesting", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = [deep];
    expectRejected(admitProduction(withParams(deep)), "limit_exceeded");
  });

  it("refuses malformed capability ids and versions", () => {
    const doc = footageProduction();
    const clip = doc.timeline.tracks[3].clips[0] as { capability: { id: string; version: string } };
    clip.capability.id = "Captions";
    clip.capability.version = "latest";
    const issues = issuesOf(admitFrozen(doc));
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining([
      "timeline.tracks[3].clips[0].capability.id",
      "timeline.tracks[3].clips[0].capability.version",
    ]));
  });
});

describe("media references stay within the bounds the time model allows", () => {
  it("refuses a source range beyond 24 hours", () => {
    const doc = footageProduction();
    const clip = doc.timeline.tracks[0].clips[0] as { source: { outUs: number } };
    clip.source.outUs = MAX_SOURCE_US + 1;
    expectRejected(admitFrozen(doc), "out_of_range", "timeline.tracks[0].clips[0].source.outUs");
  });

  it("refuses timeline positions that are not safe integers", () => {
    const doc = footageProduction();
    doc.timeline.tracks[2].clips[0].start = 2 ** 53;
    expectRejected(admitFrozen(doc), "invalid_type", "timeline.tracks[2].clips[0].start");
  });

  it("refuses a clip ending after the longest timeline allowed", () => {
    const doc = footageProduction();
    doc.timeline.tracks[2].clips[0].start = maxTimelineFrames(30) - 5;
    expectRejected(admitFrozen(doc), "out_of_range", "timeline.tracks[2].clips[0]");
  });

  it("uses the content hash as the media id", () => {
    expect(footageProduction().media.map((m) => m.mediaId)).toContain(MEDIA.aRoll);
  });
});
