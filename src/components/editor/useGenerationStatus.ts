"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Interruption } from "@/lib/generation-status";

/** An unfinished design the user can continue: its run and how far it got. */
export interface ContinuationOffer {
  runId: string;
  saved: number;
  expected: number;
}

export interface GenerationStatus {
  generating: boolean;
  interrupted: Interruption | null;
  /** Set when the last design ended unfinished and can be continued. */
  continuation?: ContinuationOffer | null;
}

/** How often a visible tab asks while nothing is generating, and while something is. */
export const IDLE_POLL_MS = 2000;
export const ACTIVE_POLL_MS = 1000;

const NOT_GENERATING: GenerationStatus = { generating: false, interrupted: null, continuation: null };

function offerOf(value: unknown): ContinuationOffer | null {
  const v = value as Partial<ContinuationOffer> | null | undefined;
  return typeof v?.runId === "string" && typeof v.saved === "number" && typeof v.expected === "number"
    ? { runId: v.runId, saved: v.saved, expected: v.expected }
    : null;
}

export interface WatchOptions {
  onStatus: (status: GenerationStatus) => void;
  fetchStatus: () => Promise<GenerationStatus>;
  isVisible: () => boolean;
  schedule?: (run: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
}

export interface GenerationWatcher {
  /** Ask now, for example when the tab becomes visible or a chat stream ends. */
  refresh: () => void;
  stop: () => void;
}

/**
 * Keeps asking the server whether a carousel is being generated or was left
 * interrupted. Every open tab of the editor does this, so a tab left idle
 * notices a generation started from another tab within a couple of seconds.
 * A hidden tab stops asking until it is shown again. A failed request keeps
 * the last answer; the export route refuses unsafe exports on its own.
 */
export function watchGenerationStatus({
  onStatus,
  fetchStatus,
  isVisible,
  schedule = (run, ms) => setTimeout(run, ms),
  unschedule = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: WatchOptions): GenerationWatcher {
  let stopped = false;
  let inFlight = false;
  let askAgain = false;
  let timer: unknown = null;
  let last = NOT_GENERATING;

  const check = async () => {
    if (stopped) return;
    if (inFlight) {
      askAgain = true;
      return;
    }
    if (timer !== null) unschedule(timer);
    timer = null;
    inFlight = true;
    try {
      last = await fetchStatus();
      if (!stopped) onStatus(last);
    } catch {
      // Keep the last answer and try again on the next tick.
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    if (askAgain) {
      askAgain = false;
      void check();
    } else if (isVisible()) {
      timer = schedule(() => void check(), last.generating ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    }
  };

  void check();
  return {
    refresh: () => void check(),
    stop: () => {
      stopped = true;
      if (timer !== null) unschedule(timer);
    },
  };
}

async function fetchGenerationStatus(carouselId: string): Promise<GenerationStatus> {
  const res = await fetch(`/api/carousels/${carouselId}/generation`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Status request failed with ${res.status}`);
  const body: Partial<GenerationStatus> = await res.json();
  return { generating: body.generating === true, interrupted: body.interrupted ?? null, continuation: offerOf(body.continuation) };
}

/**
 * Whether export is safe for this carousel, as seen by this tab: generating
 * while this tab's chat stream is open or the server reports a run, and
 * interrupted when the last run stopped, failed or timed out after changing
 * slides. `acceptSlides` is the user confirming an interrupted carousel's
 * slides as they are.
 */
export function useGenerationStatus(carouselId: string, streaming: boolean) {
  const [status, setStatus] = useState<GenerationStatus>(NOT_GENERATING);
  const [wasStreaming, setWasStreaming] = useState(streaming);
  const watcher = useRef<GenerationWatcher | null>(null);

  // When this tab's stream closes, the run may still be settling. Count it as
  // generating until the server has answered, so export never opens early.
  if (streaming !== wasStreaming) {
    setWasStreaming(streaming);
    if (!streaming) setStatus((s) => ({ ...s, generating: true }));
  }

  useEffect(() => {
    const w = watchGenerationStatus({
      onStatus: setStatus,
      fetchStatus: () => fetchGenerationStatus(carouselId),
      isVisible: () => document.visibilityState === "visible",
    });
    watcher.current = w;
    const onVisible = () => {
      if (document.visibilityState === "visible") w.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      w.stop();
      watcher.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [carouselId]);

  useEffect(() => {
    watcher.current?.refresh();
  }, [streaming]);

  const acceptSlides = useCallback(async () => {
    const res = await fetch(`/api/carousels/${carouselId}/generation`, { method: "DELETE" });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(body.error || `The request failed with status ${res.status}.`);
    }
    setStatus(NOT_GENERATING);
    watcher.current?.refresh();
  }, [carouselId]);

  const generating = streaming || status.generating;
  return {
    generating,
    interrupted: generating ? null : status.interrupted,
    continuation: generating ? null : (status.continuation ?? null),
    acceptSlides,
  };
}
