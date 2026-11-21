/**
 * Which Claude sessions a contained Design Agent run may resume (#237).
 *
 * The Claude CLI resumes any session it can find under the person's Claude
 * configuration, whatever folder it began in, so a session id alone would let
 * a contained run continue (and append to) any session on the machine,
 * including the person's own. The server therefore binds each session a
 * contained run hands back to that run's carousel, and a contained run
 * resumes only a session bound to its own carousel; any other is refused as
 * not found, which the chat answers by starting a fresh conversation.
 *
 * The bindings live in `data/design-agent-sessions.json`, written only through
 * `mutateData`, never in the agent's own folder, which the agent can write.
 */
import { isSessionId } from "@/lib/chat-stream";
import { mutateData, readDataSafe } from "@/lib/data";

const SESSIONS_FILE = "design-agent-sessions.json";

/** The most recent sessions kept per carousel; an older one starts a fresh conversation. */
export const MAX_BOUND_SESSIONS = 20;

interface SessionsFile {
  version: 1;
  carousels: Record<string, string[]>;
}

const emptySessions = (): SessionsFile => ({ version: 1, carousels: {} });

/** Binds a session a contained run handed back to its carousel, most recent last. */
export async function bindAgentSession(carouselId: string, sessionId: string): Promise<void> {
  if (!isSessionId(sessionId)) throw new Error("Only a Claude session id can be bound");
  await mutateData(SESSIONS_FILE, emptySessions, (data) => {
    const kept = (data.carousels[carouselId] ?? []).filter((id) => id !== sessionId);
    kept.push(sessionId);
    data.carousels[carouselId] = kept.slice(-MAX_BOUND_SESSIONS);
  });
}

/** Whether a contained run for this carousel may resume this session. */
export async function isAgentSessionBound(carouselId: string, sessionId: string): Promise<boolean> {
  const data = await readDataSafe<SessionsFile>(SESSIONS_FILE, emptySessions());
  return (data.carousels?.[carouselId] ?? []).includes(sessionId);
}

/** Forgets every session of a deleted carousel; writes nothing when it had none, so the legacy profile never creates the file. */
export async function forgetAgentSessions(carouselId: string): Promise<void> {
  const current = await readDataSafe<SessionsFile>(SESSIONS_FILE, emptySessions());
  if (!current.carousels?.[carouselId]) return;
  await mutateData(SESSIONS_FILE, emptySessions, (data) => {
    delete data.carousels[carouselId];
  });
}
