/**
 * The macOS runner's own evidence parsers and rules (#225): what turns
 * `eslogger`, `mDNSResponder`'s log and pf into the same normalized records
 * the Linux runner writes (`FsEvent`, `DnsLine` with an actor, `FlowAttempt`),
 * so the judge is unchanged. Pure functions only; the VM-side services call
 * them, and so do the unit tests.
 */
import { isIP } from "node:net";
import { coalescible, normalizeState, scopeOf } from "./cli-state";
import { ROOT_PATHS } from "./readers";
import { ACCESS_EVENTS, type DnsLine, type FsEvent } from "./observations";
import type { CliIdentity } from "./procs";
import { isCliBinary } from "./procs";

/** Where each logical root lives in the macOS VM. */
export const MACOS_ROOTS: Record<string, string> = { ...ROOT_PATHS.macos };

export const MACOS_SUBJECT = "designer";

/**
 * The logical path of a real path in the VM, or null outside every root. `/tmp` is a link to `/private/tmp`, and the data volume is reachable through its firmlink (`/System/Volumes/Data/Users/...` is
 * `/Users/...`), a spelling a process can choose and an event may carry: both are the same path.
 */
export function macosLogical(real: string, roots: Record<string, string> = MACOS_ROOTS): string | null {
  const data = "/System/Volumes/Data";
  const unlinked = real === data ? "/" : real.startsWith(`${data}/`) ? real.slice(data.length) : real;
  const p = unlinked.startsWith("/tmp/") || unlinked === "/tmp" ? `/private${unlinked}` : unlinked;
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
  /** Absolute paths with the access each one had, in inotify's vocabulary; `dev` and `ino` identify the file whatever name it was reached by. */
  paths: { path: string; events: string[]; dev?: number; ino?: number }[];
  /** Set for exec and fork: a new process, its uid and its parent; for exec also what was run. */
  process?: { pid: number; euid: number; ppid?: number; exe?: string; size?: number; cdhash?: string };
  /** Set for exit: the process that ended. */
  exited?: boolean;
  /** Set for mount: the file system type and mount point. A subject mount is a channel the harness refuses (the VM's VirtioFS device). */
  mount?: { fstype: string; on: string };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const pathOf = (v: unknown): string | null => {
  const p = obj(v).path;
  return typeof p === "string" ? p : null;
};
/** The device and inode `eslogger` reports in a file's `stat`: they name the file, not the path it was reached by. */
const identityOf = (v: unknown): { dev?: number; ino?: number } => {
  const st = obj(obj(v).stat);
  return typeof st.st_dev === "number" && typeof st.st_ino === "number" ? { dev: st.st_dev, ino: st.st_ino } : {};
};
const fileOf = (v: unknown, events: string[]): EsEvent["paths"] => {
  const path = pathOf(v);
  return path ? [{ path, events, ...identityOf(v) }] : [];
};
/** A new name in a folder (`target_dir` and `target_name`), as the path it makes. */
const newName = (dir: unknown, name: unknown): string | null => {
  const d = pathOf(dir);
  return d && typeof name === "string" ? `${d}/${name}` : null;
};
/** A create or rename destination: an existing file, or a new name in a folder. */
function destination(e: Json): string | null {
  const d = obj(e.destination);
  if (e.destination_type === 0) return pathOf(d.existing_file);
  const np = obj(d.new_path);
  const dir = pathOf(np.dir);
  return dir && typeof np.filename === "string" ? `${dir}/${np.filename}` : null;
}

/** The kernel's flag for a file opened for writing, in `open`'s `fflag`. */
const FWRITE = 0x2;

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
    const stat = obj(obj(child.executable).stat);
    return {
      at,
      pid,
      euid,
      paths: [],
      process: {
        pid: Number(ct.pid),
        euid: childUid,
        // A fork's child names its parent; an exec's target does too, and its executable, size and code signature say what ran.
        // The parent at the process's creation (`original_ppid`), never one it was later reparented to.
        ppid: Number.isFinite(Number(child.original_ppid)) ? Number(child.original_ppid) : Number.isFinite(Number(child.ppid)) ? Number(child.ppid) : type === "fork" ? pid : undefined,
        ...(type === "exec" ? { exe: pathOf(child.executable) ?? undefined, size: typeof stat.st_size === "number" ? stat.st_size : undefined, cdhash: typeof child.cdhash === "string" ? child.cdhash.toLowerCase() : undefined } : {}),
      },
    };
  }
  if (euid !== uid) return null;
  if (type === "exit") return { at, pid, euid, paths: [], exited: true };
  if (type === "mount" || type === "remount") {
    const st = obj(e.statfs);
    return { at, pid, euid, paths: [], mount: { fstype: String(st.f_fstypename ?? "unknown").slice(0, 32), on: String(st.f_mntonname ?? "").slice(0, 300) } };
  }
  const one = (path: string | null, events: string[]) => (path ? [{ path, events }] : []);
  let paths: EsEvent["paths"] = [];
  // An open is a read, and also a write-capable access when its flags include write access: `fflag` is in the kernel's FREAD (1) and FWRITE (2) form, not O_WRONLY or O_RDWR, and carries other flags (the
  // close-on-exec bit among them). A close is a confirmed modification when `modified` is true; a file changed only through a writable memory mapping closes with `modified: false` and
  // `was_mapped_writable: true` (ESMessage.h), so that flag is a write-capable access of its own. Neither access is a modification: the events name the process, and the rules decide what an access means.
  if (type === "open") paths = fileOf(e.file, typeof e.fflag === "number" && (e.fflag & FWRITE) !== 0 ? ["OPEN", "OPEN_WRITE"] : ["OPEN"]);
  else if (type === "close") paths = fileOf(e.target, [e.modified === true ? "CLOSE_WRITE" : "CLOSE_NOWRITE", ...(e.was_mapped_writable === true ? ["CLOSE_MAPPED"] : [])]);
  else if (type === "create") paths = [...fileOf(obj(e.destination).existing_file, ["CREATE"]), ...(e.destination_type === 1 ? one(destination(e), ["CREATE"]) : [])];
  else if (type === "write" || type === "truncate") paths = fileOf(e.target, ["MODIFY"]);
  // A rename's source is an access of that file too (its contents are one name away from anywhere), as well as its leaving.
  else if (type === "rename") paths = [...fileOf(e.source, ["MOVED_FROM", "OPEN"]), ...(e.destination_type === 0 ? fileOf(obj(e.destination).existing_file, ["MOVED_TO"]) : one(destination(e), ["MOVED_TO"]))];
  else if (type === "unlink") paths = fileOf(e.target, ["DELETE"]);
  else if (type === "setmode" || type === "setowner" || type === "setflags" || type === "setextattr" || type === "deleteextattr" || type === "utimes" || type === "setattrlist") paths = fileOf(e.target, ["ATTRIB"]);
  // A second name for a file (a hard link), an APFS clone of it, or a copy made by the system: the new name is a creation, and the source is read.
  else if (type === "link" || type === "clone") paths = [...fileOf(e.source, ["OPEN"]), ...one(newName(e.target_dir, e.target_filename ?? e.target_name), ["CREATE"])];
  else if (type === "copyfile") paths = [...fileOf(e.source, ["OPEN"]), ...fileOf(e.target_file, ["CREATE"]), ...one(newName(e.target_dir, e.target_name), ["CREATE"])];
  // Two files swap their contents: each is read and written.
  else if (type === "exchangedata") paths = [...fileOf(e.file1, ["OPEN", "MODIFY"]), ...fileOf(e.file2, ["OPEN", "MODIFY"])];
  else return null;
  return { at, pid, euid, paths };
}

