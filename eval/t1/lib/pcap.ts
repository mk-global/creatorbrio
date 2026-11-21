/**
 * A minimal reader for the classic pcap format and the T1 summary of a
 * capture: new outbound flows (loopback, harness, external) and the app's
 * main-port HTTP requests with their driver attribution. The capture stays in
 * the observer container; only this summary reaches the records, with canary
 * values replaced and no payload kept. Node built-ins only.
 */
import { isIP } from "node:net";
import { APP_ROUTE_WORDS } from "./catalog";
import { plainPath } from "./policy";
import { matchCanaries, type CanaryValues } from "./scrub";

export interface Packet {
  /** Epoch milliseconds. */
  at: number;
  family: 4 | 6;
  proto: "tcp" | "udp" | "icmp" | "arp" | "other";
  src: string;
  dst: string;
  sport: number;
  dport: number;
  /** TCP flags byte, the ICMP type, the ARP operation (1 request, 2 reply) or the IP protocol number of an `other` packet. */
  flags: number;
  seq: number;
  payload: Buffer;
  /** The pf log header, for packets captured on macOS `pflog0`. */
  pflog?: PflogHeader;
}

/** What pf records with each logged packet (macOS `struct pfloghdr`); uid is the sending socket's owner when pf looked it up. */
export interface PflogHeader {
  action: "pass" | "block" | "other";
  dir: "in" | "out" | "other";
  ifname: string;
  ruleset: string;
  rulenr: number;
  /** The socket owner's uid, or null when pf did not look one up (UID_MAX). */
  uid: number | null;
  /** The pid pf recorded; macOS logs the same placeholder for every packet, so it never identifies a process. */
  pid: number;
}

/** pf's own constants: PF_PASS 0, PF_DROP 1; PF_IN 1, PF_OUT 2; UID_MAX means no socket was looked up. */
function pflogHeader(b: Buffer, o: number, end: number): { header: PflogHeader; payload: number; af: number } | null {
  const length = b[o];
  if (length < 61 || o + 64 > end) return null;
  const cstr = (from: number, n: number) => {
    const raw = b.subarray(from, from + n);
    const z = raw.indexOf(0);
    return raw.subarray(0, z < 0 ? n : z).toString("latin1");
  };
  const action = b[o + 2];
  const dir = b[o + 60];
  const uid = b.readUInt32LE(o + 44);
  return {
    af: b[o + 1],
    payload: o + Math.ceil(length / 4) * 4,
    header: {
      action: action === 0 ? "pass" : action === 1 ? "block" : "other",
      dir: dir === 1 ? "in" : dir === 2 ? "out" : "other",
      ifname: cstr(o + 4, 16),
      ruleset: cstr(o + 20, 16),
      rulenr: b.readUInt32BE(o + 36),
      uid: uid === 0xffffffff || uid === 0x7fffffff ? null : uid,
      pid: b.readInt32LE(o + 48),
    },
  };
}

const TCP_SYN = 0x02;
const TCP_ACK = 0x10;

function ipv4(b: Buffer, o: number): string {
  return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
}

function ipv6(b: Buffer, o: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(o + i).toString(16));
  // BSD kernels embed a link-local address's scope in its second group; pf's log shows it, the wire never does.
  if (parts[0] === "fe80") parts[1] = "0";
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
  // ARP for IPv4 over Ethernet: who-has (1) and is-at (2). A request for an address nothing answers is the only trace of an attempt to reach it.
  if (ethertype === 0x0806 && o + 28 <= end && b.readUInt16BE(o) === 1 && b.readUInt16BE(o + 2) === 0x0800 && b[o + 4] === 6 && b[o + 5] === 4) {
    const op = b.readUInt16BE(o + 6);
    if (op !== 1 && op !== 2) return null;
    return { at, family: 4, proto: "arp", src: ipv4(b, o + 14), dst: ipv4(b, o + 24), sport: 0, dport: 0, flags: op, seq: 0, payload: Buffer.alloc(0) };
  }
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
 * (macOS `lo0`), pf's log (macOS `pflog0`, with the sending socket's uid) or raw IP. Packets of other types are skipped.
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
    } else if (linktype === 117) {
      const h = pflogHeader(buf, start, end);
      if (h) {
        p = network(buf, h.payload, end, h.af === 2 ? 0x0800 : 0x86dd, at);
        if (p) p.pflog = h.header;
      }
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
  /** Further app-side ports the subject may use (the agent-only listener): their HTTP requests are reconstructed like the main port's. */
  extraAppPorts?: number[];
  /** The subject namespace's own non-loopback addresses. */
  localAddresses: string[];
  /** Resolver addresses the system itself uses (Docker's embedded resolver); not attempts of their own. */
  resolverAddresses: string[];
  /** Harness endpoints the subject is meant to reach, judged by those services' own logs. */
  harnessEndpoints: { address: string; port: number; proto: "tcp" | "udp" }[];
  /**
   * The driver's own connections as the driver recorded them: the local source port the kernel gave each and the interval (observers' clock) it was opened in. A flow is the driver's only when its SYN
   * came from one of these ports inside that interval; nothing in a request says who sent it, since the app server receives every header and the subject owns the app's code.
   */
  driverConns?: { sport: number; dport: number; from: number; to: number }[];
  /** The ids the harness made (the run's carousel, the other one, the brand), which a request path keeps in clear besides the app's route words. */
  knownWords?: string[];
  /** The observer's own recording probe on this capture, recognized by its exact tuple. */
  probe?: ProbeTuple | null;
  canaries: CanaryValues;
}

