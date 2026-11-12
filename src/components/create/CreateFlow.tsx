"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ProjectFrame } from "@/components/library/ProjectFrame";
import { templateBrandId, templateFirstSlide } from "@/components/library/useLibrary";
import { brandDisplayName } from "@/lib/brand-display";
import { countLabel, DEFAULT_FORMAT, FORMATS, formatOf, isProjectFormat, type ProjectFormat } from "@/lib/formats";
import { clearIdea, handOffDraft, readIdea } from "@/lib/new-project-handoff";
import type { ProjectSummary } from "@/lib/project-summary";
import type { Brand } from "@/types/brand";
import type { AspectRatio } from "@/types/carousel";
import type { Template } from "@/types/template";
import { FormatChoice, SizeChoice } from "./FormatChoice";

const EXAMPLES: Record<ProjectFormat, string> = {
  "instagram-carousel": "five pour-over mistakes and how to fix them",
  "linkedin-document": "how our onboarding works, in six pages",
  "reel-cover": "a cover for our latte art Reel",
};

/** A name from the first sentence of the description, or "Untitled Reel cover". */
function nameFrom(about: string, format: ProjectFormat): string {
  const first = about.trim().split(/[.!?\n]/)[0].trim().slice(0, 60);
  return first || `Untitled ${FORMATS[format].name}`;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `Request failed with status ${res.status}.`);
  return json as T;
}

