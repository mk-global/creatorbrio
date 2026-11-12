"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useBrandSelection } from "@/components/brand/useBrandSelection";

/**
 * What every page in the app shell shares (#175): the brands and the one
 * chosen for new work, and short confirmations. The chosen brand is a view
 * preference kept under the same browser key as before, so nobody loses
 * their choice; it never moves an existing project to another brand.
 */

type BrandState = ReturnType<typeof useBrandSelection>;

interface Toast {
  id: number;
  text: string;
}

interface AppState extends BrandState {
  toast: (text: string) => void;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const brands = useBrandSelection();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (text: string) => {
      const id = next.current++;
      setToasts((all) => [...all.slice(-2), { id, text }]);
      window.setTimeout(() => dismiss(id), 5000);
    },
    [dismiss]
  );

  const value = useMemo(() => ({ ...brands, toast }), [brands, toast]);

  return (
    <AppContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed inset-x-3 bottom-20 z-[70] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pop pointer-events-auto flex w-full max-w-[420px] items-start gap-3 rounded-xl bg-ink px-4 py-3 text-[14px] text-white shadow-[0_18px_40px_-16px_rgb(28_27_41/0.6)]"
          >
            <p className="min-w-0 flex-1">{t.text}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="-mr-1 rounded p-0.5 text-white/80 hover:text-white"
              aria-label="Dismiss"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
