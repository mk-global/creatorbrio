/**
 * The agent-only API listener (#226, AD-46).
 *
 * A second HTTP server on its own loopback port, the only address the
 * contained Design Agent's sandbox lets it reach. It serves exactly the six
 * operations a design run needs, on exactly one carousel: the one its
 * run-scoped token was issued for.
 *
 * It authorizes and forwards; it implements nothing. A request that passes
 * every check is rebuilt (method, path and, for writes, a JSON body with only
 * a content type) and sent to the app's own route on its loopback origin, so a
 * slide written through the listener goes through the same handler, locking,
 * validation and generation tracking as any other, with the same result.
 *
 * Refused, before any forwarding: a request carrying an `Origin` or browser
 * fetch metadata, an unexpected `Host`, a path or method outside the six
 * operations, a query string or encoded path, a missing, unknown or expired
 * token, and any carousel but the token's own.
 *
 * The token reaches the agent only as an environment variable of its process,
 * is held here only as a hash, and stops working when its run ends. Nothing
 * here logs it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { isLoopbackHost } from "@/lib/request-guard";

export interface AgentGrant {
  carouselId: string;
  /** The app's own loopback origin the listener forwards to, from the chat request. */
  appOrigin: string;
  expiresAt: number;
}

interface ListenerState {
  port: number | null;
  starting: Promise<number> | null;
  servers: http.Server[];
  grants: Map<string, AgentGrant>;
}

const STATE_KEY = Symbol.for("creatorbrio.agentListener");

/** One listener and one grant table per server process, whichever bundle imports this module. */
function state(): ListenerState {
  const g = globalThis as unknown as Record<symbol, ListenerState | undefined>;
  return (g[STATE_KEY] ??= { port: null, starting: null, servers: [], grants: new Map() });
}

export const MAX_AGENT_BODY_BYTES = 4 * 1024 * 1024;
const FORWARD_TIMEOUT_MS = 30_000;

const hashToken = (token: string) => createHash("sha256").update(token).digest();

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SLIDE_ID = "[A-Za-z0-9_-]{1,64}";

/** The served operations: method, path shape and whether it carries a JSON body. */
const OPERATIONS: { method: string; pattern: RegExp; body: boolean }[] = [
  { method: "GET", pattern: new RegExp(`^/api/carousels/(${UUID})$`), body: false },
  { method: "POST", pattern: new RegExp(`^/api/carousels/(${UUID})/slides$`), body: true },
  { method: "PUT", pattern: new RegExp(`^/api/carousels/(${UUID})/slides$`), body: true },
  { method: "PUT", pattern: new RegExp(`^/api/carousels/(${UUID})/slides/${SLIDE_ID}$`), body: true },
  { method: "DELETE", pattern: new RegExp(`^/api/carousels/(${UUID})/slides/${SLIDE_ID}$`), body: false },
  { method: "PUT", pattern: new RegExp(`^/api/carousels/(${UUID})/caption$`), body: true },
];

export type AgentRefusal =
  | "browser_request"
  | "host_refused"
  | "operation_not_served"
  | "token_refused"
  | "carousel_refused"
  | "body_refused"
  | "forward_failed";

const REFUSAL_STATUS: Record<AgentRefusal, number> = {
  browser_request: 403,
  host_refused: 403,
  operation_not_served: 404,
  token_refused: 401,
  carousel_refused: 403,
  body_refused: 400,
  forward_failed: 502,
};

