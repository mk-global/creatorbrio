/**
 * How the Studio's media bin describes one library media (#150): its
 * preview state, the derived file its thumbnail reads once that file
 * exists, its kind and its length. Pure, from the API's media view.
 */
import { formatTimecode } from "./frames";
import { wholeFrames } from "./media-placement";
import type { DerivedFileName, MediaView } from "./types";

export type PreviewState = "preparing" | "ready" | "failed";

/** Whether the browser-playable copy is still being made, is ready, or failed. */
export function previewState(media: MediaView): PreviewState {
  if (media.derived.state === "succeeded") return "ready";
  if (media.derived.state === "failed") return "failed";
  return "preparing";
}

/** The derived file the thumbnail shows, once the job made it; audio has none. */
export function thumbnailFile(media: MediaView): DerivedFileName | null {
  const name: DerivedFileName | null = media.kind === "video" ? "poster.jpg" : media.kind === "image" ? "proxy.png" : null;
  return name && media.derived.state === "succeeded" && media.derived.files.includes(name) ? name : null;
}

export const KIND_LABEL: Record<MediaView["kind"], string> = { video: "Video", audio: "Audio", image: "Image" };

/** The media's length at the production's rate (`m:ss.ff`), or an image's upright size. */
export function mediaDetail(media: MediaView, fps: number): string {
  if (media.kind === "image") {
    const v = media.facts.video;
    if (!v) return "";
    const turned = v.rotation === 90 || v.rotation === 270;
    return `${turned ? v.height : v.width} × ${turned ? v.width : v.height}`;
  }
  const us = media.facts.durationUs;
  return typeof us === "number" ? formatTimecode(wholeFrames(us, fps), fps) : "";
}
