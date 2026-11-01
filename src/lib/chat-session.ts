import { isSessionId } from "@/lib/chat-stream";

/** The subset of `Storage` the chat panel's session memory needs. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Unchanged from earlier versions, so sessions already stored stay readable. */
const sessionKey = (carouselId: string) => `chat-session-${carouselId}`;

/**
 * The Claude session this carousel's chat resumes, or null to start a new
 * one. Sessions are kept per carousel, so one carousel never resumes
 * another's conversation; a stored value that is not a session ID is ignored.
 */
export function readChatSession(storage: KeyValueStorage, carouselId: string): string | null {
  try {
    const value = storage.getItem(sessionKey(carouselId));
    return isSessionId(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the carousel's session, or forgets it when given null. */
export function writeChatSession(
  storage: KeyValueStorage,
  carouselId: string,
  sessionId: string | null
): void {
  try {
    if (isSessionId(sessionId)) storage.setItem(sessionKey(carouselId), sessionId);
    else storage.removeItem(sessionKey(carouselId));
  } catch {
    // Storage can be full or unavailable; the chat still works without resuming.
  }
}
