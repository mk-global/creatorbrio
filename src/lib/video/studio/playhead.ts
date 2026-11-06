/**
 * The Studio preview's one master clock (#150). The playhead is the time the
 * preview shows; media elements follow it (`slaveCorrection`) and the overlay
 * is re-seeked to it, so nothing drifts relative to anything but the playhead.
 *
 * While playing, the frame is computed from elapsed time since the last
 * play or seek, never by adding per-tick increments, so slow or dropped
 * animation frames cannot accumulate drift. Framework-free, with an injected
 * time source and frame scheduler, so its timing is unit-tested; React reads
 * it through `useSyncExternalStore`.
 */

export interface PlayheadState {
  /** The frame shown, an integer in `[0, durationFrames)`; 0 when the production is empty. */
  frame: number;
  playing: boolean;
}

export interface Scheduler {
  now(): number;
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export const browserScheduler = (): Scheduler => ({
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(() => callback()),
  cancel: (handle) => cancelAnimationFrame(handle),
});

type Listener = () => void;

export class Playhead {
  private state: PlayheadState = { frame: 0, playing: false };
  private readonly listeners = new Set<Listener>();
  private anchor = { atMs: 0, frame: 0 };
  private handle: number | null = null;

  constructor(
    private fps: number,
    private durationFrames: number,
    private readonly scheduler: Scheduler
  ) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlayheadState => this.state;

  /** The current frame, exact at this instant (between notifications while playing). */
  currentFrame(): number {
    if (!this.state.playing) return this.state.frame;
    return this.frameAt(this.scheduler.now());
  }

  /** The current time in seconds of timeline time, unrounded, for slaving media elements. */
  currentSeconds(): number {
    if (!this.state.playing) return this.state.frame / this.fps;
    const seconds = this.anchor.frame / this.fps + (this.scheduler.now() - this.anchor.atMs) / 1000;
    return Math.min(seconds, this.lastFrame() / this.fps);
  }

  /** Takes a new length or frame rate after an edit, keeping the frame inside it. */
  setTimeline(fps: number, durationFrames: number): void {
    const playing = this.state.playing;
    if (playing) this.pause();
    this.fps = fps;
    this.durationFrames = durationFrames;
    this.seek(this.state.frame);
    if (playing && this.durationFrames > 0) this.play();
  }

  play(): void {
    if (this.state.playing || this.durationFrames <= 0) return;
    // Playing from the last frame starts again from the beginning.
    const from = this.state.frame >= this.lastFrame() ? 0 : this.state.frame;
    this.anchor = { atMs: this.scheduler.now(), frame: from };
    this.set({ frame: from, playing: true });
    this.tick();
  }

  pause(): void {
    if (!this.state.playing) return;
    const frame = this.frameAt(this.scheduler.now());
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
    this.set({ frame, playing: false });
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  /** Shows `frame`, clamped to the timeline; playing continues from there. */
  seek(frame: number): void {
    const clamped = this.clamp(frame);
    this.anchor = { atMs: this.scheduler.now(), frame: clamped };
    if (clamped !== this.state.frame) this.set({ frame: clamped });
  }

  dispose(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
    this.listeners.clear();
  }

  private tick = (): void => {
    this.handle = null;
    if (!this.state.playing) return;
    const frame = this.frameAt(this.scheduler.now());
    if (frame >= this.lastFrame()) {
      // The end: stop on the last frame.
      this.set({ frame: this.lastFrame(), playing: false });
      return;
    }
    if (frame !== this.state.frame) this.set({ frame });
    this.handle = this.scheduler.request(this.tick);
  };

  private frameAt(nowMs: number): number {
    return this.clamp(this.anchor.frame + Math.floor(((nowMs - this.anchor.atMs) / 1000) * this.fps + 1e-9));
  }

  private lastFrame(): number {
    return Math.max(0, this.durationFrames - 1);
  }

  private clamp(frame: number): number {
    if (!Number.isFinite(frame)) return 0;
    return Math.min(Math.max(0, Math.round(frame)), this.lastFrame());
  }

  private set(patch: Partial<PlayheadState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export interface SlaveAction {
  /** Seek the element to this time (seconds of its own media), or null to leave it. */
  seekTo: number | null;
  /** Playback rate to set, to close a small drift smoothly. */
  rate: number;
}

/** Drift beyond this many seconds is closed by seeking; below it, by nudging the rate. */
export const HARD_SYNC_S = 0.25;
/** Drift below this is left alone. */
export const SOFT_SYNC_S = 1 / 120;

/**
 * How to bring a playing media element back to where the playhead says it
 * should be: a seek for a large drift (a stall or a jump), a gentle rate
 * change for a small one (seeks are audible), nothing within a quarter frame
 * at 30 fps.
 */
export function slaveCorrection(elementSeconds: number, targetSeconds: number): SlaveAction {
  const drift = elementSeconds - targetSeconds;
  if (Math.abs(drift) > HARD_SYNC_S) return { seekTo: targetSeconds, rate: 1 };
  if (Math.abs(drift) <= SOFT_SYNC_S) return { seekTo: null, rate: 1 };
  // Behind: speed up a little; ahead: slow down a little. 5% closes a 100 ms drift in about 2 s.
  return { seekTo: null, rate: drift < 0 ? 1.05 : 0.95 };
}
