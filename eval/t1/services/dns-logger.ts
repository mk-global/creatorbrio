/**
 * The subject's resolver (#225): answers only the harness's own names with
 * their fixed addresses and NXDOMAIN for everything else, and logs every
 * query, so a lookup of an outside name (including data smuggled out in
 * labels) is evidence even though it resolves nowhere. Names outside the
 * harness's own are kept only as a suffix plus a hash. TCP connections to
 * port 53 are logged and closed. Runs as root in a container on the internal
 * network only, which also serves as the subject's blackhole default route.
 */
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { buildDnsResponse, dnsDecision, nameSummary, parseDnsQuery } from "../lib/policy";
import { heartbeat, jsonl, loadCanaries, loadConfig, onStop } from "./common";

const cfg = loadConfig();
const canaries = loadCanaries();
const log = jsonl("dns.jsonl");
const known = [...Object.keys(cfg.harnessNames), ...cfg.modelHosts];
let udpUp = false;

const udp = createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  const at = Date.now();
  const q = parseDnsQuery(msg);
  if (!q) {
    log.write({ type: "dns", at, src: rinfo.address, malformed: true, length: msg.length, name: "<malformed>", qtype: 0, harness: false, model: false, matched: [] });
    return;
  }
  const decision = dnsDecision(q.name, q.qtype, cfg.harnessNames);
  const summary = nameSummary(q.name, known, canaries);
  log.write({
    type: "dns",
    at,
    src: rinfo.address,
    srcPort: rinfo.port,
    id: q.id,
    qtype: q.qtype,
    name: summary.name,
    sha256: summary.sha256,
    harness: decision.harness,
    model: cfg.modelHosts.includes(q.name.toLowerCase().replace(/\.$/, "")),
    rcode: decision.rcode,
    matched: summary.matched,
  });
  udp.send(buildDnsResponse(msg, q, decision), rinfo.port, rinfo.address);
});
udp.on("listening", () => {
  udpUp = true;
  log.write({ type: "ready", at: Date.now() });
});
udp.on("close", () => (udpUp = false));
udp.bind(53, cfg.addresses.dns);

const tcp = createServer((socket) => {
  log.write({ type: "dns", at: Date.now(), src: socket.remoteAddress ?? "", tcp: true, name: "<tcp>", qtype: 0, harness: false, model: false, matched: [] });
  socket.on("error", () => {});
  socket.destroy();
});
tcp.listen(53, cfg.addresses.dns);

const hb = heartbeat(log, { dns: () => udpUp && tcp.listening });
onStop(() => {
  clearInterval(hb);
  udp.close();
  tcp.close();
});
