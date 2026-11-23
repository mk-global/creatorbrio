/**
 * One contained server at a time per data folder and agent folders' root
 * (#246): the ownership records, judged in one process, then with real OS
 * processes starting as contained servers do: a second server is refused, a
 * crashed server's record is taken over, and of servers starting at once,
 * over no record or over a stale one, exactly one owns the folders. The
 * simultaneous starts are a stress test (four racers, repeated rounds), which
 * can show a defect but is no deterministic proof of exclusion.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimContainedServer,
  claimRecord,
  containedServerStatus,
  parseRecord,
  releaseContainedServer,
  resetContainedServerForTests,
  SERVER_RECORD,
  type ServerIdentity,
} from "@/lib/contained-server";
import { ownServerStart } from "@/lib/agent-workspace";
import { containedAvailability } from "@/lib/design-agent-availability";

const HELPERS = path.resolve(__dirname, "helpers/ts-child");
let base: string;
let repo: string;
let data: string;
let agents: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "cb-owner-")));
  repo = path.join(base, "repo");
  data = path.join(repo, "data");
  agents = path.join(base, "agents");
  await mkdir(data, { recursive: true });
  resetContainedServerForTests();
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  resetContainedServerForTests();
  await rm(base, { recursive: true, force: true });
});

const recordIn = async (dir: string) => parseRecord(await readFile(path.join(dir, SERVER_RECORD), "utf8").catch(() => ""));
const plant = (dir: string, who: ServerIdentity) => writeFile(path.join(dir, SERVER_RECORD), `${JSON.stringify(who)}\n`, { mode: 0o600 });
/** Every entry in a folder but the record itself: a claim leaves no draft or set-aside file behind. */
const leftovers = async (dir: string) => (await readdir(dir)).filter((name) => name.startsWith(SERVER_RECORD) && name !== SERVER_RECORD);

describe("one ownership record", () => {
  const self = { pid: 4242, start: "Sun Nov 22 10:00:00 2026" };
  const nobodyRuns = async () => false;
  const everyoneRuns = async () => true;

  it("is created whole when there is none, and names its server by process id and start time", async () => {
    const claim = await claimRecord(data, self, nobodyRuns);
    expect(claim.owned).toBe(true);
    expect(await recordIn(data)).toEqual(self);
    expect(((await lstat(path.join(data, SERVER_RECORD))).mode & 0o777)).toBe(0o600);
    expect(await leftovers(data)).toEqual([]);
  });

  it("is refused while a running server holds it, naming that server, and left as it was", async () => {
    const other = { pid: 5151, start: "Sun Nov 22 09:00:00 2026" };
    await plant(data, other);
    expect(await claimRecord(data, self, everyoneRuns)).toEqual({ owned: false, holder: other, problem: "held" });
    expect(await recordIn(data)).toEqual(other);
    expect(await leftovers(data)).toEqual([]);
  });

  it("takes over a stale record, whose server is gone or has another start time", async () => {
    const dead = { pid: 5151, start: "Sun Nov 22 09:00:00 2026" };
    await plant(data, dead);
    const asked: ServerIdentity[] = [];
    const claim = await claimRecord(data, self, async (holder) => (asked.push(holder), false));
    expect(claim.owned).toBe(true);
    expect(asked).toEqual([dead]);
    expect(await recordIn(data)).toEqual(self);
    expect(await leftovers(data)).toEqual([]);
  });

  it("refuses a link, another kind of file or text that is not a record, and never follows or removes it", async () => {
    await writeFile(path.join(base, "target"), JSON.stringify({ pid: 5151, start: "x" }));
    await symlink(path.join(base, "target"), path.join(data, SERVER_RECORD));
    expect(await claimRecord(data, self, nobodyRuns)).toMatchObject({ owned: false, problem: "not-a-record" });
    expect((await lstat(path.join(data, SERVER_RECORD))).isSymbolicLink()).toBe(true);
    await unlink(path.join(data, SERVER_RECORD));
    await writeFile(path.join(data, SERVER_RECORD), "not a record");
    expect(await claimRecord(data, self, nobodyRuns)).toMatchObject({ owned: false, problem: "not-a-record" });
    expect(await readFile(path.join(data, SERVER_RECORD), "utf8")).toBe("not a record");
    await rm(path.join(data, SERVER_RECORD));
    await mkdir(path.join(data, SERVER_RECORD));
    expect(await claimRecord(data, self, nobodyRuns)).toMatchObject({ owned: false, problem: "not-a-record" });
  });

  it("puts back a fresh record it moved by mistake, when another server took the stale one over first", async () => {
    const dead = { pid: 5151, start: "Sun Nov 22 09:00:00 2026" };
    const winner = { pid: 6262, start: "Sun Nov 22 10:30:00 2026" };
    await plant(data, dead);
    // While this server judges the stale record, another one replaces it with its own.
    let replaced = false;
    const claim = await claimRecord(data, self, async (holder) => {
      if (holder.pid === dead.pid && !replaced) {
        replaced = true;
        await unlink(path.join(data, SERVER_RECORD));
        await plant(data, winner);
        return false;
      }
      return true;
    });
    expect(claim).toEqual({ owned: false, holder: winner, problem: "held" });
    expect(await recordIn(data)).toEqual(winner);
    expect(await leftovers(data)).toEqual([]);
  });
});

