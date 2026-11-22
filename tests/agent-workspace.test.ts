import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync as existsSyncAt, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_WORKSPACES_ENV,
  AgentWorkspaceError,
  agentHomeDir,
  HOME_STARTUP_FILES,
  prepareAgentHome,
  allowOwner,
  ConversationGoneError,
  agentWorkspaceRoot,
  conversationFolderExists,
  createRunTempDir,
  createServerTempDir,
  openConversation,
  removeCarouselWorkDir,
  removeAgentWritable,
  removeRunTempDir,
  removeServerTempDir,
  runDirNameLength,
  serverTempDirName,
  serverTempRoot,
  stageUploadsForAgent,
  stagingDirFor,
  startConversation,
  sweepLeftoverFolders,
  SERVER_TEMP_ROOT_OVERRIDE,
  systemServerTempRoot,
} from "@/lib/agent-workspace";
import { defaultProbe } from "@/lib/agent-processes";
import { agentTempDirFits, MAX_AGENT_TEMP_PATH_BYTES } from "@/lib/design-agent-profile";
import { longestRealParentBytes, OVERRIDE_KEY, realParent, serverFolderName, testParentName } from "./helpers/server-temp-parent";

const ID = "2f1c9a52-8d3e-4b7a-9f21-0e4d5c6b7a89";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uid = process.getuid?.() ?? 0;
// Real processes and a shared, sometimes slow machine: none of these waits is a measurement.
vi.setConfig({ testTimeout: 30_000 });

const QUARANTINED = "9e1c9a52-8d3e-4b7a-9f21-0e4d5c6b7a89";
const OTHER_ID = "3d2b8a41-7c6e-4f10-8b95-1a2b3c4d5e6f";
let base: string;
let repo: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-workspace-")));
  repo = path.join(base, "repo");
  root = path.join(base, "agents");
  await mkdir(path.join(repo, "public", "uploads"), { recursive: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

const strays: ChildProcess[] = [];

/** Running, and not a zombie waiting to be reaped. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
    }
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** A process of this user with no controlling terminal, working in `cwd`, as an agent's background job is. */
function stray(cwd: string): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, detached: true, stdio: "ignore" });
  strays.push(child);
  return child.pid!;
}

afterEach(async () => {
  for (const child of strays.splice(0)) child.kill("SIGKILL");
  vi.restoreAllMocks();
  // Folders a test made unremovable are made removable again first.
  execFileSync("chmod", ["-R", "u+rwx", base]);
  if (process.platform === "darwin") execFileSync("chflags", ["-R", "nouchg,nouappnd", base]);
  await rm(base, { recursive: true, force: true });
});

describe("the workspace root", () => {
  it("defaults to a folder in the home folder and accepts only an absolute override", () => {
    expect(agentWorkspaceRoot({})).toMatch(/\.creatorbrio[/\\]design-agent$/);
    expect(agentWorkspaceRoot({ [AGENT_WORKSPACES_ENV]: "/srv/agents/" })).toBe("/srv/agents");
    expect(() => agentWorkspaceRoot({ [AGENT_WORKSPACES_ENV]: "relative/agents" })).toThrow(AgentWorkspaceError);
  });
});

describe("a conversation's folder", () => {
  it("is a new owner-only folder per conversation under the carousel's, with a random identifier", async () => {
    const dir = await startConversation(ID, repo, root);
    expect(path.dirname(dir)).toBe(path.join(root, ID));
    expect(path.basename(dir)).toMatch(UUID);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(dir))).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual([]);
  });

  it("moves the previous conversation's folder into quarantine whole, never emptying it in place, and removes its staged images", async () => {
    const first = await startConversation(ID, repo, root);
    const outside = path.join(base, "outside.txt");
    await writeFile(outside, "keep me");
    await mkdir(path.join(first, "nested"));
    await writeFile(path.join(first, "nested", "a"), "x");
    await symlink(outside, path.join(first, "link"));
    await symlink(base, path.join(first, "dirlink"));
    await mkdir(stagingDirFor(first), { recursive: true });
    await writeFile(path.join(stagingDirFor(first), "a1.png"), "PNG");
    const second = await startConversation(ID, repo, root);
    expect(second).not.toBe(first);
    await expect(lstat(first)).rejects.toThrow();
    await expect(lstat(stagingDirFor(first))).rejects.toThrow();
    expect(await readdir(path.join(root, ID))).toEqual([path.basename(second)]);
    expect(await readdir(path.join(root, ".removed"))).toEqual([]);
    expect(await readFile(outside, "utf8")).toBe("keep me");
  });

  it("still starts a new conversation when the previous folder cannot be moved, and reports it", async () => {
    const first = await startConversation(ID, repo, root);
    // The quarantine folder's name is taken by a file, so nothing can be moved into it.
    await writeFile(path.join(root, ".removed"), "x");
    const second = await startConversation(ID, repo, root);
    expect(second).not.toBe(first);
    expect((await readdir(path.join(root, ID))).sort()).toEqual([path.basename(first), path.basename(second)].sort());
    expect(vi.mocked(console.error).mock.calls.some(([message]) => String(message).includes("previous conversation"))).toBe(true);
  });

  it("never reuses a conversation's path", async () => {
    const first = await startConversation(ID, repo, root);
    await expect(startConversation(ID, repo, root, path.basename(first))).rejects.toThrow(AgentWorkspaceError);
  });

  it("is reopened for a resumed session, and never recreated once it is gone", async () => {
    const dir = await startConversation(ID, repo, root);
    expect(await openConversation(ID, path.basename(dir), repo, root)).toBe(dir);
    await startConversation(ID, repo, root);
    await expect(openConversation(ID, path.basename(dir), repo, root)).rejects.toThrow(ConversationGoneError);
    await expect(lstat(dir)).rejects.toThrow();
  });

  it("refuses identifiers that are not server-generated ones", async () => {
    for (const bad of ["../escape", "default", ID.toUpperCase(), `${ID}/x`, ""]) {
      await expect(startConversation(bad, repo, root)).rejects.toThrow(AgentWorkspaceError);
      await expect(openConversation(ID, bad, repo, root)).rejects.toThrow(AgentWorkspaceError);
      await expect(openConversation(bad, ID, repo, root)).rejects.toThrow(AgentWorkspaceError);
    }
  });

  it("refuses a root inside the repository, or one that contains it", async () => {
    await expect(startConversation(ID, repo, path.join(repo, "data", "agents"))).rejects.toThrow(/outside the repository/);
    await expect(startConversation(ID, repo, base)).rejects.toThrow(/outside the repository/);
  });

  it("refuses a carousel or conversation folder that has been replaced by a link", async () => {
    await mkdir(root, { recursive: true });
    await symlink(repo, path.join(root, ID));
    await expect(startConversation(ID, repo, root)).rejects.toThrow(/not a plain folder/);
    await rm(path.join(root, ID));
    const dir = await startConversation(ID, repo, root);
    await rm(dir, { recursive: true });
    await symlink(repo, dir);
    await expect(openConversation(ID, path.basename(dir), repo, root)).rejects.toThrow(/not a plain folder/);
  });

  it("goes with its carousel, every conversation and staged image included, and an unsafe identifier removes nothing", async () => {
    const dir = await startConversation(ID, repo, root);
    await mkdir(stagingDirFor(dir), { recursive: true });
    await removeCarouselWorkDir("..", root);
    expect((await stat(dir)).isDirectory()).toBe(true);
    await removeCarouselWorkDir(ID, root);
    await expect(stat(path.join(root, ID))).rejects.toThrow();
    expect(await readdir(path.join(root, ".removed"))).toEqual([]);
    await expect(removeCarouselWorkDir(ID, root)).resolves.toBeUndefined();
  });
});

