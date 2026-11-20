/**
 * Finds which TCP ports answer on one address (#225), so the isolation
 * preflight can require the subject to fail on every one of them. Run as root
 * in the macOS VM, which pf does not confine: a plain connect to every port,
 * closed at once without sending anything, a few hundred at a time.
 *
 *   scan-ports.ts <address>   prints {"address":..., "open":[...]} on one line
 */
import { createConnection, isIP } from "node:net";

const address = process.argv[2] ?? "";
if (!isIP(address.replace(/%.*$/, ""))) throw new Error("an IP address is required");
const TIMEOUT_MS = 700;
const CONCURRENCY = 400;

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: address, port });
    const done = (open: boolean) => {
      s.destroy();
      resolve(open);
    };
    s.setTimeout(TIMEOUT_MS, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const open: number[] = [];
let next = 1;
async function worker() {
  while (next <= 65535) {
    const port = next++;
    if (await probe(port)) open.push(port);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write(`${JSON.stringify({ address, open: open.sort((a, b) => a - b) })}\n`);
