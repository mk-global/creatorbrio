/**
 * Browser pairing and Studio sessions (WS1 #122), through the real pairing
 * script and the real route modules: operator-only codes, single use under
 * races and restarts, expiry, rate limits, HttpOnly cookies carried across
 * independent requests, CSRF and rebinding refusals, revocation, and agents
 * that try to pass as a paired person.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearedSessionCookie, sessionCookie, sha256, StudioSessions } from "@/lib/video/production/api/sessions";
import { registerFixtureMedia } from "./helpers/media-fixtures";
import { footageProduction } from "./helpers/production-fixtures";

const run = promisify(execFile);
const ORIGIN = "http://127.0.0.1:3000";
const SCRIPT = path.resolve(__dirname, "../scripts/studio-pair.mjs");

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
let workdir: string;
let originalCwd: string;
let dataDir: string;
let session: Record<string, Handler>;
let collection: Record<string, Handler>;
let production: Record<string, Handler>;
let changes: Record<string, Handler>;
let undo: Record<string, Handler>;
let humanKey: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-session-")));
  dataDir = path.join(workdir, "data");
  process.chdir(workdir);
  session = (await import("@/app/api/video/session/route")) as unknown as Record<string, Handler>;
  collection = (await import("@/app/api/video/productions/route")) as unknown as Record<string, Handler>;
  production = (await import("@/app/api/video/productions/[id]/route")) as unknown as Record<string, Handler>;
  changes = (await import("@/app/api/video/productions/[id]/changes/route")) as unknown as Record<string, Handler>;
  undo = (await import("@/app/api/video/productions/[id]/undo/route")) as unknown as Record<string, Handler>;
  const { apiContext } = await import("@/lib/video/production/api/handlers");
  humanKey = await apiContext().authority.humanKey();
});

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

/** A server restart: new in-memory state (rate limits, run tokens, store instance), same files. */
function restart() {
  (globalThis as { __creatorbrioProductionApi?: Map<string, unknown> }).__creatorbrioProductionApi?.clear();
}

beforeEach(async () => {
  restart();
  await rm(path.join(dataDir, "video-auth"), { recursive: true, force: true });
  await rm(path.join(dataDir, "video"), { recursive: true, force: true });
  await registerFixtureMedia(dataDir);
});

/** The operator's terminal action: runs the real script and reads the printed code. */
async function mintCode(): Promise<string> {
  const { stdout } = await run(process.execPath, [SCRIPT, "--data-dir", dataDir, "--no-tty-check"]);
  const match = /\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})\b/.exec(stdout);
  if (!match) throw new Error(`no code in: ${stdout}`);
  return match[1];
}

interface Req {
  method?: string;
  body?: unknown;
  cookie?: string;
  origin?: string | null;
  studioHeader?: boolean;
  fetchSite?: string;
  host?: string;
  headers?: Record<string, string>;
}