describe("the contained CLI's server-owned home (#242)", () => {
  const person = () => path.join(base, "person");
  const prepare = (platform: NodeJS.Platform, options: { uid?: number } = {}) =>
    prepareAgentHome({ repoDir: repo, personHome: person(), root, platform, uid: options.uid ?? uid });

  it("is one owner-only folder under the agent folders' root, named so no carousel can have it, kept between launches", async () => {
    const dir = await prepare("linux");
    expect(dir).toBe(agentHomeDir(root));
    expect(path.dirname(dir)).toBe(root);
    expect(path.basename(dir)).toBe(".home");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    // Linux: nothing of the person's in it; the sign-in is named in the environment instead.
    expect(await readdir(dir)).toEqual([]);
    await writeFile(path.join(dir, "session-state"), "kept");
    expect(await prepare("linux")).toBe(dir);
    expect(await readFile(path.join(dir, "session-state"), "utf8")).toBe("kept");
  });

  it("holds on macOS only a link to the person's keychain folder, made once and kept", async () => {
    const dir = await prepare("darwin");
    expect(await readdir(dir)).toEqual(["Library"]);
    expect(await readdir(path.join(dir, "Library"))).toEqual(["Keychains"]);
    expect((await stat(path.join(dir, "Library"))).mode & 0o777).toBe(0o700);
    const link = path.join(dir, "Library", "Keychains");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(path.join(person(), "Library", "Keychains"));
    await expect(prepare("darwin")).resolves.toBe(dir);
  });

  it("refuses a keychain entry that is not exactly the server's link, and never follows or replaces it", async () => {
    const dir = await prepare("darwin");
    const link = path.join(dir, "Library", "Keychains");
    await rm(link);
    await symlink(path.join(base, "elsewhere"), link);
    await expect(prepare("darwin")).rejects.toThrow(/Library\/Keychains is not the link the server makes/);
    expect(await readlink(link)).toBe(path.join(base, "elsewhere"));
    await rm(link);
    await mkdir(link);
    await expect(prepare("darwin")).rejects.toThrow(AgentWorkspaceError);
  });

  it("refuses a home holding a shell startup file, and keeps only the empty ones the CLI's sandbox leaves on Linux", async () => {
    const dir = await prepare("linux");
    for (const name of HOME_STARTUP_FILES) await writeFile(path.join(dir, name), "");
    await expect(prepare("linux")).resolves.toBe(dir);
    for (const name of [".zshrc", ".bashrc", ".zshenv", ".profile", ".bash_profile"]) {
      await writeFile(path.join(dir, name), "alias ls='echo planted'\n");
      const refused = (await prepare("linux").catch((err: unknown) => err)) as Error;
      expect(refused).toBeInstanceOf(AgentWorkspaceError);
      expect(refused.message).toContain(`(${name})`);
      expect(refused.message).not.toContain(base);
      // Refused, never deleted: the server never writes one, so one there is reported.
      expect(await readFile(path.join(dir, name), "utf8")).toContain("planted");
      await writeFile(path.join(dir, name), "");
    }
    await rm(path.join(dir, ".zshrc"));
    await symlink(path.join(base, "elsewhere"), path.join(dir, ".zshrc"));
    await expect(prepare("linux")).rejects.toThrow(/\(\.zshrc\)/);
    await rm(path.join(dir, ".zshrc"));
    await rm(path.join(dir, ".bashrc"));
    await mkdir(path.join(dir, ".bashrc"));
    await expect(prepare("linux")).rejects.toThrow(/\(\.bashrc\)/);
  });

  it("refuses a home that is a link, open to others or another user's, and never adopts it", async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(path.join(base, "real-home"), { mode: 0o700 });
    await symlink(path.join(base, "real-home"), agentHomeDir(root));
    await expect(prepare("linux")).rejects.toThrow(/home folder ".home" is not a private folder/);
    await rm(agentHomeDir(root));
    await mkdir(agentHomeDir(root), { mode: 0o755 });
    await chmod(agentHomeDir(root), 0o755);
    await expect(prepare("linux")).rejects.toThrow(/not a private folder.*Remove it, or fix its owner and permissions/);
    await chmod(agentHomeDir(root), 0o700);
    await expect(prepare("linux", { uid: uid + 1 })).rejects.toThrow(/not a private folder/);
    await expect(prepare("linux")).resolves.toBe(agentHomeDir(root));
  });

  it("is refused inside the repository, as every agent folder is", async () => {
    await expect(prepareAgentHome({ repoDir: repo, personHome: person(), root: path.join(repo, "agents"), platform: "linux", uid })).rejects.toThrow(/outside the repository/);
  });
});

