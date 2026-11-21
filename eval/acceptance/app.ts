import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { createChatStreamParser, type ChatStreamEvent } from "@/lib/chat-stream";
import type { Brand } from "@/types/brand";
import type { AspectRatio, Carousel } from "@/types/carousel";
import { ROOT } from "./server";
import { addUsage, usageFromCli, type TokenUsage } from "./usage";

/**
 * A client for a running CreatorBrio app, using only its public HTTP API the
 * way the browser does, plus read-only views of the run records and the
 * server log for evidence the API does not expose.
 */

const execFileAsync = promisify(execFile);

/** One stream event with when it arrived, in ms since the request started. */
export interface TimedEvent {
  at: number;
  event: ChatStreamEvent;
}

export interface ChatResult {
  /** Every event except `token`, which is summarised in `tokens`. */
  events: TimedEvent[];
  /**
   * The stream's `token` events: streamed text chunks, not model tokens.
   * Model token usage comes from the server's run log (`ServerCosts`).
   */
  tokens: { count: number; firstAt: number | null; lastAt: number | null };
  sessionId: string | null;
  durationMs: number;
  /** The harness closed the stream on purpose (cancellation). */
  aborted: boolean;
  /** The stream broke without a `done` event, for example because the server stopped. */
  streamError: string | null;
  httpStatus: number;
  httpError: string | null;
}

export interface ChatOptions {
  onEvent?: (event: TimedEvent) => void;
  /** Close the stream (the user pressing Stop) once this returns true. */
  abortWhen?: (event: TimedEvent) => boolean;
  /** Wait this long after `abortWhen` matched before closing. */
  abortDelayMs?: number;
  /** Called just before the stream is closed, so the caller can mark the moment of the stop. */
  onAbort?: () => void;
}

export interface AppClientOptions {
  /**
   * How long the chat request waits for its headers, and then between chunks,
   * before it gives up. The harness sets it from `chatTimeoutMs(largestStageMs(...))`
   * (limits.ts), so only the product's own limits stop a design; the default
   * is `DEFAULT_CHAT_TIMEOUT_MS`.
   */
  chatTimeoutMs?: number;
}

/**
 * The chat request's idle limit for a client that is told nothing: the longest
 * stage the product can have, its maximum Design Agent deadline of an hour
 * (`MAX_DESIGN_AGENT_TIMEOUT_SECONDS`), plus five minutes (`CHAT_TIMEOUT_MARGIN_MS`
 * in limits.ts, where a test keeps the two in step).
 */
export const DEFAULT_CHAT_TIMEOUT_MS = 65 * 60 * 1000;

/** How much of a non-2xx chat response's body is kept; the response is then closed unread. */
const ERROR_BODY_CHARS = 500;

export class AppClient {
  readonly chatTimeoutMs: number;

  constructor(
    readonly origin: string,
    options: AppClientOptions = {}
  ) {
    this.chatTimeoutMs = options.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  }

