import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classify,
  containedFolders,
  descendantsOf,
  lsofProbe,
  main,
  parseLsofCwd,
  parseLsofListeners,
  parsePortArg,
  parseProcNetTcp,
  parseProcStatLine,
  parsePsLine,
  parsePsProcesses,
  planStop,
  procProbe,
  stopDescendants,
} from "../scripts/stop-server.mjs";

const ROOT = "/work/creatorbrio";
const OTHER = "/work/creatorbrio-feature";
const UID = 501;

const next = (cwd = ROOT, uid = UID) => ({ uid, command: "next-server (v16.2.3)", cwd });

describe("the /stop command", () => {
  it("delegates to the script instead of killing a port itself", () => {
    const command = readFileSync(
      path.join(__dirname, "..", ".claude", "commands", "stop.md"),
      "utf-8"
    );
    const body = command.split("---").slice(2).join("---");
    expect(body).toContain('node scripts/stop-server.mjs "$ARGUMENTS"');
    // The previous command killed whatever listened on a port, 3000 by default.
    expect(command).not.toMatch(/xargs kill|3000/);
  });
});

describe("parsing what the system reports", () => {
  it("reads lsof listeners, including IPv6 and wildcard addresses", () => {
    const output = [
      "p812",
      "f23",
      "n127.0.0.1:3010",
      "p900",
      "f5",
      "n*:3000",
      "f6",
      "n[::1]:3000",
      "",
    ].join("\n");
    expect(parseLsofListeners(output)).toEqual([
      { pid: 812, port: 3010 },
      { pid: 900, port: 3000 },
    ]);
    expect(parseLsofListeners("")).toEqual([]);
  });

  it("reads ps and lsof process details", () => {
    expect(parsePsLine("  501 next-server (v16.2.3)    \n")).toEqual({
      uid: 501,
      command: "next-server (v16.2.3)",
    });
    expect(parsePsLine("")).toBeNull();
    expect(parseLsofCwd("p812\nfcwd\nn/Users/me/creatorbrio\n")).toBe("/Users/me/creatorbrio");
    expect(parseLsofCwd("")).toBeNull();
  });

  it("reads listening sockets from /proc/net/tcp and skips other states", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0BC2 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 3506 1 0 100 0 0 10 0",
      "   1: 0100007F:0BB8 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000   501        0 4100 1 0 100 0 0 10 0",
      "   2: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 501 0 4200 1 0 100 0 0 10 0",
    ].join("\n");
    expect([...parseProcNetTcp(table)]).toEqual([
      ["3506", 3010],
      ["4200", 3000],
    ]);
  });

  it("accepts only real port numbers", () => {
    expect(parsePortArg(undefined)).toBeUndefined();
    expect(parsePortArg("")).toBeUndefined();
    expect(parsePortArg(" 3010 ")).toBe(3010);
    for (const bad of ["0", "65536", "abc", "30 10", "-1", "3000;ls"]) {
      expect(parsePortArg(bad)).toBeNaN();
    }
  });
});

describe("recognising this checkout's server", () => {
  const ctx = { root: ROOT, uid: UID };

  it("needs the same user, a Next.js server command and this checkout's directory", () => {
    expect(classify(next(), ctx)).toBe("ours");
    expect(classify({ ...next(), command: "node /work/creatorbrio/node_modules/.bin/next dev -H 127.0.0.1" }, ctx)).toBe("ours");
    expect(classify({ ...next(), command: "node /work/creatorbrio/node_modules/next/dist/bin/next start" }, ctx)).toBe("ours");
    expect(classify(next(OTHER), ctx)).toBe("other-checkout");
    expect(classify(next(ROOT, 502), ctx)).toBe("unrelated");
    expect(classify(null, ctx)).toBe("gone");
  });

  it("does not take other processes running from the checkout for the server", () => {
    // Seen in practice: Claude Code itself and Puppeteer's Chromium both run
    // with the checkout as their directory and listen on TCP ports.
    for (const command of [
      "/opt/node22/bin/claude --preload /home/claude/.claude/remote/spare.sock",
      "/opt/chromium --headless=new --remote-debugging-port=0",
      "python3 -m http.server 3000",
      "node server.js",
      "node /work/my-next-app/server.js",
      "nextcloud",
      // The design agent, whose arguments carry the user's own words.
      "/opt/node22/bin/claude -p Move the CTA to the next slide --name creatorbrio-chat",
      "node /usr/lib/claude/cli.js -p try node ./node_modules/.bin/next dev here",
      "/opt/node22/bin/claude -p next-server (v16.2.3)",
      "node /work/creatorbrio/node_modules/.bin/next build",
    ]) {
      expect(classify({ ...next(), command }, ctx), command).toBe("unrelated");
    }
  });
});

