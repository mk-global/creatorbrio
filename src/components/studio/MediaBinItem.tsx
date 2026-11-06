"use client";

/**
 * One media in the library (#150): its thumbnail once the poster or image
 * proxy exists, name, kind, length, preview state with Retry when it failed,
 * whether this production already uses it, and "Add to timeline".
 */
import Image from "next/image";
import { AlertTriangle, Check, Loader2, Music, Plus, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { mediaFileUrl } from "@/lib/video/studio/api";
import { KIND_LABEL, mediaDetail, previewState, thumbnailFile } from "@/lib/video/studio/media-library";
import type { MediaView } from "@/lib/video/studio/types";

export interface MediaBinItemProps {
  media: MediaView;
  fps: number;
  inProduction: boolean;
  /** A production command or this media's retry is in flight. */
  busy: boolean;
  retrying: boolean;
  onAdd(): void;
  onRetry(): void;
}

function Thumbnail({ media }: { media: MediaView }) {
  const file = thumbnailFile(media);
  return (
    <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted" aria-hidden>
      {file ? (
        <Image src={mediaFileUrl(media.mediaId, file)} alt="" fill sizes="48px" unoptimized className="object-cover" />
      ) : media.kind === "audio" ? (
        <Music className="h-4 w-4 text-muted-foreground" />
      ) : previewState(media) === "failed" ? (
        <AlertTriangle className="h-4 w-4 text-destructive" />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
    </span>
  );
}

export function MediaBinItem({ media, fps, inProduction, busy, retrying, onAdd, onRetry }: MediaBinItemProps) {
  const state = previewState(media);
  const detail = mediaDetail(media, fps);
  return (
    <li className="flex gap-2.5 px-3 py-2.5">
      <Thumbnail media={media} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground" title={media.originalName}>
          {media.originalName}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground tabular-nums">
          {KIND_LABEL[media.kind]}
          {detail && <> · {detail}</>}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {state === "preparing" && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Preparing preview
            </span>
          )}
          {state === "failed" && (
            <span className="inline-flex items-center gap-1 text-[11px] text-destructive" title={media.derived.failure?.message}>
              <AlertTriangle className="h-3 w-3" aria-hidden />
              Preview failed
            </span>
          )}
          {state === "ready" && !inProduction && <span className="text-[11px] text-muted-foreground">Ready</span>}
          {inProduction && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 py-px text-[11px] font-medium text-accent">
              <Check className="h-3 w-3" aria-hidden />
              In this production
            </span>
          )}
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]" disabled={busy} onClick={onAdd} aria-label={`Add ${media.originalName} to the timeline`}>
            <Plus className="h-3 w-3" aria-hidden />
            Add to timeline
          </Button>
          {state === "failed" && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px]" disabled={retrying} onClick={onRetry} aria-label={`Retry the preview of ${media.originalName}`}>
              <RotateCw className={retrying ? "h-3 w-3 animate-spin" : "h-3 w-3"} aria-hidden />
              Retry
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
