"use client";

/**
 * The media bin (#150), the workspace's left column: import by path, the
 * library with each media's preview state, and "Add to timeline", which
 * commits one change set placing the media at the end of its Studio track.
 * The library comes from the workspace (`media`), the production from the
 * session; the bin keeps only what is in flight and the last message.
 */
import { useState } from "react";
import { AlertTriangle, Film, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StudioApiError } from "@/lib/video/studio/api";
import { mediaInProduction, placeMedia } from "@/lib/video/studio/media-placement";
import { cryptoRandom, newClipId, usedIds } from "@/lib/video/studio/production-ids";
import { retryErrorMessage } from "@/lib/video/studio/studio-messages";
import type { MediaView } from "@/lib/video/studio/types";
import { MediaBinImport } from "./MediaBinImport";
import { MediaBinItem } from "./MediaBinItem";
import { useWorkspace } from "./workspace";

export function MediaBin() {
  const { api, session, state, media, refreshMedia, select } = useWorkspace();
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const production = state.view.production;

  async function add(item: MediaView) {
    setNotice(null);
    const placement = placeMedia(production, item, newClipId(usedIds(production), Date.now(), cryptoRandom));
    if (!placement.ok) {
      setNotice(placement.reason);
      return;
    }
    // A refusal is shown by the workspace's banner, with the stored state kept.
    if ((await session.apply(placement.summary, placement.ops)) === "applied") select(placement.clipId);
  }

  async function retry(item: MediaView) {
    setNotice(null);
    setRetrying((s) => new Set(s).add(item.mediaId));
    try {
      await api.retryMedia(item.mediaId);
    } catch (e) {
      setNotice(retryErrorMessage(e instanceof StudioApiError ? e : new StudioApiError(0, "unexpected_error", "something went wrong in the page")));
    } finally {
      await refreshMedia();
      setRetrying((s) => {
        const next = new Set(s);
        next.delete(item.mediaId);
        return next;
      });
    }
  }

  return (
    <section aria-labelledby="studio-media-title" className="flex min-h-0 flex-col border-r border-border bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 id="studio-media-title" className="text-[13px] font-semibold text-foreground">
          Media
        </h2>
        {media.length > 0 && <span className="text-[11px] text-muted-foreground tabular-nums">{media.length} in library</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MediaBinImport />
        {notice && (
          <div role="alert" className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-foreground">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
            <p className="flex-1">{notice}</p>
            <Button variant="ghost" size="sm" className="-m-1 h-6 w-6 px-0" onClick={() => setNotice(null)} aria-label="Dismiss">
              <X className="h-3 w-3" aria-hidden />
            </Button>
          </div>
        )}
        {media.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-8 text-center">
            <Film className="h-5 w-5 text-muted-foreground" aria-hidden />
            <p className="mt-2 text-xs text-muted-foreground">Your library has no media yet. Import footage, music or a still above.</p>
          </div>
        ) : (
          <ul aria-label="Library" className="divide-y divide-border">
            {media.map((item) => (
              <MediaBinItem
                key={item.mediaId}
                media={item}
                fps={production.format.fps}
                inProduction={mediaInProduction(production, item.mediaId)}
                busy={state.busy}
                retrying={retrying.has(item.mediaId)}
                onAdd={() => void add(item)}
                onRetry={() => void retry(item)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