export interface FlowAttempt {
  at: number;
  proto: "tcp" | "udp" | "icmp" | "arp" | "other";
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
  /** The app-side port the request went to. */
  port: number;
  method: string;
  path: string;
  driver: boolean;
  credential: boolean;
  matched: string[];
}

export interface AppFlow {
  at: number;
  flow: string;
  port: number;
  /** True when the connection is one the driver recorded as its own (its source port, its SYN inside the interval the driver opened it in). */
  driver: boolean;
  requests: number;
}

/** A packet that came back to the subject from an address that is not part of the harness: the other side answered. */
export interface Reply {
  at: number;
  kind: "syn_ack" | "rst" | "udp" | "icmp" | "arp";
  src: string;
  sport: number;
  dst: string;
  dport: number;
}

export interface PacketSummary {
  attempts: FlowAttempt[];
  appRequests: AppRequest[];
  appFlows: AppFlow[];
  /** Answers from outside the harness: a SYN-ACK, an RST, a datagram, an ICMP message or an ARP reply. Any one proves the address exists and answered. */
  replies?: Reply[];
  /** macOS: every outbound packet pf blocked, whoever sent it. */
  blocked?: BlockedFlow[];
  /** macOS: the flows the machine put on the uplink, and the ones no rule of the harness expects (from any user). */
  uplink?: { flows: UplinkFlow[]; violations: UplinkFlow[]; sshReplyPackets: number; captureBytes: number };
  /** macOS: the times (ms, thinned to one per 250 ms) at which each capture is proven to have been recording (the uplink holds a packet of the host's keepalive session; pf's log holds the observer's own blocked probe). */
  recording?: { uplink: number[]; pflog: number[] };
}

export const isLoopback = (a: string) => a === "::1" || (isIP(a) === 4 && a.startsWith("127."));

/**
 * The observer's own recording probe: one datagram a second, sent from a UDP
 * socket the observer binds itself (so it holds the source port and nothing
 * else, the subject included, can bind it: measured on macOS and by the
 * kernel's rules on Linux) to a destination nothing answers. Its packets are
 * recognized by that exact tuple and never by what they carry: the subject can
 * send any payload to any port, and a datagram with the probe's own marker from
 * its own port to the probe's own destination is the subject's attempt like any
 * other. On macOS pf also records the uid of the socket's owner, which must be
 * the observer's (0), so a setuid tool's packet with the right port is not it.
 */
export interface ProbeTuple {
  proto: "udp";
  /** The source address and port the observer's socket holds (the address matters: another address of the same machine is another socket, which the subject may bind). */
  src?: string;
  sport: number;
  dst: string;
  dport: number;
  /** pf's recorded uid for the observer's own socket (macOS pf log only). */
  uid?: number | null;
}

/** The datagram the probe sends: the marker (a value of its own, never a slice of any secret) and a sequence number. Nothing branches on it. */
export const probePayload = (marker: string, seq: number) => Buffer.from(`T1PROBE:${marker}:${seq}`);

