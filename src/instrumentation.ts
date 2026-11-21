/**
 * Runs once when a server starts (Next.js instrumentation). Only with the
 * contained Design Agent profile (#241): stops live contained runs and their
 * processes when the server receives SIGTERM or SIGINT, and removes what
 * earlier servers and runs left behind (`sweepLeftoverFolders`) before any
 * request is served. With the legacy profile, or a profile setting that is
 * neither name, it does nothing.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { designAgentProfileName } = await import("@/lib/design-agent-profile");
  const profile = designAgentProfileName();
  if (!profile.ok || profile.name !== "contained") return;
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
