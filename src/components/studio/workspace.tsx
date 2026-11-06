"use client";

/**
 * What every Studio panel shares (#150): the API client, the production
 * session (the stored production, its preview and the only way to change it),
 * the playhead, the selected clip and the media library. Panels read it with
 * `useWorkspace()`; none of them keeps a copy of the timeline.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { StudioApi } from "@/lib/video/studio/api";
import { browserScheduler, Playhead, type PlayheadState } from "@/lib/video/studio/playhead";
import { ProductionSession, type ProductionSessionState } from "@/lib/video/studio/production-session";
import type { MediaView, PreviewView, ProductionView } from "@/lib/video/studio/types";

export interface Workspace {
  api: StudioApi;
  session: ProductionSession;
  /** The session's state once the production has loaded. */
  state: ProductionSessionState & { view: ProductionView; preview: PreviewView };
  playhead: Playhead;
  playheadState: PlayheadState;
  selectedClipId: string | null;
  select(clipId: string | null): void;
  media: MediaView[];
  /** Reads the media library again, e.g. after an import. */
  refreshMedia(): Promise<void>;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useWorkspace must be used inside the Studio workspace");
  return workspace;
}

let sharedApi: StudioApi | null = null;
export function useStudioApi(): StudioApi {
  if (!sharedApi) sharedApi = new StudioApi();
  return sharedApi;
}

/** One production session for `productionId`, loaded on mount and disposed on change. */
export function useProductionSession(api: StudioApi, productionId: string): { session: ProductionSession; state: ProductionSessionState } {
  const session = useMemo(() => new ProductionSession(api, productionId), [api, productionId]);
  useEffect(() => {
    void session.load();
    return () => session.dispose();
  }, [session]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { session, state };
}

/** The master clock, following the compiled plan's frame rate and length. */
export function usePlayhead(fps: number, durationFrames: number): { playhead: Playhead; playheadState: PlayheadState } {
  const [playhead] = useState(() => new Playhead(fps, durationFrames, browserScheduler()));
  useEffect(() => playhead.setTimeline(fps, durationFrames), [playhead, fps, durationFrames]);
  useEffect(() => () => playhead.dispose(), [playhead]);
  const playheadState = useSyncExternalStore(playhead.subscribe, playhead.getSnapshot, playhead.getSnapshot);
  return { playhead, playheadState };
}

/** How often the media library is read again while a preview job is still running. */
const MEDIA_POLL_MS = 1_500;

/** The media library, read again while any derived-files job is unfinished. */
export function useMediaLibrary(api: StudioApi): { media: MediaView[]; refreshMedia(): Promise<void> } {
  const [media, setMedia] = useState<MediaView[]>([]);
  const refreshMedia = useCallback(async () => {
    try {
      setMedia(await api.listMedia());
    } catch {
      // Panels show their own errors; a failed refresh keeps the last list.
    }
  }, [api]);
  useEffect(() => {
    let current = true;
    api.listMedia().then(
      (list) => current && setMedia(list),
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [api]);
  const unfinished = media.some((m) => m.derived.state === "queued" || m.derived.state === "running");
  useEffect(() => {
    if (!unfinished) return;
    const timer = setInterval(() => void refreshMedia(), MEDIA_POLL_MS);
    return () => clearInterval(timer);
  }, [unfinished, refreshMedia]);
  return { media, refreshMedia };
}