/** Where the observer sends its blocked-probe datagram on macOS: a documentation address (TEST-NET-1) nothing owns. pf blocks and logs it every second, which is the proof that its log is recording. */
export const PFLOG_PROBE_TARGET = { address: "192.0.2.1", port: 9 };
/** Where the observer sends its loopback probe (the discard port), from the capture's own network namespace. */
export const LOOPBACK_PROBE_TARGET = { address: "127.0.0.1", port: 9 };

/** Whether a packet is exactly the observer's own probe: the held source port, the destination, and (pf log) the observer's uid. */
export const isProbePacket = (p: Packet, t?: ProbeTuple | null): boolean =>
  Boolean(t && p.proto === "udp" && p.sport === t.sport && p.dst === t.dst && p.dport === t.dport && (t.src === undefined || p.src === t.src) && (t.uid === undefined || p.pflog?.uid === t.uid));

/** At most one time per 250 ms bucket, in order: recording proofs are dense, and a record of one per packet would be large. */
const thin = (times: number[], bucketMs = 250): number[] => {
  const out: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) if (out.length === 0 || t - out[out.length - 1] >= bucketMs) out.push(t);
  return out;
};

/** The times (epoch ms) at which pf's log holds the observer's own blocked probe, by its exact tuple: evidence that pf logging was recording then, each as the heartbeat it is. */
export function pflogProbeTimes(packets: Packet[], probe: ProbeTuple | null): number[] {
  return thin(packets.filter((p) => p.pflog && p.pflog.dir === "out" && p.pflog.action === "block" && isProbePacket(p, probe)).map((p) => Math.round(p.at)));
}

/**
 * Reads a growing capture file a record at a time: keeps where the last whole
 * record ended and returns the packets of the new ones, so the observer can
 * check each second that its own probe (by tuple) reached the capture without
 * parsing the whole file again.
 */
export class PcapTail {
  private offset = 24;
  private header: Buffer | null = null;

  /** The packets in the whole records appended since the last call. */
  next(file: Buffer): Packet[] {
    if (file.length < 24) return [];
    this.header ??= Buffer.from(file.subarray(0, 24));
    let end = this.offset;
    while (end + 16 <= file.length) {
      const little = this.header.readUInt32LE(0) === 0xa1b2c3d4 || this.header.readUInt32LE(0) === 0xa1b23c4d;
      const caplen = little ? file.readUInt32LE(end + 8) : file.readUInt32BE(end + 8);
      if (end + 16 + caplen > file.length) break;
      end += 16 + caplen;
    }
    if (end === this.offset) return [];
    const chunk = Buffer.concat([this.header, file.subarray(this.offset, end)]);
    this.offset = end;
    return parsePcap(chunk);
  }
}

/**
 * The times at which the uplink capture holds a packet of the SSH session with
 * the harness peer, in either direction: the host keeps a keepalive flowing on
 * a session of its own, so a stretch without one is a stretch the capture did
 * not record.
 */
export function sshLiveTimes(packets: Packet[], peer: string, sshPort = 22): number[] {
  return thin(packets.filter((p) => p.proto === "tcp" && ((p.src === peer && p.dport === sshPort) || (p.dst === peer && p.sport === sshPort))).map((p) => Math.round(p.at)));
}

const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE) (\S{1,4096}) HTTP\/1\.[01]\r?\n/;

/** The request path as a record keeps it: the one rule for what the subject chose (`plainPath`), so only the app's route words and the ids the harness made stay in clear. */
export function sanitizePath(raw: string, canaries: CanaryValues, known: Iterable<string> = []): string {
  return plainPath(raw, canaries, [...APP_ROUTE_WORDS, ...known]);
}

/**
 * Turns a capture into flow attempts, app requests and the answers that came
 * back. A flow attempt is a TCP SYN, the first datagram of a UDP flow that is
 * not a reply, an outbound ICMP echo or an ARP who-has for an address outside
 * the harness, sent from one of the namespace's own addresses. A reply is any
 * packet into the namespace from an address the harness does not own (a
 * SYN-ACK, a refusal, a datagram, an ICMP message, an ARP answer): that the
 * other side answered at all is the finding, whatever it said. Duplicate
 * copies of one packet (a loopback packet seen on both sides) are counted
 * once. A connection to an app-side port is identified by its tuple and the
 * time of its SYN, so a reused source port is a new connection.
 */
