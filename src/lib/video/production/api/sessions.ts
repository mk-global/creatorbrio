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
 * pairing/<sha256(code)>.json                { v: 1, createdAt, expiresAt }   written by the script
 * claimed/<sha256(code)>.<nonce>.json        a redeemed code's record, moved here by the server
 * claimed/<sha256(code)>.won                 empty marker held by the one redeemer that won
 * sessions/<sha256(token)>.json              { v: 1, createdAt, expiresAt }   written by the server
 * ```
 *
 * Only hashes are stored, so reading the directory reveals no usable code or
 * token. Sessions are checked against their file on every request, so
 * revoking one takes effect immediately in every process, and a session
 * survives a server restart until it expires.
 *
 * A code works once, even under concurrent attempts in any number of
 * processes and across restarts. Deleting the record is not a claim: on
 * macOS 27.2 (APFS), concurrent `unlink` calls on one file were seen to
 * report success to several callers (#122). Redemption therefore takes three
 * steps, each of which alone refuses a second redeemer:
 *
 * 1. `rename` the record out of `pairing/` to a name unique to this attempt.
 *    Only one rename of a path succeeds, and afterwards the code no longer
 *    exists where redemption looks for it, so nothing (a crash, a restart or
 *    cleanup) can make it redeemable again.
 * 2. Create `claimed/<hash>.won` exclusively (`wx`). Exactly one caller can
 *    create it. This does not rely on step 1 being exclusive.
 * 3. Read the moved record and check it has not expired.
 *
 * A crash after any step leaves the code used and creates no session. Files
 * left in `claimed/` are removed once older than `CLAIM_RETENTION_MS`, a
 * bounded number after each successful redemption; removing them cannot
 * revive a code, since redemption only ever looks in `pairing/`.
 *
 * The format is shared with `scripts/studio-pair.mjs`, which has no access
 * to this TypeScript; a test pairs through the real script.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
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
/** How long files in `claimed/` are kept; well past any code's lifetime and any concurrent redeemer. */
export const CLAIM_RETENTION_MS = 2 * PAIRING_TTL_MS;
/** Cleanup of `claimed/` after a successful redemption removes at most this many files... */
export const CLAIM_CLEANUP_BATCH = 32;
/** ...and inspects at most this many, from a random starting point, so its cost stays bounded. */
export const CLAIM_CLEANUP_SCAN = 128;

/** Crockford base32 without I, L, O and U: 20 characters carry 100 bits. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{20}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_FILE = /^[0-9a-f]{64}\.json$/;
const CLAIMED_FILE = /^[0-9a-f]{64}\.(?:[0-9a-f]{16}\.json|won)$/;

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
  private claimedDir = () => path.join(/*turbopackIgnore: true*/ this.dir, "claimed");
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
    if (claimed === null) {
      this.failures.push(now);
      if (++this.failuresSinceSuccess >= FAILURES_BEFORE_CANCEL) {
        await this.cancelPendingCodes();
        this.failuresSinceSuccess = 0;
      }
      return { ok: false, code: "invalid_code", message: "the pairing code is not valid; it may be mistyped, expired or already used" };
    }
    this.failuresSinceSuccess = 0;
    await this.removeOldClaims(claimed);
    return this.createSession();
  }

  /**
   * Claims a code (see the file header). Returns the code's hash only for the
   * one caller that moved the record, created the winner marker and found the
   * code unexpired, and null otherwise. Any failure leaves the code
   * unredeemable.
   */
  private async claim(input: unknown): Promise<string | null> {
    const code = normaliseCode(input);
    if (!code) return null;
    const hash = sha256(code);
    const claimedDir = this.claimedDir();
    await mkdir(claimedDir, { recursive: true, mode: 0o700 });
    const moved = path.join(/*turbopackIgnore: true*/ claimedDir, `${hash}.${randomBytes(8).toString("hex")}.json`);
    try {
      await rename(path.join(/*turbopackIgnore: true*/ this.pairingDir(), `${hash}.json`), moved);
    } catch {
      return null; // no such code, or another redeemer moved it first
    }
    try {
      await (await open(path.join(/*turbopackIgnore: true*/ claimedDir, `${hash}.won`), "wx", 0o600)).close();
    } catch {
      return null; // another redeemer holds the marker
    }
    const record = parseRecord(await readFile(moved, "utf-8").catch(() => ""));
    await unlink(moved).catch(() => undefined);
    return record !== null && Date.parse(record.expiresAt) > this.now() ? hash : null;
  }

  /**
   * Removes files from `claimed/` that are older than `CLAIM_RETENTION_MS`:
   * winner markers, and records left by a crash between the rename and their
   * removal. It runs only after a successful redemption, which needs a code
   * from the operator's terminal, so no caller can make it run more often,
   * and each run inspects at most `CLAIM_CLEANUP_SCAN` files and removes at
   * most `CLAIM_CLEANUP_BATCH`. Starting at a random point means every file
   * is reached eventually. It never touches `pairing/`, so it cannot make a
   * code redeemable again, and it keeps the files of the code just claimed
   * (`keep`), so a clock jump cannot release a marker its winner still needs.
   */
  private async removeOldClaims(keep: string): Promise<void> {
    const dir = this.claimedDir();
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => CLAIMED_FILE.test(n) && !n.startsWith(`${keep}.`));
    const start = names.length ? randomBytes(4).readUInt32BE() % names.length : 0;
    let removed = 0;
    for (let i = 0; i < Math.min(names.length, CLAIM_CLEANUP_SCAN) && removed < CLAIM_CLEANUP_BATCH; i++) {
      const file = path.join(/*turbopackIgnore: true*/ dir, names[(start + i) % names.length]);
      const info = await stat(file).catch(() => null);
      if (info && this.now() - info.mtimeMs > CLAIM_RETENTION_MS) {
        await unlink(file).catch(() => undefined);
        removed++;
      }
    }
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
    for (const name of (await readdir(dir).catch(() => [] as string[])).filter((n) => HASH_FILE.test(n))) {
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

const secureSuffix = (request: Request) => (new URL(request.url).protocol === "https:" ? "; Secure" : "");

/**
 * The Set-Cookie value for a new session. `Secure` is set when the app is
 * served over HTTPS. An expiry that is not a valid time gives `Max-Age=0`, so
 * a malformed call clears the cookie rather than setting one without a limit.
 */
export function sessionCookie(request: Request, token: string, expiresAt: string): string {
  const remaining = Date.parse(expiresAt) - Date.now();
  const maxAge = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining / 1000)) : 0;
  return `${SESSION_COOKIE}=${token}; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureSuffix(request)}`;
}

/** The Set-Cookie value that clears the session cookie. */
export function clearedSessionCookie(request: Request): string {
  return `${SESSION_COOKIE}=; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0${secureSuffix(request)}`;
}
