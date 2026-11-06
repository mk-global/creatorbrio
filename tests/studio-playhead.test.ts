/**
 * The Studio preview's master clock (#150): frames follow elapsed time, not
 * the number of ticks, so slow animation frames never accumulate drift;
 * seeking, pausing and the end of the timeline behave as a person expects;
 * and media elements are corrected by rate for small drift and by seek for
 * large.
 */
import { describe, expect, it } from "vitest";

import { HARD_SYNC_S, Playhead, SETTLED_SYNC_S, slaveCorrection, SOFT_SYNC_S, type Scheduler } from "@/lib/video/studio/playhead";

/** A scheduler whose time and animation frames the test advances by hand. */
function manual() {
  let now = 1_000;
  let next = 1;
  const pending = new Map<number, () => void>();
  const scheduler: Scheduler = {
    now: () => now,
    request: (cb) => {
      pending.set(next, cb);
      return next++;
    },
    cancel: (h) => void pending.delete(h),
  };
  const advance = (ms: number) => {
    now += ms;
    const due = [...pending.values()];
    pending.clear();
    due.forEach((cb) => cb());
  };
  return { scheduler, advance, pending: () => pending.size };
}

describe("the playhead", () => {
  it("advances by elapsed time, however irregular the animation frames", () => {
    const m = manual();
    const p = new Playhead(30, 300, m.scheduler);
    p.play();
    // 1 s in ticks of 7, 50, 3 and 240 ms (a stall), then the rest.
    for (const ms of [7, 50, 3, 240, 700]) m.advance(ms);
    expect(p.getSnapshot()).toEqual({ frame: 30, playing: true });
    m.advance(1_000 / 30);
    expect(p.getSnapshot().frame).toBe(31);
    expect(p.currentSeconds()).toBeCloseTo(1 + 1 / 30, 6);
  });

  it("holds the frame on pause and continues from it", () => {
    const m = manual();
    const p = new Playhead(30, 300, m.scheduler);
    p.play();
    m.advance(500);
    p.pause();
    expect(p.getSnapshot()).toEqual({ frame: 15, playing: false });
    expect(m.pending()).toBe(0);
    m.advance(5_000);
    expect(p.getSnapshot().frame).toBe(15);
    p.play();
    m.advance(1_000);
    expect(p.getSnapshot().frame).toBe(45);
  });

  it("seeks to whole frames inside the timeline, also while playing", () => {
    const m = manual();
    const p = new Playhead(30, 90, m.scheduler);
    p.seek(41.6);
    expect(p.getSnapshot().frame).toBe(42);
    p.seek(-5);
    expect(p.getSnapshot().frame).toBe(0);
    p.seek(1e9);
    expect(p.getSnapshot().frame).toBe(89);
    p.seek(10);
    p.play();
    m.advance(1_000);
    p.seek(60);
    m.advance(500);
    expect(p.getSnapshot()).toEqual({ frame: 75, playing: true });
  });

  it("stops on the last frame and starts again from the beginning", () => {
    const m = manual();
    const p = new Playhead(30, 60, m.scheduler);
    p.play();
    m.advance(5_000);
    expect(p.getSnapshot()).toEqual({ frame: 59, playing: false });
    p.play();
    expect(p.getSnapshot()).toEqual({ frame: 0, playing: true });
  });

  it("does not play an empty timeline, and keeps the frame inside a shortened one", () => {
    const m = manual();
    const empty = new Playhead(30, 0, m.scheduler);
    empty.play();
    expect(empty.getSnapshot()).toEqual({ frame: 0, playing: false });
    const p = new Playhead(30, 300, m.scheduler);
    p.seek(200);
    p.setTimeline(30, 120);
    expect(p.getSnapshot().frame).toBe(119);
  });

  it("stops on unmount and works again when the same instance is mounted again", () => {
    const m = manual();
    const p = new Playhead(30, 300, m.scheduler);
    const seen: boolean[] = [];
    p.subscribe(() => seen.push(p.getSnapshot().playing));
    p.play();
    p.stop();
    expect(m.pending()).toBe(0);
    p.play();
    m.advance(100);
    expect(seen).toEqual([true, false, true, true]);
  });

  it("notifies on every change of frame or state", () => {
    const m = manual();
    const p = new Playhead(30, 300, m.scheduler);
    const seen: string[] = [];
    p.subscribe(() => seen.push(`${p.getSnapshot().frame}:${p.getSnapshot().playing}`));
    p.play();
    m.advance(1_000 / 30 + 0.01);
    p.pause();
    expect(seen).toEqual(["0:true", "1:true", "1:false"]);
  });
});

describe("media element correction", () => {
  it("leaves drift within three quarters of a frame alone, nudges the rate beyond it and seeks for large", () => {
    expect(slaveCorrection(10.004, 10)).toEqual({ seekTo: null, rate: 1 });
    expect(slaveCorrection(10 - (SOFT_SYNC_S - 0.001), 10)).toEqual({ seekTo: null, rate: 1 });
    expect(slaveCorrection(9.95, 10)).toEqual({ seekTo: null, rate: 1.05 });
    expect(slaveCorrection(10.05, 10)).toEqual({ seekTo: null, rate: 0.95 });
    expect(slaveCorrection(10 + HARD_SYNC_S + 0.01, 10)).toEqual({ seekTo: 10, rate: 1 });
    expect(slaveCorrection(3, 10)).toEqual({ seekTo: 10, rate: 1 });
  });

  it("holds a nudge under way until the drift has settled, so the rate never flips at the band's edge", () => {
    // A drift just outside the band starts a nudge; the jitter that brings it back inside does not stop it.
    expect(slaveCorrection(10 - (SOFT_SYNC_S + 0.001), 10, 1)).toEqual({ seekTo: null, rate: 1.05 });
    expect(slaveCorrection(10 - (SOFT_SYNC_S - 0.001), 10, 1.05)).toEqual({ seekTo: null, rate: 1.05 });
    // Only once it is within the settled band does the rate return to normal.
    expect(slaveCorrection(10 - (SETTLED_SYNC_S - 0.001), 10, 1.05)).toEqual({ seekTo: null, rate: 1 });
    // An overshoot past the settled band reverses the nudge; a stall beyond the hard limit still seeks.
    expect(slaveCorrection(10 + 0.012, 10, 1.05)).toEqual({ seekTo: null, rate: 0.95 });
    expect(slaveCorrection(9.5, 10, 1.05)).toEqual({ seekTo: 10, rate: 1 });
  });

  it("changes the rate twice for one drift that closes, never back and forth", () => {
    // An element 40 ms behind, closing at the nudge, with ±2 ms jitter in each reading.
    let rate = 1;
    let drift = -0.04;
    let changes = 0;
    for (let tick = 0; tick < 120; tick++) {
      const jitter = (tick % 2 === 0 ? 1 : -1) * 0.002;
      const next = slaveCorrection(10 + drift + jitter, 10, rate).rate;
      if (next !== rate) changes++;
      rate = next;
      drift += (rate - 1) / 60;
    }
    expect(changes).toBe(2);
    expect(rate).toBe(1);
    expect(Math.abs(drift)).toBeLessThan(SOFT_SYNC_S);
  });
});
