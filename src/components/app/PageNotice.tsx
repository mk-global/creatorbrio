import { CircleAlert, Info } from "lucide-react";

/**
 * A page-level status (#175): something a person should know before acting,
 * such as Claude Code not being found or a list that could not be read. Run
 * notices inside the editor keep their own smaller treatment (`ui/notice`).
 */
export function PageNotice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "alert";
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const Icon = tone === "alert" ? CircleAlert : Info;
  return (
    <div
      role={tone === "alert" ? "alert" : "status"}
      className={`flex flex-col gap-3 rounded-[14px] p-4 sm:flex-row sm:items-center sm:gap-4 ${
        tone === "alert" ? "bg-alert-bg text-ink" : "bg-sheet shadow-[inset_0_0_0_1px_var(--color-rule)]"
      }`}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <Icon className={`mt-0.5 size-5 shrink-0 ${tone === "alert" ? "text-alert" : "text-graphite"}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          {children && <div className="mt-0.5 text-[14px] break-words text-ink/80">{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 gap-2 pl-8 sm:pl-0">{action}</div>}
    </div>
  );
}

/**
 * Shown in place of a page that needs the brands when they could not be read
 * (#175). Home, Projects and Templates all show this one notice, so a broken
 * brands file is never mistaken for an empty library.
 */
export function BrandsUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <PageNotice
      tone="alert"
      title="Your brands couldn't be loaded"
      action={
        <button type="button" className="btn btn-quiet btn-sm" onClick={onRetry}>
          Try again
        </button>
      }
    >
      {message} Nothing was deleted; your data files were left as they are.
    </PageNotice>
  );
}