function request(url: string, r: Req = {}): Request {
  const method = r.method ?? (r.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { host: r.host ?? "127.0.0.1:3000", ...r.headers };
  if (r.studioHeader !== false) headers["x-creatorbrio-request"] = "studio";
  const origin = r.origin === undefined ? (method === "GET" ? null : ORIGIN) : r.origin;
  if (origin) headers.origin = origin;
  if (r.fetchSite) headers["sec-fetch-site"] = r.fetchSite;
  if (r.cookie) headers.cookie = r.cookie;
  let body: string | undefined;
  if (r.body !== undefined) {
    body = JSON.stringify(r.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`${ORIGIN}${url}`, { method, headers, body });
}

async function send(handler: Handler, url: string, r: Req = {}, params: Record<string, string> = {}) {
  const res = await handler(request(url, r), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text, setCookie: res.headers.get("set-cookie") };
}

const pair = (code: unknown, r: Req = {}) => send(session.POST, "/api/video/session", { body: { code }, ...r });

/** Pairs a browser and returns its cookie header value, exactly as the browser would send it back. */
async function pairedCookie(): Promise<string> {
  const res = await pair(await mintCode());
  expect(res.status, res.text).toBe(201);
  return res.setCookie!.split(";")[0];
}

const withSession = (cookie: string, r: Req = {}) => ({ cookie, ...r });
const ID = { id: "prod-footage" };

// ---------------------------------------------------------------------------

describe("the operator mints a code in a terminal; nothing else can reveal it", () => {
  it("stores only a hash, owner-only, and the printed code is not on disk", async () => {
    const code = await mintCode();
    const dir = path.join(dataDir, "video-auth", "pairing");
    const files = await readdir(dir);
    expect(files).toEqual([`${sha256(code.replace(/-/g, ""))}.json`]);
    const raw = await readFile(path.join(dir, files[0]), "utf-8");
    expect(raw).not.toContain(code.replace(/-/g, ""));
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
    if (process.platform !== "win32") {
      expect((await stat(path.join(dir, files[0]))).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(dataDir, "video-auth"))).mode & 0o777).toBe(0o700);
    }
  });

  it("refuses to print a code when its output is not a terminal", async () => {
    const failed = await run(process.execPath, [SCRIPT, "--data-dir", dataDir]).catch((e) => e);
    expect(failed.code).toBe(2);
    expect(failed.stdout).toBe("");
    await expect(readdir(path.join(dataDir, "video-auth", "pairing"))).rejects.toThrow();
  });

  it("exposes no endpoint that issues or lists codes", () => {
    expect(Object.keys(session).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["DELETE", "GET", "POST"]);
  });
});

describe("pairing sets an HttpOnly session and never returns a secret", () => {
  it("sets a strict, path-scoped, HttpOnly cookie; the body carries no token or key", async () => {
    const res = await pair(await mintCode());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "paired", expiresAt: expect.any(String) });
    const cookie = res.setCookie!;
    expect(cookie).toMatch(/^cb_studio_session=[A-Za-z0-9_-]{43}; Path=\/api\/video; HttpOnly; SameSite=Strict; Max-Age=4319\d$/);
    const token = cookie.split(";")[0].split("=")[1];
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain(humanKey);
    // The server keeps only the token's hash.
    expect(await readdir(path.join(dataDir, "video-auth", "sessions"))).toEqual([`${sha256(token)}.json`]);
  });

  it("never sets a cookie without a lifetime, even for a malformed expiry", () => {
    const req = new Request(`${ORIGIN}/api/video/session`);
    expect(sessionCookie(req, "t".repeat(43), "not a time")).toMatch(/; Max-Age=0$/);
    expect(sessionCookie(req, "t".repeat(43), new Date(Date.now() - 1000).toISOString())).toMatch(/; Max-Age=0$/);
    expect(clearedSessionCookie(req)).toBe("cb_studio_session=; Path=/api/video; HttpOnly; SameSite=Strict; Max-Age=0");
  });

  it("marks the cookie Secure when the app is served over HTTPS", async () => {
    const code = await mintCode();
    const req = new Request("https://localhost:3000/api/video/session", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "https://localhost:3000", "x-creatorbrio-request": "studio", "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect((await session.POST(req)).headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("gives the paired browser human authority over the Production API, through the store", async () => {
    const cookie = await pairedCookie();
    const created = await send(collection.POST, "/api/video/productions", withSession(cookie, { body: { production: footageProduction() } }));
    expect(created.status, created.text).toBe(201);
    const edit = await send(changes.POST, "/api/video/productions/prod-footage/changes", withSession(cookie, { body: { baseRevision: 7, summary: "rename", ops: [{ op: "renameProduction", name: "From the browser" }] } }), ID);
    expect(edit.body).toMatchObject({ status: "applied", revision: 8, generation: 2 });
    const read = await send(production.GET, "/api/video/productions/prod-footage", withSession(cookie), ID);
    expect(read.body.production.name).toBe("From the browser");
    // Body forgery is still refused for a session.
    const forged = await send(changes.POST, "/api/video/productions/prod-footage/changes", withSession(cookie, { body: { baseRevision: 8, summary: "x", ops: [], by: "system" } }), ID);
    expect(forged.body.error.code).toBe("server_owned_field");
    expect((await send(session.GET, "/api/video/session", withSession(cookie))).body).toMatchObject({ authenticated: true });
  });
});

