/**
 * The Production API (WS1 #120) through its real route modules, against
 * isolated storage: authority and forgery, request validation, typed errors,
 * revision conflicts, agent runs, confirmation gates, recovery and restart.
 */
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proxy } from "@/proxy";
import { registerFixtureMedia } from "./helpers/media-fixtures";
import { footageProduction, hybridProduction, scriptProduction } from "./helpers/production-fixtures";
import { restartApi } from "./helpers/api-contexts";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Routes = Record<string, Record<string, Handler | undefined>>;

let workdir: string;
let originalCwd: string;
let routes: Routes;
let key: string;
const ORIGIN = "http://127.0.0.1:3000";

beforeAll(async () => {
  originalCwd = process.cwd();
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-video-api-")));
  process.chdir(workdir);
  const base = "@/app/api/video/productions";
  routes = {
    collection: await import(`${base}/route`),
    production: await import(`${base}/[id]/route`),
    changes: await import(`${base}/[id]/changes/route`),
    undo: await import(`${base}/[id]/undo/route`),
    redo: await import(`${base}/[id]/redo/route`),
    labels: await import(`${base}/[id]/labels/route`),
    restore: await import(`${base}/[id]/labels/[name]/restore/route`),
    runs: await import(`${base}/[id]/runs/route`),
    decision: await import(`${base}/[id]/runs/[runId]/decision/route`),
    recover: await import(`${base}/[id]/recover/route`),
  } as Routes;
  const { apiContext } = await import("@/lib/video/production/api/handlers");
  key = await apiContext().authority.humanKey();
});

