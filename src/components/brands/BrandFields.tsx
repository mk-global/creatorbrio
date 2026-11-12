"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { useGoogleFonts } from "@/components/app/useGoogleFonts";
import { capitalise, COLOR_ROLES, fontStack } from "@/lib/brand-display";
import type { BrandColors } from "@/types/brand";

const HEX = /^#[0-9a-fA-F]{6}$/;

const COLOR_HINTS: Record<keyof BrandColors, string> = {
  primary: "Headlines and main shapes",
  secondary: "Supporting shapes",
  accent: "The one thing to notice",
  background: "Behind everything",
  surface: "Cards and panels",
};

/** The five brand colours, each with a picker and a hex field that accepts only a full #RRGGBB. */
export function ColorFields({ colors, onChange }: { colors: BrandColors; onChange: (key: keyof BrandColors, value: string) => void }) {
  const [typed, setTyped] = useState<Partial<Record<keyof BrandColors, string>>>({});
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {COLOR_ROLES.map((r) => {
        const shown = typed[r.key] ?? colors[r.key];
        return (
          <li key={r.key} className="flex min-w-0 items-center gap-3 rounded-[10px] bg-sheet p-3 shadow-[inset_0_0_0_1px_var(--color-rule)]">
            <input
              type="color"
              aria-label={`${r.label} colour picker`}
              value={HEX.test(colors[r.key]) ? colors[r.key] : "#000000"}
              onChange={(e) => {
                onChange(r.key, e.target.value);
                setTyped((t) => ({ ...t, [r.key]: undefined }));
              }}
              className="size-11 shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-0"
            />
            <div className="min-w-0 flex-1">
              <label htmlFor={`hex-${r.key}`} className="block text-[14px] font-semibold">
                {r.label}
              </label>
              <p className="truncate text-[12.5px] text-graphite">{COLOR_HINTS[r.key]}</p>
            </div>
            <input
              id={`hex-${r.key}`}
              className="field num h-9 w-[92px] px-2 text-[13.5px] uppercase"
              value={shown}
              maxLength={7}
              aria-invalid={!HEX.test(shown)}
              onChange={(e) => {
                const v = e.target.value;
                setTyped((t) => ({ ...t, [r.key]: v }));
                if (HEX.test(v)) onChange(r.key, v);
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** A font from the app's Google Fonts list, shown in its own typeface; a font not on the list stays selectable. */
export function FontField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const [fonts, setFonts] = useState<{ name: string; category: string }[]>([]);
  useGoogleFonts([value]);
  useEffect(() => {
    let current = true;
    fetch("/api/fonts")
      .then((r) => r.json())
      .then((d: { fonts?: { name: string; category: string }[] }) => current && setFonts(d.fonts ?? []))
      .catch(() => {
        // Without the list the current font is still shown and kept.
      });
    return () => {
      current = false;
    };
  }, []);
  const names = fonts.some((f) => f.name === value) ? fonts : [{ name: value, category: "current" }, ...fonts];
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[14px] font-semibold">
        {label}
      </label>
      <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        {names.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name}
          </option>
        ))}
      </select>
      <p className="mt-2 truncate text-[20px] leading-tight" style={{ fontFamily: fontStack(value) }} aria-hidden="true">
        The quick brown fox jumps
      </p>
    </div>
  );
}

const SUGGESTED = ["minimal", "bold", "playful", "corporate", "luxury", "vintage", "modern", "elegant", "creative", "professional"];

/** Words Claude reads before every design: suggestions to toggle, and any word typed. */
export function StyleWords({ words, onChange }: { words: string[]; onChange: (words: string[]) => void }) {
  const [word, setWord] = useState("");
  const add = () => {
    const w = word.trim().toLowerCase().slice(0, 40);
    if (w && !words.includes(w)) onChange([...words, w]);
    setWord("");
  };
  const suggestions = SUGGESTED.filter((s) => !words.includes(s));
  return (
    <div>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Chosen words">
        {words.map((w) => (
          <li key={w} className="inline-flex h-9 items-center gap-1 rounded-full bg-sheet pr-1 pl-3 text-[14px] shadow-[inset_0_0_0_1px_var(--color-ink)]">
            {capitalise(w)}
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded-full text-graphite hover:bg-hover hover:text-ink"
              aria-label={`Remove ${w}`}
              onClick={() => onChange(words.filter((x) => x !== w))}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
        {words.length === 0 && <li className="text-[14px] text-graphite">No words yet.</li>}
      </ul>
      {suggestions.length > 0 && (
        <div className="mt-4">
          <p className="text-[13px] text-graphite">Suggestions</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="h-8 rounded-full px-3 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--color-rule)] hover:bg-hover"
                onClick={() => onChange([...words, s])}
                aria-label={`Add ${s}`}
              >
                + {capitalise(s)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 flex max-w-[420px] gap-2">
        <label htmlFor="word" className="sr-only">
          Add a style word
        </label>
        <input
          id="word"
          className="field"
          placeholder="Add your own word, like calm"
          value={word}
          maxLength={40}
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn btn-quiet h-11" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

/** The logo: PNG, JPG or WebP up to 10 MB, checked again by the server. */
export function LogoField({ value, onChange }: { value: string | null; onChange: (path: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const upload = async (file: File) => {
    setState({ busy: true, error: null });
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error || `The upload failed with status ${res.status}.`);
      onChange(body.url);
      setState({ busy: false, error: null });
    } catch (err) {
      setState({ busy: false, error: err instanceof Error ? err.message : "The logo could not be uploaded." });
    }
  };
  return (
    <div>
      <p className="mb-1.5 text-[14px] font-semibold">Logo</p>
      <div className="flex flex-wrap items-center gap-3">
        {value && (
          <span className="flex size-16 items-center justify-center overflow-hidden rounded-lg bg-sheet shadow-[inset_0_0_0_1px_var(--color-rule)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt="Current logo" className="max-h-full max-w-full object-contain" />
          </span>
        )}
        <button type="button" className="btn btn-quiet btn-sm" disabled={state.busy} onClick={() => input.current?.click()}>
          <Upload className="size-4" aria-hidden="true" />
          {state.busy ? "Uploading…" : value ? "Replace logo" : "Upload logo"}
        </button>
        {value && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>
            Remove
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
      <p className={`mt-1.5 text-[13px] ${state.error ? "text-alert" : "text-graphite"}`} role={state.error ? "alert" : undefined}>
        {state.error ?? "PNG, JPG or WebP, up to 10 MB."}
      </p>
    </div>
  );
}