describe("deciding what /stop does", () => {
  const plan = (port: number | undefined, listeners: { pid: number; port: number; info: ReturnType<typeof next> | null }[]) =>
    planStop({ root: ROOT, uid: UID, port, listeners });

  it("finds this checkout's server on a non-default port without being told the port", () => {
    const result = plan(undefined, [{ pid: 10, port: 3010, info: next() }]);
    expect(result).toMatchObject({ action: "stop", pids: [10], ports: [3010] });
  });

  it("never stops an unrelated process on port 3000", () => {
    const listeners = [
      { pid: 7, port: 3000, info: { uid: UID, command: "python3 -m http.server 3000", cwd: "/work/site" } },
      { pid: 10, port: 3010, info: next() },
    ];
    expect(plan(undefined, listeners)).toMatchObject({ action: "stop", pids: [10] });
    const explicit = plan(3000, listeners.filter((l) => l.port === 3000));
    expect(explicit.action).toBe("refuse");
    expect(explicit.message).toMatch(/not served by this checkout's CreatorBrio server/);
    expect(explicit.message).toContain("python3 -m http.server 3000");
  });

  it("picks this checkout's instance when another worktree runs one too", () => {
    const listeners = [
      { pid: 10, port: 3010, info: next() },
      { pid: 20, port: 3020, info: next(OTHER) },
    ];
    const result = plan(undefined, listeners);
    expect(result).toMatchObject({ action: "stop", pids: [10], ports: [3010] });
    expect(result.message).toContain(`CreatorBrio/Next.js from ${OTHER}`);
  });

  it("reports two servers from the same checkout instead of guessing", () => {
    const result = plan(undefined, [
      { pid: 10, port: 3010, info: next() },
      { pid: 11, port: 3011, info: next() },
    ]);
    expect(result.action).toBe("ambiguous");
    expect(result.message).toMatch(/Found 2 CreatorBrio servers/);
    expect(result.message).toMatch(/:3010 {2}PID 10/);
    expect(result.message).toMatch(/:3011 {2}PID 11/);
    expect(result.message).toMatch(/Run \/stop <port>/);
  });

  it("treats one process on several ports as one server", () => {
    const result = plan(undefined, [
      { pid: 10, port: 3011, info: next() },
      { pid: 10, port: 3010, info: next() },
    ]);
    expect(result).toMatchObject({ action: "stop", pids: [10], ports: [3010, 3011] });
  });

  it("stops an explicit port only when this checkout serves it", () => {
    expect(plan(3010, [{ pid: 10, port: 3010, info: next() }])).toMatchObject({
      action: "stop",
      pids: [10],
      ports: [3010],
    });
    const other = plan(3020, [{ pid: 20, port: 3020, info: next(OTHER) }]);
    expect(other.action).toBe("refuse");
    expect(other.message).toMatch(/run \/stop from that checkout/);
    expect(plan(3030, [])).toMatchObject({ action: "none", message: "No process of yours is listening on :3030." });
  });

  it("ignores processes that have already exited", () => {
    expect(plan(undefined, [{ pid: 10, port: 3010, info: null }]).action).toBe("none");
    expect(plan(3010, [{ pid: 10, port: 3010, info: null }]).action).toBe("none");
  });

  it("ignores another user's server", () => {
    expect(plan(undefined, [{ pid: 10, port: 3010, info: next(ROOT, 0) }]).action).toBe("none");
    expect(plan(3010, [{ pid: 10, port: 3010, info: next(ROOT, 0) }]).action).toBe("refuse");
  });
});

describe("acting on the decision", () => {
  function fakeSystem(listeners: { pid: number; port: number }[], infos: Record<number, ReturnType<typeof next> | null>[]) {
    let call = 0;
    const signalled: number[] = [];
    const lines: string[] = [];
    return {
      signalled,
      lines,
      options: {
        root: ROOT,
        uid: UID,
        probe: {
          listListeners: () => listeners,
          // Each lookup round may see the system differently.
          processInfo: (pid: number) => infos[Math.min(call++, infos.length - 1)][pid] ?? null,
        },
        signal: (pid: number) => signalled.push(pid),
        alive: (pid: number) => !signalled.includes(pid),
        timeoutMs: 100,
        log: (line: string) => lines.push(line),
      },
    };
  }

  it("treats a server that exited by itself before the signal as stopped", async () => {
    const sys = fakeSystem([{ pid: 10, port: 3010 }], [{ 10: next() }, {}]);
    expect(await main({ ...sys.options, args: [] })).toBe(0);
    expect(sys.signalled).toEqual([]);
    expect(sys.lines.join("\n")).toMatch(/has already exited/);
  });

  it("does not signal a PID that was reused by another process after listing", async () => {
    const reused = { uid: UID, command: "python3 -m http.server", cwd: "/elsewhere" };
    const sys = fakeSystem([{ pid: 10, port: 3010 }], [{ 10: next() }, { 10: reused }]);
    expect(await main({ ...sys.options, args: [] })).toBe(1);
    expect(sys.signalled).toEqual([]);
    expect(sys.lines.join("\n")).toMatch(/no longer this checkout's server; left alone/);
  });

  it("reports a server that does not stop in time", async () => {
    const sys = fakeSystem([{ pid: 10, port: 3010 }], [{ 10: next() }]);
    const code = await main({ ...sys.options, args: ["3010"], alive: () => true });
    expect(code).toBe(1);
    expect(sys.signalled).toEqual([10]);
    expect(sys.lines.join("\n")).toMatch(/still running/);
  });

  it("rejects a malformed port without looking at any process", async () => {
    const sys = fakeSystem([{ pid: 10, port: 3010 }], [{ 10: next() }]);
    expect(await main({ ...sys.options, args: ["3010 && kill 1"] })).toBe(2);
    expect(sys.signalled).toEqual([]);
  });
});

describe("the server's descendants", () => {
  // The server 10 started a worker 11, which started a contained Design
  // Agent run 12; the run started 13. Process 20 is unrelated, and 14 belongs
  // to another user.
  const at = (pid: number, ppid: number, start = "t0", uid = UID, tty = false) => ({ pid, ppid, uid, tty, start });
  const table = [at(1, 0), at(10, 1), at(11, 10), at(12, 11), at(13, 12), at(14, 12, "t0", 0), at(20, 1)];

  it("are every process below the server, read from one listing", () => {
    expect(descendantsOf(10, table).map((p) => p.pid)).toEqual([11, 12, 13, 14]);
    expect(descendantsOf(20, table)).toEqual([]);
  });

  it("parse as ps and /proc print them", () => {
    expect(parsePsProcesses("  10     1   501 ??       Sun Nov 22 01:02:03 2026\n  11    10   501 ttys002  Sun Nov 22 01:02:04 2026\nbad\n")).toEqual([
      at(10, 1, "Sun Nov 22 01:02:03 2026"),
      at(11, 10, "Sun Nov 22 01:02:04 2026", UID, true),
    ]);
    expect(parseProcStatLine("13 (sh (x)) S 12 13 13 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 98765 0")).toEqual({ ppid: 12, tty: false, start: "98765" });
    expect(parseProcStatLine("13 (bash) S 12 13 13 34817 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 98765 0")).toMatchObject({ tty: true });
  });

  it("name the contained profile's folders as the app does, honouring the workspace setting from the environment or .env.local", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "creatorbrio-stop-folders-"));
    try {
      expect(containedFolders({ root: dir, env: {}, uid: 501, platform: "darwin", home: "/home/q" })).toEqual(["/home/q/.creatorbrio/design-agent", "/private/tmp/cbdx"]);
      expect(containedFolders({ root: dir, env: { CREATORBRIO_DESIGN_AGENT_WORKSPACES: "/srv/agents/" }, uid: 1000, platform: "linux", home: "/home/q" })).toEqual(["/srv/agents", "/tmp/cbrs"]);
      await writeFile(path.join(dir, ".env.local"), 'CLAUDE_CLI_PATH=/x\nCREATORBRIO_DESIGN_AGENT_WORKSPACES="/srv/other"\n');
      expect(containedFolders({ root: dir, env: {}, uid: 1000, platform: "linux", home: "/home/q" })[0]).toBe("/srv/other");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  function system(listing: () => ReturnType<typeof at>[], ignoresTerm: number[] = []) {
    const sent: [number, string][] = [];
    const dead = new Set<number>();
    return {
      sent,
      probe: { listListeners: () => [], processInfo: () => null, listProcesses: () => listing().filter((p) => !dead.has(p.pid)) },
      signal: (pid: number, sig: string = "SIGTERM") => {
        sent.push([pid, sig]);
        if (sig === "SIGKILL" || !ignoresTerm.includes(pid)) dead.add(pid);
      },
      alive: (pid: number) => !dead.has(pid),
    };
  }

  it("that outlive the server get SIGTERM, then SIGKILL if they ignore it", async () => {
    const recorded = descendantsOf(10, table).filter((p) => p.uid === UID);
    const sys = system(() => table.filter((p) => p.pid !== 10 && p.pid !== 11), [13]);
    const result = await stopDescendants(recorded, { ...sys, graceMs: 200 });
    expect(result).toEqual({ stopped: 2, left: 0 });
    expect(sys.sent).toEqual([
      [12, "SIGTERM"],
      [13, "SIGTERM"],
      [13, "SIGKILL"],
    ]);
  });

  it("are never confused with a later process that reused an id", async () => {
    const recorded = [at(12, 11, "t0")];
    const sys = system(() => [at(12, 1, "t1")]);
    expect(await stopDescendants(recorded, { ...sys, graceMs: 100 })).toEqual({ stopped: 0, left: 0 });
    expect(sys.sent).toEqual([]);
  });

  it("are stopped by /stop once the server is gone only when they are the contained agent's, and left to a server that is still running", async () => {
    const AGENTS = "/home/q/.creatorbrio/design-agent";
    const TEMP = "/tmp/cbrs";
    // Beside the contained run 12 and 13: the legacy Design Agent 15 working
    // in the checkout, an export browser 16 elsewhere, the Visual Director 17
    // in the system temporary folder, a person's terminal 18 in a
    // conversation folder, and a contained run's process 19 in the per-user
    // temporary parent.
    const full = [...table, at(15, 11), at(16, 11), at(17, 11), at(18, 11, "t0", UID, true), at(19, 12)];
    const cwd: Record<number, string> = { 12: `${AGENTS}/c/conv`, 13: `${AGENTS}/c/conv/sub`, 14: `${AGENTS}/c/conv`, 15: ROOT, 16: "/home/q", 17: "/tmp/creatorbrio-director-Ab12Cd", 18: `${AGENTS}/c/conv`, 19: `${TEMP}/a1b` };
    const lines: string[] = [];
    let serverUp = true;
    const sys = system(() => full.filter((p) => serverUp || (p.pid !== 10 && p.pid !== 11)));
    const options = {
      root: ROOT,
      uid: UID,
      args: [],
      timeoutMs: 100,
      folders: [AGENTS, TEMP],
      log: (line: string) => lines.push(line),
      probe: {
        ...sys.probe,
        listListeners: () => [{ pid: 10, port: 3010 }],
        processInfo: (pid: number) => (pid === 10 ? next() : cwd[pid] ? { uid: UID, command: "x", cwd: cwd[pid] } : null),
      },
    };
    // The server ignores the stop: nothing below it is touched.
    expect(await main({ ...options, alive: () => true, signal: (pid: number, sig?: NodeJS.Signals) => sys.signal(pid, sig) })).toBe(1);
    expect(sys.sent).toEqual([[10, "SIGTERM"]]);
    sys.sent.length = 0;
    // The server stops, its worker with it; only the contained run's processes are stopped.
    const code = await main({
      ...options,
      alive: (pid: number) => (pid === 10 ? serverUp : sys.alive(pid)),
      signal: (pid: number, sig?: NodeJS.Signals) => (pid === 10 ? (serverUp = false) : sys.signal(pid, sig)),
    });
    expect(code).toBe(0);
    expect(sys.sent).toEqual([
      [12, "SIGTERM"],
      [13, "SIGTERM"],
      [19, "SIGTERM"],
    ]);
    for (const pid of [14, 15, 16, 17, 18]) expect(sys.alive(pid)).toBe(true);
    expect(lines.join("\n")).toMatch(/Stopped 3 process\(es\) the server had started/);
  });

  it("are collected only below a server process that was actually signalled", async () => {
    // The listener is this checkout's server when listed, and something else when checked again.
    let call = 0;
    const sys = system(() => table);
    const code = await main({
      root: ROOT,
      uid: UID,
      args: [],
      timeoutMs: 100,
      folders: ["/"],
      log: () => {},
      probe: {
        ...sys.probe,
        listListeners: () => [{ pid: 10, port: 3010 }],
        processInfo: (pid: number) => (pid === 10 ? (call++ === 0 ? next() : { uid: UID, command: "python3", cwd: "/elsewhere" }) : { uid: UID, command: "x", cwd: "/x" }),
      },
      alive: sys.alive,
      signal: (pid: number, sig?: NodeJS.Signals) => sys.signal(pid, sig),
    });
    expect(code).toBe(1);
    expect(sys.sent).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("the process listing on this system", () => {
  it("lists this process under its parent, with a start time", () => {
    const listing = (process.platform === "linux" ? procProbe : lsofProbe).listProcesses();
    const self = listing.find((p) => p.pid === process.pid);
    expect(self).toMatchObject({ ppid: process.ppid, uid: process.getuid?.() });
    expect(self?.start).toBeTruthy();
    expect(descendantsOf(process.ppid, listing).some((p) => p.pid === process.pid)).toBe(true);
  });
});

// Real processes with real sockets, discovered through /proc. Linux only,
// which includes CI; the lsof path used on macOS is covered by the parsing
// tests above.
describe.skipIf(process.platform !== "linux")("with real servers (Linux)", () => {
  let base: string;
  let checkoutA: string;
  let checkoutB: string;
  let nextBin: string;
  let otherBin: string;
  const children: ChildProcess[] = [];

  // Stands in for `next dev`: its command line names `next`, it listens on a
  // free port, and it reports the port once it is listening.
  const SERVER = `const net = require("node:net");
const server = net.createServer((s) => s.end());
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
process.on("SIGTERM", () => process.exit(0));
`;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-stop-")));
    checkoutA = path.join(base, "creatorbrio");
    checkoutB = path.join(base, "creatorbrio-worktree");
    await mkdir(path.join(base, "bin"));
    await mkdir(checkoutA);
    await mkdir(checkoutB);
    nextBin = path.join(base, "bin", "next");
    otherBin = path.join(base, "bin", "other-app.js");
    await writeFile(nextBin, SERVER);
    await writeFile(otherBin, SERVER);
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function start(
    bin: string,
    cwd: string,
    args = ["dev"]
  ): Promise<{ pid: number; port: number; child: ChildProcess }> {
    const child = spawn(process.execPath, [bin, ...args], { cwd, stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    const port = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Test server exited early (${code})`)));
      child.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    return { pid: child.pid!, port, child };
  }

  const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

  async function stop(root: string, args: string[] = []) {
    const lines: string[] = [];
    const code = await main({ root, args, probe: procProbe, timeoutMs: 5000, log: (l: string) => lines.push(l) });
    return { code, output: lines.join("\n") };
  }

  async function exited(child: ChildProcess) {
    if (!running(child)) return;
    await new Promise((resolve) => child.once("exit", resolve));
  }

  it("stops only this checkout's server, leaving another worktree's and an unrelated process running", async () => {
    const a = await start(nextBin, checkoutA);
    const b = await start(nextBin, checkoutB);
    const unrelated = await start(otherBin, checkoutA);

    const { code, output } = await stop(checkoutA);

    expect(code).toBe(0);
    expect(output).toContain(`Stopped the CreatorBrio server on :${a.port} (PID ${a.pid})`);
    expect(output).toContain(`CreatorBrio/Next.js from ${checkoutB}`);
    await exited(a.child);
    expect(running(b.child)).toBe(true);
    expect(running(unrelated.child)).toBe(true);
  });

  it("asks for a port when this checkout runs two servers, then stops only the one named", async () => {
    const first = await start(nextBin, checkoutA);
    const second = await start(nextBin, checkoutA);

    const ambiguous = await stop(checkoutA);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.output).toMatch(/Found 2 CreatorBrio servers/);
    expect(running(first.child)).toBe(true);
    expect(running(second.child)).toBe(true);

    const explicit = await stop(checkoutA, [String(second.port)]);
    expect(explicit.code).toBe(0);
    await exited(second.child);
    expect(running(first.child)).toBe(true);
  });

  it("refuses an explicit port held by an unrelated process or another worktree", async () => {
    const unrelated = await start(otherBin, checkoutA);
    const b = await start(nextBin, checkoutB);

    const one = await stop(checkoutA, [String(unrelated.port)]);
    expect(one.code).toBe(1);
    expect(one.output).toMatch(/not served by this checkout's CreatorBrio server/);

    const two = await stop(checkoutA, [String(b.port)]);
    expect(two.code).toBe(1);
    expect(two.output).toMatch(/run \/stop from that checkout/);

    expect(running(unrelated.child)).toBe(true);
    expect(running(b.child)).toBe(true);
  });

  it("leaves the design agent alone when the user's message mentions next dev", async () => {
    // Listens from the checkout like the claude CLI does, with user text in its arguments.
    const agent = await start(otherBin, checkoutA, ["-p", "use", "node", "./next", "dev", "on", "the", "next", "slide"]);

    expect((await stop(checkoutA)).output).toMatch(/^No CreatorBrio server from this checkout/);
    expect((await stop(checkoutA, [String(agent.port)])).code).toBe(1);
    expect(running(agent.child)).toBe(true);
  });

  it("reports a port with nothing on it, and a checkout with no server", async () => {
    const gone = await start(nextBin, checkoutA);
    gone.child.kill("SIGKILL");
    await exited(gone.child);

    expect(await stop(checkoutA, [String(gone.port)])).toEqual({
      code: 0,
      output: `No process of yours is listening on :${gone.port}.`,
    });
    expect((await stop(checkoutA)).output).toMatch(/^No CreatorBrio server from this checkout/);
  });
});
