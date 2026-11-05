/**
 * Browser pairing and human sessions for the Production API (WS1 #122).
 *
 * A person pairs a browser in two steps:
 *
 * 1. In a terminal, as the account that owns the checkout, they run
 *    `npm run studio:pair`. The script writes a short-lived, single-use
 *    pairing challenge to `data/video-auth/pairing/` and prints the code to
 *    that terminal only. No HTTP endpoint, page or agent tool can reveal it.
 * 2. In the Studio page they enter the code. `POST /api/video/session`
 *    redeems it and sets an opaque session in an HttpOnly, SameSite=Strict
 *    cookie scoped to `/api/video`. Page JavaScript never sees the session
 *    token, the code's stored form or the human key.
 *
 * On disk (`data/video-auth/`, owner-only):
 *
 * ```text
 * pairing/<sha256(code)>.json      { v: 1, createdAt, expiresAt }   written by the script
 * sessions/<sha256(token)>.json    { v: 1, createdAt, expiresAt }   written by the server
 * ```
 *
 * Only hashes are stored, so reading the directory reveals no usable code or
 * token. Redeeming a code deletes its file first: `unlink` succeeds for
 * exactly one caller, in any process, so a code works once even under
 * concurrent attempts and across restarts. Sessions are checked against
 * their file on every request, so revoking one takes effect immediately in
 * every process, and a session survives a server restart until it expires.
 *
 * The format is shared with `scripts/studio-pair.mjs`, which has no access
 * to this TypeScript; a test pairs through the real script.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export const SESSION_COOKIE = "cb_studio_session";
export const SESSION_COOKIE_PATH = "/api/video";
/** Every cookie-authenticated request must carry this header with the value `studio`. */
export const STUDIO_REQUEST_HEADER = "x-creatorbrio-request";

export const PAIRING_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const MAX_SESSIONS = 16;
/** Failed redemptions allowed per minute before further attempts are refused. */
export const MAX_FAILURES_PER_MINUTE = 5;
/** Failed redemptions after which every pending code is cancelled. */
export const FAILURES_BEFORE_CANCEL = 10;

/** Crockford base32 without I, L, O and U: 20 characters carry 100 bits. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{20}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_FILE = /^[0-9a-f]{64}\.json$/;

export const sha256 = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");

/** Accepts the code as printed (groups separated by dashes) or typed loosely; returns null for anything else. */
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  // Crockford base32 reads O as 0 and I or L as 1, so a misread character still works.
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE_PATTERN.test(code) ? code : null;
}

/** Generates a code in the format the pairing script prints. Used by tests; the script has its own copy. */
export function generateCode(): string {
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
}

interface Record_ {
  v: 1;
  createdAt: string;
  expiresAt: string;
}

function parseRecord(raw: string): Record_ | null {
  try {
    const r = JSON.parse(raw);
    if (r && r.v === 1 && typeof r.createdAt === "string" && typeof r.expiresAt === "string" && Number.isFinite(Date.parse(r.expiresAt))) return r;
  } catch {
    /* fall through */
  }
  return null;
}

