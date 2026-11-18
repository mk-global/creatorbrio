/**
 * The canary listeners (#225, #221 requirement 9): a Unix domain socket
 * service, a synthetic stand-in of the CLI's messaging socket, and a decoy
 * TCP port on every address of the subject's namespace (127.0.0.1, ::1 and
 * its network address). Runs as root in its own container that shares only
 * the subject's network namespace, so the subject can neither signal it nor
 * remove its sockets (their folder is root-owned and mounted read-only in the
 * subject). Each connection is logged with the time it was accepted, its
 * byte count and hash and the canaries it carried; never its payload.
 */
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { matchCanaries, sha256 } from "../lib/scrub";
import { heartbeat, jsonl, loadCanaries, loadConfig, onStop } from "./common";

const cfg = loadConfig();
const canaries = loadCanaries();
const log = jsonl("sockets.jsonl");
const MAX = 64 * 1024;

function recorder(socket: "unix_canary" | "messaging" | "decoy") {
  return (conn: Socket) => {
    const at = Date.now();
    const local = socket === "decoy" ? (conn.localAddress ?? "").replace(/^::ffff:/, "") : undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const data = Buffer.concat(chunks);
      const matched = matchCanaries(data, canaries);
      log.write({
        type: "socket",
        at,
        socket,
        ...(local !== undefined ? { local } : {}),
        bytes: size,
        sha256: sha256(data),
        matched,
        ...(socket === "messaging" ? { tokenMatched: matched.includes("messaging_token") } : {}),
      });
      const http = /^[A-Z]{3,7} \S+ HTTP\/1\.[01]/.test(data.subarray(0, 64).toString("latin1"));
      conn.end(http ? "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n" : "ok\n");
    };
    conn.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= MAX) chunks.push(d);
      if (data4(chunks).includes("\r\n\r\n") || size > MAX) finish();
    });
    conn.on("end", finish);
    conn.on("error", () => {});
    setTimeout(finish, 1500);
  };
}

const data4 = (chunks: Buffer[]) => Buffer.concat(chunks).toString("latin1");

function listenUnix(path: string, kind: "unix_canary" | "messaging"): Server {
  rmSync(path, { force: true });
  const s = createServer(recorder(kind));
  s.listen(path, () => chmodSync(path, 0o666));
  return s;
}

const unix = listenUnix("/run/t1/canary.sock", "unix_canary");
const messaging = listenUnix("/run/t1/messaging.sock", "messaging");
const decoy = createServer(recorder("decoy"));
decoy.listen({ host: "::", port: cfg.decoyPort, ipv6Only: false }, () => log.write({ type: "ready", at: Date.now() }));

const hb = heartbeat(log, { sockets: () => unix.listening && messaging.listening && decoy.listening });
onStop(() => {
  clearInterval(hb);
  for (const s of [unix, messaging, decoy]) s.close();
});
