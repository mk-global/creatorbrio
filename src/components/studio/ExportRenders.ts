"use client";

/**
 * The Export panel's data hook (#150): this production's renders, read when
 * the workspace opens and when the panel opens, and again about once a
 * second while any render is queued or running (even with the panel closed,
 * so the header can show progress). Requests, cancels and retries go through
 * the Render API; nothing here keeps a copy of a render the server did not
 * answer with.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { StudioApiError, type StudioApi } from "@/lib/video/studio/api";
import { RENDER_POLL_MS, shouldPoll, sortRenders, withRender } from "@/lib/video/studio/render-status";
import type { RenderView } from "@/lib/video/studio/types";
import type { CompileIssue } from "@/lib/video/render/plan";

export type RequestOutcome =
  | { kind: "queued"; render: RenderView }
  | { kind: "existing"; render: RenderView }
  | { kind: "refused"; revision: number | null; issues: CompileIssue[] }
  | { kind: "error"; message: string };

export interface Renders {
  renders: RenderView[] | null;
  /** The last failure to read the list, if the latest read failed. */
  error: string | null;
  refresh(): Promise<void>;
  request(): Promise<RequestOutcome>;
  /** Cancels or retries one render; resolves to an error message, or null when the server accepted it. */
  act(renderId: string, action: "cancel" | "retry"): Promise<string | null>;
}

export function useRenders(api: StudioApi, productionId: string, open: boolean): Renders {
  const [renders, setRenders] = useState<RenderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);

  const refresh = useCallback(async () => {
    // One read at a time: a slow answer is not overtaken by the next tick.
    if (reading.current) return;
    reading.current = true;
    try {
      setRenders(sortRenders(await api.listRenders(productionId)));
      setError(null);
    } catch (e) {
      setError(e instanceof StudioApiError ? e.message : "The renders could not be read.");
    } finally {
      reading.current = false;
    }
  }, [api, productionId]);

  // Read when the workspace opens, so a render left running shows in the header, and whenever the panel opens.
  useEffect(() => {
    void refresh();
  }, [open, refresh]);

  const polling = shouldPoll(renders ?? []);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void refresh(), RENDER_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  const request = useCallback(async (): Promise<RequestOutcome> => {
    try {
      const { status, render } = await api.requestRender(productionId);
      setRenders((list) => withRender(list ?? [], render));
      return { kind: status, render };
    } catch (e) {
      if (e instanceof StudioApiError && e.code === "render_refused") {
        const issues = Array.isArray(e.details.issues) ? (e.details.issues as CompileIssue[]) : [];
        return { kind: "refused", revision: typeof e.details.revision === "number" ? e.details.revision : null, issues };
      }
      return { kind: "error", message: e instanceof StudioApiError ? e.message : "The render could not be requested." };
    }
  }, [api, productionId]);

  const act = useCallback(
    async (renderId: string, action: "cancel" | "retry"): Promise<string | null> => {
      try {
        const { render } = action === "cancel" ? await api.cancelRender(productionId, renderId) : await api.retryRender(productionId, renderId);
        setRenders((list) => withRender(list ?? [], render));
        return null;
      } catch (e) {
        void refresh();
        return e instanceof StudioApiError ? e.message : `The render could not be ${action === "cancel" ? "cancelled" : "retried"}.`;
      }
    },
    [api, productionId, refresh]
  );

  return { renders, error, refresh, request, act };
}
