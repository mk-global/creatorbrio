/**
 * Who is calling the Production API, decided by the server from a credential,
 * never from the request body (WS1 #120).
 *
 * - **Human**: the request carries the local human key in the
 *   `X-CreatorBrio-Human-Key` header. The key is 32 random bytes kept in
 *   `data/video-studio.key`, created with owner-only permissions on first use.
 *   It is never served over HTTP, so a web page, another site, or a process
 *   that can only reach the loopback port cannot obtain it.
 * - **Agent**: the request carries `Authorization: Bearer <run token>`. A run
 *   token is minted when a person begins an agent run, is bound to that one
 *   production and run, and is held only as a hash in this process's memory.
 *   It ends with the run and with the server process, so a restarted server
 *   never honours a token from before the restart.
 * - **Human, through a paired browser**: the request carries the session
 *   cookie set by `POST /api/video/session` after a person redeemed a pairing
 *   code from `npm run studio:pair` (see `sessions.ts`). Because a cookie is
 *   sent automatically, a cookie request must also carry the
 *   `X-CreatorBrio-Request: studio` header (which a cross-origin page cannot
 *   send without a preflight this server never approves), must not be marked
 *   by the browser as anything but same-origin, and, when it changes state,
 *   must carry this app's exact `Origin`.
 *   One narrow exception, for media elements, which cannot add a header: a
 *   GET or HEAD of media bytes (proxy, poster, peaks; the routes opt in with
 *   `mediaRead`) may omit `X-CreatorBrio-Request` when the browser itself
 *   marks it `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Dest` video, audio
 *   or image. Here the fetch metadata is required, not merely "not foreign":
 *   a page on another localhost port is same-site, so its `SameSite=Strict`
 *   cookie would be sent, and only `same-origin` tells the two apart. Such a
 *   request can only read preview bytes; it changes nothing.
 * - **Anonymous**: no credential. Refused everywhere.
 *
 * Any `by`, `actor`, `role`, `userId`, `runId` or approval field in a body is
 * refused, not interpreted: the actor and the run come from the credential.
 *
 * Limits: a process running as the same operating-system user with a shell
 * can read the key file, as it can read and edit `data/` directly. The
 * specification gives video agents MCP tools only, with no shell and no
 * access to `data/` (spec 06 §9), and the key is what separates them, and
 * every other caller, from a person.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { resolveAppOrigin } from "@/lib/request-origin";
import { sessionTokenFrom, STUDIO_REQUEST_HEADER, StudioSessions } from "./sessions";

export const HUMAN_KEY_HEADER = "x-creatorbrio-human-key";
const KEY_PATTERN = /^[0-9a-f]{64}$/;

export type Authority =
  | { kind: "anonymous" }
  | { kind: "human" }
  | { kind: "agent"; productionId: string; runId: string };

export type AuthorityResult =
  | { ok: true; authority: Authority }
  | { ok: false; code: "invalid_credential" | "ambiguous_credential"; message: string }
  /** A session cookie on a request that could have been made by another site: 403, not 401. */
  | { ok: false; code: "session_request_refused"; message: string };

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MEDIA_DESTINATIONS = new Set(["video", "audio", "image"]);

export interface ResolveOptions {
  /** The route serves media bytes and accepts the media-element exception described above. */
  mediaRead?: boolean;
}

interface Grant {
  productionId: string;
  runId: string;
}

const hash = (token: string) => createHash("sha256").update(token, "utf-8").digest();

function sameSecret(given: string, expected: string): boolean {
  const a = hash(given);
  const b = hash(expected);
  return timingSafeEqual(a, b);
}

export class AuthorityRegistry {
  private readonly keyFile: string;
  private key: string | null = null;
  /** Run tokens by the hex of their SHA-256; the tokens themselves are not kept. */
  private readonly grants = new Map<string, Grant>();

  readonly sessions: StudioSessions;

