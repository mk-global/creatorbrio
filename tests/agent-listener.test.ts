/**
 * The agent-only listener (#226), against a running listener that forwards to
 * the app's real route handlers on a loopback server, with synthetic data.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentListenerPort, issueAgentToken, liveGrantCount, stopAgentListener, MAX_AGENT_BODY_BYTES } from "@/lib/agent-listener";
import { createCarousel, getCarousel } from "@/lib/carousels";
import { startAppRoutesServer, type AppRoutesServer, type ReceivedRequest } from "./helpers/app-routes-server";

let workdir: string;
let originalCwd: string;
let app: AppRoutesServer;
let appOrigin: string;
/** Every request the stand-in app received: what the listener forwarded. */
let received: ReceivedRequest[];
let port: number;
let A: string;
let B: string;

beforeAll(async () => {
  app = await startAppRoutesServer();
  appOrigin = app.origin;
  port = await agentListenerPort();
});

afterAll(async () => {
  await stopAgentListener();
  await app.close();
});

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-listener-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  process.chdir(workdir);
  A = (await createCarousel("Carousel A", "4:5")).id;
  B = (await createCarousel("Carousel B", "4:5")).id;
  app.received.length = 0;
  received = app.received;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

/** A request to the listener exactly as the agent's curl sends it through the sandbox's proxy. */
function agent(method: string, target: string, opts: { token?: string | null; body?: unknown; headers?: Record<string, string>; host?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        // A fresh connection per request, as each of the agent's curl commands is.
        agent: false,
        method,
        path: target,
        headers: {
          host: opts.host ?? `localhost:${port}`,
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          // Framed with its length, as curl sends a body on every method.
          ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const issue = (carouselId: string, ttlMs = 60_000) => issueAgentToken({ carouselId, appOrigin, ttlMs });

describe("agent listener: a valid token", () => {
  it("reads its carousel and adds, updates, reorders and deletes its slides and saves its caption, as the main routes do", async () => {
    const { token, revoke } = issue(A);
    const read = await agent("GET", `/api/carousels/${A}`, { token });
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body).id).toBe(A);

    const first = await agent("POST", `/api/carousels/${A}/slides`, { token, body: { html: "<div>one</div>", notes: "n1" } });
    const second = await agent("POST", `/api/carousels/${A}/slides`, { token, body: { html: "<div>two</div>" } });
    expect([first.status, second.status]).toEqual([201, 201]);
    const [s1, s2] = [JSON.parse(first.body).id, JSON.parse(second.body).id];

    expect((await agent("PUT", `/api/carousels/${A}/slides/${s1}`, { token, body: { html: "<div>ONE</div>" } })).status).toBe(200);
    expect((await agent("PUT", `/api/carousels/${A}/slides`, { token, body: { slideIds: [s2, s1] } })).status).toBe(200);
    expect((await agent("PUT", `/api/carousels/${A}/caption`, { token, body: { caption: "Synthetic caption", hashtags: ["one"] } })).status).toBe(200);
    expect((await agent("DELETE", `/api/carousels/${A}/slides/${s2}`, { token })).status).toBe(200);

    const stored = await getCarousel(A);
    expect(stored?.slides.map((s) => s.html)).toEqual(["<div>ONE</div>"]);
    expect(stored?.caption).toBe("Synthetic caption");
    revoke();
  });

  it("forwards only the method, path and a JSON content type: never the token, an origin or the agent's other headers", async () => {
    const { token } = issue(A);
    await agent("POST", `/api/carousels/${A}/slides`, { token, body: { html: "<p>x</p>" }, headers: { "x-forwarded-host": "evil.example", cookie: "a=b" } });
    expect(received).toHaveLength(1);
    const h = received[0].headers;
    expect(h.authorization).toBeUndefined();
    expect(h.origin).toBeUndefined();
    expect(h.cookie).toBeUndefined();
    expect(h["x-forwarded-host"]).toBeUndefined();
    expect(h["content-type"]).toBe("application/json");
    expect(h.host).toBe(new URL(appOrigin).host);
  });

  it("relays the route's own refusal unchanged", async () => {
    const { token } = issue(A);
    const missing = await agent("PUT", `/api/carousels/${A}/slides/no-such-slide`, { token, body: { html: "<p>x</p>" } });
    expect(missing.status).toBe(404);
  });
});

describe("agent listener: refusals change nothing and forward nothing", () => {
  const before = async () => JSON.stringify([await getCarousel(A), await getCarousel(B)]);

  it.each([
    ["no token", () => null],
    ["a malformed token", () => "not-a-token"],
    ["a forged token", () => "A".repeat(43)],
  ])("refuses %s", async (_name, token) => {
    const snapshot = await before();
    const res = await agent("POST", `/api/carousels/${A}/slides`, { token: token(), body: { html: "<p>x</p>" } });
    expect(res.status).toBe(401);
    expect(await before()).toBe(snapshot);
    expect(received).toHaveLength(0);
  });

  it("refuses another run's token for this carousel's operations, and this token for another carousel", async () => {
    const forB = issue(B).token;
    const forA = issue(A).token;
    const snapshot = await before();
    expect((await agent("POST", `/api/carousels/${A}/slides`, { token: forB, body: { html: "<p>x</p>" } })).status).toBe(403);
    expect((await agent("GET", `/api/carousels/${B}`, { token: forA })).status).toBe(403);
    expect((await agent("DELETE", `/api/carousels/${B}/slides/s1`, { token: forA })).status).toBe(403);
    expect(await before()).toBe(snapshot);
    expect(received).toHaveLength(0);
  });

  it("refuses an expired token and a revoked one", async () => {
    const expired = issue(A, 1).token;
    await new Promise((r) => setTimeout(r, 10));
    expect((await agent("GET", `/api/carousels/${A}`, { token: expired })).status).toBe(401);
    const { token, revoke } = issue(A);
    revoke();
    expect((await agent("GET", `/api/carousels/${A}`, { token })).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it.each([
    ["DELETE", (id: string) => `/api/carousels/${id}`],
    ["PUT", (id: string) => `/api/carousels/${id}`],
    ["POST", (id: string) => `/api/carousels/${id}/export`],
    ["POST", (id: string) => `/api/carousels/${id}/duplicate`],
    ["DELETE", (id: string) => `/api/carousels/${id}/generation`],
    ["POST", (id: string) => `/api/carousels/${id}/references`],
    ["POST", (id: string) => `/api/carousels/${id}/slides/s1/undo`],
    ["GET", () => "/api/carousels"],
    ["POST", () => "/api/carousels"],
    ["POST", () => "/api/style-presets"],
    ["PUT", () => "/api/brand"],
    ["PUT", () => "/api/brands/default"],
    ["POST", () => "/api/templates"],
    ["POST", () => "/api/upload"],
    ["POST", () => "/api/chat"],
    ["POST", () => "/api/video/session"],
    ["POST", () => "/api/video/productions"],
    ["GET", () => "/api/status"],
    ["PATCH", (id: string) => `/api/carousels/${id}/slides`],
  ])("serves no %s %s", async (method, target) => {
    const { token } = issue(A);
    const res = await agent(method, target(A), { token, body: method === "GET" || method === "DELETE" ? undefined : {} });
    expect(res.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it.each([
    `/api/carousels/A/../B`,
    `/api/carousels/%2e%2e/x`,
    `/api/carousels/{A}?x=1`,
    `/api/carousels/{A}/slides/`,
    `//api/carousels/{A}`,
    `/api/carousels/{A}#frag`,
  ])("refuses the unusual target %s", async (shape) => {
    const { token } = issue(A);
    const res = await agent("GET", shape.replaceAll("{A}", A).replace("A/../B", `${A}/../${B}`), { token });
    expect(res.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("refuses a browser: an Origin or any fetch metadata", async () => {
    const { token } = issue(A);
    expect((await agent("GET", `/api/carousels/${A}`, { token, headers: { origin: `http://localhost:${port}` } })).status).toBe(403);
    expect((await agent("GET", `/api/carousels/${A}`, { token, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(403);
    expect((await agent("GET", `/api/carousels/${A}`, { token, headers: { "sec-fetch-mode": "cors" } })).status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("refuses an unexpected Host, including the app's own port", async () => {
    const { token } = issue(A);
    for (const host of [new URL(appOrigin).host, "localhost", `evil.example:${port}`, `localhost:${port + 1}`]) {
      expect((await agent("GET", `/api/carousels/${A}`, { token, host })).status).toBe(403);
    }
    expect(received).toHaveLength(0);
  });

  it("refuses a body that is not JSON, too large, or on an operation without one", async () => {
    const { token } = issue(A);
    expect((await agent("POST", `/api/carousels/${A}/slides`, { token, body: "html=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(400);
    expect((await agent("POST", `/api/carousels/${A}/slides`, { token, body: "x".repeat(MAX_AGENT_BODY_BYTES + 1) })).status).toBe(400);
    expect((await agent("DELETE", `/api/carousels/${A}/slides/s1`, { token, body: "{}" })).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("forwards a JSON body sent without its content-type header, as the main routes accept it", async () => {
    const { token } = issue(A);
    const body = JSON.stringify({ html: "<p>x</p>" });
    expect((await agent("POST", `/api/carousels/${A}/slides`, { token, body, headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(201);
    expect(received).toHaveLength(1);
  });
});

describe("agent listener connections", () => {
  it("never parses a refused body's bytes as another request", async () => {
    const { token } = issue(A);
    const hidden = `DELETE /api/carousels/${A}/slides/s1 HTTP/1.1\r\nHost: localhost:${port}\r\nAuthorization: Bearer ${token}\r\n\r\n`;
    const body = hidden.padEnd(MAX_AGENT_BODY_BYTES + 1, " ");
    const raw =
      `POST /api/carousels/${A}/slides HTTP/1.1\r\nHost: localhost:${port}\r\nAuthorization: Bearer ${token}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.end(raw));
      let text = "";
      socket.on("data", (d) => (text += d));
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
    expect(reply.startsWith("HTTP/1.1 400")).toBe(true);
    expect(reply.match(/HTTP\/1\.1 /g)).toHaveLength(1);
    expect(received).toHaveLength(0);
  });
});

describe("agent tokens", () => {
  it("are issued only for the app's loopback origin", () => {
    for (const origin of ["http://evil.example:3000", "https://127.0.0.1:3000", "http://user:pw@127.0.0.1:3000", "http://127.0.0.1:3000/x", "not a url"]) {
      expect(() => issueAgentToken({ carouselId: A, appOrigin: origin, ttlMs: 1000 })).toThrow();
    }
  });

  it("are never logged", async () => {
    const warn = vi.spyOn(console, "warn");
    const { token } = issue(A);
    await agent("GET", `/api/carousels/${B}`, { token });
    await agent("POST", `/api/style-presets`, { token, body: {} });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });

  it("stop counting as live once revoked", () => {
    const before = liveGrantCount();
    const { revoke } = issue(A);
    expect(liveGrantCount()).toBe(before + 1);
    revoke();
    expect(liveGrantCount()).toBe(before);
  });
});

describe("agent listener data", () => {
  it("writes through the same store the main routes read", async () => {
    const { token } = issue(A);
    await agent("POST", `/api/carousels/${A}/slides`, { token, body: { html: "<p>shared</p>" } });
    const raw = JSON.parse(await readFile(path.join(workdir, "data", "carousels.json"), "utf8"));
    expect(raw.carousels.find((c: { id: string }) => c.id === A).slides[0].html).toBe("<p>shared</p>");
    await writeFile(path.join(workdir, "marker"), "");
  });
});
