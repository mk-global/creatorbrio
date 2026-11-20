/**
 * The macOS runner's own evidence parsers and rules (#225): what turns
 * `eslogger`, `mDNSResponder`'s log and pf into the same normalized records
 * the Linux runner writes (`FsEvent`, `DnsLine` with an actor, `FlowAttempt`),
 * so the judge is unchanged. Pure functions only; the VM-side services call
 * them, and so do the unit tests.
 */
import { isIP } from "node:net";
import type { DnsLine, FsEvent } from "./observations";

/** Where each logical root lives in the macOS VM. */
export const MACOS_ROOTS: Record<string, string> = {
  checkout: "/Users/Shared/creatorbrio",
  home: "/Users/designer",
  tmp: "/private/tmp",
};

export const MACOS_SUBJECT = "designer";

/** The logical path of a real path in the VM, or null outside every root. `/tmp` is a link to `/private/tmp`. */
export function macosLogical(real: string, roots: Record<string, string> = MACOS_ROOTS): string | null {
  const p = real.startsWith("/tmp/") || real === "/tmp" ? `/private${real}` : real;
  // The longest root first, so a root nested in another wins.
  for (const [logical, dir] of Object.entries(roots).sort((a, b) => b[1].length - a[1].length)) {
    if (p === dir) return `${logical}:`;
    if (p.startsWith(`${dir}/`)) return `${logical}:${p.slice(dir.length + 1)}`;
  }
  return null;
}

