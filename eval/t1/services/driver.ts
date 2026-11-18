/**
 * The driver (#225): plays the operator against the app's public API on its
 * main port, from the observer container (which shares the subject's network
 * namespace but not its processes or files). Every request carries the run's
 * nonce in `X-T1-Driver`, which the subject never sees, so the capture can
 * tell the driver's requests from the subject's. A model phase ends at the
 * app's own `done` or `error` event or at the deadline; the driver records
 * which, the session the app returned and the canaries, by id, the stream
 * disclosed, never the stream itself.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { matchCanaries, type CanaryValues } from "../lib/scrub";
import { RAW, RECORDS, type HarnessConfig } from "./common";

export interface DriverState {
  brandId: string;
  otherBrandId: string;
  runCarouselId: string;
  otherCarouselId: string;
}

interface Reply {
  status: number;
  body: string;
}

function call(cfg: HarnessConfig, nonce: string, method: string, url: string, body?: unknown, timeoutMs = 30_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: "127.0.0.1",
        port: cfg.appPort,
        method,
        path: url,
        // The nonce goes first so it sits in the request's first segment.
        headers: { "X-T1-Driver": nonce, Host: `127.0.0.1:${cfg.appPort}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for the app, then creates the synthetic brands and the two carousels through the public API. */
export async function setup(cfg: HarnessConfig, nonce: string): Promise<DriverState> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      if ((await call(cfg, nonce, "GET", "/api/brands", undefined, 5000)).status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("the app did not answer within 180 s");
    await sleep(1000);
  }
  const create = async (url: string, body: unknown) => {
    const r = await call(cfg, nonce, "POST", url, body);
    if (r.status !== 201) throw new Error(`POST ${url} answered ${r.status}`);
    return (JSON.parse(r.body) as { id: string }).id;
  };
  const brandId = await create("/api/brands", {
    name: "T1 Synthetic Brand",
    colors: { primary: "#14213d", secondary: "#fca311", accent: "#e63946", background: "#ffffff", surface: "#f1faee" },
    fonts: { heading: "Inter", body: "Inter" },
  });
  const otherBrandId = await create("/api/brands", { name: "T1 Other Brand" });
  const runCarouselId = await create("/api/carousels", { name: "T1 run carousel", brandId, aspectRatio: "4:5" });
  const otherCarouselId = await create("/api/carousels", { name: "T1 other carousel", brandId, aspectRatio: "4:5" });
  const state = { brandId, otherBrandId, runCarouselId, otherCarouselId };
  writeFileSync(path.join(RAW, "driver-state.json"), JSON.stringify(state, null, 2));
  return state;
}

export function readState(): DriverState {
  return JSON.parse(readFileSync(path.join(RAW, "driver-state.json"), "utf8")) as DriverState;
}

export interface ChatRecord {
  phase: string;
  status: "done" | "error" | "timeout" | "http_error";
  httpStatus: number;
  errorCode: string | null;
  sessionId: string | null;
  startedAt: number;
  endedAt: number;
  events: Record<string, number>;
  stages: string[];
  disclosed: string[];
}

/**
 * Sends one chat message and follows the app's event stream to its `done`
 * event (after an `error`, if any) or the deadline. The message text is the
 * harness's own file in the records folder.
 */
export function chat(cfg: HarnessConfig, nonce: string, canaries: CanaryValues, phase: string, messageFile: string, resumeFrom: string | null): Promise<ChatRecord> {
  const state = readState();
  const message = readFileSync(path.join(RECORDS, "config", messageFile), "utf8");
  const sessionId = resumeFrom ? (JSON.parse(readFileSync(path.join(RAW, `driver-${resumeFrom}.json`), "utf8")) as ChatRecord).sessionId : null;
  const body = Buffer.from(JSON.stringify({ message, carouselId: state.runCarouselId, ...(sessionId ? { sessionId } : {}) }));
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const rec: ChatRecord = { phase, status: "timeout", httpStatus: 0, errorCode: null, sessionId: null, startedAt, endedAt: 0, events: {}, stages: [], disclosed: [] };
    const disclosed = new Set<string>();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rec.endedAt = Date.now();
      rec.disclosed = [...disclosed].sort();
      writeFileSync(path.join(RAW, `driver-${phase}.json`), JSON.stringify(rec, null, 2));
      resolve(rec);
    };
    const req = request(
      {
        host: "127.0.0.1",
        port: cfg.appPort,
        method: "POST",
        path: "/api/chat",
        headers: { "X-T1-Driver": nonce, Host: `127.0.0.1:${cfg.appPort}`, "Content-Type": "application/json", "Content-Length": String(body.length) },
      },
      (res) => {
        rec.httpStatus = res.statusCode ?? 0;
        if (rec.httpStatus !== 200) {
          rec.status = "http_error";
          res.resume();
          res.on("end", settle);
          return;
        }
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            for (const id of matchCanaries(data, canaries)) disclosed.add(id);
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }
            const type = String(ev.type ?? "?");
            rec.events[type] = (rec.events[type] ?? 0) + 1;
            if (type === "stage" && typeof ev.stage === "string") rec.stages.push(ev.stage);
            if (type === "error" && rec.errorCode === null) rec.errorCode = typeof ev.code === "string" ? ev.code : "unknown";
            if (type === "done") {
              rec.sessionId = typeof ev.sessionId === "string" ? ev.sessionId : null;
              rec.status = rec.errorCode ? "error" : "done";
              settle();
              req.destroy();
            }
          }
        });
        res.on("end", settle);
        res.on("error", settle);
      },
    );
    req.on("error", settle);
    const timer = setTimeout(() => {
      rec.status = "timeout";
      settle();
      req.destroy();
    }, cfg.phaseDeadlineSeconds * 1000);
    req.end(body);
  });
}
