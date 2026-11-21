/**
 * Runs once when a server starts (Next.js instrumentation). For the contained
 * Design Agent (#241): stops live contained runs and their processes when the
 * server receives SIGTERM or SIGINT, and removes what earlier servers and
 * runs left behind (`sweepLeftoverFolders`) before any request is served.
 * Both are harmless with the legacy profile, which has no such folders or
 * processes: the sweep creates nothing.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installShutdownHook } = await import("@/lib/agent-processes");
  const { sweepLeftoverFolders } = await import("@/lib/agent-workspace");
  installShutdownHook();
  try {
    // Moving leftovers into quarantine is awaited; deleting them is not.
    const { purged } = await sweepLeftoverFolders();
    void purged;
  } catch (err) {
    console.error("[design-agent] could not sweep leftover folders", { code: (err as NodeJS.ErrnoException)?.code ?? null });
  }
}