/** One `eslogger` event reduced to what the judge needs: who, when, which paths, as the Linux names for the same access. */
export interface EsEvent {
  at: number;
  pid: number;
  euid: number;
  /** Absolute paths with the access each one had, in inotify's vocabulary. */
  paths: { path: string; events: string[] }[];
  /** Set for exec and fork: a new process and its uid. */
  process?: { pid: number; euid: number };
  /** Set for mount: the file system type and mount point. A subject mount is a channel the harness refuses (the VM's VirtioFS device). */
  mount?: { fstype: string; on: string };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const pathOf = (v: unknown): string | null => {
  const p = obj(v).path;
  return typeof p === "string" ? p : null;
};
/** A create or rename destination: an existing file, or a new name in a folder. */
function destination(e: Json): string | null {
  const d = obj(e.destination);
  if (e.destination_type === 0) return pathOf(d.existing_file);
  const np = obj(d.new_path);
  const dir = pathOf(np.dir);
  return dir && typeof np.filename === "string" ? `${dir}/${np.filename}` : null;
}

/**
 * Parses one line of `eslogger` JSON output. Only events whose process runs
 * with `uid` as its effective user are kept, so the harness's own (root)
 * access never counts; exec and fork are kept for every process of that uid
 * because the DNS attribution needs the subject's process ids.
 */
export function parseEsloggerLine(line: string, uid: number): EsEvent | null {
  let j: Json;
  try {
    j = JSON.parse(line) as Json;
  } catch {
    return null;
  }
  const token = obj(obj(j.process).audit_token);
  const euid = Number(token.euid);
  const pid = Number(token.pid);
  const at = typeof j.time === "string" ? Date.parse(j.time) : NaN;
  if (!Number.isFinite(at)) return null;
  const event = obj(j.event);
  const [type] = Object.keys(event);
  const e = obj(event[type]);
  if (type === "exec" || type === "fork") {
    const child = obj(type === "exec" ? e.target : e.child);
    const ct = obj(child.audit_token);
    const childUid = Number(ct.euid);
    if (childUid !== uid && euid !== uid) return null;
    return { at, pid, euid, paths: [], process: { pid: Number(ct.pid), euid: childUid } };
  }
  if (euid !== uid) return null;
  if (type === "mount" || type === "remount") {
    const st = obj(e.statfs);
    return { at, pid, euid, paths: [], mount: { fstype: String(st.f_fstypename ?? "unknown").slice(0, 32), on: String(st.f_mntonname ?? "").slice(0, 300) } };
  }
  const one = (path: string | null, events: string[]) => (path ? [{ path, events }] : []);
  let paths: EsEvent["paths"] = [];
  if (type === "open") paths = one(pathOf(e.file), ["OPEN"]);
  else if (type === "close") paths = one(pathOf(e.target), [e.modified === true ? "CLOSE_WRITE" : "CLOSE_NOWRITE"]);
  else if (type === "create") paths = one(destination(e), ["CREATE"]);
  else if (type === "write" || type === "truncate") paths = one(pathOf(e.target), ["MODIFY"]);
  else if (type === "rename") paths = [...one(pathOf(e.source), ["MOVED_FROM"]), ...one(destination(e), ["MOVED_TO"])];
  else if (type === "unlink") paths = one(pathOf(e.target), ["DELETE"]);
  else if (type === "setmode" || type === "setowner" || type === "setflags" || type === "setextattr" || type === "deleteextattr" || type === "utimes" || type === "setattrlist") paths = one(pathOf(e.target), ["ATTRIB"]);
  else if (type === "link") paths = one(pathOf(e.target_dir) ? `${pathOf(e.target_dir)}/${String(e.target_filename ?? "")}` : null, ["CREATE"]);
  else return null;
  return { at, pid, euid, paths };
}

/** The `eslogger` event types the observer subscribes to. */
export const ES_EVENTS = ["open", "close", "create", "write", "truncate", "rename", "unlink", "link", "setmode", "setowner", "setflags", "setextattr", "deleteextattr", "utimes", "setattrlist", "exec", "fork", "mount", "remount"];

/**
 * Reduces `EsEvent`s to `FsEvent`s on logical paths, as the Linux observer
 * does: reads only on canaries, writes everywhere under the roots, and one
 * record per path and access within `coalesceMs`, since a single file write
 * can produce thousands of write events.
 */
export function fsEventsFrom(events: EsEvent[], canaryLogical: Set<string>, roots: Record<string, string> = MACOS_ROOTS, coalesceMs = 1000): FsEvent[] {
  const reads = new Set(["OPEN", "CLOSE_NOWRITE"]);
  const last = new Map<string, number>();
  const out: FsEvent[] = [];
  for (const e of events) {
    for (const p of e.paths) {
      const logical = macosLogical(p.path, roots);
      if (!logical) continue;
      const kept = canaryLogical.has(logical) ? p.events : p.events.filter((x) => !reads.has(x));
      if (kept.length === 0) continue;
      const key = `${logical}|${kept.join(",")}`;
      const prev = last.get(key);
      if (prev !== undefined && e.at - prev < coalesceMs) continue;
      last.set(key, e.at);
      out.push({ at: e.at, path: logical, events: kept });
    }
  }
  return out;
}

/** What `mDNSResponder`'s log says about one query: a client request, a request's question, or a question sent upstream with its DNS id. */
export type MdnsRecord =
  | { kind: "request"; at: number; r: number; pid: number; process: string }
  | { kind: "question"; at: number; r: number; q: number }
  | { kind: "sent"; at: number; q: number; id: number; proto: string }
  /** A query from `mDNSResponder`'s own Discovery of Designated Resolvers querier (RFC 9462): asked by the system, for no client. */
  | { kind: "ddr"; at: number; id: number; proto: string };

/** Parses one `log stream --style ndjson` line from `mDNSResponder`. Names are private in that log and never needed. */
export function parseMdnsLine(line: string): MdnsRecord | null {
  let j: Json;
  try {
    j = JSON.parse(line) as Json;
  } catch {
    return null;
  }
  const msg = typeof j.eventMessage === "string" ? j.eventMessage : "";
  const ts = typeof j.timestamp === "string" ? Date.parse(j.timestamp.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
  if (!msg || !Number.isFinite(ts)) return null;
  let m = /^\[R(\d+)\] [^\n]*?(?:client pid: (\d+) \(([^)]*)\)|PID\[(\d+)\]\(([^)]*)\))/.exec(msg);
  if (m) return { kind: "request", at: ts, r: Number(m[1]), pid: Number(m[2] ?? m[4]), process: (m[3] ?? m[5] ?? "").slice(0, 64) };
  m = /^\[R(\d+)->Q(\d+)\]/.exec(msg);
  if (m) return { kind: "question", at: ts, r: Number(m[1]), q: Number(m[2]) };
  m = /^\[Q(\d+)\] Sent \d+-byte query #\d+ to [^\n]*? over (\w+) [^\n]*?-- id: 0x([0-9A-Fa-f]+)/.exec(msg);
  if (m) return { kind: "sent", at: ts, q: Number(m[1]), proto: m[2], id: parseInt(m[3], 16) };
  m = /^\[S\d+\.DDR\d+\] Sent \d+-byte query #\d+ to [^\n]*? over (\w+) [^\n]*?-- id: 0x([0-9A-Fa-f]+)[^\n]* IN SVCB\?$/.exec(msg);
  if (m) return { kind: "ddr", at: ts, proto: m[1], id: parseInt(m[2], 16) };
  return null;
}

export interface DnsAttributionInput {
  /** The resolver's lines, with their DNS id and source port. */
  dns: (DnsLine & { id?: number; srcPort?: number })[];
  mdns: MdnsRecord[];
  /** Process ids that ran as the subject's uid. */
  subjectPids: Set<number>;
  /** The subject's own packets to the resolver, from pf's log: direct queries that bypass mDNSResponder. */
  direct: { at: number; sport: number }[];
  windowMs?: number;
}

