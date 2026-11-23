"use client";

import { Plus, X } from "lucide-react";
import { useState } from "react";
import type { ResearchDirection } from "@/types/research";

const MAX_FIELD = 300;
const MAX_POINT = 200;
const MAX_POINTS = 8;

/** Whether the person's direction can be confirmed: the same limits the server checks. */
export function directionProblem(d: ResearchDirection): string | null {
  if (!d.angle.trim() || !d.audience.trim() || !d.centralMessage.trim()) return "Fill in the angle, audience and central message.";
  const points = d.keyPoints.filter((p) => p.trim());
  if (points.length === 0) return "Keep at least one key point.";
  return null;
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  max,
  rows = 2,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  rows?: number;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[14px] font-semibold">
        {label} {hint && <span className="font-normal text-graphite">{hint}</span>}
      </label>
      <textarea id={id} className="field" rows={rows} maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/**
 * The suggested direction, which the person edits before confirming (#253).
 * Confirming sends exactly what is in the form.
 */
export function DirectionForm({
  initial,
  onConfirm,
  confirmLabel,
  busy,
  error,
}: {
  initial: ResearchDirection;
  onConfirm: (direction: ResearchDirection) => void;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
}) {
  const [d, setD] = useState<ResearchDirection>(initial);
  const set = <K extends keyof ResearchDirection>(key: K, value: ResearchDirection[K]) => setD((prev) => ({ ...prev, [key]: value }));
  const cleaned: ResearchDirection = { ...d, keyPoints: d.keyPoints.filter((p) => p.trim()) };
  const problem = directionProblem(cleaned);

  return (
    <form
      aria-labelledby="direction"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && !busy) onConfirm(cleaned);
      }}
    >
      <h2 id="direction" className="type-section">
        Suggested direction
      </h2>
      <p className="mt-1 max-w-[70ch] text-[14px] text-graphite">Change anything you like. The design is built on what you confirm here.</p>
      <div className="mt-5 grid max-w-[760px] gap-5">
        <Field id="direction-angle" label="Angle" value={d.angle} onChange={(v) => set("angle", v)} max={MAX_FIELD} />
        <div className="grid gap-5 md:grid-cols-2">
          <Field id="direction-audience" label="Audience" value={d.audience} onChange={(v) => set("audience", v)} max={MAX_FIELD} />
          <Field
            id="direction-message"
            label="Central message"
            value={d.centralMessage}
            onChange={(v) => set("centralMessage", v)}
            max={MAX_FIELD}
          />
        </div>
        <fieldset>
          <legend className="mb-1.5 text-[14px] font-semibold">
            Key points <span className="font-normal text-graphite">In order, up to {MAX_POINTS}</span>
          </legend>
          <ol className="grid gap-2">
            {d.keyPoints.map((point, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="num mt-2.5 w-5 shrink-0 text-right text-[13px] font-semibold text-graphite">{i + 1}</span>
                <label htmlFor={`direction-point-${i}`} className="sr-only">
                  Key point {i + 1}
                </label>
                <input
                  id={`direction-point-${i}`}
                  className="field"
                  maxLength={MAX_POINT}
                  value={point}
                  onChange={(e) => set("keyPoints", d.keyPoints.map((p, j) => (j === i ? e.target.value : p)))}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon mt-1"
                  aria-label={`Remove key point ${i + 1}`}
                  disabled={d.keyPoints.length === 1}
                  onClick={() => set("keyPoints", d.keyPoints.filter((_, j) => j !== i))}
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          {d.keyPoints.length < MAX_POINTS && (
            <button type="button" className="btn btn-ghost btn-sm mt-2 -ml-2" onClick={() => set("keyPoints", [...d.keyPoints, ""])}>
              <Plus className="size-4" aria-hidden="true" /> Add a key point
            </button>
          )}
        </fieldset>
        <Field
          id="direction-cta"
          label="Call to action"
          hint="Optional"
          value={d.callToAction}
          onChange={(v) => set("callToAction", v)}
          max={MAX_POINT}
          rows={1}
        />
      </div>

      {error && (
        <p role="alert" className="mt-6 max-w-[760px] rounded-lg bg-alert-bg px-4 py-3 text-[14px]">
          {error}
        </p>
      )}
      <div className="mt-8 flex flex-col gap-3 rounded-[14px] bg-ink p-4 text-white sm:flex-row sm:items-center sm:justify-between sm:pl-6">
        <p className="text-[14px] text-white/85">{problem ?? "Confirming opens the editor and starts the design right away."}</p>
        <button type="submit" className="btn btn-create" disabled={Boolean(problem) || busy}>
          {busy ? "Confirming…" : confirmLabel}
        </button>
      </div>
    </form>
  );
}
