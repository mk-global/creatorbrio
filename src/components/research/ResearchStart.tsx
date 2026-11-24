"use client";

import Link from "next/link";
import { useState } from "react";
import type { WebSearchMethod } from "@/types/research";
import type { StartRefusal } from "./useResearch";

/**
 * How research will search the web here (#256): the method it tries first,
 * "unavailable" when Claude Code is not found (research cannot run without
 * it), or null while that is not known.
 */
export type SearchAvailability = WebSearchMethod | "unavailable" | null;

/** The search the app status reports, as the research forms use it. */
export function searchAvailability(
  status: { claude: { available: boolean }; research?: { search: { provider?: WebSearchMethod | null } } } | null
): SearchAvailability {
  if (!status) return null;
  // Synthesis needs Claude Code whatever search is set up, so without it no run can start.
  if (!status.claude.available) return "unavailable";
  return status.research?.search.provider ?? null;
}

export const MAX_LINKS = 3;
export const MAX_TOPIC = 500;

/** Failures the person fixes in Settings: where, so a notice can link there. */
const SETTINGS_LINK: Record<string, { href: string; label: string }> = {
  search_key_refused: { href: "/settings#research", label: "Web search settings" },
  web_search_unavailable: { href: "/settings#research", label: "Web search settings" },
  budget_setting_invalid: { href: "/settings#research", label: "Research settings" },
  claude_unavailable: { href: "/settings#claude", label: "Claude Code settings" },
};

/** The link to the Settings row that fixes a failure code, led by a space to follow a message; nothing for any other code. */
export function SettingsLink({ code }: { code: string | null | undefined }) {
  const target = code ? SETTINGS_LINK[code] : undefined;
  if (!target) return null;
  return (
    <>
      {" "}
      <Link href={target.href} className="font-semibold underline underline-offset-4">
        {target.label}
      </Link>
    </>
  );
}

/** Lines of the links box that are not blank, trimmed. */
export function linksFrom(text: string): string[] {
  return text
    .split(/\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** What the links box tells the person about how research will search. */
function SearchHint({ search }: { search: SearchAvailability }) {
  if (search === "unavailable") {
    return (
      <>
        Research needs Claude Code, and CreatorBrio couldn&apos;t find it.
        <SettingsLink code="claude_unavailable" />
      </>
    );
  }
  return (
    <>
      {search === "brave"
        ? "Pages you trust are read first. CreatorBrio also searches the web with Brave Search, and with Claude's web search if Brave refuses the key, limits requests or can't be reached."
        : "Pages you trust are read first. CreatorBrio also searches the web with Claude's web search, through your Claude Code sign-in."}
    </>
  );
}

/**
 * What to research (#253): a topic and up to three links of the person's own.
 * Research searches the web with Claude's own web search, or Brave Search
 * when it is set up (#256), so links are never required here. Without Claude
 * Code the form says research needs it and links to Settings, and still lets
 * a start through, so the server's own refusal, which links there too, is
 * reachable.
 */
export function ResearchFields({
  topic,
  onTopic,
  links,
  onLinks,
  search,
  idPrefix = "research",
}: {
  topic: string;
  onTopic: (v: string) => void;
  links: string;
  onLinks: (v: string) => void;
  search: SearchAvailability;
  idPrefix?: string;
}) {
  const count = linksFrom(links).length;
  return (
    <div className="grid max-w-[640px] gap-5">
      <div>
        <label htmlFor={`${idPrefix}-topic`} className="mb-1.5 block text-[14px] font-semibold">
          Topic to research
        </label>
        <textarea
          id={`${idPrefix}-topic`}
          className="field"
          rows={2}
          maxLength={MAX_TOPIC}
          value={topic}
          onChange={(e) => onTopic(e.target.value)}
          placeholder="For example: how morning light affects sleep"
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-links`} className="mb-1.5 block text-[14px] font-semibold">
          Your links{" "}
          <span className="font-normal text-graphite">{`Optional, up to ${MAX_LINKS}`}</span>
        </label>
        <textarea
          id={`${idPrefix}-links`}
          className="field"
          rows={3}
          value={links}
          onChange={(e) => onLinks(e.target.value)}
          placeholder="https://… one per line"
          aria-describedby={`${idPrefix}-links-hint`}
          aria-invalid={count > MAX_LINKS || undefined}
        />
        <p id={`${idPrefix}-links-hint`} className={`mt-1.5 text-[13px] ${count > MAX_LINKS ? "text-alert" : "text-graphite"}`}>
          {count > MAX_LINKS ? `That is ${count} links; research reads at most ${MAX_LINKS} of yours.` : <SearchHint search={search} />}
        </p>
      </div>
    </div>
  );
}

/**
 * Whether the fields can start research, and why not. A topic the server would refuse for its length stops here, so New
 * project never creates a project for it. Links are never required: the server refuses a start it cannot run, and says why.
 */
export function researchReady(topic: string, links: string): { ok: boolean; reason: string | null } {
  const length = topic.trim().length;
  if (length < 3) return { ok: false, reason: null };
  if (length > MAX_TOPIC) return { ok: false, reason: `The topic can be at most ${MAX_TOPIC} characters; this one is ${length}. Shorten it to research it.` };
  const count = linksFrom(links).length;
  if (count > MAX_LINKS) return { ok: false, reason: null };
  return { ok: true, reason: null };
}

/** The form on the research screen, to start research or start it again with other words or links. */
export function ResearchStart({
  initialTopic,
  initialLinks,
  search,
  onStart,
  onCancel,
  editorHref,
  error,
}: {
  initialTopic: string;
  initialLinks: string[];
  search: SearchAvailability;
  onStart: (topic: string, links: string[]) => Promise<void>;
  onCancel?: () => void;
  editorHref: string;
  error: StartRefusal | null;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const [links, setLinks] = useState(initialLinks.join("\n"));
  const [busy, setBusy] = useState(false);
  const ready = researchReady(topic, links);
  return (
    <form
      className="mt-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready.ok || busy) return;
        setBusy(true);
        void onStart(topic.trim(), linksFrom(links)).finally(() => setBusy(false));
      }}
    >
      <ResearchFields topic={topic} onTopic={setTopic} links={links} onLinks={setLinks} search={search} />
      {error && (
        <p role="alert" className="mt-6 max-w-[640px] rounded-lg bg-alert-bg px-4 py-3 text-[14px]">
          Research didn&apos;t start: {error.message}
          <SettingsLink code={error.code} />
        </p>
      )}
      {ready.reason && <p className="mt-4 text-[13px] text-graphite">{ready.reason}</p>}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={!ready.ok || busy}>
          {busy ? "Starting…" : "Research"}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
        <Link href={editorHref} className="btn btn-ghost">
          Open the editor without research
        </Link>
      </div>
    </form>
  );
}
