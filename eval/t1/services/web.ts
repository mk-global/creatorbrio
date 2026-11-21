/**
 * The hostile page and the exfiltration sink (#225), at `web.t1.test` on
 * HTTPS (with a per-run harness certificate authority the subject trusts
 * only through NODE_EXTRA_CA_CERTS) and plain HTTP. The page is read from the
 * run's config folder on every request, so the page the runner writes after
 * setup is the page that is served; the service refuses to start without one
 * and answers 503 while the file is still the placeholder. Every page request
 * is logged with the SHA-256 and length of the body it was served, the
 * requester's address and port and its user agent. A sink request is kept only
 * as its hash, length and the canaries it carried; any other request is
 * logged as egress. The authority's key never leaves this container; only its
 * certificate is published to the run volume.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { currentPage } from "../lib/page";
import { expectedSinkIds, plainPath, plainUserAgent, sinkRecord } from "../lib/policy";
import { boundText, matchCanaries, safeReadFile } from "../lib/scrub";
import path from "node:path";
import { heartbeat, jsonl, loadCanaries, loadConfig, onStop, RECORDS, runDir } from "./common";

const cfg = loadConfig();
const canaries = loadCanaries();
const log = jsonl("web.jsonl");
const sinkIds = expectedSinkIds(cfg.canaryPaths);
const PAGE = `${RECORDS}/config/brief.html`;
const MAX_BODY = 1024 * 1024;

if (!safeReadFile(PAGE, MAX_BODY, { root: RECORDS }).ok) throw new Error("there is no page to serve (config/brief.html); refusing to start");
const PKI = "/var/t1web";
const HOST = "web.t1.test";

function makePki() {
  mkdirSync(PKI, { recursive: true, mode: 0o700 });
  const run = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${PKI}/ca.key`, "-out", `${PKI}/ca.pem`, "-days", "2", "-subj", "/CN=T1 harness test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${PKI}/web.key`, "-out", `${PKI}/web.csr`, "-subj", `/CN=${HOST}`]);
  execFileSync("sh", ["-c", `printf 'subjectAltName=DNS:${HOST}\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth\\n' > ${PKI}/ext.cnf`]);
  run(["x509", "-req", "-in", `${PKI}/web.csr`, "-CA", `${PKI}/ca.pem`, "-CAkey", `${PKI}/ca.key`, "-CAcreateserial", "-out", `${PKI}/web.pem`, "-days", "2", "-extfile", `${PKI}/ext.cnf`]);
  copyFileSync(`${PKI}/ca.pem`, path.join(runDir(cfg), "ca.pem"));
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
      // A request is the page's delivery only when it is a bare GET or HEAD of exactly the page: no query, no body. Anything else on that path is logged as any other request, with its canary matches.
      if (url === "/brief.html" && (method === "GET" || method === "HEAD") && size === 0) {
        const page = currentPage(PAGE, RECORDS);
        const body = page.ok ? page.body : Buffer.alloc(0);
        log.write({
          type: "page",
          at,
          method,
          scheme,
          path: "/brief.html",
          status: page.ok ? 200 : 503,
          sha256: page.ok ? page.sha256 : null,
          length: body.length,
          unavailable: page.ok ? undefined : page.reason,
          remote: boundText(req.socket.remoteAddress ?? "", 64),
          remotePort: req.socket.remotePort ?? 0,
          userAgent: plainUserAgent(String(req.headers["user-agent"] ?? "")),
          // Even a bare request can carry a canary in a header: matched like everything else the web server sees.
          matchedCanaryIds: [...new Set([...matchCanaries(headers, canaries), ...matchCanaries(url, canaries)])].sort(),
        });
        if (!page.ok) {
          res.writeHead(503, { "cache-control": "no-store" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": String(body.length) });
        res.end(method === "HEAD" ? undefined : body);
        return;
      }
      if (url.startsWith("/sink")) {
        log.write({ ...sinkRecord({ at, method, path: url, headers, body }, canaries, sinkIds), scheme });
        res.writeHead(204);
        res.end();
        return;
      }
      log.write({ type: "other", at, method: boundText(method, 12), scheme, path: plainPath(url, canaries), length: size, matchedCanaryIds: [...new Set([...matchCanaries(body, canaries), ...matchCanaries(url, canaries), ...matchCanaries(headers, canaries)])].sort() });
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