describe("codes work once, briefly, and resist guessing", () => {
  it("refuses a replayed code", async () => {
    const code = await mintCode();
    expect((await pair(code)).status).toBe(201);
    const replay = await pair(code);
    expect([replay.status, replay.body.error.code, replay.setCookie]).toEqual([401, "invalid_pairing_code", null]);
  });

  it("lets exactly one of many simultaneous redeemers win, also across separate session stores", async () => {
    const code = await mintCode();
    const results = await Promise.all(Array.from({ length: 8 }, () => pair(code)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);

    const second = await mintCode();
    const dir = path.join(dataDir, "video-auth");
    const stores = Array.from({ length: 6 }, () => new StudioSessions(dir));
    const raced = await Promise.all(stores.map((s) => s.redeem(second)));
    expect(raced.filter((r) => r.ok)).toHaveLength(1);
  });

  it("refuses an expired code and an expired session, and deletes them", async () => {
    const code = await mintCode();
    const pairing = path.join(dataDir, "video-auth", "pairing");
    const [file] = await readdir(pairing);
    const record = JSON.parse(await readFile(path.join(pairing, file), "utf-8"));
    await writeFile(path.join(pairing, file), JSON.stringify({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect((await pair(code)).body.error.code).toBe("invalid_pairing_code");
    expect(await readdir(pairing)).toEqual([]);

    const cookie = await pairedCookie();
    const sessions = path.join(dataDir, "video-auth", "sessions");
    const [sessionFile] = await readdir(sessions);
    const s = JSON.parse(await readFile(path.join(sessions, sessionFile), "utf-8"));
    await writeFile(path.join(sessions, sessionFile), JSON.stringify({ ...s, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect((await send(production.GET, "/api/video/productions/prod-footage", withSession(cookie), ID)).body.error.code).toBe("invalid_credential");
    expect(await readdir(sessions)).toEqual([]);
  });

  it("rate-limits failed attempts, and cancels pending codes after repeated guessing", async () => {
    await mintCode();
    for (let i = 0; i < 5; i++) expect((await pair("AAAAA-AAAAA-AAAAA-AAAAA")).status).toBe(401);
    const limited = await pair("AAAAA-AAAAA-AAAAA-AAAAA");
    expect([limited.status, limited.body.error.code]).toEqual([429, "rate_limited"]);

    let clock = Date.now();
    const store = new StudioSessions(path.join(dataDir, "video-auth"), { now: () => clock });
    const code = await mintCode();
    // Cancellation removes pairing records only, never other files in the folder.
    await writeFile(path.join(dataDir, "video-auth", "pairing", ".keep-me"), "");
    for (let i = 0; i < 10; i++) {
      expect((await store.redeem("BBBBB-BBBBB-BBBBB-BBBBB")).ok).toBe(false);
      clock += 61_000; // outside the one-minute window, so only the cancellation rule applies
    }
    expect(await readdir(path.join(dataDir, "video-auth", "pairing"))).toEqual([".keep-me"]);
    clock = Date.now();
    expect((await store.redeem(code)).ok).toBe(false);
  });

  it("refuses malformed codes, counting each towards the rate limit", async () => {
    for (const bad of [123, null, "", "x".repeat(65), "../../etc/passwd"]) {
      expect((await pair(bad)).status, JSON.stringify(bad)).toBe(401);
    }
    expect((await pair("AAAAA-AAAAA")).status).toBe(429);
    await expect(readdir(path.join(dataDir, "video-auth", "sessions"))).rejects.toThrow();
  });
});

describe("cookie requests must come from this app's own pages", () => {
  it("refuses pairing from other sites, rebinding hosts and scripts that cannot set the Studio header", async () => {
    const code = await mintCode();
    for (const [label, r] of [
      ["no Origin", { origin: null }],
      ["foreign Origin", { origin: "https://evil.example" }],
      ["another local port", { origin: "http://127.0.0.1:5173" }],
      ["rebinding Host", { host: "rebound.evil.example:3000", origin: "http://rebound.evil.example:3000" }],
      ["no Studio header", { studioHeader: false }],
      ["same-site fetch", { fetchSite: "same-site" }],
      ["cross-site fetch", { fetchSite: "cross-site" }],
    ] as [string, Req][]) {
      const res = await pair(code, r);
      expect(res.status, label).toBe(403);
      expect(res.setCookie, label).toBeNull();
    }
    // None of those consumed the code.
    expect((await pair(code, { fetchSite: "same-origin" })).status).toBe(201);
  });

  it("refuses a valid session cookie on cross-site or headerless requests", async () => {
    const cookie = await pairedCookie();
    await send(collection.POST, "/api/video/productions", withSession(cookie, { body: { production: footageProduction() } }));
    const url = "/api/video/productions/prod-footage/changes";
    const body = { baseRevision: 7, summary: "csrf", ops: [{ op: "renameProduction", name: "Hijacked" }] };
    for (const [label, r] of [
      ["no Studio header", { studioHeader: false }],
      ["cross-site fetch metadata", { fetchSite: "cross-site" }],
      ["same-site page on another port", { fetchSite: "same-site", origin: ORIGIN }],
      ["no Origin on a write", { origin: null }],
      ["foreign Origin on a write", { origin: "https://evil.example" }],
    ] as [string, Req][]) {
      const res = await send(changes.POST, url, withSession(cookie, { body, ...r }), ID);
      expect(res.status, label).toBe(403);
    }
    const read = await send(production.GET, "/api/video/productions/prod-footage", withSession(cookie, { fetchSite: "cross-site" }), ID);
    expect(read.status).toBe(403);
    expect((await send(production.GET, "/api/video/productions/prod-footage", withSession(cookie), ID)).body.production.name).not.toBe("Hijacked");
  });
});

describe("sessions end on sign-out, revocation and expiry, and survive a restart", () => {
  it("signs out on the server, so a copied cookie stops working too", async () => {
    const cookie = await pairedCookie();
    const copied = cookie;
    const out = await send(session.DELETE, "/api/video/session", withSession(cookie, { method: "DELETE" }));
    expect(out.status).toBe(200);
    expect(out.setCookie).toMatch(/^cb_studio_session=; Path=\/api\/video; HttpOnly; SameSite=Strict; Max-Age=0$/);
    expect((await send(session.GET, "/api/video/session", withSession(copied))).status).toBe(401);
    expect((await send(collection.GET, "/api/video/productions", withSession(copied))).body.error.code).toBe("invalid_credential");
  });

  it("revokes every session from the terminal", async () => {
    const a = await pairedCookie();
    const b = await pairedCookie();
    const { stdout } = await run(process.execPath, [SCRIPT, "--data-dir", dataDir, "--revoke-all"]);
    expect(stdout).toContain("Signed out 2 Studio session(s)");
    for (const cookie of [a, b]) expect((await send(session.GET, "/api/video/session", withSession(cookie))).status).toBe(401);
  });

  it("keeps sessions and unused codes across a restart; rate limits start afresh", async () => {
    const cookie = await pairedCookie();
    const code = await mintCode();
    restart();
    expect((await send(session.GET, "/api/video/session", withSession(cookie))).status).toBe(200);
    expect((await pair(code)).status).toBe(201);
    expect((await pair(code)).status).toBe(401);
  });

  it("re-pairing replaces the browser's session; at most 16 sessions are kept", async () => {
    const first = await pairedCookie();
    const again = await pair(await mintCode(), withSession(first));
    expect(again.status).toBe(201);
    expect((await send(session.GET, "/api/video/session", withSession(first))).status).toBe(401);

    const store = new StudioSessions(path.join(dataDir, "video-auth"));
    const cookies: string[] = [];
    for (let i = 0; i < 17; i++) {
      const code = await mintCode();
      const res = await store.redeem(code);
      if (!res.ok) throw new Error("redeem");
      cookies.push(`cb_studio_session=${res.token}`);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect((await readdir(path.join(dataDir, "video-auth", "sessions"))).length).toBe(16);
    expect((await send(session.GET, "/api/video/session", withSession(cookies[0]))).status).toBe(401);
    expect((await send(session.GET, "/api/video/session", withSession(cookies[16]))).status).toBe(200);
  });

  it("treats tampered and duplicated cookies as no valid session", async () => {
    const cookie = await pairedCookie();
    const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
    expect((await send(collection.GET, "/api/video/productions", withSession(tampered))).body.error.code).toBe("invalid_credential");
    const tossed = `${cookie}; cb_studio_session=${"x".repeat(43)}`;
    expect((await send(collection.GET, "/api/video/productions", withSession(tossed))).body.error.code).toBe("invalid_credential");
    expect((await send(session.GET, "/api/video/session", withSession(tossed))).status).toBe(401);
  });
});

describe("agents and other credentials cannot pass as a paired person", () => {
  it("refuses a session combined with a run token or the human key", async () => {
    const cookie = await pairedCookie();
    await send(collection.POST, "/api/video/productions", withSession(cookie, { body: { production: footageProduction() } }));
    const both = await send(production.GET, "/api/video/productions/prod-footage", withSession(cookie, { headers: { authorization: `Bearer cbrun_${"a".repeat(64)}` } }), ID);
    expect(both.body.error.code).toBe("ambiguous_credential");
    const keyToo = await send(production.GET, "/api/video/productions/prod-footage", withSession(cookie, { headers: { "x-creatorbrio-human-key": humanKey } }), ID);
    expect(keyToo.body.error.code).toBe("ambiguous_credential");
    expect((await pair(await mintCode(), { headers: { authorization: `Bearer cbrun_${"a".repeat(64)}` } })).body.error.code).toBe("ambiguous_credential");
  });

  it("keeps agents to their runs: a run token gains nothing from the Studio header or a forged cookie", async () => {
    const cookie = await pairedCookie();
    await send(collection.POST, "/api/video/productions", withSession(cookie, { body: { production: footageProduction() } }));
    const runs = (await import("@/app/api/video/productions/[id]/runs/route")) as unknown as Record<string, Handler>;
    const started = await send(runs.POST, "/api/video/productions/prod-footage/runs", withSession(cookie, { body: {} }), ID);
    expect(started.status, started.text).toBe(201);
    const agent = { headers: { authorization: `Bearer ${started.body.token}` } };
    const g = (await send(production.GET, "/api/video/productions/prod-footage", agent, ID)).body.generation;
    const tryUndo = await send(undo.POST, "/api/video/productions/prod-footage/undo", { ...agent, body: { expectedGeneration: g } }, ID);
    expect([tryUndo.status, tryUndo.body.error.code]).toEqual([403, "forbidden"]);
    const forgedCookie = await send(undo.POST, "/api/video/productions/prod-footage/undo", { cookie: `cb_studio_session=${"a".repeat(43)}`, body: { expectedGeneration: g } }, ID);
    expect(forgedCookie.body.error.code).toBe("invalid_credential");
    // An agent cannot redeem a code it does not have, and guessing is limited.
    expect((await pair("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ")).status).toBe(401);
  });

  it("still accepts the human key for API clients without a browser, unchanged", async () => {
    const res = await collection.GET(new Request(`${ORIGIN}/api/video/productions`, { headers: { host: "127.0.0.1:3000", "x-creatorbrio-human-key": humanKey } }));
    expect(res.status).toBe(200);
  });
});