describe("the server temporary folders", () => {
  it("are named per user, and a run's folder fits the CLI's limit with every user id on either platform, as long as the budget allows", () => {
    expect(systemServerTempRoot("darwin", 501)).toBe("/private/tmp/cbdx");
    expect(systemServerTempRoot("linux", 1000)).toBe("/tmp/cbrs");
    for (const uid of [0, 501, 1000, 65534, 2 ** 31, 4294967295, 9999999999]) {
      for (const platform of ["darwin", "linux"] as const) {
        const root = systemServerTempRoot(platform, uid);
        const length = runDirNameLength(root, uid);
        const run = path.join(root, "z".repeat(length));
        expect({ uid, platform, fits: agentTempDirFits(run, uid) }).toEqual({ uid, platform, fits: true });
        // One more character would not fit: the name fills what the budget leaves (the longest name, 26, is exactly that for the shortest parent).
        expect({ uid, platform, longer: agentTempDirFits(path.join(root, "z".repeat(length + 1)), uid) }).toEqual({ uid, platform, longer: false });
      }
    }
    // The worst case is exactly the limit: /private/tmp/cb + 7 + /zzz/claude- + 10 digits.
    const worst = path.join(systemServerTempRoot("darwin", 4294967295), "zzz", "claude-4294967295");
    expect(worst).toBe("/private/tmp/cb1z141z3/zzz/claude-4294967295");
    expect(Buffer.byteLength(worst)).toBe(MAX_AGENT_TEMP_PATH_BYTES);
  });

  it("give a run's name the length the CLI's budget leaves for this user id and parent, never fewer than three characters (#241 A1)", async () => {
    expect(runDirNameLength(systemServerTempRoot("darwin", 501), 501)).toBe(15);
    expect(runDirNameLength(systemServerTempRoot("linux", 1000), 1000)).toBe(22);
    expect(runDirNameLength(systemServerTempRoot("darwin", 4294967295), 4294967295)).toBe(3);
    // A longer user id leaves fewer characters, and a longer parent too.
    expect(runDirNameLength(systemServerTempRoot("darwin", 501), 4294967295)).toBeLessThan(15);
    expect(runDirNameLength(path.join(systemServerTempRoot("darwin", 501), "w"), 501)).toBe(13);
    // What is created follows it, in the parent in use.
    const parent = path.join(serverTempRoot(), "n");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const dir = await createRunTempDir(uid, process.platform, parent);
      try {
        expect(path.basename(dir)).toHaveLength(runDirNameLength(parent, uid));
        expect(agentTempDirFits(dir, uid)).toBe(true);
        names.add(path.basename(dir));
      } finally {
        await removeRunTempDir(dir);
      }
    }
    // Names are not drawn twice: this is what stops a later run from reusing a path an earlier run's survivor still holds.
    expect(names.size).toBe(20);
  });

  it("are never the real parent while tests run: each test file has its own", () => {
    expect(serverTempRoot()).not.toBe(systemServerTempRoot());
    expect(serverTempRoot()).toMatch(/^(\/private)?\/tmp\/t[0-9a-z]+-[0-9a-z]*$/);
    expect(OVERRIDE_KEY).toBe(SERVER_TEMP_ROOT_OVERRIDE);
    expect(realParent(process.platform, uid)).toBe(systemServerTempRoot());
  });

  it("have a test parent no longer than the longest real parent, and never named like one (#241)", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(longestRealParentBytes(platform)).toBe(Buffer.byteLength(systemServerTempRoot(platform, 4294967295)));
      const base = platform === "darwin" ? "/private/tmp" : "/tmp";
      // Any process id the platforms can have, and a random part long enough to fill what is left.
      for (const pid of [1, 99999, 4194304, 2 ** 31, 2 ** 32]) {
        const name = testParentName(base, platform, pid, "0123456789abcdef");
        const parent = path.join(base, name);
        expect({ platform, pid, fits: Buffer.byteLength(parent) <= longestRealParentBytes(platform) }).toEqual({ platform, pid, fits: true });
        // The process id is whole and ends at the `-`, so no id's name is another's prefix and two live processes never share a name.
        expect(name.startsWith(`t${pid.toString(36)}-`)).toBe(true);
        expect(name.slice(1, name.indexOf("-"))).toBe(pid.toString(36));
        // The real name is `cb` and base 36, which has no `-`.
        expect(name).toContain("-");
        for (const realUid of [0, 501, 4294967295]) expect(parent).not.toBe(systemServerTempRoot(platform, realUid));
        // So a run's folder in it fits the CLI's limit for the longest user id the real parent fits.
        expect(agentTempDirFits(path.join(parent, "zzz"), 4294967295)).toBe(true);
      }
    }
    // One id's base 36 form can be the start of another's (46656 and 1679616 are `1000` and `10000`), and a fixed-length name then
    // collides for some random parts: `t-10000ab` came from both. With the `-` after the id the two names differ.
    const [shorter, longer] = [46656, 1679616];
    expect(shorter.toString(36)).toBe("1000");
    expect(longer.toString(36)).toBe("10000");
    const a = testParentName("/private/tmp", "darwin", shorter, "0abcdef");
    const b = testParentName("/private/tmp", "darwin", longer, "abcdef0");
    expect([a, b]).toEqual(["t1000-0ab", "t10000-ab"]);
    expect(a).not.toBe(b);
    // The parent in use here is within the same bound, and a three-character run folder in it fits the longest user id.
    if (process.platform !== "win32") {
      expect(Buffer.byteLength(serverTempRoot())).toBeLessThanOrEqual(longestRealParentBytes(process.platform));
      expect(agentTempDirFits(path.join(serverTempRoot(), "zzz"), 4294967295)).toBe(true);
      expect(path.basename(serverTempRoot())).not.toMatch(/^cb[0-9a-z]+$/);
    }
  });

  it("put a run's folder directly in the parent, owner-only, with its owner recorded in this server's folder", async () => {
    const dir = await createRunTempDir(uid);
    const root = serverTempRoot();
    const marker = path.join(root, serverTempDirName(), `run-${path.basename(dir)}`);
    try {
      expect(path.dirname(dir)).toBe(root);
      expect(path.basename(dir)).toMatch(/^[0-9a-z]{3,26}$/);
      expect(path.basename(dir)).toHaveLength(runDirNameLength(root, uid));
      expect(serverTempDirName()).toBe(`.s${process.pid.toString(36)}`);
      expect(serverFolderName(process.pid)).toBe(serverTempDirName());
      for (const d of [dir, root, path.join(root, serverTempDirName())]) expect((await stat(d)).mode & 0o777).toBe(0o700);
      expect((await stat(marker)).isFile()).toBe(true);
      await writeFile(path.join(dir, "x"), "x");
    } finally {
      await removeRunTempDir(dir);
    }
    await expect(stat(dir)).rejects.toThrow();
    await expect(stat(marker)).rejects.toThrow();
  });

  it("keep the Visual Director's copies in this server's own folder", async () => {
    const dir = await createServerTempDir("creatorbrio-director-", uid);
    expect(path.dirname(dir)).toBe(path.join(serverTempRoot(), serverTempDirName()));
    await removeServerTempDir(dir);
  });

  it("refuse a parent that is a link, has wider access, or belongs to someone else", async () => {
    const wide = path.join(base, "wide");
    await mkdir(wide, { mode: 0o755 });
    await chmod(wide, 0o755);
    // The refusal names the folder by its last component only, and says what to do.
    const refused = (await createRunTempDir(uid, process.platform, wide).catch((err: unknown) => err)) as Error;
    expect(refused).toBeInstanceOf(AgentWorkspaceError);
    expect(refused.message).toMatch(/"wide" is not a private folder.*Remove it, or fix its owner and permissions/);
    expect(refused.message).not.toContain(base);
    const link = path.join(base, "link");
    await mkdir(path.join(base, "real"), { mode: 0o700 });
    await symlink(path.join(base, "real"), link);
    await expect(createServerTempDir("p-", uid, process.platform, link)).rejects.toThrow(/not a private folder/);
    await expect(createServerTempDir("p-", uid + 1, process.platform, path.join(base, "real"))).rejects.toThrow(/not a private folder/);
  });
});

