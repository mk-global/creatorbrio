"use client";

/**
 * The production list (#150): every production in the store, newest change
 * first, with its revision and last update; damaged or incomplete ones are
 * listed with their status and cannot be opened. A new production is
 * created and opened from the form above the list.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, Clapperboard, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StudioApiError } from "@/lib/video/studio/api";
import { sortProductions } from "@/lib/video/studio/production-ids";
import { readErrorMessage } from "@/lib/video/studio/studio-messages";
import type { ProductionSummary } from "@/lib/video/studio/types";
import { ProductionPickerCreate } from "./ProductionPickerCreate";
import { useStudioApi } from "./workspace";

type List = { status: "loading" } | { status: "ready"; productions: ProductionSummary[] } | { status: "error"; message: string };

const STATUS_LABEL = { corrupt: "Damaged", unsupported_version: "Newer version", incomplete: "Incomplete" } as const;

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function updated(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : `Updated ${when.format(date)}`;
}

async function readList(api: ReturnType<typeof useStudioApi>): Promise<List> {
  try {
    return { status: "ready", productions: sortProductions(await api.listProductions()) };
  } catch (e) {
    const error = e instanceof StudioApiError ? e : new StudioApiError(0, "unexpected_error", "something went wrong in the page");
    return { status: "error", message: readErrorMessage(error, "The productions") };
  }
}

export function ProductionPicker({ onOpen }: { onOpen: (id: string | null) => void }) {
  const api = useStudioApi();
  const [list, setList] = useState<List>({ status: "loading" });

  const load = useCallback(() => {
    setList({ status: "loading" });
    void readList(api).then(setList);
  }, [api]);

  useEffect(() => {
    let current = true;
    void readList(api).then((next) => current && setList(next));
    return () => {
      current = false;
    };
  }, [api]);

  return (
    <div>
      <div className="w-full max-w-2xl">
        <h2 className="display-md text-[28px]">Productions</h2>
        <p className="mt-1 text-sm text-muted-foreground">Open a production to edit it, or start a new one.</p>
        <div className="mt-6">
          <ProductionPickerCreate onCreated={(id) => onOpen(id)} />
        </div>

        <section aria-label="Your productions" aria-busy={list.status === "loading"} className="mt-8">
          {list.status === "loading" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Reading your productions…
            </p>
          )}
          {list.status === "error" && (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <p className="flex-1 text-sm text-foreground">{list.message}</p>
              <Button variant="outline" size="sm" onClick={load}>
                Try again
              </Button>
            </div>
          )}
          {list.status === "ready" && list.productions.length === 0 && (
            <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
              <Clapperboard className="h-6 w-6 text-muted-foreground" aria-hidden />
              <p className="mt-3 text-sm font-medium text-foreground">No productions yet</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">A production is one video you edit: its footage, music, captions and titles on a timeline, exported as an MP4.</p>
            </div>
          )}
          {list.status === "ready" && list.productions.length > 0 && (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {list.productions.map((p) => (
                <li key={p.productionId}>
                  {p.status === "ok" ? (
                    <button
                      type="button"
                      onClick={() => onOpen(p.productionId)}
                      aria-label={`Open ${p.name}`}
                      className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{p.name}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                          Revision {p.revision}
                          {updated(p.updatedAt) && <> · {updated(p.updatedAt)}</>}
                          {p.runId && <> · An agent run is open</>}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
                    </button>
                  ) : (
                    <div className="flex items-start gap-3 px-4 py-3" aria-disabled="true">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-mono text-xs text-foreground">{p.productionId}</span>
                          <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">{STATUS_LABEL[p.status]}</span>
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">Cannot be opened: {p.message}</span>
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