  constructor(keyFile: string, sessionDir: string = path.join(/*turbopackIgnore: true*/ path.dirname(keyFile), "video-auth")) {
    this.keyFile = keyFile;
    this.sessions = new StudioSessions(sessionDir);
  }

  /** Reads the human key, creating it with owner-only permissions if it does not exist. */
  async humanKey(): Promise<string> {
    if (this.key) return this.key;
    await mkdir(path.dirname(this.keyFile), { recursive: true });
    try {
      const handle = await open(this.keyFile, "wx", 0o600);
      try {
        await handle.writeFile(randomBytes(32).toString("hex"), "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const key = (await readFile(this.keyFile, "utf-8")).trim();
    if (!KEY_PATTERN.test(key)) throw new Error("the human key file is not a valid key; delete it to create a new one");
    this.key = key;
    return key;
  }

  /** Mints a token for one agent run on one production. It is returned once and stored only as a hash. */
  mintRunToken(productionId: string, runId: string): string {
    const token = `cbrun_${randomBytes(32).toString("hex")}`;
    this.grants.set(hash(token).toString("hex"), { productionId, runId });
    return token;
  }

  /** Revokes every token for a run, when the run ends or is taken over. */
  revokeRun(productionId: string, runId: string): void {
    for (const [digest, grant] of this.grants) {
      if (grant.productionId === productionId && grant.runId === runId) this.grants.delete(digest);
    }
  }

  async resolve(request: Request, options: ResolveOptions = {}): Promise<AuthorityResult> {
    const humanHeader = request.headers.get(HUMAN_KEY_HEADER);
    const authorization = request.headers.get("authorization");
    const cookie = sessionTokenFrom(request);
    if ([humanHeader, authorization, cookie].filter((c) => c !== null).length > 1) {
      return { ok: false, code: "ambiguous_credential", message: "send one credential: the human key, a run token or a session" };
    }
    if (cookie !== null) return this.resolveSession(request, cookie, options);
    if (humanHeader !== null) {
      const key = await this.humanKey();
      return sameSecret(humanHeader.trim(), key) ? { ok: true, authority: { kind: "human" } } : invalid();
    }
    if (authorization !== null) {
      const match = /^Bearer (cbrun_[0-9a-f]{64})$/.exec(authorization.trim());
      const grant = match && this.grants.get(hash(match[1]).toString("hex"));
      return grant ? { ok: true, authority: { kind: "agent", productionId: grant.productionId, runId: grant.runId } } : invalid();
    }
    return { ok: true, authority: { kind: "anonymous" } };
  }

  /** A paired browser's session, accepted only from this app's own pages. */
  private async resolveSession(request: Request, cookie: string, options: ResolveOptions): Promise<AuthorityResult> {
    const refused = (message: string): AuthorityResult => ({ ok: false, code: "session_request_refused", message });
    const fetchSite = request.headers.get("sec-fetch-site");
    if (request.headers.get(STUDIO_REQUEST_HEADER) !== "studio" && !isMediaElementRead(request, options)) {
      return refused("session requests must carry X-CreatorBrio-Request: studio");
    }
    if (fetchSite !== null && fetchSite !== "same-origin") return refused("session requests must come from this app's own pages");
    if (STATE_CHANGING.has(request.method.toUpperCase()) && request.headers.get("origin") !== resolveAppOrigin(request)) {
      return refused("session requests that change state must carry this app's Origin");
    }
    if (cookie === "duplicate") return invalid();
    const verified = await this.sessions.verify(cookie);
    return verified.ok ? { ok: true, authority: { kind: "human" } } : invalid();
  }
}

/** A media element on this app's own page reading media bytes. */
function isMediaElementRead(request: Request, options: ResolveOptions): boolean {
  const method = request.method.toUpperCase();
  return (
    options.mediaRead === true &&
    (method === "GET" || method === "HEAD") &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    MEDIA_DESTINATIONS.has(request.headers.get("sec-fetch-dest") ?? "")
  );
}

function invalid(): AuthorityResult {
  return { ok: false, code: "invalid_credential", message: "the credential is not valid" };
}