  private headers(json = true): Record<string, string> {
    // Same-origin, like the app's own pages.
    return { Origin: this.origin, ...(json ? { "Content-Type": "application/json" } : {}) };
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  /** Creates a carousel, in `brandId`'s brand when given (fixed for the carousel's life). */
  async createCarousel(name: string, aspectRatio: AspectRatio, brandId?: string): Promise<Carousel> {
    const res = await fetch(`${this.origin}/api/carousels`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name, aspectRatio, ...(brandId ? { brandId } : {}) }),
    });
    return this.json<Carousel>(res, "create carousel");
  }

  /**
   * The brand with exactly this configuration, created through the public
   * API the first time; an existing brand of the same name that differs is
   * left alone and a new one is created.
   */
  async ensureBrand(spec: BrandSpec): Promise<Brand> {
    const listed = await this.json<{ brands: Brand[] }>(await fetch(`${this.origin}/api/brands`, { headers: this.headers(false) }), "list brands");
    const found = listed.brands.find((b) => sameBrand(b, spec));
    if (found) return found;
    const res = await fetch(`${this.origin}/api/brands`, { method: "POST", headers: this.headers(), body: JSON.stringify(spec) });
    const created = await this.json<Brand>(res, "create brand");
    if (!sameBrand(created, spec)) throw new Error("The created brand does not match the synthetic brand the harness asked for");
    return created;
  }

  async getCarousel(id: string): Promise<Carousel> {
    const res = await fetch(`${this.origin}/api/carousels/${id}`, { headers: this.headers(false) });
    return this.json<Carousel>(res, "get carousel");
  }

  /** Uploads a PNG and adds it as a reference image, as the reference picker does. */
  async addReference(carouselId: string, png: Buffer, name: string): Promise<{ url: string; name: string }> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), name);
    const uploaded = await this.json<{ url: string }>(
      await fetch(`${this.origin}/api/upload`, { method: "POST", headers: this.headers(false), body: form }),
      "upload"
    );
    await this.json(
      await fetch(`${this.origin}/api/carousels/${carouselId}/references`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ url: uploaded.url, name }),
      }),
      "add reference"
    );
    return { url: uploaded.url, name };
  }

  async generation(carouselId: string): Promise<{ generating: boolean; interrupted: boolean }> {
    const res = await fetch(`${this.origin}/api/carousels/${carouselId}/generation`, { headers: this.headers(false) });
    return this.json(res, "generation status");
  }

  /** Waits until no run is writing the carousel, up to `timeoutMs`. */
  async waitUntilIdle(carouselId: string, timeoutMs = 60_000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        if (!(await this.generation(carouselId)).generating) return true;
      } catch {
        // The server may be restarting.
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /**
   * Sends one chat message and reads the whole event stream. Never throws for
   * stream problems. It uses `node:http` rather than `fetch`, whose default
   * body timeout of 300 s between chunks cut off designs whose stream was
   * quiet for longer (#232); this request gives up only after
   * `chatTimeoutMs` without its headers or without a chunk.
   */
  async chat(
    body: { carouselId: string; message: string; sessionId?: string | null; retryRunId?: string },
    options: ChatOptions = {}
  ): Promise<ChatResult> {
    const started = Date.now();
    const controller = new AbortController();
    const result: ChatResult = {
      events: [],
      tokens: { count: 0, firstAt: null, lastAt: null },
      sessionId: null,
      durationMs: 0,
      aborted: false,
      streamError: null,
      httpStatus: 0,
      httpError: null,
    };
    let abortTimer: NodeJS.Timeout | null = null;
    let sawDone = false;

    const handle = (event: ChatStreamEvent) => {
      const timed = { at: Date.now() - started, event };
      if (event.type === "token") {
        result.tokens.count++;
        result.tokens.firstAt ??= timed.at;
        result.tokens.lastAt = timed.at;
      } else {
        result.events.push(event.type === "result" ? { at: timed.at, event: { ...event, text: event.text.slice(0, 4000) } } : timed);
      }
      if (event.type === "done") {
        sawDone = true;
        result.sessionId = event.sessionId;
      }
      options.onEvent?.(timed);
      if (!abortTimer && !result.aborted && options.abortWhen?.(timed)) {
        abortTimer = setTimeout(() => {
          result.aborted = true;
          options.onAbort?.();
          controller.abort();
        }, options.abortDelayMs ?? 0);
      }
    };

    const payload = JSON.stringify({
      message: body.message,
      carouselId: body.carouselId,
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      ...(body.retryRunId ? { retryRunId: body.retryRunId } : {}),
    });
    // The idle limit, restarted by every chunk: the headers, then each part of the stream.
    let idleTimer: NodeJS.Timeout | null = null;
    let timedOut: string | null = null;
    let destroy: ((err: Error) => void) | null = null;
    const restartIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = `the chat stream sent nothing for ${Math.round(this.chatTimeoutMs / 1000)} s`;
        destroy?.(new Error(timedOut));
      }, this.chatTimeoutMs);
    };

    try {
      restartIdle();
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(
          new URL("/api/chat", this.origin),
          {
            method: "POST",
            headers: { ...this.headers(), "Content-Length": String(Buffer.byteLength(payload)) },
            // A socket of its own, so no agent's keep-alive or socket timeout applies.
            agent: false,
            signal: controller.signal,
          },
          resolve
        );
        destroy = (err) => req.destroy(err);
        req.on("error", reject);
        req.end(payload);
      });
      result.httpStatus = res.statusCode ?? 0;
      const ok = result.httpStatus >= 200 && result.httpStatus < 300;
      const decoder = new TextDecoder();
      const parser = createChatStreamParser();
      let errorText = "";
      for await (const chunk of res as AsyncIterable<Buffer>) {
        restartIdle();
        if (!ok) {
          errorText += decoder.decode(chunk, { stream: true });
          // Only the start of a refusal is kept, so read no more of it than that.
          if (errorText.length >= ERROR_BODY_CHARS) break;
          continue;
        }
        for (const event of parser.push(decoder.decode(chunk, { stream: true }))) handle(event);
      }
      if (!ok) {
        result.httpError = (errorText + decoder.decode()).slice(0, ERROR_BODY_CHARS);
        res.destroy();
        return result;
      }
      for (const event of parser.end()) handle(event);
      if (!sawDone) result.streamError = "stream ended without a done event";
    } catch (err) {
      if (!result.aborted) result.streamError = timedOut ?? (err as Error).message;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      if (idleTimer) clearTimeout(idleTimer);
      result.durationMs = Date.now() - started;
    }
    return result;
  }

  /** Exports the PNG ZIP and unpacks it; returns the PNG paths in slide order, or the refusal. */
  async exportPngs(
    carouselId: string,
    outDir: string
  ): Promise<{ ok: true; files: string[]; durationMs: number } | { ok: false; status: number; error: string; durationMs: number }> {
    const started = Date.now();
    const res = await fetch(`${this.origin}/api/carousels/${carouselId}/export?format=png`, {
      method: "POST",
      headers: this.headers(false),
    });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 300), durationMs: Date.now() - started };
    await mkdir(outDir, { recursive: true });
    const zip = path.join(outDir, "export.zip");
    await writeFile(zip, Buffer.from(await res.arrayBuffer()));
    await execFileAsync("unzip", ["-o", "-q", zip, "-d", outDir]);
    const files = (await readdir(outDir))
      .filter((f) => /\.png$/i.test(f))
      .sort((a, b) => slideNumber(a) - slideNumber(b))
      .map((f) => path.join(outDir, f));
    return { ok: true, files, durationMs: Date.now() - started };
  }
}

