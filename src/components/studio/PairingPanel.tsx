"use client";

/**
 * Pairing this browser with the Video Studio (#150): one field for the
 * one-time code `npm run studio:pair` prints, grouped as it is typed, sent on
 * Enter. The page never sees the session token; the server sets a cookie the
 * page cannot read.
 */
import { useId, useState, type FormEvent } from "react";
import { KeyRound, Loader2, TerminalSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StudioApiError } from "@/lib/video/studio/api";
import { PAIRING_CODE_LENGTH, readPairingInput } from "@/lib/video/studio/pairing-code";
import { pairingErrorMessage } from "@/lib/video/studio/studio-messages";
import { useStudioApi } from "./workspace";

export function PairingPanel({ onPaired }: { onPaired: () => void }) {
  const api = useStudioApi();
  const [typed, setTyped] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const input = readPairingInput(typed);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.complete || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.pair(input.display);
      onPaired();
    } catch (e) {
      setError(pairingErrorMessage(e instanceof StudioApiError ? e : new StudioApiError(0, "unexpected_error", "something went wrong in the page")));
      setSending(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <section aria-labelledby={`${id}-title`} className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden>
            <KeyRound className="h-4 w-4 text-foreground" />
          </span>
          <h2 id={`${id}-title`} className="text-base font-semibold text-foreground">
            Pair this browser
          </h2>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          The Studio opens only in a browser you have paired with this computer. You do it once; the pairing lasts 12 hours, also across restarts.
        </p>
        <ol className="mt-4 space-y-2.5 text-sm text-foreground">
          <li className="flex gap-2.5">
            <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              In a terminal in the CreatorBrio folder, run
              <code className="mt-1 block w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-xs">npm run studio:pair</code>
            </span>
          </li>
          <li className="flex gap-2.5">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>Enter the code it prints. A code works once, for five minutes.</span>
          </li>
        </ol>

        <form onSubmit={(e) => void submit(e)} className="mt-6" noValidate>
          <label htmlFor={`${id}-code`} className="text-xs font-medium text-foreground">
            Pairing code
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id={`${id}-code`}
              value={input.display}
              onChange={(e) => {
                setTyped(e.target.value);
                if (error) setError(null);
              }}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              disabled={sending}
              aria-describedby={error ? `${id}-help ${id}-error` : `${id}-help`}
              aria-invalid={error ? true : undefined}
              className="font-mono tracking-wider"
            />
            <Button type="submit" disabled={!input.complete || sending} className="w-24 shrink-0">
              {sending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {sending ? "Pairing" : "Pair"}
            </Button>
          </div>
          <p id={`${id}-help`} className="mt-1.5 text-xs text-muted-foreground tabular-nums">
            {input.code.length} of {PAIRING_CODE_LENGTH} characters. Dashes, spaces and case do not matter.
          </p>
          {error && (
            <p id={`${id}-error`} role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground">
              {error}
            </p>
          )}
        </form>
      </section>
    </div>
  );
}
