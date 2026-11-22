// A stand-in for the development server's worker (#241): it tracks a run whose
// CLI leads its own process group, as the app starts it, and then waits to be
// signalled. The test plays the supervisor that ends it shortly after.
//
// The CLI starts a live command in a group of its own, and a command in
// another group of its own that leaves a job behind (same group, working
// outside the run's folders) and exits, so the job is orphaned while the run
// is live. Only a process the periodic look recorded can be stopped at
// shutdown: the shutdown window has no time to find the job otherwise.
//
// Usage: node shutdown-worker.mjs <run folder> <folder outside it> <record file>
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createJiti } from "jiti";

const [folder, outside, record] = process.argv.slice(2);
const jiti = createJiti(import.meta.url);
const { trackRun } = await jiti.import("../../src/lib/agent-processes.ts");

const CLI = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [folder, outside, record] = process.argv.slice(1);
const forever = ["-e", "setInterval(() => {}, 1000)"];
const pids = { cli: process.pid };
pids.sameGroup = spawn(process.execPath, forever, { stdio: "ignore" }).pid;
pids.liveCommand = spawn(process.execPath, forever, { stdio: "ignore", detached: true, cwd: outside }).pid;
const command = spawn(process.execPath, ["-e", "const j = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', cwd: process.argv[1] }); require('node:fs').writeFileSync(process.argv[2], String(j.pid)); j.unref(); setTimeout(() => process.exit(0), 700);", outside, record + ".job"], { stdio: "ignore", detached: true, cwd: outside });
command.on("exit", () => {
  pids.job = Number(fs.readFileSync(record + ".job", "utf8"));
  fs.writeFileSync(record, JSON.stringify(pids));
});
setInterval(() => {}, 1000);
`;

const cli = spawn(process.execPath, ["-e", CLI, folder, outside, record], { cwd: folder, detached: true, stdio: "ignore" });
trackRun({
  leaderPid: cli.pid,
  folders: [folder],
  abort: () => {},
  leaderUnreaped: () => cli.exitCode === null && cli.signalCode === null,
  recordEveryMs: 50,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Ready once the command has gone, leaving its job behind, and the look has had time to record it.
while (!fs.existsSync(record)) await sleep(25);
await sleep(400);
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
