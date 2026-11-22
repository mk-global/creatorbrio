/**
 * A loopback stand-in for the Messages API (#237).
 *
 * The real Claude CLI runs against it with `ANTHROPIC_BASE_URL` pointing here
 * and a dummy API key, so its tools, permissions, sandbox and sessions are
 * exercised exactly as shipped, with no model, no spend and no credential.
 * It answers the CLI's main loop (a request that offers Bash or Read) with the
 * scripted tool calls in order, one per turn, then a final text reply; any
 * other request the CLI makes gets a short text reply.
 *
 * It records facts about each request, never a credential: the model asked
 * for, the tools offered, the effort and thinking settings, which marker
 * strings appear anywhere in the request, the kind of credential header,
 * whether a bearer matches the hash the harness expects (#242), and
 * the tool results the CLI sent back (the CLI's own report of what a tool
 * did, which the harness checks against host-side evidence, never trusts).
 *
 * It never refuses a credential: it answers 200, or 404 for a path it does
 * not serve, never 401 or 403, because an authentication refusal makes the
 * CLI try a refresh and then sign itself out.
 *
 * Node built-ins only, so it runs in the Linux container and the macOS VM.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

export const STAND_IN_API_KEY = "sk-ant-api03-creatorbrio-stand-in-dummy";

export interface ScriptedCall {
  name: string;
  input: Record<string, unknown>;
}

export interface StandInRequest {
  path: string;
  credential: "dummy-key" | "other-key" | "bearer" | "none";
  /**
   * Whether the request's bearer is the one whose SHA-256 the harness said to
   * expect (`expectBearer`); null when none is expected or there is no
   * bearer. Only the comparison is kept, never the bearer.
   */
  bearerMatches: boolean | null;
  model: string | null;
  mainLoop: boolean;
  tools: string[];
  effort: unknown;
  thinking: unknown;
  markers: string[];
  /** How many earlier assistant turns the request carries: the conversation's length so far. */
  assistantTurns: number;
  /** The conversation's shape, role and block types only, never content: for diagnosing a run. */
  shape: string[];
  toolResults: string[];
}

export interface StandIn {
  port: number;
  requests: StandInRequest[];
  /** The calls the next main-loop conversation is answered with. */
  setScript: (calls: ScriptedCall[]) => void;
  /** The SHA-256, in hex, of the bearer later requests are compared with; null to compare none. */
  expectBearer: (sha256Hex: string | null) => void;
  close: () => Promise<void>;
}

/** Whether a request's bearer hashes to `expected`; null when nothing is expected or there is no bearer. */
export function bearerMatchesOf(headers: Record<string, string | string[] | undefined>, expected: string | null): boolean | null {
  const auth = headers.authorization;
  if (expected === null || typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  return createHash("sha256").update(auth.slice("Bearer ".length)).digest("hex") === expected.toLowerCase();
}

function credentialOf(headers: Record<string, string | string[] | undefined>): StandInRequest["credential"] {
  if (headers.authorization) return "bearer";
  if (headers["x-api-key"] === STAND_IN_API_KEY) return "dummy-key";
  return headers["x-api-key"] ? "other-key" : "none";
}

function writeSse(res: import("node:http").ServerResponse, model: string, block: ScriptedCall & { id: string } | { text: string }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", {
    message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  if ("text" in block) {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
  } else {
    ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
  }
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: "text" in block ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
  ev("message_stop", {});
  res.end();
}

/**
 * How many of the current script's calls the conversation already holds.
 * Each script's calls carry its own id prefix, so the calls of an earlier
 * script in a resumed conversation never count, whatever text messages the
 * CLI places between them.
 */
export function scriptCallsMade(messages: readonly { role?: string; content?: unknown }[], prefix: string): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const c of m.content as { type?: string; id?: unknown }[]) if (c.type === "tool_use" && typeof c.id === "string" && c.id.startsWith(prefix)) n++;
  }
  return n;
}