describe("a contained server's ownership of its folders", () => {
  it("takes the data folder's record, then the agent folders', and lets the server run contained designs", async () => {
    expect(await claimContainedServer({ dataDir: data, agentsRoot: agents, repoDir: repo })).toEqual({ owned: true });
    const self = { pid: process.pid, start: (await ownServerStart())! };
    expect(await recordIn(data)).toEqual(self);
    expect(await recordIn(agents)).toEqual(self);
    expect(await containedServerStatus()).toEqual({ ok: true });
    releaseContainedServer();
    expect(await recordIn(data)).toBeNull();
    expect(await recordIn(agents)).toBeNull();
  });

  it("gives back the data folder's record when it cannot take the agent folders', and explains which folder and process", async () => {
    const other = { pid: process.ppid, start: "Sun Nov 22 09:00:00 2026" };
    await mkdir(agents, { recursive: true, mode: 0o700 });
    await plant(agents, other);
    // The holder is running: its id is alive and its start time cannot be compared.
    expect(await claimContainedServer({ dataDir: data, agentsRoot: agents, repoDir: repo, probe: { list: async () => [], cwds: async () => new Map(), listSync: () => [] } })).toEqual({ owned: false });
    expect(await recordIn(data)).toBeNull();
    expect(await recordIn(agents)).toEqual(other);
    const status = await containedServerStatus();
    expect(status).toMatchObject({ ok: false, reason: expect.stringMatching(new RegExp(`process ${process.ppid}\\).*same Design Agent's folders`)), guidance: expect.stringMatching(/\/stop.*CREATORBRIO_DESIGN_AGENT_WORKSPACES/) });
    expect(JSON.stringify(status)).not.toContain(base);
  });

  it("refuses contained work when it never claimed, and when its record was replaced, which it never removes", async () => {
    expect(await containedServerStatus()).toMatchObject({ ok: false, reason: expect.stringMatching(/did not take charge/) });
    expect(await claimContainedServer({ dataDir: data, agentsRoot: agents, repoDir: repo })).toEqual({ owned: true });
    const replacement = path.join(base, "replacement");
    await writeFile(replacement, await readFile(path.join(agents, SERVER_RECORD)));
    await unlink(path.join(agents, SERVER_RECORD));
    await link(replacement, path.join(agents, SERVER_RECORD));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await containedServerStatus()).toMatchObject({ ok: false, reason: expect.stringMatching(/was replaced/) });
      // Asked on every request, it says so once: which folder, never a path.
      expect(await containedServerStatus()).toMatchObject({ ok: false });
      const warned = warn.mock.calls.filter(([message]) => String(message).includes("ownership record was replaced"));
      expect(warned).toHaveLength(1);
      expect(warned[0][1]).toEqual({ folders: ["agents"] });
      expect(JSON.stringify(warned)).not.toContain(base);
    } finally {
      warn.mockRestore();
    }
    releaseContainedServer();
    // Only its own record goes: the data folder's.
    expect(await recordIn(data)).toBeNull();
    expect(await lstat(path.join(agents, SERVER_RECORD))).toBeTruthy();
  });

  it("says when it takes over a stale record: the folder and the previous process, never a path (#246)", async () => {
    const dead = { pid: 99_999_001, start: "Sun Nov 22 09:00:00 2026" };
    await mkdir(agents, { recursive: true, mode: 0o700 });
    await plant(agents, dead);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await claimContainedServer({ dataDir: data, agentsRoot: agents, repoDir: repo, alive: () => false })).toEqual({ owned: true });
      const taken = info.mock.calls.filter(([message]) => String(message).includes("took over a stale ownership record"));
      // Only the agent folders' record was stale; the data folder's was created.
      expect(taken).toEqual([["[design-agent] took over a stale ownership record", { folder: "agents", previousPid: dead.pid }]]);
      expect(JSON.stringify(taken)).not.toContain(base);
      expect((await recordIn(agents))?.pid).toBe(process.pid);
    } finally {
      info.mockRestore();
    }
  });

  it("says nothing of a takeover when no record was stale", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await claimContainedServer({ dataDir: data, agentsRoot: agents, repoDir: repo })).toEqual({ owned: true });
      expect(info.mock.calls.filter(([message]) => String(message).includes("stale ownership record"))).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });

  it("stays bound to the folders it claimed: other folders in the settings refuse contained work and deletion until a restart, and the claimed ones restore it (#246)", async () => {
    const setting = "CREATORBRIO_DESIGN_AGENT_WORKSPACES";
    const original = process.env[setting];
    const ok = async () => ({ ok: true as const });
    const darwin = { platform: "darwin" as const, kernelRelease: null, has: () => true };
    process.env[setting] = agents;
    try {
      // As the server starts it: the agent folders from the setting, which is read again whenever it is asked.
      expect(await claimContainedServer({ dataDir: data, repoDir: repo })).toEqual({ owned: true });
      expect(await containedServerStatus()).toEqual({ ok: true });
      const other = path.join(base, "other-agents");
      await mkdir(other, { mode: 0o700 });
      process.env[setting] = other;
      const refused = await containedServerStatus();
      expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer the ones this server took charge of when it started/), guidance: expect.stringMatching(/Restart CreatorBrio after changing CREATORBRIO_DESIGN_AGENT_WORKSPACES/) });
      expect(JSON.stringify(refused)).not.toContain(base);
      // The availability check, which Home, Settings and the chat read, says the same.
      expect(await containedAvailability("/nonexistent/claude", darwin, { server: containedServerStatus, signIn: ok, modelApi: ok })).toMatchObject({ available: false, reason: expect.stringMatching(/no longer the ones this server took charge of/) });
      // A folder that does not exist, or a relative or unusable setting, is not the claimed one either.
      for (const value of [path.join(base, "missing"), "relative/agents"]) {
        process.env[setting] = value;
        expect(await containedServerStatus(), value).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer the ones/) });
      }
      // The same folder under another spelling is the same folder; the claimed one restores it.
      const alias = path.join(base, "alias");
      await symlink(agents, alias);
      process.env[setting] = alias;
      expect(await containedServerStatus()).toEqual({ ok: true });
      process.env[setting] = agents;
      expect(await containedServerStatus()).toEqual({ ok: true });
      // Nothing was taken or removed in the other folder meanwhile.
      expect(await recordIn(other)).toBeNull();
    } finally {
      if (original === undefined) delete process.env[setting];
      else process.env[setting] = original;
    }
  });

  it("refuses an agent folders' setting inside the repository without taking anything", async () => {
    expect(await claimContainedServer({ dataDir: data, agentsRoot: path.join(repo, "agents"), repoDir: repo })).toEqual({ owned: false });
    expect(await recordIn(data)).toBeNull();
    expect(await containedServerStatus()).toMatchObject({ ok: false, reason: expect.stringMatching(/could not take charge/) });
  });
});