describe("the sweep at server start", () => {
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    return child.pid!;
  }

  it("removes dead servers' folders and runs, unowned runs, this server's unowned leftovers and both quarantines, and keeps what is live", async () => {
    // Inside this file's injected parent, so a run's folder in it still fits the CLI's limit.
    const tempRoot = path.join(serverTempRoot(), "w");
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    for (const dir of [serverTempRoot(), tempRoot]) await chmod(dir, 0o700);
    const dead = path.join(tempRoot, serverTempDirName(await deadPid()));
    const alive = path.join(tempRoot, serverTempDirName(process.ppid));
    for (const d of [dead, alive]) await mkdir(d, { mode: 0o700 });
    // A dead server's run, with a folder the agent made unreadable: mode 000 with a file inside.
    await writeFile(path.join(dead, "run-ab1"), "");
    await mkdir(path.join(tempRoot, "ab1", "locked"), { recursive: true });
    await writeFile(path.join(tempRoot, "ab1", "locked", "f"), "x");
    await chmod(path.join(tempRoot, "ab1", "locked"), 0o000);
    await mkdir(path.join(dead, "creatorbrio-director-Ab12Cd"));
    // A live server's run and copies are kept.
    await writeFile(path.join(alive, "run-cd2"), "");
    await mkdir(path.join(tempRoot, "cd2"));
    await mkdir(path.join(alive, "creatorbrio-director-Ef34Gh"));
    // A run no server owns.
    await mkdir(path.join(tempRoot, "ef3"));
    // This server: one live run, one live copy, and leftovers of each.
    const live = await createRunTempDir(uid, process.platform, tempRoot);
    const liveCopy = await createServerTempDir("creatorbrio-director-", uid, process.platform, tempRoot);
    const own = path.join(tempRoot, serverTempDirName());
    await writeFile(path.join(own, "run-gh4"), "");
    await mkdir(path.join(tempRoot, "gh4"));
    await mkdir(path.join(own, "creatorbrio-director-Zz99Yy"));
    await writeFile(path.join(tempRoot, "not-ours.txt"), "x");
    // The agent folders' quarantine, with another unreadable folder.
    const quarantined = path.join(root, ".removed", "9e1c9a52-8d3e-4b7a-9f21-0e4d5c6b7a89");
    await mkdir(path.join(quarantined, "deep", "locked"), { recursive: true });
    await writeFile(path.join(quarantined, "deep", "locked", "f"), "x");
    await chmod(path.join(quarantined, "deep", "locked"), 0o000);
    await chmod(path.join(quarantined, "deep"), 0o000);
    await chmod(path.join(root, ".removed"), 0o700);

    const { purged } = await sweepLeftoverFolders({ tempRoot, workspaceRoot: root, stopProcesses: false });
    await purged;
    expect((await readdir(tempRoot)).sort()).toEqual([".removed", serverTempDirName(), path.basename(alive), "cd2", path.basename(live), "not-ours.txt"].sort());
    expect(await readdir(path.join(tempRoot, ".removed"))).toEqual([]);
    // The server's own start time is kept in its folder (and is not a leftover).
    expect((await readdir(own)).filter((name) => name !== ".start").sort()).toEqual([path.basename(liveCopy), `run-${path.basename(live)}`].sort());
    expect((await readdir(alive)).sort()).toEqual(["creatorbrio-director-Ef34Gh", "run-cd2"]);
    expect(await readdir(path.join(root, ".removed"))).toEqual([]);
    await removeRunTempDir(live);
    await removeServerTempDir(liveCopy);
  });

  it.skipIf(process.platform !== "darwin")("clears user immutable flags in quarantine before deleting (macOS)", async () => {
    const bin = path.join(root, ".removed", QUARANTINED);
    await mkdir(path.join(bin, "d"), { recursive: true });
    await writeFile(path.join(bin, "d", "f"), "x");
    execFileSync("chflags", ["uchg", path.join(bin, "d", "f")]);
    execFileSync("chflags", ["uchg", path.join(bin, "d")]);
    await chmod(path.join(root, ".removed"), 0o700);
    const { purged } = await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: root, stopProcesses: false });
    await purged;
    expect(await readdir(path.join(root, ".removed"))).toEqual([]);
  });

  it("never purges a quarantine folder open to the group or others, or owned by another user", async () => {
    const bin = path.join(root, ".removed");
    await mkdir(path.join(bin, QUARANTINED), { recursive: true });
    await chmod(bin, 0o770);
    await (await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: root, stopProcesses: false })).purged;
    expect(await readdir(bin)).toEqual([QUARANTINED]);
    expect(vi.mocked(console.error).mock.calls.some(([message]) => String(message).includes("not purged"))).toBe(true);
    // Private, but not this user's: the sweep runs as another user id.
    await chmod(bin, 0o700);
    await (await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: root, uid: uid + 1, stopProcesses: false })).purged;
    expect(await readdir(bin)).toEqual([QUARANTINED]);
    // The same folder as this user's own private folder is purged.
    await (await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: root, stopProcesses: false })).purged;
    expect(await readdir(bin)).toEqual([]);
  });

  it("deletes only what the removal itself names, and reports anything else instead of deleting it (#241 A6)", async () => {
    const bin = path.join(root, ".removed");
    await mkdir(path.join(bin, QUARANTINED), { recursive: true });
    await mkdir(path.join(bin, "planted-by-someone"), { recursive: true });
    await writeFile(path.join(bin, "planted-by-someone", "keep"), "keep");
    await chmod(bin, 0o700);
    await (await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: root, stopProcesses: false })).purged;
    expect(await readdir(bin)).toEqual(["planted-by-someone"]);
    expect(await readFile(path.join(bin, "planted-by-someone", "keep"), "utf8")).toBe("keep");
    expect(vi.mocked(console.warn).mock.calls.some(([message]) => String(message).includes("unexpected entry"))).toBe(true);
  });

  it("never sweeps an agent folder setting inside the repository or around it (#241 A6)", async () => {
    for (const unsafe of [path.join(repo, "data", "agents"), base]) {
      const bin = path.join(unsafe, ".removed", QUARANTINED);
      await mkdir(bin, { recursive: true });
      await chmod(path.join(unsafe, ".removed"), 0o700);
      await (await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: unsafe, repoDir: repo, stopProcesses: false })).purged;
      expect((await lstat(bin)).isDirectory()).toBe(true);
    }
    expect(vi.mocked(console.error).mock.calls.some(([message]) => String(message).includes("inside or around the repository"))).toBe(true);
  });

  it("never moves anything into a quarantine folder open to the group or others", async () => {
    const dir = await startConversation(ID, repo, root);
    await mkdir(path.join(root, ".removed"));
    await chmod(path.join(root, ".removed"), 0o755);
    await expect(removeAgentWritable(dir, root)).rejects.toThrow(/not a private folder/);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("creates nothing where nothing was left, and leaves a parent that is not this user's private folder alone", async () => {
    const tempRoot = path.join(base, "absent");
    const { purged } = await sweepLeftoverFolders({ tempRoot, workspaceRoot: root, stopProcesses: false });
    await purged;
    await expect(lstat(tempRoot)).rejects.toThrow();
    await expect(lstat(root)).rejects.toThrow();
    const shared = path.join(base, "shared");
    await mkdir(path.join(shared, serverTempDirName(await deadPid())), { recursive: true });
    await chmod(shared, 0o755);
    await (await sweepLeftoverFolders({ tempRoot: shared, workspaceRoot: null, stopProcesses: false })).purged;
    expect((await readdir(shared)).length).toBe(1);
  });
});

