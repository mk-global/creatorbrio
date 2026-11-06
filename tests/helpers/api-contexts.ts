import type { ApiContext } from "@/lib/video/production/api/handlers";

/**
 * A server restart for API tests: stops the media and render runners of every
 * API context this process created and waits for them, then forgets the
 * contexts, so the next request builds fresh in-memory state over the same
 * files. Call it before removing a folder the runners may write into, or a
 * job still writing there makes the removal fail.
 */
export async function restartApi(): Promise<void> {
  const contexts = (globalThis as { __creatorbrioProductionApi?: Map<string, ApiContext> }).__creatorbrioProductionApi;
  for (const ctx of contexts?.values() ?? []) {
    ctx.jobs.stop();
    ctx.renders.stop();
    await Promise.all([ctx.jobs.idle(), ctx.renders.idle()]);
  }
  contexts?.clear();
}
