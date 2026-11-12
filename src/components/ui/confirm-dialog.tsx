"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRef } from "react";
import { X } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  /** The button that closes the dialog without doing anything. */
  cancelLabel?: string;
  variant?: "destructive" | "default";
  onConfirm: () => void;
}

/**
 * The app's one confirmation (#175, Design C). These dialogs are opened by
 * state rather than by a Radix trigger, so the dialog remembers what had
 * focus when it opened and returns focus there when it closes.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
}: ConfirmDialogProps) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay data-oc-overlay className="fixed inset-0 z-[60] bg-ink/35" />
        <Dialog.Content
          data-oc-dialog
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(e) => {
            const el = opener.current;
            if (el && el.isConnected) {
              e.preventDefault();
              el.focus();
            }
          }}
          className="fixed top-1/2 left-1/2 z-[61] max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-[14px] bg-sheet p-6 shadow-[0_24px_60px_-20px_rgb(28_27_41/0.5)]"
        >
          <div className="flex items-start gap-4">
            <Dialog.Title className="display-md flex-1 text-[24px]">{title}</Dialog.Title>
            <Dialog.Close className="btn btn-ghost btn-sm btn-icon -mt-1 -mr-2" aria-label="Close">
              <X className="size-4" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-2 text-graphite">{description}</Dialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Dialog.Close className="btn btn-quiet">{cancelLabel}</Dialog.Close>
            <button
              type="button"
              className={variant === "destructive" ? "btn btn-danger" : "btn btn-primary"}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