/** A stand-in answers at most this many main-loop requests per script, so a CLI that loops cannot run unattended. */
export const MAX_REQUESTS_PER_SCRIPT = 64;

export async function startStandIn(markers: readonly string[] = []): Promise<StandIn> {
  const requests: StandInRequest[] = [];
  let script: ScriptedCall[] = [];
  let generation = 0;
  let answered = 0;
  let expectedBearer: string | null = null;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "/";
      const pathOnly = url.split("?")[0];
      if (!pathOnly.startsWith("/v1/messages") || pathOnly.includes("count_tokens")) {
        requests.push({ path: pathOnly, credential: credentialOf(req.headers), bearerMatches: bearerMatchesOf(req.headers, expectedBearer), model: null, mainLoop: false, tools: [], effort: null, thinking: null, markers: [], assistantTurns: 0, shape: [], toolResults: [] });
        const counting = pathOnly.includes("count_tokens");
        res.writeHead(counting ? 200 : 404, { "content-type": "application/json" });
        res.end(counting ? '{"input_tokens":10}' : "{}");
        return;
      }
      let j: Record<string, unknown> = {};
      try {
        j = JSON.parse(body);
      } catch {
        // Recorded with what could be read.
      }
      const tools = Array.isArray(j.tools) ? (j.tools as { name?: string }[]).map((t) => String(t.name)) : [];
      const messages = Array.isArray(j.messages) ? (j.messages as { role?: string; content?: unknown }[]) : [];
      const toolResults: string[] = [];
      for (const m of messages) {
        for (const c of Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []) {
          if (c.type === "tool_result") toolResults.push(typeof c.content === "string" ? c.content : JSON.stringify(c.content));
        }
      }
      const mainLoop = tools.includes("Bash") || tools.includes("Read");
      const model = typeof j.model === "string" ? j.model : "unknown";
      requests.push({
        path: pathOnly,
        credential: credentialOf(req.headers),
        bearerMatches: bearerMatchesOf(req.headers, expectedBearer),
        model,
        mainLoop,
        tools,
        effort: (j.output_config as unknown) ?? (j.effort as unknown) ?? null,
        thinking: (j.thinking as unknown) ?? null,
        markers: markers.filter((m) => body.includes(m)),
        assistantTurns: messages.filter((m) => m.role === "assistant").length,
        shape: messages.map((m) => `${m.role}:${typeof m.content === "string" ? "text" : Array.isArray(m.content) ? (m.content as { type?: string }[]).map((c) => c.type).join("+") : "?"}`),
        toolResults,
      });
      // The step is how many of this script's calls the conversation holds.
      const prefix = `toolu_stand_in_g${generation}_`;
      const step = scriptCallsMade(messages, prefix);
      if (mainLoop) answered++;
      const reply =
        mainLoop && step < script.length && answered <= MAX_REQUESTS_PER_SCRIPT ? { id: `${prefix}${step}`, ...script[step] } : { text: mainLoop ? "DONE" : "ok" };
      if (j.stream) {
        writeSse(res, model, reply);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_stand_in",
          type: "message",
          role: "assistant",
          model,
          content: ["text" in reply ? { type: "text", text: reply.text } : { type: "tool_use", id: reply.id, name: reply.name, input: reply.input }],
          stop_reason: "text" in reply ? "end_turn" : "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    requests,
    setScript: (calls) => {
      script = calls;
      generation++;
      answered = 0;
    },
    expectBearer: (sha256Hex) => {
      expectedBearer = sha256Hex;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The CLI's environment additions for a stand-in run: the loopback address and the dummy key, and no sign-in. */
export function standInEnv(env: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: STAND_IN_API_KEY };
  delete next.CLAUDE_CODE_OAUTH_TOKEN;
  delete next.ANTHROPIC_AUTH_TOKEN;
  return next;
}

/**
 * The CLI's environment for a run that signs in from the platform's sign-in
 * store (#242): the loopback address, and no API key or sign-in variable, so
 * the CLI uses only what the store holds.
 */
export function storeSignInEnv(env: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete next[name];
  return next;
}
