import { describe, expect, it } from "vitest";

import {
  buildEnvelope,
  ENVELOPE_ABSOLUTE_TOLERANCE,
  ENVELOPE_TOLERANCE_DB,
  gainAt,
  mergeIntervals,
  type EnvelopeSpec,
  type Interval,
} from "@/lib/video/render/audio-envelope";
import type { GainPoint } from "@/lib/video/render/plan";
import { EASINGS, type FrameRate, type Keyframe } from "@/types/production";

/**
 * An independent statement of the exact gain, written straight from the
 * definition with no knots or bounds, to check the sampled envelope against.
 */
function exact(spec: EnvelopeSpec): (t: number) => number {
  const us = (f: number) => Math.round((f * 1e6) / spec.fps);
  const start = us(spec.startFrame);
  const end = us(spec.startFrame + spec.durationFrames);
  const keys = spec.gainDb.map((k) => ({ t: us(spec.startFrame + k.frame), v: k.value, ease: k.ease ?? "linear" }));
  const fadeInEnd = us(spec.startFrame + (spec.fadeInFrames ?? 0));
  const fadeOutStart = us(spec.startFrame + spec.durationFrames - (spec.fadeOutFrames ?? 0));
  const d = spec.ducking;
  const voice = d ? mergeIntervals(d.voice) : [];
  const attack = (d?.attackMs ?? 0) * 1000;
  const release = (d?.releaseMs ?? 0) * 1000;

  const keyDb = (t: number) => {
    if (keys.length === 0) return 0;
    if (t <= keys[0].t) return keys[0].v;
    for (let i = 1; i < keys.length; i++) {
      if (t < keys[i].t) {
        const u = (t - keys[i - 1].t) / (keys[i].t - keys[i - 1].t);
        const e = { linear: u, "ease-in": u * u, "ease-out": 1 - (1 - u) ** 2, "ease-in-out": 3 * u * u - 2 * u ** 3, hold: 0 }[keys[i].ease];
        return keys[i - 1].v + (keys[i].v - keys[i - 1].v) * e;
      }
    }
    return keys[keys.length - 1].v;
  };
  const shape = (v: Interval, t: number) => {
    const reached = attack === 0 ? 1 : Math.min(1, (v.endUs - v.startUs) / attack);
    if (t < v.startUs) return 0;
    if (t < v.endUs) return attack === 0 ? 1 : Math.min(1, (t - v.startUs) / attack);
    return release === 0 ? 0 : Math.max(0, reached - (t - v.endUs) / release);
  };
  return (t: number) => {
    let deepest = 0;
    for (const v of voice) deepest = Math.max(deepest, shape(v, t));
    const duck = d ? d.depthDb * deepest : 0;
    let fade = 1;
    if (t < fadeInEnd) fade *= (t - start) / (fadeInEnd - start);
    if (t > fadeOutStart) fade *= (end - t) / (end - fadeOutStart);
    return 10 ** ((keyDb(t) - duck) / 20) * fade;
  };
}

/** The largest error against the exact gain, as a multiple of what is allowed (at most 1 passes). */
function worstError(spec: EnvelopeSpec, envelope: GainPoint[], step = 37): number {
  const g = exact(spec);
  const ratio = 10 ** (ENVELOPE_TOLERANCE_DB / 20) - 1;
  let worst = 0;
  const check = (t: number) => {
    const want = g(t);
    const allowed = Math.max(want * ratio, ENVELOPE_ABSOLUTE_TOLERANCE);
    worst = Math.max(worst, Math.abs(gainAt(envelope, t) - want) / allowed);
  };
  const first = envelope[0].atUs;
  const last = envelope[envelope.length - 1].atUs;
  for (let t = first; t <= last; t += step) check(t);
  // Every point and its neighbours, where steps and kinks are, and the middle of every segment.
  envelope.forEach((p, i) => {
    for (const t of [p.atUs - 1, p.atUs, p.atUs + 1]) if (t >= first && t <= last) check(t);
    if (i > 0) check(Math.round((envelope[i - 1].atUs + p.atUs) / 2));
  });
  return worst;
}

