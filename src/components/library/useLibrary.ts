"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProjectSummary } from "@/lib/project-summary";
import type { Template } from "@/types/template";

/**
 * The library as the screens read it (#175): every project's summary and
 * every template, loaded once per page and filtered by brand in the browser,
 * so switching brands never waits on the network and a slow answer can never
 * show under the wrong brand. A list that cannot be read is an error with the
 * server's reason, never an empty library.
 */

export type Loaded<T> = { status: "loading" } | { status: "ready"; items: T[] } | { status: "error"; message: string };

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed with status ${res.status}.`);
  return body as T;
}

function useList<T>(url: string, pick: (body: unknown) => T[]) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    readJson<unknown>(url)
      .then((body) => current && setState({ status: "ready", items: pick(body) }))
      .catch((err: unknown) => current && setState({ status: "error", message: err instanceof Error ? err.message : "The list could not be read." }));
    return () => {
      current = false;
    };
    // `pick` is a module-level function per caller; the URL and attempt decide reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const update = useCallback((change: (items: T[]) => T[]) => setState((s) => (s.status === "ready" ? { status: "ready", items: change(s.items) } : s)), []);
  return { state, reload, update };
}

const pickProjects = (body: unknown) => (body as { projects?: ProjectSummary[] }).projects ?? [];
const pickTemplates = (body: unknown) => (body as { templates?: Template[] }).templates ?? [];

export function useProjects() {
  return useList<ProjectSummary>("/api/carousels?view=summary", pickProjects);
}

export function useTemplates() {
  return useList<Template>("/api/templates", pickTemplates);
}

/** A template's brand: one saved before brands belongs to the default brand. */
export function templateBrandId(template: Template, defaultBrandId: string | null): string | null {
  return template.brandId ?? defaultBrandId;
}

/** A template's first slide, by order. */
export function templateFirstSlide(template: Template): string | null {
  const first = [...template.slides].sort((a, b) => a.order - b.order)[0];
  return first ? first.html : null;
}

// What a person can do to a project or template from the library. Each
// answers with the server's own reason when it is refused.

export function duplicateProject(id: string) {
  return readJson<{ id: string; name: string }>(`/api/carousels/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
}

export function deleteProject(id: string) {
  return readJson<unknown>(`/api/carousels/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function saveProjectAsTemplate(id: string) {
  return readJson<Template>("/api/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ carouselId: id }),
  });
}

export function deleteTemplate(id: string) {
  return readJson<unknown>(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}
