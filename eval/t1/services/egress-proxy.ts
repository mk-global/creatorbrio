/**
 * The subject's single route out (#225): a forward proxy that accepts only
 * `CONNECT` to an allowlisted host and port (the model API), connects only
 * to public addresses that name resolves to, refuses everything else, and
 * logs every request with its decision and byte counts. It never logs a
 * payload, and names outside the harness's own are kept only as a suffix
 * plus a hash. It counts model API connections and bytes per phase (the
 * observer mirrors the current phase into a file it reads) and refuses beyond
 * the configured ceiling, logging each refusal, because the subject holds the
 * token and could start model calls of its own. Every tunnel has a lifetime
 * cap (the phase deadline plus the driver's margin), and the tunnels of a
 * phase are closed when the phase ends, so nothing opened in one window
 * carries traffic in the next; a tunnel the proxy closes says why in its
 * closing line. A connection turned away for the proxy's own limit is logged as
 * lost evidence. Runs as root in the egress
 * container on Linux (the only container on both the internal network and an
 * outbound bridge) and, on macOS, as its own service account, the one user the
 * pf anchor lets reach the network.
 */
import { lookup, Resolver } from "node:dns/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { nameSummary, proxyAddressAllowed, proxyDecision } from "../lib/policy";
import { boundText, matchCanaries, plainOrHash, sha256 } from "../lib/scrub";
import { PhaseLedger } from "../lib/spend";
import { heartbeat, jsonl, loadCanaries, loadConfig, onStop, readPhase } from "./common";

const cfg = loadConfig();
const canaries = loadCanaries();
const log = jsonl("proxy.jsonl");
const known = [...Object.keys(cfg.harnessNames), ...cfg.modelHosts];
const MAX_HEAD = 16 * 1024;
const MAX_OPEN = 256;
let open = 0;
let turnedAway = 0;
const ledger = cfg.modelBudget ? new PhaseLedger(cfg.modelBudget) : null;
/** A tunnel's longest life: the phase deadline and the driver's margin, so nothing outlives the phase it was opened for. */
const LIFETIME_MS = ((cfg.phaseDeadlineSeconds ?? 2400) + 120) * 1000;
/** The open tunnels, with the phase each was opened in, so a phase's end and its byte ceiling can close them. */
const tunnels = new Set<{ phase: string; model: boolean; close: (cap: string) => void }>();
let currentPhase = readPhase();
const phaseWatch = setInterval(() => {
  const now = readPhase();
  if (now === currentPhase) return;
  currentPhase = now;
  for (const t of [...tunnels]) if (t.phase !== now) t.close("phase_ended");
}, 250);

/**
 * Where the proxy resolves allowlisted names: the system resolver on Linux;
 * on macOS, where the system resolver is the harness's logging one, the
 * upstream resolvers the VM had before the run, asked directly.
 */
async function resolveAll(host: string): Promise<{ address: string; family: number }[]> {
  if (!cfg.upstreamDns?.length) return lookup(host, { all: true });
  const r = new Resolver({ timeout: 3000, tries: 2 });
  r.setServers(cfg.upstreamDns);
  const [v4, v6] = await Promise.allSettled([r.resolve4(host), r.resolve6(host)]);
  const out = [
    ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
    ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
  ];
  if (out.length === 0) throw new Error("unresolvable");
  return out;
}

