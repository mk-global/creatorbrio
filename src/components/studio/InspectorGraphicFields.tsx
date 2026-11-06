"use client";

/** The title card's and lower third's fields (#150), with the limits their capabilities enforce. */
import { LOWER_THIRD_LIMITS, TITLE_CARD_LIMITS, type LowerThirdDraft, type TitleCardDraft } from "@/lib/video/studio/capability-forms";
import { CheckboxField, ChoiceField, ColorField, TextField } from "./InspectorFields";
import type { FieldsProps } from "./InspectorGraphic";

export function TitleCardFields({ draft, change, submit, errors }: FieldsProps<TitleCardDraft>) {
  return (
    <>
      <TextField label="Title" value={draft.title} onChange={(title) => change({ ...draft, title })} onSubmit={submit} max={TITLE_CARD_LIMITS.title} errors={errors("title")} />
      <TextField
        label="Subtitle"
        value={draft.subtitle}
        onChange={(subtitle) => change({ ...draft, subtitle })}
        onSubmit={submit}
        max={TITLE_CARD_LIMITS.subtitle}
        errors={errors("subtitle")}
        hint="Optional. Leave empty for none."
      />
      <ChoiceField
        label="Position"
        value={draft.align}
        options={[
          { value: "center", label: "Centre" },
          { value: "top", label: "Top" },
        ]}
        onChange={(align) => change({ ...draft, align })}
        errors={errors("align")}
      />
      <CheckboxField label="Dark card" hint="Sets the text on a translucent card instead of over the picture." checked={draft.scrim} onChange={(scrim) => change({ ...draft, scrim })} errors={errors("scrim")} />
    </>
  );
}

export function LowerThirdFields({ draft, change, submit, errors }: FieldsProps<LowerThirdDraft>) {
  return (
    <>
      <TextField label="Name" value={draft.title} onChange={(title) => change({ ...draft, title })} onSubmit={submit} max={LOWER_THIRD_LIMITS.title} errors={errors("title")} />
      <TextField
        label="Second line"
        value={draft.subtitle}
        onChange={(subtitle) => change({ ...draft, subtitle })}
        onSubmit={submit}
        max={LOWER_THIRD_LIMITS.subtitle}
        errors={errors("subtitle")}
        hint="Optional, for example a role. Leave empty for none."
      />
      <ColorField label="Accent" value={draft.accent} onChange={(accent) => change({ ...draft, accent })} onSubmit={submit} errors={errors("accent")} hint="The bar beside the text, as #rrggbb." />
    </>
  );
}
