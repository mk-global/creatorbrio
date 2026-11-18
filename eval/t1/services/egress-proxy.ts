/**
 * The subject's single route out (#225): a forward proxy that accepts only
 * `CONNECT` to an allowlisted host and port (the model API), connects only
 * to public addresses that name resolves to, refuses everything else, and
 * logs every request with its decision and byte counts. It never logs a
 * payload, and names outside the harness's own are kept only as a suffix
 * plus a hash. Runs as root in the egress container, the only container on
 * both the internal network and an outbound bridge.
 */
import { lookup } from "node:dns/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { nameSummary, proxyAddressAllowed, proxyDecision } from "../lib/policy";
import { boundText, matchCanaries } from "../lib/scrub";
import { heartbeat, jsonl, loadCanaries, loadConfig, onStop } from "./common";

const cfg = loadConfig();
const canaries = loadCanaries();
const log = jsonl("proxy.jsonl");
const known = [...Object.keys(cfg.harnessNames), ...cfg.modelHosts];
const MAX_HEAD = 16 * 1024;
let open = 0;

function summarizeTarget(method: string, target: string): string {
  const m = /^([^:/\s]+|\[[^\]]+\]):(\d+)$/.exec(target);
  if (m) return `${nameSummary(m[1], known, canaries).name}:${m[2]}`;
  try {
    const u = new URL(target);
    return `${u.protocol}//${nameSummary(u.hostname, known, canaries).name}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return boundText(`${method} <${target.length} chars>`, 40);
  }
}

const server = createServer((client: Socket) => {
  const started = Date.now();
  if (open >= 256) {
    client.destroy();
    return;
  }
  open++;
  let head = Buffer.alloc(0);
  let up = 0;
  let down = 0;
  let record: Record<string, unknown> | null = null;
  const finish = () => {
    if (record?.decision === "allowed") log.write({ ...record, type: "proxy_end", bytesUp: up, bytesDown: down, durationMs: Date.now() - started });
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
    const base = { type: "proxy", at: started, method: boundText(method, 12), target: summarizeTarget(method, target), matched: matchCanaries(head, canaries) };
    const decision = proxyDecision(method, target, cfg.allowlist);
    const refuse = (reason: string) => {
      record = { ...base, decision: "refused", reason, model: false };
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    if (!decision.allow) return refuse(decision.reason);
    // Logged now, so a tunnel that never closes (or a container removed mid-run) still leaves its line.
    record = { ...base, decision: "allowed", reason: "allowlisted", model: cfg.modelHosts.includes(decision.host) };
    log.write({ ...record, bytesUp: 0, bytesDown: 0, durationMs: 0, stage: "decision" });
    const fail = (reason: string) => {
      log.write({ ...base, type: "proxy_upstream", decision: "failed", reason, durationMs: Date.now() - started });
      record = null;
      client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    let addresses: { address: string; family: number }[] = [];
    try {
      addresses = await lookup(decision.host, { all: true });
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
        upstream.setTimeout(0);
        client.setTimeout(600_000, () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = end < 0 ? Buffer.alloc(0) : head.subarray(end + 4);
        if (rest.length > 0) {
          up += rest.length;
          upstream.write(rest);
        }
        client.on("data", (d: Buffer) => (up += d.length));
        upstream.on("data", (d: Buffer) => (down += d.length));
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
  server.close();
});