function summarizeTarget(method: string, target: string): string {
  const m = /^([^:/\s]+|\[[^\]]+\]):(\d+)$/.exec(target);
  if (m) return `${nameSummary(m[1], known, canaries).name}:${m[2]}`;
  try {
    const u = new URL(target);
    return `${u.protocol === "http:" || u.protocol === "https:" ? u.protocol : plainOrHash(u.protocol, new Set())}//${nameSummary(u.hostname, known, canaries).name}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return boundText(`${method} <${target.length} chars>`, 40);
  }
}

const server = createServer((client: Socket) => {
  const started = Date.now();
  if (open >= MAX_OPEN) {
    client.destroy();
    // Evidence the proxy could not record: the first, and then every hundredth, so the log cannot be flooded.
    if (turnedAway++ % 100 === 0) log.write({ type: "loss", at: started, observer: "proxy", reason: `the proxy's connection limit (${MAX_OPEN} open) turned connections away (${turnedAway} so far)`, scope: "run" });
    return;
  }
  open++;
  let head = Buffer.alloc(0);
  let up = 0;
  let down = 0;
  let record: Record<string, unknown> | null = null;
  let cap: string | null = null;
  const finish = () => {
    if (record?.decision === "allowed") log.write({ ...record, type: "proxy_end", bytesUp: up, bytesDown: down, durationMs: Date.now() - started, ...(cap ? { cap } : {}) });
    else if (record) log.write({ ...record, bytesUp: up, bytesDown: down, durationMs: Date.now() - started });
    record = null;
  };
  client.on("close", () => {
    open--;
    finish();
  });
  client.on("error", () => {});
  client.setTimeout(15_000, () => client.destroy());

  const onData = async (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0 && head.length < MAX_HEAD) return;
    client.off("data", onData);
    client.pause();
    const text = head.subarray(0, end < 0 ? head.length : end).toString("latin1");
    const [method = "", target = ""] = (text.split("\r\n")[0] ?? "").split(" ");
    const base = { type: "proxy", at: started, method: boundText(method, 12), target: summarizeTarget(method, target), targetSha256: sha256(target), matched: matchCanaries(head, canaries) };
    const decision = proxyDecision(method, target, cfg.allowlist);
    const refuse = (reason: string) => {
      record = { ...base, decision: "refused", reason, model: false };
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    if (!decision.allow) return refuse(decision.reason);
    const isModel = cfg.modelHosts.includes(decision.host);
    const phase = readPhase();
    if (isModel && ledger) {
      const verdict = ledger.admit(phase);
      if (verdict !== "allow") return refuse(verdict);
    }
    // Logged now, so a tunnel that never closes (or a container removed mid-run) still leaves its line.
    record = { ...base, decision: "allowed", reason: "allowlisted", model: isModel };
    log.write({ ...record, bytesUp: 0, bytesDown: 0, durationMs: 0, stage: "decision" });
    const fail = (reason: string) => {
      log.write({ ...base, type: "proxy_upstream", decision: "failed", reason, durationMs: Date.now() - started });
      record = null;
      client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    let addresses: { address: string; family: number }[] = [];
    try {
      addresses = await resolveAll(decision.host);
    } catch {
      return fail("unresolvable");
    }
    // IPv4 first: the outbound bridge has no IPv6 route, and a v6 connect would only time out.
    const usable = addresses
      .filter((a) => proxyAddressAllowed(a.address, [cfg.subnet]))
      .sort((a, b) => a.family - b.family)
      .map((a) => a.address);
    if (usable.length === 0) return fail("address_not_public");
    const attempt = (i: number) => {
      if (i >= usable.length) return fail("upstream_unreachable");
      const upstream = createConnection({ host: usable[i], port: decision.port });
      upstream.setTimeout(5_000, () => upstream.destroy(new Error("connect timeout")));
      let connected = false;
      upstream.on("error", () => {
        if (!connected) attempt(i + 1);
        else client.destroy();
      });
      upstream.once("connect", () => {
        connected = true;
        // Which address the tunnel really reached, so the uplink capture's flows can be matched to the proxy's own connections.
        log.write({ type: "proxy_connect", at: Date.now(), host: decision.host, address: usable[i], port: decision.port });
        upstream.setTimeout(0);
        client.setTimeout(600_000, () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = end < 0 ? Buffer.alloc(0) : head.subarray(end + 4);
        if (rest.length > 0) {
          up += rest.length;
          upstream.write(rest);
        }
        const tunnel = {
          phase,
          model: isModel,
          close: (why: string) => {
            cap ??= why;
            client.destroy();
            upstream.destroy();
          },
        };
        tunnels.add(tunnel);
        const lifetime = setTimeout(() => tunnel.close("lifetime"), LIFETIME_MS);
        client.on("close", () => {
          clearTimeout(lifetime);
          tunnels.delete(tunnel);
        });
        // Bytes count against the phase the tunnel was opened in; at the phase's byte ceiling every one of its tunnels is cut.
        const carried = (n: number) => {
          if (isModel && ledger?.carried(phase, n)) for (const t of [...tunnels]) if (t.phase === phase && t.model) t.close("bytes");
        };
        client.on("data", (d: Buffer) => {
          up += d.length;
          carried(d.length);
        });
        upstream.on("data", (d: Buffer) => {
          down += d.length;
          carried(d.length);
        });
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
      });
    };
    attempt(0);
  };
  client.on("data", onData);
});

server.listen(cfg.proxyPort, cfg.addresses.egress, () => {
  log.write({ type: "ready", at: Date.now(), allowlist: cfg.allowlist });
});
const hb = heartbeat(log, { proxy: () => server.listening });
onStop(() => {
  clearInterval(hb);
  clearInterval(phaseWatch);
  server.close();
});
