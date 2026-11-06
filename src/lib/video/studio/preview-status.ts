/**
 * What the Studio preview says when it cannot show something (#150): media
 * whose derived files are not ready, and compiler issues that keep a revision
 * from being previewed or exported, in plain words.
 */
import type { CompileIssue, CompileIssueCode } from "@/lib/video/render/plan";
import type { DerivedFileName, MediaView } from "./types";

export type MediaReadiness =
  | { state: "ready"; poster: boolean }
  | { state: "preparing" }
  | { state: "failed"; message: string }
  /** Not in the media library the page last read. */
  | { state: "missing" };

/** Whether the element for `mediaId` can load `file` yet. */
export function mediaReadiness(media: readonly MediaView[], mediaId: string, file: DerivedFileName): MediaReadiness {
  const record = media.find((m) => m.mediaId === mediaId);
  if (!record) return { state: "missing" };
  const { derived } = record;
  if (derived.state === "failed") return { state: "failed", message: "Its preview could not be made. Retry it in the media bin." };
  if (derived.state !== "succeeded" || !derived.files.includes(file)) return { state: "preparing" };
  return { state: "ready", poster: derived.files.includes("poster.jpg") };
}

const LEADS: Record<CompileIssueCode, string> = {
  empty_timeline: "The timeline is empty",
  profile_mismatch: "The format does not match the export profile",
  duration_exceeds_profile: "The production is longer than the export allows",
  unsupported_feature: "A clip uses something the export cannot make yet",
  capability_unavailable: "A graphic uses a style that is not available",
  invalid_capability_params: "A graphic has a value that is not allowed",
  media_not_registered: "A clip uses media that is not in the library",
  media_kind_mismatch: "A clip uses the wrong kind of media",
  no_audio_stream: "A sound clip uses media without sound",
};

export interface IssueLine {
  /** A short plain sentence naming the problem. */
  lead: string;
  /** The compiler's own detail, with a capital first letter. */
  detail: string;
  clipId?: string;
}

export interface PreviewBlock {
  /** Only `empty_timeline`: nothing has been added yet, which is a start, not a fault. */
  empty: boolean;
  lines: IssueLine[];
}

/** The compiler's issues as the preview lists them, one line each. */
export function describeIssues(issues: readonly CompileIssue[]): PreviewBlock {
  const empty = issues.length > 0 && issues.every((i) => i.code === "empty_timeline");
  const lines = issues.map((issue) => ({
    lead: LEADS[issue.code] ?? "The production cannot be compiled",
    detail: sentence(issue.message),
    ...(issue.clipId ? { clipId: issue.clipId } : {}),
  }));
  return { empty, lines };
}

function sentence(message: string): string {
  const text = message.trim();
  if (!text) return "";
  const capital = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
