"use client";

import { useEffect, useId, useRef, useState } from "react";

// An accessible menu button: arrow keys move, Home and End jump, Escape and
// Tab close, focus returns to the trigger. The open menu is positioned
// against the window, so a scrolling row (the editor tools, Home's recent
// work) cannot clip it. Hand-built rather than adding a menu package: this
// one was verified by keyboard in the Design C prototype, and the app's
// menus are short lists that need nothing more (#175).

export interface MenuItem {
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function Menu({
  trigger,
  label,
  items,
  header,
  align = "end",
  triggerClassName = "btn btn-ghost btn-sm btn-icon",
  wrapperClassName = "relative inline-flex",
  width = 240,
}: {
  trigger: React.ReactNode;
  label: string;
  items: MenuItem[];
  header?: React.ReactNode;
  align?: "start" | "end";
  triggerClassName?: string;
  wrapperClassName?: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])');
    first?.focus();
    const onDown = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onMove = (e: Event) => {
      if (e.type === "scroll" && list.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(width, window.innerWidth - 24);
    const top = r.bottom + 8;
    const left = align === "end" ? Math.max(12, r.right - w) : Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
    setPos({ top, left, width: w, maxHeight: Math.max(160, window.innerHeight - top - 12) });
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); els[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); els[els.length - 1]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { close(false); }
  };

  return (
    <div className={wrapperClassName}>
      <button
        ref={btn}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        onClick={() => { if (!open) place(); setOpen((o) => !o); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) { e.preventDefault(); place(); setOpen(true); }
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKey}
          className="pop fixed z-50 overflow-y-auto rounded-[14px] bg-sheet p-1.5 shadow-[0_0_0_1px_rgb(28_27_41/0.08),0_18px_40px_-12px_rgb(28_27_41/0.35)]"
          style={pos}
        >
          {header && <div className="px-2.5 pt-1.5 pb-2 text-[13px] text-graphite">{header}</div>}
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role={it.checked !== undefined ? "menuitemradio" : "menuitem"}
              aria-checked={it.checked !== undefined ? it.checked : undefined}
              aria-disabled={it.disabled || undefined}
              tabIndex={-1}
              onClick={() => {
                if (it.disabled) return;
                close();
                it.onSelect();
              }}
              className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] outline-none focus-visible:bg-hover hover:bg-hover ${
                it.danger ? "text-alert" : "text-ink"
              } ${it.disabled ? "cursor-not-allowed opacity-50" : ""}`}
            >
              {it.icon && <span className="shrink-0 text-graphite [&>svg]:size-4" aria-hidden="true">{it.icon}</span>}
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{it.label}</span>
                {it.hint && <span className="block text-[12.5px] leading-snug text-graphite">{it.hint}</span>}
              </span>
              {it.checked !== undefined && (
                <span className={`size-2 shrink-0 rounded-full ${it.checked ? "bg-crop" : ""}`} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
