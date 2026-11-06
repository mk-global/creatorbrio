"use client";

/**
 * The "New production" form (#150): a name, then an empty Instagram Reel
 * production made by `newEditProduction()`, created through the API and
 * opened. The store's admission is the judge; the page checks the name only
 * so a person hears about a mistake before sending.
 */
import { useId, useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { newEditProduction } from "@/lib/video/production/new-production";
import { StudioApiError } from "@/lib/video/studio/api";
import { checkProductionName, cryptoRandom, newProductionId, PRODUCTION_NAME_MAX } from "@/lib/video/studio/production-ids";
import { createErrorMessage } from "@/lib/video/studio/studio-messages";
import { useStudioApi } from "./workspace";

export function ProductionPickerCreate({ onCreated }: { onCreated: (id: string) => void }) {
  const api = useStudioApi();
  const [name, setName] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    const checked = checkProductionName(name);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setSending(true);
    setError(null);
    const productionId = newProductionId(Date.now(), cryptoRandom);
    try {
      await api.createProduction(newEditProduction({ id: productionId, name: checked.name, at: new Date().toISOString() }));
      onCreated(productionId);
    } catch (e) {
      setError(createErrorMessage(e instanceof StudioApiError ? e : new StudioApiError(0, "unexpected_error", "something went wrong in the page")));
      setSending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="rounded-xl border border-border bg-surface p-4">
      <label htmlFor={`${id}-name`} className="text-sm font-medium text-foreground">
        New production
      </label>
      <p id={`${id}-help`} className="mt-0.5 text-xs text-muted-foreground">
        An Instagram Reel, 1080 × 1920 at 30 frames per second.
      </p>
      <div className="mt-3 flex gap-2">
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Name, e.g. Spring launch teaser"
          maxLength={PRODUCTION_NAME_MAX + 20}
          disabled={sending}
          aria-describedby={error ? `${id}-help ${id}-error` : `${id}-help`}
          aria-invalid={error ? true : undefined}
        />
        <Button type="submit" variant="accent" disabled={sending} className="shrink-0">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          Create
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
