"use client";

/**
 * A graphics clip's parameter form (#150). The form shows the person's draft
 * while there is one, and the stored parameters otherwise. Save commits the
 * draft as one `setGraphicParams` change set; a refusal keeps the draft and
 * shows each issue at its field; Revert discards the draft.
 */
import { useEffect, useRef } from "react";
import { Save, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  draftDiffers,
  draftFromParams,
  formIssues,
  paramsFromDraft,
  type FormIssues,
  type GraphicDraft,
  type GraphicKindInfo,
} from "@/lib/video/studio/capability-forms";
import type { Refusal } from "@/lib/video/studio/production-session";
import type { GraphicsClip } from "@/types/production";
import { InspectorCaptions } from "./InspectorCaptions";
import { ReadOnlyParams } from "./InspectorClip";
import { LowerThirdFields, TitleCardFields } from "./InspectorGraphicFields";
import { useWorkspace } from "./workspace";

export interface DraftEntry {
  draft: GraphicDraft;
  /** The stored parameters when the draft began, to notice a change underneath it (an undo, another writer). */
  base: string;
  /** The last refused Save's issues, shown until the next Save or a Revert. */
  issues: FormIssues | null;
  /** The session's refusal of that Save, so a Revert can dismiss its banner too. */
  refusal?: Refusal | null;
}

interface Props {
  clip: GraphicsClip;
  info: GraphicKindInfo;
  entry: DraftEntry | null;
  update(fn: (previous: DraftEntry | null) => DraftEntry | null): void;
}

export interface FieldsProps<D extends GraphicDraft> {
  draft: D;
  change(draft: D): void;
  submit(): void;
  errors(key: string): string[] | undefined;
}

export function InspectorGraphic({ clip, info, entry, update }: Props) {
  const { session, state } = useWorkspace();
  const formRef = useRef<HTMLFormElement>(null);
  // Set by a refused Save; once its issues are on screen, the first field they name is focused.
  const focusIssue = useRef(false);
  const shownIssues = entry?.issues ?? null;
  useEffect(() => {
    if (!focusIssue.current || !shownIssues) return;
    focusIssue.current = false;
    const field = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    field?.focus({ preventScroll: true });
    // Centred, so the sticky Save bar never covers it.
    field?.scrollIntoView({ block: "center" });
  }, [shownIssues]);
  const stored = clip.capability.params;
  const storedJson = JSON.stringify(stored);
  const draft = entry?.draft ?? draftFromParams(info.kind, stored);
  if (!draft) return <ReadOnlyParams params={stored} note="These parameters are not in a shape this form shows, so they are shown as stored." />;

  const dirty = entry !== null && draftDiffers(info.kind, entry.draft, stored);
  const changedUnderneath = entry !== null && dirty && entry.base !== storedJson;
  const issues = entry?.issues ?? null;

  const change = (next: GraphicDraft) =>
    update((previous) => {
      // Typing back to the stored values leaves nothing to save, unless a refusal is still being shown.
      if (!draftDiffers(info.kind, next, stored) && !previous?.issues) return null;
      return { draft: next, base: previous?.base ?? storedJson, issues: previous?.issues ?? null };
    });

  const save = async () => {
    if (!dirty || state.busy || !entry) return;
    const sent = entry.draft;
    const outcome = await session.apply(`Edit ${info.label.toLowerCase()}`, [{ op: "setGraphicParams", clipId: clip.id, params: paramsFromDraft(sent) }]);
    if (outcome === "busy") return;
    if (outcome === "applied") {
      // What was typed while the Save was in flight stays a draft.
      update((previous) => (previous && previous.draft !== sent ? { ...previous, base: JSON.stringify(paramsFromDraft(sent)), issues: null } : null));
      return;
    }
    const snapshot = session.getSnapshot();
    const refusal = snapshot.refusal;
    const sorted = refusal && snapshot.view ? formIssues(refusal.issues, snapshot.view.production, clip.id) : { fields: {}, general: [] };
    if (Object.keys(sorted.fields).length === 0 && sorted.general.length === 0) sorted.general.push(refusal?.message ?? "The change was not saved.");
    focusIssue.current = true;
    update((previous) => (previous ? { ...previous, issues: sorted, refusal } : null));
  };

  const revert = () => {
    // The banner is about the Save being reverted; one about anything else stays.
    if (entry?.refusal && state.refusal === entry.refusal) session.dismissRefusal();
    update(() => null);
  };

  const fields: FieldsProps<GraphicDraft> = {
    draft,
    change,
    submit: () => void save(),
    errors: (key) => issues?.fields[key],
  };

  return (
    <form
      ref={formRef}
      className="flex flex-col"
      aria-label={`${info.label} parameters`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="space-y-4 px-4 py-4">
        {draft.kind === "title-card" && <TitleCardFields {...(fields as FieldsProps<typeof draft>)} />}
        {draft.kind === "lower-third" && <LowerThirdFields {...(fields as FieldsProps<typeof draft>)} />}
        {draft.kind === "captions" && <InspectorCaptions {...(fields as FieldsProps<typeof draft>)} durationFrames={clip.duration} />}
      </div>
      <div className="sticky bottom-0 border-t border-border bg-surface px-4 py-3">
        {issues && issues.general.length > 0 && (
          <ul role="alert" className="mb-2 space-y-0.5 text-[11px] leading-4 text-destructive">
            {issues.general.map((m, i) => (
              <li key={i}>{m[0]?.toUpperCase() + m.slice(1)}</li>
            ))}
          </ul>
        )}
        {issues && issues.general.length === 0 && (
          <p role="alert" className="mb-2 text-[11px] leading-4 text-destructive">
            Not saved. Fix the fields marked above.
          </p>
        )}
        {changedUnderneath && (
          <p className="mb-2 text-[11px] leading-4 text-muted-foreground">
            This clip changed after you started editing. Save replaces it with your draft; Revert shows what is stored.
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className="mr-auto text-[11px] text-muted-foreground" aria-live="polite">
            {dirty ? "Unsaved changes" : "Saved"}
          </span>
          <Button type="button" variant="ghost" size="sm" disabled={!entry} onClick={revert}>
            <Undo2 className="h-3.5 w-3.5" aria-hidden />
            Revert
          </Button>
          <Button type="submit" variant="accent" size="sm" disabled={!dirty || state.busy}>
            <Save className="h-3.5 w-3.5" aria-hidden />
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}