/**
 * The file the self-test writer (a launchd daemon of its own, never the observer
 * and never in the session `eslogger` runs in) rewrites every second: its events
 * must come back through `eslogger`, which proves the stream is recording.
 * `eslogger` mutes the events of its own audit session (measured: the
 * processes of the ssh session it was started in vanish from its output but
 * still consume sequence numbers), so neither the self-test nor the observer's
 * own file activity may share that session.
 */
export const ES_SELFTEST_FILE = "/var/t1/selftest-beat";

/**
 * Whether an `eslogger` line is an event on the self-test file made by a root
 * process: the file named exactly (as the system's own path for it, with or
 * without `/private`), and the event's own audit token saying its process runs
 * as uid 0. A substring test would let a subject file at any path containing
 * the name forge the proof that the stream is recording, and a path alone would
 * let any process that can reach it; only root writes `/var/t1`.
 */
export function esSelfTestEvent(line: string, file: string): boolean {
  if (!line.includes(file.split("/").pop() as string)) return false;
  let j: Json;
  try {
    j = JSON.parse(line) as Json;
  } catch {
    return false;
  }
  if (Number(obj(obj(j.process).audit_token).euid) !== 0) return false;
  const event = obj(j.event);
  const e = obj(event[Object.keys(event)[0]]);
  const named = [pathOf(e.file), pathOf(e.target), pathOf(obj(e.destination).existing_file), destination(e)];
  return named.some((p) => p === file || p === `/private${file}`);
}

