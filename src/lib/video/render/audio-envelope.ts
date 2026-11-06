/**
 * Gain envelopes (#144): the one definition of how loud each sound in a
 * render plan is at every moment, used by the export's mix and by the Studio
 * preview (through `gainAt`).
 *
 * A clip's gain is the product of three factors, all in timeline time:
 *
 * 1. Gain keyframes, in dB, at clip-relative frames. Before the first
 *    keyframe the gain holds the first value, after the last it holds the
 *    last, and no keyframes means 0 dB. A keyframe's `ease` shapes the
 *    segment arriving at it from the previous keyframe (so an ease on the
 *    last keyframe matters and one on the first does nothing); absent means
 *    linear. With `u` running 0 to 1 across the segment, the dB value moves
 *    by `linear` u, `ease-in` u², `ease-out` 1 - (1 - u)², `ease-in-out`
 *    3u² - 2u³; `hold` keeps the previous value and steps to this one at the
 *    keyframe's frame.
 * 2. Fades, as linear amplitude ramps from silence over `fadeInFrames` at the
 *    clip's start and to silence over `fadeOutFrames` at its end.
 * 3. Ducking, for music, sfx and ambience: while any voice sounds (the union
 *    of the voice sources' intervals), the gain is lowered by `depthDb`. Each
 *    voice interval ramps the reduction in linearly in dB over `attackMs` from
 *    its start and, after its end, back out at the same rate as a full
 *    release over `releaseMs` would, starting from whatever depth it reached
 *    (an interval shorter than the attack never reaches full depth). Where a
 *    release overlaps the next interval's attack, the deeper of the two
 *    applies, so voice never ducks twice. `depthDb` 0 means no ducking.
 *
 * Times are integer microseconds; a frame boundary `f` is at
 * `framesToSourceSpanUs(f, fps)`, i.e. `round(f * 1e6 / fps)`.
 *
 * The envelope is that product sampled at integer microseconds so that
 * linear interpolation between consecutive points (`gainAt`) is within
 * `ENVELOPE_TOLERANCE_DB` of it at every microsecond of the clip, or within
 * `ENVELOPE_ABSOLUTE_TOLERANCE` where the gain is below about -60 dB (dB error
 * is unbounded as a fade reaches silence, and gains are rounded to six
 * decimals). A step (a `hold` keyframe, a zero attack or release) is written
 * as a 1 µs ramp ending at the step, shorter than one 48 kHz sample, so
 * `atUs` is always strictly increasing.
 *
 * Point count: every keyframe, fade edge, ducking ramp edge and ramp crossing
 * is a point; between two such points the curve is split into equal pieces,
 * the fewest for which a proven error bound holds. A dB ramp with no fade
 * across it needs a piece per 2 to 2.5 dB (a 12 dB ducking ramp is six
 * pieces, so 60 s of music ducked under 20 takes is about 280 points), a fade
 * over constant gain needs none, and a fade over a changing gain a piece per
 * 0.08 dB of change. A piece is never shorter than 1 µs.
 */
import type { DuckingPolicy, FrameRate, Keyframe } from "@/types/production";
import { framesToSourceSpanUs } from "@/lib/video/production/time";
import type { GainPoint } from "./plan";

export const ENVELOPE_TOLERANCE_DB = 0.1;
export const ENVELOPE_ABSOLUTE_TOLERANCE = 1e-5;
/** What interpolation may use of the tolerance; the rest absorbs rounding gains to six decimals. */
const INTERPOLATION_BUDGET_DB = 0.08;
const DB_PER_NEPER = 20 / Math.LN10;

/** A half-open interval of timeline time, `[startUs, endUs)`. */
export interface Interval {
  startUs: number;
  endUs: number;
}

export interface EnvelopeSpec {
  fps: FrameRate;
  startFrame: number;
  durationFrames: number;
  gainDb: readonly Keyframe<number>[];
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /** For ducked roles only: the policy and the intervals voice sounds in (merged here). */
  ducking?: DuckingPolicy & { voice: readonly Interval[] };
}

/** Sorts intervals and joins those that overlap or touch. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.endUs > i.startUs).sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  const merged: Interval[] = [];
  for (const i of sorted) {
    const last = merged[merged.length - 1];
    if (last && i.startUs <= last.endUs) last.endUs = Math.max(last.endUs, i.endUs);
    else merged.push({ startUs: i.startUs, endUs: i.endUs });
  }
  return merged;
}

/**
 * The gain at a moment of timeline time: linear interpolation between the
 * envelope's points, and 0 (silence) before its first point or after its last.
 */
export function gainAt(envelope: readonly GainPoint[], atUs: number): number {
  const n = envelope.length;
  if (n === 0 || atUs < envelope[0].atUs || atUs > envelope[n - 1].atUs) return 0;
  if (atUs === envelope[n - 1].atUs) return envelope[n - 1].gain;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (envelope[mid].atUs <= atUs) lo = mid;
    else hi = mid;
  }
  const a = envelope[lo];
  const b = envelope[hi];
  return a.gain + ((b.gain - a.gain) * (atUs - a.atUs)) / (b.atUs - a.atUs);
}