export function CreateFlow({
  brands,
  initialBrand,
  defaultBrandId,
  templates,
  templatesError,
  projects,
  params,
}: {
  brands: Brand[];
  initialBrand: Brand;
  defaultBrandId: string | null;
  templates: Template[];
  templatesError: string | null;
  projects: ProjectSummary[];
  params: { format: string | null; template: string | null; fromIdea: boolean };
}) {
  const router = useRouter();
  const initialTemplate = templates.find((t) => t.id === params.template);
  const startFormat: ProjectFormat = initialTemplate ? formatOf(initialTemplate) : isProjectFormat(params.format) ? params.format : DEFAULT_FORMAT;

  const [format, setFormat] = useState<ProjectFormat>(startFormat);
  const [brandId, setBrandId] = useState(() => (initialTemplate && templateBrandId(initialTemplate, defaultBrandId)) || initialBrand.id);
  const [size, setSize] = useState<AspectRatio>(initialTemplate?.aspectRatio ?? FORMATS[startFormat].defaultSize);
  const [source, setSource] = useState<"description" | "template">(initialTemplate ? "template" : "description");
  const [templateId, setTemplateId] = useState(initialTemplate?.id ?? "");
  const [about, setAbout] = useState(() => (params.fromIdea ? readIdea() : ""));
  // The idea is now in the form; it is not offered again on the next visit.
  useEffect(() => clearIdea(), []);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phones take the flow in two steps (format, then details); wider screens show both at once.
  const [step, setStep] = useState<1 | 2>(initialTemplate || params.fromIdea ? 2 : 1);
  const backBtn = useRef<HTMLButtonElement>(null);

  const def = FORMATS[format];
  const brand = brands.find((b) => b.id === brandId) ?? initialBrand;
  const available = templates.filter((t) => formatOf(t) === format && templateBrandId(t, defaultBrandId) === brandId);
  const template = available.find((t) => t.id === templateId);
  const chosenSize: AspectRatio = source === "template" && template ? template.aspectRatio : def.sizes.includes(size) ? size : def.defaultSize;
  const derivedName = source === "template" && template ? template.name : nameFrom(about, format);

  const pickFormat = (id: ProjectFormat) => {
    setFormat(id);
    setSize(FORMATS[id].defaultSize);
    setTemplateId("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || (source === "template" && !template)) return;
    setBusy(true);
    setError(null);
    try {
      const finalName = name.trim() || derivedName;
      const created =
        source === "template" && template
          ? await post<{ id: string }>(`/api/templates/${encodeURIComponent(template.id)}/use`, { name: finalName })
          : await post<{ id: string }>("/api/carousels", { name: finalName, aspectRatio: chosenSize, brandId, format });
      // The format's words, and the description, wait in the editor's message box; nothing is sent.
      const draft = source === "description" ? `${def.composerPrefix}${about.trim()}` : def.composerPrefix;
      if (draft.trim()) handOffDraft(created.id, draft);
      router.push(`/carousel/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The project could not be created.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="max-w-[980px]">
      <h1 className="display text-[44px] lg:text-[56px]">New project</h1>
      <p className="mt-2 text-graphite">Two choices, then the editor. Nothing is designed until you press Send there.</p>
      <p className="mt-4 text-[13px] font-semibold text-graphite sm:hidden" aria-live="polite">
        Step {step} of 2
      </p>

      <fieldset className={`mt-6 sm:mt-10 ${step === 1 ? "" : "max-sm:hidden"}`}>
        <legend className="flex items-baseline gap-3">
          <span className="display num text-[26px] text-graphite">1</span>
          <span className="display-md text-[24px]">Format</span>
        </legend>
        <FormatChoice format={format} brand={brand} projects={projects} onPick={pickFormat} />
        <button
          type="button"
          className="btn btn-primary mt-8 w-full sm:hidden"
          onClick={() => {
            setStep(2);
            window.scrollTo({ top: 0 });
            window.setTimeout(() => backBtn.current?.focus(), 0);
          }}
        >
          Next: details for {withA(def.name)}
        </button>
      </fieldset>

      <fieldset className={`mt-6 sm:mt-12 sm:border-t sm:border-rule sm:pt-10 ${step === 2 ? "" : "max-sm:hidden"}`}>
        <legend className="sr-only">Details</legend>
        <button ref={backBtn} type="button" className="btn btn-ghost btn-sm mb-4 -ml-2 sm:hidden" onClick={() => setStep(1)}>
          <ArrowLeft className="size-4" aria-hidden="true" /> Format: {def.name}
        </button>
        <p className="flex items-baseline gap-3" aria-hidden="true">
          <span className="display num text-[26px] text-graphite">2</span>
          <span className="display-md text-[24px]">Details</span>
        </p>

        <div className="mt-6 grid gap-8 lg:grid-cols-2">
          <div>
            <label htmlFor="brand" className="mb-1.5 block text-[14px] font-semibold">
              Brand
            </label>
            <select
              id="brand"
              className="field"
              value={brandId}
              onChange={(e) => {
                setBrandId(e.target.value);
                setTemplateId("");
              }}
              aria-describedby="brand-hint"
            >
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {brandDisplayName(b)}
                </option>
              ))}
            </select>
            <p id="brand-hint" className="mt-1.5 text-[13px] text-graphite">
              A project keeps its brand for life.
            </p>
          </div>
          <SizeChoice format={format} size={chosenSize} locked={source === "template"} onPick={setSize} />
        </div>

        <fieldset className="mt-8">
          <legend className="mb-2 text-[14px] font-semibold">Start from</legend>
          <div className="inline-flex rounded-lg bg-hover p-1">
            {(["description", "template"] as const).map((s) => (
              <label key={s} className="cursor-pointer">
                <input type="radio" name="source" className="peer sr-only" checked={source === s} onChange={() => setSource(s)} />
                <span className="flex h-9 items-center rounded-md px-4 text-[14px] font-medium text-graphite peer-checked:bg-sheet peer-checked:text-ink peer-checked:shadow-[0_1px_2px_rgb(28_27_41/0.15)] peer-focus-visible:outline-2 peer-focus-visible:outline-ink">
                  {s === "description" ? "A description" : `A template (${available.length})`}
                </span>
              </label>
            ))}
          </div>

          {source === "description" ? (
            <div className="mt-5 max-w-[640px]">
              <label htmlFor="about" className="mb-1.5 block text-[14px] font-semibold">
                What is it about? <span className="font-normal text-graphite">Optional</span>
              </label>
              <textarea
                id="about"
                className="field"
                rows={3}
                maxLength={4000}
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                placeholder={`For example: ${EXAMPLES[format]}`}
              />
              <p className="mt-1.5 text-[13px] text-graphite">
                This goes into the chat in the editor
                {def.composerPrefix && <>, after the words &ldquo;{def.composerPrefix.trim().replace(/\.$/, "")}&rdquo;</>}. You can change it
                before sending.
              </p>
            </div>
          ) : templatesError ? (
            <p className="mt-5 max-w-[60ch] text-alert">Templates couldn&apos;t be loaded: {templatesError}</p>
          ) : available.length === 0 ? (
            <p className="mt-5 max-w-[60ch] text-graphite">
              {brandDisplayName(brand)} has no {def.name} templates yet. Save any finished project as a template from its menu.{" "}
              <Link href="/projects" className="font-semibold text-ink underline underline-offset-4">
                Go to projects
              </Link>
            </p>
          ) : (
            <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-6" role="radiogroup" aria-label="Template">
              {available.map((t) => (
                <label key={t.id} className="crop-hover flex cursor-pointer flex-col">
                  <input type="radio" name="template" className="peer sr-only" checked={templateId === t.id} onChange={() => setTemplateId(t.id)} />
                  <span className="rounded-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-8 peer-focus-visible:outline-ink">
                    <ProjectFrame
                      html={templateFirstSlide(t)}
                      slideCount={t.slides.length}
                      aspectRatio={t.aspectRatio}
                      format={format}
                      heightClass="[--fh:120px]"
                      selected={templateId === t.id}
                      paperColors={[brand.colors.surface, brand.colors.background]}
                    />
                  </span>
                  <span className="mt-3 max-w-[24ch] text-[14px] font-semibold break-words">{t.name}</span>
                  <span className="text-[13px] text-graphite">{countLabel(format, t.slides.length)}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <div className="mt-8 max-w-[420px]">
          <label htmlFor="name" className="mb-1.5 block text-[14px] font-semibold">
            Name <span className="font-normal text-graphite">Optional</span>
          </label>
          <input id="name" className="field" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder={derivedName} />
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="mt-6 rounded-lg bg-alert-bg px-4 py-3 text-[14px]">
          The project wasn&apos;t created: {error}
        </p>
      )}

      <div
        className={`mt-10 flex flex-col gap-3 rounded-[14px] bg-ink p-4 text-white sm:flex-row sm:items-center sm:justify-between sm:pl-6 ${step === 2 ? "" : "max-sm:hidden"}`}
      >
        <p className="text-[14px] text-white/85">
          {capitalFirst(withA(`${chosenSize} ${def.name}`))} for <span className="font-semibold text-white">{brandDisplayName(brand)}</span>
          {source === "template" && template ? <>, starting from &ldquo;{template.name}&rdquo;</> : null}.
        </p>
        <button type="submit" className="btn bg-white text-ink hover:bg-white/90" disabled={busy || (source === "template" && !template)}>
          {busy ? "Creating…" : "Create and open editor"}
        </button>
      </div>
    </form>
  );
}

const capitalFirst = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** "a Reel cover", "an Instagram carousel", "a 4:5 Instagram carousel". */
function withA(words: string): string {
  return `${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}`;
}