/**
 * The `eslogger` event types the observer subscribes to. `write` is left out on
 * purpose: a program writes in many small calls, each its own event, and the
 * volume overran the system's event queue (the observer now notices skipped
 * sequence numbers and refuses to call such a run valid). `truncate` is in: it
 * is rare, and a path truncate is a confirmed modification. A modified file
 * still shows as `close` with `modified: true` (CLOSE_WRITE); a file changed
 * only through a writable memory mapping shows as a close with
 * `was_mapped_writable` (CLOSE_MAPPED) and a write-capable open as OPEN_WRITE,
 * which name the process without confirming a change; and the snapshots catch
 * what a process killed before closing changed. A write made through a
 * descriptor opened before a window, or closed after it, is seen by none of
 * these in that window.
 */
export const ES_EVENTS = ["open", "close", "create", "rename", "unlink", "truncate", "link", "clone", "copyfile", "exchangedata", "setmode", "setowner", "setflags", "setextattr", "deleteextattr", "utimes", "setattrlist", "exec", "fork", "exit", "mount", "remount"];

/** The classifier's view of the macOS subject: which paths are in a persistence surface or a CLI state folder. */
const MAC_STATE = normalizeState({ platform: "macos" });

/**
 * Reduces `EsEvent`s to `FsEvent`s on logical paths, as the Linux observer
 * does: reads only on canaries, writes everywhere under the roots, and one
 * record per path and access within `coalesceMs`, since a single file write
 * can produce thousands of write events. A file is a canary by its device and
 * inode as well as by its path (`canaryInodes`, from `dev:ino` to the canary's
 * logical path): a read through a hard link, or any other second name, is the
 * canary's read, wherever the name is.
 */
export function fsEventsFrom(events: EsEvent[], canaryLogical: Set<string>, roots: Record<string, string> = MACOS_ROOTS, coalesceMs = 1000, canaryInodes: Map<string, string> = new Map()): FsEvent[] {
  const reads = new Set(["OPEN", "CLOSE_NOWRITE"]);
  const last = new Map<string, number>();
  const out: FsEvent[] = [];
  for (const e of events) {
    for (const p of e.paths) {
      const byInode = p.dev !== undefined && p.ino !== undefined ? canaryInodes.get(`${p.dev}:${p.ino}`) : undefined;
      const named = macosLogical(p.path, roots);
      const logical = byInode ?? named;
      if (!logical) continue;
      const kept = canaryLogical.has(logical) ? p.events : p.events.filter((x) => !reads.has(x));
      if (kept.length === 0) continue;
      // A write-capable access is kept with its process on every path, and two processes' accesses are never one record.
      const access = kept.some((x) => ACCESS_EVENTS.has(x));
      const key = `${logical}|${kept.join(",")}|${byInode && named !== byInode ? (named ?? p.path) : ""}|${access ? e.pid : ""}`;
      const prev = last.get(key);
      // Only the app's own churn is coalesced. Every event on a path in a surface or one of the CLI's state folders is kept: the CLI saves the config many times within milliseconds, each rename over it one more state,
      // and a swap of the transcript (a create, a move in, a delete, a second create) is invisible if repeats are dropped.
      if (coalescible(logical, "macos") && prev !== undefined && e.at - prev < coalesceMs) continue;
      last.set(key, e.at);
      // The acting process is kept for every path in a persistence surface or a CLI state folder: it labels an expected change, and tells a write to the session's transcript by the CLI from one by anything else.
      out.push({ at: e.at, path: logical, events: kept, ...(byInode && named !== byInode ? { via: named ?? p.path } : {}), ...(access || scopeOf(logical, MAC_STATE) ? { pid: e.pid } : {}) });
    }
  }
  return out;
}

