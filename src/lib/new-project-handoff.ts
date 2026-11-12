/**
 * Words handed from one screen to the next in this browser tab (#175): the
 * idea typed on Home goes to the New project form, and what the form
 * composes goes into the editor's message box. Nothing is ever sent from
 * here; the person reads it and presses Send (#175,
 * docs/architecture/app-shell.md). Kept in sessionStorage, so it never
 * outlives the tab and never reaches the server.
 */
const IDEA_KEY = "creatorbrio:idea";
const draftKey = (projectId: string) => `creatorbrio:draft:${projectId}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// Reading never removes: React may run a state initializer twice in
// development, so a screen reads during render and clears once mounted.
function read(key: string): string {
  try {
    return storage()?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function clear(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // nothing to clear
  }
}

function put(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Storage may be full or blocked; the person can still type it again.
  }
}

export const handOffIdea = (idea: string) => put(IDEA_KEY, idea);
export const readIdea = () => read(IDEA_KEY);
export const clearIdea = () => clear(IDEA_KEY);
export const handOffDraft = (projectId: string, draft: string) => put(draftKey(projectId), draft);
export const readDraft = (projectId: string) => read(draftKey(projectId));
export const clearDraft = (projectId: string) => clear(draftKey(projectId));
