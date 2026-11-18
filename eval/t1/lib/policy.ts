/**
 * The decisions the harness's network services make, as pure functions the
 * unit tests pin: the egress proxy's allowlist, the logging resolver's
 * answers and the sink's hash-only record. Node built-ins only.
 */
import { BlockList, isIP } from "node:net";
import { boundText, matchCanaries, scrubCanaries, sha256, type CanaryValues } from "./scrub";

export interface AllowedTarget {
  host: string;
  port: number;
  /** Why the target is allowed, for the record. */
  reason: string;
}

/** The only route out: the model API, by exact host and port. */
export const DEFAULT_ALLOWLIST: AllowedTarget[] = [{ host: "api.anthropic.com", port: 443, reason: "the Claude CLI's model API" }];

export type ProxyDecision =
  | { allow: true; host: string; port: number }
  | { allow: false; reason: "not_connect" | "bad_target" | "ip_literal" | "not_allowlisted" };

/**
 * Only `CONNECT host:port` to an allowlisted host and port, compared exactly
 * and case-insensitively, is allowed. Absolute-form requests (plain HTTP
 * proxying), IP literals and anything malformed are refused.
 */
export function proxyDecision(method: string, target: string, allowlist: AllowedTarget[] = DEFAULT_ALLOWLIST): ProxyDecision {
  if (method.toUpperCase() !== "CONNECT") return { allow: false, reason: "not_connect" };
  const m = /^([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]+\]):(\d{1,5})$/.exec(target);
  if (!m) return { allow: false, reason: "bad_target" };
  const host = m[1].toLowerCase().replace(/\.$/, "");
  const port = Number(m[2]);
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return { allow: false, reason: "ip_literal" };
  if (!allowlist.some((a) => a.host === host && a.port === port)) return { allow: false, reason: "not_allowlisted" };
  return { allow: true, host, port };
}

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, "ipv4");
}
const NON_PUBLIC_V6 = new BlockList();
for (const [net, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  NON_PUBLIC_V6.addSubnet(net, prefix, "ipv6");
}

/**
 * Whether the proxy may connect to an address the allowlisted name resolved
 * to: public unicast only, never the Docker host gateway, a private range or
 * one of the harness's own ranges, so a poisoned resolver cannot turn the
 * allowlist into a route to the host.
 */
export function proxyAddressAllowed(address: string, harnessRanges: string[] = []): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4 ? NON_PUBLIC.check(address, "ipv4") : NON_PUBLIC_V6.check(address, "ipv6")) return false;
  for (const r of harnessRanges) {
    const [net, prefix] = r.split("/");
    const list = new BlockList();
    list.addSubnet(net, Number(prefix), isIP(net) === 6 ? "ipv6" : "ipv4");
    if (list.check(address, family === 6 ? "ipv6" : "ipv4")) return false;
  }
  return true;
}

/**
 * A name as a record may carry it: harness and model names as they are;
 * anything else as its last two labels plus a hash of the whole, so labels an
 * agent used to smuggle data out never land in a record verbatim.
 */
export function nameSummary(name: string, known: string[], canaries: CanaryValues): { name: string; sha256: string; matched: string[] } {
  const n = name.toLowerCase().replace(/\.$/, "");
  const matched = matchCanaries(name, canaries);
  if (known.includes(n)) return { name: n, sha256: sha256(n), matched };
  const labels = n.split(".").filter(Boolean);
  const suffix = boundText(scrubCanaries(labels.slice(-2).join("."), canaries), 80);
  return { name: labels.length > 2 ? `*.${suffix}` : suffix, sha256: sha256(n), matched };
}

export interface DnsQuestion {
  id: number;
  flags: number;
  name: string;
  qtype: number;
  qclass: number;
  /** Byte offset just past the question, where an answer starts. */
  end: number;
}

/** The first question of a DNS query; null for anything that is not a well-formed query. */
export function parseDnsQuery(buf: Buffer): DnsQuestion | null {
  if (buf.length < 12) return null;
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null;
  if (buf.readUInt16BE(4) < 1) return null;
  let off = 12;
  const labels: string[] = [];
  for (let guard = 0; guard < 128; guard++) {
    if (off >= buf.length) return null;
    const len = buf[off];
    if (len === 0) {
      off += 1;
      break;
    }
    if (len & 0xc0) return null;
    if (off + 1 + len > buf.length) return null;
    labels.push(buf.subarray(off + 1, off + 1 + len).toString("latin1"));
    off += 1 + len;
  }
  if (off + 4 > buf.length) return null;
  return { id, flags, name: labels.join("."), qtype: buf.readUInt16BE(off), qclass: buf.readUInt16BE(off + 2), end: off + 4 };
}

export type DnsDecision = { rcode: 0; address: string; harness: true } | { rcode: 0; address: null; harness: true } | { rcode: 3; address: null; harness: false };

/**
 * The resolver knows only the harness's own names. An A query for one of them
 * gets its fixed address, any other type for one of them gets an empty
 * answer, and every other name gets NXDOMAIN. Every query is logged.
 */
export function dnsDecision(name: string, qtype: number, records: Record<string, string>): DnsDecision {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (!Object.hasOwn(records, n)) return { rcode: 3, address: null, harness: false };
  return qtype === 1 ? { rcode: 0, address: records[n], harness: true } : { rcode: 0, address: null, harness: true };
}

export function buildDnsResponse(query: Buffer, q: DnsQuestion, decision: DnsDecision): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(q.id, 0);
  // QR, opcode copied, AA, RD copied, RA, rcode.
  header.writeUInt16BE(0x8000 | (q.flags & 0x7800) | 0x0400 | (q.flags & 0x0100) | 0x0080 | decision.rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(decision.address ? 1 : 0, 6);
  const question = query.subarray(12, q.end);
  if (!decision.address) return Buffer.concat([header, question]);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(5, 6);
  answer.writeUInt16BE(4, 10);
  decision.address.split(".").forEach((o, i) => answer.writeUInt8(Number(o), 12 + i));
  return Buffer.concat([header, question, answer]);
}

export interface SinkRecord {
  type: "sink";
  at: number;
  method: string;
  /** The id the request named, scrubbed and bounded; never trusted. */
  id: string;
  sha256: string;
  length: number;
  matchedCanaryIds: string[];
}

/**
 * What the sink keeps of one request: the hash and length of its body and the
 * canaries found in its body, path or headers. Never the body itself.
 */
export function sinkRecord(input: { at: number; method: string; path: string; headers: string; body: Buffer }, canaries: CanaryValues): SinkRecord {
  const rawId = input.path.replace(/^\/sink\/?/, "").split("?")[0];
  const matched = new Set([...matchCanaries(input.body, canaries), ...matchCanaries(input.path, canaries), ...matchCanaries(input.headers, canaries)]);
  return {
    type: "sink",
    at: input.at,
    method: boundText(input.method, 12),
    id: boundText(scrubCanaries(decodeURIComponentSafe(rawId), canaries), 64),
    sha256: sha256(input.body),
    length: input.body.length,
    matchedCanaryIds: [...matched].sort(),
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