/** What the observer knows of one process start: the record the judge reads, with whether it ran the CLI binary. */
export function processRecord(e: EsEvent, cli: CliIdentity | null): { pid: number; ppid?: number; exe?: string; cli?: true } | null {
  const p = e.process;
  if (!p) return null;
  const isCli = Boolean(cli && p.exe && isCliBinary({ path: p.exe, size: p.size, cdhash: p.cdhash }, cli));
  return { pid: p.pid, ...(p.ppid !== undefined ? { ppid: p.ppid } : {}), ...(p.exe ? { exe: p.exe } : {}), ...(isCli ? { cli: true as const } : {}) };
}

/** What `mDNSResponder`'s log says about one query: a client request, a request's question, or a question sent upstream with its DNS id. */
export type MdnsRecord =
  | { kind: "request"; at: number; r: number; pid: number; process: string }
  | { kind: "question"; at: number; r: number; q: number }
  | { kind: "sent"; at: number; q: number; id: number; proto: string }
  /** A query from `mDNSResponder`'s own Discovery of Designated Resolvers querier (RFC 9462): asked by the system, for no client. */
  | { kind: "ddr"; at: number; id: number; proto: string };

/** Parses one `log stream --style ndjson` line from `mDNSResponder`. Names are private in that log and never needed. */
/** The real resolver's executable: its log lines are trusted by this path, never by the process name, which any program can choose. */
export const MDNS_IMAGE = "/usr/sbin/mDNSResponder";
/** The user the real resolver daemon runs as (`_mdnsresponder`, measured as the log's `userID`): the same binary run by the subject logs as the subject's uid, and a line from it is refused. */
export const MDNS_UID = 65;

export function parseMdnsLine(line: string): MdnsRecord | null {
  let j: Json;
  try {
    j = JSON.parse(line) as Json;
  } catch {
    return null;
  }
  if (j.processImagePath !== MDNS_IMAGE || j.userID !== MDNS_UID) return null;
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
  /** The subject's uid. */
  uid: number;
  /** The egress proxy's own service uid: the one user that may send anything to the network. */
  egressUid: number;
  appPort: number;
  proxyPort: number;
  decoyPort: number;
  dnsPort: number;
  webAddress: string;
  allowedLoopbackPorts: number[];
  /** The resolvers the egress proxy asks (IPv4). */
  upstreamDns: string[];
  /** The harness peer: the host's address on the VM's network, the only machine SSH may come from and be answered to. */
  peer: string;
}

/**
 * The root-owned pf anchor for the whole machine. For every user, on every
 * interface but `lo0`, it is default-deny and logs what it blocks: pf
 * attributes a setuid tool's packets (traceroute) and a root daemon's
 * (mDNSResponder acting for the subject) to root or to no one, so a rule
 * scoped to the subject's uid cannot stop them, and nothing here passes root.
 * What passes off the loopback: the control channel (inbound SSH from the
 * harness peer only, with state, also picked up mid-stream so a session open
 * when the anchor loads survives, and the server's replies from port 22 to that
 * peer only, logged; the subject cannot use that reply rule because it cannot
 * send from port 22: launchd holds `*:22`, measured as `EADDRINUSE` for a
 * wildcard bind under every option and `EACCES` for a specific address, and the
 * preflight proves it again every run), and the egress proxy's own user (a dedicated service account,
 * not root and not the subject) reaching the model API on 443 and the
 * resolvers it asks on 53. A user match was chosen over matching the model
 * API's addresses because address matching would let the subject connect to
 * the API directly and bypass the proxy and its log. On the loopback the
 * subject reaches only the app, the proxy, the decoy (so its listener
 * records the attempt), the harness web server and the logging resolver;
 * everything else from its uid is blocked and logged with the uid. DHCP
 * renewals are sent over BPF and are not filtered by pf.
 */
