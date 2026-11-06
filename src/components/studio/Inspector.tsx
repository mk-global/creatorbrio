"use client";

/**
 * The Inspector (#150), the workspace's right column. With nothing selected
 * it adds graphics at the playhead; with a clip selected it shows the clip
 * and, for graphics, a form for its capability's parameters.
 *
 * Unsaved drafts are view state kept here by clip id, so switching the
 * selection away and back keeps what the person typed until they save or
 * revert it. Everything else is read from the stored production on every
 * render.
 */
import { useCallback, useState } from "react";

import { clipFacts } from "@/lib/video/studio/clip-placement";
import { InspectorAdd } from "./InspectorAdd";
import { InspectorClip } from "./InspectorClip";
import type { DraftEntry } from "./InspectorGraphic";
import { useWorkspace } from "./workspace";

export function Inspector() {
  const { state, selectedClipId } = useWorkspace();
  const [drafts, setDrafts] = useState<Record<string, DraftEntry>>({});
  const facts = selectedClipId ? clipFacts(state.view.production, selectedClipId) : null;

  const updateDraft = useCallback((clipId: string, update: (previous: DraftEntry | null) => DraftEntry | null) => {
    setDrafts((all) => {
      const previous = all[clipId] ?? null;
      const next = update(previous);
      if (next === previous) return all;
      const copy = { ...all };
      if (next) copy[clipId] = next;
      else delete copy[clipId];
      return copy;
    });
  }, []);

  return (
    <section aria-label="Inspector" className="min-h-0 overflow-y-auto border-l border-border bg-surface">
      {facts ? <InspectorClip facts={facts} draft={drafts[facts.clip.id] ?? null} updateDraft={updateDraft} /> : <InspectorAdd />}
    </section>
  );
}