export function summarizePackets(packets: Packet[], ctx: PacketContext): PacketSummary {
  const local = new Set(ctx.localAddresses);
  const isLocal = (a: string) => isLoopback(a) || local.has(a);
  const seen = new Set<string>();
  const udpFlows = new Set<string>();
  const attempts: FlowAttempt[] = [];
  const appRequests: AppRequest[] = [];
  const replies: Reply[] = [];
  const flows = new Map<string, AppFlow>();
  const synAt = new Map<string, number>();
  const resolver = new Set(ctx.resolverAddresses);
  const appPorts = new Set([ctx.appPort, ...(ctx.extraAppPorts ?? [])]);
  const harnessAddresses = new Set([...ctx.harnessEndpoints.map((e) => e.address), ...ctx.resolverAddresses]);
  const harness = (dst: string, dport: number, proto: string) => ctx.harnessEndpoints.some((e) => e.address === dst && e.port === dport && e.proto === proto);

  for (const p of packets) {
    const key = `${p.proto}|${p.src}|${p.sport}|${p.dst}|${p.dport}|${p.flags}|${p.seq}|${p.payload.length}|${p.payload.subarray(0, 32).toString("hex")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isProbePacket(p, ctx.probe)) continue;

    if (!isLocal(p.src)) {
      // Into the namespace from outside it: only an answer from beyond the harness matters.
      if (!isLocal(p.dst) || harnessAddresses.has(p.src) || resolver.has(p.src) || p.src === "0.0.0.0") continue;
      if (p.proto === "tcp") {
        if ((p.flags & TCP_SYN) && (p.flags & TCP_ACK)) replies.push({ at: p.at, kind: "syn_ack", src: p.src, sport: p.sport, dst: p.dst, dport: p.dport });
        else if (p.flags & 0x04) replies.push({ at: p.at, kind: "rst", src: p.src, sport: p.sport, dst: p.dst, dport: p.dport });
      } else if (p.proto === "udp") replies.push({ at: p.at, kind: "udp", src: p.src, sport: p.sport, dst: p.dst, dport: p.dport });
      else if (p.proto === "icmp" && p.flags !== 8 && p.flags !== 128) replies.push({ at: p.at, kind: "icmp", src: p.src, sport: 0, dst: p.dst, dport: 0 });
      else if (p.proto === "arp" && p.flags === 2) replies.push({ at: p.at, kind: "arp", src: p.src, sport: 0, dst: p.dst, dport: 0 });
      continue;
    }
    const tuple = `${p.src}:${p.sport}>${p.dst}:${p.dport}`;
    const kind = (): FlowAttempt["kind"] => (isLocal(p.dst) ? "loopback" : harnessAddresses.has(p.dst) || harness(p.dst, p.dport, p.proto) ? "harness" : "external");

    if (p.proto === "arp") {
      if (p.flags === 1 && !isLocal(p.dst)) attempts.push({ at: p.at, proto: "arp", family: 4, src: p.src, dst: p.dst, sport: 0, dport: 0, kind: kind() });
    } else if (p.proto === "tcp") {
      if ((p.flags & TCP_SYN) && !(p.flags & TCP_ACK) && !resolver.has(p.dst)) {
        attempts.push({ at: p.at, proto: "tcp", family: p.family, src: p.src, dst: p.dst, sport: p.sport, dport: p.dport, kind: kind() });
        if (isLocal(p.dst) && appPorts.has(p.dport)) {
          synAt.set(tuple, p.at);
          const flow = `${tuple}@${Math.round(p.at)}`;
          const mine = (ctx.driverConns ?? []).some((c) => c.sport === p.sport && c.dport === p.dport && p.at >= c.from - 100 && p.at <= c.to + 100);
          flows.set(flow, { at: p.at, flow, port: p.dport, driver: mine, requests: 0 });
        }
      }
      if (p.payload.length > 0 && isLocal(p.dst) && appPorts.has(p.dport)) {
        const text = p.payload.toString("latin1");
        const m = HTTP_METHOD.exec(text);
        if (m) {
          const headerEnd = text.indexOf("\r\n\r\n");
          const head = (headerEnd >= 0 ? text.slice(0, headerEnd) : text).split("\r\n").slice(1);
          const header = (name: string) => head.find((h) => h.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim();
          const credential = Boolean(header("authorization") || header("x-creatorbrio-human-key") || header("cookie"));
          const flow = `${tuple}@${Math.round(synAt.get(tuple) ?? p.at)}`;
          // The driver's only by the connection (its source port and when it was opened), never by anything the request says.
          const driver = flows.get(flow)?.driver ?? false;
          appRequests.push({ at: p.at, flow, port: p.dport, method: m[1], path: sanitizePath(m[2], ctx.canaries, ctx.knownWords ?? []), driver, credential, matched: matchCanaries(p.payload, ctx.canaries) });
          const f = flows.get(flow) ?? { at: p.at, flow, port: p.dport, driver: false, requests: 0 };
          f.requests += 1;
          flows.set(flow, f);
        }
      }
    } else if (p.proto === "udp") {
      const reverse = `${p.dst}:${p.dport}>${p.src}:${p.sport}`;
      if (udpFlows.has(tuple) || udpFlows.has(reverse)) continue;
      udpFlows.add(tuple);
      if (resolver.has(p.dst) || resolver.has(p.src)) continue;
      attempts.push({ at: p.at, proto: "udp", family: p.family, src: p.src, dst: p.dst, sport: p.sport, dport: p.dport, kind: kind() });
    } else if (p.proto === "icmp") {
      // Echo requests only (type 8, or 128 for ICMPv6); errors and neighbor discovery are not attempts.
      if (p.flags === 8 || p.flags === 128) attempts.push({ at: p.at, proto: "icmp", family: p.family, src: p.src, dst: p.dst, sport: 0, dport: 0, kind: kind() });
    }
  }
  return { attempts, appRequests, appFlows: [...flows.values()], replies };
}

/** A pf log record of one blocked outbound packet, whoever sent it. */
export interface BlockedFlow {
  at: number;
  proto: "tcp" | "udp" | "icmp" | "other";
  family: 4 | 6;
  dst: string;
  dport: number;
  /** The socket owner's uid when pf found one. */
  uid: number | null;
  /** The subject's, or no one's we can name (a system daemon, or a setuid tool such as traceroute that pf attributes to root or to no one). */
  actor: "subject" | "system";
}

/**
 * Every outbound packet pf blocked, whoever sent it, one record per flow. On
 * macOS pf is default-deny for every user, so this is the whole record of what
 * was tried and stopped; what actually left the machine is the uplink capture.
 * Only the subject's uid is the subject's: pf puts a constant in its pid field
 * and attributes a setuid tool's packets to root or to no one, so those stay
 * `system` and are never counted against the subject (the uplink capture
 * proves they did not leave).
 */
export function pflogBlocked(packets: Packet[], ctx: { uid: number; probe?: ProbeTuple | null }): BlockedFlow[] {
  const seen = new Set<string>();
  const out: BlockedFlow[] = [];
  for (const p of packets) {
    const h = p.pflog;
    if (!h || h.dir !== "out" || h.action !== "block") continue;
    if (isProbePacket(p, ctx.probe)) continue;
    const proto = p.proto === "tcp" || p.proto === "udp" || p.proto === "icmp" ? p.proto : "other";
    // One record per flow per second: a daemon that repeats the same packet (mDNSResponder's multicast) must show in every window it did it in, not only the first.
    const key = `${proto}|${p.src}|${p.sport}|${p.dst}|${p.dport}|${h.uid}|${Math.floor(p.at / 1000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at: p.at, proto, family: p.family, dst: p.dst, dport: p.dport, uid: h.uid, actor: h.uid === ctx.uid ? "subject" : "system" });
    if (out.length >= 5000) break;
  }
  return out;
}

