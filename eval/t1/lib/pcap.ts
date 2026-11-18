/**
 * A minimal reader for the classic pcap format and the T1 summary of a
 * capture: new outbound flows (loopback, harness, external) and the app's
 * main-port HTTP requests with their driver attribution. The capture stays in
 * the observer container; only this summary reaches the records, with canary
 * values replaced and no payload kept. Node built-ins only.
 */
import { isIP } from "node:net";
import { boundText, matchCanaries, scrubCanaries, type CanaryValues } from "./scrub";

export interface Packet {
  /** Epoch milliseconds. */
  at: number;
  family: 4 | 6;
  proto: "tcp" | "udp" | "icmp" | "other";
  src: string;
  dst: string;
  sport: number;
  dport: number;
  /** TCP flags byte (0 for other protocols), or the ICMP type. */
  flags: number;
  seq: number;
  payload: Buffer;
}

const TCP_SYN = 0x02;
const TCP_ACK = 0x10;

function ipv4(b: Buffer, o: number): string {
  return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
}

function ipv6(b: Buffer, o: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(o + i).toString(16));
  // Compress the longest run of zero groups.
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (parts[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && parts[j] === "0") j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return parts.join(":");
  return `${parts.slice(0, best).join(":")}::${parts.slice(best + bestLen).join(":")}`;
}

function transport(b: Buffer, o: number, end: number, proto: number, base: Omit<Packet, "proto" | "sport" | "dport" | "flags" | "seq" | "payload">): Packet {
  if (proto === 6 && o + 20 <= end) {
    const off = (b[o + 12] >> 4) * 4;
    return { ...base, proto: "tcp", sport: b.readUInt16BE(o), dport: b.readUInt16BE(o + 2), seq: b.readUInt32BE(o + 4), flags: b[o + 13], payload: b.subarray(Math.min(o + off, end), end) };
  }
  if (proto === 17 && o + 8 <= end) {
    return { ...base, proto: "udp", sport: b.readUInt16BE(o), dport: b.readUInt16BE(o + 2), seq: 0, flags: 0, payload: b.subarray(o + 8, end) };
  }
  if ((proto === 1 || proto === 58) && o + 1 <= end) {
    return { ...base, proto: "icmp", sport: 0, dport: 0, seq: 0, flags: b[o], payload: Buffer.alloc(0) };
  }
  return { ...base, proto: "other", sport: 0, dport: 0, seq: 0, flags: proto, payload: Buffer.alloc(0) };
}

function network(b: Buffer, o: number, end: number, ethertype: number, at: number): Packet | null {
  if (ethertype === 0x0800 && o + 20 <= end) {
    const ihl = (b[o] & 0x0f) * 4;
    const total = Math.min(b.readUInt16BE(o + 2) || end - o, end - o);
    const fragOffset = b.readUInt16BE(o + 6) & 0x1fff;
    if (fragOffset !== 0) return null;
    return transport(b, o + ihl, o + total, b[o + 9], { at, family: 4, src: ipv4(b, o + 12), dst: ipv4(b, o + 16) });
  }
  if (ethertype === 0x86dd && o + 40 <= end) {
    const payloadLen = b.readUInt16BE(o + 4);
    return transport(b, o + 40, Math.min(o + 40 + payloadLen, end), b[o + 6], { at, family: 6, src: ipv6(b, o + 8), dst: ipv6(b, o + 24) });
  }
  return null;
}

/**
 * Parses a classic pcap file (either byte order, micro- or nanosecond
 * timestamps) captured on Linux `any` (SLL or SLL2), Ethernet, BSD loopback
 * (macOS `lo0`) or raw IP. Packets of other types are skipped.
 */
export function parsePcap(buf: Buffer): Packet[] {
  if (buf.length < 24) return [];
  const magicLE = buf.readUInt32LE(0);
  let le: boolean;
  let nano = false;
  if (magicLE === 0xa1b2c3d4) le = true;
  else if (magicLE === 0xa1b23c4d) {
    le = true;
    nano = true;
  } else if (buf.readUInt32BE(0) === 0xa1b2c3d4) le = false;
  else if (buf.readUInt32BE(0) === 0xa1b23c4d) {
    le = false;
    nano = true;
  } else return [];
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const linktype = u32(20) & 0x0fffffff;
  const out: Packet[] = [];
  let off = 24;
  while (off + 16 <= buf.length) {
    const sec = u32(off);
    const frac = u32(off + 4);
    const caplen = u32(off + 8);
    const start = off + 16;
    const end = start + caplen;
    if (end > buf.length) break;
    off = end;
    const at = sec * 1000 + (nano ? frac / 1e6 : frac / 1e3);
    let p: Packet | null = null;
    if (linktype === 113 && caplen >= 16) p = network(buf, start + 16, end, buf.readUInt16BE(start + 14), at);
    else if (linktype === 276 && caplen >= 20) p = network(buf, start + 20, end, buf.readUInt16BE(start), at);
    else if (linktype === 1 && caplen >= 14) {
      let et = buf.readUInt16BE(start + 12);
      let o = start + 14;
      if (et === 0x8100 && caplen >= 18) {
        et = buf.readUInt16BE(start + 16);
        o += 4;
      }
      p = network(buf, o, end, et, at);
    } else if (linktype === 0 && caplen >= 4) {
      const family = le ? buf.readUInt32LE(start) : buf.readUInt32BE(start);
      p = network(buf, start + 4, end, family === 2 ? 0x0800 : 0x86dd, at);
    } else if (linktype === 101 || linktype === 12 || linktype === 228 || linktype === 229) {
      const v = buf[start] >> 4;
      p = network(buf, start, end, v === 6 ? 0x86dd : 0x0800, at);
    }
    if (p) out.push(p);
  }
  return out;
}

