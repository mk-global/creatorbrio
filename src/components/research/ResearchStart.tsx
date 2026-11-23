"use client";

import Link from "next/link";
import { useState } from "react";

export const MAX_LINKS = 3;
export const MAX_TOPIC = 500;

/** Lines of the links box that are not blank, trimmed. */
export function linksFrom(text: string): string[] {
  return text
    .split(/\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * What to research (#253): a topic and up to three links of the person's own.
 * Without a search key the links are required, and the form says so before
 * anything is sent.
 */
export function ResearchFields({
  topic,
  onTopic,
  links,
  onLinks,
  searchConfigured,
  idPrefix = "research",
}: {
  topic: string;
  onTopic: (v: string) => void;
  links: string;
  onLinks: (v: string) => void;
  /** Null while unknown. */
  searchConfigured: boolean | null;
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
          <span className="font-normal text-graphite">{searchConfigured === false ? `Required, up to ${MAX_LINKS}` : `Optional, up to ${MAX_LINKS}`}</span>
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
          {count > MAX_LINKS
            ? `That is ${count} links; research reads at most ${MAX_LINKS} of yours.`
            : searchConfigured === false
              ? "Web search is not set up, so research reads only the pages you link. Public pages that show their text without a sign-in work best."
              : "Pages you trust are read first. CreatorBrio also searches the web with Brave Search."}
        </p>
        {searchConfigured === false && (
          <p className="mt-1 text-[13px] text-graphite">
            To search the web too, add your own Brave Search API key.{" "}
            <Link href="/settings#research" className="font-semibold text-ink underline underline-offset-4">
              How to set it up
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

/** Whether the fields can start research, and why not. */
export function researchReady(topic: string, links: string, searchConfigured: boolean | null): { ok: boolean; reason: string | null } {
  if (topic.trim().length < 3) return { ok: false, reason: null };
  const count = linksFrom(links).length;
  if (count > MAX_LINKS) return { ok: false, reason: null };
  if (searchConfigured === false && count === 0) return { ok: false, reason: "Add at least one link, or set up web search." };
  return { ok: true, reason: null };
}

/** The form on the research screen, to start research or start it again with other words or links. */
export function ResearchStart({
  initialTopic,
  initialLinks,
  searchConfigured,
  onStart,
  onCancel,
  editorHref,
  error,
}: {
  initialTopic: string;
  initialLinks: string[];
  searchConfigured: boolean | null;
  onStart: (topic: string, links: string[]) => Promise<void>;
  onCancel?: () => void;
  editorHref: string;
  error: string | null;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const [links, setLinks] = useState(initialLinks.join("\n"));
  const [busy, setBusy] = useState(false);
  const ready = researchReady(topic, links, searchConfigured);
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
      <ResearchFields topic={topic} onTopic={setTopic} links={links} onLinks={setLinks} searchConfigured={searchConfigured} />
      {error && (
        <p role="alert" className="mt-6 max-w-[640px] rounded-lg bg-alert-bg px-4 py-3 text-[14px]">
          Research didn&apos;t start: {error}
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
