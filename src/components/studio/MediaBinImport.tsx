"use client";

/**
 * Importing a file into the media library by its absolute path (#150). The
 * server copies the file into CreatorBrio's data folder and never changes
 * the original; browser upload is not available yet (#141). The path the
 * person typed stays in this field only: it is not logged or shown anywhere
 * else.
 */
import { useId, useState, type FormEvent } from "react";
import { FolderInput, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StudioApiError } from "@/lib/video/studio/api";
import { importErrorMessage } from "@/lib/video/studio/studio-messages";
import { useWorkspace } from "./workspace";

type Outcome = { tone: "done" | "error"; text: string } | null;

export function MediaBinImport() {
  const { api, refreshMedia } = useWorkspace();
  const [path, setPath] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = path.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setOutcome(null);
    try {
      const result = await api.importMedia(trimmed);
      setOutcome({ tone: "done", text: result.status === "existing" ? `Already in your library: ${result.media.originalName}` : `Imported ${result.media.originalName}` });
      setPath("");
      await refreshMedia();
    } catch (e) {
      setOutcome({ tone: "error", text: importErrorMessage(e instanceof StudioApiError ? e : new StudioApiError(0, "unexpected_error", "something went wrong in the page")) });
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="border-b border-border p-3">
      <label htmlFor={`${id}-path`} className="text-xs font-medium text-foreground">
        Import a file
      </label>
      <div className="mt-1.5 flex gap-1.5">
        <Input
          id={`${id}-path`}
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            if (outcome?.tone === "error") setOutcome(null);
          }}
          placeholder="/Users/you/Movies/clip.mov"
          autoComplete="off"
          spellCheck={false}
          disabled={sending}
          aria-describedby={outcome ? `${id}-help ${id}-outcome` : `${id}-help`}
          aria-invalid={outcome?.tone === "error" ? true : undefined}
          className="h-8 min-w-0 px-2 font-mono text-xs"
        />
        <Button type="submit" variant="outline" size="sm" disabled={sending || !path.trim()} className="shrink-0 px-2.5">
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FolderInput className="h-3.5 w-3.5" aria-hidden />}
          Import
        </Button>
      </div>
      <p id={`${id}-help`} className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        The full path of a video, sound or image on this computer. CreatorBrio copies it into its library and never changes the original. Uploading from the browser is not available yet.
      </p>
      {outcome && (
        <p
          id={`${id}-outcome`}
          role={outcome.tone === "error" ? "alert" : "status"}
          className={outcome.tone === "error" ? "mt-2 text-xs text-destructive" : "mt-2 truncate text-xs text-foreground"}
          title={outcome.tone === "done" ? outcome.text : undefined}
        >
          {outcome.text}
        </p>
      )}
    </form>
  );
}