function expectWellFormed(spec: EnvelopeSpec, envelope: GainPoint[]): void {
  const us = (f: number) => Math.round((f * 1e6) / spec.fps);
  expect(envelope[0].atUs).toBe(us(spec.startFrame));
  expect(envelope[envelope.length - 1].atUs).toBe(us(spec.startFrame + spec.durationFrames));
  const increasing = envelope.every((p, i) => i === 0 || p.atUs > envelope[i - 1].atUs);
  const integral = envelope.every((p) => Number.isInteger(p.atUs));
  const rounded = envelope.every((p) => p.gain >= 0 && Math.round(p.gain * 1e6) / 1e6 === p.gain);
  expect({ increasing, integral, rounded }).toEqual({ increasing: true, integral: true, rounded: true });
}

const base = (extra: Partial<EnvelopeSpec> = {}): EnvelopeSpec => ({ fps: 30, startFrame: 30, durationFrames: 150, gainDb: [], ...extra });
const db = (g: number) => 20 * Math.log10(g);
const expectDb = (gain: number, want: number) => expect(Math.abs(db(gain) - want)).toBeLessThanOrEqual(ENVELOPE_TOLERANCE_DB);
const duck = (voice: Interval[], extra: Partial<NonNullable<EnvelopeSpec["ducking"]>> = {}) => ({ depthDb: 12, attackMs: 80, releaseMs: 300, voice, ...extra });

describe("gainAt", () => {
  const env: GainPoint[] = [
    { atUs: 100, gain: 0 },
    { atUs: 200, gain: 1 },
    { atUs: 300, gain: 0.5 },
  ];

  it("interpolates linearly between points and is exact at them", () => {
    expect(gainAt(env, 100)).toBe(0);
    expect(gainAt(env, 150)).toBe(0.5);
    expect(gainAt(env, 200)).toBe(1);
    expect(gainAt(env, 250)).toBe(0.75);
    expect(gainAt(env, 300)).toBe(0.5);
  });

  it("is silent outside the envelope and for an empty one", () => {
    expect(gainAt(env, 99)).toBe(0);
    expect(gainAt(env, 301)).toBe(0);
    expect(gainAt([], 0)).toBe(0);
  });
});