/**
 * Gives each resolver line an actor. Queries reach the resolver either
 * straight from a process (pf's log names the subject's) or through
 * `mDNSResponder`, whose log links the upstream DNS id to the question, the
 * request and the client process id. A line that cannot be linked to anyone
 * counts as the subject's: unattributed evidence is never discarded.
 */
export function attributeDns(input: DnsAttributionInput): (DnsLine & { actor: "subject" | "system"; via: string })[] {
  const w = input.windowMs ?? 5000;
  const questionToRequest = new Map<number, number>();
  const requestToPid = new Map<number, { pid: number; process: string }>();
  for (const r of input.mdns) {
    if (r.kind === "question") questionToRequest.set(r.q, r.r);
    else if (r.kind === "request") requestToPid.set(r.r, { pid: r.pid, process: r.process });
  }
  const sent = input.mdns.filter((r): r is Extract<MdnsRecord, { kind: "sent" }> => r.kind === "sent");
  const ddr = input.mdns.filter((r): r is Extract<MdnsRecord, { kind: "ddr" }> => r.kind === "ddr");
  return input.dns.map((l) => {
    if (input.direct.some((d) => d.sport === l.srcPort && Math.abs(d.at - l.at) <= w)) return { ...l, actor: "subject" as const, via: "direct" };
    if (l.id !== undefined) {
      const candidates = sent.filter((s) => s.id === l.id && Math.abs(s.at - l.at) <= w).sort((a, b) => Math.abs(a.at - l.at) - Math.abs(b.at - l.at));
      for (const s of candidates) {
        const r = questionToRequest.get(s.q);
        const client = r === undefined ? undefined : requestToPid.get(r);
        if (client) return { ...l, actor: input.subjectPids.has(client.pid) ? ("subject" as const) : ("system" as const), via: `mDNSResponder for ${client.process}` };
      }
      // SVCB (type 64) is what the resolver discovery querier asks; any other type with the same id stays unexplained.
      if (l.qtype === 64 && ddr.some((d) => d.id === l.id && Math.abs(d.at - l.at) <= w)) return { ...l, actor: "system" as const, via: "mDNSResponder resolver discovery" };
    }
    return { ...l, actor: "subject" as const, via: "unattributed" };
  });
}

export interface PfAnchorInput {
  uid: number;
  appPort: number;
  proxyPort: number;
  decoyPort: number;
  dnsPort: number;
  webAddress: string;
  allowedLoopbackPorts: number[];
}

/**
 * The root-owned pf anchor that confines the subject's uid: outbound TCP only
 * to the proxy, the app, the decoy (so its listener records the attempt) and
 * the harness web server; UDP only to the logging resolver; everything else
 * from that uid blocked and logged with its uid. Inbound loopback keeps state
 * so the subject's own listeners (the app) can answer. Outbound ICMP echo and
 * outbound IPv6 to link-local addresses are blocked for everyone, because pf
 * cannot match either to a user.
 */
export function pfAnchor(i: PfAnchorInput): string {
  for (const p of [i.appPort, i.proxyPort, i.decoyPort, i.dnsPort, ...i.allowedLoopbackPorts]) if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`bad port ${p}`);
  if (!Number.isInteger(i.uid) || i.uid < 1) throw new Error("bad uid");
  if (isIP(i.webAddress) !== 4) throw new Error("bad web address");
  const loopbackTcp = [i.appPort, i.proxyPort, i.decoyPort, ...i.allowedLoopbackPorts].join(" ");
  return [
    "# T1 confinement of the subject user (#225); generated, loaded under com.apple/ by the harness, removed on cleanup.",
    "pass in quick on lo0 all keep state",
    // For every user: pf's user match does not apply to IPv6 link-local, which reaches the host's services on the gateway. IPv6 is also off on the uplink.
    "block drop out log quick on ! lo0 inet6 from any to fe80::/10",
    `pass out log quick on lo0 proto tcp from any to 127.0.0.1 port { ${loopbackTcp} } user ${i.uid} keep state`,
    `pass out log quick on lo0 proto tcp from any to ::1 port { ${[i.decoyPort, ...i.allowedLoopbackPorts].join(" ")} } user ${i.uid} keep state`,
    `pass out log quick proto tcp from any to ${i.webAddress} port { 80 443 } user ${i.uid} keep state`,
    `pass out log quick on lo0 proto udp from any to 127.0.0.1 port ${i.dnsPort} user ${i.uid} keep state`,
    `block drop out log quick proto { tcp udp } all user ${i.uid}`,
    "block drop out log quick on ! lo0 inet proto icmp all icmp-type echoreq",
    "block drop out log quick on ! lo0 inet6 proto icmp6 all icmp6-type echoreq",
    "",
  ].join("\n");
}
