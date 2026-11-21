import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_WORKSPACES_ENV,
  AgentWorkspaceError,
  agentWorkspaceRoot,
  createRunTempDir,
  emptyCarouselWorkDir,
  ensureCarouselWorkDir,
  removeCarouselWorkDir,
  removeAgentWritable,
  removeRunTempDir,
  stageUploadsForAgent,
  stagingDirFor,
} from "@/lib/agent-workspace";

const ID = "2f1c9a52-8d3e-4b7a-9f21-0e4d5c6b7a89";
let base: string;
let repo: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-workspace-")));
  repo = path.join(base, "repo");
  root = path.join(base, "agents");
  await mkdir(path.join(repo, "public", "uploads"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("the workspace root", () => {
  it("defaults to a folder in the home folder and accepts only an absolute override", () => {
    expect(agentWorkspaceRoot({})).toMatch(/\.creatorbrio[/\\]design-agent$/);
    expect(agentWorkspaceRoot({ [AGENT_WORKSPACES_ENV]: "/srv/agents/" })).toBe("/srv/agents");
    expect(() => agentWorkspaceRoot({ [AGENT_WORKSPACES_ENV]: "relative/agents" })).toThrow(AgentWorkspaceError);
  });
});

describe("a carousel's folder", () => {
  it("is created owner-only under the root and reused", async () => {
    const dir = await ensureCarouselWorkDir(ID, repo, root);
    expect(dir).toBe(path.join(root, ID));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await writeFile(path.join(dir, "kept"), "x");
    expect(await ensureCarouselWorkDir(ID, repo, root)).toBe(dir);
    expect(await readdir(dir)).toEqual(["kept"]);
  });

  it("refuses an identifier that is not a server-generated one", async () => {
    for (const bad of ["../escape", "default", ID.toUpperCase(), `${ID}/x`, ""]) {
      await expect(ensureCarouselWorkDir(bad, repo, root)).rejects.toThrow(AgentWorkspaceError);
    }
  });

  it("refuses a root inside the repository, or one that contains it", async () => {
    await expect(ensureCarouselWorkDir(ID, repo, path.join(repo, "data", "agents"))).rejects.toThrow(/outside the repository/);
    await expect(ensureCarouselWorkDir(ID, repo, base)).rejects.toThrow(/outside the repository/);
  });

  it("refuses a folder that has been replaced by a link", async () => {
    await mkdir(root, { recursive: true });
    await symlink(repo, path.join(root, ID));
    await expect(ensureCarouselWorkDir(ID, repo, root)).rejects.toThrow(/not a plain folder/);
  });

  it("is emptied for a new conversation without following links out of it", async () => {
    const dir = await ensureCarouselWorkDir(ID, repo, root);
    const outside = path.join(base, "outside.txt");
    await writeFile(outside, "keep me");
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(dir, "nested", "a"), "x");
    await symlink(outside, path.join(dir, "link"));
    await symlink(base, path.join(dir, "dirlink"));
    await emptyCarouselWorkDir(dir);
    expect(await readdir(dir)).toEqual([]);
    expect(await readFile(outside, "utf8")).toBe("keep me");
  });

  it("is removed with its carousel, and an unsafe identifier removes nothing", async () => {
    const dir = await ensureCarouselWorkDir(ID, repo, root);
    await removeCarouselWorkDir("..", root);
    expect((await stat(dir)).isDirectory()).toBe(true);
    await removeCarouselWorkDir(ID, root);
    await expect(stat(dir)).rejects.toThrow();
    await expect(removeCarouselWorkDir(ID, root)).resolves.toBeUndefined();
  });
});

describe("the run's temporary folder", () => {
  it("is a fresh owner-only folder in the system's short temporary folder", async () => {
    const dir = await createRunTempDir(501);
    try {
      expect(dir).toMatch(/^(\/private)?\/tmp\/cb-[A-Za-z0-9]{6}$/);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await removeRunTempDir(dir, root);
    }
    await expect(stat(dir)).rejects.toThrow();
  });
});

describe("removing what the agent could write", () => {
  it("moves it into the removal folder beside the carousels' folders before deleting it, and never follows a link", async () => {
    const dir = await ensureCarouselWorkDir(ID, repo, root);
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

  it("removes the run's temporary folder the same way", async () => {
    const dir = await createRunTempDir(501);
    await writeFile(path.join(dir, "x"), "x");
    await removeRunTempDir(dir, root);
    await expect(stat(dir)).rejects.toThrow();
  });
});

describe("images the agent may view", () => {
  const uploads = () => path.join(repo, "public", "uploads");

  it("are copied into a server-only staging folder beside the carousel's, and only staged paths are rewritten", async () => {
    const dir = await ensureCarouselWorkDir(ID, repo, root);
    const staged = stagingDirFor(dir);
    expect(staged).toBe(path.join(root, ".staged", ID));
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
    const dir = await ensureCarouselWorkDir(ID, repo, root);
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
    const dir = await ensureCarouselWorkDir(ID, repo, root);
    const staged = stagingDirFor(dir);
    await writeFile(path.join(uploads(), "a1.png"), "PNG-A");
    await writeFile(path.join(uploads(), "b2.png"), "PNG-B");
    await stageUploadsForAgent([`${uploads()}/a1.png`], uploads(), staged);
    const [again] = await stageUploadsForAgent([`${uploads()}/a1.png ${uploads()}/b2.png`], uploads(), staged);
    expect(again).toBe(`${staged}/a1.png ${staged}/b2.png`);
    expect((await readdir(staged)).sort()).toEqual(["a1.png", "b2.png"]);
  });

  it("stages every spelling of the uploads folder in one pass", async () => {
    const dir = await ensureCarouselWorkDir(ID, repo, root);
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
    const dir = await ensureCarouselWorkDir(ID, repo, root);
    expect(await stageUploadsForAgent(["no images here"], uploads(), stagingDirFor(dir))).toEqual(["no images here"]);
    await expect(stat(stagingDirFor(dir))).rejects.toThrow();
  });
});
