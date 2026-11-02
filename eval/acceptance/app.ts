import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createChatStreamParser, type ChatStreamEvent } from "@/lib/chat-stream";
import type { AspectRatio, Carousel } from "@/types/carousel";
import { ROOT } from "./server";

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

export class AppClient {
  constructor(readonly origin: string) {}

  private headers(json = true): Record<string, string> {
    // Same-origin, like the app's own pages.
    return { Origin: this.origin, ...(json ? { "Content-Type": "application/json" } : {}) };
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async createCarousel(name: string, aspectRatio: AspectRatio): Promise<Carousel> {
    const res = await fetch(`${this.origin}/api/carousels`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name, aspectRatio }),
    });
    return this.json<Carousel>(res, "create carousel");
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

  /** Sends one chat message and reads the whole event stream. Never throws for stream problems. */
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

    try {
      const res = await fetch(`${this.origin}/api/chat`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          message: body.message,
          carouselId: body.carouselId,
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
          ...(body.retryRunId ? { retryRunId: body.retryRunId } : {}),
        }),
        signal: controller.signal,
      });
      result.httpStatus = res.status;
      if (!res.ok || !res.body) {
        result.httpError = (await res.text()).slice(0, 500);
        return result;
      }
      const parser = createChatStreamParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) handle(event);
      }
      for (const event of parser.end()) handle(event);
      if (!sawDone) result.streamError = "stream ended without a done event";
    } catch (err) {
      if (!result.aborted) result.streamError = (err as Error).message;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
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
}

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
      const fields = scalarFields(text.slice(open + 1, close));
      if (fields.carouselId === carouselId) entries.push({ at, entry: { tag, fields } });
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
  directorPlan: LogEntry["fields"] | null;
  designCostUsd: number | null;
  designMs: number | null;
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
  return {
    directorCostUsd: sum(planned.map((e) => num(e.fields.costUsd))),
    directorMs: sum(planned.map((e) => num(e.fields.durationMs))),
    directorPlan: director.at(-1)?.fields ?? null,
    designCostUsd: sum(finished.map((e) => num(e.fields.designCostUsd))),
    designMs: sum(finished.map((e) => num(e.fields.designDurationMs))),
    imagesStaged: staged.length,
    imageMs: staged.map((e) => num(e.fields.durationMs) ?? 0),
    imageFailures: entries.filter((e) => e.tag === "[creative-run] image failed").map((e) => e.fields),
    retries: entries.filter((e) => e.tag === "[creative-run] retry").map((e) => e.fields),
    entries,
  };
}
