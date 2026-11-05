/**
 * `/api/video/session`: pairing a browser, checking its session, signing out
 * (WS1 #122). See `sessions.ts` for the design.
 *
 * - `POST` redeems a pairing code from `npm run studio:pair` and sets the
 *   session cookie. It is accepted only from this app's own page: loopback
 *   Host, this app's exact `Origin` (present, not just "not foreign"), the
 *   `X-CreatorBrio-Request: studio` header and same-origin fetch metadata.
 *   The response body never contains the session token.
 * - `GET` reports whether the browser's session is valid, and until when.
 * - `DELETE` ends the session and clears the cookie.
 */

import { checkApiRequest } from "@/lib/request-guard";
import { resolveAppOrigin } from "@/lib/request-origin";
import { apiContext } from "./handlers";
import { HUMAN_KEY_HEADER } from "./authority";
import { errorResponse, HttpFailure, okResponse, readJsonObject, selectFields } from "./http";
import { sessionCookie, sessionTokenFrom, STUDIO_REQUEST_HEADER } from "./sessions";

const refused = (message: string) => new HttpFailure(errorResponse(403, { code: "request_refused", message }));

/** The checks a cookie-carrying browser request must pass before anything else. */
function browserRequest(request: Request, requireOrigin: boolean): void {
  if (checkApiRequest(request) !== "allow") throw refused("Request refused");
  if (request.headers.get(STUDIO_REQUEST_HEADER) !== "studio") throw refused("send X-CreatorBrio-Request: studio from the Studio page");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") throw refused("requests must come from this app's own pages");
  if (requireOrigin && request.headers.get("origin") !== resolveAppOrigin(request)) throw refused("requests must carry this app's Origin");
}

async function guarded(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpFailure) return error.response;
    console.error("[video api] session error", { name: (error as Error)?.name });
    return errorResponse(500, { code: "internal_error", message: "the request could not be completed" });
  }
}

export function pairSession(request: Request): Promise<Response> {
  return guarded(async () => {
    browserRequest(request, true);
    if (request.headers.get(HUMAN_KEY_HEADER) !== null || request.headers.get("authorization") !== null) {
      return errorResponse(400, { code: "ambiguous_credential", message: "pairing takes only a pairing code" });
    }
    const { code } = selectFields(await readJsonObject(request), ["code"]);
    const sessions = apiContext().authority.sessions;
    const result = await sessions.redeem(code);
    if (!result.ok) {
      if (result.code === "rate_limited") {
        return errorResponse(429, { code: "rate_limited", message: result.message }, { "retry-after": String(result.retryAfterSeconds) });
      }
      return errorResponse(401, { code: "invalid_pairing_code", message: result.message });
    }
    // A browser pairing again replaces its previous session.
    const previous = sessionTokenFrom(request);
    if (typeof previous === "string" && previous !== "duplicate") await sessions.revoke(previous);
    const response = okResponse({ status: "paired", expiresAt: result.expiresAt }, 201);
    response.headers.append("set-cookie", sessionCookie(request, result.token, result.expiresAt));
    return response;
  });
}

export function sessionStatus(request: Request): Promise<Response> {
  return guarded(async () => {
    browserRequest(request, false);
    const token = sessionTokenFrom(request);
    const verified = typeof token === "string" && token !== "duplicate" ? await apiContext().authority.sessions.verify(token) : { ok: false as const };
    if (!verified.ok) return errorResponse(401, { code: "not_paired", message: "this browser has no valid Studio session; pair it with npm run studio:pair" });
    return okResponse({ authenticated: true, expiresAt: verified.expiresAt });
  });
}

/** Signs out: the session is deleted on the server, so a copied cookie stops working too. */
export function endSession(request: Request): Promise<Response> {
  return guarded(async () => {
    browserRequest(request, true);
    const token = sessionTokenFrom(request);
    if (typeof token === "string" && token !== "duplicate") await apiContext().authority.sessions.revoke(token);
    const response = okResponse({ status: "signed_out" });
    response.headers.append("set-cookie", sessionCookie(request, null));
    return response;
  });
}