export interface AgentRequest {
  method: string;
  /** The request target as received, path and query. */
  target: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface AgentResponse {
  status: number;
  body: string;
  refusal?: AgentRefusal;
}

function header(headers: AgentRequest["headers"], name: string): string | null {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function refuse(refusal: AgentRefusal, context: Record<string, unknown> = {}): AgentResponse {
  // An expected refusal: the code and shape only, never the token or the body.
  console.warn("[agent-listener] request refused", { refusal, ...context });
  return { status: REFUSAL_STATUS[refusal], body: JSON.stringify({ error: refusal }), refusal };
}

function grantFor(authorization: string | null): AgentGrant | null {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const presented = hashToken(match[1]);
  const grants = state().grants;
  for (const [key, grant] of grants) {
    const stored = Buffer.from(key, "hex");
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      if (Date.now() >= grant.expiresAt) {
        grants.delete(key);
        return null;
      }
      return grant;
    }
  }
  return null;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Decides and, when allowed, forwards one request. Exported for tests; the server calls it. */
export async function handleAgentRequest(request: AgentRequest, port: number): Promise<AgentResponse> {
  const method = request.method.toUpperCase();
  if (header(request.headers, "origin") !== null || Object.keys(request.headers).some((h) => h.toLowerCase().startsWith("sec-fetch-"))) {
    return refuse("browser_request", { method });
  }
  const host = header(request.headers, "host");
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}` && host !== `[::1]:${port}`) {
    return refuse("host_refused", { method });
  }
  // Only a plain path: no query, fragment, encoding or dot segments.
  const target = request.target;
  if (!/^\/[A-Za-z0-9/_-]*$/.test(target) || target.includes("//")) {
    return refuse("operation_not_served", { method });
  }
  const operation = OPERATIONS.find((op) => op.method === method && op.pattern.test(target));
  if (!operation) return refuse("operation_not_served", { method });

  const grant = grantFor(header(request.headers, "authorization"));
  if (!grant) return refuse("token_refused", { method });
  const carouselId = operation.pattern.exec(target)![1];
  if (carouselId !== grant.carouselId) return refuse("carousel_refused", { method, carouselId: grant.carouselId });

  let body: string | undefined;
  if (operation.body) {
    // Like the main routes, the body must be JSON whatever type it declares: a
    // call copied without its content-type header still works.
    if (request.body.length > MAX_AGENT_BODY_BYTES || !isJson(request.body.toString("utf8"))) {
      return refuse("body_refused", { method, carouselId });
    }
    body = request.body.toString("utf8");
  } else if (request.body.length > 0) {
    return refuse("body_refused", { method, carouselId });
  }

  try {
    const response = await fetch(new URL(target, grant.appOrigin), {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.text() };
  } catch (err) {
    console.error("[agent-listener] forwarding failed", { method, carouselId, message: (err as Error)?.message });
    return refuse("forward_failed", { method, carouselId });
  }
}

/**
 * Issues a token for one design run on one carousel. The app origin must be a
 * loopback origin; anything else is refused rather than forwarded to.
 */
export function issueAgentToken(grant: { carouselId: string; appOrigin: string; ttlMs: number }): { token: string; revoke: () => void } {
  let origin: URL;
  try {
    origin = new URL(grant.appOrigin);
  } catch {
    throw new Error("The app origin is not a URL.");
  }
  if (origin.protocol !== "http:" || !isLoopbackHost(origin.host) || origin.pathname !== "/" || origin.search || origin.username || origin.password) {
    throw new Error("The agent listener forwards only to the app's loopback origin.");
  }
  const token = randomBytes(32).toString("base64url");
  const key = hashToken(token).toString("hex");
  state().grants.set(key, { carouselId: grant.carouselId, appOrigin: origin.origin, expiresAt: Date.now() + grant.ttlMs });
  return { token, revoke: () => void state().grants.delete(key) };
}

/** Whether a token issued here is still live; for tests and the run's own bookkeeping. */
export function liveGrantCount(): number {
  const now = Date.now();
  let n = 0;
  for (const grant of state().grants.values()) if (grant.expiresAt > now) n++;
  return n;
}

/**
 * The request's body, or null when it passes the cap. An oversized body is
 * read to its end and discarded, never kept, before the refusal is sent:
 * closing a connection with unread data resets it, and the reset would lose the
 * refusal. The server's request timeout bounds a client that never stops.
 */
function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"]);
  let oversized = Number.isFinite(declared) && declared > MAX_AGENT_BODY_BYTES;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_AGENT_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(oversized ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

function serve(port: () => number) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const body = await readBody(req);
    const result = body === null
      ? refuse("body_refused", { method: req.method })
      : await handleAgentRequest({ method: req.method ?? "", target: req.url ?? "", headers: req.headers, body }, port());
    res.writeHead(result.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(body === null ? { connection: "close" } : {}),
    });
    res.end(result.body);
  };
}

function listenOn(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      // A later failure, such as running out of file descriptors, is reported
      // rather than left uncaught, where it would stop the app.
      server.on("error", (err: NodeJS.ErrnoException) => {
        console.error("[agent-listener] server error", { host, code: err.code ?? null });
      });
      resolve((server.address() as { port: number }).port);
    });
  });
}

/**
 * The listener's port, starting it on first use. It listens on 127.0.0.1 and,
 * where available, on ::1 with the same port, because the sandbox's proxy
 * resolves `localhost` itself (as the #220 proof's stand-in did).
 */
export function agentListenerPort(): Promise<number> {
  const s = state();
  if (s.port !== null) return Promise.resolve(s.port);
  s.starting ??= (async () => {
    const handler = serve(() => s.port ?? 0);
    const v4 = http.createServer(handler);
    v4.requestTimeout = FORWARD_TIMEOUT_MS * 2;
    v4.unref();
    const port = await listenOn(v4, 0, "127.0.0.1");
    s.servers.push(v4);
    const v6 = http.createServer(handler);
    v6.requestTimeout = FORWARD_TIMEOUT_MS * 2;
    v6.unref();
    try {
      await listenOn(v6, port, "::1");
      s.servers.push(v6);
    } catch (err) {
      // Only a machine without IPv6 loopback may go without it: there,
      // localhost reaches the IPv4 listener. Any other failure, such as
      // another program holding the port on ::1, would let localhost reach
      // that program instead, with the agent's token, so it stops the start.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") {
        await new Promise<void>((resolve) => v4.close(() => resolve()));
        s.servers.length = 0;
        throw new Error(`The agent listener could not take its port on the IPv6 loopback (${code ?? "unknown error"}).`);
      }
    }
    s.port = port;
    console.info("[agent-listener] listening", { port, ipv6: s.servers.length > 1 });
    return port;
  })().finally(() => {
    s.starting = null;
  });
  return s.starting;
}

/** Stops the listener and forgets every grant; for tests. */
export async function stopAgentListener(): Promise<void> {
  const s = state();
  await Promise.all(s.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  s.servers = [];
  s.port = null;
  s.grants.clear();
}
