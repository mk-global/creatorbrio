import { Check, Minus } from "lucide-react";

// Kept in step with the README's "What you can do today" table.
const WORKS = [
  "Import video, sound and stills by their path on this computer",
  "Preview with sound",
  "Move, trim, split and delete clips on a timeline",
  "Titles, lower thirds and typed captions",
  "Undo and redo",
  "Export an MP4 checked against Instagram's Reel requirements",
];

const NOT_YET = ["AI-assisted video editing", "Editing on a phone"];

/** What the Video Studio does today and what it does not (#175): shown before pairing, so nobody is surprised. */
export function StudioIntro() {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section aria-labelledby="studio-works" className="panel p-6">
        <h2 id="studio-works" className="type-section">
          Works today
        </h2>
        <ul className="mt-4 space-y-2.5">
          {WORKS.map((w) => (
            <li key={w} className="flex gap-3 text-[15px]">
              <Check className="mt-0.5 size-[18px] shrink-0 text-ok" aria-hidden="true" />
              {w}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="studio-not-yet" className="rounded-[14px] p-6 shadow-[inset_0_0_0_1px_var(--color-rule)]">
        <h2 id="studio-not-yet" className="type-section">
          Not built yet
        </h2>
        <ul className="mt-4 space-y-2.5">
          {NOT_YET.map((w) => (
            <li key={w} className="flex gap-3 text-[15px] text-ink/85">
              <Minus className="mt-0.5 size-[18px] shrink-0 text-graphite" aria-hidden="true" />
              {w}
            </li>
          ))}
        </ul>
        <p className="mt-5 text-[13.5px] text-graphite">Verified with synthetic media only so far. Needs FFmpeg 6 or later, with ffprobe, on this computer.</p>
      </section>
    </div>
  );
}
