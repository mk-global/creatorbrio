// A real OS process that starts as a contained server does (#246), for the
// cross-process tests in tests/contained-server.test.ts: it waits until the
// given moment (so several start at once), takes the ownership records,
// installs the shutdown hook when it owns them, prints one JSON line with
// what it found, and then runs until it is signalled.
//
// Usage: node --import ./register.mjs contained-server-worker.mts <data folder> <agent folders> <repository> <start at, ms since the epoch>
import { installShutdownHook } from "../../../src/lib/agent-processes";
import { claimContainedServer, containedServerStatus } from "../../../src/lib/contained-server";

// Standard output carries the one JSON line below, so informational logs, such as a stale record's takeover, go to standard error.
console.info = console.error;

const [dataDir, agentsRoot, repoDir, startAt] = process.argv.slice(2);
const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
const claim = await claimContainedServer({ dataDir, agentsRoot, repoDir });
if (claim.owned) installShutdownHook();
const status = await containedServerStatus();
process.stdout.write(`${JSON.stringify({ pid: process.pid, owned: claim.owned, status })}\n`);
setInterval(() => {}, 1000);
