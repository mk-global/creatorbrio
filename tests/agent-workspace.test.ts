import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_WORKSPACES_ENV,
  AgentWorkspaceError,
  ConversationGoneError,
  agentWorkspaceRoot,
  createRunTempDir,
  createServerTempDir,
  openConversation,
  removeCarouselWorkDir,
  removeAgentWritable,
  removeRunTempDir,
  removeServerTempDir,
  serverTempDirName,
  serverTempRoot,
  stageUploadsForAgent,
  stagingDirFor,
  startConversation,
  sweepLeftoverFolders,
  SERVER_TEMP_ROOT_OVERRIDE,
  systemServerTempRoot,
} from "@/lib/agent-workspace";
import { agentTempDirFits, MAX_AGENT_TEMP_PATH_BYTES } from "@/lib/design-agent-profile";
import { OVERRIDE_KEY, realParent } from "./helpers/server-temp-parent";

const ID = "2f1c9a52-8d3e-4b7a-9f21-0e4d5c6b7a89";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uid = process.getuid?.() ?? 0;
let base: string;
let repo: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-workspace-")));
  repo = path.join(base, "repo");
  root = path.join(base, "agents");
  await mkdir(path.join(repo, "public", "uploads"), { recursive: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
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

describe("the server temporary folders", () => {
  it("are named per user, and a run's folder fits the CLI's limit with the longest user id on either platform", () => {
    expect(systemServerTempRoot("darwin", 501)).toBe("/private/tmp/cbdx");
    expect(systemServerTempRoot("linux", 1000)).toBe("/tmp/cbrs");
    for (const uid of [0, 501, 1000, 65534, 2 ** 31, 4294967295, 9999999999]) {
      for (const platform of ["darwin", "linux"] as const) {
        // The longest name a run's folder can have: three characters.
        const run = path.join(systemServerTempRoot(platform, uid), "zzz");
        expect({ uid, platform, fits: agentTempDirFits(run, uid) }).toEqual({ uid, platform, fits: true });
      }
    }
    // The worst case is exactly the limit: /private/tmp/cb + 7 + /zzz/claude- + 10 digits.
    const worst = path.join(systemServerTempRoot("darwin", 4294967295), "zzz", "claude-4294967295");
    expect(worst).toBe("/private/tmp/cb1z141z3/zzz/claude-4294967295");
    expect(Buffer.byteLength(worst)).toBe(MAX_AGENT_TEMP_PATH_BYTES);
  });

  it("are never the real parent while tests run: each test file has its own", () => {
    expect(serverTempRoot()).not.toBe(systemServerTempRoot());
    expect(serverTempRoot()).toMatch(/^(\/private)?\/tmp\/cbt-[0-9a-z]+$/);
    expect(OVERRIDE_KEY).toBe(SERVER_TEMP_ROOT_OVERRIDE);
    expect(realParent(process.platform, uid)).toBe(systemServerTempRoot());
  });

  it("put a run's folder directly in the parent, owner-only, with its owner recorded in this server's folder", async () => {
    const dir = await createRunTempDir(uid);
    const root = serverTempRoot();
    const marker = path.join(root, serverTempDirName(), `run-${path.basename(dir)}`);
    try {
      expect(path.dirname(dir)).toBe(root);
      expect(path.basename(dir)).toMatch(/^[0-9a-z]{3}$/);
      expect(serverTempDirName()).toBe(`.s${process.pid.toString(36)}`);
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
    await expect(createRunTempDir(uid, process.platform, wide)).rejects.toThrow(/not a private folder/);
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

    const { purged } = await sweepLeftoverFolders({ tempRoot, workspaceRoot: root });
    await purged;
    expect((await readdir(tempRoot)).sort()).toEqual([".removed", serverTempDirName(), path.basename(alive), "cd2", path.basename(live), "not-ours.txt"].sort());
    expect(await readdir(path.join(tempRoot, ".removed"))).toEqual([]);
    expect((await readdir(own)).sort()).toEqual([path.basename(liveCopy), `run-${path.basename(live)}`].sort());
    expect((await readdir(alive)).sort()).toEqual(["creatorbrio-director-Ef34Gh", "run-cd2"]);
    expect(await readdir(path.join(root, ".removed"))).toEqual([]);
    await removeRunTempDir(live);
    await removeServerTempDir(liveCopy);
  });

  it.skipIf(process.platform !== "darwin")("clears user immutable flags in quarantine before deleting (macOS)", async () => {
    const bin = path.join(root, ".removed", "entry");
    await mkdir(path.join(bin, "d"), { recursive: true });
    await writeFile(path.join(bin, "d", "f"), "x");
    execFileSync("chflags", ["uchg", path.join(bin, "d", "f")]);
    execFileSync("chflags", ["uchg", path.join(bin, "d")]);
    await chmod(path.join(root, ".removed"), 0o700);
    const { purged } = await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: root });
    await purged;
    expect(await readdir(path.join(root, ".removed"))).toEqual([]);
  });

  it("never purges a quarantine folder open to the group or others, or owned by another user", async () => {
    const bin = path.join(root, ".removed");
    await mkdir(path.join(bin, "entry"), { recursive: true });
    await chmod(bin, 0o770);
    await (await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: root })).purged;
    expect(await readdir(bin)).toEqual(["entry"]);
    expect(vi.mocked(console.error).mock.calls.some(([message]) => String(message).includes("not purged"))).toBe(true);
    // Private, but not this user's: the sweep runs as another user id.
    await chmod(bin, 0o700);
    await (await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: root, uid: uid + 1 })).purged;
    expect(await readdir(bin)).toEqual(["entry"]);
    // The same folder as this user's own private folder is purged.
    await (await sweepLeftoverFolders({ tempRoot: path.join(base, "none"), workspaceRoot: root })).purged;
    expect(await readdir(bin)).toEqual([]);
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
    const { purged } = await sweepLeftoverFolders({ tempRoot, workspaceRoot: root });
    await purged;
    await expect(lstat(tempRoot)).rejects.toThrow();
    await expect(lstat(root)).rejects.toThrow();
    const shared = path.join(base, "shared");
    await mkdir(path.join(shared, serverTempDirName(await deadPid())), { recursive: true });
    await chmod(shared, 0o755);
    await (await sweepLeftoverFolders({ tempRoot: shared, workspaceRoot: null })).purged;
    expect((await readdir(shared)).length).toBe(1);
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
