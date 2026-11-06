"use client";

/**
 * The timed captions form (#150): preset, position and accent, and the cue
 * list, each cue's text and its start and end in frames from the clip's
 * start. Adding and removing cues changes only the draft; Save commits it.
 */
import { useId, type KeyboardEvent } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addCue, removeCue, updateCue } from "@/lib/video/studio/caption-cues";
import { CAPTION_LIMITS, fieldKey, type CaptionsDraft, type CueDraft } from "@/lib/video/studio/capability-forms";
import { formatTimecode } from "@/lib/video/studio/frames";
import { cn } from "@/lib/utils";
import { ChoiceField, ColorField, FieldErrors } from "./InspectorFields";
import type { FieldsProps } from "./InspectorGraphic";
import { useWorkspace } from "./workspace";

export function InspectorCaptions({ draft, change, submit, errors, durationFrames }: FieldsProps<CaptionsDraft> & { durationFrames: number }) {
  const { state } = useWorkspace();
  const fps = state.view.production.format.fps;
  const listId = useId();
  const room = draft.cues.length < CAPTION_LIMITS.cues && addCue(draft.cues, durationFrames, fps) !== null;
  const setCues = (cues: CueDraft[]) => change({ ...draft, cues });

  return (
    <>
      <ChoiceField
        label="Style"
        value={draft.preset}
        options={[
          { value: "sentence", label: "Sentence" },
          { value: "kinetic", label: "Kinetic" },
        ]}
        onChange={(preset) => change({ ...draft, preset })}
        errors={errors("preset")}
      />
      <ChoiceField
        label="Position"
        value={draft.position}
        options={[
          { value: "lower", label: "Lower" },
          { value: "center", label: "Centre" },
        ]}
        onChange={(position) => change({ ...draft, position })}
        errors={errors("position")}
      />
      <ColorField label="Accent" value={draft.accent} onChange={(accent) => change({ ...draft, accent })} onSubmit={submit} errors={errors("accent")} hint="The current word in kinetic captions, as #rrggbb." />

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <h3 id={listId} className="text-xs font-medium text-foreground">
            Cues
          </h3>
          <span className="text-[11px] text-muted-foreground">Frames from the clip&apos;s start, 0 to {durationFrames}</span>
        </div>
        {draft.cues.length === 0 && <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">No cues. Add one to show a caption.</p>}
        <ol aria-labelledby={listId} className="space-y-2">
          {draft.cues.map((cue, i) => (
            <CueRow
              key={i}
              index={i}
              cue={cue}
              fps={fps}
              onChange={(field, value) => setCues(updateCue(draft.cues, i, field, value))}
              onRemove={() => setCues(removeCue(draft.cues, i))}
              onSubmit={submit}
              errors={errors}
            />
          ))}
        </ol>
        <FieldErrors id={`${listId}-errors`} messages={errors("cues")} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          disabled={!room}
          onClick={() => {
            const next = addCue(draft.cues, durationFrames, fps);
            if (next) setCues(next);
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {room ? "Add cue" : "No free frames for another cue"}
        </Button>
      </div>
    </>
  );
}

interface CueRowProps {
  index: number;
  cue: CueDraft;
  fps: number;
  onChange(field: keyof CueDraft, value: string): void;
  onRemove(): void;
  onSubmit(): void;
  errors(key: string): string[] | undefined;
}

function CueRow({ index, cue, fps, onChange, onRemove, onSubmit, errors }: CueRowProps) {
  const id = useId();
  const n = index + 1;
  const key = (field?: keyof CueDraft) => (field ? fieldKey("cues", index, field) : fieldKey("cues", index));
  const textErrors = errors(key("text"));
  const startErrors = errors(key("start"));
  const endErrors = errors(key("end"));
  const rowErrors = errors(key());
  const invalid = Boolean(textErrors || startErrors || endErrors || rowErrors);
  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };
  const tc = (text: string) => (/^\d+$/.test(text.trim()) ? formatTimecode(Number(text), fps) : "?");

  return (
    <li className={cn("rounded-lg border border-border bg-background/60 p-2", invalid && "border-destructive/60")}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-medium text-foreground">Cue {n}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {tc(cue.start)} to {tc(cue.end)}
        </span>
        <Button type="button" variant="ghost" size="icon" className="ml-auto h-6 w-6 text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label={`Remove cue ${n}`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      <Input
        id={`${id}-text`}
        aria-label={`Cue ${n} text`}
        value={cue.text}
        onChange={(e) => onChange("text", e.target.value)}
        onKeyDown={enter}
        aria-invalid={textErrors ? true : undefined}
        aria-describedby={textErrors ? `${id}-text-errors` : undefined}
        className={cn("h-8 text-xs", textErrors && "border-destructive focus-visible:ring-destructive/50")}
      />
      <FieldErrors id={`${id}-text-errors`} messages={textErrors} />
      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <FrameInput id={`${id}-start`} label={`Cue ${n} start frame`} short="Start" value={cue.start} onChange={(v) => onChange("start", v)} onKeyDown={enter} errors={startErrors} />
        <FrameInput id={`${id}-end`} label={`Cue ${n} end frame`} short="End" value={cue.end} onChange={(v) => onChange("end", v)} onKeyDown={enter} errors={endErrors} />
      </div>
      {/* Frame errors span the row, so a message is not squeezed into one narrow column. */}
      <FieldErrors id={`${id}-start-errors`} messages={startErrors?.map((m) => `Start: ${m}`)} />
      <FieldErrors id={`${id}-end-errors`} messages={endErrors?.map((m) => `End: ${m}`)} />
      <FieldErrors id={`${id}-row-errors`} messages={rowErrors} />
    </li>
  );
}

function FrameInput(props: { id: string; label: string; short: string; value: string; onChange(value: string): void; onKeyDown(e: KeyboardEvent): void; errors?: string[] }) {
  const { id, label, short, value, onChange, onKeyDown, errors } = props;
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="w-8 shrink-0 text-[11px] text-muted-foreground">
          {short}
        </label>
        <Input
          id={id}
          aria-label={label}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          aria-invalid={errors ? true : undefined}
          aria-describedby={errors ? `${id}-errors` : undefined}
          className={cn("h-7 px-2 text-xs tabular-nums", errors && "border-destructive focus-visible:ring-destructive/50")}
        />
      </div>
    </div>
  );
}