describe("buildEnvelope", () => {
  it("is a flat line from the clip's start to its end with no automation", () => {
    expect(buildEnvelope(base())).toEqual([
      { atUs: 1_000_000, gain: 1 },
      { atUs: 6_000_000, gain: 1 },
    ]);
  });

  it("writes fades over a constant gain as exact linear ramps", () => {
    const spec = base({ fadeInFrames: 15, fadeOutFrames: 30 });
    expect(buildEnvelope(spec)).toEqual([
      { atUs: 1_000_000, gain: 0 },
      { atUs: 1_500_000, gain: 1 },
      { atUs: 5_000_000, gain: 1 },
      { atUs: 6_000_000, gain: 0 },
    ]);
    const half = buildEnvelope(base({ gainDb: [{ frame: 0, value: -6 }], fadeInFrames: 75, fadeOutFrames: 75 }));
    expect(half).toEqual([
      { atUs: 1_000_000, gain: 0 },
      { atUs: 3_500_000, gain: 0.501187 },
      { atUs: 6_000_000, gain: 0 },
    ]);
  });

  it("holds the first keyframe's value before it and the last one's after it", () => {
    const spec = base({ gainDb: [{ frame: 30, value: -10 }, { frame: 60, value: -20 }] });
    const env = buildEnvelope(spec);
    expectDb(gainAt(env, 1_500_000), -10);
    expectDb(gainAt(env, 5_000_000), -20);
    expect(worstError(spec, env)).toBeLessThanOrEqual(1);
  });

  it("applies an ease to the segment arriving at its keyframe", () => {
    // Half way from -20 to 0 dB at the second keyframe: linear is -10, ease-in -15, ease-out -5, ease-in-out -10.
    const mid = 3_000_000;
    const at = (ease: Keyframe<number>["ease"]) =>
      db(gainAt(buildEnvelope(base({ gainDb: [{ frame: 0, value: -20, ease: "ease-in" }, { frame: 120, value: 0, ease }] })), mid));
    expect(Math.abs(at(undefined) - -10)).toBeLessThanOrEqual(ENVELOPE_TOLERANCE_DB);
    expect(Math.abs(at("linear") - -10)).toBeLessThanOrEqual(ENVELOPE_TOLERANCE_DB);
    expect(Math.abs(at("ease-in") - -15)).toBeLessThanOrEqual(ENVELOPE_TOLERANCE_DB);
    expect(Math.abs(at("ease-out") - -5)).toBeLessThanOrEqual(ENVELOPE_TOLERANCE_DB);
    expect(Math.abs(at("ease-in-out") - -10)).toBeLessThanOrEqual(ENVELOPE_TOLERANCE_DB);
    // A quarter of the way: ease-in-out is 3/16 - 2/64 = 0.15625 of the change.
    const quarter = db(gainAt(buildEnvelope(base({ gainDb: [{ frame: 0, value: -20 }, { frame: 120, value: 0, ease: "ease-in-out" }] })), 2_000_000));
    expect(Math.abs(quarter - (-20 + 20 * 0.15625))).toBeLessThanOrEqual(ENVELOPE_TOLERANCE_DB);
  });

  it("steps at a hold keyframe within one microsecond", () => {
    const spec = base({ gainDb: [{ frame: 0, value: -12 }, { frame: 60, value: 0, ease: "hold" }] });
    const env = buildEnvelope(spec);
    const step = 3_000_000;
    expect(gainAt(env, step - 1)).toBe(0.251189);
    expect(gainAt(env, step)).toBe(1);
    expect(gainAt(env, 2_000_000)).toBe(0.251189);
    expect(env.length).toBe(4);
    expect(worstError(spec, env)).toBeLessThanOrEqual(1);
  });

  it("ramps ducking in over the attack and out over the release, in dB", () => {
    const spec = base({ ducking: duck([{ startUs: 2_000_000, endUs: 4_000_000 }]) });
    const env = buildEnvelope(spec);
    const near = (t: number, want: number) => expectDb(gainAt(env, t), want);
    near(1_999_999, 0);
    near(2_040_000, -6);
    near(2_080_000, -12);
    near(3_000_000, -12);
    near(4_150_000, -6);
    near(4_300_000, 0);
    expect(worstError(spec, env)).toBeLessThanOrEqual(1);
    // Each 12 dB linear ramp needs only a handful of points.
    expect(env.length).toBeLessThanOrEqual(20);
  });

  it("releases a voice shorter than the attack from the depth it reached", () => {
    const spec = base({ ducking: duck([{ startUs: 2_000_000, endUs: 2_040_000 }]) });
    const env = buildEnvelope(spec);
    expectDb(gainAt(env, 2_040_000), -6);
    expectDb(gainAt(env, 2_115_000), -3);
    expectDb(gainAt(env, 2_190_000), 0);
    expect(worstError(spec, env)).toBeLessThanOrEqual(1);
  });

  it("takes the deeper reduction where a release meets the next attack, and never ducks twice", () => {
    const voice = [
      { startUs: 1_500_000, endUs: 2_000_000 },
      { startUs: 2_100_000, endUs: 2_120_000 },
      { startUs: 2_200_000, endUs: 3_000_000 },
    ];
    const spec = base({ gainDb: [{ frame: 0, value: -3 }], ducking: duck(voice) });
    const env = buildEnvelope(spec);
    expect(worstError(spec, env, 7)).toBeLessThanOrEqual(1);
    for (const p of env) expect(db(p.gain)).toBeGreaterThanOrEqual(-3 - 12 - ENVELOPE_TOLERANCE_DB);
    // 100 ms after the first voice ends, a third of the 300 ms release has passed.
    expectDb(gainAt(env, 2_100_000), -3 - 8);
  });

  it("merges overlapping and touching voice intervals", () => {
    expect(
      mergeIntervals([
        { startUs: 5, endUs: 9 },
        { startUs: 0, endUs: 3 },
        { startUs: 3, endUs: 4 },
        { startUs: 8, endUs: 12 },
        { startUs: 20, endUs: 20 },
      ])
    ).toEqual([
      { startUs: 0, endUs: 4 },
      { startUs: 5, endUs: 12 },
    ]);
    const a = base({ ducking: duck([{ startUs: 2_000_000, endUs: 3_000_000 }, { startUs: 3_000_000, endUs: 4_000_000 }]) });
    const b = base({ ducking: duck([{ startUs: 2_000_000, endUs: 4_000_000 }]) });
    expect(buildEnvelope(a)).toEqual(buildEnvelope(b));
  });

  it("steps for a zero attack or release", () => {
    const spec = base({ ducking: duck([{ startUs: 2_000_000, endUs: 4_000_000 }], { attackMs: 0, releaseMs: 0 }) });
    const env = buildEnvelope(spec);
    expect(gainAt(env, 1_999_999)).toBe(1);
    expect(gainAt(env, 2_000_000)).toBe(0.251189);
    expect(gainAt(env, 3_999_999)).toBe(0.251189);
    expect(gainAt(env, 4_000_000)).toBe(1);
    expect(worstError(spec, env, 11)).toBeLessThanOrEqual(1);
  });

  it("does nothing for depth 0 or voice outside the clip, and starts ducked under voice already sounding", () => {
    expect(buildEnvelope(base({ ducking: duck([{ startUs: 2_000_000, endUs: 4_000_000 }], { depthDb: 0 }) }))).toEqual(buildEnvelope(base()));
    expect(buildEnvelope(base({ ducking: duck([{ startUs: 0, endUs: 500_000 }, { startUs: 7_000_000, endUs: 8_000_000 }]) }))).toEqual(buildEnvelope(base()));
    const env = buildEnvelope(base({ ducking: duck([{ startUs: 0, endUs: 3_000_000 }]) }));
    expect(env[0]).toEqual({ atUs: 1_000_000, gain: 0.251189 });
  });

  it("stays within tolerance through fades over changing gain and ducking", () => {
    const spec = base({
      gainDb: [{ frame: 0, value: -30 }, { frame: 40, value: 6, ease: "ease-out" }, { frame: 150, value: -40, ease: "ease-in" }],
      fadeInFrames: 50,
      fadeOutFrames: 60,
      ducking: duck([{ startUs: 1_100_000, endUs: 2_200_000 }, { startUs: 5_500_000, endUs: 7_000_000 }], { depthDb: 40, attackMs: 1, releaseMs: 10_000 }),
    });
    const env = buildEnvelope(spec);
    expectWellFormed(spec, env);
    expect(worstError(spec, env, 13)).toBeLessThanOrEqual(1);
  });

  it("stays within tolerance and well formed across many random clips at every frame rate", () => {
    let seed = 12345;
    const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    for (let n = 0; n < 60; n++) {
      const fps = pick([24, 25, 30, 60] as FrameRate[]);
      const durationFrames = 1 + Math.floor(rand() * 300);
      const gainDb: Keyframe<number>[] = [];
      for (let frame = Math.floor(rand() * 10); frame <= durationFrames; frame += 1 + Math.floor(rand() * 60)) {
        gainDb.push({ frame, value: Math.round((rand() * 120 - 96) * 10) / 10, ...(rand() < 0.8 ? { ease: pick(EASINGS) } : {}) });
      }
      const fadeInFrames = Math.floor(rand() * durationFrames * 0.5);
      const fadeOutFrames = Math.floor(rand() * (durationFrames - fadeInFrames));
      const startFrame = Math.floor(rand() * 100);
      const startUs = Math.round((startFrame * 1e6) / fps);
      const voice: Interval[] = [];
      for (let t = startUs - 500_000; t < startUs + (durationFrames * 1e6) / fps; t += Math.floor(rand() * 900_000)) {
        const len = Math.floor(rand() * 600_000);
        voice.push({ startUs: t, endUs: t + len });
        t += len;
      }
      const spec: EnvelopeSpec = {
        fps,
        startFrame,
        durationFrames,
        gainDb,
        fadeInFrames,
        fadeOutFrames,
        ...(rand() < 0.7 ? { ducking: { depthDb: Math.round(rand() * 40), attackMs: pick([0, 1, 80, 500]), releaseMs: pick([0, 5, 300, 2000]), voice } } : {}),
      };
      const env = buildEnvelope(spec);
      expectWellFormed(spec, env);
      expect(worstError(spec, env, 997), JSON.stringify(spec)).toBeLessThanOrEqual(1);
    }
  });

  it("is checked by a measure that rejects a coarse envelope", () => {
    const spec = base({ ducking: duck([{ startUs: 2_000_000, endUs: 4_000_000 }]) });
    const env = buildEnvelope(spec);
    const coarse = env.filter((p, i) => i === 0 || i === env.length - 1 || p.atUs === 2_000_000 || p.atUs === 2_080_000 || p.atUs === 4_000_000 || p.atUs === 4_300_000);
    expect(coarse.length).toBeLessThan(env.length);
    expect(worstError(spec, coarse)).toBeGreaterThan(1);
  });

  it("is deterministic", () => {
    const spec = base({ gainDb: [{ frame: 0, value: -20 }, { frame: 100, value: 0, ease: "ease-in-out" }], fadeInFrames: 10, ducking: duck([{ startUs: 2_000_000, endUs: 3_000_000 }]) });
    expect(buildEnvelope(spec)).toEqual(buildEnvelope(structuredClone(spec)));
  });
});
