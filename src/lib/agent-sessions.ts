/**
 * Which Claude sessions a contained Design Agent run may resume, and in which
 * conversation folder (#237, #241).
 *
 * The Claude CLI resumes any session it can find under the person's Claude
 * configuration, whatever folder it began in, so a session id alone would let
 * a contained run continue (and append to) any session on the machine,
 * including the person's own. The server therefore binds each session a
 * contained run hands back to that run's carousel and conversation folder,
 * and a contained run resumes only a session bound to its own carousel, in
 * the folder it is bound to (the CLI keys sessions by working folder); any
 * other is refused as not found, which the chat answers by starting a fresh
 * conversation. A new conversation forgets the carousel's earlier bindings,
 * because their folders are removed.
 *
 * The bindings live in `data/design-agent-sessions.json`, written only through
 * `mutateData`, never in the agent's own folder, which the agent can write.
 * Bindings written before conversation folders existed (version 1, a bare
 * session id) name no folder and are not resumed.
 */
import { isSessionId } from "@/lib/chat-stream";
import { mutateData, readDataSafe } from "@/lib/data";
import { isServerId } from "@/lib/agent-workspace";

const SESSIONS_FILE = "design-agent-sessions.json";

/** The most recent sessions kept per carousel; an older one starts a fresh conversation. */
export const MAX_BOUND_SESSIONS = 20;

interface Binding {
  sessionId: string;
  conversationId: string;
}

interface SessionsFile {
  version: 1 | 2;
  carousels: Record<string, unknown[]>;
}

const emptySessions = (): SessionsFile => ({ version: 2, carousels: {} });

function bindingsOf(data: SessionsFile, carouselId: string): Binding[] {
  const entries = data.carousels?.[carouselId];
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e): e is Binding => typeof e === "object" && e !== null && isSessionId((e as Binding).sessionId) && isServerId((e as Binding).conversationId)
  );
}

/** Binds a session a contained run handed back to its carousel and conversation folder, most recent last. */
export async function bindAgentSession(carouselId: string, sessionId: string, conversationId: string): Promise<void> {
  if (!isSessionId(sessionId)) throw new Error("Only a Claude session id can be bound");
  if (!isServerId(conversationId)) throw new Error("Only a conversation id can be bound");
  await mutateData(SESSIONS_FILE, emptySessions, (data) => {
    data.version = 2;
    const kept = bindingsOf(data, carouselId).filter((b) => b.sessionId !== sessionId);
    kept.push({ sessionId, conversationId });
    data.carousels[carouselId] = kept.slice(-MAX_BOUND_SESSIONS);
  });
}

/** The conversation a contained run for this carousel resumes this session in, or null when it may not resume it. */
export async function boundConversation(carouselId: string, sessionId: string): Promise<string | null> {
  const data = await readDataSafe<SessionsFile>(SESSIONS_FILE, emptySessions());
  return bindingsOf(data, carouselId).find((b) => b.sessionId === sessionId)?.conversationId ?? null;
}

/** Forgets every session of a carousel; writes nothing when it had none, so the legacy profile never creates the file. */
export async function forgetAgentSessions(carouselId: string): Promise<void> {
  const current = await readDataSafe<SessionsFile>(SESSIONS_FILE, emptySessions());
  if (!current.carousels?.[carouselId]) return;
  await mutateData(SESSIONS_FILE, emptySessions, (data) => {
    delete data.carousels[carouselId];
  });
}