interface WorkerLine {
  pid: number;
  owned: boolean;
  status: { ok: boolean; reason?: string; guidance?: string };
}

function startWorker(startAt = 0): { child: ChildProcess; line: Promise<WorkerLine> } {
  const child = spawn(process.execPath, ["--no-warnings", "--import", path.join(HELPERS, "register.mjs"), path.join(HELPERS, "contained-server-worker.mts"), data, agents, repo, String(startAt)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  const line = new Promise<WorkerLine>((resolve, reject) => {
    child.stdout!.on("data", (d) => {
      out += d;
      const at = out.indexOf("\n");
      if (at >= 0) resolve(JSON.parse(out.slice(0, at)) as WorkerLine);
    });
    child.on("exit", (code, signal) => reject(new Error(`worker ended (${code ?? signal}) before reporting: ${err.slice(-400)}`)));
  });
  return { child, line };
}

const exited = (child: ChildProcess) => new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.on("exit", () => resolve())));

describe("contained servers as separate processes", () => {
  it("refuses a second server over the same folders, naming the first, and lets one start after the first stops", async () => {
    const first = startWorker();
    expect(await first.line).toMatchObject({ owned: true, status: { ok: true } });
    const firstPid = (await first.line).pid;
    const second = startWorker();
    const refused = await second.line;
    expect(refused.owned).toBe(false);
    expect(refused.status.reason).toContain(`process ${firstPid}`);
    expect(await recordIn(data)).toMatchObject({ pid: firstPid });
    // The first stops through the shutdown hook, which gives its records back.
    first.child.kill("SIGTERM");
    await exited(first.child);
    expect(await recordIn(data)).toBeNull();
    expect(await recordIn(agents)).toBeNull();
    const third = startWorker();
    expect(await third.line).toMatchObject({ owned: true });
  }, 60_000);

  it("takes over the records a crashed server left", async () => {
    const crashed = startWorker();
    const crashedPid = (await crashed.line).pid;
    crashed.child.kill("SIGKILL");
    await exited(crashed.child);
    expect(await recordIn(data)).toMatchObject({ pid: crashedPid });
    const next = startWorker();
    const line = await next.line;
    expect(line).toMatchObject({ owned: true, status: { ok: true } });
    expect(await recordIn(data)).toMatchObject({ pid: line.pid });
    expect(await recordIn(agents)).toMatchObject({ pid: line.pid });
  }, 60_000);

  it("takes over a record whose process id is alive but is another process, by its start time", async () => {
    // This test's own process, with a start time it never had.
    await mkdir(agents, { recursive: true, mode: 0o700 });
    for (const dir of [data, agents]) await plant(dir, { pid: process.pid, start: "Thu Jan  1 00:00:00 1970" });
    const next = startWorker();
    expect(await next.line).toMatchObject({ owned: true });
  }, 60_000);

  for (const [name, stale] of [
    ["over no record", false],
    ["over a stale record", true],
  ] as const) {
    it(`lets exactly one of several servers starting at once own the folders, ${name}`, async () => {
      for (let round = 0; round < 3; round++) {
        await rm(path.join(data, SERVER_RECORD), { force: true });
        await rm(path.join(agents, SERVER_RECORD), { force: true });
        if (stale) {
          // A crashed server's records.
          const crashed = startWorker();
          await crashed.line;
          crashed.child.kill("SIGKILL");
          await exited(crashed.child);
        }
        const startAt = Date.now() + 2500;
        const racers = Array.from({ length: 4 }, () => startWorker(startAt));
        const lines = await Promise.all(racers.map((r) => r.line));
        const owners = lines.filter((l) => l.owned);
        expect({ round, owners: owners.length }).toEqual({ round, owners: 1 });
        expect(owners[0].status).toEqual({ ok: true });
        expect(await recordIn(data)).toMatchObject({ pid: owners[0].pid });
        expect(await recordIn(agents)).toMatchObject({ pid: owners[0].pid });
        for (const loser of lines.filter((l) => !l.owned)) expect(loser.status.ok).toBe(false);
        expect([...(await leftovers(data)), ...(await leftovers(agents))]).toEqual([]);
        for (const r of racers) r.child.kill("SIGKILL");
        await Promise.all(racers.map((r) => exited(r.child)));
      }
    }, 120_000);
  }
});
