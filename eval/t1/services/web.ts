/**
 * The hostile page and the exfiltration sink (#225), at `web.t1.test` on
 * HTTPS (with a per-run harness certificate authority the subject trusts
 * only through NODE_EXTRA_CA_CERTS) and plain HTTP. The page is served as
 * given; a sink request is kept only as its hash, length and the canaries it
 * carried; any other request is logged as egress. The authority's key never
 * leaves this container; only its certificate is published to the run volume.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { sanitizePath } from "../lib/pcap";
import { sinkRecord } from "../lib/policy";
import { boundText, matchCanaries } from "../lib/scrub";
import { heartbeat, jsonl, loadCanaries, loadConfig, onStop, RECORDS } from "./common";

const cfg = loadConfig();
const canaries = loadCanaries();
const log = jsonl("web.jsonl");
const page = readFileSync(`${RECORDS}/config/brief.html`);
const MAX_BODY = 1024 * 1024;
const PKI = "/var/t1web";
const HOST = "web.t1.test";

function makePki() {
  mkdirSync(PKI, { recursive: true, mode: 0o700 });
  const run = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${PKI}/ca.key`, "-out", `${PKI}/ca.pem`, "-days", "2", "-subj", "/CN=T1 harness test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${PKI}/web.key`, "-out", `${PKI}/web.csr`, "-subj", `/CN=${HOST}`]);
  execFileSync("sh", ["-c", `printf 'subjectAltName=DNS:${HOST}\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth\\n' > ${PKI}/ext.cnf`]);
  run(["x509", "-req", "-in", `${PKI}/web.csr`, "-CA", `${PKI}/ca.pem`, "-CAkey", `${PKI}/ca.key`, "-CAcreateserial", "-out", `${PKI}/web.pem`, "-days", "2", "-extfile", `${PKI}/ext.cnf`]);
  copyFileSync(`${PKI}/ca.pem`, "/run/t1/ca.pem");
}

function handler(scheme: "http" | "https") {
  return (req: IncomingMessage, res: ServerResponse) => {
    const at = Date.now();
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= MAX_BODY) chunks.push(d);
      else req.destroy();
    });
    req.on("error", () => {});
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? "/";
      const method = req.method ?? "?";
      const headers = req.rawHeaders.join("\n");
      if (url.split("?")[0] === "/brief.html" && (method === "GET" || method === "HEAD")) {
        log.write({ type: "page", at, method, scheme, path: "/brief.html", userAgent: boundText(String(req.headers["user-agent"] ?? ""), 80) });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(method === "HEAD" ? undefined : page);
        return;
      }
      if (url.startsWith("/sink")) {
        log.write({ ...sinkRecord({ at, method, path: url, headers, body }, canaries), scheme });
        res.writeHead(204);
        res.end();
        return;
      }
      log.write({ type: "other", at, method: boundText(method, 12), scheme, path: sanitizePath(url, canaries), length: size, matchedCanaryIds: [...new Set([...matchCanaries(body, canaries), ...matchCanaries(url, canaries), ...matchCanaries(headers, canaries)])].sort() });
      res.writeHead(404);
      res.end();
    });
  };
}

makePki();
const https = createHttps({ key: readFileSync(`${PKI}/web.key`), cert: readFileSync(`${PKI}/web.pem`) }, handler("https"));
const http = createHttp(handler("http"));
https.listen(443, cfg.addresses.web);
http.listen(80, cfg.addresses.web, () => log.write({ type: "ready", at: Date.now() }));
const hb = heartbeat(log, { web: () => https.listening && http.listening });
onStop(() => {
  clearInterval(hb);
  https.close();
  http.close();
});
