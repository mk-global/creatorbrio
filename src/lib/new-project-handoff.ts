/**
 * Words handed from one screen to the next in this browser tab (#175): the
 * idea typed on Home goes to the New project form, and what the form
 * composes goes into the editor's message box. Nothing is ever sent from
 * here; the person reads it and presses Send (#175,
 * docs/architecture/app-shell.md). The one exception is research (#253):
 * the research screen's "Confirm and create design" is the person's request
 * to design, so it hands the editor a message to send once, on arrival.
 * Kept in sessionStorage, so it never outlives the tab and never reaches the
 * server.
 */
const IDEA_KEY = "creatorbrio:idea";
const draftKey = (projectId: string) => `creatorbrio:draft:${projectId}`;
const researchKey = (projectId: string) => `creatorbrio:research:${projectId}`;
const designStartKey = (projectId: string) => `creatorbrio:design-start:${projectId}`;

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

/** The topic and links the New project form asks the research screen to research (#253). */
export interface ResearchRequestDraft {
  topic: string;
  links: string[];
}

export const handOffResearch = (projectId: string, request: ResearchRequestDraft) => put(researchKey(projectId), JSON.stringify(request));
export function readResearchRequest(projectId: string): ResearchRequestDraft | null {
  try {
    const parsed = JSON.parse(read(researchKey(projectId)) || "null") as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { topic, links } = parsed as Record<string, unknown>;
    if (typeof topic !== "string") return null;
    return { topic, links: Array.isArray(links) ? links.filter((l): l is string => typeof l === "string") : [] };
  } catch {
    return null;
  }
}
export const clearResearchRequest = (projectId: string) => clear(researchKey(projectId));

/** A message the editor sends once on arrival: the person pressed "Confirm and create design" (#253). */
export const handOffDesignStart = (projectId: string, message: string) => put(designStartKey(projectId), message);
export const readDesignStart = (projectId: string) => read(designStartKey(projectId));
export const clearDesignStart = (projectId: string) => clear(designStartKey(projectId));
