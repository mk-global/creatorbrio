import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import zlib from "node:zlib";
import { bareHost, isPublicAddress, parseSourceUrl, type SourceUrlRefusal } from "./source-address";
import { extractPlainText, extractText } from "./source-text";

/**
 * Bounded retrieval of the pages a user linked to, as planning material for
 * the Visual Director. It is a library only: no route exposes it.
 *
 * Every hop is validated as a new URL (http or https, default port, no
 * credentials), its host is resolved once and every address must be public
 * unicast, and the connection is made to that validated address, so a
 * resolver cannot move it elsewhere afterwards. No cookies or authorization
 * are sent. Each source is bounded in time and size, and so is the stage.
 */

export const MAX_SOURCES = 3;
export const MAX_REDIRECTS = 3;
export const MIN_SOURCE_TEXT_CHARS = 200;

export interface RetrievalLimits {
  perSourceMs: number;
  stageMs: number;
  maxBodyBytes: number;
}

export const DEFAULT_LIMITS: RetrievalLimits = {
  perSourceMs: 10_000,
  stageMs: 30_000,
  maxBodyBytes: 2 * 1024 * 1024,
};

const USER_AGENT = "CreatorBrio-SourceRetrieval/1.0";
const ACCEPTED_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);

export type SourceUnavailableReason =
  | SourceUrlRefusal
  | "unresolvable_host"
  | "non_public_address"
  | "too_many_redirects"
  | "http_status"
  | "unsupported_content_type"
  | "unsupported_encoding"
  | "too_large"
  | "timed_out"
  | "stage_timed_out"
  | "network_error"
  | "too_little_text";

export type SourceOutcome =
  | { url: string; host: string; ok: true; title: string; text: string; truncated: boolean }
  | { url: string; host: string; ok: false; reason: SourceUnavailableReason };

/** What the Director receives for the links in one user message. */
export type SourceRetrieval =
  | { status: "none" }
  | { status: "too_many_sources"; count: number }
  | { status: "retrieved"; sources: SourceOutcome[] };

/** How to reach a validated address. Tests replace it; production connects directly. */
export type Dial = (target: { address: string; port: number; tls: boolean; servername: string }) => Duplex;

export interface RetrievalOptions {
  resolve?: (host: string) => Promise<string[]>;
  dial?: Dial;
  limits?: Partial<RetrievalLimits>;
}

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const defaultDial: Dial = ({ address, port, tls: secure, servername }) =>
  secure
    ? tls.connect({ host: address, port, servername: isIP(servername) ? undefined : servername, ALPNProtocols: ["http/1.1"] })
    : net.connect({ host: address, port });

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** The distinct http(s) links in a message, in order, without trailing punctuation. */
export function findSourceLinks(message: string): string[] {
  const links: string[] = [];
  for (const match of message.matchAll(URL_IN_TEXT)) {
    let link = match[0].replace(/[.,;:!?'")\]}>]+$/, "");
    // Keep a closing parenthesis that belongs to the URL itself.
    if (match[0].length > link.length && link.includes("(") && match[0][link.length] === ")") link += ")";
    if (!links.includes(link)) links.push(link);
  }
  return links;
}

class Unavailable extends Error {
  constructor(readonly reason: SourceUnavailableReason) {
    super(reason);
  }
}

/** Validates one hop and returns the single address to connect to. */
async function validateHop(raw: string, resolve: (host: string) => Promise<string[]>) {
  const parsed = parseSourceUrl(raw);
  if (!parsed.ok) throw new Unavailable(parsed.reason);
  const host = bareHost(parsed.url);
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new Unavailable("unresolvable_host");
    }
  }
  if (addresses.length === 0) throw new Unavailable("unresolvable_host");
  // Every answer must be public, so no answer can be swapped in later.
  if (!addresses.every(isPublicAddress)) throw new Unavailable("non_public_address");
  return { url: parsed.url, address: addresses[0] };
}

interface Response {
  status: number;
  location: string | null;
  contentType: string;
  charset: string | null;
  body: Buffer;
}

/** A streaming decoder for the body's encoding; its output is counted against the size limit. */
function decoderFor(encoding: string | undefined) {
  switch ((encoding ?? "identity").trim().toLowerCase()) {
    case "identity":
    case "":
      return null;
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      throw new Unavailable("unsupported_encoding");
  }
}

