"use client";

/**
 * A succeeded render's downloads (#150). A plain link cannot carry the Studio
 * header the session requires, so each button reads the file through the API
 * and saves it from an object URL, under the name the server's
 * `Content-Disposition` gives it. A failed download says why next to the
 * buttons.
 */
import { useState } from "react";
import { Download, LoaderCircle } from "lucide-react";

import { StudioApiError } from "@/lib/video/studio/api";
import { RENDER_DOWNLOADS, renderFileName, sentence, type RenderFileName } from "@/lib/video/studio/render-status";
import type { RenderView } from "@/lib/video/studio/types";
import { useWorkspace } from "./workspace";

/** Hands `blob` to the browser as a download named `name`, then lets the object URL go. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download has taken its reference once the click is handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExportDownloads({ render, files }: { render: RenderView; files: RenderFileName[] }) {
  const { api } = useWorkspace();
  const [loading, setLoading] = useState<ReadonlySet<RenderFileName>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  async function download(name: RenderFileName, label: string) {
    setProblem(null);
    setLoading((s) => new Set(s).add(name));
    try {
      saveBlob(await api.renderFile(render.productionId, render.renderId, name), renderFileName(render.productionId, render.renderId, name));
    } catch (error) {
      setProblem(`${label} was not downloaded. ${error instanceof StudioApiError ? sentence(error.message) : "Something went wrong in the page."}`);
    } finally {
      setLoading((s) => {
        const next = new Set(s);
        next.delete(name);
        return next;
      });
    }
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-muted-foreground">Download</span>
        {RENDER_DOWNLOADS.filter((d) => files.includes(d.name)).map((d) => {
          const busy = loading.has(d.name);
          return (
            <button
              key={d.name}
              type="button"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => void download(d.name, d.label)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
              aria-label={busy ? `Downloading ${d.label}, revision ${render.revision}` : `Download ${d.label}, revision ${render.revision}`}
            >
              {busy ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden /> : <Download className="h-3 w-3" aria-hidden />}
              {d.label}
            </button>
          );
        })}
      </div>
      {problem && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
