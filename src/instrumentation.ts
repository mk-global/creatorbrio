/**
 * Runs once when a server starts (Next.js instrumentation). Only with the
 * contained Design Agent profile (#241, #246): first it takes ownership of the
 * data folder and the agent folders (`claimContainedServer`), and a server
 * that cannot, because another contained server holds them, does nothing more
 * and refuses contained designs. The owner stops live contained runs and
 * their processes when it receives SIGTERM, SIGINT or SIGHUP, giving back its
 * ownership then, and, before any request is served, stops the processes
 * earlier servers' runs left working in the profile's folders and removes the
 * folders earlier servers and runs left behind (`sweepLeftoverFolders`). With
 * the legacy profile, or a profile setting that is neither name, it does
 * nothing.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { designAgentProfileName } = await import("@/lib/design-agent-profile");
  const profile = designAgentProfileName();
  if (!profile.ok || profile.name !== "contained") return;
  const { claimContainedServer, containedServerClaimLog } = await import("@/lib/contained-server");
  const claim = await claimContainedServer();
  if (!claim.owned) {
    // Not a fault of this server, but it runs no contained design until restarted: an error the operator should see.
    console.error("[design-agent] this server does not own the contained Design Agent's folders; it runs no contained design, no start sweep and no stop of leftover processes", containedServerClaimLog());
    return;
  }
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