/** One GET over a socket to the validated address; redirects are not followed here. */
function get(url: URL, address: string, dial: Dial, signal: AbortSignal, maxBytes: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const port = secure ? 443 : 80;
    const request = (secure ? https : http).request({
      method: "GET",
      host: bareHost(url),
      port,
      path: `${url.pathname}${url.search}`,
      headers: {
        Host: url.host,
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
      // The socket goes to the validated address; the client never resolves the host itself.
      createConnection: () => dial({ address, port, tls: secure, servername: bareHost(url) }),
      signal,
    });
    request.on("error", reject);
    // Settle however the exchange ends, so a stalled or dropped body cannot hang the stage.
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    request.on("response", (res) => {
      res.on("close", () => {
        if (!res.complete) reject(new Error("incomplete response"));
      });
      const status = res.statusCode ?? 0;
      const [mime, ...params] = (res.headers["content-type"] ?? "").split(";");
      const charset = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith("charset="))?.slice(8) ?? null;
      const base = {
        status,
        location: typeof res.headers.location === "string" ? res.headers.location : null,
        contentType: mime.trim().toLowerCase(),
        charset: charset?.replace(/"/g, "") ?? null,
      };
      // Only a 200 page of an accepted type has a body worth reading.
      if (status !== 200 || !ACCEPTED_TYPES.has(base.contentType)) {
        res.resume();
        resolve({ ...base, body: Buffer.alloc(0) });
        return;
      }
      if (Number(res.headers["content-length"]) > maxBytes && !res.headers["content-encoding"]) {
        request.destroy();
        reject(new Unavailable("too_large"));
        return;
      }
      let stream: NodeJS.ReadableStream & { destroy(): void } = res;
      try {
        const decoder = decoderFor(res.headers["content-encoding"]);
        if (decoder) {
          res.pipe(decoder);
          res.on("error", (err) => decoder.destroy(err));
          stream = decoder;
        }
      } catch (err) {
        request.destroy();
        reject(err);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          // Stop decoding at once: a small compressed body can expand without bound.
          reject(new Unavailable("too_large"));
          stream.destroy();
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve({ ...base, body: Buffer.concat(chunks) }));
    });
    request.end();
  });
}

function decodeBody(body: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

async function retrieveOne(
  link: string,
  resolve: (host: string) => Promise<string[]>,
  dial: Dial,
  limits: RetrievalLimits,
  stage: AbortSignal
): Promise<SourceOutcome & { redirects: number; bytes: number }> {
  const signal = AbortSignal.any([stage, AbortSignal.timeout(limits.perSourceMs)]);
  let host = "";
  let redirects = 0;
  let bytes = 0;
  const fail = (reason: SourceUnavailableReason) => ({ url: link, host, ok: false as const, reason, redirects, bytes });
  try {
    // The linked host names the source in outcomes and logs, even when it is refused.
    host = new URL(link).hostname;
  } catch {
    // Reported below as an invalid URL.
  }
  try {
    let current = link;
    for (;;) {
      const hop = await validateHop(current, resolve);
      if (signal.aborted) throw signal.reason;
      const res = await get(hop.url, hop.address, dial, signal, limits.maxBodyBytes);
      if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
        if (redirects === MAX_REDIRECTS) return fail("too_many_redirects");
        redirects++;
        current = new URL(res.location, hop.url).href;
        continue;
      }
      if (res.status !== 200) return fail("http_status");
      if (!ACCEPTED_TYPES.has(res.contentType)) return fail("unsupported_content_type");
      bytes = res.body.length;
      const decoded = decodeBody(res.body, res.charset);
      const extracted = res.contentType === "text/plain" ? extractPlainText(decoded) : extractText(decoded);
      if (extracted.text.length < MIN_SOURCE_TEXT_CHARS) return fail("too_little_text");
      return { url: link, host, ok: true, ...extracted, redirects, bytes };
    }
  } catch (err) {
    if (err instanceof Unavailable) return fail(err.reason);
    if (stage.aborted) return fail("stage_timed_out");
    if (signal.aborted) return fail("timed_out");
    return fail("network_error");
  }
}

/**
 * Retrieves the sources linked in one user message. More than
 * `MAX_SOURCES` links are refused before any request is made. Logs carry
 * the host, outcome, counts and duration only, never a path, query or text.
 */
export async function retrieveSources(message: string, options: RetrievalOptions = {}): Promise<SourceRetrieval> {
  const links = findSourceLinks(message);
  if (links.length === 0) return { status: "none" };
  if (links.length > MAX_SOURCES) {
    console.info("[sources] refused", { outcome: "too_many_sources", count: links.length });
    return { status: "too_many_sources", count: links.length };
  }
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const resolve = options.resolve ?? defaultResolve;
  const dial = options.dial ?? defaultDial;
  const stage = AbortSignal.timeout(limits.stageMs);

  const sources = await Promise.all(
    links.map(async (link) => {
      const started = Date.now();
      const { redirects, bytes, ...outcome } = await retrieveOne(link, resolve, dial, limits, stage);
      console.info("[sources] source", {
        host: outcome.host || null,
        outcome: outcome.ok ? "retrieved" : outcome.reason,
        redirects,
        bytes,
        chars: outcome.ok ? outcome.text.length : 0,
        durationMs: Date.now() - started,
      });
      return outcome;
    })
  );
  return { status: "retrieved", sources };
}