afterAll(async () => {
  await restartApi();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

/** A server restart over the same files; see `restartApi`. */
const restart = restartApi;

beforeEach(async () => {
  await restart();
  await rm(path.join(workdir, "data", "video"), { recursive: true, force: true });
  await registerFixtureMedia(path.join(workdir, "data"));
});

interface CallOptions {
  human?: boolean;
  humanKey?: string;
  token?: string;
  body?: unknown;
  raw?: string;
  contentType?: string;
  origin?: string;
  host?: string;
  params?: Record<string, string>;
  method?: string;
}

async function call(route: string, options: CallOptions = {}) {
  const method = options.method ?? (options.body !== undefined || options.raw !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { host: options.host ?? "127.0.0.1:3000" };
  if (options.human !== false && (options.human || options.humanKey)) headers["x-creatorbrio-human-key"] = options.humanKey ?? key;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.origin) headers.origin = options.origin;
  let body: string | undefined;
  if (options.raw !== undefined || options.body !== undefined) {
    body = options.raw ?? JSON.stringify(options.body);
    headers["content-type"] = options.contentType ?? "application/json";
  }
  const handler = routes[route][method];
  if (!handler) throw new Error(`${route} has no ${method}`);
  const response = await handler(new Request(`${ORIGIN}/api/video/productions`, { method, headers, body }), { params: Promise.resolve(options.params ?? {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text, headers: response.headers };
}

const human = (route: string, options: CallOptions = {}) => call(route, { human: true, ...options });
const id = (productionId = "prod-footage") => ({ params: { id: productionId } });

async function create(doc = footageProduction()) {
  const res = await human("collection", { body: { production: doc } });
  expect(res.status, res.text).toBe(201);
  return res.body;
}

async function read(productionId = "prod-footage", options: CallOptions = { human: true }) {
  const res = await call("production", { ...options, ...id(productionId) });
  return res;
}

const rename = (baseRevision: number, name: string) => ({ baseRevision, summary: `Rename to ${name}`, ops: [{ op: "renameProduction", name }] });

async function generation(productionId = "prod-footage"): Promise<number> {
  return (await read(productionId)).body.generation;
}

// ---------------------------------------------------------------------------

describe("authority comes from a credential, never from the body", () => {
  it("refuses every operation without a credential, and with a wrong or doubled one", async () => {
    await create();
    for (const [route, options] of [
      ["collection", {}],
      ["collection", { body: { production: footageProduction() } }],
      ["production", id()],
      ["changes", { ...id(), body: rename(7, "x") }],
    ] as [string, CallOptions][]) {
      const res = await call(route, options);
      expect(res.status, route).toBe(401);
      expect(res.body.error.code).toBe("authority_required");
    }
    expect((await call("production", { ...id(), humanKey: "0".repeat(64) })).body.error.code).toBe("invalid_credential");
    expect((await call("production", { ...id(), token: "cbrun_" + "a".repeat(64) })).body.error.code).toBe("invalid_credential");
    expect((await call("production", { ...id(), human: true, token: "cbrun_" + "a".repeat(64) })).body.error.code).toBe("ambiguous_credential");
  });

  it("keeps the human key in an owner-only file and never returns it", async () => {
    const file = path.join(workdir, "data", "video-studio.key");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    await create();
    const run = await human("runs", { ...id(), body: {} });
    for (const res of [await read(), await human("collection"), run]) expect(res.text).not.toContain(key);
  });

  it("refuses actor, role, run, id, time and approval fields instead of trusting them", async () => {
    await create();
    const before = await generation();
    for (const forged of [{ by: "user" }, { actor: "human" }, { role: "admin" }, { userId: "u1" }, { runId: "run-x" }, { approved: true }, { id: "cs-mine" }, { at: "2030-01-01T00:00:00.000Z" }, { override: true }]) {
      const res = await human("changes", { ...id(), body: { ...rename(7, "Forged"), ...forged } });
      expect(res.status, JSON.stringify(forged)).toBe(400);
      expect(res.body.error).toMatchObject({ code: "server_owned_field", fields: Object.keys(forged) });
    }
    expect((await human("changes", { ...id(), body: { ...rename(7, "x"), extra: 1 } })).body.error.code).toBe("unknown_field");
    expect(await generation()).toBe(before);
  });

  it("gives an agent only its own run's changes on its own production, as an agent", async () => {
    await create();
    await create(scriptProduction());
    const { token, runId } = (await human("runs", { ...id(), body: {} })).body;
    expect(runId).toMatch(/^run-[0-9a-f]{16}$/);

    const edit = await call("changes", { ...id(), token, body: rename(7, "Agent name") });
    expect(edit.status, edit.text).toBe(200);
    const state = (await read()).body;
    expect(state.run).toMatchObject({ runId, changeSetIds: [edit.body.changeSetId], interrupted: false });

    // The engine refuses an agent approval however the request is phrased.
    const approve = await call("changes", { ...id(), token, body: { baseRevision: 8, summary: "approve", ops: [{ op: "setSceneStatus", sceneId: "scene-hook", status: "final" }] } });
    expect(approve.status).toBe(422);
    expect(approve.body.error.issues[0]).toMatchObject({ code: "forbidden" });
    expect((await call("changes", { ...id(), token, body: { ...rename(8, "x"), by: "user" } })).body.error.code).toBe("server_owned_field");

    // Nothing else is open to an agent, and nothing on another production.
    const g = await generation();
    for (const [route, options] of [
      ["collection", {}],
      ["undo", { ...id(), body: { expectedGeneration: g } }],
      ["labels", { ...id(), body: { name: "v1" } }],
      ["runs", { ...id(), body: {} }],
      ["decision", { params: { id: "prod-footage", runId }, body: { decision: "keep", expectedGeneration: g } }],
      ["recover", { ...id(), body: { fromGeneration: 1, expectedGeneration: g } }],
      ["production", id("prod-script")],
      ["changes", { ...id("prod-script"), body: rename(3, "x") }],
    ] as [string, CallOptions][]) {
      const res = await call(route, { ...options, token });
      expect(res.status, route).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect((await call("collection", { token, body: { production: hybridProduction() } })).status).toBe(403);
  });
});

describe("requests are validated before anything is read or written", () => {
  beforeEach(async () => void (await create()));

  it("refuses malformed, wrongly typed and oversized bodies", async () => {
    const send = (options: CallOptions) => human("changes", { ...id(), ...options });
    expect((await send({ raw: "{not json" })).body.error.code).toBe("invalid_json");
    expect((await send({ raw: "[1,2]" })).body.error.code).toBe("invalid_body");
    expect((await send({ raw: JSON.stringify(rename(7, "x")), contentType: "text/plain" })).status).toBe(415);
    const big = JSON.stringify({ ...rename(7, "x"), summary: "x".repeat(2 * 1024 * 1024) });
    const tooBig = await send({ raw: big });
    expect([tooBig.status, tooBig.body.error.code]).toEqual([413, "body_too_large"]);
    expect((await send({ body: { summary: "x", ops: [] } })).body.error).toMatchObject({ code: "missing_field", fields: ["baseRevision"] });
    expect(await generation()).toBe(1);
  });

  it("refuses ids that could reach outside the store, in every encoding", async () => {
    for (const bad of ["../etc", "..%2Fetc", "..\\etc", "prod/../../x", "%2e%2e", "prod\u0000x", "a".repeat(65), ".hidden", ""]) {
      for (const route of ["production", "changes"]) {
        const res = await human(route, { params: { id: bad }, ...(route === "changes" ? { body: rename(7, "x") } : {}) });
        expect(res.status, `${route} ${JSON.stringify(bad)}`).toBe(400);
        expect(res.body.error.code).toBe("invalid_id");
      }
    }
    expect(await readdir(path.join(workdir, "data", "video"))).toEqual(["prod-footage"]);
  });

  it("answers only the methods each route defines", () => {
    expect(Object.keys(routes.collection).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(routes.production).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["GET"]);
    for (const name of ["changes", "undo", "redo", "labels", "restore", "runs", "decision", "recover"]) {
      expect(Object.keys(routes[name]).filter((k) => /^[A-Z]+$/.test(k)), name).toEqual(["POST"]);
    }
  });

  it("keeps the loopback Host and cross-site Origin protections, in the proxy and in each route", async () => {
    const refused = await human("changes", { ...id(), body: rename(7, "x"), origin: "https://evil.example" });
    expect([refused.status, refused.body.error.code]).toEqual([403, "request_refused"]);
    expect((await human("production", { ...id(), host: "evil.example:3000" })).status).toBe(403);
    expect((await human("changes", { ...id(), body: rename(7, "Same origin"), origin: ORIGIN })).status).toBe(200);

    const viaProxy = (method: string, headers: Record<string, string>) =>
      proxy(new NextRequest(`${ORIGIN}/api/video/productions/prod-footage/changes`, { method, headers }));
    expect(viaProxy("POST", { host: "127.0.0.1:3000", origin: "https://evil.example" }).status).toBe(403);
    expect(viaProxy("GET", { host: "rebound.example:3000" }).status).toBe(403);
    expect(viaProxy("POST", { host: "127.0.0.1:3000" }).status).toBe(200);
  });
});

describe("revision handling and typed errors", () => {
  beforeEach(async () => void (await create()));

  it("rejects a stale change set with the revisions involved, and nothing is written", async () => {
    expect((await human("changes", { ...id(), body: rename(7, "First") })).status).toBe(200);
    const stale = await human("changes", { ...id(), body: rename(7, "Second") });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "stale_revision", expectedRevision: 7, actualRevision: 8 });
    expect((await read()).body.production.name).toBe("First");
  });

  it("accepts exactly one of several parallel change sets against one revision", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => human("changes", { ...id(), body: rename(7, `Writer ${i}`) })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === "stale_revision")).toHaveLength(5);
    expect(await generation()).toBe(2);
  });

  it("maps engine and store failures to stable codes", async () => {
    expect((await read("prod-missing")).body.error.code).toBe("not_found");
    expect((await human("collection", { body: { production: footageProduction() } })).body.error.code).toBe("already_exists");
    const invalid = await human("collection", { body: { production: { ...scriptProduction(), revision: -1 } } });
    expect([invalid.status, invalid.body.error.code, invalid.body.error.stage]).toEqual([422, "rejected", "admission"]);
    const badOp = await human("changes", { ...id(), body: { baseRevision: 7, summary: "x", ops: [{ op: "setPath", path: "revision", value: 1 }] } });
    expect([badOp.status, badOp.body.error.issues[0].code]).toEqual([422, "unknown_op"]);
  });
});

describe("undo, redo and named versions need a confirmed generation", () => {
  beforeEach(async () => void (await create(hybridProduction())));
  const hx = id("prod-hybrid");

  it("refuses an unconfirmed or outdated command and applies a confirmed one", async () => {
    await human("changes", { ...hx, body: rename(9, "Edited") });
    expect((await human("undo", { ...hx, body: {} })).status).toBe(428);
    const g = await generation("prod-hybrid");
    const outdated = await human("undo", { ...hx, body: { expectedGeneration: g - 1 } });
    expect(outdated.body.error).toMatchObject({ code: "generation_mismatch", expectedGeneration: g - 1, actualGeneration: g });
    expect((await human("undo", { ...hx, body: { expectedGeneration: g } })).status).toBe(200);
    expect((await read("prod-hybrid")).body.production.name).toBe(hybridProduction().name);
    expect((await human("redo", { ...hx, body: { expectedGeneration: g + 1 } })).status).toBe(200);
    expect((await read("prod-hybrid")).body.production.name).toBe("Edited");
  });

  it("labels and restores versions, and never resolves a label from the object prototype", async () => {
    expect((await human("labels", { ...hx, body: { name: "v1-sent" } })).status).toBe(200);
    await human("changes", { ...hx, body: rename(9, "Later") });
    const g = await generation("prod-hybrid");
    expect((await human("restore", { params: { id: "prod-hybrid", name: "v1-sent" }, body: {} })).status).toBe(428);
    expect((await human("restore", { params: { id: "prod-hybrid", name: "v1-sent" }, body: { expectedGeneration: g } })).status).toBe(200);
    expect((await read("prod-hybrid")).body.production.name).toBe(hybridProduction().name);
    for (const name of ["constructor", "toString", "missing"]) {
      const res = await human("restore", { params: { id: "prod-hybrid", name }, body: { expectedGeneration: g + 1 } });
      expect([res.status, res.body.error.code], name).toEqual([422, "rejected"]);
    }
    expect((await read("prod-hybrid")).body.history.labels).toEqual([{ name: "v1-sent", revision: 9 }]);
  });
});

describe("agent runs across a server restart", () => {
  beforeEach(async () => void (await create()));

  it("blocks other writers during a run and ends it only on a confirmed decision", async () => {
    const { token, runId } = (await human("runs", { ...id(), body: {} })).body;
    expect((await call("changes", { ...id(), token, body: rename(7, "By agent") })).status).toBe(200);
    expect((await human("changes", { ...id(), body: rename(8, "By person") })).body.error.code).toBe("run_in_progress");
    const decide = (body: object) => human("decision", { params: { id: "prod-footage", runId }, body });
    expect((await decide({ decision: "keep" })).status).toBe(428);
    expect((await decide({ decision: "resume", expectedGeneration: 3 })).body.error.code).toBe("run_not_interrupted");
    expect((await decide({ decision: "keep", expectedGeneration: 2 })).body.error.code).toBe("generation_mismatch");
    expect((await human("decision", { params: { id: "prod-footage", runId: "run-other" }, body: { decision: "keep", expectedGeneration: 3 } })).status).toBe(404);
    const kept = await decide({ decision: "keep", expectedGeneration: 3 });
    expect(kept.status, kept.text).toBe(200);
    expect((await read()).body.history.undo.at(-1)).toMatchObject({ runId });
    // The run's token ended with the run.
    expect((await call("changes", { ...id(), token, body: rename(8, "x") })).body.error.code).toBe("invalid_credential");
  });

  it("after a restart: the old token is dead, the run is interrupted, and only a person decides", async () => {
    const { token, runId } = (await human("runs", { ...id(), body: {} })).body;
    await call("changes", { ...id(), token, body: rename(7, "Half-finished agent edit") });
    await restart();

    expect((await call("changes", { ...id(), token, body: rename(8, "x") })).body.error.code).toBe("invalid_credential");
    const state = (await read()).body;
    expect(state).toMatchObject({ recoveryRequired: true, run: { runId, interrupted: true, ownerAlive: true } });
    expect(state.production.name).toBe("Half-finished agent edit");
    const blocked = await human("changes", { ...id(), body: rename(8, "Person") });
    expect([blocked.status, blocked.body.error.code]).toEqual([423, "recovery_required"]);

    const resumed = await human("decision", { params: { id: "prod-footage", runId }, body: { decision: "resume", expectedGeneration: state.generation } });
    expect(resumed.status, resumed.text).toBe(200);
    expect(resumed.body.token).toMatch(/^cbrun_/);
    expect((await call("changes", { ...id(), token: resumed.body.token, body: rename(8, "Resumed agent edit") })).status).toBe(200);

    const g = await generation();
    const discarded = await human("decision", { params: { id: "prod-footage", runId }, body: { decision: "discard", expectedGeneration: g } });
    expect(discarded.status, discarded.text).toBe(200);
    const after = (await read()).body;
    expect(after.production.name).toBe(footageProduction().name);
    expect(after.run).toBeNull();
  });
});

describe("damaged productions are reported and recovered only explicitly", () => {
  it("reports corruption without paths, refuses writes, and recovers on a confirmed request", async () => {
    await create();
    await human("changes", { ...id(), body: rename(7, "One") });
    const journal = path.join(workdir, "data", "video", "prod-footage", "journal");
    const newest = path.join(journal, (await readdir(journal)).sort().at(-1)!);
    await writeFile(newest, "{ torn");

    const res = await read();
    expect([res.status, res.body.error.code, res.body.error.generation]).toEqual([500, "production_corrupt", 2]);
    expect(res.text).not.toContain(workdir);
    expect((await human("changes", { ...id(), body: rename(8, "x") })).body.error.code).toBe("production_corrupt");
    const listed = (await human("collection")).body.productions;
    expect(listed).toEqual([expect.objectContaining({ productionId: "prod-footage", status: "corrupt" })]);
    expect(JSON.stringify(listed)).not.toContain(workdir);

    expect((await human("recover", { ...id(), body: { fromGeneration: 1 } })).status).toBe(428);
    expect((await human("recover", { ...id(), body: { fromGeneration: 1, expectedGeneration: 1 } })).body.error.code).toBe("generation_mismatch");
    const recovered = await human("recover", { ...id(), body: { fromGeneration: 1, expectedGeneration: 2 } });
    expect(recovered.status, recovered.text).toBe(200);
    expect((await read()).body.production.name).toBe(footageProduction().name);
    expect(await readFile(newest, "utf-8")).toBe("{ torn");
  });
});

describe("end to end for every workflow, across a restart", () => {
  for (const build of [footageProduction, scriptProduction, hybridProduction]) {
    it(`${build().workflow}: create, edit, label, undo, redo and restore survive a restart`, async () => {
      const doc = build();
      const p = id(doc.id);
      await create(doc);
      expect((await human("changes", { ...p, body: rename(doc.revision, "Draft two") })).status).toBe(200);
      expect((await human("labels", { ...p, body: { name: "draft-two" } })).status).toBe(200);
      expect((await human("changes", { ...p, body: rename(doc.revision + 1, "Draft three") })).status).toBe(200);
      await restart();
      let g = await generation(doc.id);
      expect((await human("undo", { ...p, body: { expectedGeneration: g } })).status).toBe(200);
      await restart();
      expect((await human("redo", { ...p, body: { expectedGeneration: g + 1 } })).status).toBe(200);
      await restart();
      g = await generation(doc.id);
      expect((await human("restore", { params: { id: doc.id, name: "draft-two" }, body: { expectedGeneration: g } })).status).toBe(200);
      await restart();
      const final = (await read(doc.id)).body;
      expect(final.production.name).toBe("Draft two");
      expect(final.history.undo.map((s: { label: string }) => s.label)).toEqual(["Rename to Draft two", "Rename to Draft three", "Restore draft-two"]);
      expect(final.history.labels).toEqual([{ name: "draft-two", revision: doc.revision + 1 }]);
    });
  }
});