/** The brand fields the harness sets; everything else is server-owned or left at its default. */
export type BrandSpec = Pick<Brand, "name" | "colors" | "fonts" | "styleKeywords">;

export function sameBrand(brand: BrandSpec, spec: BrandSpec): boolean {
  return (
    brand.name === spec.name &&
    JSON.stringify(Object.entries(brand.colors).sort()) === JSON.stringify(Object.entries(spec.colors).sort()) &&
    brand.fonts.heading === spec.fonts.heading &&
    brand.fonts.body === spec.fonts.body &&
    JSON.stringify(brand.styleKeywords) === JSON.stringify(spec.styleKeywords)
  );
}

function slideNumber(file: string): number {
  const m = file.match(/(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** The carousel's latest creative-run record, read from the runs file (read only). */
export async function readRunRecord(carouselId: string): Promise<Record<string, unknown> | null> {
  try {
    const data = JSON.parse(await readFile(path.join(ROOT, "data", "generation-runs.json"), "utf8"));
    return (data?.creative?.[carouselId] as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

/** The log's current size, so a scenario can read only the lines it caused. */
export async function logOffset(logPath: string): Promise<number> {
  try {
    return (await stat(logPath)).size;
  } catch {
    return 0;
  }
}

export interface LogEntry {
  tag: string;
  fields: Record<string, string | number | boolean | null>;
  /** The scalar fields of the nested objects in `NESTED_OBJECTS`, when the line has them. */
  objects?: Record<string, Record<string, string | number | boolean | null>>;
  /** The string items of the lists in `STRING_LISTS`, when the line has them. */
  lists?: Record<string, string[]>;
}

/** Nested objects read from a log line: the Design Agent's token usage on "run finished". */
const NESTED_OBJECTS = ["designUsage"] as const;

/** Lists of strings read from a log line: what the Director's plan needs that this machine lacks, on "plan finished". */
const STRING_LISTS = ["unavailable"] as const;

const TAGS = [
  "[director] plan finished",
  "[creative-run] planned",
  "[creative-run] sources read",
  "[creative-run] source unavailable",
  "[creative-run] image staged",
  "[creative-run] image failed",
  "[creative-run] image stage finished",
  "[creative-run] retry",
  "[creative-run] blocked",
  "[creative-run] cancelled before design",
  "[chat] run finished",
  "[chat] plan_deviation",
];

/**
 * Reads the structured log lines for one carousel. Node prints the field
 * objects in inspect format, on one line or several; only scalar fields are
 * read, which is all the evidence needs.
 */
export async function logEntries(logPath: string, carouselId: string, fromOffset = 0): Promise<LogEntry[]> {
  let text: string;
  try {
    text = (await readFile(logPath)).subarray(fromOffset).toString("utf8");
  } catch {
    return [];
  }
  const entries: { at: number; entry: LogEntry }[] = [];
  for (const tag of TAGS) {
    let from = 0;
    while (true) {
      const at = text.indexOf(tag, from);
      if (at === -1) break;
      from = at + tag.length;
      const open = text.indexOf("{", from);
      if (open === -1 || text.slice(from, open).trim() !== "") continue;
      const close = matchingBrace(text, open);
      if (close === -1) continue;
      const body = text.slice(open + 1, close);
      const fields = scalarFields(body);
      if (fields.carouselId !== carouselId) continue;
      const objects: NonNullable<LogEntry["objects"]> = {};
      for (const key of NESTED_OBJECTS) {
        const nested = nestedObject(body, key);
        if (nested) objects[key] = nested;
      }
      const lists: NonNullable<LogEntry["lists"]> = {};
      for (const key of STRING_LISTS) {
        const list = stringList(body, key);
        if (list) lists[key] = list;
      }
      entries.push({ at, entry: { tag, fields, ...(Object.keys(objects).length ? { objects } : {}), ...(Object.keys(lists).length ? { lists } : {}) } });
    }
  }
  return entries.sort((a, b) => a.at - b.at).map((e) => e.entry);
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The scalar fields of `key: { ... }` at the top level of a log line's object, or null. */
function nestedObject(body: string, key: string): LogEntry["fields"] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (depth === 0 && body.startsWith(`${key}:`, i) && (i === 0 || /[\s,]/.test(body[i - 1]))) {
      const rest = body.slice(i + key.length + 1);
      const open = rest.search(/\S/);
      if (open === -1 || rest[open] !== "{") return null;
      const close = matchingBrace(rest, open);
      return close === -1 ? null : scalarFields(rest.slice(open + 1, close));
    }
  }
  return null;
}

/** The quoted items of `key: [ ... ]` at the top level of a log line's object, or null. */
function stringList(body: string, key: string): string[] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (depth === 0 && body.startsWith(`${key}:`, i) && (i === 0 || /[\s,]/.test(body[i - 1]))) {
      const rest = body.slice(i + key.length + 1);
      const open = rest.search(/\S/);
      if (open === -1 || rest[open] !== "[") return null;
      const close = matchingBrace(rest, open);
      if (close === -1) return null;
      return [...rest.slice(open + 1, close).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, "$1"));
    }
  }
  return null;
}

function scalarFields(body: string): LogEntry["fields"] {
  const fields: LogEntry["fields"] = {};
  const re = /(?:^|[\s{,])(\w+): ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|true|false|null|undefined)/g;
  for (const m of body.matchAll(re)) {
    const [, key, raw] = m;
    if (key in fields) continue; // the first (top-level) occurrence wins
    if (raw.startsWith("'") || raw.startsWith('"')) fields[key] = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    else if (raw === "true" || raw === "false") fields[key] = raw === "true";
    else if (raw === "null" || raw === "undefined") fields[key] = null;
    else fields[key] = Number(raw);
  }
  return fields;
}

export interface ServerCosts {
  directorCostUsd: number | null;
  directorMs: number | null;
  /** The Director's CLI turns; its token counts are not in the server's records. */
  directorTurns: number | null;
  /** Director calls the log shows (one "planned" line each), and the cost each one carried (a call without one has no entry). */
  directorRuns: number;
  directorCallCosts: number[];
  directorPlan: LogEntry["fields"] | null;
  designCostUsd: number | null;
  designMs: number | null;
  /** The Design Agent's model token usage, summed over its runs, from the server's "run finished" lines. */
  designUsage: TokenUsage | null;
  designTurns: number | null;
  /** Design runs whose line carried no usage (for example, the CLI never reported a result). */
  designRunsWithoutUsage: number;
  /**
   * Design runs the log shows (one "run finished" line each), and the numeric
   * cost each one carried. The cost and the usage are separate fields of the
   * line, so settlement counts by cost; the sums above hide a run without one
   * and a run above its limit.
   */
  designRuns: number;
  designCallCosts: number[];
  imagesStaged: number;
  imageMs: number[];
  imageFailures: LogEntry["fields"][];
  retries: LogEntry["fields"][];
  entries: LogEntry[];
}

/** Best-effort cost and timing evidence for one carousel from the server log. */
export async function serverCosts(logPath: string, carouselId: string, fromOffset = 0): Promise<ServerCosts> {
  const entries = await logEntries(logPath, carouselId, fromOffset);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const sum = (values: (number | null)[]) => {
    const present = values.filter((v): v is number => v !== null);
    return present.length ? present.reduce((a, b) => a + b, 0) : null;
  };
  const planned = entries.filter((e) => e.tag === "[creative-run] planned");
  const finished = entries.filter((e) => e.tag === "[chat] run finished");
  const staged = entries.filter((e) => e.tag === "[creative-run] image staged");
  const director = entries.filter((e) => e.tag === "[director] plan finished");
  const designed = finished.filter((e) => e.fields.stage === "design");
  const usages = designed.map((e) => usageFromCli(e.objects?.designUsage));
  return {
    directorCostUsd: sum(planned.map((e) => num(e.fields.costUsd))),
    directorMs: sum(planned.map((e) => num(e.fields.durationMs))),
    directorTurns: sum(planned.map((e) => num(e.fields.turns))),
    directorRuns: planned.length,
    directorCallCosts: planned.map((e) => num(e.fields.costUsd)).filter((v): v is number => v !== null),
    directorPlan: director.at(-1)?.fields ?? null,
    designCostUsd: sum(finished.map((e) => num(e.fields.designCostUsd))),
    designMs: sum(finished.map((e) => num(e.fields.designDurationMs))),
    designUsage: addUsage(usages),
    designTurns: sum(designed.map((e) => num(e.fields.designTurns))),
    designRunsWithoutUsage: usages.filter((u) => !u).length,
    designRuns: designed.length,
    designCallCosts: designed.map((e) => num(e.fields.designCostUsd)).filter((v): v is number => v !== null),
    imagesStaged: staged.length,
    imageMs: staged.map((e) => num(e.fields.durationMs) ?? 0),
    imageFailures: entries.filter((e) => e.tag === "[creative-run] image failed").map((e) => e.fields),
    retries: entries.filter((e) => e.tag === "[creative-run] retry").map((e) => e.fields),
    entries,
  };
}