async function writeOwnerOnly(file: string, data: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(data, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type RedeemResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; code: "invalid_code"; message: string }
  | { ok: false; code: "rate_limited"; message: string; retryAfterSeconds: number };

export interface SessionOptions {
  now?: () => number;
}

export class StudioSessions {
  readonly dir: string;
  private readonly now: () => number;
  private failures: number[] = [];
  private failuresSinceSuccess = 0;

  constructor(dir: string, options: SessionOptions = {}) {
    this.dir = dir;
    this.now = options.now ?? Date.now;
  }

  private pairingDir = () => path.join(/*turbopackIgnore: true*/ this.dir, "pairing");
  private sessionDir = () => path.join(/*turbopackIgnore: true*/ this.dir, "sessions");

  /**
   * Redeems a pairing code for a new session. Every failure counts towards
   * the rate limit; after `FAILURES_BEFORE_CANCEL` failures every pending
   * code is cancelled, so guessing gains nothing even across restarts.
   */
  async redeem(input: unknown): Promise<RedeemResult> {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
    if (this.failures.length >= MAX_FAILURES_PER_MINUTE) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.failures[0] + 60_000 - now) / 1000));
      return { ok: false, code: "rate_limited", message: "too many failed pairing attempts; wait and try again", retryAfterSeconds };
    }

    const claimed = await this.claim(input);
    if (!claimed) {
      this.failures.push(now);
      if (++this.failuresSinceSuccess >= FAILURES_BEFORE_CANCEL) {
        await this.cancelPendingCodes();
        this.failuresSinceSuccess = 0;
      }
      return { ok: false, code: "invalid_code", message: "the pairing code is not valid; it may be mistyped, expired or already used" };
    }
    this.failuresSinceSuccess = 0;
    return this.createSession();
  }

  /** Claims a code by deleting its record. Returns true only for the one caller whose delete succeeded on an unexpired code. */
  private async claim(input: unknown): Promise<boolean> {
    const code = normaliseCode(input);
    if (!code) return false;
    const file = path.join(/*turbopackIgnore: true*/ this.pairingDir(), `${sha256(code)}.json`);
    let record: Record_ | null;
    try {
      record = parseRecord(await readFile(file, "utf-8"));
    } catch {
      return false;
    }
    try {
      await unlink(file);
    } catch {
      return false; // another redeemer won
    }
    return record !== null && Date.parse(record.expiresAt) > this.now();
  }

  private async createSession(): Promise<RedeemResult> {
    const dir = this.sessionDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + SESSION_TTL_MS).toISOString();
    await writeOwnerOnly(path.join(/*turbopackIgnore: true*/ dir, `${sha256(token)}.json`), JSON.stringify({ v: 1, createdAt, expiresAt }));
    await this.prune();
    return { ok: true, token, expiresAt };
  }

  /** Removes expired sessions and, beyond `MAX_SESSIONS`, the oldest ones. */
  private async prune(): Promise<void> {
    const dir = this.sessionDir();
    const live: { file: string; createdAt: number }[] = [];
    for (const name of (await readdir(dir)).filter((n) => HASH_FILE.test(n))) {
      const file = path.join(/*turbopackIgnore: true*/ dir, name);
      const record = parseRecord(await readFile(file, "utf-8").catch(() => ""));
      if (!record || Date.parse(record.expiresAt) <= this.now()) await unlink(file).catch(() => undefined);
      else live.push({ file, createdAt: Date.parse(record.createdAt) });
    }
    live.sort((a, b) => b.createdAt - a.createdAt);
    for (const old of live.slice(MAX_SESSIONS)) await unlink(old.file).catch(() => undefined);
  }

  /** Checks a session token against its record; an expired one is deleted. */
  async verify(token: string): Promise<{ ok: true; expiresAt: string } | { ok: false }> {
    if (!TOKEN_PATTERN.test(token)) return { ok: false };
    const file = path.join(/*turbopackIgnore: true*/ this.sessionDir(), `${sha256(token)}.json`);
    const record = parseRecord(await readFile(file, "utf-8").catch(() => ""));
    if (!record) return { ok: false };
    if (Date.parse(record.expiresAt) <= this.now()) {
      await unlink(file).catch(() => undefined);
      return { ok: false };
    }
    return { ok: true, expiresAt: record.expiresAt };
  }

  /** Ends one session (sign-out). */
  async revoke(token: string): Promise<void> {
    if (!TOKEN_PATTERN.test(token)) return;
    await unlink(path.join(/*turbopackIgnore: true*/ this.sessionDir(), `${sha256(token)}.json`)).catch(() => undefined);
  }

  private async cancelPendingCodes(): Promise<void> {
    const dir = this.pairingDir();
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      await unlink(path.join(/*turbopackIgnore: true*/ dir, name)).catch(() => undefined);
    }
  }
}

/** Reads the session cookie. A request with the cookie more than once is treated as having none (cookie tossing). */
export function sessionTokenFrom(request: Request): string | null | "duplicate" {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
    .map((part) => part.slice(SESSION_COOKIE.length + 1));
  if (values.length === 0) return null;
  return values.length === 1 ? values[0] : "duplicate";
}

/** The Set-Cookie value for a new session, or for clearing it. `Secure` is set when the app is served over HTTPS. */
export function sessionCookie(request: Request, token: string | null, expiresAt?: string): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  if (token === null) return `${SESSION_COOKIE}=; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt!) - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
