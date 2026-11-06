/**
 * A `fetch` for the Studio client that dispatches to the real Video Studio
 * route modules in-process (#150), as a paired browser on this app's own
 * page would reach them: loopback Host, this app's Origin on writes and
 * `Sec-Fetch-Site: same-origin`, with the session cookie. Tests of the page's
 * state logic then see the server's real answers, not a model of them.
 */
type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Module = Record<string, Handler | undefined>;

export const STUDIO_ORIGIN = "http://127.0.0.1:3000";

interface Route {
  pattern: RegExp;
  names: string[];
  load: () => Promise<unknown>;
}

const routes: Route[] = [
  { pattern: /^\/api\/video\/session$/, names: [], load: () => import("@/app/api/video/session/route") },
  { pattern: /^\/api\/video\/productions$/, names: [], load: () => import("@/app/api/video/productions/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)$/, names: ["id"], load: () => import("@/app/api/video/productions/[id]/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)\/preview$/, names: ["id"], load: () => import("@/app/api/video/productions/[id]/preview/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)\/changes$/, names: ["id"], load: () => import("@/app/api/video/productions/[id]/changes/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)\/undo$/, names: ["id"], load: () => import("@/app/api/video/productions/[id]/undo/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)\/redo$/, names: ["id"], load: () => import("@/app/api/video/productions/[id]/redo/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)\/renders$/, names: ["id"], load: () => import("@/app/api/video/productions/[id]/renders/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)\/renders\/([^/]+)$/, names: ["id", "renderId"], load: () => import("@/app/api/video/productions/[id]/renders/[renderId]/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)\/renders\/([^/]+)\/cancel$/, names: ["id", "renderId"], load: () => import("@/app/api/video/productions/[id]/renders/[renderId]/cancel/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)\/renders\/([^/]+)\/retry$/, names: ["id", "renderId"], load: () => import("@/app/api/video/productions/[id]/renders/[renderId]/retry/route") },
  { pattern: /^\/api\/video\/productions\/([^/]+)\/renders\/([^/]+)\/files\/([^/]+)$/, names: ["id", "renderId", "name"], load: () => import("@/app/api/video/productions/[id]/renders/[renderId]/files/[name]/route") },
  { pattern: /^\/api\/video\/media$/, names: [], load: () => import("@/app/api/video/media/route") },
  { pattern: /^\/api\/video\/media\/([^/]+)$/, names: ["id"], load: () => import("@/app/api/video/media/[id]/route") },
  { pattern: /^\/api\/video\/media\/([^/]+)\/proxy$/, names: ["id"], load: () => import("@/app/api/video/media/[id]/proxy/route") },
];

/** A fetch that answers from the route modules; `cookie()` supplies the current session cookie, if any. */
export function routeFetch(cookie: () => string | null) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, STUDIO_ORIGIN);
    const route = routes.find((r) => r.pattern.test(url.pathname));
    if (!route) return new Response("not found", { status: 404 });
    const match = route.pattern.exec(url.pathname)!;
    const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
    const method = (init.method ?? "GET").toUpperCase();
    const handler = ((await route.load()) as Module)[method];
    if (!handler) return new Response(null, { status: 405 });
    const headers = new Headers(init.headers);
    headers.set("host", "127.0.0.1:3000");
    headers.set("sec-fetch-site", "same-origin");
    if (method !== "GET" && method !== "HEAD") headers.set("origin", STUDIO_ORIGIN);
    const value = cookie();
    if (value) headers.set("cookie", value);
    return handler(new Request(url, { method, headers, body: init.body }), { params: Promise.resolve(params) });
  };
}