export function pfAnchor(i: PfAnchorInput): string {
  for (const p of [i.appPort, i.proxyPort, i.decoyPort, i.dnsPort, ...i.allowedLoopbackPorts]) if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`bad port ${p}`);
  if (!Number.isInteger(i.uid) || i.uid < 1) throw new Error("bad uid");
  if (!Number.isInteger(i.egressUid) || i.egressUid < 1 || i.egressUid >= 500 || i.egressUid === i.uid) throw new Error("bad egress uid");
  if (isIP(i.webAddress) !== 4) throw new Error("bad web address");
  if (isIP(i.peer) !== 4) throw new Error("bad peer address");
  const dns = i.upstreamDns.filter((a) => isIP(a) === 4);
  if (dns.length === 0) throw new Error("the egress proxy needs at least one IPv4 upstream resolver");
  const loopbackTcp = [i.appPort, i.proxyPort, i.decoyPort, ...i.allowedLoopbackPorts].join(" ");
  return [
    "# T1 confinement (#225); generated, loaded under com.apple/ by the harness, removed on cleanup.",
    "pass in quick on lo0 all keep state",
    // For every user: pf's user match does not apply to IPv6 link-local, which reaches the host's services on the gateway. IPv6 is also off on the uplink.
    "block drop out log quick on ! lo0 inet6 from any to fe80::/10",
    // The control channel: SSH in from the harness peer only, with state, from any packet (a session already open), and the server's replies to that peer, logged.
    // The subject cannot send from port 22 to anywhere: launchd holds *:22 (measured: a wildcard bind fails with EADDRINUSE under every option, and a specific address with EACCES); the preflight proves it again.
    `pass in quick on ! lo0 inet proto tcp from ${i.peer} to any port 22 flags any keep state`,
    `pass out log quick on ! lo0 inet proto tcp from any port 22 to ${i.peer} flags any keep state`,
    // The egress proxy's own user: the model API, and the resolvers it asks. No other user passes anything.
    `pass out log quick on ! lo0 inet proto tcp from any to any port 443 user ${i.egressUid} keep state`,
    `pass out log quick on ! lo0 inet proto { udp tcp } from any to { ${dns.join(" ")} } port 53 user ${i.egressUid} keep state`,
    // The subject, on the loopback.
    `pass out log quick on lo0 proto tcp from any to 127.0.0.1 port { ${loopbackTcp} } user ${i.uid} keep state`,
    `pass out log quick on lo0 proto tcp from any to ::1 port { ${[i.decoyPort, ...i.allowedLoopbackPorts].join(" ")} } user ${i.uid} keep state`,
    `pass out log quick proto tcp from any to ${i.webAddress} port { 80 443 } user ${i.uid} keep state`,
    `pass out log quick on lo0 proto udp from any to 127.0.0.1 port ${i.dnsPort} user ${i.uid} keep state`,
    `block drop out log quick proto { tcp udp } all user ${i.uid}`,
    // Default-deny for everyone, logged. Inbound is blocked quietly: the network's own broadcasts would fill the log.
    "block drop out log quick on ! lo0 all",
    "block drop in quick on ! lo0 all",
    "",
  ].join("\n");
}

/** Tracks `eslogger`'s sequence numbers: a skipped number means the system dropped events before this client saw them. */
export class EsSeqTracker {
  private lastGlobal: number | null = null;
  private readonly lastByType = new Map<string, number>();
  /** Events known missing so far. */
  missing = 0;

  /** Feeds one line; returns how many events were skipped just before it (0 when none or when it carries no numbers). */
  feed(line: string): number {
    const g = /"global_seq_num"\s*:\s*(\d+)/.exec(line);
    const q = /[,{]"seq_num"\s*:\s*(\d+)/.exec(line);
    const t = /"event_type"\s*:\s*(\d+)/.exec(line);
    let skipped = 0;
    if (g) {
      const n = Number(g[1]);
      if (this.lastGlobal !== null && n > this.lastGlobal + 1) skipped = Math.max(skipped, n - this.lastGlobal - 1);
      this.lastGlobal = this.lastGlobal === null ? n : Math.max(this.lastGlobal, n);
    }
    if (q && t) {
      const n = Number(q[1]);
      const last = this.lastByType.get(t[1]);
      if (last !== undefined && n > last + 1) skipped = Math.max(skipped, n - last - 1);
      this.lastByType.set(t[1], last === undefined ? n : Math.max(last, n));
    }
    this.missing += skipped;
    return skipped;
  }
}

/** What `tcpdump` prints to standard error when it stops: how many packets it captured, saw, and lost. */
export function parseTcpdumpStats(stderr: string): { captured: number; received: number; droppedKernel: number; droppedInterface: number } | null {
  const num = (re: RegExp) => Number(re.exec(stderr)?.[1] ?? NaN);
  const captured = num(/(\d+) packets? captured/);
  if (!Number.isFinite(captured)) return null;
  const n = (re: RegExp) => {
    const v = num(re);
    return Number.isFinite(v) ? v : 0;
  };
  return { captured, received: n(/(\d+) packets? received by filter/), droppedKernel: n(/(\d+) packets? dropped by kernel/), droppedInterface: n(/(\d+) packets? dropped by interface/) };
}
