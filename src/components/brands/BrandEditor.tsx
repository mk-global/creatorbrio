"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useApp } from "@/components/app/AppContext";
import { SlideFace } from "@/components/library/ProjectFrame";
import { sampleSlideHtml } from "@/lib/format-samples";
import type { Brand, BrandConfig } from "@/types/brand";
import { DEFAULT_BRAND } from "@/types/brand";
import { brandSaveTarget } from "@/lib/brand-save-target";
import { ColorFields, FontField, LogoField, StyleWords } from "./BrandFields";

/**
 * One brand's colours, fonts, logo and style words (#175), replacing the
 * five-step brand dialog. It saves the whole brand, as that dialog did, to
 * the brand's own route; the server keeps only the fields a person may set.
 * Every design made after saving uses it; existing slides are not redrawn.
 */
export function BrandEditor({ existing }: { existing: Brand | null }) {
  const { reload, toast } = useApp();
  const router = useRouter();
  const [draft, setDraft] = useState<BrandConfig>(() => existing ?? { ...DEFAULT_BRAND, name: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = existing === null;
  const canSave = draft.name.trim().length > 0 && !saving;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    const target = brandSaveTarget(isNew ? "create" : "edit", existing?.id);
    if (!target) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(target.url, {
        method: target.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await res.json().catch(() => ({}))) as Brand & { error?: string };
      if (!res.ok) throw new Error(body.error || `Saving failed with status ${res.status}.`);
      // A new brand becomes the one new work uses, as it did before.
      await reload(isNew ? body.id : undefined);
      toast(isNew ? `Created ${body.name}. New projects use it.` : `Saved ${body.name}.`);
      router.push("/brands");
    } catch (err) {
      // Stay on the page so nothing typed is lost and the failure is visible.
      setError(err instanceof Error ? err.message : "The brand could not be saved.");
      setSaving(false);
    }
  };

  return (
    <div>
      <Link href="/brands" className="inline-flex min-h-8 items-center gap-1.5 text-[14px] font-medium text-graphite hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden="true" /> Brands
      </Link>
      <h1 className="display mt-3 text-[40px] break-words lg:text-[52px]">
        {isNew ? "New brand" : existing.name.trim() ? `Edit ${existing.name.trim()}` : "Set up your brand"}
      </h1>

      <div className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
        <form className="space-y-9" onSubmit={(e) => void save(e)}>
          <section aria-labelledby="identity" className="space-y-4">
            <h2 id="identity" className="display-md text-[22px]">
              Identity
            </h2>
            <div>
              <label htmlFor="bname" className="mb-1.5 block text-[14px] font-semibold">
                Brand name
              </label>
              <input
                id="bname"
                className="field max-w-[420px]"
                value={draft.name}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                required
                aria-describedby="bname-hint"
              />
              <p id="bname-hint" className="mt-1.5 text-[13px] text-graphite">
                Claude uses it on slides when a design calls for it, and the brand menu shows it.
              </p>
            </div>
            <LogoField value={draft.logoPath} onChange={(logoPath) => setDraft({ ...draft, logoPath })} />
          </section>

          <section aria-labelledby="colours">
            <h2 id="colours" className="display-md text-[22px]">
              Colours
            </h2>
            <ColorFields colors={draft.colors} onChange={(key, value) => setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value } }))} />
          </section>

          <section aria-labelledby="type" className="space-y-4">
            <h2 id="type" className="display-md text-[22px]">
              Fonts
            </h2>
            <div className="grid max-w-[560px] gap-4 sm:grid-cols-2">
              <FontField id="font-heading" label="Headings" value={draft.fonts.heading} onChange={(heading) => setDraft((d) => ({ ...d, fonts: { ...d.fonts, heading } }))} />
              <FontField id="font-body" label="Text" value={draft.fonts.body} onChange={(body) => setDraft((d) => ({ ...d, fonts: { ...d.fonts, body } }))} />
            </div>
          </section>

          <section aria-labelledby="style">
            <h2 id="style" className="display-md text-[22px]">
              Style words
            </h2>
            <p className="mt-1 text-[14px] text-graphite">A few words Claude reads before every design.</p>
            <StyleWords words={draft.styleKeywords} onChange={(styleKeywords) => setDraft((d) => ({ ...d, styleKeywords }))} />
          </section>

          {error && (
            <p role="alert" className="rounded-lg bg-alert-bg px-4 py-3 text-[14px]">
              The brand wasn&apos;t saved: {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-6">
            <button type="submit" className="btn btn-primary" disabled={!canSave}>
              {saving ? "Saving…" : isNew ? "Create brand" : "Save brand"}
            </button>
            <Link href="/brands" className="btn btn-ghost">
              Cancel
            </Link>
            {!draft.name.trim() && <span className="text-[13px] text-graphite">Give the brand a name to save it.</span>}
          </div>
        </form>

        <aside aria-label="Preview" className="lg:sticky lg:top-10 lg:self-start">
          <p className="text-[14px] font-semibold">Preview</p>
          <p className="text-[13px] text-graphite">Updates as you edit. Claude designs each project from scratch; these only show your colours and fonts.</p>
          <div className="mt-4 flex items-end gap-4">
            <div className="paper aspect-[4/5] w-[58%]">
              <SlideFace html={sampleSlideHtml("instagram-carousel", draft)} aspectRatio="4:5" title="Carousel preview" />
            </div>
            <div className="paper aspect-[9/16] w-[36%]">
              <SlideFace html={sampleSlideHtml("reel-cover", draft)} aspectRatio="9:16" title="Reel cover preview" />
            </div>
          </div>
          <div className="paper mt-4 aspect-[4/5] w-[58%]">
            <SlideFace html={sampleSlideHtml("linkedin-document", draft)} aspectRatio="4:5" title="Document preview" />
          </div>
        </aside>
      </div>
    </div>
  );
}
