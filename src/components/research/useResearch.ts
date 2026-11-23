"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CarouselResearch, ConfirmedResearch, ResearchDirection } from "@/types/research";

/** How often the screen asks for progress while research runs. */
const POLL_MS = 1500;

export type ResearchState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; research: CarouselResearch | null };

/** Why a start was refused. `code` is the failure code of a refusal that Settings fixes, when the server names one. */
export interface StartRefusal {
  message: string;
  code: string | null;
}

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; body: T } | { ok: false; status: number; error: string; code: string | null }> {
  try {
    const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: unknown };
    if (res.ok) return { ok: true, body };
    return {
      ok: false,
      status: res.status,
      error: body.error || `The app answered with status ${res.status}.`,
      code: typeof body.code === "string" ? body.code : null,
    };
  } catch {
    return { ok: false, status: 0, error: "CreatorBrio did not answer. Check that it is still running, then try again.", code: null };
  }
}

/**
 * A project's research (#253), kept current: read once, then polled while a
 * run is in progress, so a reload or a second tab shows the same state.
 * Every action answers with the server's record or its message.
 */
export function useResearch(projectId: string) {
  const [state, setState] = useState<ResearchState>({ status: "loading" });
  const base = `/api/carousels/${encodeURIComponent(projectId)}/research`;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((result: Awaited<ReturnType<typeof call<{ research: CarouselResearch | null }>>>) => {
    if (!alive.current) return;
    if (result.ok) setState({ status: "ready", research: result.body.research });
    else if (result.status === 404) setState({ status: "missing" });
    // A failed poll keeps what is on screen; only the first read reports it.
    else setState((prev) => (prev.status === "ready" ? prev : { status: "error", message: result.error }));
  }, []);
  const load = useCallback(async () => apply(await call<{ research: CarouselResearch | null }>(base)), [base, apply]);

  useEffect(() => {
    void call<{ research: CarouselResearch | null }>(base).then(apply);
  }, [base, apply]);

  const running = state.status === "ready" && state.research?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const start = useCallback(
    async (topic: string, links: string[]): Promise<StartRefusal | null> => {
      const result = await call<{ research: CarouselResearch }>(base, { method: "POST", body: JSON.stringify({ topic, links }) });
      if (!alive.current) return null;
      if (!result.ok) {
        // Already running (another tab): show that run rather than an error.
        if (result.status === 409) await load();
        return result.status === 409 ? null : { message: result.error, code: result.code };
      }
      setState({ status: "ready", research: result.body.research });
      return null;
    },
    [base, load]
  );

  const stop = useCallback(async () => {
    await call(`${base}/cancel`, { method: "POST" });
    await load();
  }, [base, load]);

  const confirm = useCallback(
    async (revision: number, direction: ResearchDirection): Promise<{ ok: true; confirmed: ConfirmedResearch } | { ok: false; error: string }> => {
      const result = await call<{ research: CarouselResearch }>(`${base}/confirm`, {
        method: "POST",
        body: JSON.stringify({ revision, direction }),
      });
      // The person left the page while this was in flight: whatever the server did,
      // nothing here may go on to hand off a design request or open the editor.
      if (!alive.current) return { ok: false, error: "You left this page before the direction was confirmed. Confirm it again to start the design." };
      if (!result.ok) {
        if (result.status === 409) await load();
        return { ok: false, error: result.error };
      }
      const confirmed = result.body.research?.confirmed;
      if (!confirmed) return { ok: false, error: "CreatorBrio did not confirm the direction. Try again." };
      setState({ status: "ready", research: result.body.research });
      return { ok: true, confirmed };
    },
    [base, load]
  );

  return { state, start, stop, confirm, reload: load };
}
