import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one treatment for notices about a run that stopped, is unfinished or
 * failed (#168). Text is always the app's foreground colour, so it reads at
 * full contrast on the tone's pale surface; the tone's colour is carried only
 * by the icon and the border. Selected text keeps the foreground colour on a
 * fixed highlight rather than the system's.
 *
 * CreatorBrio has one light theme, so nothing here follows the operating
 * system's dark preference: a `dark:` variant on a light surface is what made
 * these notices unreadable on a Mac in dark mode.
 */
export type NoticeTone = "warning" | "error";

const TONES: Record<NoticeTone, { box: string; icon: string; action: string }> = {
  warning: { box: "border-warning/40 bg-warning-surface", icon: "text-warning", action: "border-warning hover:bg-warning/10" },
  error: { box: "border-destructive/40 bg-destructive-surface", icon: "text-destructive", action: "border-destructive hover:bg-destructive/10" },
};

export function Notice({
  tone,
  icon: Icon,
  title,
  children,
  action,
  role,
  className,
}: {
  tone: NoticeTone;
  icon: LucideIcon;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
  className?: string;
}) {
  return (
    <div
      data-notice={tone}
      role={role}
      className={cn(
        "rounded-lg border p-3 text-xs leading-relaxed text-foreground selection:bg-selection selection:text-foreground",
        TONES[tone].box,
        className
      )}
    >
      <div className="flex items-start gap-1.5">
        <Icon aria-hidden="true" className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", TONES[tone].icon)} />
        <div className="min-w-0 break-words">
          {title && <div className="font-medium">{title}</div>}
          <p className={title ? "mt-0.5" : undefined}>{children}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

/** A button inside a notice, such as Retry or Continue. */
export function NoticeAction({
  tone,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone: NoticeTone }) {
  return (
    <button
      type="button"
      className={cn(
        "mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50",
        TONES[tone].action,
        className
      )}
      {...props}
    />
  );
}
