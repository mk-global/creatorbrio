"use client";

/** The timeline's "Keyboard" popover (#150): every key a focused clip answers to. */
import { useEffect, useId, useRef, useState } from "react";
import { Keyboard } from "lucide-react";

import { Button } from "@/components/ui/button";
import { KEYBOARD_HELP } from "@/lib/video/studio/timeline-keys";

export function TimelineKeyboardHelp() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  return (
    <div ref={root} className="relative">
      <Button
        ref={trigger}
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Keyboard className="h-3.5 w-3.5" aria-hidden />
        Keyboard
      </Button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label="Timeline keyboard shortcuts"
          className="absolute bottom-full right-0 z-30 mb-1 w-80 rounded-lg border border-border bg-surface p-3 shadow-lg"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <p className="mb-2 text-xs text-muted-foreground">Focus a clip with Tab or a click, then:</p>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-xs">
            {KEYBOARD_HELP.map((row) => (
              <div key={row.action} className="contents">
                <dt className="flex justify-end gap-1 whitespace-nowrap">
                  {row.keys.map((k) => (
                    <kbd key={k} className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[11px] leading-none text-foreground">
                      {k}
                    </kbd>
                  ))}
                </dt>
                <dd className="text-foreground">{row.action}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