export interface PacketContext {
  appPort: number;
  /** The subject namespace's own non-loopback addresses. */
  localAddresses: string[];
  /** Resolver addresses the system itself uses (Docker's embedded resolver); not attempts of their own. */
  resolverAddresses: string[];
  /** Harness endpoints the subject is meant to reach, judged by those services' own logs. */
  harnessEndpoints: { address: string; port: number; proto: "tcp" | "udp" }[];
  nonce: string;
  canaries: CanaryValues;
}

export interface FlowAttempt {
  at: number;
  proto: "tcp" | "udp" | "icmp" | "other";
  family: 4 | 6;
  src: string;
  dst: string;
  sport: number;
  dport: number;
  kind: "loopback" | "harness" | "external";
}

export interface AppRequest {
  at: number;
  flow: string;
  method: string;
  path: string;
  driver: boolean;
  credential: boolean;
  matched: string[];
}

export interface AppFlow {
  at: number;
  flow: string;
  /** True when a request on this connection carried the driver's nonce. */
  driver: boolean;
  requests: number;
}

export interface PacketSummary {
  attempts: FlowAttempt[];
  appRequests: AppRequest[];
  appFlows: AppFlow[];
}

export const isLoopback = (a: string) => a === "::1" || (isIP(a) === 4 && a.startsWith("127."));

const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE) (\S{1,4096}) HTTP\/1\.[01]\r?\n/;

/** The request path as a record keeps it: no query, long segments hashed down, canaries replaced. */
export function sanitizePath(raw: string, canaries: CanaryValues): string {
  const pathOnly = raw.split("?")[0].split("#")[0];
  const segs = pathOnly.split("/").map((s) => (s.length > 64 ? `<${s.length} chars>` : s));
  return boundText(scrubCanaries(segs.join("/"), canaries), 160);
}

/**
 * Turns a capture into flow attempts and app requests. A flow attempt is a
 * TCP SYN, the first datagram of a UDP flow that is not a reply, or an
 * outbound ICMP echo, sent from one of the namespace's own addresses.
 * Duplicate copies of one packet (a loopback packet seen on both sides) are
 * counted once.
 */
export function summarizePackets(packets: Packet[], ctx: PacketContext): PacketSummary {
  const local = new Set(ctx.localAddresses);
  const isLocal = (a: string) => isLoopback(a) || local.has(a);
  const seen = new Set<string>();
  const udpFlows = new Set<string>();
  const attempts: FlowAttempt[] = [];
  const appRequests: AppRequest[] = [];
  const flows = new Map<string, AppFlow>();
  const resolver = new Set(ctx.resolverAddresses);
  const harness = (dst: string, dport: number, proto: string) => ctx.harnessEndpoints.some((e) => e.address === dst && e.port === dport && e.proto === proto);

  for (const p of packets) {
    const key = `${p.proto}|${p.src}|${p.sport}|${p.dst}|${p.dport}|${p.flags}|${p.seq}|${p.payload.length}|${p.payload.subarray(0, 32).toString("hex")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isLocal(p.src)) continue;
    const flow = `${p.src}:${p.sport}>${p.dst}:${p.dport}`;
    const kind = (): FlowAttempt["kind"] => (isLocal(p.dst) ? "loopback" : harness(p.dst, p.dport, p.proto) ? "harness" : "external");

    if (p.proto === "tcp") {
      if ((p.flags & TCP_SYN) && !(p.flags & TCP_ACK) && !resolver.has(p.dst)) {
        attempts.push({ at: p.at, proto: "tcp", family: p.family, src: p.src, dst: p.dst, sport: p.sport, dport: p.dport, kind: kind() });
        if (isLocal(p.dst) && p.dport === ctx.appPort) flows.set(flow, { at: p.at, flow, driver: false, requests: 0 });
      }
      if (p.payload.length > 0 && isLocal(p.dst) && p.dport === ctx.appPort) {
        const text = p.payload.toString("latin1");
        const m = HTTP_METHOD.exec(text);
        if (m) {
          const headerEnd = text.indexOf("\r\n\r\n");
          const head = (headerEnd >= 0 ? text.slice(0, headerEnd) : text).split("\r\n").slice(1);
          const header = (name: string) => head.find((h) => h.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim();
          const driver = ctx.nonce.length >= 16 && header("x-t1-driver") === ctx.nonce;
          const credential = Boolean(header("authorization") || header("x-creatorbrio-human-key") || header("cookie"));
          appRequests.push({ at: p.at, flow, method: m[1], path: sanitizePath(m[2], ctx.canaries), driver, credential, matched: matchCanaries(p.payload, ctx.canaries) });
          const f = flows.get(flow) ?? { at: p.at, flow, driver: false, requests: 0 };
          f.requests += 1;
          f.driver ||= driver;
          flows.set(flow, f);
        }
      }
    } else if (p.proto === "udp") {
      const reverse = `${p.dst}:${p.dport}>${p.src}:${p.sport}`;
      if (udpFlows.has(flow) || udpFlows.has(reverse)) continue;
      udpFlows.add(flow);
      if (resolver.has(p.dst) || resolver.has(p.src)) continue;
      attempts.push({ at: p.at, proto: "udp", family: p.family, src: p.src, dst: p.dst, sport: p.sport, dport: p.dport, kind: kind() });
    } else if (p.proto === "icmp") {
      // Echo requests only (type 8, or 128 for ICMPv6); errors and neighbor discovery are not attempts.
      if (p.flags === 8 || p.flags === 128) attempts.push({ at: p.at, proto: "icmp", family: p.family, src: p.src, dst: p.dst, sport: 0, dport: 0, kind: kind() });
    }
  }
  return { attempts, appRequests, appFlows: [...flows.values()] };
}
