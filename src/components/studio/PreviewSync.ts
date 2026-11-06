"use client";

/**
 * Slaves the preview's media elements to the workspace playhead (#150).
 *
 * One animation-frame loop, outside React state: on every tick each mounted
 * element is brought to where the playhead says it should be (`syncAction`),
 * its volume set from its sound's gain envelope, and, while playing, its drift
 * from the target written to `data-drift-ms` for the end-to-end measurement.
 * A paused playhead holds every element at exactly its target, so a pause or
 * a seek sets exact times. A media element's clock stands still for a moment
 * after `play()`, so elements are started one start lead early (the next clip
 * before its cut, an element joining mid-clip ahead of its target), and the
 * lead is learned from how far behind or ahead each start actually landed.
 */
import { useCallback, useEffect, useRef } from "react";

import type { Playhead } from "@/lib/video/studio/playhead";
import {
  activeAt,
  elementTarget,
  INITIAL_START_LEAD_S,
  nextStartLead,
  START_SETTLE_MS,
  startsWithin,
  syncAction,
  volumeAt,
  type PreviewElement,
} from "@/lib/video/studio/preview-plan";

export type RegisterMedia = (clipId: string, element: HTMLMediaElement | null) => void;

export function usePreviewSync(playhead: Playhead, elements: readonly PreviewElement[], fps: number): RegisterMedia {
  const registry = useRef(new Map<string, HTMLMediaElement>());
  const latest = useRef({ byId: new Map<string, PreviewElement>(), fps });

  useEffect(() => {
    latest.current = { byId: new Map(elements.map((e) => [e.clipId, e])), fps };
  }, [elements, fps]);

  const register = useCallback<RegisterMedia>((clipId, element) => {
    if (element) registry.current.set(clipId, element);
    else registry.current.delete(clipId);
  }, []);

  useEffect(() => {
    const mediaElements = registry.current;
    /** Elements started and not yet measured: when `play()` was called, in page milliseconds. */
    const starting = new Map<HTMLMediaElement, number>();
    let lead = INITIAL_START_LEAD_S;
    let handle = 0;
    const tick = () => {
      const { byId, fps } = latest.current;
      const playing = playhead.getSnapshot().playing;
      const frame = playhead.currentFrame();
      const seconds = playhead.currentSeconds();
      for (const [clipId, el] of mediaElements) {
        const element = byId.get(clipId);
        if (!element) continue;
        // A seek in flight reports the time it is going to; correcting again would only queue more seeks.
        if (el.seeking) continue;
        const active = activeAt(element, frame);
        const target = elementTarget(element, frame, seconds, fps);
        const startedAt = starting.get(el);
        const settling = startedAt !== undefined && performance.now() - startedAt < START_SETTLE_MS;
        if (startedAt !== undefined && (!playing || el.paused)) starting.delete(el);
        else if (startedAt !== undefined && !settling && active) {
          lead = nextStartLead(lead, el.currentTime - target);
          starting.delete(el);
        }
        const action = syncAction({
          elementSeconds: el.currentTime,
          targetSeconds: target,
          active,
          playing,
          elementPaused: el.paused,
          startsSoon: startsWithin(element, seconds, fps, lead),
          startLeadSeconds: lead,
          settling,
        });
        if (action.pause) el.pause();
        if (action.seekTo !== null) el.currentTime = action.seekTo;
        if (el.playbackRate !== action.rate) el.playbackRate = action.rate;
        if (action.play) {
          starting.set(el, performance.now());
          el.play().catch(() => undefined);
        }
        if (element.sound) {
          const volume = volumeAt(element.sound.envelope, seconds);
          if (Math.abs(el.volume - volume) > 1e-3) el.volume = volume;
          if (el.muted) el.muted = false;
        } else if (!el.muted) {
          el.muted = true;
        }
        if (playing && active) el.dataset.driftMs = ((el.currentTime - target) * 1000).toFixed(1);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(handle);
      for (const el of mediaElements.values()) el.pause();
    };
  }, [playhead]);

  return register;
}
