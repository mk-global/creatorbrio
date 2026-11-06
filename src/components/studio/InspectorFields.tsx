"use client";

/**
 * The Inspector's form controls (#150): labelled fields that show the
 * refusal issues at their own field, and Enter in a single-line field saves.
 */
import { useId, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function FieldErrors({ id, messages }: { id: string; messages?: string[] }) {
  if (!messages || messages.length === 0) return null;
  return (
    <ul id={id} className="mt-1 space-y-0.5 text-[11px] leading-4 text-destructive">
      {messages.map((m, i) => (
        <li key={i}>{sentenceCase(m)}</li>
      ))}
    </ul>
  );
}

function sentenceCase(message: string): string {
  return message ? message[0].toUpperCase() + message.slice(1) : message;
}

export function FieldLabel({ htmlFor, children, aside }: { htmlFor: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {children}
      </label>
      {aside && <span className="text-[11px] tabular-nums text-muted-foreground">{aside}</span>}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  max: number;
  errors?: string[];
  placeholder?: string;
  hint?: string;
}

/** A single-line text field with its character count against the capability's limit. */
export function TextField({ label, value, onChange, onSubmit, max, errors, placeholder, hint }: TextFieldProps) {
  const id = useId();
  const length = Array.from(value.trim()).length;
  const invalid = Boolean(errors?.length);
  return (
    <div>
      <FieldLabel htmlFor={id} aside={<span className={cn(length > max && "text-destructive")}>{length}/{max}</span>}>
        {label}
      </FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-errors` : hint ? `${id}-hint` : undefined}
        className={cn("h-8 text-xs", invalid && "border-destructive")}
      />
      {hint && !invalid && (
        <p id={`${id}-hint`} className="mt-1 text-[11px] text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldErrors id={`${id}-errors`} messages={errors} />
    </div>
  );
}

interface ChoiceFieldProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  errors?: string[];
}

/** A small set of choices as a segmented radio group. */
export function ChoiceField<T extends string>({ label, value, options, onChange, errors }: ChoiceFieldProps<T>) {
  const id = useId();
  const invalid = Boolean(errors?.length);
  return (
    <fieldset aria-describedby={invalid ? `${id}-errors` : undefined}>
      <legend className="mb-1 text-xs font-medium text-foreground">{label}</legend>
      <div className={cn("grid gap-1 rounded-lg border border-border bg-muted p-0.5", invalid && "border-destructive")} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex h-7 cursor-pointer items-center justify-center rounded-md text-xs text-muted-foreground transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              value === option.value ? "bg-surface font-medium text-foreground shadow-sm" : "hover:text-foreground"
            )}
          >
            <input type="radio" name={id} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="sr-only" />
            {option.label}
          </label>
        ))}
      </div>
      <FieldErrors id={`${id}-errors`} messages={errors} />
    </fieldset>
  );
}

export function CheckboxField({ label, checked, onChange, hint, errors }: { label: string; checked: boolean; onChange(checked: boolean): void; hint?: string; errors?: string[] }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2 text-xs">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <span>
          <span className="font-medium text-foreground">{label}</span>
          {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
        </span>
      </label>
      <FieldErrors id={`${id}-errors`} messages={errors} />
    </div>
  );
}

/** A `#rrggbb` colour, with a swatch picker beside the typed value. */
export function ColorField({ label, value, onChange, onSubmit, errors, hint }: { label: string; value: string; onChange(value: string): void; onSubmit(): void; errors?: string[]; hint?: string }) {
  const id = useId();
  const invalid = Boolean(errors?.length);
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={valid ? value.toLowerCase() : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-border bg-surface p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-errors` : hint ? `${id}-hint` : undefined}
          className={cn("h-8 font-mono text-xs", invalid && "border-destructive")}
        />
      </div>
      {hint && !invalid && (
        <p id={`${id}-hint`} className="mt-1 text-[11px] text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldErrors id={`${id}-errors`} messages={errors} />
    </div>
  );
}

/** A label and a value in the clip summary. */
export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-right tabular-nums text-foreground">{value}</dd>
    </>
  );
}
