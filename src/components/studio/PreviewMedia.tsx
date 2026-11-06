"use client";

/**
 * One clip's media element in the preview (#150): a `<video>`, `<img>` or
 * `<audio>` of the media's proxy, placed by `layerBox()` at the canvas scale.
 * Media whose derived files are not ready yet shows a neutral tile in its box
 * instead of a broken element, and failed media a short message.
 */
import { memo, useCallback } from "react";
import Image from "next/image";
import { ImageOff, LoaderCircle } from "lucide-react";

import { mediaFileUrl } from "@/lib/video/studio/api";
import { scaledLayerBox } from "@/lib/video/studio/preview-layout";
import type { PreviewElement } from "@/lib/video/studio/preview-plan";
import type { MediaReadiness } from "@/lib/video/studio/preview-status";
import type { RegisterMedia } from "./PreviewSync";

interface Props {
  element: PreviewElement;
  readiness: MediaReadiness;
  scale: number;
  /** The clip is on the playhead's frame; otherwise it waits, hidden, for its cut. */
  visible: boolean;
  register: RegisterMedia;
}

export const PreviewMedia = memo(function PreviewMedia({ element, readiness, scale, visible, register }: Props) {
  const { clipId, mediaId, tag, file, layer } = element;
  const ref = useCallback((node: HTMLMediaElement | null) => register(clipId, node), [register, clipId]);
  const common = { "data-studio-media": "", "data-clip-id": clipId } as const;

  if (!layer) {
    // A sound with no picture: nothing to draw, and nothing to play until its proxy is ready.
    if (readiness.state !== "ready") return null;
    return <audio ref={ref} {...common} src={mediaFileUrl(mediaId, file)} preload="auto" aria-hidden />;
  }

  const box = scaledLayerBox(layer.placement, scale);
  const style = { left: box.left, top: box.top, width: box.width, height: box.height, zIndex: layer.trackIndex, visibility: visible ? "visible" : "hidden" } as const;

  if (readiness.state !== "ready") {
    const failed = readiness.state === "failed";
    return (
      <div {...common} style={style} className="absolute flex items-center justify-center bg-neutral-900 text-neutral-300" role="img" aria-label={failed ? readiness.message : "Preparing preview"}>
        <span className="flex max-w-[60%] flex-col items-center gap-2 text-center text-xs leading-snug">
          {failed ? <ImageOff className="h-5 w-5" aria-hidden /> : <LoaderCircle className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden />}
          {failed ? readiness.message : "Preparing preview"}
        </span>
      </div>
    );
  }

  const src = mediaFileUrl(mediaId, file);
  if (tag === "img") {
    // `unoptimized`: the proxy is already sized for the preview and served by the media route as it is.
    return (
      <Image
        {...common}
        src={src}
        alt=""
        width={layer.placement.scaledWidth}
        height={layer.placement.scaledHeight}
        unoptimized
        loading="eager"
        draggable={false}
        style={style}
        className="absolute block max-w-none object-fill select-none"
      />
    );
  }
  return (
    <video
      ref={ref}
      {...common}
      src={src}
      poster={readiness.poster ? mediaFileUrl(mediaId, "poster.jpg") : undefined}
      preload="auto"
      playsInline
      muted={!element.sound}
      disablePictureInPicture
      disableRemotePlayback
      tabIndex={-1}
      aria-hidden
      style={style}
      className="absolute block max-w-none object-fill"
    />
  );
});