describe("the sweep's look for leftover processes at server start (#241 A2)", () => {
  /** The folders a sweep judges: a workspace with one conversation, and a temporary parent with one run folder. */
  async function layout() {
    const dir = await startConversation(ID, repo, root);
    const tempRoot = path.join(serverTempRoot(), "s");
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    for (const d of [serverTempRoot(), tempRoot]) await chmod(d, 0o700);
    const run = await createRunTempDir(uid, process.platform, tempRoot);
    return { dir, tempRoot, run };
  }
  const sweep = async (tempRoot: string, extra: Record<string, unknown> = {}) => (await sweepLeftoverFolders({ tempRoot, workspaceRoot: root, ...extra })).purged;

  it("stops a process with no terminal left working in a conversation folder, its staging folder or a run's folder, and nothing else of the user's", async () => {
    const { dir, tempRoot, run } = await layout();
    await mkdir(stagingDirFor(dir), { recursive: true });
    const inConversation = stray(dir);
    const inStaging = stray(stagingDirFor(dir));
    const inRun = stray(run);
    // Under the configured folder, but not a folder the server makes; the carousel's own folder is one; a person's own folder.
    await mkdir(path.join(root, "notes"));
    const elsewhere = stray(path.join(root, "notes"));
    const unrelated = stray(base);
    await sweep(tempRoot);
    for (const pid of [inConversation, inStaging, inRun]) expect({ pid, gone: await goneWithin(pid) }).toEqual({ pid, gone: true });
    expect(isRunning(elsewhere)).toBe(true);
    expect(isRunning(unrelated)).toBe(true);
    await removeRunTempDir(run).catch(() => {});
  });

  it("is told apart from the person's own processes and other users', and never stops them", async () => {
    const { dir, tempRoot } = await layout();
    const real = defaultProbe();
    const mine = stray(dir);
    const shell = stray(dir);
    const theirs = stray(dir);
    // The same table with a terminal on one process and another owner on another.
    const probe = {
      ...real,
      list: async () => (await real.list()).map((p) => (p.pid === shell ? { ...p, tty: true } : p.pid === theirs ? { ...p, uid: uid + 1 } : p)),
      listSync: () => real.listSync(),
    };
    await sweep(tempRoot, { probe });
    expect(await goneWithin(mine)).toBe(true);
    expect(isRunning(shell)).toBe(true);
    expect(isRunning(theirs)).toBe(true);
  });

  it("stops nothing while another contained server of this user is running, and says so", async () => {
    const { dir, tempRoot } = await layout();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    strays.push(child);
    // Another running server: its folder is in the parent and its process id is alive, with no recorded start time to contradict that.
    await mkdir(path.join(tempRoot, serverTempDirName(child.pid!)), { mode: 0o700 });
    const mine = stray(dir);
    await sweep(tempRoot);
    expect(isRunning(mine)).toBe(true);
    expect(vi.mocked(console.info).mock.calls.some(([message]) => String(message).includes("another server is running"))).toBe(true);
    // Once that server is gone, the next start stops them.
    child.kill("SIGKILL");
    await once(child, "exit");
    await sweep(tempRoot);
    expect(await goneWithin(mine)).toBe(true);
  });

  it("takes a server folder whose process id a later process reuses for a dead server's, by its recorded start time", async () => {
    const { dir, tempRoot } = await layout();
    const reused = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    strays.push(reused);
    const folder = path.join(tempRoot, serverTempDirName(reused.pid!));
    await mkdir(folder, { mode: 0o700 });
    await writeFile(path.join(folder, ".start"), "a start time this process does not have");
    await mkdir(path.join(tempRoot, "abc"), { mode: 0o700 });
    await writeFile(path.join(folder, "run-abc"), "");
    const mine = stray(dir);
    await sweep(tempRoot);
    // It was a dead server's: its folder and run are gone, and the look for leftovers went ahead.
    await expect(lstat(folder)).rejects.toThrow();
    await expect(lstat(path.join(tempRoot, "abc"))).rejects.toThrow();
    expect(await goneWithin(mine)).toBe(true);
    expect(isRunning(reused.pid!)).toBe(true);
  });

  it("abandons the stop, with nothing signalled, when another server starts while the processes are being read (#241 B4)", async () => {
    const { dir, tempRoot } = await layout();
    const mine = stray(dir);
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    strays.push(other);
    const real = defaultProbe();
    // Another server's first run starts while this sweep reads the system: its folder exists before its CLI does.
    const probe = {
      ...real,
      cwds: async (user: number) => {
        const found = await real.cwds(user);
        await mkdir(path.join(tempRoot, serverTempDirName(other.pid!)), { mode: 0o700 });
        return found;
      },
    };
    await sweep(tempRoot, { probe });
    expect(isRunning(mine)).toBe(true);
    expect(vi.mocked(console.info).mock.calls.some(([message]) => String(message).includes("another server started"))).toBe(true);
  });

  it("says that SIGTERM had already been sent when another server starts after it, and sends no SIGKILL (#241 C3)", async () => {
    const { dir, tempRoot } = await layout();
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    strays.push(other);
    const folder = path.join(tempRoot, serverTempDirName(other.pid!));
    const ready = path.join(base, "late-ready");
    // The leftover ignores SIGTERM, except that its receiving it is when the other server's folder appears.
    const child = spawn(
      process.execPath,
      ["-e", `process.on('SIGTERM', () => { try { require('node:fs').mkdirSync(${JSON.stringify(folder)}, { mode: 0o700 }); } catch {} }); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'x'); setInterval(() => {}, 1000)`],
      { cwd: dir, detached: true, stdio: "ignore" }
    );
    strays.push(child);
    for (let i = 0; i < 400 && !existsSyncAt(ready); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    await sweep(tempRoot);
    expect(isRunning(child.pid!)).toBe(true);
    const said = vi.mocked(console.info).mock.calls.map(([message]) => String(message));
    expect(said.some((message) => message.includes("SIGTERM had already been sent to them, and none was sent SIGKILL"))).toBe(true);
    expect(said.some((message) => message.includes("none was signalled"))).toBe(false);
  });

  it("keeps a server folder whatever time zone and language the sweep runs in, since its start time is read in one fixed zone (#241 B1)", async () => {
    const { tempRoot } = await layout();
    const alive = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    strays.push(alive);
    // As the server that started it recorded it, under its own settings.
    const start = defaultProbe().listSync().find((p) => p.pid === alive.pid)?.start;
    expect(start).toBeTruthy();
    const folder = path.join(tempRoot, serverTempDirName(alive.pid!));
    await mkdir(folder, { mode: 0o700 });
    await writeFile(path.join(folder, ".start"), start!);
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    try {
      process.env.TZ = "Asia/Tokyo";
      process.env.LC_ALL = "de_DE.UTF-8";
      await sweep(tempRoot, { stopProcesses: false });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect((await lstat(folder)).isDirectory()).toBe(true);
  });

  it("keeps a server folder whose recorded start time is still the process's", async () => {
    const { tempRoot } = await layout();
    const alive = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    strays.push(alive);
    const start = defaultProbe().listSync().find((p) => p.pid === alive.pid)?.start;
    expect(start).toBeTruthy();
    const folder = path.join(tempRoot, serverTempDirName(alive.pid!));
    await mkdir(folder, { mode: 0o700 });
    await writeFile(path.join(folder, ".start"), start!);
    await sweep(tempRoot, { stopProcesses: false });
    expect((await lstat(folder)).isDirectory()).toBe(true);
  });

  it("records this server's start time in its own folder, as the process table prints it", async () => {
    const dir = await createRunTempDir(uid);
    try {
      const recorded = await readFile(path.join(serverTempRoot(), serverTempDirName(), ".start"), "utf8");
      expect(recorded).toBe(defaultProbe().listSync().find((p) => p.pid === process.pid)?.start);
    } finally {
      await removeRunTempDir(dir);
    }
  });
});

describe("a conversation's folder that may be gone", () => {
  it("is found missing only when it is known to be gone", async () => {
    const dir = await startConversation(ID, repo, root);
    expect(await conversationFolderExists(ID, path.basename(dir), root)).toBe(true);
    expect(await conversationFolderExists(ID, OTHER_ID, root)).toBe(false);
    expect(await conversationFolderExists("not-an-id", OTHER_ID, root)).toBe(false);
  });
});

describe("restoring access to what the agent locked", () => {
  it("adds owner access to a folder and keeps its other bits", async () => {
    const dir = path.join(base, "f");
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o050);
    await allowOwner(dir);
    expect((await stat(dir)).mode & 0o7777).toBe(0o750);
    await chmod(dir, 0o000);
    await allowOwner(dir);
    expect((await stat(dir)).mode & 0o7777).toBe(0o700);
  });

  it("through the fallback for a folder it cannot open, never follows a link, restores a real folder, and never fails on what it cannot look at (#241 B6)", async () => {
    const target = path.join(base, "fallback-target");
    await mkdir(target, { mode: 0o700 });
    await chmod(target, 0o500);
    const link = path.join(base, "fallback-link");
    await symlink(target, link);
    await allowOwner(link, process.platform, { skipOpen: true });
    expect((await stat(target)).mode & 0o7777).toBe(0o500);
    const locked = path.join(base, "fallback-locked");
    await mkdir(locked, { mode: 0o700 });
    await chmod(locked, 0o000);
    await allowOwner(locked, process.platform, { skipOpen: true });
    expect((await stat(locked)).mode & 0o7777).toBe(0o700);
    // Gone, or not to be looked at: nothing is changed and nothing is thrown, so a purge goes on to the next entry.
    await expect(allowOwner(path.join(base, "fallback-missing"), process.platform, { skipOpen: true })).resolves.toBeUndefined();
    await expect(allowOwner(path.join(base, "fallback-missing"))).resolves.toBeUndefined();
  });

  it("never follows a link: what a link points to keeps its mode", async () => {
    const target = path.join(base, "target");
    await mkdir(target, { mode: 0o700 });
    await chmod(target, 0o500);
    const link = path.join(base, "link");
    await symlink(target, link);
    await allowOwner(link);
    expect((await stat(target)).mode & 0o7777).toBe(0o500);
  });
});

describe.skipIf(process.platform !== "darwin")("a folder the agent made user-immutable (macOS)", () => {
  it("is still moved into quarantine, once its flags are cleared, and removed", async () => {
    const dir = await startConversation(ID, repo, root);
    await writeFile(path.join(dir, "f"), "x");
    execFileSync("chflags", ["uchg", path.join(dir, "f")]);
    execFileSync("chflags", ["uchg", dir]);
    await removeAgentWritable(dir, root);
    await expect(lstat(dir)).rejects.toThrow();
    expect(await readdir(path.join(root, ".removed"))).toEqual([]);
  });
});

describe("removing what the agent could write", () => {
  it("moves it into the removal folder before deleting it, and never follows a link", async () => {
    const dir = await startConversation(ID, repo, root);
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep"), "keep");
    await mkdir(path.join(dir, "nested", "deep"), { recursive: true });
    await writeFile(path.join(dir, "nested", "deep", "keep"), "agent");
    await symlink(outside, path.join(dir, "nested", "link"));
    await removeAgentWritable(path.join(dir, "nested"), root);
    await expect(stat(path.join(dir, "nested"))).rejects.toThrow();
    expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("keep");
    expect(await readdir(path.join(root, ".removed"))).toEqual([]);
    // A link in the agent's place is moved and removed as a link.
    await symlink(outside, path.join(dir, "swapped"));
    await removeAgentWritable(path.join(dir, "swapped"), root);
    expect(await readdir(outside)).toEqual(["keep"]);
    // Nothing there is not an error.
    await expect(removeAgentWritable(path.join(dir, "gone"), root)).resolves.toBeUndefined();
  });

  it("deletes a moved folder holding an unreadable subfolder by restoring its permissions", async () => {
    const dir = await startConversation(ID, repo, root);
    await mkdir(path.join(dir, "locked"));
    await writeFile(path.join(dir, "locked", "f"), "x");
    await chmod(path.join(dir, "locked"), 0o000);
    await removeAgentWritable(dir, root);
    await expect(lstat(dir)).rejects.toThrow();
    expect(await readdir(path.join(root, ".removed"))).toEqual([]);
  });

  it("removes the run's temporary folder the same way, through the server-owned parent's quarantine", async () => {
    const dir = await createRunTempDir(uid);
    await writeFile(path.join(dir, "x"), "x");
    await removeRunTempDir(dir);
    await expect(stat(dir)).rejects.toThrow();
  });
});

describe("images the agent may view", () => {
  const uploads = () => path.join(repo, "public", "uploads");

  it("are copied into a server-only staging folder beside the carousel's, and only staged paths are rewritten", async () => {
    const dir = await startConversation(ID, repo, root);
    const staged = stagingDirFor(dir);
    expect(staged).toBe(path.join(root, ID, ".staged", path.basename(dir)));
    await writeFile(path.join(uploads(), "a1.png"), "PNG-A");
    await writeFile(path.join(uploads(), "b2.webp"), "WEBP-B");
    const prompt = `Look at ${uploads()}/a1.png and ${uploads()}/missing.png.`;
    const task = `Also ${uploads()}/b2.webp, and ${uploads()}/a1.png again.`;
    const [p, t] = await stageUploadsForAgent([prompt, task], uploads(), staged);
    expect(p).toBe(`Look at ${staged}/a1.png and ${uploads()}/missing.png.`);
    expect(t).toBe(`Also ${staged}/b2.webp, and ${staged}/a1.png again.`);
    expect((await readdir(staged)).sort()).toEqual(["a1.png", "b2.webp"]);
    // Nothing is staged in the folder the agent can write.
    expect(await readdir(dir)).toEqual([]);

    // A copy, not a link: changing it never changes the upload.
    await writeFile(path.join(staged, "a1.png"), "CHANGED");
    expect(await readFile(path.join(uploads(), "a1.png"), "utf8")).toBe("PNG-A");
  });

  it("never stages a link, a non-image name or a path outside the uploads folder", async () => {
    const dir = await startConversation(ID, repo, root);
    const secret = path.join(base, "secret.png");
    await writeFile(secret, "SECRET");
    await symlink(secret, path.join(uploads(), "link.png"));
    await writeFile(path.join(uploads(), "notes.txt"), "x");
    const text = [
      `${uploads()}/link.png`,
      `${uploads()}/notes.txt`,
      `${uploads()}/../../secret.png`,
      `${path.join(repo, "data")}/x.png`,
    ].join(" ");
    const [out] = await stageUploadsForAgent([text], uploads(), stagingDirFor(dir));
    expect(out).toBe(text);
    await expect(readdir(stagingDirFor(dir))).resolves.toEqual([]);
  });

  it("keeps what earlier turns staged, so a resumed conversation can still view them", async () => {
    const dir = await startConversation(ID, repo, root);
    const staged = stagingDirFor(dir);
    await writeFile(path.join(uploads(), "a1.png"), "PNG-A");
    await writeFile(path.join(uploads(), "b2.png"), "PNG-B");
    await stageUploadsForAgent([`${uploads()}/a1.png`], uploads(), staged);
    const [again] = await stageUploadsForAgent([`${uploads()}/a1.png ${uploads()}/b2.png`], uploads(), staged);
    expect(again).toBe(`${staged}/a1.png ${staged}/b2.png`);
    expect((await readdir(staged)).sort()).toEqual(["a1.png", "b2.png"]);
  });

  it("stages every spelling of the uploads folder in one pass", async () => {
    const dir = await startConversation(ID, repo, root);
    const alias = path.join(base, "alias");
    await symlink(repo, alias);
    await writeFile(path.join(uploads(), "a1.png"), "PNG-A");
    await writeFile(path.join(uploads(), "b2.png"), "PNG-B");
    const other = path.join(alias, "public", "uploads");
    const staged = stagingDirFor(dir);
    const [out] = await stageUploadsForAgent([`${uploads()}/a1.png ${other}/b2.png`], [uploads(), other], staged);
    expect(out).toBe(`${staged}/a1.png ${staged}/b2.png`);
    expect((await readdir(staged)).sort()).toEqual(["a1.png", "b2.png"]);
  });

  it("leaves text without uploads untouched and creates nothing", async () => {
    const dir = await startConversation(ID, repo, root);
    expect(await stageUploadsForAgent(["no images here"], uploads(), stagingDirFor(dir))).toEqual(["no images here"]);
    await expect(stat(stagingDirFor(dir))).rejects.toThrow();
  });
});