/** Samples a clip's gain into points; see the module comment for the definition and accuracy. */
export function buildEnvelope(spec: EnvelopeSpec): GainPoint[] {
  const curve = new GainCurve(spec);
  const knots = curve.knots();
  const points: GainPoint[] = [];
  for (let k = 0; k + 1 < knots.length; k++) {
    const a = knots[k];
    const b = knots[k + 1];
    const pieces = curve.piecesBetween(a, b);
    for (let p = 0; p < pieces; p++) {
      const atUs = a + Math.round((p * (b - a)) / pieces);
      points.push({ atUs, gain: round6(curve.gain(atUs)) });
    }
  }
  const end = knots[knots.length - 1];
  points.push({ atUs: end, gain: round6(curve.gain(end)) });
  return points;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

type Ease = NonNullable<Keyframe<number>["ease"]>;

function ease(kind: Ease, u: number): number {
  switch (kind) {
    case "linear":
      return u;
    case "ease-in":
      return u * u;
    case "ease-out":
      return 1 - (1 - u) * (1 - u);
    case "ease-in-out":
      return u * u * (3 - 2 * u);
    case "hold":
      return 0;
  }
}

/** The steepest slope and the largest |second derivative| of each ease over u in [0, 1]. */
const EASE_BOUNDS: Record<Ease, { slope: number; curvature: number }> = {
  linear: { slope: 1, curvature: 0 },
  "ease-in": { slope: 2, curvature: 2 },
  "ease-out": { slope: 2, curvature: 2 },
  "ease-in-out": { slope: 1.5, curvature: 6 },
  hold: { slope: 0, curvature: 0 },
};

/**
 * The largest error, in dB, of interpolating linear amplitude across a piece
 * over which the level moves linearly by `deltaDb`: the convexity of the
 * exponential. Closed form of max over u of ln(1 - u + uR) - u ln R.
 */
function convexityDb(deltaDb: number): number {
  const x = Math.abs(deltaDb) / DB_PER_NEPER;
  if (x < 1e-4) return (x * x * DB_PER_NEPER) / 8;
  const r = Math.exp(x);
  const u = ((r - 1) / x - 1) / (r - 1);
  return (Math.log(1 - u + u * r) - u * x) * DB_PER_NEPER;
}

interface AbsoluteKeyframe {
  atUs: number;
  db: number;
  ease: Ease;
}

interface VoiceShape extends Interval {
  /** How far towards full depth the attack got by the interval's end, 0 to 1. */
  reached: number;
  /** When the release returns to no reduction. */
  releasedUs: number;
}

/** The exact gain of one clip, with what the sampler needs to bound its error. */
class GainCurve {
  private readonly startUs: number;
  private readonly endUs: number;
  private readonly keys: AbsoluteKeyframe[];
  private readonly fadeInEndUs: number;
  private readonly fadeOutStartUs: number;
  private readonly depthDb: number;
  private readonly attackUs: number;
  private readonly releaseUs: number;
  private readonly voice: VoiceShape[];

  constructor(spec: EnvelopeSpec) {
    const us = (frame: number) => framesToSourceSpanUs(frame, spec.fps);
    this.startUs = us(spec.startFrame);
    this.endUs = us(spec.startFrame + spec.durationFrames);
    this.keys = spec.gainDb.map((k) => ({ atUs: us(spec.startFrame + k.frame), db: k.value, ease: k.ease ?? "linear" }));
    this.fadeInEndUs = us(spec.startFrame + (spec.fadeInFrames ?? 0));
    this.fadeOutStartUs = us(spec.startFrame + spec.durationFrames - (spec.fadeOutFrames ?? 0));

    const ducking = spec.ducking && spec.ducking.depthDb > 0 ? spec.ducking : null;
    this.depthDb = ducking?.depthDb ?? 0;
    this.attackUs = (ducking?.attackMs ?? 0) * 1000;
    this.releaseUs = (ducking?.releaseMs ?? 0) * 1000;
    this.voice = mergeIntervals(ducking?.voice ?? [])
      .map((v) => {
        const reached = this.attackUs === 0 ? 1 : Math.min(1, (v.endUs - v.startUs) / this.attackUs);
        return { ...v, reached, releasedUs: v.endUs + reached * this.releaseUs };
      })
      .filter((v) => v.startUs < this.endUs && v.releasedUs > this.startUs);
  }

  gain(t: number): number {
    return Math.pow(10, (this.keyDb(t) - this.depthDb * this.duckFraction(t)) / 20) * this.fade(t);
  }

  /** Every point where a factor starts, ends, steps, bends or crosses another, inside the clip, sorted. */
  knots(): number[] {
    const set = new Set<number>([this.startUs, this.endUs, this.fadeInEndUs, this.fadeOutStartUs]);
    for (const k of this.keys) {
      set.add(k.atUs);
      if (k.ease === "hold") set.add(k.atUs - 1);
    }
    const a = this.attackUs;
    const r = this.releaseUs;
    this.voice.forEach((v, i) => {
      set.add(v.startUs);
      set.add(v.endUs);
      if (a === 0) set.add(v.startUs - 1);
      else if (v.startUs + a < v.endUs) set.add(v.startUs + a);
      if (r === 0) set.add(v.endUs - 1);
      set.add(Math.floor(v.releasedUs));
      set.add(Math.ceil(v.releasedUs));
      if (a === 0 || r === 0) return;
      // A release can cross the attack ramp of a later interval that starts before it ends.
      for (let j = i + 1; j < this.voice.length && this.voice[j].startUs < v.releasedUs; j++) {
        const w = this.voice[j];
        const crossing = (v.reached + v.endUs / r + w.startUs / a) / (1 / r + 1 / a);
        set.add(Math.floor(crossing));
        set.add(Math.ceil(crossing));
      }
    });
    return [...set].filter((t) => t >= this.startUs && t <= this.endUs).sort((x, y) => x - y);
  }

  /**
   * The fewest equal pieces `[a, b]` can be cut into so that interpolating
   * each is within the budget. Between knots every factor is smooth and
   * monotone: the keyframe curve is one eased segment, the ducking reduction
   * is linear in dB, and a fade is linear in amplitude.
   *
   * Two bounds on a piece of width w, where the level (keyframes plus
   * ducking, in dB) changes at most `slope` per µs and the keyframe curve
   * bends at most `bend` dB per µs²:
   * - any curve: the error is at most the level's range, `slope * w`, even
   *   with a fade across the piece (the interpolant is then a weighted mean
   *   of the endpoint levels relative to the exact one);
   * - without a fade: at most the exponential's convexity over
   *   `slope * w` plus the level's distance from its chord, `bend * w² / 8`.
   */
  piecesBetween(a: number, b: number): number {
    const width = b - a;
    if (width <= 1) return 1;
    const { slope, bend } = this.levelBounds(a, b);
    if (slope === 0) return 1;
    const fading = a < this.fadeInEndUs || b > this.fadeOutStartUs;
    // Rounding piece edges to whole microseconds can widen a piece by 1 µs. Pieces of
    // exactly 1 µs have no microsecond inside them, so they are always exact.
    const fits = (pieces: number) => {
      if (pieces >= width) return true;
      const w = width / pieces + 1;
      const range = slope * w;
      const error = fading ? range : Math.min(range, convexityDb(range) + (bend * w * w) / 8);
      return error <= INTERPOLATION_BUDGET_DB;
    };
    if (fits(1)) return 1;
    let lo = 1;
    let hi = 2;
    while (!fits(hi)) {
      lo = hi;
      hi = Math.min(width, hi * 2);
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  private levelBounds(a: number, b: number): { slope: number; bend: number } {
    let slope = Math.abs(this.duckFraction(b) - this.duckFraction(a)) * this.depthDb / (b - a);
    let bend = 0;
    const k = this.keyIndexAfter(a);
    if (k > 0 && k < this.keys.length) {
      const from = this.keys[k - 1];
      const to = this.keys[k];
      const span = to.atUs - from.atUs;
      const delta = Math.abs(to.db - from.db);
      slope += (delta * EASE_BOUNDS[to.ease].slope) / span;
      bend = (delta * EASE_BOUNDS[to.ease].curvature) / (span * span);
    }
    return { slope, bend };
  }

  /** Index of the first keyframe strictly after `t`. */
  private keyIndexAfter(t: number): number {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid].atUs <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private keyDb(t: number): number {
    const keys = this.keys;
    if (keys.length === 0) return 0;
    const k = this.keyIndexAfter(t);
    if (k === 0) return keys[0].db;
    if (k === keys.length) return keys[k - 1].db;
    const from = keys[k - 1];
    const to = keys[k];
    return from.db + (to.db - from.db) * ease(to.ease, (t - from.atUs) / (to.atUs - from.atUs));
  }

  private fade(t: number): number {
    let f = 1;
    if (t < this.fadeInEndUs) f *= (t - this.startUs) / (this.fadeInEndUs - this.startUs);
    if (t > this.fadeOutStartUs) f *= (this.endUs - t) / (this.endUs - this.fadeOutStartUs);
    return f;
  }

  /** The ducking reduction at `t` as a fraction of `depthDb`, 0 to 1. */
  private duckFraction(t: number): number {
    const voice = this.voice;
    if (voice.length === 0) return 0;
    let lo = 0;
    let hi = voice.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (voice[mid].startUs <= t) lo = mid + 1;
      else hi = mid;
    }
    let deepest = 0;
    // Intervals are disjoint and sorted, so once a release ends before `t` every earlier one has too.
    for (let i = lo - 1; i >= 0 && voice[i].endUs + this.releaseUs >= t; i--) {
      deepest = Math.max(deepest, this.shape(voice[i], t));
      if (deepest === 1) break;
    }
    return deepest;
  }

  private shape(v: VoiceShape, t: number): number {
    if (t < v.startUs) return 0;
    if (t < v.endUs) return this.attackUs === 0 ? 1 : Math.min(1, (t - v.startUs) / this.attackUs);
    if (this.releaseUs === 0) return 0;
    return Math.max(0, v.reached - (t - v.endUs) / this.releaseUs);
  }
}