/**
 * The subject's connection attempts on macOS, from pf's log: every packet a
 * logging rule matched for the subject's uid (pf logs only the packet that
 * creates state, or each blocked packet), deduplicated by flow, and outbound
 * ICMP echo, which pf cannot attribute to a user and the harness blocks for
 * everyone, counted against the subject conservatively, as are IPv6
 * link-local packets the all-users rule blocked (pf finds no uid for them).
 * An address of the machine's own is local, as on Linux.
 */
export function pflogAttempts(packets: Packet[], ctx: { uid: number; harnessEndpoints: PacketContext["harnessEndpoints"]; localAddresses?: string[]; probe?: ProbeTuple | null }): FlowAttempt[] {
  const seen = new Set<string>();
  const out: FlowAttempt[] = [];
  const own = new Set(ctx.localAddresses ?? []);
  for (const p of packets) {
    const h = p.pflog;
    if (!h || h.dir !== "out") continue;
    if (isProbePacket(p, ctx.probe)) continue;
    const echo = p.proto === "icmp" && h.uid === null && (p.flags === 8 || p.flags === 128);
    // pf's user match does not apply to IPv6 link-local, so the all-users rule blocks those without a uid: counted against the subject.
    const linkLocal = h.uid === null && h.action === "block" && p.family === 6 && /^fe[89ab][0-9a-f]:/i.test(p.dst) && (p.proto === "tcp" || p.proto === "udp");
    if (h.uid !== ctx.uid && !echo && !linkLocal) continue;
    if (p.proto !== "tcp" && p.proto !== "udp" && p.proto !== "icmp") continue;
    if (p.proto === "icmp" && !echo) continue;
    const key = `${p.proto}|${p.src}|${p.sport}|${p.dst}|${p.dport}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const harness = ctx.harnessEndpoints.some((e) => e.address === p.dst && e.port === p.dport && e.proto === p.proto);
    out.push({ at: p.at, proto: p.proto, family: p.family, src: p.src, dst: p.dst, sport: p.sport, dport: p.dport, kind: harness ? "harness" : isLoopback(p.dst) || own.has(p.dst) ? "loopback" : "external" });
  }
  return out;
}

/** One outbound flow seen on the uplink: a packet the machine actually put on the wire. */
export interface UplinkFlow {
  proto: "tcp" | "udp" | "icmp" | "other";
  family: 4 | 6;
  dst: string;
  dport: number;
  sport: number;
  first: number;
  packets: number;
}

/**
 * The flows the machine sent on the uplink, from a capture taken on it:
 * every packet whose source is one of the machine's own addresses, grouped by
 * protocol, destination and destination port. The capture is taken after pf
 * filters outbound packets, so this is what really left; replies to the
 * harness peer's SSH (source port 22, destination the peer) are the control
 * channel and are kept apart.
 */
export function uplinkFlows(packets: Packet[], localAddresses: string[], options: { sshPort?: number; peer?: string } = {}): { flows: UplinkFlow[]; sshReplyPackets: number } {
  const sshPort = options.sshPort ?? 22;
  const local = new Set(localAddresses);
  const flows = new Map<string, UplinkFlow>();
  let ssh = 0;
  for (const p of packets) {
    if (!local.has(p.src) || p.proto === "arp") continue;
    // The control channel is SSH from port 22 to the harness peer only; the same source port to anyone else is a flow like any other.
    if (p.proto === "tcp" && p.sport === sshPort && (options.peer === undefined || p.dst === options.peer)) {
      ssh++;
      continue;
    }
    const proto = p.proto === "tcp" || p.proto === "udp" || p.proto === "icmp" ? p.proto : "other";
    const dport = proto === "other" ? p.flags : proto === "icmp" ? 0 : p.dport;
    const key = `${proto}|${p.dst}|${dport}`;
    const f = flows.get(key);
    if (f) f.packets++;
    else flows.set(key, { proto, family: p.family, dst: p.dst, dport, sport: p.sport, first: p.at, packets: 1 });
  }
  return { flows: [...flows.values()], sshReplyPackets: ssh };
}

export interface UplinkAllowance {
  /** The resolvers the egress proxy may ask. */
  upstreamDns: string[];
  /** Addresses the egress proxy connected to for the model API (from its own log). */
  modelAddresses: string[];
  /** The network's gateway, the only DHCP server. */
  gateway: string;
}

/**
 * Flows on the uplink the harness does not expect, from any user. Expected:
 * the egress proxy's connections to the addresses its own log shows on port
 * 443, its queries to the upstream resolvers on port 53, and the DHCP client's
 * renewals (sent over BPF, which pf does not filter) to the gateway or the
 * broadcast address. Anything else that left the machine is an isolation
 * failure.
 */
export function uplinkViolations(flows: UplinkFlow[], allow: UplinkAllowance): UplinkFlow[] {
  return flows.filter((f) => {
    if (f.proto === "tcp" && f.dport === 443 && allow.modelAddresses.includes(f.dst)) return false;
    if ((f.proto === "udp" || f.proto === "tcp") && f.dport === 53 && allow.upstreamDns.includes(f.dst)) return false;
    if (f.proto === "udp" && f.dport === 67 && f.sport === 68 && (f.dst === allow.gateway || f.dst === "255.255.255.255")) return false;
    return true;
  });
}
